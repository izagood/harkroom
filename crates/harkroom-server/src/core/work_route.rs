//! 글 → 작업 라우팅(B2) — **그림자만**. 기존 동작(멘션 → `inbox` → 깨움)은 바꾸지 않는다.
//!
//! - 글이 커밋된 뒤 [`after_post`] 가 「이 글이 깨운 에이전트」마다 그 글이 어느 작업으로 가는지를 옆에 적는다:
//!   같은 스레드에서 그 에이전트가 맡은 열린 작업(`open`·`running`·`waiting`)이 있으면 가장 최근에 고쳐진 그 작업(`existing`),
//!   없으면 뿌리 작업을 새로 만든다(`new`). 어느 쪽이든 그 작업에 [`EVENT_ROUTED`] 사건 한 줄을 남긴다.
//! - 「깨운 에이전트」는 글 올리기가 이미 계산한 값이다 — `Outcome::Posted.notified`(이 글로 `inbox` 행이 간 계정, 넣은 순서)에서
//!   `account.kind = 'agent'` 인 것만 고른다. 본문을 다시 해석하지 않는다.
//! - 위임 글(`meta.kind = 'delegation'`)은 건너뛴다 — 위임의 하위 작업은 다른 그림자(D1)가 세운다.
//! - **기존 트랜잭션 안에서 문장을 돌리지 않는다.** 요청 밖(`tokio::spawn`)에서 다른 연결로 돈다 — 실패는 로그 한 줄
//!   (오류 갈래만)로 삼킨다. 기존 작업의 상태·`updated_at` 은 건드리지 않고, 신호(outbox)도 내지 않는다.
//! - 새 작업 행에 글 본문을 베끼지 않는다(`title`·`body` 는 빈 채).
//! - 라우팅은 프로세스 안에서 하나씩 돈다([`GATE`]) — 쓰기 풀 연결을 많아야 2개 쓴다.
//! - (글, 에이전트)마다 한 번 — 같은 글로 두 번 돌아도 작업·사건이 늘지 않는다. (스레드, 에이전트) 자문 잠금 아래에서
//!   「이 글의 사건이 이미 있는가」를 먼저 본다.
//! - 스위치 `HARKROOM_WORK_ROUTE`(`off` | `shadow`(기본)) — [`switch_from_env`].
use super::msg_post::Outcome;
use super::work::{self, NewWork};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

/// 그림자 라우팅이 쓰는 권한 — 작업 표 읽기·넣기 + 글·계정 읽기. 시퀀스는 `work::WORK_SEQUENCE_PRIVILEGES`.
/// `work` 의 update 는 쓰지 않는다(기존 작업을 고치지 않는다). 없으면 `main.rs` 가 켜지 않는다(나머지는 그대로 돈다).
pub const WORK_ROUTE_PRIVILEGES: &[(&str, &str)] = &[
    ("work", "SELECT"),
    ("work", "INSERT"),
    ("work_event", "SELECT"),
    ("work_event", "INSERT"),
    ("message", "SELECT"),
    ("account", "SELECT"),
];

/// 글이 작업으로 갔을 때 남기는 사건 종류.
pub const EVENT_ROUTED: &str = "message.routed";
/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_WORK_ROUTE";

/// 글 한 줄 — 채널, 스레드 뿌리(뿌리 글은 자기 자신), 작성자, `meta.kind`.
const HEAD_SQL: &str = "select channel_id::text, coalesce(thread_root_id, id)::text, author_id::text, \
            coalesce(meta->>'kind', '') \
       from message where id = $1::uuid";

/// 받은 계정 가운데 에이전트만(id 순 — 되풀이해도 같은 순서).
const AGENTS_SQL: &str =
    "select id::text from account where id = any($1::uuid[]) and kind = 'agent' order by id";

/// (스레드, 에이전트) 자문 잠금 — 트랜잭션이 끝나면 풀린다. 같은 스레드·같은 에이전트의 라우팅을 한 줄로 세운다.
const LOCK_SQL: &str = "select pg_advisory_xact_lock(hashtextextended('work_route:' || $1::text || ':' || $2::text, 0))";

/// 이 글의 라우팅 사건이 그 에이전트의 작업에 이미 있는가.
const ROUTED_SQL: &str = "select exists(select 1 from work_event e join work w on w.id = e.work_id \
          where w.thread_root_id = $1::uuid and w.assignee_account_id = $2::uuid \
            and e.kind = $3 and e.payload->>'messageId' = $4)";

/// 같은 스레드에서 그 에이전트가 맡은 열린 작업 가운데 가장 최근에 고쳐진 것.
const OPEN_WORK_SQL: &str = "select id::text from work \
          where thread_root_id = $1::uuid and assignee_account_id = $2::uuid \
            and state in ('open', 'running', 'waiting') \
          order by updated_at desc, created_at desc, id desc limit 1";

static POOL: OnceLock<PgPool> = OnceLock::new();
/// 한 번에 도는 라우팅 수. 라우팅 하나는 잠금 연결을 쥔 채 `work` 쓰기에 연결을 하나 더 빌린다 — 글이 몰릴 때 저마다 잠금 연결을
/// 쥐고 두 번째 연결을 기다리면 요청과 나눠 쓰는 쓰기 풀이 마른다. 하나씩 세우면 이 그림자가 쓰는 연결은 많아야 2개다.
static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// 그림자 라우팅을 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 스위치 값.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    Off,
    Shadow,
}

/// 스위치 글자를 읽는다 — 없거나 모르는 값이면 `Shadow`(기본). 앞뒤 공백·대소문자는 가리지 않는다.
pub fn parse_switch(raw: Option<&str>) -> Switch {
    match raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("off") => Switch::Off,
        _ => Switch::Shadow,
    }
}

/// 환경 변수 [`SWITCH_ENV`] 에서 읽는다.
pub fn switch_from_env() -> Switch {
    parse_switch(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// 라우팅 판정.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 이미 열린 작업으로 간다(그 작업 id).
    Existing(String),
    /// 뿌리 작업을 새로 만든다.
    New,
}

impl Decision {
    /// 사건 payload 에 싣는 이름.
    pub fn as_str(&self) -> &'static str {
        match self {
            Decision::Existing(_) => "existing",
            Decision::New => "new",
        }
    }
}

/// 이 글을 라우팅하는가(순수) — 위임 글은 D1 그림자가 하위 작업을 세우므로 건너뛴다.
pub fn routes(meta_kind: &str) -> bool {
    meta_kind != "delegation"
}

/// 열린 작업 → 판정(순수). 열린 작업이 있으면 그 작업, 없으면 새로.
pub fn decide(open_work: Option<String>) -> Decision {
    match open_work {
        Some(id) => Decision::Existing(id),
        None => Decision::New,
    }
}

/// 사건 payload — 글 id 와 판정뿐이다(본문은 싣지 않는다).
pub fn payload(message_id: &str, decision: &Decision) -> Value {
    json!({ "messageId": message_id, "decision": decision.as_str() })
}

fn kind_of(e: &sqlx::Error) -> &'static str {
    e.as_database_error().map_or("io", |_| "db")
}

/// 글 올리기가 **돌아온 뒤**(커밋 뒤) 부른다 — 올라간 글이고 받은 계정이 있으면 요청 밖에서 라우팅을 적는다.
/// 꺼져 있거나 글이 올라가지 않았으면 아무것도 하지 않는다.
pub(crate) fn after_post(out: &Result<Outcome, sqlx::Error>) {
    let Some(pool) = POOL.get() else { return };
    let Ok(Outcome::Posted {
        row,
        notified,
        delegation_id: None,
        ..
    }) = out
    else {
        return;
    };
    if notified.is_empty() {
        return;
    }
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let Some(id) = serde_json::from_str::<Value>(row)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
    else {
        return;
    };
    let notified = notified.clone();
    rt.spawn(async move {
        let Ok(_one) = GATE.acquire().await else {
            return;
        };
        if let Err(e) = route_with(pool, &id, &notified).await {
            eprintln!("work route: message.routed skipped ({})", kind_of(&e));
        }
    });
}

/// [`after_post`] 의 몸통. `notified` 는 이 글로 `inbox` 행이 간 계정이다(사람이 섞여 있어도 된다 — 에이전트만 고른다).
/// 되풀이해도 같은 결과다. 새로 남긴 `(작업 id, 판정)` 을 에이전트 id 순으로 돌려준다. 글이 없거나 위임 글이면 빈 목록.
pub async fn route_with(
    pool: &PgPool,
    message_id: &str,
    notified: &[String],
) -> sqlx::Result<Vec<(String, Decision)>> {
    let mut made = Vec::new();
    if notified.is_empty() {
        return Ok(made);
    }
    let head: Option<(String, String, String, String)> = sqlx::query_as(HEAD_SQL)
        .bind(message_id)
        .fetch_optional(pool)
        .await?;
    let Some((channel, thread, author, meta_kind)) = head else {
        return Ok(made);
    };
    if !routes(&meta_kind) {
        return Ok(made);
    }
    let agents: Vec<String> = sqlx::query_scalar(AGENTS_SQL)
        .bind(notified)
        .fetch_all(pool)
        .await?;
    for agent in &agents {
        // 잠금은 이 연결의 트랜잭션이 쥔다. 작업·사건 쓰기는 `work` 모듈이 다른 연결로 한다 — 잠금이 순서만 세운다.
        let mut lock = pool.begin().await?;
        sqlx::query(LOCK_SQL)
            .bind(&thread)
            .bind(agent)
            .execute(&mut *lock)
            .await?;
        let done: bool = sqlx::query_scalar(ROUTED_SQL)
            .bind(&thread)
            .bind(agent)
            .bind(EVENT_ROUTED)
            .bind(message_id)
            .fetch_one(&mut *lock)
            .await?;
        if done {
            lock.commit().await?;
            continue;
        }
        let open: Option<String> = sqlx::query_scalar(OPEN_WORK_SQL)
            .bind(&thread)
            .bind(agent)
            .fetch_optional(&mut *lock)
            .await?;
        let decision = decide(open);
        let work_id = match &decision {
            Decision::Existing(id) => id.clone(),
            Decision::New => {
                let root = NewWork {
                    channel_id: &channel,
                    thread_root_id: &thread,
                    source_message_id: Some(message_id),
                    assignee_account_id: Some(agent),
                    requester_account_id: Some(&author),
                    ..Default::default()
                };
                match work::create(pool, &root, Some(&author)).await? {
                    Some(id) => id,
                    None => {
                        lock.commit().await?;
                        continue;
                    }
                }
            }
        };
        let p = payload(message_id, &decision);
        work::append_event(pool, &work_id, EVENT_ROUTED, Some(&author), &p).await?;
        lock.commit().await?;
        made.push((work_id, decision));
    }
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_parses_with_shadow_default() {
        for (raw, want) in [
            (None, Switch::Shadow),
            (Some(""), Switch::Shadow),
            (Some("shadow"), Switch::Shadow),
            (Some("off"), Switch::Off),
            (Some(" OFF "), Switch::Off),
            (Some("on"), Switch::Shadow),
            (Some("0"), Switch::Shadow),
        ] {
            assert_eq!(parse_switch(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn decide_prefers_the_open_work() {
        assert_eq!(decide(None), Decision::New);
        assert_eq!(decide(Some("w1".into())), Decision::Existing("w1".into()));
        assert_eq!(Decision::New.as_str(), "new");
        assert_eq!(Decision::Existing("w1".into()).as_str(), "existing");
    }

    #[test]
    fn delegation_posts_are_left_to_the_delegation_shadow() {
        assert!(!routes("delegation"));
        for k in ["", "report", "ask", "fail", "progress"] {
            assert!(routes(k), "{k}");
        }
    }

    #[test]
    fn payload_carries_only_the_message_id_and_decision() {
        let p = payload("m1", &Decision::Existing("w1".into()));
        assert_eq!(p, json!({ "messageId": "m1", "decision": "existing" }));
        assert_eq!(payload("m1", &Decision::New)["decision"], "new");
    }

    #[test]
    fn privileges_never_update_or_delete() {
        assert!(
            WORK_ROUTE_PRIVILEGES
                .iter()
                .all(|(_, p)| matches!(*p, "SELECT" | "INSERT"))
        );
        // 넣는 표는 작업 판뿐이다 — 글·계정은 읽기만.
        assert!(
            WORK_ROUTE_PRIVILEGES
                .iter()
                .all(|(t, p)| *p != "INSERT" || t.starts_with("work"))
        );
    }

    #[test]
    fn sql_reads_open_states_and_writes_nothing() {
        for s in ["'open'", "'running'", "'waiting'"] {
            assert!(OPEN_WORK_SQL.contains(s), "{s}");
        }
        for s in ["'done'", "'failed'", "'canceled'"] {
            assert!(!OPEN_WORK_SQL.contains(s), "{s}");
        }
        assert!(OPEN_WORK_SQL.contains("order by updated_at desc"));
        for sql in [HEAD_SQL, AGENTS_SQL, LOCK_SQL, ROUTED_SQL, OPEN_WORK_SQL] {
            let low = sql.to_ascii_lowercase();
            assert!(low.starts_with("select "), "{sql}");
            for w in ["insert ", "update ", "delete ", " body"] {
                assert!(!low.contains(w), "{sql}");
            }
        }
        assert!(ROUTED_SQL.contains("payload->>'messageId'"));
        assert_eq!(EVENT_ROUTED, "message.routed");
    }

    #[test]
    fn hook_is_a_noop_when_not_enabled_or_not_posted() {
        // 풀이 없으면(켜지 않았으면) 런타임 밖에서도 그냥 돌아온다.
        after_post(&Ok(Outcome::ToTs));
        after_post(&Err(sqlx::Error::RowNotFound));
    }
}

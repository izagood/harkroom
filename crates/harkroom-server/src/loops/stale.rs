//! 아무도 집지 않은 요청 통지 sweep(S5.4 L2) — TS `services/staleRequests.ts::createStaleRequestSweeper` 를 옮긴다. 문지기 이름 `stale`.
//!
//! - 후보: 미읽음 · 아직 안 말함(`stale_notified_at is null`) · 사람이 부른 사유(`REQUEST_REASONS`) · `STALE_AFTER` 보다 오래됨 ·
//!   러너가 오프라인 · 볼 수 있는 채널 · 지워지지 않은 글 · 켜진 에이전트(`agent_config` 가 있는). 문장은 TS 와 같다.
//! - presence: TS 는 인메모리 `agentPresence` 를 보지만 이 프로세스에는 그것이 없다. 같은 사실의 DB 사본 `agent_presence`(171)를
//!   본다 — 온라인은 `expires_at > now()`, 「오프라인이 된 시각」은 지난 `expires_at`, 줄이 없으면 「한 번도 못 봄」(TS `null`, 말한다).
//!   DB 의 만료는 메모리보다 최대 10초 이르다(`PERSIST_EVERY_MS`) — 오프라인 유예 90초 안에 묻힌다.
//! - 한 묶음(에이전트 × 스레드)마다: 표시 트랜잭션(`update … where stale_notified_at is null … returning`)이 경합 진 쪽을 거르고,
//!   글은 [`msg_post::post_tx`](자기 트랜잭션·재시도 키 `stale:<최소 id>`·`message.created`/`inbox.updated` outbox)로 낸 뒤 표시를 커밋한다.
//!   TS 와 같은 순서다 — 글 뒤 커밋 전에 죽으면 표시가 되돌아가고, 다음 sweep 은 같은 키로 새 글을 만들지 않는다.
//! - 디스크 사유(TS 에 없는 덧붙임): 그 에이전트가 배정된 오퍼레이터가 붙어 있고 박동(`status.disk.freeBytes`)이 [`DISK_LOW_BYTES`] 밑이면
//!   본문과 `failure.reason` 에 「디스크가 가득 찼다(남은 N GB)」를 적는다. 허브·배정·박동 중 하나라도 못 읽으면 옛 문장 그대로다.
//!   실리는 것은 남은 용량 하나다 — 경로·기기 이름은 박동에 칸이 없다.
//! - 한 번에 `STALE_SWEEP_BATCH` 묶음. 한 묶음의 실패는 기록만 하고 나머지를 계속한다.
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_for;
use crate::core::msg_post::{self, Origin, Outcome, PostBody, PostState};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration;

/// TS `STALE_AFTER_MS`.
pub const STALE_AFTER: Duration = Duration::from_secs(2 * 60);
/// TS `STALE_STARTUP_GRACE_MS` — 기동 뒤 이만큼은 돌지 않는다.
pub const STALE_STARTUP_GRACE: Duration = Duration::from_secs(60);
/// TS `STALE_OFFLINE_GRACE_MS` — 교대 중인 러너는 없는 러너가 아니다.
pub const STALE_OFFLINE_GRACE: Duration = Duration::from_secs(90);
/// TS `STALE_SWEEP_INTERVAL_MS`.
pub const STALE_SWEEP_INTERVAL: Duration = Duration::from_secs(30);
/// TS `STALE_SWEEP_BATCH`.
pub const STALE_SWEEP_BATCH: usize = 20;
/// TS `REQUEST_REASONS`.
const REQUEST_REASONS: [&str; 4] = ["mention", "team_mention", "thread_reply", "dm"];

/// 표시 칸 + 글 올리기 권한([`msg_post::MESSAGE_POST_PRIVILEGES`] 와 함께 본다).
pub const STALE_PRIVILEGES: &[(&str, &str)] = &[("inbox.stale_notified_at", "UPDATE")];

/// TS `candidates` 와 같은 술어 — 온라인 목록 대신 `agent_presence` 를 본다(위 모듈 주석).
pub const CANDIDATES_SQL: &str = "select i.id, i.account_id::text, a.handle, m.channel_id::text, \
        coalesce(m.thread_root_id, m.id)::text \
   from inbox i \
   join message m on m.id = i.message_id \
   join account a on a.id = i.account_id \
   join agent_config c on c.account_id = a.id \
   join channel ch on ch.id = m.channel_id \
   left join agent_presence p on p.account_id = i.account_id \
  where i.read_at is null \
    and ((ch.kind = 'standard' and ch.visibility = 'public') \
      or exists (select 1 from channel_member cm_vis where cm_vis.channel_id = ch.id and cm_vis.account_id = i.account_id)) \
    and i.stale_notified_at is null \
    and i.reason = any($1) \
    and i.created_at < now() - ($2::int * interval '1 millisecond') \
    and (p.account_id is null or p.expires_at <= now() - ($3::int * interval '1 millisecond')) \
    and m.deleted_at is null \
    and a.disabled_at is null and a.deleted_at is null \
  order by i.id \
  limit 200";

/// 후보 문장 — 나머지 읽는 곳이 깨움 행을 볼 때는 안 읽힌 줄 가운데 깨움이 열린 것만 본다(폴이 내줄 줄과 같다).
fn candidates_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        crate::core::wake_source::open_if_on(CANDIDATES_SQL, STALE_UNREAD, "i.id", "sw")
    })
}

/// [`CANDIDATES_SQL`] 의 「안 읽음」 조건.
pub const STALE_UNREAD: &str = "i.read_at is null";

const MARK_SQL: &str = "update inbox set stale_notified_at = now() \
  where id = any($1) and stale_notified_at is null and read_at is null returning id";

/// sweep 이 묻는 시한 — 시험이 줄인다.
#[derive(Debug, Clone, Copy)]
pub struct Opts {
    pub stale_after: Duration,
    pub offline_grace: Duration,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            stale_after: STALE_AFTER,
            offline_grace: STALE_OFFLINE_GRACE,
        }
    }
}

struct Candidate {
    id: i64,
    account: String,
    handle: String,
    channel: String,
    root: String,
}

/// 박동의 디스크 여유가 이 밑이면 「러너 없음」의 까닭을 디스크로 적는다. 러너가 턴 준비를 못 하는 선(512MB)보다 넉넉히 잡는다.
pub const DISK_LOW_BYTES: u64 = 1024 * 1024 * 1024;

/// 박동 본문에서 디스크가 바닥인지 — 바닥이면 남은 바이트. 칸이 없거나 넉넉하면 `None`(옛 문장 그대로).
pub fn disk_low(status: &Value) -> Option<u64> {
    let free = status.get("disk")?.get("freeBytes")?.as_u64()?;
    (free < DISK_LOW_BYTES).then_some(free)
}

fn gb(bytes: u64) -> String {
    format!("{:.1}GB", bytes as f64 / DISK_LOW_BYTES as f64)
}

/// 이 에이전트가 배정된 오퍼레이터가 지금 붙어 있고 그 박동의 디스크가 바닥이면 남은 바이트.
/// 허브가 없거나(소켓이 꺼진 프로세스) 배정을 못 읽거나 박동이 없으면 `None` — 통지는 옛 문장으로 나간다.
async fn disk_low_for(st: &PostState, account: &str) -> Option<u64> {
    let hub = crate::core::operator_hub::process_hub()?;
    let op: Option<String> = sqlx::query_scalar(
        "select operator_id::text from agent_assignment where agent_id = $1::uuid",
    )
    .bind(account)
    .fetch_optional(&st.read)
    .await
    .ok()?;
    disk_low(&hub.status(&op?)?)
}

/// TS `failureFor` — 러너가 스스로 남기는 실패 통지와 같은 어휘. 디스크가 바닥이면(`disk_free`) 그 까닭을 적는다.
fn failure_meta(handle: &str, disk_free: Option<u64>) -> Map<String, Value> {
    let reason = match disk_free {
        Some(free) => format!(
            "오퍼레이터 기기의 디스크가 가득 찼다(남은 {}, 서버가 박동으로 관측했다) — 자리를 비운 뒤 러너를 다시 띄우면 이 요청부터 다시 집는다",
            gb(free)
        ),
        None => {
            "러너가 폴을 멈춘 상태다(서버가 관측했다) — 러너를 다시 띄우면 이 요청부터 다시 집는다"
                .to_owned()
        }
    };
    let v = json!({
        "kind": "failure",
        "failure": {
            "retryable": true,
            "what": format!("@{handle} 의 러너가 붙어 있지 않아 이 요청이 처리되지 않았다"),
            "reason": reason,
        },
    });
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// TS 통지 본문.
pub const STALE_BODY: &str = "(이 요청을 집을 러너가 없습니다 — 운영자 확인이 필요합니다)";

/// 통지 본문 — 디스크가 바닥이면 그 까닭을 덧붙인다. 아니면 [`STALE_BODY`] 그대로.
pub fn stale_body(disk_free: Option<u64>) -> String {
    match disk_free {
        Some(free) => format!(
            "(이 요청을 집을 러너가 없습니다 — 오퍼레이터 기기의 디스크가 가득 찼습니다(남은 {}). 자리를 비운 뒤 러너를 다시 띄워야 합니다)",
            gb(free)
        ),
        None => STALE_BODY.to_owned(),
    }
}

fn ms(d: Duration) -> i32 {
    i32::try_from(d.as_millis()).unwrap_or(i32::MAX)
}

/// 묶음 하나 — 표시하고, 말하고, 커밋한다. 표시가 0 행이면(다른 sweep 이 집었다) `false`.
async fn post_one(st: &PostState, group: &[Candidate]) -> Result<bool, sqlx::Error> {
    let head = &group[0];
    let ids: Vec<i64> = group.iter().map(|c| c.id).collect();
    // 표시 트랜잭션을 열기 전에 읽는다 — 작은 풀에서 연결을 쥔 채 또 빌리지 않게.
    let audience = audience_for(&st.read, &head.channel).await?.to_json();
    let is_dm = msg_post::channel_is_dm(&st.read, &head.channel).await?;
    let disk_free = disk_low_for(st, &head.account).await;
    let mut tx = st.write.begin().await?;
    let marked: Vec<i64> = sqlx::query_scalar(MARK_SQL)
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
    if marked.is_empty() {
        tx.commit().await?;
        return Ok(false);
    }
    let post = PostBody {
        body: stale_body(disk_free),
        attachment_ids: Vec::new(),
        thread_root: Some(head.root.clone()),
        also_in_channel: false,
    };
    // 서버가 에이전트 이름으로 세운 알림 줄이다 — 그 에이전트의 결과가 아니므로 회신권·위임 의무를 건드리지 않는다.
    let origin = Origin {
        meta: failure_meta(&head.handle, disk_free),
        server_notice: true,
        ..Origin::default()
    };
    let key = format!("stale:{}", ids.iter().min().copied().unwrap_or_default());
    let out = msg_post::post_tx(
        st,
        &head.channel,
        &head.account,
        true,
        &post,
        Some(&key),
        &audience,
        is_dm,
        &origin,
    )
    .await?;
    match out {
        Outcome::Posted { .. } | Outcome::Replayed(_) => {
            tx.commit().await?;
            Ok(true)
        }
        // 머리가 사라졌거나 하는 일 — 표시를 되돌려 다음 sweep 이 다시 본다(영구 실패로 굳히지 않는다).
        _ => {
            tx.rollback().await?;
            Ok(true)
        }
    }
}

/// TS `sweep`(기동 유예는 [`spawn`] 이 본다). 글을 낸 묶음 수를 돌려준다.
pub async fn sweep(st: &PostState, opts: Opts) -> Result<usize, sqlx::Error> {
    let rows: Vec<(i64, String, String, String, String)> = sqlx::query_as(candidates_sql())
        .bind(&REQUEST_REASONS[..])
        .bind(ms(opts.stale_after))
        .bind(ms(opts.offline_grace))
        .fetch_all(&st.write)
        .await?;
    // 에이전트 하나 × 스레드 하나로 묶는다(처음 본 순서를 지킨다).
    let mut order: Vec<(String, String)> = Vec::new();
    let mut groups: HashMap<(String, String), Vec<Candidate>> = HashMap::new();
    for (id, account, handle, channel, root) in rows {
        let key = (account.clone(), root.clone());
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(Candidate {
            id,
            account,
            handle,
            channel,
            root,
        });
    }
    let mut done = 0;
    for key in order {
        if done >= STALE_SWEEP_BATCH {
            break;
        }
        let group = &groups[&key];
        match post_one(st, group).await {
            Ok(true) => done += 1,
            Ok(false) => {}
            Err(e) => {
                // 한 건의 실패로 나머지를 멈추지 않는다. 표시가 되돌아가므로 다음 sweep 이 다시 집는다(TS 는 실패도 셈에 넣는다).
                eprintln!("loop stale: post failed: {e}");
                done += 1;
            }
        }
    }
    Ok(done)
}

/// 기동 유예 뒤 30초마다 문지기 아래서 sweep. 주인이 `rust` 일 때만 실제로 돈다.
pub fn spawn(gate: PgPool, st: PostState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(STALE_STARTUP_GRACE).await;
        let mut every = tokio::time::interval(STALE_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "stale", Side::Rust, || async {
                sweep(&st, Opts::default()).await.map(|_| ())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop stale: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop stale: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_wake_statement_keeps_unread_and_adds_open_wake() {
        let sql = crate::core::wake_source::with_open(CANDIDATES_SQL, STALE_UNREAD, "i.id", "sw");
        assert!(sql.contains(
            "where i.read_at is null and exists (select 1 from wake sw where sw.inbox_id = i.id"
        ));
        assert_eq!(candidates_sql(), CANDIDATES_SQL);
    }

    #[test]
    fn disk_low_only_below_the_line() {
        assert_eq!(
            disk_low(&json!({ "disk": { "totalBytes": 10, "freeBytes": 5 } })),
            Some(5)
        );
        let roomy =
            json!({ "disk": { "totalBytes": DISK_LOW_BYTES * 4, "freeBytes": DISK_LOW_BYTES } });
        assert_eq!(disk_low(&roomy), None);
        // 칸이 없거나 꼴이 다르면 모름 — 옛 문장으로 간다.
        assert_eq!(disk_low(&json!({ "turns": { "running": 0 } })), None);
        assert_eq!(disk_low(&json!({ "disk": { "freeBytes": "0" } })), None);
    }

    #[test]
    fn wording_is_unchanged_without_a_disk_reason() {
        assert_eq!(stale_body(None), STALE_BODY);
        let m = failure_meta("a", None);
        assert_eq!(
            m["failure"]["reason"],
            "러너가 폴을 멈춘 상태다(서버가 관측했다) — 러너를 다시 띄우면 이 요청부터 다시 집는다"
        );
    }

    #[test]
    fn disk_reason_carries_only_the_free_size() {
        let free = DISK_LOW_BYTES / 4;
        let body = stale_body(Some(free));
        assert!(
            body.contains("디스크가 가득 찼습니다(남은 0.2GB)"),
            "{body}"
        );
        let m = failure_meta("a", Some(free));
        let reason = m["failure"]["reason"].as_str().unwrap();
        assert!(reason.contains("남은 0.2GB"), "{reason}");
        assert_eq!(m["failure"]["retryable"], true);
        assert_eq!(
            m["failure"]["what"],
            "@a 의 러너가 붙어 있지 않아 이 요청이 처리되지 않았다"
        );
    }
}

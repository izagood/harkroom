//! 턴 끝 판정을 턴 끝 자리에 잇는다(I2c-a) — **그림자만**. 작업 상태는 바꾸지 않는다.
//!
//! - 턴 끝 자리는 턴 임대 끝내기(`POST /agent/turn-leases/{id}/end`, [`super::turn_lease_routes::end`])다. 임대가 끝난 뒤
//!   [`turn_ended`] 가 요청 밖에서 그 턴의 사실([`Facts`])을 읽고 [`judge`] 로 판정해, 그 턴이 맡았던 작업에
//!   [`EVENT_TURN_JUDGED`] 사건 한 줄을 남긴다. 뿌리 작업이면 「상태가 정본이었다면 닫았을 것」([`would_close`])도 같이 싣는다.
//! - 작업 행·임대·위임·예약 어느 것도 고치지 않는다. 넣는 것은 `work_event` 한 줄과 측정 한 줄(`turn.judged`)뿐이다.
//! - 사실은 「그 에이전트 × 그 스레드 × 임대가 선 뒤」 창으로 읽는다 — 턴마다 가르는 열쇠가 글에 없어, 같은 스레드에서 같은
//!   에이전트의 턴이 겹치면 서로의 글을 같이 본다(근삿값).
//! - 취소는 감사 줄(`agent.turn.canceled`)로 읽는다 — 그 줄은 에이전트·채널까지만 적혀 있어 같은 채널의 다른 스레드 턴과
//!   가르지 못하고, 임대가 끝난 뒤에 적힐 수 있다. 그래서 판정을 [`SETTLE_DELAY`] 만큼 늦춘다. 새 부름이 밀어낸 턴은 적힌 곳이 없다.
//! - 임대가 끝내기 없이 만료되거나 다시 주기로 접힌 턴은 이 자리를 지나지 않는다(판정 없음).
//! - 켬: 위임 그림자와 같은 스위치(`HARKROOM_TURN_END_JUDGE`, `off` 가 아니면)이고 [`TURN_JUDGE_PRIVILEGES`] 가 다 있을 때.
//!   켤 때 닫히지 않은 옛 뿌리 작업을 **세기만** 한다([`OPEN_ROOTS_SQL`]).
use super::work;
pub use super::work_shadow::{Facts, Verdict, judge};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;
use std::time::Duration;

/// 판정 그림자가 쓰는 권한 — 읽기와 `work_event` 한 줄 넣기. 시퀀스는 `work::WORK_SEQUENCE_PRIVILEGES`.
/// 임대 표는 읽는 칸만 적는다(토큰 해시는 읽지 않는다). 없으면 `main.rs` 가 켜지 않는다(나머지는 그대로 돈다).
pub const TURN_JUDGE_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease.id", "SELECT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.channel_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.cause_message_id", "SELECT"),
    ("secret_turn_lease.created_at", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
    ("message", "SELECT"),
    ("agent_wake", "SELECT"),
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
    ("audit_log.action", "SELECT"),
    ("audit_log.target", "SELECT"),
    ("audit_log.at", "SELECT"),
    ("audit_log.detail", "SELECT"),
    ("work", "SELECT"),
    ("work_event", "SELECT"),
    ("work_event", "INSERT"),
];

/// 턴 끝 판정을 남기는 사건 종류.
pub const EVENT_TURN_JUDGED: &str = "turn.judged";
/// 임대가 끝난 뒤 사실을 읽기까지 기다리는 시간 — 취소의 감사 줄·정리가 임대 끝보다 늦게 적힐 수 있다.
pub const SETTLE_DELAY: Duration = Duration::from_secs(3);

/// 사람에게 건 열린 카드(답도 닫힘도 없는 것) — 지워진 글·권한 카드는 뺀다(`loops::plan_progress::ASKING_SQL` 과 같은 규칙).
macro_rules! open_ask {
    ($agent:literal, $thread:literal) => {
        concat!(
            "exists (select 1 from message q where q.thread_root_id = ",
            $thread,
            " and q.author_id = ",
            $agent,
            " and q.deleted_at is null and q.meta ? 'ask' and not (q.meta ? 'permissionRequest') \
               and q.meta->'ask'->>'answeredWith' is null and q.meta->'ask'->>'closedAt' is null)"
        )
    };
}

/// 걸려 있는 예약 — 그 스레드에 걸었거나 그 스레드로 보고하기로 한 것(`loops::delegation_deadline` 과 같은 규칙).
macro_rules! pending_wake {
    ($agent:literal, $thread:literal) => {
        concat!(
            "exists (select 1 from agent_wake k join message km on km.id = k.message_id where k.account_id = ",
            $agent,
            " and k.fired_at is null and k.canceled_at is null and (coalesce(km.thread_root_id, km.id) = ",
            $thread,
            " or lower(km.meta->'wake'->'reportTo'->>'threadRootId') = ",
            $thread,
            "::text))"
        )
    };
}

/// 자기가 넘긴 열린 위임 — 자기 조각(담당 = 위임자)은 하위 위임이 아니다.
macro_rules! open_sub_delegation {
    ($agent:literal, $thread:literal) => {
        concat!(
            "exists (select 1 from team_delegation sd join team_delegation_item si on si.delegation_id = sd.id \
              where sd.lead_account_id = ",
            $agent,
            " and sd.thread_root_id = ",
            $thread,
            " and si.outcome is null and si.delegate_account_id <> sd.lead_account_id)"
        )
    };
}

/// 끝난 임대 하나의 사실 — `$1` 임대, `$2` 에이전트. 임대가 없거나 남의 것이거나 아직 안 끝났으면 0줄.
/// 돌려주는 칸: 채널·스레드·원인 글, 그리고 [`Facts`] 의 일곱 칸(보고·실패·열린 카드·예약·하위 위임·글·취소).
pub const FACTS_SQL: &str = concat!(
    "with l as ( \
       select agent_id, channel_id, thread_root_id, cause_message_id, created_at from secret_turn_lease \
        where id = $1::uuid and agent_id = $2::uuid and ended_at is not null \
     ), mine as ( \
       select m.meta from message m join l on m.author_id = l.agent_id \
        where (m.thread_root_id = l.thread_root_id or m.id = l.thread_root_id) \
          and m.created_at >= l.created_at and m.deleted_at is null and m.kind = 'user' \
     ) \
     select l.channel_id::text, l.thread_root_id::text, l.cause_message_id::text, \
       exists (select 1 from mine where meta->>'kind' = 'report'), \
       exists (select 1 from mine where meta->>'kind' = 'failure'), ",
    open_ask!("l.agent_id", "l.thread_root_id"),
    ", ",
    pending_wake!("l.agent_id", "l.thread_root_id"),
    ", ",
    open_sub_delegation!("l.agent_id", "l.thread_root_id"),
    ", exists (select 1 from mine), \
       exists (select 1 from audit_log a where a.action = 'agent.turn.canceled' and a.target = l.agent_id::text \
                 and a.at >= l.created_at and a.detail->>'channelId' = l.channel_id::text) \
     from l"
);

/// 그 턴이 맡았던 작업 — `$1` 스레드, `$2` 에이전트, `$3` 원인 글. 앞선 줄이 이긴다:
/// ① 원인 글이 라우팅된 작업(`message.routed`) ② 원인 글이 낳은 작업(위임 글의 하위 작업) ③ 그 스레드에서 맡은 열린 작업 가운데 가장 최근 것.
/// 돌려주는 칸: 작업 id, 뿌리인가(부모도 위임도 없다), 찾은 길(`routed`·`source`·`thread`).
pub const WORK_SQL: &str = "select w.id::text, (w.parent_id is null and w.delegation_id is null), x.via from ( \
       (select e.work_id, 'routed' as via, 1 as ord from work_event e join work rw on rw.id = e.work_id \
         where rw.thread_root_id = $1::uuid and rw.assignee_account_id = $2::uuid \
           and e.kind = 'message.routed' and e.payload->>'messageId' = $3::uuid::text \
         order by e.id desc limit 1) \
       union all \
       (select sw.id, 'source', 2 from work sw \
         where sw.source_message_id = $3::uuid and sw.assignee_account_id = $2::uuid and sw.thread_root_id = $1::uuid \
         order by sw.created_at desc, sw.id desc limit 1) \
       union all \
       (select tw.id, 'thread', 3 from work tw \
         where tw.thread_root_id = $1::uuid and tw.assignee_account_id = $2::uuid and tw.closed_at is null \
         order by tw.updated_at desc, tw.created_at desc, tw.id desc limit 1) \
     ) x join work w on w.id = x.work_id order by x.ord limit 1";

/// 닫히지 않은 뿌리 작업 세기(읽기뿐) — 전체, 하루 넘은 것, 「움직임이 없는 것」(담당의 살아 있는 임대·열린 카드·예약·열린 하위
/// 위임이 하나도 없다). 마지막 수가 정리 대상의 어림이다. 아무것도 닫지 않는다.
pub const OPEN_ROOTS_SQL: &str = concat!(
    "select count(*)::int8, \
       (count(*) filter (where w.created_at < now() - interval '1 day'))::int8, \
       (count(*) filter (where not exists ( \
              select 1 from secret_turn_lease tl \
               where tl.agent_id = w.assignee_account_id and tl.thread_root_id = w.thread_root_id \
                 and tl.ended_at is null and tl.expires_at > now()) \
          and not ",
    open_ask!("w.assignee_account_id", "w.thread_root_id"),
    " and not ",
    pending_wake!("w.assignee_account_id", "w.thread_root_id"),
    " and not ",
    open_sub_delegation!("w.assignee_account_id", "w.thread_root_id"),
    "))::int8 \
     from work w where w.parent_id is null and w.delegation_id is null and w.closed_at is null"
);

static POOL: OnceLock<PgPool> = OnceLock::new();
/// 한 번에 도는 판정 수 — 요청과 나눠 쓰는 쓰기 풀에서 연결을 많아야 하나 쓴다.
static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// 판정 그림자를 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 닫았을 것 — 무엇 때문에(`by`), 어느 상태로(`state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Close {
    /// `report` | `fail` | `canceled` | `answered`.
    pub by: &'static str,
    /// `work.state` 의 끝난 값.
    pub state: &'static str,
}

/// 판정 → 뿌리 작업을 닫았을 것인가(순수). 기다리는 판정(사람·예약·하위 위임)은 닫지 않는다.
///
/// | 판정 | 사실 | 닫았을 것 |
/// |---|---|---|
/// | `Settled` | 실패를 알렸다 | `fail` → `failed` |
/// | `Settled` | 보고를 냈다 | `report` → `done` |
/// | `Settled` | 취소뿐이다 | `canceled` → `canceled` |
/// | `Silent` | 글을 냈다(보통의 답) | `answered` → `done` |
/// | `Silent` | 글도 없다 | 닫지 않는다 |
pub fn would_close(f: Facts, v: Verdict) -> Option<Close> {
    let close = |by, state| Some(Close { by, state });
    match v {
        Verdict::Settled if f.posted_fail => close("fail", "failed"),
        Verdict::Settled if f.posted_report => close("report", "done"),
        Verdict::Settled => close("canceled", "canceled"),
        Verdict::Silent if f.posted_any => close("answered", "done"),
        _ => None,
    }
}

/// 그 턴이 맡았던 작업.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub work_id: String,
    /// 뿌리 작업인가 — 위임이 낳은 하위 작업은 위임 그림자가 닫는다.
    pub root: bool,
    /// 찾은 길(`routed`·`source`·`thread`).
    pub via: String,
}

/// 판정 한 건.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Judged {
    pub channel_id: String,
    pub thread_root_id: String,
    pub cause_message_id: String,
    pub facts: Facts,
    pub verdict: Verdict,
    /// 작업을 못 찾았으면 `None`(라우팅 그림자가 꺼져 있었거나 그 글이 라우팅되지 않았다) — 사건은 남기지 않는다.
    pub target: Option<Target>,
    /// 뿌리 작업이고 닫았을 판정일 때만.
    pub close: Option<Close>,
}

/// 사건 payload — id·판정·사실뿐이다(본문은 싣지 않는다).
pub fn payload(lease_id: &str, j: &Judged) -> Value {
    let f = j.facts;
    json!({
        "leaseId": lease_id,
        "causeMessageId": j.cause_message_id,
        "verdict": j.verdict.as_str(),
        "facts": {
            "report": f.posted_report, "fail": f.posted_fail, "openAsk": f.open_ask, "wake": f.scheduled_wake,
            "subDelegation": f.sub_delegation_open, "posted": f.posted_any, "canceled": f.turn_canceled,
        },
        "root": j.target.as_ref().map(|t| t.root),
        "via": j.target.as_ref().map(|t| t.via.as_str()),
        "wouldClose": j.close.map(|c| c.state),
        "closeBy": j.close.map(|c| c.by),
    })
}

fn kind_of(e: &sqlx::Error) -> &'static str {
    e.as_database_error().map_or("io", |_| "db")
}

/// 임대 끝내기가 **성공한 뒤** 부른다 — 요청 밖에서 판정을 적는다. 꺼져 있으면 아무것도 하지 않는다.
pub fn turn_ended(lease_id: &str, agent_id: &str) {
    let Some(pool) = POOL.get() else { return };
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let (lease, agent) = (lease_id.to_owned(), agent_id.to_owned());
    rt.spawn(async move {
        tokio::time::sleep(SETTLE_DELAY).await;
        let Ok(_one) = GATE.acquire().await else {
            return;
        };
        match judge_with(pool, &lease, &agent).await {
            Ok(Some(j)) => super::measure::record(super::measure::Event {
                kind: super::measure::KIND_TURN_JUDGED,
                account_id: Some(agent),
                channel_id: Some(j.channel_id.clone()),
                thread_root_id: Some(j.thread_root_id.clone()),
                ref_id: Some(lease),
                value: Some(i64::from(j.close.is_some())),
                detail: Some(json!({
                    "verdict": j.verdict.as_str(),
                    "work": j.target.as_ref().map_or("none", |t| t.via.as_str()),
                    "root": j.target.as_ref().map(|t| t.root),
                    "closeBy": j.close.map(|c| c.by),
                })),
            }),
            Ok(None) => {}
            Err(e) => eprintln!("turn end judge: turn.judged skipped ({})", kind_of(&e)),
        }
    });
}

type FactsRow = (
    String,
    String,
    String,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
);

/// [`turn_ended`] 의 몸통. 임대가 없거나 남의 것이거나 아직 안 끝났으면 `None`. 작업을 찾았으면 그 작업에 사건 한 줄을 남긴다.
pub async fn judge_with(
    pool: &PgPool,
    lease_id: &str,
    agent_id: &str,
) -> sqlx::Result<Option<Judged>> {
    let row: Option<FactsRow> = sqlx::query_as(FACTS_SQL)
        .bind(lease_id)
        .bind(agent_id)
        .fetch_optional(pool)
        .await?;
    let Some((channel, thread, cause, report, fail, ask, wake, sub, posted, canceled)) = row else {
        return Ok(None);
    };
    let facts = Facts {
        posted_report: report,
        posted_fail: fail,
        open_ask: ask,
        scheduled_wake: wake,
        sub_delegation_open: sub,
        posted_any: posted,
        turn_canceled: canceled,
    };
    let verdict = judge(facts);
    let found: Option<(String, bool, String)> = sqlx::query_as(WORK_SQL)
        .bind(&thread)
        .bind(agent_id)
        .bind(&cause)
        .fetch_optional(pool)
        .await?;
    let target = found.map(|(work_id, root, via)| Target { work_id, root, via });
    let close = match &target {
        Some(t) if t.root => would_close(facts, verdict),
        _ => None,
    };
    let judged = Judged {
        channel_id: channel,
        thread_root_id: thread,
        cause_message_id: cause,
        facts,
        verdict,
        target,
        close,
    };
    if let Some(t) = &judged.target {
        let p = payload(lease_id, &judged);
        work::append_event(pool, &t.work_id, EVENT_TURN_JUDGED, Some(agent_id), &p).await?;
    }
    Ok(Some(judged))
}

/// 닫히지 않은 뿌리 작업 수 — (전체, 하루 넘은 것, 움직임이 없는 것). 세기만 한다.
pub async fn open_roots(pool: &PgPool) -> sqlx::Result<(i64, i64, i64)> {
    sqlx::query_as(OPEN_ROOTS_SQL).fetch_one(pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(bits: u8) -> Facts {
        let b = |i: u8| bits & (1 << i) != 0;
        Facts {
            posted_report: b(0),
            posted_fail: b(1),
            open_ask: b(2),
            scheduled_wake: b(3),
            sub_delegation_open: b(4),
            posted_any: b(5),
            turn_canceled: b(6),
        }
    }

    #[test]
    fn would_close_table() {
        let f = Facts::default();
        let cases = [
            (f, None),
            (
                Facts {
                    posted_any: true,
                    ..f
                },
                Some(("answered", "done")),
            ),
            (
                Facts {
                    posted_report: true,
                    posted_any: true,
                    ..f
                },
                Some(("report", "done")),
            ),
            (
                Facts {
                    posted_fail: true,
                    posted_report: true,
                    ..f
                },
                Some(("fail", "failed")),
            ),
            (
                Facts {
                    turn_canceled: true,
                    ..f
                },
                Some(("canceled", "canceled")),
            ),
            (
                Facts {
                    turn_canceled: true,
                    posted_report: true,
                    ..f
                },
                Some(("report", "done")),
            ),
            // 기다리는 판정은 글을 냈어도 닫지 않는다.
            (
                Facts {
                    open_ask: true,
                    posted_any: true,
                    ..f
                },
                None,
            ),
            (
                Facts {
                    scheduled_wake: true,
                    posted_any: true,
                    ..f
                },
                None,
            ),
            (
                Facts {
                    sub_delegation_open: true,
                    posted_any: true,
                    ..f
                },
                None,
            ),
        ];
        for (facts, want) in cases {
            let got = would_close(facts, judge(facts)).map(|c| (c.by, c.state));
            assert_eq!(got, want, "{facts:?}");
        }
    }

    /// 일곱 사실의 모든 조합에서 — 닫았을 상태는 끝난 상태이고, 기다리는 판정은 닫지 않는다.
    #[test]
    fn would_close_exhaustive_invariants() {
        for bits in 0u8..128 {
            let f = facts(bits);
            let v = judge(f);
            let c = would_close(f, v);
            if let Some(c) = c {
                assert!(work::is_closed(c.state), "{f:?}");
                assert!(matches!(v, Verdict::Settled | Verdict::Silent), "{f:?}");
            }
            let waiting = matches!(
                v,
                Verdict::WaitingOnHuman | Verdict::WaitingOnWake | Verdict::WaitingOnChild
            );
            if waiting {
                assert_eq!(c, None, "{f:?}");
            }
            assert_eq!(
                v == Verdict::Settled,
                c.is_some() && c.unwrap().by != "answered"
            );
        }
    }

    #[test]
    fn payload_carries_ids_verdict_and_facts_only() {
        let f = Facts {
            posted_report: true,
            posted_any: true,
            ..Facts::default()
        };
        let v = judge(f);
        let mut j = Judged {
            channel_id: "c".into(),
            thread_root_id: "t".into(),
            cause_message_id: "m".into(),
            facts: f,
            verdict: v,
            target: Some(Target {
                work_id: "w".into(),
                root: true,
                via: "routed".into(),
            }),
            close: would_close(f, v),
        };
        let p = payload("l", &j);
        assert_eq!(
            p,
            json!({
                "leaseId": "l", "causeMessageId": "m", "verdict": "settled",
                "facts": { "report": true, "fail": false, "openAsk": false, "wake": false,
                           "subDelegation": false, "posted": true, "canceled": false },
                "root": true, "via": "routed", "wouldClose": "done", "closeBy": "report",
            })
        );
        j.target = None;
        j.close = None;
        let p = payload("l", &j);
        assert!(p["root"].is_null() && p["via"].is_null() && p["wouldClose"].is_null());
    }

    #[test]
    fn sql_only_reads() {
        for sql in [FACTS_SQL, WORK_SQL, OPEN_ROOTS_SQL] {
            let low = sql.to_ascii_lowercase();
            assert!(
                low.starts_with("with ") || low.starts_with("select "),
                "{sql}"
            );
            for w in [
                "insert ",
                "update ",
                "delete ",
                "for update",
                " body",
                "token",
            ] {
                assert!(!low.contains(w), "{w}: {sql}");
            }
        }
        // 임대는 끝난 것, 그 에이전트의 것만.
        assert!(FACTS_SQL.contains("agent_id = $2::uuid and ended_at is not null"));
        // 세는 것은 닫히지 않은 뿌리뿐이다.
        assert!(
            OPEN_ROOTS_SQL.contains(
                "w.parent_id is null and w.delegation_id is null and w.closed_at is null"
            )
        );
        assert_eq!(EVENT_TURN_JUDGED, "turn.judged");
    }

    #[test]
    fn privileges_insert_only_the_event_row() {
        for (t, p) in TURN_JUDGE_PRIVILEGES {
            assert!(matches!(*p, "SELECT" | "INSERT"), "{t} {p}");
            assert!(*p != "INSERT" || *t == "work_event", "{t}");
            // 토큰 해시 칸은 읽지 않는다 — 임대 표는 칸으로만 적는다.
            assert!(
                *t != "secret_turn_lease" && !t.ends_with("token_hash"),
                "{t}"
            );
        }
    }

    #[test]
    fn hook_is_a_noop_when_not_enabled() {
        // 풀이 없으면(켜지 않았으면) 런타임 밖에서도 그냥 돌아온다.
        turn_ended(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
        );
    }
}

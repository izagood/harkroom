//! 계획 진행 루프(K1) — **그림자**. 최근 계획판(`thread_plan`)을 읽어 「서버가 진행한다면 무엇을 했을지」를 판정하고
//! (`core::plan_progress::judge`), 그 **갈래와 수만** `measure_event` 에 남긴다. 계획 행·글·깨움은 쓰지 않는다.
//!
//! - 스위치: `HARKROOM_PLAN_PROGRESS=shadow` 일 때만 뜬다([`shadow_enabled`]). 기본은 꺼짐이고, 꺼져 있으면 아무것도 읽지 않는다.
//!   측정 기록(`core::measure`)이 안 켜졌으면 tick 은 읽기 전에 돌아간다(남길 곳이 없다).
//! - 읽기 셋: 계획([`PLANS_SQL`]) → 그 단계들에 달린 카드 글의 `meta.ask`([`CARDS_SQL`]) → 담당 중 에이전트 계정([`AGENTS_SQL`]).
//!   권한 카드(`meta.permissionRequest`)는 정본이 따로(`permission_request.status`)라 여기서는 보지 않는다(없는 카드로 친다).
//! - 상한: 한 번에 [`MAX_PLANS`] 장(최근에 고친 순, [`PLAN_WINDOW_DAYS`] 일 안), 한 계획에서 판정 [`MAX_VERDICTS`] 개.
//! - 기록: 한 계획의 (막힘, 풀림, 시작) 수가 **지난 기록과 달라졌을 때만** 갈래마다 한 줄(`kind` = `plan.progress`,
//!   `detail.branch` = `would_block`·`would_unblock`·`would_start`, `value` = 그 수). 같은 판정을 tick 마다 다시 쌓지 않는다.
//!   지난 기록은 프로세스 메모리에만 둔다 — 다시 뜨면 한 번 더 남는다(그림자라 받아들인다).
//!
//! ## 멈춤 판정(s64, 그림자)
//!
//! `active` 단계인데 아무도 움직이지 않는 것을 같은 sweep 에서 센다(`core::plan_progress::judge_stall`). 갈래 둘:
//! `quiet`(신호 없음)·`would_stall`(신호 없음 + 담당이 [`StallState::after_sec`] 안에 그 스레드에 쓴 글도 없음).
//! - 읽기 넷(+하나): 열린 위임([`DELEGATIONS_SQL`])·살아 있는 턴 임대([`LEASES_SQL`])·걸린 예약([`WAKES_SQL`])·열린 PR 감시
//!   ([`PR_WATCHES_SQL`]). 조용한 단계가 하나라도 있을 때만 담당의 최근 글([`ACTIVITY_SQL`])을 더 읽는다.
//!   `active` 단계에 에이전트 담당이 없으면 아무것도 더 읽지 않는다.
//! - 권한은 따로 본다([`PLAN_STALL_PRIVILEGES`]) — 없으면 멈춤 판정만 빠지고 위 셋은 그대로 돈다. 턴 임대는 필요한 칸만 본다.
//! - 시간: [`STALL_HOURS_ENV`](기본 [`DEFAULT_STALL_HOURS`] 시간, 위임 유휴 기한과 같다).
//! - 쓰지 않는다: 계획 행·글·깨움 어느 것도. 수만 남긴다.
use super::{GateResult, Side, run_gated};
use crate::core::measure::{self, Event};
use crate::core::plan_progress::{self as judge, Card};
use crate::core::wake_deliver::is_uuid_shaped;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// sweep 주기.
pub const PLAN_PROGRESS_INTERVAL: Duration = Duration::from_secs(60);
/// 한 sweep 이 보는 최대 계획 수. [`PLANS_SQL`] 의 `limit` 과 같아야 한다(시험이 본다).
pub const MAX_PLANS: i64 = 50;
/// 이 일수 안에 고쳐진 계획만 본다. [`PLANS_SQL`] 의 수와 같아야 한다(시험이 본다).
pub const PLAN_WINDOW_DAYS: i64 = 14;
/// 한 계획에서 내는 최대 판정 수.
pub const MAX_VERDICTS: usize = 20;
/// 측정 갈래 이름.
pub const KIND_PLAN_PROGRESS: &str = "plan.progress";
/// 스위치 env.
pub const SWITCH_ENV: &str = "HARKROOM_PLAN_PROGRESS";
/// 멈춤으로 볼 시간(시간 단위) env.
pub const STALL_HOURS_ENV: &str = "HARKROOM_PLAN_STALL_HOURS";
/// 멈춤으로 볼 시간의 기본값 — 위임 유휴 기한(`delegation_deadline::DELEGATION_IDLE_SEC`)과 같다.
pub const DEFAULT_STALL_HOURS: i64 = 6;
/// 멈춤으로 볼 시간의 상한(30일).
pub const MAX_STALL_HOURS: i64 = 24 * 30;

/// 최근에 고친 계획 — 검사에 걸린 판(`flag_reason`)은 뺀다.
pub const PLANS_SQL: &str = "select root_id::text, channel_id::text, doc::text from thread_plan \
      where flag_reason is null and updated_at > now() - make_interval(days => 14) \
      order by updated_at desc limit 50";

/// 카드 글의 `meta.ask` — 지워진 글·권한 카드는 뺀다.
pub const CARDS_SQL: &str = "select id::text, (meta->'ask')::text from message \
      where id = any($1::uuid[]) and deleted_at is null and meta ? 'ask' and not (meta ? 'permissionRequest')";

/// 담당 중 에이전트 계정.
pub const AGENTS_SQL: &str =
    "select id::text from account where id = any($1::uuid[]) and kind = 'agent'";

/// 이 루프가 쓰는 권한(표, 권한) — 읽기뿐이다. 없으면 `main.rs` 가 루프를 띄우지 않는다. 기록은 `core::measure` 몫이다.
pub const PLAN_PROGRESS_PRIVILEGES: &[(&str, &str)] = &[
    ("thread_plan", "SELECT"),
    ("message", "SELECT"),
    ("account", "SELECT"),
];

/// 열린 위임 — (스레드, 담당, 단계 id). `$1` 스레드들, `$2` 담당들. 결과가 온 뒤 닫히기를 기다리는 것(`reported`)은 열린 것이 아니다.
pub const DELEGATIONS_SQL: &str = "select d.thread_root_id::text, i.delegate_account_id::text, d.plan_step_id \
      from team_delegation_item i join team_delegation d on d.id = i.delegation_id \
      where i.outcome is null and i.delegate_account_id = any($2::uuid[]) and d.thread_root_id = any($1::uuid[])";

/// 살아 있는 턴 임대 — (스레드, 담당).
pub const LEASES_SQL: &str = "select thread_root_id::text, agent_id::text from secret_turn_lease \
      where ended_at is null and expires_at > now() and agent_id = any($2::uuid[]) and thread_root_id = any($1::uuid[])";

/// 걸려 있는 예약 — (스레드, 담당). 앵커는 예약 글에서 되찾는다.
pub const WAKES_SQL: &str = "select coalesce(m.thread_root_id, m.id)::text, w.account_id::text \
      from agent_wake w join message m on m.id = w.message_id \
      where w.fired_at is null and w.canceled_at is null and w.account_id = any($2::uuid[]) \
        and coalesce(m.thread_root_id, m.id) = any($1::uuid[])";

/// 열린 PR 감시 — (스레드, 건 계정).
pub const PR_WATCHES_SQL: &str = "select s.thread_root_id::text, s.account_id::text \
      from pr_watch_subscriber s join pr_watch w on w.id = s.watch_id \
      where w.state = 'open' and s.account_id = any($2::uuid[]) and s.thread_root_id = any($1::uuid[])";

/// `$3` 초 안에 그 스레드에 글을 쓴 (스레드, 계정).
pub const ACTIVITY_SQL: &str = "select distinct thread_root_id::text, author_id::text from message \
      where thread_root_id = any($1::uuid[]) and author_id = any($2::uuid[]) \
        and created_at > now() - make_interval(secs => $3::double precision)";

/// 멈춤 판정이 더 쓰는 권한 — 읽기뿐이다. 없으면 멈춤 판정만 빠진다. 턴 임대는 토큰 칸을 읽지 않으므로 칸 단위로 적는다.
pub const PLAN_STALL_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
    ("agent_wake", "SELECT"),
    ("pr_watch", "SELECT"),
    ("pr_watch_subscriber", "SELECT"),
];

/// env 값 → 멈춤으로 볼 초. 1~[`MAX_STALL_HOURS`] 의 정수만 받고, 그 밖(빈 값·0·음수·글자)은 기본값이다.
pub fn stall_after_sec(raw: Option<&str>) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|h| (1..=MAX_STALL_HOURS).contains(h))
        .unwrap_or(DEFAULT_STALL_HOURS)
        * 3600
}

/// 멈춤 판정의 설정과 지난 기록 — 계획 뿌리 id → (조용함, 멈춤) 수.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StallState {
    pub after_sec: i64,
    pub seen: HashMap<String, (usize, usize)>,
}

impl StallState {
    pub fn new(after_sec: i64) -> Self {
        Self {
            after_sec,
            seen: HashMap::new(),
        }
    }
}

/// 한 계획의 멈춤 수 → 남길 줄. [`events_for`] 와 같은 규칙이다(같으면 없음, 0 인 갈래는 줄 없음).
pub fn stall_events_for(
    state: &mut StallState,
    root: &str,
    channel: &str,
    counts: (usize, usize),
    truncated: bool,
) -> Vec<Event> {
    if state.seen.get(root).copied().unwrap_or((0, 0)) == counts {
        return vec![];
    }
    if counts == (0, 0) {
        state.seen.remove(root);
    } else {
        state.seen.insert(root.to_string(), counts);
    }
    let after_sec = state.after_sec;
    [("quiet", counts.0), ("would_stall", counts.1)]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .map(|(branch, n)| Event {
            kind: KIND_PLAN_PROGRESS,
            channel_id: Some(channel.to_string()),
            thread_root_id: Some(root.to_string()),
            value: Some(n as i64),
            detail: Some(
                json!({ "branch": branch, "truncated": truncated, "afterSec": after_sec }),
            ),
            ..Event::default()
        })
        .collect()
}

/// 스위치 값 → 그림자를 켜나. `shadow` 만 켠다(빈 값·모르는 값은 꺼짐).
pub fn shadow_enabled(raw: Option<&str>) -> bool {
    raw.map(str::trim) == Some("shadow")
}

/// 지난 기록 — 계획 뿌리 id → (막힘, 풀림, 시작) 수.
pub type Seen = HashMap<String, (usize, usize, usize)>;

/// 한 계획의 수 → 남길 줄. 지난 기록과 같으면 없다. 0 인 갈래는 줄을 내지 않는다.
pub fn events_for(
    seen: &mut Seen,
    root: &str,
    channel: &str,
    counts: (usize, usize, usize),
    truncated: bool,
) -> Vec<Event> {
    if seen.get(root).copied().unwrap_or((0, 0, 0)) == counts {
        return vec![];
    }
    if counts == (0, 0, 0) {
        seen.remove(root);
    } else {
        seen.insert(root.to_string(), counts);
    }
    [
        ("would_block", counts.0),
        ("would_unblock", counts.1),
        ("would_start", counts.2),
    ]
    .into_iter()
    .filter(|(_, n)| *n > 0)
    .map(|(branch, n)| Event {
        kind: KIND_PLAN_PROGRESS,
        channel_id: Some(channel.to_string()),
        thread_root_id: Some(root.to_string()),
        value: Some(n as i64),
        detail: Some(json!({ "branch": branch, "truncated": truncated })),
        ..Event::default()
    })
    .collect()
}

fn uuids(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let set: HashSet<String> = ids.into_iter().filter(|s| is_uuid_shaped(s)).collect();
    set.into_iter().collect()
}

type Pairs = Vec<(String, String)>;

/// 멈춤 판정 한 번 — 남길 줄들. 읽기만 한다. `active` 단계에 에이전트 담당이 없으면 아무것도 읽지 않는다.
async fn sweep_stall(
    pool: &PgPool,
    state: &mut StallState,
    plans: &[(String, String, Value)],
    cards: &HashMap<String, Card>,
    agents: &HashSet<String>,
) -> Result<Vec<Event>, sqlx::Error> {
    state
        .seen
        .retain(|root, _| plans.iter().any(|(r, _, _)| r == root));
    // 판정할 단계가 있는 계획만 — (스레드, 담당).
    let mut roots = vec![];
    let mut who = HashSet::new();
    for (root, _, doc) in plans {
        let mine: Vec<String> = judge::active_steps(doc)
            .into_iter()
            .map(|(_, a)| a)
            .filter(|a| agents.contains(a))
            .collect();
        if !mine.is_empty() && is_uuid_shaped(root) {
            roots.push(root.clone());
            who.extend(mine);
        }
    }
    let mut signals: HashMap<String, judge::Signals> = HashMap::new();
    if !roots.is_empty() {
        let who: Vec<String> = who.into_iter().collect();
        let delegations: Vec<(String, String, Option<String>)> = sqlx::query_as(DELEGATIONS_SQL)
            .bind(&roots)
            .bind(&who)
            .fetch_all(pool)
            .await?;
        for (root, account, step) in delegations {
            let s = signals.entry(root).or_default();
            match step {
                Some(step) => s.step_delegations.insert((account, step)),
                None => s.loose_delegations.insert(account),
            };
        }
        for sql in [LEASES_SQL, WAKES_SQL, PR_WATCHES_SQL] {
            let rows: Pairs = sqlx::query_as(sql)
                .bind(&roots)
                .bind(&who)
                .fetch_all(pool)
                .await?;
            for (root, account) in rows {
                signals.entry(root).or_default().turns.insert(account);
            }
        }
        // 조용한 단계가 있는 스레드만 담당의 최근 글을 더 읽는다.
        let none = judge::Signals::default();
        let quiet: Vec<String> = plans
            .iter()
            .filter(|(root, _, doc)| {
                let s = signals.get(root).unwrap_or(&none);
                !judge::judge_stall(doc, cards, agents, s, MAX_VERDICTS)
                    .quiet
                    .is_empty()
            })
            .map(|(root, _, _)| root.clone())
            .filter(|root| roots.contains(root))
            .collect();
        if !quiet.is_empty() {
            let rows: Pairs = sqlx::query_as(ACTIVITY_SQL)
                .bind(&quiet)
                .bind(&who)
                .bind(state.after_sec as f64)
                .fetch_all(pool)
                .await?;
            for (root, account) in rows {
                signals.entry(root).or_default().recent.insert(account);
            }
        }
    }
    let none = judge::Signals::default();
    let mut out = vec![];
    for (root, channel, doc) in plans {
        let s = signals.get(root).unwrap_or(&none);
        let v = if roots.contains(root) {
            judge::judge_stall(doc, cards, agents, s, MAX_VERDICTS)
        } else {
            judge::Stall::default()
        };
        out.extend(stall_events_for(
            state,
            root,
            channel,
            v.counts(),
            v.truncated,
        ));
    }
    Ok(out)
}

/// sweep 한 번 — 남길 줄들. 읽기만 한다. `stall` 이 있으면 멈춤 판정도 같이 한다.
pub async fn sweep(
    pool: &PgPool,
    seen: &mut Seen,
    stall: Option<&mut StallState>,
) -> Result<Vec<Event>, sqlx::Error> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(PLANS_SQL).fetch_all(pool).await?;
    let plans: Vec<(String, String, Value)> = rows
        .into_iter()
        .filter_map(|(root, channel, doc)| Some((root, channel, serde_json::from_str(&doc).ok()?)))
        .collect();
    // 창 밖으로 나간 계획의 지난 기록은 버린다(메모리가 끝없이 크지 않게).
    seen.retain(|root, _| plans.iter().any(|(r, _, _)| r == root));
    let card_ids = uuids(plans.iter().flat_map(|(_, _, d)| judge::card_ids(d)));
    let mut cards: HashMap<String, Card> = HashMap::new();
    if !card_ids.is_empty() {
        let found: Vec<(String, Option<String>)> = sqlx::query_as(CARDS_SQL)
            .bind(&card_ids)
            .fetch_all(pool)
            .await?;
        for (id, ask) in found {
            let ask: Value = ask
                .and_then(|a| serde_json::from_str(&a).ok())
                .unwrap_or(Value::Null);
            cards.insert(id, judge::card_state(&ask));
        }
    }
    // `pending` 단계의 담당(시작 판정) + 멈춤 판정을 할 때는 `active` 단계의 담당.
    let with_active = stall.is_some();
    let assignees = uuids(plans.iter().flat_map(|(_, _, d)| {
        let active = with_active.then(|| judge::active_steps(d).into_iter().map(|(_, a)| a));
        judge::assignee_ids(d)
            .into_iter()
            .chain(active.into_iter().flatten())
    }));
    let agents: HashSet<String> = if assignees.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar(AGENTS_SQL)
            .bind(&assignees)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect()
    };
    let mut out = vec![];
    for (root, channel, doc) in &plans {
        let v = judge::judge(doc, &cards, &agents, MAX_VERDICTS);
        out.extend(events_for(seen, root, channel, v.counts(), v.truncated));
    }
    if let Some(state) = stall {
        out.extend(sweep_stall(pool, state, &plans, &cards, &agents).await?);
    }
    Ok(out)
}

/// 루프를 띄운다 — 60초마다. 주인이 `rust` 일 때만 실제로 돈다. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀이다.
/// `stall_after_sec` 이 있으면 멈춤 판정도 같이 한다(그 권한이 있을 때만 준다).
pub fn spawn(
    gate: PgPool,
    pool: PgPool,
    stall_after_sec: Option<i64>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(PLAN_PROGRESS_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut seen = Seen::new();
        let mut stall = stall_after_sec.map(StallState::new);
        loop {
            every.tick().await;
            // 남길 곳이 없으면 읽지도 않는다.
            let Some(record) = measure::pool() else {
                continue;
            };
            let (p, s, st) = (&pool, &mut seen, stall.as_mut());
            match run_gated(&gate, "plan.progress", Side::Rust, || async move {
                for e in sweep(p, s, st).await? {
                    measure::record_with(record, e).await;
                }
                Ok::<(), sqlx::Error>(())
            })
            .await
            {
                // 실패는 다음 시각에 다시 한다 — 그림자는 늦어도 해가 없다. 오류 문구만(행 내용 없음).
                GateResult::Gate(e) => eprintln!("loop plan.progress: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop plan.progress: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_is_off_unless_shadow() {
        assert!(!shadow_enabled(None));
        for off in ["", "0", "1", "on", "true", "live", "Shadow"] {
            assert!(!shadow_enabled(Some(off)), "{off}");
        }
        assert!(shadow_enabled(Some("shadow")));
        assert!(shadow_enabled(Some(" shadow\n")));
    }

    #[test]
    fn sql_matches_constants_and_only_reads() {
        assert!(PLANS_SQL.ends_with(&format!("limit {MAX_PLANS}")));
        assert!(PLANS_SQL.contains(&format!("make_interval(days => {PLAN_WINDOW_DAYS})")));
        assert!(PLANS_SQL.contains("flag_reason is null"));
        for sql in [
            PLANS_SQL,
            CARDS_SQL,
            AGENTS_SQL,
            DELEGATIONS_SQL,
            LEASES_SQL,
            WAKES_SQL,
            PR_WATCHES_SQL,
            ACTIVITY_SQL,
        ] {
            assert!(sql.starts_with("select "));
            for w in ["insert ", "update ", "delete "] {
                assert!(!sql.contains(w), "{sql}");
            }
        }
        assert!(CARDS_SQL.contains("deleted_at is null"));
        assert!(CARDS_SQL.contains("not (meta ? 'permissionRequest')"));
        assert!(AGENTS_SQL.contains("kind = 'agent'"));
    }

    #[test]
    fn privileges_are_select_only() {
        assert!(PLAN_PROGRESS_PRIVILEGES.iter().all(|(_, p)| *p == "SELECT"));
        let tables: Vec<&str> = PLAN_PROGRESS_PRIVILEGES.iter().map(|(t, _)| *t).collect();
        assert_eq!(tables, ["thread_plan", "message", "account"]);
    }

    #[test]
    fn stall_reads_only_open_things_and_never_the_lease_token() {
        assert!(DELEGATIONS_SQL.contains("i.outcome is null"));
        assert!(LEASES_SQL.contains("ended_at is null and expires_at > now()"));
        assert!(!LEASES_SQL.contains("token"));
        assert!(WAKES_SQL.contains("w.fired_at is null and w.canceled_at is null"));
        assert!(PR_WATCHES_SQL.contains("w.state = 'open'"));
        assert!(ACTIVITY_SQL.contains("make_interval(secs => $3"));
        // 스레드·계정으로 좁히지 않는 읽기는 없다.
        for sql in [
            DELEGATIONS_SQL,
            LEASES_SQL,
            WAKES_SQL,
            PR_WATCHES_SQL,
            ACTIVITY_SQL,
        ] {
            assert!(
                sql.contains("any($1::uuid[])") && sql.contains("any($2::uuid[])"),
                "{sql}"
            );
        }
        assert!(PLAN_STALL_PRIVILEGES.iter().all(|(_, p)| *p == "SELECT"));
        let lease: Vec<&str> = PLAN_STALL_PRIVILEGES
            .iter()
            .map(|(t, _)| *t)
            .filter(|t| t.starts_with("secret_turn_lease"))
            .collect();
        assert_eq!(
            lease,
            [
                "secret_turn_lease.agent_id",
                "secret_turn_lease.thread_root_id",
                "secret_turn_lease.ended_at",
                "secret_turn_lease.expires_at"
            ]
        );
        // 임대 읽기가 쓰는 칸은 권한에 적힌 칸뿐이다.
        for col in ["agent_id", "thread_root_id", "ended_at", "expires_at"] {
            assert!(LEASES_SQL.contains(col), "{col}");
        }
    }

    #[test]
    fn stall_hours_default_and_bounds() {
        assert_eq!(DEFAULT_STALL_HOURS, 6);
        assert_eq!(stall_after_sec(None), 6 * 3600);
        for bad in ["", "0", "-1", "x", "1.5", "721"] {
            assert_eq!(stall_after_sec(Some(bad)), 6 * 3600, "{bad}");
        }
        assert_eq!(stall_after_sec(Some("1")), 3600);
        assert_eq!(stall_after_sec(Some(" 12\n")), 12 * 3600);
        assert_eq!(stall_after_sec(Some("720")), 720 * 3600);
    }

    #[test]
    fn stall_events_carry_branch_count_and_window_only() {
        let mut st = StallState::new(3600);
        let ev = stall_events_for(&mut st, "r1", "c1", (2, 1), false);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].value, Some(2));
        assert_eq!(
            ev[0].detail,
            Some(json!({"branch": "quiet", "truncated": false, "afterSec": 3600}))
        );
        assert_eq!(ev[1].value, Some(1));
        assert_eq!(ev[1].detail.as_ref().unwrap()["branch"], "would_stall");
        assert!(ev.iter().all(|e| e.kind == KIND_PLAN_PROGRESS));
        assert!(ev[0].account_id.is_none() && ev[0].ref_id.is_none());
        // 같은 수는 한 번만, 0 으로 돌아가면 지난 기록을 지운다.
        assert!(stall_events_for(&mut st, "r1", "c1", (2, 1), false).is_empty());
        assert_eq!(
            stall_events_for(&mut st, "r1", "c1", (2, 0), false).len(),
            1
        );
        assert!(stall_events_for(&mut st, "r1", "c1", (0, 0), false).is_empty());
        assert!(st.seen.is_empty());
        assert_eq!(
            stall_events_for(&mut st, "r1", "c1", (1, 1), false).len(),
            2
        );
    }

    #[test]
    fn loop_name_is_registered() {
        assert!(super::super::LOOP_NAMES.contains(&"plan.progress"));
    }

    #[test]
    fn events_carry_branch_and_count_only() {
        let mut seen = Seen::new();
        let ev = events_for(&mut seen, "r1", "c1", (2, 0, 1), true);
        assert_eq!(ev.len(), 2);
        assert!(ev.iter().all(|e| e.kind == KIND_PLAN_PROGRESS));
        assert_eq!(ev[0].value, Some(2));
        assert_eq!(
            ev[0].detail,
            Some(json!({"branch": "would_block", "truncated": true}))
        );
        assert_eq!(ev[1].value, Some(1));
        assert_eq!(ev[1].detail.as_ref().unwrap()["branch"], "would_start");
        assert_eq!(ev[0].thread_root_id.as_deref(), Some("r1"));
        assert_eq!(ev[0].channel_id.as_deref(), Some("c1"));
        assert!(ev[0].account_id.is_none() && ev[0].ref_id.is_none());
    }

    #[test]
    fn same_counts_are_recorded_once() {
        let mut seen = Seen::new();
        assert_eq!(events_for(&mut seen, "r1", "c1", (1, 0, 0), false).len(), 1);
        assert!(events_for(&mut seen, "r1", "c1", (1, 0, 0), false).is_empty());
        // 달라지면 다시 남긴다.
        assert_eq!(events_for(&mut seen, "r1", "c1", (0, 1, 0), false).len(), 1);
        // 0 으로 돌아가면 줄은 없고 지난 기록을 지운다 — 다음에 같은 수가 나오면 다시 남는다.
        assert!(events_for(&mut seen, "r1", "c1", (0, 0, 0), false).is_empty());
        assert!(seen.is_empty());
        assert_eq!(events_for(&mut seen, "r1", "c1", (0, 1, 0), false).len(), 1);
        // 아무 판정도 없던 계획은 줄이 없다.
        assert!(events_for(&mut seen, "r2", "c1", (0, 0, 0), false).is_empty());
    }

    #[test]
    fn only_uuid_shaped_ids_reach_the_cast() {
        let got = uuids([
            "a0000000-0000-0000-0000-000000000001".to_string(),
            "a0000000-0000-0000-0000-000000000001".to_string(),
            "not-a-uuid".to_string(),
        ]);
        assert_eq!(got, ["a0000000-0000-0000-0000-000000000001"]);
    }
}

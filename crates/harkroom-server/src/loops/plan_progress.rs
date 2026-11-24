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

/// sweep 한 번 — 남길 줄들. 읽기만 한다.
pub async fn sweep(pool: &PgPool, seen: &mut Seen) -> Result<Vec<Event>, sqlx::Error> {
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
    let assignees = uuids(plans.iter().flat_map(|(_, _, d)| judge::assignee_ids(d)));
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
    Ok(out)
}

/// 루프를 띄운다 — 60초마다. 주인이 `rust` 일 때만 실제로 돈다. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀이다.
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(PLAN_PROGRESS_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut seen = Seen::new();
        loop {
            every.tick().await;
            // 남길 곳이 없으면 읽지도 않는다.
            let Some(record) = measure::pool() else {
                continue;
            };
            let (p, s) = (&pool, &mut seen);
            match run_gated(&gate, "plan.progress", Side::Rust, || async move {
                for e in sweep(p, s).await? {
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
        for sql in [PLANS_SQL, CARDS_SQL, AGENTS_SQL] {
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

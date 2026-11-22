//! 기준선 측정 기록(A1) — 표 `measure_event`(migration 178). 뒤 단계의 「켬」 판단이 비교할 지금 값을 쌓는다.
//!
//! - **기록만 한다.** 동작은 바꾸지 않는다: [`record`] 는 요청 밖(`tokio::spawn`)에서 한 줄을 넣고, 실패는 로그 한 줄로 삼킨다.
//!   부른 쪽의 트랜잭션·응답·지연에 닿지 않는다.
//! - 켜는 곳은 `main.rs` 한 군데([`enable`]) — 쓰기 풀에 [`MEASURE_PRIVILEGES`] 가 다 있을 때만. 안 켜졌으면 [`record`] 는 아무것도 안 한다.
//! - 글 본문·핸들은 싣지 않는다 — id 와 수, 갈래 이름만.
//! - 읽기는 [`summary`] — 기간 안의 `kind`·갈래별 건수와 `value` 의 합·평균·p50·p95·최댓값.
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

/// 멘션이 inbox 에 들어온 뒤 턴 임대가 나기까지 기다린 초(`value`). `turn_lease::issue`.
pub const KIND_QUEUE_WAIT: &str = "queue.wait";
/// 머지 권한 거절 한 건 — `detail.code`·`detail.branch`. `merge_checks` 의 거절 세 곳.
pub const KIND_MERGE_DENIED: &str = "merge.denied";
/// 위임 의무 하나가 닫힌 결말 — `detail.outcome`·`detail.reason`. 기한 스윕·위임자 닫기.
pub const KIND_DELEGATION_OUTCOME: &str = "delegation.outcome";
/// 에이전트 글이 `@핸들` 을 적었지만 깨우지 못한 호출 — `detail.reason`. `mention_calls::resolve`.
pub const KIND_CALL_MISSED: &str = "call.missed";
/// 턴 하나의 토큰 — `detail` 에 input·output·cache.
pub const KIND_TURN_TOKENS: &str = "turn.tokens";

/// 기록이 쓰는 권한 — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 기록을 켜지 않는다(나머지는 그대로 돈다).
pub const MEASURE_PRIVILEGES: &[(&str, &str)] =
    &[("measure_event", "SELECT"), ("measure_event", "INSERT")];

static POOL: OnceLock<PgPool> = OnceLock::new();

/// 기록을 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 사건 한 줄. id 칸은 uuid 글자(아니면 그 줄은 버려진다 — 기록 실패로 삼킨다).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Event {
    pub kind: &'static str,
    pub account_id: Option<String>,
    pub channel_id: Option<String>,
    pub thread_root_id: Option<String>,
    pub ref_id: Option<String>,
    pub value: Option<i64>,
    pub detail: Option<Value>,
}

pub const INSERT_SQL: &str = "insert into measure_event (kind, account_id, channel_id, thread_root_id, ref_id, value, detail) \
     values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb)";

/// 한 줄을 넣는다. 실패는 종류만 로그에 남기고 삼킨다.
pub async fn record_with(pool: &PgPool, e: Event) {
    let r = sqlx::query(INSERT_SQL)
        .bind(e.kind)
        .bind(e.account_id)
        .bind(e.channel_id)
        .bind(e.thread_root_id)
        .bind(e.ref_id)
        .bind(e.value)
        .bind(e.detail.unwrap_or_else(|| json!({})).to_string())
        .execute(pool)
        .await;
    if let Err(err) = r {
        eprintln!(
            "front: measure record failed ({}): {}",
            e.kind,
            err.as_database_error().map_or("io", |_| "db")
        );
    }
}

/// best-effort 기록 — 기다리지 않는다. 켜지지 않았거나 런타임 밖이면 아무것도 안 한다.
pub fn record(e: Event) {
    let Some(pool) = POOL.get() else { return };
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let pool = pool.clone();
    rt.spawn(async move { record_with(&pool, e).await });
}

/// 머지 거절 코드 → 끊긴 갈래. 모르는 코드는 `other`(코드 자체는 `detail.code` 에 남는다).
pub fn denial_branch(code: &str) -> &'static str {
    match code {
        "lease_invalid" => "lease",
        "bad_repo" => "repo",
        "not_granted" => "grant",
        "cause_not_human" => "cause_chain",
        "no_mandate_line" => "mandate_line",
        _ => "other",
    }
}

/// 머지 거절 한 건.
pub fn merge_denied(agent: &str, code: &str, channel: Option<&str>, root: Option<&str>) {
    record(Event {
        kind: KIND_MERGE_DENIED,
        account_id: Some(agent.to_string()),
        channel_id: channel.map(str::to_string),
        thread_root_id: root.map(str::to_string),
        detail: Some(json!({ "code": code, "branch": denial_branch(code) })),
        ..Event::default()
    });
}

/// 닫힌 위임 의무들 — 위임 id 하나에 한 줄(`ref_id`). `reason` 은 `closed_reason`(없으면 `None`).
pub fn delegation_outcomes(ids: &[String], outcome: &str, reason: Option<&str>) {
    for id in ids {
        record(Event {
            kind: KIND_DELEGATION_OUTCOME,
            ref_id: Some(id.clone()),
            detail: Some(json!({ "outcome": outcome, "reason": reason })),
            ..Event::default()
        });
    }
}

/// 기간(`$1` 초) 안의 `kind`·갈래별 집계. 갈래는 `detail` 의 `branch` → `reason` → `outcome` 순으로 처음 있는 값.
pub const SUMMARY_SQL: &str = "select kind, coalesce(detail->>'branch', detail->>'reason', detail->>'outcome', '') as branch, \
            count(*)::int8 as n, coalesce(sum(value), 0)::int8 as total, \
            coalesce(avg(value), 0)::float8 as mean, \
            coalesce(percentile_cont(0.5) within group (order by value), 0)::float8 as p50, \
            coalesce(percentile_cont(0.95) within group (order by value), 0)::float8 as p95, \
            coalesce(max(value), 0)::int8 as max \
       from measure_event where created_at >= now() - make_interval(secs => $1::float8) \
      group by 1, 2 order by 1, 2";

type SummaryRow = (String, String, i64, i64, f64, f64, f64, i64);

/// [`SUMMARY_SQL`] 을 돌려 JSON 줄로.
pub async fn summary(pool: &PgPool, window_sec: i64) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<SummaryRow> = sqlx::query_as(SUMMARY_SQL)
        .bind(window_sec as f64)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(kind, branch, n, total, mean, p50, p95, max)| {
            json!({ "kind": kind, "branch": branch, "count": n, "sum": total, "mean": mean, "p50": p50, "p95": p95, "max": max })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denial_codes_map_to_branches() {
        assert_eq!(denial_branch("lease_invalid"), "lease");
        assert_eq!(denial_branch("bad_repo"), "repo");
        assert_eq!(denial_branch("not_granted"), "grant");
        assert_eq!(denial_branch("cause_not_human"), "cause_chain");
        assert_eq!(denial_branch("no_mandate_line"), "mandate_line");
        assert_eq!(denial_branch("something_new"), "other");
    }

    #[test]
    fn record_is_a_no_op_until_enabled() {
        // 켜지지 않았고 런타임도 없다 — 패닉 없이 돌아온다.
        record(Event {
            kind: KIND_QUEUE_WAIT,
            value: Some(3),
            ..Event::default()
        });
        merge_denied("a", "not_granted", None, None);
        delegation_outcomes(&["d".to_string()], "timeout", None);
    }

    #[test]
    fn privileges_cover_insert_and_summary() {
        for p in ["SELECT", "INSERT"] {
            assert!(MEASURE_PRIVILEGES.contains(&("measure_event", p)));
        }
        assert!(INSERT_SQL.starts_with("insert into measure_event"));
        assert!(SUMMARY_SQL.contains("from measure_event"));
    }
}

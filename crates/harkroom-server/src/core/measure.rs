//! 기준선 측정 기록(A1) — 표 `measure_event`(migration 178). 뒤 단계의 「켬」 판단이 비교할 지금 값을 쌓는다.
//!
//! - **기록만 한다.** 동작은 바꾸지 않는다: [`record`] 는 요청 밖(`tokio::spawn`)에서 한 줄을 넣고, 실패는 로그 한 줄로 삼킨다.
//!   부른 쪽의 트랜잭션·응답·지연에 닿지 않는다.
//! - 켜는 곳은 `main.rs` 한 군데([`enable`]) — 쓰기 풀에 [`MEASURE_PRIVILEGES`] 가 다 있을 때만. 안 켜졌으면 [`record`] 는 아무것도 안 한다.
//! - 글 본문·핸들은 싣지 않는다 — id 와 수, 갈래 이름만.
//! - 읽기는 [`summary`]·`GET /measure/summary`([`summary_route`], 관리자만) — 기간 안의 `kind`·갈래별 건수와 `value` 의 합·평균·p50·p95·최댓값.
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
/// 턴 하나의 토큰 — `value` 는 합, `detail` 에 harness·model·input·output·cacheRead·cacheWrite·messages·durationMs(모르는 칸은 없음). [`turn_tokens`].
pub const KIND_TURN_TOKENS: &str = "turn.tokens";
/// 팀 명단 갈래를 지난 위임 한 건(T1) — `value` 는 명단으로 지나간 팀원 중 호출 게이트였다면 막혔을 수,
/// `detail.branch` 는 `gate_would_pass`·`gate_would_block`·`unknown`(판정 못 함). `message.delegate` 게이트.
pub const KIND_TEAM_ROUTE: &str = "team.route";

/// 기록이 쓰는 권한 — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 기록을 켜지 않는다(나머지는 그대로 돈다).
pub const MEASURE_PRIVILEGES: &[(&str, &str)] =
    &[("measure_event", "SELECT"), ("measure_event", "INSERT")];

static POOL: OnceLock<PgPool> = OnceLock::new();

/// 기록을 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 켜졌을 때의 풀 — 읽기 길([`summary_route`])이 같은 역할로 읽는다. 안 켜졌으면 `None`.
pub fn pool() -> Option<&'static PgPool> {
    POOL.get()
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

/// 닫힌 호출 누락들 — 대상 하나에 한 줄(`ref_id`). `missed` 는 `mention_calls::Resolved::missed`(대상, 이유).
pub fn calls_missed<'a>(
    author: &str,
    channel: &str,
    missed: impl IntoIterator<Item = &'a (String, &'static str)>,
) {
    for (reference, reason) in missed {
        record(Event {
            kind: KIND_CALL_MISSED,
            account_id: Some(author.to_string()),
            channel_id: Some(channel.to_string()),
            ref_id: Some(reference.clone()),
            detail: Some(json!({ "reason": reason })),
            ..Event::default()
        });
    }
}

/// [`KIND_TEAM_ROUTE`] 한 줄의 갈래와 `detail` — `would_block` 은 게이트였다면 막혔을 수(`None` = 판정 못 함).
pub fn team_route_event(
    to: usize,
    gated: usize,
    would_block: Option<usize>,
) -> (&'static str, Value) {
    let branch = match would_block {
        None => "unknown",
        Some(0) => "gate_would_pass",
        Some(_) => "gate_would_block",
    };
    (
        branch,
        json!({ "branch": branch, "to": to, "gated": gated, "skipped": to.saturating_sub(gated) }),
    )
}

/// 팀 명단 갈래를 지난 위임 한 건. `to` 는 받는 쪽 수, `gated` 는 그중 호출 게이트를 거친 수.
pub fn team_route(
    lead: &str,
    channel: &str,
    root: &str,
    to: usize,
    gated: usize,
    would_block: Option<usize>,
) {
    let (_, detail) = team_route_event(to, gated, would_block);
    record(Event {
        kind: KIND_TEAM_ROUTE,
        account_id: Some(lead.to_string()),
        channel_id: Some(channel.to_string()),
        thread_root_id: Some(root.to_string()),
        value: would_block.map(|n| n as i64),
        detail: Some(detail),
        ..Event::default()
    });
}

/// 토큰 수 한 칸의 상한 — 넘는 값은 그 칸만 버린다(턴 하나가 이만큼 쓸 수 없다).
pub const TOKEN_COUNT_MAX: i64 = 2_000_000_000;
/// 턴 길이 상한(ms) — 7일.
pub const TURN_DURATION_MAX_MS: i64 = 7 * 86_400_000;
/// 모델 id·하네스 이름 길이 상한(글자).
pub const MODEL_ID_MAX_CHARS: usize = 80;
pub const HARNESS_NAME_MAX_CHARS: usize = 32;

fn bounded(v: Option<&Value>, max: i64) -> Option<i64> {
    v.and_then(Value::as_i64).filter(|n| (0..=max).contains(n))
}

/// 러너가 턴 끝 보고(`POST /agent/activity`)의 선택 칸 `tokens` 로 보낸 값 → [`KIND_TURN_TOKENS`] 한 줄.
/// 거절하지 않는다: 음수·상한 넘는 수·수가 아닌 칸은 그 칸만 버리고, 모르는 칸은 무시한다. 토큰 수가 하나도
/// 남지 않으면 줄을 만들지 않는다(`None`). `value` 는 남은 토큰 수의 합. 글·경로는 싣지 않는다 — 수와 이름만.
pub fn turn_tokens_event(account: &str, tokens: &Value) -> Option<Event> {
    let t = tokens.as_object()?;
    let mut detail = serde_json::Map::new();
    let mut total: i64 = 0;
    let mut any = false;
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        if let Some(n) = bounded(t.get(key), TOKEN_COUNT_MAX) {
            total = total.saturating_add(n);
            any = true;
            detail.insert(key.to_string(), json!(n));
        }
    }
    if !any {
        return None;
    }
    if let Some(n) = bounded(t.get("messages"), TOKEN_COUNT_MAX) {
        detail.insert("messages".into(), json!(n));
    }
    if let Some(n) = bounded(t.get("durationMs"), TURN_DURATION_MAX_MS) {
        detail.insert("durationMs".into(), json!(n));
    }
    // 하네스 이름은 소문자·숫자·`-` 만(아니면 버린다). 모델 id 는 하네스가 준 글자 그대로 — 제어 문자만 빼고 길이를 자른다.
    if let Some(h) = t.get("harness").and_then(Value::as_str).filter(|h| {
        !h.is_empty()
            && h.len() <= HARNESS_NAME_MAX_CHARS
            && h.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }) {
        detail.insert("harness".into(), json!(h));
    }
    if let Some(m) = t.get("model").and_then(Value::as_str) {
        let m: String = m
            .chars()
            .filter(|c| !c.is_control())
            .take(MODEL_ID_MAX_CHARS)
            .collect();
        if !m.is_empty() {
            detail.insert("model".into(), json!(m));
        }
    }
    Some(Event {
        kind: KIND_TURN_TOKENS,
        account_id: Some(account.to_string()),
        value: Some(total),
        detail: Some(Value::Object(detail)),
        ..Event::default()
    })
}

/// 턴 끝 보고 본문에 `tokens` 가 있으면 한 줄 적는다. 없거나(옛 러너) 쓸 수 없으면 아무것도 안 한다.
pub fn turn_tokens(account: &str, body: Option<&Value>) {
    if let Some(e) = body
        .and_then(|b| b.get("tokens"))
        .and_then(|t| turn_tokens_event(account, t))
    {
        record(e);
    }
}

macro_rules! summary_sql {
    ($cond:literal) => {
        concat!(
            "select kind, coalesce(detail->>'branch', detail->>'reason', detail->>'outcome', '') as branch, \
            count(*)::int8 as n, coalesce(sum(value), 0)::int8 as total, \
            coalesce(avg(value), 0)::float8 as mean, \
            coalesce(percentile_cont(0.5) within group (order by value), 0)::float8 as p50, \
            coalesce(percentile_cont(0.95) within group (order by value), 0)::float8 as p95, \
            coalesce(max(value), 0)::int8 as max \
       from measure_event where ",
            $cond,
            " group by 1, 2 order by 1, 2"
        )
    };
}

/// 기간(`$1` 초) 안의 `kind`·갈래별 집계. 갈래는 `detail` 의 `branch` → `reason` → `outcome` 순으로 처음 있는 값.
pub const SUMMARY_SQL: &str =
    summary_sql!("created_at >= now() - make_interval(secs => $1::float8)");

/// 같은 집계를 `[$1, $2)`(epoch ms) 구간으로.
pub const SUMMARY_BETWEEN_SQL: &str = summary_sql!(
    "created_at >= to_timestamp($1::float8 / 1000.0) and created_at < to_timestamp($2::float8 / 1000.0)"
);

type SummaryRow = (String, String, i64, i64, f64, f64, f64, i64);

fn summary_json(rows: Vec<SummaryRow>) -> Vec<Value> {
    rows.into_iter()
        .map(|(kind, branch, n, total, mean, p50, p95, max)| {
            json!({ "kind": kind, "branch": branch, "count": n, "sum": total, "mean": mean, "p50": p50, "p95": p95, "max": max })
        })
        .collect()
}

/// [`SUMMARY_SQL`] 을 돌려 JSON 줄로.
pub async fn summary(pool: &PgPool, window_sec: i64) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<SummaryRow> = sqlx::query_as(SUMMARY_SQL)
        .bind(window_sec as f64)
        .fetch_all(pool)
        .await?;
    Ok(summary_json(rows))
}

/// [`SUMMARY_BETWEEN_SQL`] — `[since_ms, until_ms)` 구간의 줄.
pub async fn summary_between(
    pool: &PgPool,
    since_ms: i64,
    until_ms: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<SummaryRow> = sqlx::query_as(SUMMARY_BETWEEN_SQL)
        .bind(since_ms as f64)
        .bind(until_ms as f64)
        .fetch_all(pool)
        .await?;
    Ok(summary_json(rows))
}

/// 줄들을 `kind` 별 건수로 접는다(줄 순서 = `kind` 순서).
pub fn kind_counts(rows: &[Value]) -> Vec<Value> {
    let mut out: Vec<(String, i64)> = vec![];
    for r in rows {
        let (k, n) = (
            r["kind"].as_str().unwrap_or_default(),
            r["count"].as_i64().unwrap_or(0),
        );
        match out.last_mut() {
            Some((last, total)) if last == k => *total += n,
            _ => out.push((k.to_string(), n)),
        }
    }
    out.into_iter()
        .map(|(kind, count)| json!({ "kind": kind, "count": count }))
        .collect()
}

/// 읽기 창의 기본(7일)·상한(31일), ms.
pub const DEFAULT_WINDOW_MS: i64 = 7 * 86_400_000;
pub const MAX_WINDOW_MS: i64 = 31 * 86_400_000;

/// `since`·`until`(epoch ms, 숫자만) → `[since, until)`. 없으면 `until = now`, `since = until - 7일`. 창이 31일을 넘으면 `since` 를 당긴다.
/// 모르는 키는 버린다. 꼴이 틀리거나 `since >= until` 이면 `Err`.
pub fn parse_window(raw: Option<&str>, now_ms: i64) -> Result<(i64, i64), &'static str> {
    let (mut since, mut until): (Option<i64>, Option<i64>) = (None, None);
    for (k, v) in crate::directory::form_pairs(raw.unwrap_or("")) {
        let slot = match k.as_str() {
            "since" => &mut since,
            "until" => &mut until,
            _ => continue,
        };
        if slot.is_some() {
            return Err("duplicate query key");
        }
        if v.is_empty() || v.len() > 15 || !v.bytes().all(|b| b.is_ascii_digit()) {
            return Err("since/until must be epoch milliseconds");
        }
        *slot = v.parse().ok();
    }
    let until = until.unwrap_or(now_ms);
    let since = since.unwrap_or(until - DEFAULT_WINDOW_MS);
    if since >= until {
        return Err("since must be before until");
    }
    Ok((since.max(until - MAX_WINDOW_MS), until))
}

/// `GET /measure/summary` — 관리자만(`RequireAdmin`). 기록이 안 켜졌으면(권한 없음) 옮기지 않은 줄처럼 404 `not_found`.
pub async fn summary_route(
    _admin: crate::auth::RequireAdmin,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> axum::response::Response {
    use axum::http::StatusCode;
    let Some(pool) = pool() else {
        return crate::directory::json_err(StatusCode::NOT_FOUND, "not_found", "not found");
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let (since, until) = match parse_window(raw.as_deref(), now_ms) {
        Ok(w) => w,
        Err(m) => return crate::directory::json_err(StatusCode::BAD_REQUEST, "invalid_request", m),
    };
    match summary_between(pool, since, until).await {
        Ok(rows) => crate::directory::json_ok(
            json!({ "since": since, "until": until, "kinds": kind_counts(&rows), "rows": rows })
                .to_string(),
        ),
        Err(e) => crate::directory::internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_tokens_keeps_valid_fields_and_drops_the_rest() {
        let e = turn_tokens_event(
            "a1",
            &json!({
                "harness": "claude-code", "model": "model-x", "input": 10, "output": 5,
                "cacheRead": 100, "cacheWrite": 7, "messages": 3, "durationMs": 1200,
                "prompt": "hello", "path": "/x"
            }),
        )
        .unwrap();
        assert_eq!(e.kind, KIND_TURN_TOKENS);
        assert_eq!(e.account_id.as_deref(), Some("a1"));
        assert_eq!(e.value, Some(122));
        assert_eq!(
            e.detail.unwrap(),
            json!({
                "harness": "claude-code", "model": "model-x", "input": 10, "output": 5,
                "cacheRead": 100, "cacheWrite": 7, "messages": 3, "durationMs": 1200
            })
        );
    }

    #[test]
    fn turn_tokens_drops_bad_numbers_without_rejecting() {
        // 음수·상한 넘는 수·문자열·소수는 그 칸만 버린다. 캐시 칸이 없어도 된다.
        let e = turn_tokens_event(
            "a1",
            &json!({
                "input": -1, "output": 9, "cacheRead": TOKEN_COUNT_MAX + 1, "cacheWrite": "7",
                "durationMs": TURN_DURATION_MAX_MS + 1, "messages": 1.5,
                "harness": "Bad Name", "model": format!("m\n{}", "x".repeat(200))
            }),
        )
        .unwrap();
        assert_eq!(e.value, Some(9));
        let d = e.detail.unwrap();
        assert_eq!(d["output"], 9);
        for k in [
            "input",
            "cacheRead",
            "cacheWrite",
            "durationMs",
            "messages",
            "harness",
        ] {
            assert!(d.get(k).is_none(), "{k}");
        }
        let m = d["model"].as_str().unwrap();
        assert_eq!(m.chars().count(), MODEL_ID_MAX_CHARS);
        assert!(m.starts_with("mx"));
    }

    #[test]
    fn turn_tokens_without_counts_is_no_event() {
        assert!(turn_tokens_event("a1", &json!({ "model": "m", "durationMs": 5 })).is_none());
        assert!(turn_tokens_event("a1", &json!({ "input": "many" })).is_none());
        assert!(turn_tokens_event("a1", &json!([1, 2])).is_none());
        assert!(turn_tokens_event("a1", &json!(null)).is_none());
        // 0 은 「모름」이 아니라 잰 값이다.
        assert_eq!(
            turn_tokens_event("a1", &json!({ "input": 0 }))
                .unwrap()
                .value,
            Some(0)
        );
        // 본문이 없거나 `tokens` 칸이 없으면(옛 러너) 아무 일도 없다 — 기록이 꺼져 있어도 던지지 않는다.
        turn_tokens("a1", None);
        turn_tokens("a1", Some(&json!({})));
    }

    #[test]
    fn team_route_branches() {
        assert_eq!(team_route_event(2, 0, Some(0)).0, "gate_would_pass");
        assert_eq!(team_route_event(2, 1, Some(1)).0, "gate_would_block");
        let (branch, detail) = team_route_event(3, 1, None);
        assert_eq!(branch, "unknown");
        assert_eq!(detail["skipped"], 2);
        assert_eq!(detail["branch"], "unknown");
    }

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
    fn window_defaults_caps_and_rejects() {
        let now = 1_800_000_000_000_i64;
        assert_eq!(parse_window(None, now), Ok((now - DEFAULT_WINDOW_MS, now)));
        assert_eq!(
            parse_window(Some("since=10&until=20&x=1"), now),
            Ok((10, 20))
        );
        // 상한을 넘는 창은 since 를 당긴다.
        assert_eq!(
            parse_window(Some("since=0"), now),
            Ok((now - MAX_WINDOW_MS, now))
        );
        assert_eq!(
            parse_window(Some("until=5000000000"), now),
            Ok((5_000_000_000 - DEFAULT_WINDOW_MS, 5_000_000_000))
        );
        for bad in [
            "since=abc",
            "since=",
            "since=-1",
            "since=20&until=10",
            "since=1&since=2",
        ] {
            assert!(parse_window(Some(bad), now).is_err(), "{bad}");
        }
    }

    #[test]
    fn kind_counts_fold_branches() {
        let rows = vec![
            json!({ "kind": "a", "branch": "x", "count": 2 }),
            json!({ "kind": "a", "branch": "y", "count": 3 }),
            json!({ "kind": "b", "branch": "", "count": 1 }),
        ];
        assert_eq!(
            kind_counts(&rows),
            vec![
                json!({ "kind": "a", "count": 5 }),
                json!({ "kind": "b", "count": 1 })
            ]
        );
    }

    #[test]
    fn privileges_cover_insert_and_summary() {
        assert!(
            SUMMARY_BETWEEN_SQL.contains("from measure_event where created_at >= to_timestamp")
        );
        assert!(SUMMARY_BETWEEN_SQL.ends_with("group by 1, 2 order by 1, 2"));
        for p in ["SELECT", "INSERT"] {
            assert!(MEASURE_PRIVILEGES.contains(&("measure_event", p)));
        }
        assert!(INSERT_SQL.starts_with("insert into measure_event"));
        assert!(SUMMARY_SQL.contains("from measure_event"));
    }
}

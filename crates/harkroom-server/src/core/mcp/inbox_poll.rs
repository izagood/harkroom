//! MCP `inbox.poll` 의 빈 즉답 갈래(TS `mcpPlugin.ts` `inbox.poll`). Rust 는 **기다리지 않는 폴**(`timeoutMs` 없음·0)에
//! 버전·임대가 없고, 안 읽은 줄이 하나도 없을 때만 답한다 — 그때 TS 는 `{entries:[],messages:[]}` 를 내고, 에이전트면
//! `stopRequestedAt`(키는 늘 있다)을 덧붙인다. 그 밖은 모두 `None`(→ TS): 긴 폴(이벤트 버스·종료 park), `version` 기록·`lease`
//! 임대(쓰기), 줄이 있는 배치(본문 펼치기·시스템 줄 표시·`memoryRev`), 아직 승인 안 된 종료 요청(TS `ackAgentStop` 이 쓴다),
//! zod 를 못 지나는 인자, DB 오류. 읽기만 한다 — 쓰기 권한(`*_PRIVILEGES`)이 필요 없다.
use super::respond::text_result;
use crate::auth::Account;
use crate::core::inbox_list::{InboxQuery, list_inbox};
use serde_json::Value;
use sqlx::PgPool;

/// TS `readAgentStop` 의 SELECT — 시각은 `Date#toISOString` 꼴(UTC·밀리초·`Z`)로 Postgres 가 짓는다.
const AGENT_STOP_SQL: &str = "select to_char(stop_requested_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       stop_acked_at is not null from agent_config where account_id = $1::uuid";

/// zod 를 지나고 Rust 가 답할 꼴이면 참 — `timeoutMs` 는 없거나 0, `version`·`lease` 는 없어야(있으면 TS 가 쓴다).
fn quick(args: &Value) -> bool {
    let o = match args {
        Value::Object(o) => o,
        _ => return false,
    };
    let timeout_ok = match o.get("timeoutMs") {
        None => true,
        Some(v) => v.as_f64() == Some(0.0),
    };
    let reasons_ok = match o.get("inboxReasons") {
        None => true,
        Some(v) => v
            .as_array()
            .is_some_and(|a| a.len() <= 32 && a.iter().all(Value::is_string)),
    };
    timeout_ok && reasons_ok && !o.contains_key("version") && !o.contains_key("lease")
}

/// `{"entries":[],"messages":[]}` 에 에이전트면 종료 요청 키를 붙인다. `stop` = (요청 시각, 승인됨). 승인 안 된 요청이면 `None`.
fn empty_text(agent: bool, stop: Option<(Option<String>, bool)>) -> Option<String> {
    if !agent {
        return Some(text_result("{\"entries\":[],\"messages\":[]}"));
    }
    let at = match stop {
        Some((Some(at), true)) => Value::from(at).to_string(),
        Some((Some(_), false)) => return None,
        _ => "null".to_string(),
    };
    Some(text_result(&format!(
        "{{\"entries\":[],\"messages\":[],\"stopRequestedAt\":{at}}}"
    )))
}

pub async fn answer(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    if !quick(args) {
        return None;
    }
    // 빈 목록에는 위임 요약이 붙지 않으니 `v2` 값과 무관하다.
    let rows = list_inbox(pool, &me.id, InboxQuery::Unread { since: None }, false)
        .await
        .ok()?;
    if !rows.is_empty() {
        return None;
    }
    let agent = me.kind == "agent";
    let stop = if agent {
        sqlx::query_as::<_, (Option<String>, bool)>(AGENT_STOP_SQL)
            .bind(&me.id)
            .fetch_optional(pool)
            .await
            .ok()?
    } else {
        None
    };
    empty_text(agent, stop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quick_only_for_no_wait_no_write() {
        assert!(quick(&json!({})));
        assert!(quick(
            &json!({ "timeoutMs": 0, "inboxReasons": ["mention"], "claudeLane": 1 })
        ));
        for bad in [
            json!(null),
            json!({ "timeoutMs": 25000 }),
            json!({ "timeoutMs": "0" }),
            json!({ "version": "1" }),
            json!({ "lease": { "runnerId": "r", "holding": [] } }),
            json!({ "inboxReasons": [1] }),
        ] {
            assert!(!quick(&bad), "{bad}");
        }
    }

    #[test]
    fn empty_shape_matches_ts() {
        let inner = |s: Option<String>| -> String {
            let v: Value = serde_json::from_str(&s.unwrap()).unwrap();
            v.pointer("/content/0/text")
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(
            inner(empty_text(false, None)),
            "{\"entries\":[],\"messages\":[]}"
        );
        assert_eq!(
            inner(empty_text(true, None)),
            "{\"entries\":[],\"messages\":[],\"stopRequestedAt\":null}"
        );
        assert_eq!(
            inner(empty_text(
                true,
                Some((Some("2026-01-01T00:00:00.000Z".into()), true))
            )),
            "{\"entries\":[],\"messages\":[],\"stopRequestedAt\":\"2026-01-01T00:00:00.000Z\"}"
        );
        assert!(empty_text(true, Some((Some("x".into()), false))).is_none());
    }
}

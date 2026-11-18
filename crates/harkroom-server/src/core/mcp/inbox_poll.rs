//! MCP `inbox.poll` 의 빈 즉답 갈래(TS `mcpPlugin.ts` `inbox.poll`). Rust 는 **기다리지 않는 폴**(`timeoutMs` 없음·0)에
//! 버전·임대가 없을 때 답한다. 줄이 없으면 — 그때 TS 는 `{entries:[],messages:[]}` 를 내고, 에이전트면
//! `stopRequestedAt`(키는 늘 있다)을 덧붙인다. 줄이 있으면 `{entries,messages}`(본문 펼치기·시스템 줄 표시)에 에이전트면
//! `memoryRev` — 위임 스위치(`HARKROOM_DELEGATION_V2`)가 없거나 `delegation_update` 사유를 고쳐 써야 하면 TS. 그 밖은 모두 `None`(→ TS): 긴 폴(이벤트 버스·종료 park), `version` 기록·`lease`
//! 임대(쓰기), 아직 승인 안 된 종료 요청(TS `ackAgentStop` 이 쓴다),
//! zod 를 못 지나는 인자, DB 오류. 읽기만 한다 — 쓰기 권한(`*_PRIVILEGES`)이 필요 없다.
use super::respond::{minify, text_result};
use crate::auth::Account;
use crate::core::inbox_list::{InboxQuery, list_inbox};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::OnceLock;

/// TS `select ${MESSAGE_COLS} from message where id = any($1) order by seq` — 칸은 골든 `message_by_id`(같은 `COLS`)에서 꼬리
/// (`from message where …`)만 바꿔 쓰고, 맨 겉 시각 셋은 `msg_read` 와 같이 `toISOString` 꼴로 다시 짓는다.
fn messages_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let by_id = v["message_by_id"].as_str().expect("golden message_by_id");
        let tail = " from message where id = $1::uuid and deleted_at is null";
        let cols = by_id.strip_suffix(tail).expect("message_by_id tail");
        format!(
            "with t as ({cols}, seq as \"__seq\" from message where id = any($1::uuid[])) \
             select json_object_agg(e.key, case e.key \
               when 'createdAt' then to_json({}) \
               when 'editedAt' then to_json({}) \
               when 'deletedAt' then to_json({}) \
               else e.value end order by e.ord)::text \
             from t, json_each(row_to_json(t)) with ordinality as e(key, value, ord) \
             where e.key <> '__seq' group by t.id, t.\"__seq\" order by t.\"__seq\"",
            crate::iso!("t.\"createdAt\""),
            crate::iso!("t.\"editedAt\""),
            crate::iso!("t.\"deletedAt\""),
        )
    })
}

/// TS `memoryRev`.
const MEMORY_REV_SQL: &str = "select coalesce(\
       md5(string_agg(slug || ':' || (extract(epoch from updated_at) * 1000000)::bigint, ',' order by slug)), \
       'empty') as rev from agent_memory where account_id = $1::uuid";

/// 줄 있는 배치를 TS 처럼 고칠 일이 있으면 참(→ TS): 위임 v2 가 켜졌고 러너가 `delegation_update` 를 밝히지 않았는데 그 사유 줄이 있다
/// (TS 는 사유를 `delegation_followup` 으로 바꾸거나 읽음으로 접는다 — 버전에 따라, 접기는 쓰기).
fn needs_reason_rewrite(v2: bool, args: &Value, reasons: &[Option<String>]) -> bool {
    if !v2 {
        return false;
    }
    let knows = args
        .get("inboxReasons")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|r| r == "delegation_update"));
    !knows
        && reasons
            .iter()
            .any(|r| r.as_deref() == Some("delegation_update"))
}

/// 줄 있는 배치의 응답 글자 — `{"entries":[…],"messages":[…]}` 에 에이전트면 `memoryRev`.
fn batch_text(entries: &[String], messages: &str, rev: Option<&str>) -> String {
    let rev = rev
        .map(|r| format!(",\"memoryRev\":{}", Value::from(r)))
        .unwrap_or_default();
    text_result(&format!(
        "{{\"entries\":[{}],\"messages\":{messages}{rev}}}",
        entries.join(",")
    ))
}

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
    let agent = me.kind == "agent";
    if !rows.is_empty() {
        return batch(pool, me, args, &rows, agent).await;
    }
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

async fn batch(
    pool: &PgPool,
    me: &Account,
    args: &Value,
    rows: &[crate::core::inbox_list::InboxRow],
    agent: bool,
) -> Option<String> {
    // TS 는 스위치가 없으면 꺼짐으로 본다 — Rust 는 값이 없으면 모르니 TS 로(`msg_post::delegation_v2`).
    let v2 = crate::core::msg_post::delegation_v2(
        std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref(),
    )?;
    // 위에서 `v2=false` 로 읽었으니, 켜졌으면 위임 요약이 붙은 줄로 다시 읽는다.
    let rows = if v2 {
        list_inbox(pool, &me.id, InboxQuery::Unread { since: None }, true)
            .await
            .ok()?
    } else {
        rows.to_vec()
    };
    if rows.is_empty() {
        return None;
    }
    let mut entries = Vec::with_capacity(rows.len());
    let mut reasons = Vec::with_capacity(rows.len());
    let mut ids = Vec::with_capacity(rows.len());
    for r in &rows {
        let v: Value = serde_json::from_str(&r.body).ok()?;
        let id = v.get("messageId")?.as_str()?;
        if !crate::core::channels::is_uuid(id) {
            return None;
        }
        ids.push(id.to_owned());
        reasons.push(v.get("reason").and_then(Value::as_str).map(str::to_owned));
        entries.push(minify(&r.body));
    }
    if needs_reason_rewrite(v2, args, &reasons) {
        return None;
    }
    let msgs: Vec<String> = sqlx::query_scalar::<_, String>(messages_sql())
        .bind(&ids)
        .fetch_all(pool)
        .await
        .ok()?
        .iter()
        .map(|r| minify(r))
        .collect();
    let arr = super::tools::denormalize_marked(pool, &msgs).await?;
    let rev = if agent {
        Some(
            sqlx::query_scalar::<_, String>(MEMORY_REV_SQL)
                .bind(&me.id)
                .fetch_one(pool)
                .await
                .ok()?,
        )
    } else {
        None
    };
    Some(batch_text(&entries, &arr, rev.as_deref()))
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
    fn reason_rewrite_goes_to_ts() {
        let upd = [Some("delegation_update".to_owned()), None];
        assert!(!needs_reason_rewrite(false, &json!({}), &upd));
        assert!(needs_reason_rewrite(true, &json!({}), &upd));
        assert!(!needs_reason_rewrite(
            true,
            &json!({ "inboxReasons": ["delegation_update"] }),
            &upd
        ));
        assert!(!needs_reason_rewrite(
            true,
            &json!({}),
            &[Some("mention".into())]
        ));
    }

    #[test]
    fn batch_shape_matches_ts() {
        let inner = |s: String| -> String {
            let v: Value = serde_json::from_str(&s).unwrap();
            v.pointer("/content/0/text")
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(
            inner(batch_text(&["{\"id\":1}".into()], "[]", None)),
            "{\"entries\":[{\"id\":1}],\"messages\":[]}"
        );
        assert_eq!(
            inner(batch_text(
                &["{\"id\":1}".into(), "{\"id\":2}".into()],
                "[{}]",
                Some("empty")
            )),
            "{\"entries\":[{\"id\":1},{\"id\":2}],\"messages\":[{}],\"memoryRev\":\"empty\"}"
        );
    }

    #[test]
    fn messages_sql_builds() {
        assert!(messages_sql().contains("id = any($1::uuid[])"));
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

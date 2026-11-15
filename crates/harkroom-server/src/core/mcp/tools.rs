//! C4a-3 — Rust 가 답하는 읽기 도구. TS `mcpPlugin.ts` 의 같은 이름 도구와 **같은 글자**를 낸다(대조: `tests/contrast.rs` 의 MCP 줄).
//!
//! - 인자 모양은 TS zod 가 받는 것만 받는다. 모양이 조금이라도 다르면(객체 아님·uuid 아님·타입 다름) Rust 는 답하지 않고 TS 로 넘긴다
//!   — SDK 의 검증 오류 글자(`Input validation error: …`)를 따라 쓰지 않고 정본을 하나로 둔다. zod `z.object` 는 모르는 키를 버리므로
//!   더 붙은 키는 받는다.
//! - DB 오류도 TS 로 넘긴다(같은 요청을 TS 가 다시 답한다 — 읽기라 두 번 돌아도 바뀌는 것이 없다).
//! - 결과 글자: 행은 Postgres 가 짓고(`json`, 열 순서 = 키 순서) [`super::respond::minify`] 로 공백만 지운다. TS 는 node-pg 가 읽은
//!   객체를 `JSON.stringify` 하므로 키 순서·값이 같고 공백이 없다.
use super::respond::{minify, text_result};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// 이 단계에서 Rust 가 답하는 도구.
pub const SERVED: &[&str] = &["account.me", "account.list", "channel.list", "channel.doc"];

/// 입력 스키마가 없는 도구 — SDK 는 `arguments` 를 레코드(객체)로만 받는다. 없으면 `{}` 로 들어온다.
fn no_input(args: &Value) -> bool {
    args.is_object()
}

/// `z.string().uuid()`(zod 3) 인 필수 칸.
fn uuid_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.as_object()?
        .get(key)?
        .as_str()
        .filter(|s| crate::core::channels::is_uuid(s))
}

fn err(code: &str, message: &str) -> String {
    text_result(&format!(
        "{{\"error\":{{\"code\":{},\"message\":{}}}}}",
        Value::from(code),
        Value::from(message)
    ))
}

/// TS `req.account`(auth plugin `ACCOUNT_COLS` 순서) 그대로.
fn account_text(a: &Account) -> String {
    let s = |v: &str| Value::from(v).to_string();
    let o = |v: &Option<String>| v.as_deref().map_or("null".to_string(), s);
    format!(
        "{{\"id\":{},\"handle\":{},\"displayName\":{},\"kind\":{},\"isAdmin\":{},\"role\":{},\"status\":{},\"statusText\":{},\"avatarAttachmentId\":{}}}",
        s(&a.id),
        s(&a.handle),
        s(&a.display_name),
        s(&a.kind),
        a.is_admin,
        s(&a.role),
        s(&a.status),
        o(&a.status_text),
        o(&a.avatar_attachment_id),
    )
}

/// `account.list` — TS 는 질의 셋(계정 · `listTeams` · `listHandleGroups`)의 행을 `{ accounts, teams, groups }` 로 묶는다. 팀은
/// `{id,name,leadAccountId}`, 집합은 `{id,handle}` 만 싣는다(`mcpPlugin.ts` 의 map). 같은 문장·같은 정렬을 한 문장으로.
const ACCOUNT_LIST_SQL: &str = "select json_build_object(\
 'accounts', coalesce((select json_agg(t) from (select id, handle, display_name as \"displayName\", kind, \
   disabled_at is not null as disabled, deleted_at is not null as deleted from account order by handle) t), '[]'::json), \
 'teams', coalesce((select json_agg(t) from (select t.id, t.name, t.lead_account_id as \"leadAccountId\" \
   from agent_team t order by t.name) t), '[]'::json), \
 'groups', coalesce((select json_agg(t) from (select g.id, g.handle from handle_group g order by g.handle) t), '[]'::json))::text";

/// 도구 하나의 답(`result` 글자). `None` 이면 TS 로.
pub async fn answer(pool: &PgPool, me: &Account, tool: &str, args: &Value) -> Option<String> {
    match tool {
        "account.me" => no_input(args).then(|| text_result(&account_text(me))),
        "account.list" => {
            if !no_input(args) {
                return None;
            }
            let j: String = sqlx::query_scalar(ACCOUNT_LIST_SQL)
                .fetch_one(pool)
                .await
                .ok()?;
            Some(text_result(&minify(&j)))
        }
        // admin 예외 없음(TS 주석: 이 목록은 곧 message.read 로 이어진다).
        "channel.list" => {
            if !no_input(args) {
                return None;
            }
            let rows = crate::core::channels::list_text(pool, &me.id, false)
                .await
                .ok()?;
            Some(text_result(&format!("{{\"channels\":{}}}", minify(&rows))))
        }
        "channel.doc" => {
            let id = uuid_arg(args, "channelId")?;
            if !crate::core::channels::visible(pool, &me.id, id)
                .await
                .ok()?
            {
                return Some(err("forbidden", "not a member of this channel"));
            }
            let rows = minify(&crate::core::channels::doc_rows_text(pool, id).await.ok()?);
            if rows == "[]" {
                return Some(text_result(&format!(
                    "{{\"channelId\":{},\"body\":\"\",\"updatedBy\":null,\"updatedAt\":null}}",
                    Value::from(id)
                )));
            }
            // 채널마다 문서는 하나 — 한 행 배열이 아니면 모르는 꼴이니 TS 로.
            let one = rows.strip_prefix('[')?.strip_suffix(']')?;
            (serde_json::from_str::<Value>(&rows).ok()?.as_array()?.len() == 1)
                .then(|| text_result(one))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_are_pure_reads_in_registry() {
        for n in SERVED {
            let s = super::super::find(n).expect(n);
            assert_eq!(s.access, super::super::Access::Read, "{n}");
        }
    }

    #[test]
    fn arg_shapes_follow_zod() {
        assert!(no_input(&serde_json::json!({})));
        assert!(no_input(&serde_json::json!({"extra": 1})));
        assert!(!no_input(&serde_json::json!([])));
        assert!(!no_input(&serde_json::json!("x")));
        let id = "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";
        assert_eq!(
            uuid_arg(&serde_json::json!({"channelId": id, "x": 1}), "channelId"),
            Some(id)
        );
        for bad in [
            serde_json::json!({"channelId": "nope"}),
            serde_json::json!({"channelId": 1}),
            serde_json::json!({}),
            serde_json::json!([id]),
            serde_json::json!(id),
        ] {
            assert_eq!(uuid_arg(&bad, "channelId"), None, "{bad}");
        }
    }

    #[test]
    fn account_text_matches_ts_column_order() {
        let a = Account {
            id: "i".into(),
            handle: "h".into(),
            display_name: "D \"q\"".into(),
            kind: "agent".into(),
            is_admin: false,
            role: "member".into(),
            status: "active".into(),
            status_text: None,
            avatar_attachment_id: Some("x".into()),
        };
        assert_eq!(
            account_text(&a),
            r#"{"id":"i","handle":"h","displayName":"D \"q\"","kind":"agent","isAdmin":false,"role":"member","status":"active","statusText":null,"avatarAttachmentId":"x"}"#
        );
        let src = include_str!("../../../../../packages/server/src/auth/plugin.ts");
        assert!(src.contains(
            "const ACCOUNT_COLS = `a.id, a.handle, a.display_name as \"displayName\", a.kind, a.is_admin as \"isAdmin\",\n  a.role, a.status, a.status_text as \"statusText\", a.avatar_attachment_id as \"avatarAttachmentId\"`;"
        ));
    }

    /// 문장을 TS 원본과 맞춘다 — TS 가 칸·정렬을 바꾸면 여기서 깨진다(값 비교는 대조 시험이 한다).
    #[test]
    fn account_list_follows_ts_source() {
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(mcp.contains(
            "`select id, handle, display_name as \"displayName\", kind,\n                disabled_at is not null as disabled, deleted_at is not null as deleted\n         from account order by handle`"
        ));
        assert!(mcp.contains(
            "(await listTeams(pool)).map((t) => ({ id: t.id, name: t.name, leadAccountId: t.leadAccountId }))"
        ));
        assert!(mcp.contains(
            "(await listHandleGroups(pool)).map((g) => ({ id: g.id, handle: g.handle }))"
        ));
        assert!(mcp.contains("return jsonResult({ accounts: res.rows, teams, groups });"));
        let teams = include_str!("../../../../../packages/server/src/services/teams.ts");
        assert!(teams.contains("t.lead_account_id as \"leadAccountId\""));
        assert!(teams.contains("`select ${COLS} from agent_team t order by t.name`"));
        let groups = include_str!("../../../../../packages/server/src/services/handleGroups.ts");
        assert!(groups.contains("`select ${COLS} from handle_group g order by g.handle`"));
    }

    #[test]
    fn minify_keeps_order_and_strings() {
        assert_eq!(
            minify("[{\"b\" : 1, \"a\" : \"x : y\\\" z\"}, \n {\"c\" : [1, 2]}]"),
            r#"[{"b":1,"a":"x : y\" z"},{"c":[1,2]}]"#
        );
        assert_eq!(
            text_result("{\"a\":\"\n\u{1}é\"}"),
            r#"{"content":[{"type":"text","text":"{\"a\":\"\n\u0001é\"}"}]}"#
        );
    }
}

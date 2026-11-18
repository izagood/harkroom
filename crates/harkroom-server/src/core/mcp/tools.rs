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
pub const SERVED: &[&str] = &[
    "workspace.guide",
    "account.me",
    "account.list",
    "channel.list",
    "channel.doc",
    "message.read",
    // C4a-4
    "memory.list",
    "secret.list",
    "thread.note.list",
    // C4a-5
    "memory.revisions",
    // C4a-6a
    "workitem.list",
    "automation.list",
    // C4a-6b
    "message.search",
    // C4b
    "grant.list",
    // S5.4 A2a — 오퍼레이터 코어가 Rust 일 때만 답한다(`route` 가 `relay_moved` 로 거른다, [`super::model_options`]).
    "agent.modelOptions",
    // S5.4 A2b
    "memory.audit",
    // S5.4 통합 — 오퍼레이터가 가로채는 도구([`super::operator_only`], DB 없이 `operator_required`)
    "secret.mount",
    "secret.generate",
    "secret.import",
    "secret.rotate",
    "attachment.upload",
    "pr.status",
];

/// 입력 스키마가 없는 도구 — SDK 는 `arguments` 를 레코드(객체)로만 받고, 없어도(`null`) 받는다. 스키마가 있는 도구는
/// `arguments` 가 없으면 검증 오류라 각 도구가 `as_object()` 에서 TS 로 넘긴다.
pub(super) fn no_input(args: &Value) -> bool {
    args.is_object() || args.is_null()
}

/// `z.string().uuid()`(zod 3) 인 필수 칸.
pub(super) fn uuid_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.as_object()?
        .get(key)?
        .as_str()
        .filter(|s| crate::core::channels::is_uuid(s))
}

pub(super) fn err(code: &str, message: &str) -> String {
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

/// zod `z.number().int().min(lo).max(hi).optional()` — 없으면 `Some(None)`, 맞으면 `Some(Some(n))`, 틀리면 `None`(→ TS).
pub(super) fn opt_int(args: &Value, key: &str, lo: i64, hi: i64) -> Option<Option<i64>> {
    match args.get(key) {
        None => Some(None),
        Some(v) => v.as_i64().filter(|n| (lo..=hi).contains(n)).map(Some),
    }
}

/// `z.string().uuid().optional()`.
pub(super) fn opt_uuid(args: &Value, key: &str) -> Option<Option<String>> {
    match args.get(key) {
        None => Some(None),
        Some(v) => v
            .as_str()
            .filter(|s| crate::core::channels::is_uuid(s))
            .map(|s| Some(s.to_owned())),
    }
}

/// shared `ANY_MENTION_TOKEN_PATTERN` — 집합·팀(접두) 먼저, 그다음 계정.
fn mention_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        regex::Regex::new(r"<@(?:((?:group|team):[0-9a-f-]{36})|([0-9a-f-]{36}))>")
            .expect("mention re")
    })
}

/// 맨 겉 객체의 `key` 값이 문자열이면 그 글자 범위(따옴표 포함). 공백 없는 JSON([`minify`] 뒤)만 받는다.
fn top_string_span(t: &str, key: &str) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    let str_end = |i: usize| -> Option<usize> {
        let mut j = i + 1;
        while j < b.len() {
            match b[j] {
                b'\\' => j += 2,
                b'"' => return Some(j + 1),
                _ => j += 1,
            }
        }
        None
    };
    let (mut depth, mut want_key, mut i) = (0usize, false, 0usize);
    while i < b.len() {
        match b[i] {
            b'"' => {
                let e = str_end(i)?;
                if depth == 1 && want_key {
                    want_key = false;
                    if serde_json::from_str::<String>(&t[i..e]).ok()? == key
                        && b.get(e) == Some(&b':')
                    {
                        return (b.get(e + 1) == Some(&b'"'))
                            .then(|| str_end(e + 1).map(|v| (e + 1, v)))?;
                    }
                }
                i = e;
                continue;
            }
            b'{' | b'[' => {
                depth += 1;
                want_key = depth == 1 && b[i] == b'{';
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            b',' if depth == 1 => want_key = true,
            _ => {}
        }
        i += 1;
    }
    None
}

/// `message.read` — TS `listMessages` → `denormalizeBodies`(본문의 `<@…>` 를 지금 이름으로) → `markSystemLines`.
async fn message_read(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let channel = uuid_arg(args, "channelId")?;
    let since = opt_int(args, "since", 0, i64::MAX)?;
    let limit = opt_int(args, "limit", 1, 500)?;
    let thread = opt_uuid(args, "threadRootId")?;
    if !crate::core::channels::visible(pool, &me.id, channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    let rows: Vec<String> =
        crate::core::msg_list::rows_for_mcp(pool, channel, since, limit, thread)
            .await
            .ok()?
            .iter()
            .map(|r| minify(r))
            .collect();
    let arr = denormalize_marked(pool, &rows).await?;
    Some(text_result(&format!("{{\"messages\":{arr}}}")))
}

/// TS `markSystemLines(await denormalizeBodies(pool, rows))` — 행 JSON 글자들([`minify`] 뒤)을 받아 배열 글자 `[…]` 를 낸다.
/// `message.read`·`message.search` 가 같이 쓴다. 모르는 꼴·DB 오류는 `None`(→ TS).
pub(super) async fn denormalize_marked(pool: &PgPool, rows: &[String]) -> Option<String> {
    // 본문마다 (범위, 본문). 본문이 문자열이 아닌 행은 모르는 꼴이니 TS 로.
    let mut bodies = Vec::with_capacity(rows.len());
    let (mut ids, mut groups, mut teams) = (Vec::new(), Vec::new(), Vec::new());
    for r in rows {
        let (a, z) = top_string_span(r, "body")?;
        let body: String = serde_json::from_str(&r[a..z]).ok()?;
        for c in mention_re().captures_iter(&body) {
            if let Some(t) = c.get(1) {
                let (kind, id) = t.as_str().split_once(':')?;
                (if kind == "group" {
                    &mut groups
                } else {
                    &mut teams
                })
                .push(id.to_owned());
            } else if let Some(id) = c.get(2) {
                ids.push(id.as_str().to_owned());
            }
        }
        bodies.push((a, z, body));
    }
    let mut names: std::collections::HashMap<String, String> = Default::default();
    // TS 는 `= any($1)` 로 uuid 열과 비교한다 — uuid 꼴이 아닌 글자가 섞이면 TS 쪽 질의가 깨진다. 그 경우는 TS 에 맡긴다.
    let all_uuid = |v: &[String]| v.iter().all(|s| crate::core::channels::is_uuid(s));
    if !(all_uuid(&ids) && all_uuid(&groups) && all_uuid(&teams)) {
        return None;
    }
    for (sql, list, prefix) in [
        (
            "select id::text, handle from account where id = any($1::uuid[])",
            &ids,
            "",
        ),
        (
            "select id::text, handle from handle_group where id = any($1::uuid[])",
            &groups,
            "group:",
        ),
        (
            "select id::text, name from agent_team where id = any($1::uuid[])",
            &teams,
            "team:",
        ),
    ] {
        if list.is_empty() {
            continue;
        }
        let got: Vec<(String, String)> =
            sqlx::query_as(sql).bind(list).fetch_all(pool).await.ok()?;
        for (id, name) in got {
            names.insert(format!("{prefix}{id}"), name);
        }
    }
    let mut out = String::from("[");
    for (i, (r, (a, z, body))) in rows.iter().zip(bodies).enumerate() {
        if i > 0 {
            out.push(',');
        }
        let new_body = mention_re().replace_all(&body, |c: &regex::Captures| {
            let key = c.get(1).or(c.get(2)).map_or("", |m| m.as_str());
            match names.get(key) {
                Some(h) => format!("@{h}"),
                None => c[0].to_owned(),
            }
        });
        let mut row = String::with_capacity(r.len() + 64);
        row.push_str(&r[..a]);
        row.push_str(&Value::from(new_body.as_ref()).to_string());
        row.push_str(&r[z..]);
        // markSystemLines — `{ ...m, relatedAccountId: m.authorId }`(새 키는 끝에).
        let v: Value = serde_json::from_str(&row).ok()?;
        if v.get("relatedAccountId").is_some() {
            return None;
        }
        if v.get("kind").and_then(Value::as_str) == Some("system")
            && let Some(author) = v
                .get("authorId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        {
            row.pop()?;
            row.push_str(&format!(",\"relatedAccountId\":{}}}", Value::from(author)));
        }
        out.push_str(&row);
    }
    out.push(']');
    Some(out)
}

/// `workspace.guide` 의 글 — TS `guideFor(mode, { avcs })` 넷을 `golden/mcp_guide.json` 으로 받는다
/// (`packages/server/test/rustMcpGuideGolden.test.ts` 가 TS 와 같은지 본다).
fn guide(mode: &str, avcs: bool) -> Option<&'static str> {
    static G: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let g = G.get_or_init(|| {
        serde_json::from_str(include_str!("../../../golden/mcp_guide.json"))
            .expect("golden/mcp_guide.json")
    });
    let key = match (mode, avcs) {
        ("resident", true) => "resident",
        ("resident", false) => "resident_no_avcs",
        ("turn", true) => "turn",
        ("turn", false) => "turn_no_avcs",
        _ => return None,
    };
    g.get(key)?.as_str()
}

/// 도구 하나의 답(`result` 글자). `None` 이면 TS 로.
/// `cause` 는 요청의 `x-harkroom-cause`(TS mcpPlugin 처럼 uuid 꼴 하나만, [`super::reads3::cause_from`]).
pub async fn answer(
    pool: &PgPool,
    me: &Account,
    tool: &str,
    args: &Value,
    cause: Option<&str>,
) -> Option<String> {
    match tool {
        // `mode: z.enum(['resident','turn']).optional()` · `avcs: z.unknown().optional()` — 정확히 `false` 일 때만 avcs 절을 뺀다.
        "workspace.guide" => {
            let o = args.as_object()?;
            let mode = match o.get("mode") {
                None => "resident",
                Some(Value::String(m)) if m == "resident" || m == "turn" => m.as_str(),
                Some(_) => return None,
            };
            let g = guide(mode, o.get("avcs") != Some(&Value::Bool(false)))?;
            Some(text_result(&format!("{{\"guide\":{}}}", Value::from(g))))
        }
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
        "message.read" => message_read(pool, me, args).await,
        "message.search" => super::search::answer(pool, me, args).await,
        "memory.audit" => super::mem_audit::answer(pool, me, args).await,
        "grant.list" => super::reads4::answer(pool, me, tool, args).await,
        "secret.mount" | "secret.generate" | "secret.import" | "secret.rotate"
        | "attachment.upload" | "pr.status" => super::operator_only::answer(tool, args),
        "workitem.list" | "automation.list" => {
            super::reads3::answer(pool, me, tool, args, cause).await
        }
        "memory.list" | "secret.list" | "thread.note.list" | "memory.revisions" => {
            super::reads2::answer(pool, me, tool, args).await
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_are_pure_reads_in_registry() {
        // 오퍼레이터가 가로채는 도구(`Operator`)는 DB 에 닿지 않고 고정 글자만 낸다([`super::operator_only`]) — 읽기와 같이 친다.
        for n in SERVED {
            let s = super::super::find(n).expect(n);
            let operator_only = super::super::operator_only::SERVED.contains(n);
            let want = if operator_only {
                super::super::Access::Operator
            } else {
                super::super::Access::Read
            };
            assert_eq!(s.access, want, "{n}");
        }
    }

    #[test]
    fn arg_shapes_follow_zod() {
        assert!(no_input(&serde_json::json!({})));
        assert!(no_input(&serde_json::json!({"extra": 1})));
        assert!(!no_input(&serde_json::json!([])));
        assert!(!no_input(&serde_json::json!("x")));
        assert!(no_input(&Value::Null));
        assert_eq!(uuid_arg(&Value::Null, "channelId"), None);
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
    fn guide_golden_has_all_four() {
        for (m, a) in [
            ("resident", true),
            ("resident", false),
            ("turn", true),
            ("turn", false),
        ] {
            assert!(guide(m, a).is_some_and(|g| g.ends_with('\n')), "{m} {a}");
        }
        assert_ne!(guide("turn", true), guide("turn", false));
        assert_eq!(guide("other", true), None);
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

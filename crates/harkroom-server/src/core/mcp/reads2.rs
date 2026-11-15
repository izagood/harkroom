//! C4a-4 — 읽기 도구 2차 첫 묶음: `memory.list` · `secret.list` · `thread.note.list`. [`super::tools`] 와 같은 약속이다 —
//! TS 와 **같은 글자**(대조: `rustFrontDb.test.ts` 의 MCP 줄), zod 가 그대로 받는 인자만, DB 오류·모르는 꼴은 TS 로.
use super::respond::{minify, text_result};
use super::tools::{no_input, opt_int, opt_uuid};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `memory.list` = `listMemoryIndex` · `memoryRev` · `bgCleanupOn`(services/memory.ts · bgJobs.ts) 의 문장 그대로.
/// `bgCleanup` 은 서버 env(`HARKROOM_BACKGROUND_ENABLED`)에 걸려 있다 — 앞단이 그 env 를 TS 와 같게 받는다는 보장이 없으므로
/// 그 값이 참일 **수 있는** 에이전트(설정이 켜졌고 하네스가 claude-code)는 Rust 가 답하지 않는다. 나머지는 env 와 상관없이 거짓이다.
const MEMORY_LIST_SQL: &str = "with e as (select slug, case when flagged_at is null then description end as description, kind \
       from agent_memory where account_id = $1::uuid and archived_at is null order by slug) \
     select json_build_object( \
       'slugs', coalesce((select json_agg(e.slug) from e), '[]'::json), \
       'entries', coalesce((select json_agg(e) from e), '[]'::json), \
       'rev', (select coalesce(md5(string_agg(slug || ':' || (extract(epoch from updated_at) * 1000000)::bigint, ',' order by slug)), 'empty') \
               from agent_memory where account_id = $1::uuid))::text, \
       coalesce((select bg_enabled = true and harness = 'claude-code' from agent_config where account_id = $1::uuid), false)";

/// TS `listGrantedSecrets`(services/secretAccess.ts) 그대로 — 값·판·소유자는 싣지 않는다.
const SECRET_LIST_SQL: &str = "select coalesce(json_agg(t), '[]'::json)::text from ( \
     select s.name, s.kind, s.filename, s.description, array_agg(distinct g.channel_id) as \"channelIds\" \
       from secret_grant g join secret s on s.id = g.secret_id join account o on o.id = s.owner_account_id \
       join agent_config ac on ac.account_id = g.agent_id and ac.owner_account_id = s.owner_account_id \
      where g.agent_id = $1::uuid and g.suspended_at is null \
        and (s.expires_at is null or s.expires_at > now()) \
        and o.deleted_at is null and o.disabled_at is null \
        and exists (select 1 from secret_version v where v.secret_id = s.id and v.revoked_at is null and v.sealed is not null) \
      group by s.id order by s.name) t";

/// TS `THREAD_NOTE_LIST_MAX`.
const THREAD_NOTE_LIST_MAX: i64 = 100;

fn thread_note_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        // TS `listThreadNotes` — 가시성 술어는 TS 골든(`channelVisibleSql('c', '$1::uuid')`). timestamptz 는 toISOString 꼴로.
        format!(
            "select n.thread_root_id::text, m.channel_id::text, c.name, m.body, n.body, \
               to_char(n.updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), n.flag_reason \
               from thread_note n \
               join message m on m.id = n.thread_root_id and m.deleted_at is null \
               join channel c on c.id = m.channel_id \
              where n.account_id = $1::uuid and n.archived_at is null \
                and ($2::uuid is null or m.channel_id = $2::uuid) \
                and {} \
              order by n.updated_at desc \
              limit $3",
            crate::core::channels::frag("channel_visible_c_p1uuid")
        )
    })
}

/// JS `String.prototype.trim` 이 지우는 글자(WhiteSpace + LineTerminator). Rust `char::is_whitespace` 와 다르다
/// (JS 는 U+FEFF 를 지우고 U+0085 는 두며, Zs 만 공백으로 본다).
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\u{b}'
            | '\u{c}'
            | ' '
            | '\u{a0}'
            | '\u{feff}'
            | '\n'
            | '\r'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_ws)
}

/// TS `firstLine(text, max)` — 빈 줄 아닌 첫 줄을 다듬고, UTF-16 길이로 `max` 를 넘으면 `max-1` 단위 + `…`.
/// 자르는 자리가 서로게이트 쌍 한가운데면 JS 는 짝 잃은 서로게이트를 내는데 Rust 문자열은 그것을 못 담는다 → `None`(TS 로).
fn first_line(text: &str, max: usize) -> Option<String> {
    let line = js_trim(
        text.split('\n')
            .find(|l| !js_trim(l).is_empty())
            .unwrap_or(""),
    );
    if line.encode_utf16().count() <= max {
        return Some(line.to_owned());
    }
    let mut out = String::new();
    let mut units = 0;
    for c in line.chars() {
        let n = c.len_utf16();
        if units + n > max - 1 {
            if units < max - 1 {
                return None;
            }
            break;
        }
        units += n;
        out.push(c);
    }
    out.push('…');
    Some(out)
}

/// TS `MEMORY_SLUG_REGEX`(services/memory.ts) + 길이 255. 맞지 않으면 TS 가 `invalid_slug` 로 답한다 — Rust 는 그 글을 따라 쓰지 않고 넘긴다.
pub(super) fn valid_slug(slug: &str) -> bool {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = R.get_or_init(|| {
        regex::Regex::new(r"^core$|^mem/[a-z0-9][a-z0-9_-]{0,63}((/[a-z0-9][a-z0-9_-]{0,63})*)$")
            .expect("slug re")
    });
    !slug.is_empty() && slug.len() <= 255 && re.is_match(slug)
}

/// JS 참·거짓(`...(x ? { k: x } : {})` 갈래).
pub(super) fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// jsonb 값을 node-pg 가 읽어 `JSON.stringify` 한 글자로 — 키 순서는 jsonb 출력 그대로(공백만 지운다). 정수가 아닌 수나
/// 2^53 을 넘는 수가 있으면 JS 의 수 표기와 갈릴 수 있으니 `None`(→ TS).
pub(super) fn jsonb_as_js(text: &str) -> Option<String> {
    fn ok(v: &Value) -> bool {
        match v {
            Value::Number(n) => n.as_i64().is_some_and(|i| i.unsigned_abs() <= (1u64 << 53)),
            Value::Array(a) => a.iter().all(ok),
            Value::Object(o) => o.values().all(ok),
            _ => true,
        }
    }
    let v: Value = serde_json::from_str(text).ok()?;
    ok(&v).then(|| minify(text))
}

/// `memory.revisions` — TS `listMemoryRevisions` 문장 + 도구의 map(빈 칸은 키째 뺀다, `chars` 는 UTF-16 길이).
async fn memory_revisions(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    // `slug: z.string().min(1)` — 모양이 틀리거나 판정에 걸리면 TS 로.
    let slug = args.as_object()?.get("slug")?.as_str()?;
    if !valid_slug(slug) {
        return None;
    }
    type R = (
        i32,
        String,
        Option<String>,
        String,
        String,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<R> = sqlx::query_as(
        "select id::int, value, description, \
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
           to_char(replaced_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
           flagged, reason, detail::text, kind \
         from agent_memory_revision where account_id = $1::uuid and slug = $2 \
         order by replaced_at desc, id desc",
    )
    .bind(&me.id)
    .bind(slug)
    .fetch_all(pool)
    .await
    .ok()?;
    let mut out = String::from("{\"revisions\":[");
    for (i, (id, value, description, updated, replaced, flagged, reason, detail, kind)) in
        rows.into_iter().enumerate()
    {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"id\":{id},\"updatedAt\":{},\"replacedAt\":{},\"chars\":{}",
            Value::from(updated),
            Value::from(replaced),
            value.encode_utf16().count()
        ));
        let opt = |k: &str, v: Option<String>, out: &mut String| {
            if let Some(v) = v.filter(|v| !v.is_empty()) {
                out.push_str(&format!(",\"{k}\":{}", Value::from(v)));
            }
        };
        opt("kind", kind, &mut out);
        opt("description", description, &mut out);
        opt("reason", reason, &mut out);
        if let Some(d) = detail {
            let v: Value = serde_json::from_str(&d).ok()?;
            if js_truthy(&v) {
                out.push_str(&format!(",\"detail\":{}", jsonb_as_js(&d)?));
            }
        }
        if flagged {
            out.push_str(",\"flagged\":true");
        }
        out.push('}');
    }
    out.push_str("]}");
    Some(text_result(&out))
}

pub(super) async fn answer(
    pool: &PgPool,
    me: &Account,
    tool: &str,
    args: &Value,
) -> Option<String> {
    match tool {
        "memory.list" => {
            if !no_input(args) {
                return None;
            }
            let (text, bg): (String, bool) = sqlx::query_as(MEMORY_LIST_SQL)
                .bind(&me.id)
                .fetch_one(pool)
                .await
                .ok()?;
            (!bg).then(|| text_result(&minify(&text)))
        }
        // MCP 는 에이전트만 오므로 TS 의 「에이전트가 아니면 빈 목록」 갈래는 닿지 않는다.
        "secret.list" => {
            if !no_input(args) {
                return None;
            }
            let rows: String = sqlx::query_scalar(SECRET_LIST_SQL)
                .bind(&me.id)
                .fetch_one(pool)
                .await
                .ok()?;
            Some(text_result(&format!("{{\"secrets\":{}}}", minify(&rows))))
        }
        "memory.revisions" => memory_revisions(pool, me, args).await,
        "thread.note.list" => {
            args.as_object()?;
            let channel = opt_uuid(args, "channelId")?;
            let limit = opt_int(args, "limit", 1, THREAD_NOTE_LIST_MAX)?.unwrap_or(50);
            type R = (
                String,
                String,
                Option<String>,
                Option<String>,
                String,
                String,
                Option<String>,
            );
            let rows: Vec<R> = sqlx::query_as(thread_note_sql())
                .bind(&me.id)
                .bind(channel)
                .bind(limit)
                .fetch_all(pool)
                .await
                .ok()?;
            let mut out = String::from("{\"notes\":[");
            for (i, (root, ch, name, root_body, body, at, flag)) in rows.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                // TS: `noteFirstLine: r.flag_reason ? '' : …`(빈 글자는 거짓 — 본문을 보인다) · `flagged: r.flag_reason !== null`.
                let note = if flag.as_deref().is_some_and(|f| !f.is_empty()) {
                    String::new()
                } else {
                    first_line(&body, 120)?
                };
                out.push_str(&format!(
                    "{{\"threadRootId\":{},\"channelId\":{},\"channelName\":{},\"rootFirstLine\":{},\"noteFirstLine\":{},\"flagged\":{},\"updatedAt\":{}}}",
                    Value::from(root),
                    Value::from(ch),
                    name.map_or(Value::Null, Value::from),
                    Value::from(first_line(root_body.as_deref().unwrap_or(""), 80)?),
                    Value::from(note),
                    flag.is_some(),
                    Value::from(at),
                ));
            }
            out.push_str("]}");
            Some(text_result(&out))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_matches_js() {
        assert_eq!(
            first_line("\n  \n  hi there \nnext", 80).as_deref(),
            Some("hi there")
        );
        assert_eq!(first_line("", 80).as_deref(), Some(""));
        // JS trim 은 U+FEFF 를 지우고 U+0085 는 둔다.
        assert_eq!(first_line("\u{feff}x\u{feff}", 80).as_deref(), Some("x"));
        assert_eq!(first_line("\u{85}x", 80).as_deref(), Some("\u{85}x"));
        assert_eq!(first_line("abcdef", 4).as_deref(), Some("abc…"));
        assert_eq!(first_line("abcd", 4).as_deref(), Some("abcd"));
        // 한글은 UTF-16 한 단위.
        assert_eq!(first_line("가나다라마", 4).as_deref(), Some("가나다…"));
        // 서로게이트 쌍(😀 = 2 단위)을 자르는 자리면 TS 로.
        assert_eq!(first_line("ab😀cd", 4), None);
        assert_eq!(first_line("a😀bcd", 4).as_deref(), Some("a😀…"));
    }

    #[test]
    fn slug_and_truthiness_follow_ts() {
        for ok in ["core", "mem/a", "mem/a-b/c_d", "mem/0"] {
            assert!(valid_slug(ok), "{ok}");
        }
        for bad in [
            "", "Core", "mem/", "mem/A", "mem/a.b", "mem//a", "x", "mem/-a", "core/x",
        ] {
            assert!(!valid_slug(bad), "{bad}");
        }
        assert!(
            !js_truthy(&serde_json::json!(""))
                && !js_truthy(&Value::Null)
                && !js_truthy(&serde_json::json!(0))
        );
        assert!(js_truthy(&serde_json::json!({})) && js_truthy(&serde_json::json!([])));
        assert_eq!(
            jsonb_as_js(r#"{"from": ["mem/a", "mem/b"]}"#).as_deref(),
            Some(r#"{"from":["mem/a","mem/b"]}"#)
        );
        assert_eq!(jsonb_as_js(r#"{"n": 1.5}"#), None);
    }

    /// 문장을 TS 원본과 맞춘다 — TS 가 칸·조건을 바꾸면 여기서 깨진다(값 비교는 대조 시험이 한다).
    #[test]
    fn statements_follow_ts_source() {
        let mem = include_str!("../../../../../packages/server/src/services/memory.ts");
        assert!(mem.contains("`select slug, case when flagged_at is null then description end as description, kind\n     from agent_memory where account_id = $1 and archived_at is null order by slug`"));
        assert!(mem.contains("md5(string_agg(slug || ':' || (extract(epoch from updated_at) * 1000000)::bigint, ',' order by slug)),\n       'empty') as rev\n     from agent_memory where account_id = $1`"));
        let bg = include_str!("../../../../../packages/server/src/services/bgJobs.ts");
        assert!(bg.contains("return env.HARKROOM_BACKGROUND_ENABLED === '1';"));
        assert!(bg.contains(
            "return r.rows[0]?.bg_enabled === true && r.rows[0].harness === BG_HARNESS;"
        ));
        assert!(bg.contains("export const BG_HARNESS = 'claude-code';"));
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(mcp.contains("return jsonResult({ slugs: entries.map((e) => e.slug), entries, rev, ...(bgCleanup ? { bgCleanup: true } : {}) });"));
        assert!(mcp.contains(
            "return jsonResult({ secrets: await listGrantedSecrets(pool, account.id) });"
        ));
        assert!(mcp.contains(
            "notes: notes.map((n) => ({ ...n, updatedAt: n.updatedAt.toISOString() })),"
        ));
        let sec = include_str!("../../../../../packages/server/src/services/secretAccess.ts");
        assert!(sec.contains("`select s.name, s.kind, s.filename, s.description, array_agg(distinct g.channel_id) as \"channelIds\""));
        assert!(sec.contains("group by s.id order by s.name`, [agentId]);"));
        let tn = include_str!("../../../../../packages/server/src/services/threadNote.ts");
        assert!(tn.contains("export const THREAD_NOTE_LIST_MAX = 100;"));
        assert!(tn.contains(
            "const limit = Math.min(Math.max(opts.limit ?? 50, 1), THREAD_NOTE_LIST_MAX);"
        ));
        assert!(tn.contains("rootFirstLine: firstLine(r.root_body ?? '', 80),\n    noteFirstLine: r.flag_reason ? '' : firstLine(r.body, 120),"));
        assert!(tn.contains("return line.length > max ? `${line.slice(0, max - 1)}…` : line;"));
        assert!(tn.contains("noteFirstLine: r.flag_reason ? '' : firstLine(r.body, 120),\n    flagged: r.flag_reason !== null,"));
        assert!(mem.contains("const MEMORY_SLUG_REGEX = /^core$|^mem\\/[a-z0-9][a-z0-9_-]{0,63}((\\/[a-z0-9][a-z0-9_-]{0,63})*)$/;"));
        assert!(mem.contains(
            "return slug.length > 0 && slug.length <= 255 && MEMORY_SLUG_REGEX.test(slug);"
        ));
        assert!(mem.contains("`select id::int as id, value, description, updated_at as \"updatedAt\", replaced_at as \"replacedAt\", flagged, reason, detail, kind\n     from agent_memory_revision where account_id = $1 and slug = $2\n     order by replaced_at desc, id desc`"));
        assert!(mcp.contains("id: r.id, updatedAt: r.updatedAt.toISOString(), replacedAt: r.replacedAt.toISOString(), chars: r.value.length, ...(r.kind ? { kind: r.kind } : {}),"));
        assert!(mcp.contains("...(r.description ? { description: r.description } : {}), ...(r.reason ? { reason: r.reason } : {}),"));
        assert!(mcp.contains(
            "...(r.detail ? { detail: r.detail } : {}), ...(r.flagged ? { flagged: true } : {}),"
        ));
    }
}

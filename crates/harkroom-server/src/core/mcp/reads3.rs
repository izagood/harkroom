//! C4a-6a — `workitem.list` · `automation.list`. [`super::tools`] 와 같은 약속이다 — TS 와 **같은 글자**(대조:
//! `rustFrontDb.test.ts` 의 MCP 줄), zod 가 그대로 받는 인자만, DB 오류·모르는 꼴은 TS 로.
use super::reads2::{js_truthy, jsonb_as_js};
use super::respond::text_result;
use super::tools::{err, opt_uuid};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `WORK_ITEM_SOURCES`.
const WORK_ITEM_SOURCES: &[&str] = &["github", "jira", "slack", "other", "avcs"];
/// TS `MAX_ITEMS_PER_OWNER`.
const MAX_ITEMS_PER_OWNER: i64 = 500;
/// TS `WORK_ITEM_REFUSAL_MESSAGE.no_owner`.
const NO_OWNER: &str = "this agent has no human owner, so it has no board to write to";

/// TS `resolveWorkItemOwner`(에이전트 갈래) — 살아 있는 사람 주인.
const OWNER_SQL: &str = "select o.id::text from agent_config c join account o on o.id = c.owner_account_id \
      where c.account_id = $1::uuid and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null";

/// TS `listWorkItems` — 주인이 아닌 쪽(에이전트)이라 `actorSeesItemSql` 이 늘 붙는다. 자리표시자는 TS 와 달리 고정이다
/// ($1 주인 · $2 나 · $3 스레드 · $4 출처, 없으면 null) — 걸러 내는 뜻은 같다. 가시성 술어는 TS 골든 조각.
fn work_items_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let f = crate::core::channels::frag;
        format!(
            "select w.id::text, w.source, w.external_key, w.url, w.title, w.state, w.thread_root_id::text, w.updated_by::text, \
               to_char(w.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
               to_char(w.updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
               from work_item w \
               left join message m on m.id = w.thread_root_id \
               left join channel c on c.id = m.channel_id \
              where w.owner_account_id = $1::uuid \
                and (w.thread_root_id is not null and exists ( \
                  select 1 from message am join channel ac on ac.id = am.channel_id \
                   where am.id = w.thread_root_id and am.deleted_at is null and {})) \
                and ($3::uuid is null or w.thread_root_id = $3::uuid) \
                and ($4::text is null or w.source = $4::text) \
                and (w.thread_root_id is null or (m.deleted_at is null and {})) \
              order by w.updated_at desc \
              limit {MAX_ITEMS_PER_OWNER}",
            f("channel_visible_ac_p2uuid"),
            f("channel_visible_c_p1uuid"),
        )
    })
}

/// TS `AGENT_LIST_BODY_CHARS`.
const AGENT_LIST_BODY_CHARS: usize = 200;

/// TS `agentRunOwner` 의 문장(1시간 = `AGENT_RUN_CAUSE_MAX_AGE_MS / 1000`).
const RUN_OWNER_SQL: &str = "select m.author_id::text, (a.kind = 'agent'), (m.meta ? 'automation'), \
            m.created_at > now() - make_interval(secs => 3600) \
       from message m join account a on a.id = m.author_id \
      where m.id = $1::uuid and m.deleted_at is null \
        and exists (select 1 from inbox i \
                     where i.message_id = m.id and i.account_id = $2::uuid \
                       and i.reason in ('mention', 'dm', 'team_mention', 'team_delegated', 'thread_reply', 'ask_answered'))";

const AUTOMATIONS_SQL: &str = "select a.id::text, a.name, a.channel_id::text, a.enabled, a.paused_reason, a.trigger::text, a.body, \
            r.status, to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
       from automation a \
       left join lateral (select status, created_at from automation_run \
                           where automation_id = a.id order by created_at desc limit 1) r on true \
      where a.owner_id = $1::uuid and a.deleted_at is null and a.approved_at is not null \
      order by a.created_at";

/// TS mcpPlugin `automationRefusal` 중 `automation.list` 가 낼 수 있는 넷.
fn refusal(code: &str) -> Option<&'static str> {
    Some(match code {
        "no_cause" => {
            "only the automation owner can ask you to run it — this turn was not started by a human message that called you"
        }
        "cause_stale" => {
            "the request that started this turn is more than an hour old; ask the owner to ask again"
        }
        "cause_not_human" => {
            "this turn was started by an agent; the automation owner must ask you directly"
        }
        "automation_reentry" => {
            "this turn was started by an automation post; automations cannot re-run themselves through agents"
        }
        _ => return None,
    })
}

/// JS `s.length > n ? s.slice(0, n) + '…' : s`(UTF-16 단위). 자르는 자리가 서로게이트 쌍 한가운데면 `None`(→ TS).
fn js_preview(s: &str, n: usize) -> Option<String> {
    if s.encode_utf16().count() <= n {
        return Some(s.to_owned());
    }
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            if units < n {
                return None;
            }
            break;
        }
        units += w;
        out.push(c);
    }
    out.push('…');
    Some(out)
}

fn s_or_null(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::from)
}

async fn workitem_list(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    args.as_object()?;
    let thread = opt_uuid(args, "threadRootId")?;
    let source = match args.get("source") {
        None => None,
        Some(Value::String(s)) if WORK_ITEM_SOURCES.contains(&s.as_str()) => Some(s.clone()),
        Some(_) => return None,
    };
    let owner: Option<String> = sqlx::query_scalar(OWNER_SQL)
        .bind(&me.id)
        .fetch_optional(pool)
        .await
        .ok()?;
    let Some(owner) = owner else {
        return Some(err("no_owner", NO_OWNER));
    };
    // MCP 는 에이전트만 오므로 주인(사람)과 나는 늘 다르다 — 그래도 같으면 모르는 꼴이라 TS 로.
    if owner == me.id {
        return None;
    }
    type R = (
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let rows: Vec<R> = sqlx::query_as(work_items_sql())
        .bind(&owner)
        .bind(&me.id)
        .bind(thread)
        .bind(source)
        .fetch_all(pool)
        .await
        .ok()?;
    let mut out = String::from("{\"items\":[");
    for (i, (id, source, key, url, title, state, root, by, created, updated)) in
        rows.into_iter().enumerate()
    {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"id\":{},\"source\":{},\"externalKey\":{},\"url\":{},\"title\":{},\"state\":{},\"threadRootId\":{},\"updatedBy\":{},\"createdAt\":{},\"updatedAt\":{}}}",
            Value::from(id),
            Value::from(source),
            Value::from(key),
            s_or_null(url),
            Value::from(title),
            s_or_null(state),
            s_or_null(root),
            s_or_null(by),
            Value::from(created),
            Value::from(updated),
        ));
    }
    out.push_str("]}");
    Some(text_result(&out))
}

async fn automation_list(
    pool: &PgPool,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
) -> Option<String> {
    // `inputSchema: {}` — 빈 모양이라도 스키마가 있으면 SDK 는 `arguments` 가 객체여야 받는다. 없으면(null) 검증 오류라 TS 로.
    if !args.is_object() {
        return None;
    }
    let refuse = |code: &str| Some(err(code, refusal(code)?));
    let Some(cause) = cause else {
        return refuse("no_cause");
    };
    type W = (String, bool, bool, bool);
    let who: Option<W> = sqlx::query_as(RUN_OWNER_SQL)
        .bind(cause)
        .bind(&me.id)
        .fetch_optional(pool)
        .await
        .ok()?;
    let Some((owner, author_is_agent, from_automation, fresh)) = who else {
        return refuse("no_cause");
    };
    if !fresh {
        return refuse("cause_stale");
    }
    if author_is_agent {
        return refuse("cause_not_human");
    }
    if from_automation {
        return refuse("automation_reentry");
    }
    type R = (
        String,
        String,
        String,
        bool,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<R> = sqlx::query_as(AUTOMATIONS_SQL)
        .bind(&owner)
        .fetch_all(pool)
        .await
        .ok()?;
    let mut out = format!(
        "{{\"ownerId\":{},\"automations\":[",
        Value::from(owner.as_str())
    );
    for (i, (id, name, channel, enabled, paused, trigger, body, status, at)) in
        rows.into_iter().enumerate()
    {
        if i > 0 {
            out.push(',');
        }
        // `trigger` 는 jsonb — node-pg 가 읽은 값을 JSON.stringify 한 글자(키 순서는 jsonb 출력).
        let t: Value = serde_json::from_str(&trigger).ok()?;
        let trigger = if t.is_object() || t.is_array() {
            jsonb_as_js(&trigger)?
        } else {
            return None;
        };
        let last = match (status.filter(|s| js_truthy(&Value::from(s.as_str()))), at) {
            (Some(s), Some(a)) => format!(
                "{{\"status\":{},\"createdAt\":{}}}",
                Value::from(s),
                Value::from(a)
            ),
            _ => "null".to_owned(),
        };
        out.push_str(&format!(
            "{{\"id\":{},\"name\":{},\"channelId\":{},\"enabled\":{enabled},\"pausedReason\":{},\"trigger\":{trigger},\"bodyPreview\":{},\"lastRun\":{last}}}",
            Value::from(id),
            Value::from(name),
            Value::from(channel),
            s_or_null(paused),
            Value::from(js_preview(&body, AGENT_LIST_BODY_CHARS)?),
        ));
    }
    out.push_str("]}");
    Some(text_result(&out))
}

pub(super) async fn answer(
    pool: &PgPool,
    me: &Account,
    tool: &str,
    args: &Value,
    cause: Option<&str>,
) -> Option<String> {
    match tool {
        "workitem.list" => workitem_list(pool, me, args).await,
        "automation.list" => automation_list(pool, me, args, cause).await,
        _ => None,
    }
}

/// TS `CAUSE_HEADER` 를 mcpPlugin 처럼 읽는다 — 값이 하나이고 uuid 꼴(대소문자 무관)일 때만. 여러 개면 node 가 `, ` 로 이어 붙여
/// uuid 꼴이 아니게 되므로 없는 것과 같다.
pub fn cause_from(headers: &axum::http::HeaderMap) -> Option<String> {
    uuid_header(headers, "x-harkroom-cause")
}

/// 턴 id 헤더(`TURN_ID_HEADER`) — TS `rawTurnId` 와 같이 UUID 꼴 한 값만. 여러 값이면 node 가 `, ` 로 이어 붙여 꼴이 깨지므로 `None`.
pub fn turn_from(headers: &axum::http::HeaderMap) -> Option<String> {
    uuid_header(headers, "x-harkroom-turn-id")
}

fn uuid_header(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let mut it = headers.get_all(name).iter();
    let v = it.next()?.to_str().ok()?;
    if it.next().is_some() {
        return None;
    }
    let b = v.as_bytes();
    let ok = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        });
    ok.then(|| v.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_matches_js() {
        assert_eq!(js_preview("abc", 3).as_deref(), Some("abc"));
        assert_eq!(js_preview("abcd", 3).as_deref(), Some("abc…"));
        assert_eq!(js_preview("가나다라", 3).as_deref(), Some("가나다…"));
        assert_eq!(js_preview("ab😀c", 3), None);
        assert_eq!(js_preview("a😀bc", 3).as_deref(), Some("a😀…"));
    }

    #[test]
    fn cause_header_like_ts() {
        let mut h = axum::http::HeaderMap::new();
        assert_eq!(cause_from(&h), None);
        h.insert(
            "x-harkroom-cause",
            "0B7F3F92-3FA6-494A-8AB3-76D0D2A6A1C0".parse().unwrap(),
        );
        assert!(cause_from(&h).is_some());
        h.append(
            "x-harkroom-cause",
            "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0".parse().unwrap(),
        );
        assert_eq!(cause_from(&h), None);
        let mut b = axum::http::HeaderMap::new();
        b.insert(
            "x-harkroom-cause",
            "bg:0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0".parse().unwrap(),
        );
        assert_eq!(cause_from(&b), None);
    }

    /// 문장·문구를 TS 원본과 맞춘다 — TS 가 칸·조건·문구를 바꾸면 여기서 깨진다(값 비교는 대조 시험이 한다).
    #[test]
    fn statements_follow_ts_source() {
        let wi = include_str!("../../../../../packages/server/src/services/workItems.ts");
        for want in [
            "export const WORK_ITEM_SOURCES = ['github', 'jira', 'slack', 'other', 'avcs'] as const;",
            "export const MAX_ITEMS_PER_OWNER = 500;",
            "no_owner: 'this agent has no human owner, so it has no board to write to',",
            "`select o.id from agent_config c join account o on o.id = c.owner_account_id\n      where c.account_id = $1 and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null`",
            "if (actor.id !== ownerId) { params.push(actor.id); where.push(actorSeesItemSql('w', `$${params.length}`)); }",
            "where am.id = ${w}.thread_root_id and am.deleted_at is null and ${channelVisibleSql('ac', actorParam)}))`;",
            "and (w.thread_root_id is null or (m.deleted_at is null and ${channelVisibleSql('c', '$1')}))\n      order by w.updated_at desc\n      limit ${MAX_ITEMS_PER_OWNER}`,",
            "const COLUMNS = `w.id, w.source, w.external_key as \"externalKey\", w.url, w.title, w.state,\n  w.thread_root_id as \"threadRootId\", w.updated_by as \"updatedBy\",\n  w.created_at as \"createdAt\", w.updated_at as \"updatedAt\"`;",
        ] {
            assert!(wi.contains(want), "{want}");
        }
        let au = include_str!("../../../../../packages/server/src/services/automations.ts");
        for want in [
            "export const AGENT_RUN_CAUSE_MAX_AGE_MS = 60 * 60 * 1000;",
            "export const AGENT_LIST_BODY_CHARS = 200;",
            "and i.reason in ('mention', 'dm', 'team_mention', 'team_delegated', 'thread_reply', 'ask_answered'))`,",
            "where a.owner_id = $1 and a.deleted_at is null and a.approved_at is not null\n      order by a.created_at`,",
            "bodyPreview: r.body.length > AGENT_LIST_BODY_CHARS ? `${r.body.slice(0, AGENT_LIST_BODY_CHARS)}…` : r.body,",
            "lastRun: r.lastStatus && r.lastAt ? { status: r.lastStatus, createdAt: new Date(r.lastAt).toISOString() } : null,",
            "id: r.id, name: r.name, channelId: r.channelId, enabled: r.enabled, pausedReason: r.pausedReason,\n      trigger: r.trigger,",
        ] {
            assert!(au.contains(want), "{want}");
        }
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for code in [
            "no_cause",
            "cause_stale",
            "cause_not_human",
            "automation_reentry",
        ] {
            assert!(
                mcp.contains(&format!("    {code}: '{}',", refusal(code).unwrap())),
                "{code}"
            );
        }
        assert!(mcp.contains(
            "const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;"
        ));
        assert!(mcp.contains("return jsonResult({ items: await listWorkItems(pool, ownerId, account, { threadRootId, source }) });"));
    }
}

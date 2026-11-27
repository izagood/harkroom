//! C4a-6a — `workitem.list` · `automation.list`. [`super::tools`] 와 같은 약속이다 — TS 와 **같은 글자**(대조:
//! `rustFrontDb.test.ts` 의 MCP 줄), zod 가 그대로 받는 인자만, DB 오류·모르는 꼴은 TS 로.
use super::reads2::{js_truthy, jsonb_as_js};
use super::respond::text_result;
use super::tools::err;
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `AGENT_LIST_BODY_CHARS`.
const AGENT_LIST_BODY_CHARS: usize = 200;

/// TS `agentRunOwner` 의 문장(1시간 = `AGENT_RUN_CAUSE_MAX_AGE_MS / 1000`).
pub(super) const RUN_OWNER_SQL: &str = "select m.author_id::text, (a.kind = 'agent'), (m.meta ? 'automation'), \
            m.created_at > now() - make_interval(secs => 3600) \
       from message m join account a on a.id = m.author_id \
      where m.id = $1::uuid and m.deleted_at is null \
        and exists (select 1 from inbox i \
                     where i.message_id = m.id and i.account_id = $2::uuid \
                       and i.reason in ('mention', 'dm', 'team_mention', 'team_delegated', 'thread_reply', 'ask_answered'))";

/// [`RUN_OWNER_SQL`] 에서 깨움 행 판을 만들 때 바꾸는 낱말.
pub(super) const RUN_OWNER_FROM: &str = "from inbox i ";

/// 돌릴 문장 — 나머지 읽는 곳이 깨움 행을 볼 때는 inbox 줄과 깨움 행을 함께 읽는다([`crate::core::wake_source::EITHER`]).
pub(super) fn run_owner_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        crate::core::wake_source::either_if_on(RUN_OWNER_SQL, RUN_OWNER_FROM, " i ", 1)
    })
}

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
    let who: Option<W> = sqlx::query_as(run_owner_sql())
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
        "workitem.list" => super::workitem::list(args),
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
    fn run_owner_wake_statement_reads_both_tables() {
        let sql = crate::core::wake_source::either(RUN_OWNER_SQL, RUN_OWNER_FROM, " i ", 1);
        assert!(sql.contains("from wake where state <> 'canceled') i "));
        assert!(sql.contains("i.message_id = m.id and i.account_id = $2::uuid"));
        assert_eq!(run_owner_sql(), RUN_OWNER_SQL);
    }

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
}

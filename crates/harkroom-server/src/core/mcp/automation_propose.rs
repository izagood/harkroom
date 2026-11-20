//! S5.4 통합 — MCP `automation.propose`. TS `mcpPlugin.ts` 의 같은 도구와 `services/automations.ts::proposeAutomation` 을 옮긴다:
//! 인자(zod, `triggerSchema` 포함) → 승인할 사람(`forHandle` 의 사람, 없으면 이 에이전트의 소유자) → 채널이 있고 그 사람이 쓸 수
//! 있는가(`channelPostGate`) → 제안 행 INSERT(`approved_at = null`·`enabled = false`). 글·이벤트는 없다(TS 도 없다).
//!
//! - INSERT 문장은 TS 정본을 골든(`automation_propose_insert`)으로 받는다. Rust 는 **제안 행만** 넣는다 — 승인·켜기·돌리기 길은 없다
//!   (INSERT 칸에 `approved_at`·`enabled` 는 상수 `null`·`false` 로 박혀 있다).
//! - **TS 로 넘기는 것**(`None`): zod 가 받지 않을 인자 · 시간대가 허용 목록 밖(ICU `Intl` 판정과 갈라질 수 있어서) · 이름 가장자리가
//!   ASCII 밖 공백(JS `trim` 과 Rust `trim` 이 다르다) · 정수가 아닌 수 표기 · DB 오류.
//! - 답 글자는 TS `jsonResult` 와 **키 순서까지** 같게 직접 쓴다(값은 `Value` 로 이스케이프한다). `trigger` 는 DB jsonb 글자 그대로.
use super::tools::err;
use crate::auth::Account;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use crate::core::msg_post;
use crate::core::msg_read::is_uuid;
use serde_json::{Map, Value};
use sqlx::{PgPool, Row};
use std::sync::OnceLock;

/// 쓰기 풀에 이 권한이 다 있을 때만 Rust 가 답한다(`main.rs`). 운영 GRANT:
/// `grant insert (owner_id, proposed_by, approved_at, enabled, channel_id, name, body, trigger, debounce_sec) on automation` ·
/// `grant select (id, owner_id, channel_id, name, body, trigger, enabled, next_at, paused_reason, consecutive_failures,
/// ingress_enabled_at, debounce_sec, proposed_by, approved_at, created_at, updated_at) on automation`
/// (SELECT 는 `returning` 이 읽는 칸뿐 — 수신 비밀 칸 `ingress_token_hash`·`ingress_secret_enc` 는 넣지 않는다).
/// 승인자·채널 판정은 읽기 풀로 한다.
pub const AUTOMATION_PROPOSE_PRIVILEGES: &[(&str, &str)] = &[
    ("automation.owner_id", "INSERT"),
    ("automation.proposed_by", "INSERT"),
    ("automation.approved_at", "INSERT"),
    ("automation.enabled", "INSERT"),
    ("automation.channel_id", "INSERT"),
    ("automation.name", "INSERT"),
    ("automation.body", "INSERT"),
    ("automation.trigger", "INSERT"),
    ("automation.debounce_sec", "INSERT"),
    ("automation.id", "SELECT"),
    ("automation.owner_id", "SELECT"),
    ("automation.channel_id", "SELECT"),
    ("automation.name", "SELECT"),
    ("automation.body", "SELECT"),
    ("automation.trigger", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.next_at", "SELECT"),
    ("automation.paused_reason", "SELECT"),
    ("automation.consecutive_failures", "SELECT"),
    ("automation.ingress_enabled_at", "SELECT"),
    ("automation.debounce_sec", "SELECT"),
    ("automation.proposed_by", "SELECT"),
    ("automation.approved_at", "SELECT"),
    ("automation.created_at", "SELECT"),
    ("automation.updated_at", "SELECT"),
];

/// 이름·채널·본문 상한(TS zod).
const NAME_MAX: usize = 100;
const HANDLE_MAX: usize = 64;
const DEBOUNCE_MAX: i64 = 3600;

/// Rust 가 판정하는 시간대 — TS `tzSchema`(1~64자 + `Intl` 이 받음). chrono-tz 표의 이름·링크를 대소문자 무시로 받는다
/// ([`parse_tz`](crate::core::automation_time::parse_tz)). 오프셋 꼴(`+09:00`)과 ICU 옛 이름(`JST`·`SystemV/*`)도 받는다 — 여기서 거절되는 이름은 `Intl` 도 거절한다. 저장 값은 입력 글자 그대로라 TS 와 같다.
fn tz_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && crate::core::automation_time::parse_tz(s).is_some()
}

const GITHUB_EVENTS: &[&str] = &[
    "push",
    "pull_request.merged",
    "release.published",
    "workflow_run.completed",
];
const GITHUB_CHANGES: &[&str] = &["any", "added", "modified", "removed"];

/// 골든 INSERT 에 Rust 가 씌우는 `returning` 칸 — `AUTOMATION_PROPOSE_PRIVILEGES` 의 SELECT 칸과 같아야 한다(단위 시험이 못 박는다).
/// `returning *` 은 표의 모든 칸(수신 비밀 칸 포함)에 SELECT 를 요구해 칸 단위 GRANT 로는 돌지 않는다.
const RETURNING_COLS: &[&str] = &[
    "id",
    "owner_id",
    "channel_id",
    "name",
    "body",
    "trigger",
    "enabled",
    "next_at",
    "paused_reason",
    "consecutive_failures",
    "ingress_enabled_at",
    "debounce_sec",
    "proposed_by",
    "approved_at",
    "created_at",
    "updated_at",
];

pub fn insert_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = v["automation_propose_insert"]
            .as_str()
            .expect("golden fragment automation_propose_insert");
        // 시각은 ms 로 받는다(node-pg `Date` 처럼 μs 는 버린다) — 문장 자체는 정본 그대로. 칸 이름·순서는 TS `COLS`.
        format!(
            "with r as ({frag} returning {cols}) select r.id::text as id, r.owner_id::text as owner_id, \
             r.channel_id::text as channel_id, r.name, r.body, r.trigger::text as trigger, r.enabled, \
             floor(extract(epoch from r.next_at) * 1000)::bigint as next_ms, r.paused_reason, r.consecutive_failures, \
             floor(extract(epoch from r.ingress_enabled_at) * 1000)::bigint as ingress_ms, r.debounce_sec, \
             r.proposed_by::text as proposed_by, floor(extract(epoch from r.approved_at) * 1000)::bigint as approved_ms, \
             floor(extract(epoch from r.created_at) * 1000)::bigint as created_ms, \
             floor(extract(epoch from r.updated_at) * 1000)::bigint as updated_ms from r",
            cols = RETURNING_COLS.join(", ")
        )
    })
}

/// TS 와 같은 문장(`mcpPlugin.ts` automation.propose).
const OWNER_BY_HANDLE_SQL: &str = "select id::text from account where handle = $1 and kind = 'human' and deleted_at is null and disabled_at is null";
const OWNER_OF_AGENT_SQL: &str = "select o.id::text from agent_config c join account o on o.id = c.owner_account_id
         where c.account_id = $1::uuid and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null";

#[derive(Debug, PartialEq)]
pub(crate) struct Args {
    pub(crate) name: String,
    pub(crate) channel: String,
    pub(crate) body: String,
    pub(crate) trigger: Value,
    pub(crate) debounce: Option<i32>,
    for_handle: Option<String>,
}

/// REST `POST /automations` 의 zod — `forHandle` 이 없는 같은 꼴(모르는 키는 버린다). `None` 이면 TS 가 판정한다.
pub(crate) fn parse_rest(body: &Value) -> Option<Args> {
    let mut o = body.as_object()?.clone();
    o.remove("forHandle");
    parse(&Value::Object(o))
}

fn u16len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `String#trim` 과 같은 결과를 낼 수 있을 때만 깎는다. ASCII 공백만 깎고, 깎은 가장자리가 ASCII 밖 공백(JS 와 Rust 의 공백 정의가
/// 다르다)·`\u{FEFF}` 면 `None`.
fn js_trim(s: &str) -> Option<&str> {
    let t = s.trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{0B}' | '\u{0C}'));
    let edge = |c: Option<char>| {
        c.is_some_and(|c| !c.is_ascii() && (c.is_whitespace() || c == '\u{FEFF}'))
    };
    if edge(t.chars().next()) || edge(t.chars().last()) {
        return None;
    }
    Some(t)
}

fn str_len<'a>(o: &'a Map<String, Value>, k: &str, min: usize, max: usize) -> Option<&'a str> {
    let s = o.get(k)?.as_str()?;
    let n = u16len(s);
    (min..=max).contains(&n).then_some(s)
}

fn int_in(v: &Value, min: i64, max: i64) -> Option<i64> {
    super::tools::js_int(v).filter(|n| (min..=max).contains(n))
}

/// TS `HHMM` `^([01]\d|2[0-3]):[0-5]\d$`.
fn hhmm_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit())
        && (b[0] < b'2' || (b[0] == b'2' && b[1] <= b'3'))
        && b[3] <= b'5'
}

/// JS `\w` = `[A-Za-z0-9_]`. `^[\w.-]+\/[\w.-]+$`.
fn repo_ok(s: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b'-')
    };
    match s.split_once('/') {
        Some((a, b)) => part(a) && part(b),
        None => false,
    }
}

/// zod `optional()` 은 키가 없을 때만 통과한다(`null` 은 거절).
fn optional<'a>(o: &'a Map<String, Value>, k: &str) -> Option<Option<&'a Value>> {
    match o.get(k) {
        None => Some(None),
        Some(Value::Null) => None,
        Some(v) => Some(Some(v)),
    }
}

/// TS `triggerSchema` 를 지난 값(모르는 키는 버린다 — zod strip). 못 지나면 `None`.
fn parse_trigger(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut out = Map::new();
    match o.get("kind")?.as_str()? {
        "schedule" => {
            let time = o.get("time")?.as_str().filter(|s| hhmm_ok(s))?;
            let tz = o.get("tz")?.as_str().filter(|s| tz_ok(s))?;
            out.insert("kind".into(), "schedule".into());
            let freq = o.get("freq")?.as_str()?;
            out.insert("freq".into(), freq.into());
            match freq {
                "daily" => {}
                "weekly" => {
                    let arr = o.get("weekdays")?.as_array()?;
                    if arr.is_empty() || arr.len() > 7 {
                        return None;
                    }
                    let mut days = arr
                        .iter()
                        .map(|d| int_in(d, 0, 6))
                        .collect::<Option<Vec<_>>>()?;
                    days.sort_unstable();
                    days.dedup();
                    out.insert("weekdays".into(), Value::from(days));
                }
                "monthly" => {
                    out.insert("monthDay".into(), int_in(o.get("monthDay")?, 1, 31)?.into());
                }
                _ => return None,
            }
            out.insert("time".into(), time.into());
            out.insert("tz".into(), tz.into());
        }
        "github" => {
            let repo = o.get("repo")?.as_str().filter(|s| repo_ok(s))?;
            let event = o
                .get("event")?
                .as_str()
                .filter(|s| GITHUB_EVENTS.contains(s))?;
            out.insert("kind".into(), "github".into());
            out.insert("repo".into(), repo.into());
            out.insert("event".into(), event.into());
            if let Some(b) = optional(o, "branch")? {
                let b = b.as_str().filter(|s| (1..=200).contains(&u16len(s)))?;
                out.insert("branch".into(), b.into());
            }
            if let Some(p) = optional(o, "paths")? {
                let arr = p.as_array().filter(|a| a.len() <= 20)?;
                let paths = arr
                    .iter()
                    .map(|x| {
                        x.as_str()
                            .filter(|s| (1..=300).contains(&u16len(s)))
                            .map(Value::from)
                    })
                    .collect::<Option<Vec<_>>>()?;
                out.insert("paths".into(), Value::Array(paths));
            }
            if let Some(c) = optional(o, "change")? {
                let c = c.as_str().filter(|s| GITHUB_CHANGES.contains(s))?;
                out.insert("change".into(), c.into());
            }
        }
        "webhook" => {
            out.insert("kind".into(), "webhook".into());
        }
        _ => return None,
    }
    Some(Value::Object(out))
}

/// REST `PATCH /automations/:id` 의 zod(`.strict()` — 모르는 키는 거절). 값이 없는 칸은 `None`, `debounceSec` 은
/// `Some(None)` 이 null(끄기). Rust 가 확신하지 못하면 `None` — TS 가 판정한다.
#[derive(Debug, PartialEq, Default)]
pub(crate) struct PatchArgs {
    pub(crate) name: Option<String>,
    pub(crate) channel: Option<String>,
    pub(crate) body: Option<String>,
    pub(crate) trigger: Option<Value>,
    pub(crate) enabled: Option<bool>,
    pub(crate) debounce: Option<Option<i32>>,
}

pub(crate) fn parse_patch(v: &Value) -> Option<PatchArgs> {
    let o = v.as_object()?;
    const KEYS: [&str; 6] = [
        "name",
        "channelId",
        "body",
        "trigger",
        "enabled",
        "debounceSec",
    ];
    if o.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return None;
    }
    let mut p = PatchArgs::default();
    if let Some(n) = optional(o, "name")? {
        let n = js_trim(n.as_str()?)?;
        if !(1..=NAME_MAX).contains(&u16len(n)) {
            return None;
        }
        p.name = Some(n.to_owned());
    }
    if let Some(c) = optional(o, "channelId")? {
        p.channel = Some(c.as_str().filter(|s| is_uuid(s))?.to_owned());
    }
    if optional(o, "body")?.is_some() {
        p.body = Some(str_len(o, "body", 1, MAX_MESSAGE_BODY_CHARS)?.to_owned());
    }
    if let Some(t) = optional(o, "trigger")? {
        p.trigger = Some(parse_trigger(t)?);
    }
    if let Some(e) = optional(o, "enabled")? {
        p.enabled = Some(e.as_bool()?);
    }
    p.debounce = match o.get("debounceSec") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(int_in(v, 0, DEBOUNCE_MAX)? as i32)),
    };
    Some(p)
}

/// JS `JSON.stringify` 꼴(빈칸 없음)로 쓴다. 객체 키는 `order` 가 정한 순서.
pub(crate) fn stringify_ordered(
    v: &Value,
    order: &dyn Fn(&str, &str) -> std::cmp::Ordering,
) -> String {
    match v {
        Value::Object(m) => {
            let mut ks: Vec<&String> = m.keys().collect();
            ks.sort_by(|a, b| order(a, b));
            let parts: Vec<String> = ks
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        Value::from(k.as_str()),
                        stringify_ordered(&m[k.as_str()], order)
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter()
                .map(|x| stringify_ordered(x, order))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// zod 가 내놓는 트리거 키 순서(스키마 순서).
pub(crate) fn zod_trigger_order(a: &str, b: &str) -> std::cmp::Ordering {
    const ORDER: [&str; 11] = [
        "kind", "freq", "weekdays", "monthDay", "time", "tz", "repo", "event", "branch", "paths",
        "change",
    ];
    let pos = |k: &str| ORDER.iter().position(|x| *x == k).unwrap_or(usize::MAX);
    pos(a).cmp(&pos(b)).then_with(|| a.cmp(b))
}

/// pg jsonb 의 키 순서(짧은 키 먼저, 같으면 바이트 순).
pub(crate) fn jsonb_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.len()
        .cmp(&b.len())
        .then_with(|| a.as_bytes().cmp(b.as_bytes()))
}

/// zod: `name` trim 1..100 · `channelId` uuid · `body` 1..MAX · `trigger` · `debounceSec` 0..3600 · `forHandle` 1..64(UTF-16).
fn parse(args: &Value) -> Option<Args> {
    let o = args.as_object()?;
    let raw_name = o.get("name")?.as_str()?;
    let name = js_trim(raw_name)?;
    if !(1..=NAME_MAX).contains(&u16len(name)) {
        return None;
    }
    let channel = o.get("channelId")?.as_str().filter(|s| is_uuid(s))?;
    let body = str_len(o, "body", 1, MAX_MESSAGE_BODY_CHARS)?;
    let trigger = parse_trigger(o.get("trigger")?)?;
    let debounce = match optional(o, "debounceSec")? {
        Some(v) => Some(int_in(v, 0, DEBOUNCE_MAX)? as i32),
        None => None,
    };
    let for_handle = match optional(o, "forHandle")? {
        Some(v) => {
            let s = v
                .as_str()
                .filter(|s| (1..=HANDLE_MAX).contains(&u16len(s)))?;
            Some(s.strip_prefix('@').unwrap_or(s).to_owned())
        }
        None => None,
    };
    Some(Args {
        name: name.to_owned(),
        channel: channel.to_owned(),
        body: body.to_owned(),
        trigger,
        debounce,
        for_handle,
    })
}

fn opt_iso(ms: Option<i64>) -> Value {
    ms.map_or(Value::Null, |m| Value::from(msg_post::iso_ms(m)))
}

pub async fn answer(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    let owner: Option<String> = match &a.for_handle {
        Some(h) => sqlx::query_scalar(OWNER_BY_HANDLE_SQL)
            .bind(h)
            .fetch_optional(read)
            .await
            .ok()?,
        None => sqlx::query_scalar(OWNER_OF_AGENT_SQL)
            .bind(&me.id)
            .fetch_optional(read)
            .await
            .ok()?,
    };
    let Some(owner) = owner else {
        let msg = match &a.for_handle {
            // TS 는 `forHandle` 을 깎기 **전** 글자로 적는다.
            Some(_) => format!(
                "no active human @{}",
                args.get("forHandle")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ),
            None => "this agent has no owner; pass forHandle".to_owned(),
        };
        return Some(err("no_owner", &msg));
    };
    let exists: Option<i32> = sqlx::query_scalar("select 1 from channel where id = $1::uuid")
        .bind(&a.channel)
        .fetch_optional(read)
        .await
        .ok()?;
    let gate: Option<(bool, bool)> = if exists.is_some() {
        sqlx::query_as(msg_post::gate_sql())
            .bind(&a.channel)
            .bind(&owner)
            .fetch_optional(read)
            .await
            .ok()?
    } else {
        None
    };
    // TS `channelPostGate`: 행 없음 = 'ok', 안 보임 = forbidden, 보관 = archived(→ 여기서는 forbidden).
    let ok = exists.is_some() && gate.is_none_or(|(visible, archived)| visible && !archived);
    if !ok {
        return Some(err("forbidden", "the approver cannot post in this channel"));
    }
    let row = sqlx::query(insert_sql())
        .bind(&owner)
        .bind(&me.id)
        .bind(&a.channel)
        .bind(&a.name)
        .bind(&a.body)
        .bind(a.trigger.to_string())
        .bind(a.debounce)
        .fetch_one(write)
        .await
        .ok()?;
    // 여기부터는 행이 이미 들어갔다 — 읽기에 실패해도 TS 로 넘기지 않는다(넘기면 TS 가 한 번 더 INSERT 해 대기 제안이 둘 된다).
    let Some(view) = view_of(&row) else {
        return Some(err(
            "internal",
            "the automation was saved but could not be read back; it was not retried",
        ));
    };
    let text = format!(
        "{{\"automation\":{view},\"next\":{}}}",
        Value::from("Tell the approver in chat: Settings › Automations › Approve.")
    );
    Some(super::respond::text_result(&text))
}

/// INSERT 가 돌려준 행 → TS `automationView` 글자(`lastRun` 은 새 행이라 null).
fn view_of(row: &sqlx::postgres::PgRow) -> Option<String> {
    let s = |k: &str| row.try_get::<String, _>(k).ok().map(Value::from);
    let os = |k: &str| {
        row.try_get::<Option<String>, _>(k)
            .ok()
            .map(|v| v.map_or(Value::Null, Value::from))
    };
    let oi = |k: &str| row.try_get::<Option<i64>, _>(k).ok();
    let trigger_text: String = row.try_get("trigger").ok()?;
    let debounce: Option<i32> = row.try_get("debounce_sec").ok()?;
    let failures: i32 = row.try_get("consecutive_failures").ok()?;
    let enabled: bool = row.try_get("enabled").ok()?;
    Some(format!(
        "{{\"id\":{},\"ownerId\":{},\"channelId\":{},\"name\":{},\"body\":{},\"trigger\":{},\"enabled\":{},\"nextAt\":{},\
         \"pausedReason\":{},\"consecutiveFailures\":{},\"ingressEnabledAt\":{},\"debounceSec\":{},\"proposedBy\":{},\
         \"approvedAt\":{},\"createdAt\":{},\"updatedAt\":{},\"lastRun\":null}}",
        s("id")?,
        s("owner_id")?,
        s("channel_id")?,
        s("name")?,
        s("body")?,
        compact(&trigger_text)?,
        enabled,
        opt_iso(oi("next_ms")?),
        os("paused_reason")?,
        failures,
        opt_iso(oi("ingress_ms")?),
        debounce.map_or(Value::Null, Value::from),
        os("proposed_by")?,
        opt_iso(oi("approved_ms")?),
        opt_iso(oi("created_ms")?),
        opt_iso(oi("updated_ms")?),
    ))
}

/// jsonb 글자(`{"a": 1}`)를 JS `JSON.stringify` 꼴(`{"a":1}`)로 — **키 순서는 jsonb 가 준 그대로**(node-pg 가 파싱한 객체의 순서와 같다).
fn compact(jsonb_text: &str) -> Option<String> {
    // serde_json 의 preserve_order 가 없어도 순서를 지키려고 토큰 단위로 공백만 걷는다(문자열 안은 건드리지 않는다).
    let mut out = String::with_capacity(jsonb_text.len());
    let mut in_str = false;
    let mut esc = false;
    for c in jsonb_text.chars() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    // 값 검증 — 깨진 글자면 TS 로.
    serde_json::from_str::<Value>(&out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({ "name": "  주간 정리 ", "channelId": "00000000-0000-4000-8000-000000000001", "body": "정리해",
                "trigger": { "kind": "schedule", "freq": "weekly", "weekdays": [3, 1, 1], "time": "09:00", "tz": "Asia/Seoul", "x": 1 } })
    }

    #[test]
    fn parses_and_normalizes_like_zod() {
        let a = parse(&base()).unwrap();
        assert_eq!(a.name, "주간 정리");
        assert_eq!(
            a.trigger,
            json!({ "kind": "schedule", "freq": "weekly", "weekdays": [1, 3], "time": "09:00", "tz": "Asia/Seoul" })
        );
        assert_eq!(a.debounce, None);
        assert_eq!(a.for_handle, None);
    }

    #[test]
    fn falls_back_to_ts_when_unsure() {
        let mut v = base();
        v["trigger"]["tz"] = json!("asia/seoul");
        assert!(
            parse(&v).is_some(),
            "대소문자 다른 시간대도 Intl 처럼 받는다"
        );
        v["trigger"]["tz"] = json!("US/Eastern");
        assert!(parse(&v).is_some(), "링크 이름도 받는다");
        v["trigger"]["tz"] = json!("+09:00");
        assert!(parse(&v).is_some(), "오프셋 꼴도 Intl 처럼 받는다");
        v["trigger"]["tz"] = json!("JST");
        assert!(parse(&v).is_some(), "ICU 옛 약칭도 Intl 처럼 받는다");
        v["trigger"]["tz"] = json!("UTC+9");
        assert!(parse(&v).is_none(), "Intl 이 거절하는 꼴은 TS 가 판정");
        let mut v = base();
        v["name"] = json!("\u{FEFF}이름");
        assert!(parse(&v).is_none());
        let mut v = base();
        v["debounceSec"] = json!(1.5);
        assert!(parse(&v).is_none());
        let mut v = base();
        v["debounceSec"] = Value::Null;
        assert!(parse(&v).is_none());
        let mut v = base();
        v["trigger"]["time"] = json!("24:00");
        assert!(parse(&v).is_none());
    }

    #[test]
    fn github_and_webhook() {
        let mut v = base();
        v["trigger"] = json!({ "kind": "github", "repo": "o/r.x", "event": "push", "paths": ["a"], "change": "added" });
        v["forHandle"] = json!("@boss");
        let a = parse(&v).unwrap();
        assert_eq!(
            a.trigger,
            json!({ "kind": "github", "repo": "o/r.x", "event": "push", "paths": ["a"], "change": "added" })
        );
        assert_eq!(a.for_handle.as_deref(), Some("boss"));
        v["trigger"] = json!({ "kind": "github", "repo": "o/r/x", "event": "push" });
        assert!(parse(&v).is_none());
        v["trigger"] = json!({ "kind": "webhook", "freq": "daily" });
        assert_eq!(parse(&v).unwrap().trigger, json!({ "kind": "webhook" }));
    }

    #[test]
    fn returning_cols_match_select_grant() {
        let granted: Vec<&str> = AUTOMATION_PROPOSE_PRIVILEGES
            .iter()
            .filter(|(_, p)| *p == "SELECT")
            .map(|(c, _)| c.strip_prefix("automation.").unwrap())
            .collect();
        assert_eq!(
            granted, RETURNING_COLS,
            "returning 칸 = SELECT GRANT 칸(순서까지)"
        );
        let sql = insert_sql();
        assert!(
            !sql.contains("returning *"),
            "returning * 는 비밀 칸까지 SELECT 를 요구한다"
        );
        assert!(sql.contains(&format!("returning {})", RETURNING_COLS.join(", "))));
        for secret in [
            "ingress_token_hash",
            "ingress_secret_enc",
            "mandate_session_at",
            "deleted_at",
        ] {
            assert!(!sql.contains(secret), "{secret} 를 읽지 않는다");
        }
    }

    #[test]
    fn hhmm_and_compact() {
        assert!(hhmm_ok("00:00") && hhmm_ok("23:59") && hhmm_ok("19:30"));
        assert!(!hhmm_ok("24:00") && !hhmm_ok("9:00") && !hhmm_ok("12:60"));
        assert_eq!(
            compact(r#"{"tz": "Asia/Seoul", "kind": "a b\" c"}"#).unwrap(),
            r#"{"tz":"Asia/Seoul","kind":"a b\" c"}"#
        );
    }
}

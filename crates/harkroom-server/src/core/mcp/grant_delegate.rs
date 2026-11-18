//! S5.4 통합 — MCP `grant.delegate`(외부 API 권한 위임 P5). TS `mcpPlugin.ts` 의 같은 도구와
//! `services/apiDelegation.ts::delegateApiGrant` 의 **거절 전부와 같은 위임 다시 오기**를 옮긴다(WIP):
//! 인자(zod) → `not_agent` → `no_connector` → `not_granted` → 사슬(`apiGrantFor`, `parent_invalid`) →
//! `no_delegate_depth`·`depth_too_deep` → `bad_limits`·`wider_than_parent` → `bad_expiry` → `no_target`·`self`·
//! `not_root_owner_agent` → `already_granted` → 같은 위임이면 그 줄로 답 → `rate_limited`.
//! 거절은 TS 처럼 `audit_log` 에 `grant.delegate.denied` 한 줄을 남기고 `{error:{code,message}}` 로 답한다.
//!
//! 모든 판정을 지난 새 위임은 **원인이 확인되지 않을 때만**(원인 없음·이 에이전트를 1시간 안에 깨운 글이 아님) Rust 가 쓴다 —
//! 그때 TS 는 늘 대기(`pending_approval`)이고 시스템 줄을 쓰지 않는다. 줄 upsert·`grant.delegate.pending` 감사·`grant.changed`
//! 이벤트를 **한 트랜잭션**에 쓴다.
//!
//! - **TS 로 넘기는 것**(`None`): zod 가 받지 않을 인자 · `%`·ASCII 밖 글자·URL 짓기가 바꿀 글자가 든 경로 ·
//!   낯선 limits 모양 · 원인이 확인된 새 위임(즉시 유효 판정·시스템 줄 — `postMessage` 의 부름·알림) · uuid 가 아닌 원인 ·
//!   DB 오류 · 감사 줄 INSERT 실패. 넘기기 전에 Rust 가 쓴 것은 없다(감사 줄은 거절 답과 함께, 새 위임은 롤백 뒤 넘긴다).
//! - 쓰기 칸은 [`GRANT_DELEGATE_PRIVILEGES`] 뿐이다.
use super::tools::err;
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// 쓰기 풀에 이 권한이 다 있을 때만 Rust 가 답한다(`main.rs`). 연결·준 쪽 줄 판정은 읽기 풀로 한다.
pub const GRANT_DELEGATE_PRIVILEGES: &[(&str, &str)] = &[
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.detail", "INSERT"),
    // 새 위임(TS `insert … on conflict (account_id, capability, scope) do update … returning id`).
    ("account_grant.id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.account_id", "INSERT"),
    ("account_grant.capability", "INSERT"),
    ("account_grant.scope", "INSERT"),
    ("account_grant.granted_by", "INSERT"),
    ("account_grant.expires_at", "INSERT"),
    ("account_grant.limits", "INSERT"),
    ("account_grant.delegate_depth", "INSERT"),
    ("account_grant.write_needs_human_cause", "INSERT"),
    ("account_grant.parent_grant_id", "INSERT"),
    ("account_grant.suspended_at", "INSERT"),
    ("account_grant.suspend_reason", "INSERT"),
    ("account_grant.granted_by", "UPDATE"),
    ("account_grant.granted_at", "UPDATE"),
    ("account_grant.expires_at", "UPDATE"),
    ("account_grant.limits", "UPDATE"),
    ("account_grant.delegate_depth", "UPDATE"),
    ("account_grant.write_needs_human_cause", "UPDATE"),
    ("account_grant.parent_grant_id", "UPDATE"),
    ("account_grant.suspended_at", "UPDATE"),
    ("account_grant.suspend_reason", "UPDATE"),
    // `grant.changed`(outbox).
    ("event_outbox", "INSERT"),
];
pub const GRANT_DELEGATE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

const CONNECTOR_SQL: &str = "select id::text, owner_account_id::text, base_url, auth_kind, \
     (secret_id is not null), methods from api_connector where name = $1";
/// TS `parent` — `apiGrantFor` 의 `leaf` 와 같은 줄이다. 만료 비교(`exp > parent.expiresAt`)는 SQL 로 한다.
const PARENT_SQL: &str = "select id::text, limits::text, delegate_depth, write_needs_human_cause, \
     (expires_at is not null and now() + make_interval(days => $3) > expires_at) \
     from account_grant where account_id = $1::uuid and capability = 'api.call' and scope = $2";
/// `apiGrantFor` 의 사슬 쿼리 그대로(칸만 문자열·참거짓으로).
const CHAIN_SQL: &str = "with recursive up as ( \
       select g.id, g.parent_grant_id, g.account_id, g.capability, g.scope, g.granted_by, g.expires_at, g.suspended_at, \
              g.limits, g.delegate_depth, g.write_needs_human_cause, 0 as depth \
         from account_grant g where g.id = $1::uuid \
       union all \
       select p.id, p.parent_grant_id, p.account_id, p.capability, p.scope, p.granted_by, p.expires_at, p.suspended_at, \
              p.limits, p.delegate_depth, p.write_needs_human_cause, up.depth + 1 \
         from account_grant p join up on p.id = up.parent_grant_id \
        where up.depth < 5 \
     ) \
     select up.parent_grant_id::text, up.account_id::text, up.capability, up.scope, \
            up.granted_by::text, a.kind, \
            (up.expires_at is not null and up.expires_at <= now()), \
            (up.suspended_at is not null), \
            up.limits::text, up.delegate_depth, up.write_needs_human_cause \
       from up left join account a on a.id = up.granted_by \
      order by up.depth";
const OWNERS_SQL: &str =
    "select owner_account_id::text from agent_config where account_id = any($1::uuid[])";
const TARGET_SQL: &str = "select a.id::text, c.owner_account_id::text from account a \
     join agent_config c on c.account_id = a.id \
     where (a.id::text = $1 or a.handle = $1) and a.kind = 'agent' and a.deleted_at is null";
/// 받는 쪽의 같은 범위 줄 — 같은 위임 판정(만료가 하루 안쪽)도 SQL 로 한다.
const EXISTING_SQL: &str = "select id::text, parent_grant_id::text, limits::text, delegate_depth, \
     write_needs_human_cause, suspend_reason, \
     (expires_at is not null and abs(extract(epoch from (expires_at - (now() + make_interval(days => $3))))) < 86400) \
     from account_grant where account_id = $1::uuid and capability = 'api.call' and scope = $2";
const RECENT_SQL: &str = "select count(*)::int from audit_log where action in ('grant.delegated', 'grant.delegate.pending') \
     and actor_id = $1::uuid and target = $2 and at > now() - interval '1 day'";
const AUDIT_SQL: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('grant.delegate.denied', $1::uuid, $2, $3::jsonb)";
/// TS 원인 확인(security F1) — 그 글이 이 에이전트를 1시간 안에 깨웠어야 원인이다. 줄이 있으면 TS 몫(즉시 유효 판정·시스템 줄).
const CAUSE_SQL: &str = "select 1 from message m where m.id = $1::uuid and m.deleted_at is null \
     and exists (select 1 from inbox i where i.account_id = $2::uuid and i.message_id = m.id \
                 and i.created_at > now() - interval '60 minutes')";
/// TS 위임 줄 upsert(대기 — `suspended_at`·`pending_approval`).
const UPSERT_SQL: &str = "insert into account_grant (account_id, capability, scope, granted_by, expires_at, limits, delegate_depth, \
       write_needs_human_cause, parent_grant_id, suspended_at, suspend_reason) \
     values ($1::uuid, 'api.call', $2, $3::uuid, $4::timestamptz, $5::jsonb, $6, $7, $8::uuid, $9::timestamptz, 'pending_approval') \
     on conflict (account_id, capability, scope) do update \
       set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, limits = excluded.limits, \
           delegate_depth = excluded.delegate_depth, write_needs_human_cause = excluded.write_needs_human_cause, \
           parent_grant_id = excluded.parent_grant_id, suspended_at = excluded.suspended_at, suspend_reason = excluded.suspend_reason \
     returning id::text";
const PENDING_AUDIT_SQL: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('grant.delegate.pending', $1::uuid, $2, $3::jsonb)";

const METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const DAILY_PER_PAIR: i32 = 5;

/// zod 가 받는 인자 — 받지 않을 인자는 TS 가 답한다.
#[derive(Debug, PartialEq)]
struct Args {
    to: String,
    connector: String,
    methods: Vec<String>,
    path_prefix: String,
    days: i32,
    delegate_depth: i32,
    write_needs_human_cause: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct Limits {
    methods: Vec<String>,
    path_prefix: String,
}

/// DB 의 limits(jsonb 글). 모양이 다르면 TS 에 맡긴다(`None`).
fn limits_of(text: Option<&str>) -> Option<Option<Limits>> {
    let Some(text) = text else {
        return Some(None);
    };
    let v: Value = serde_json::from_str(text).ok()?;
    if v.is_null() {
        return Some(None);
    }
    let methods = v
        .get("methods")?
        .as_array()?
        .iter()
        .map(|m| m.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    let path_prefix = v.get("pathPrefix")?.as_str()?.to_owned();
    Some(Some(Limits {
        methods,
        path_prefix,
    }))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/^[a-z0-9][a-z0-9_-]{0,63}$/`
fn connector_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// TS `safePath` 중 `%` 가 없는 ASCII 경로만 — 그 밖(`%`·ASCII 밖 글자)은 `None` 으로 TS 에 맡긴다.
fn safe_path_plain(path: &str) -> Option<bool> {
    if !path.is_ascii() || path.contains('%') {
        return None;
    }
    if !path.starts_with('/') || path.starts_with("//") {
        return Some(false);
    }
    // JS `\s` 의 ASCII 몫: \t \n \v \f \r 와 빈칸.
    if path
        .bytes()
        .any(|c| matches!(c, b'\\' | b'#' | b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'))
    {
        return Some(false);
    }
    let p = path.split('?').next().unwrap_or("");
    if p.contains(';') || p.split('/').any(|s| s == "." || s == "..") {
        return Some(false);
    }
    Some(true)
}

/// TS `pathCovered` 중 `%` 없는 경로(호출하는 쪽이 보장한다).
fn path_covered_plain(path: &str, prefix: &str) -> bool {
    let p = path.split('?').next().unwrap_or("");
    if prefix.ends_with('/') {
        return p.starts_with(prefix);
    }
    p == prefix || p.starts_with(&format!("{prefix}/"))
}

/// `new URL(path, base)` 가 경로를 그대로 두는 글자들인가(WHATWG path percent-encode set·`?`·`#` 없음, 인쇄 가능한 ASCII).
fn wire_is_identity(path: &str) -> bool {
    path.bytes().all(|c| {
        (0x21..0x7f).contains(&c)
            && !matches!(c, b'"' | b'<' | b'>' | b'`' | b'{' | b'}' | b'?' | b'#')
    })
}

fn parse(args: &Value) -> Option<Args> {
    let o = args.as_object()?;
    let to = o.get("to")?.as_str()?;
    if !(1..=64).contains(&utf16_len(to)) {
        return None;
    }
    let connector = o.get("connector")?.as_str()?;
    if !connector_ok(connector) {
        return None;
    }
    let methods = o.get("methods")?.as_array()?;
    if !(1..=5).contains(&methods.len())
        || !methods
            .iter()
            .all(|m| m.as_str().is_some_and(|m| METHODS.contains(&m)))
    {
        return None;
    }
    let path = o.get("pathPrefix")?.as_str()?;
    if !(1..=300).contains(&utf16_len(path)) {
        return None;
    }
    // 정수 칸 — `2.0` 같은 소수 꼴은 TS 에 맡긴다.
    let days = o.get("days")?.as_i64()?;
    if !(1..=30).contains(&days) {
        return None;
    }
    let delegate_depth = match o.get("delegateDepth") {
        None => 0,
        Some(v) => {
            let d = v.as_i64()?;
            if !(0..=1).contains(&d) {
                return None;
            }
            d
        }
    };
    let write_needs_human_cause = match o.get("writeNeedsHumanCause") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    let mut ms: Vec<String> = Vec::new();
    for m in methods.iter().filter_map(Value::as_str) {
        if !ms.iter().any(|x| x == m) {
            ms.push(m.to_owned());
        }
    }
    Some(Args {
        to: to.to_owned(),
        connector: connector.to_owned(),
        methods: ms,
        path_prefix: path.to_owned(),
        days: days as i32,
        delegate_depth: delegate_depth as i32,
        write_needs_human_cause,
    })
}

type ConnRow = (String, Option<String>, String, String, bool, Vec<String>);
type ChainRow = (
    Option<String>,
    String,
    String,
    String,
    String,
    Option<String>,
    bool,
    bool,
    Option<String>,
    i32,
    bool,
);

/// `apiGrantFor` 를 준 쪽 자신의 범위 끝(`methods[0]`, `pathPrefix`)으로 한 번 돌린 결과.
/// `Some(Ok(root))` 통과 · `Some(Err(code))` 거절 · `None` 은 TS 몫(모양이 낯설거나 DB 오류).
async fn live_chain(
    read: &PgPool,
    conn: &ConnRow,
    scope: &str,
    leaf_id: &str,
    leaf: &Limits,
) -> Option<Result<String, &'static str>> {
    let method = leaf.methods.first()?;
    let path = leaf.path_prefix.as_str();
    if !safe_path_plain(path)? {
        return Some(Err("bad_path"));
    }
    // 실제로 보낼 경로가 입력과 같은 글자일 때만 옮긴다(그 밖은 URL 짓기를 TS 가 한다).
    if !wire_is_identity(path) {
        return None;
    }
    let chain: Vec<ChainRow> = sqlx::query_as(CHAIN_SQL)
        .bind(leaf_id)
        .fetch_all(read)
        .await
        .ok()?;
    let root = chain.last();
    let Some(root) = root.filter(|r| r.0.is_none() && chain.len() <= 3) else {
        return Some(Err("chain_broken"));
    };
    if chain.iter().any(|g| g.2 != "api.call" || g.3 != scope) {
        return Some(Err("chain_broken"));
    }
    if root.5.as_deref() != Some("human") || Some(&root.4) != conn.1.as_ref() {
        return Some(Err("chain_broken"));
    }
    for w in chain.windows(2) {
        let (child, parent) = (&w[0], &w[1]);
        if child.4 != parent.1 {
            return Some(Err("chain_broken"));
        }
        let (Some(cl), Some(pl)) = (
            limits_of(child.8.as_deref())?,
            limits_of(parent.8.as_deref())?,
        ) else {
            return Some(Err("chain_broken"));
        };
        if !cl.methods.iter().all(|m| pl.methods.contains(m)) {
            return Some(Err("chain_broken"));
        }
        if cl.path_prefix.contains('%') {
            return None;
        }
        if !path_covered_plain(&cl.path_prefix, &pl.path_prefix) {
            return Some(Err("chain_broken"));
        }
        if parent.9 < 1 || child.9 > parent.9 - 1 {
            return Some(Err("chain_broken"));
        }
        if parent.10 && !child.10 {
            return Some(Err("chain_broken"));
        }
    }
    let ids: Vec<String> = chain.iter().map(|g| g.1.clone()).collect();
    let owners: Vec<Option<String>> = sqlx::query_scalar(OWNERS_SQL)
        .bind(&ids)
        .fetch_all(read)
        .await
        .ok()?;
    if owners.len() != chain.len() || owners.iter().any(|o| o.as_ref() != Some(&root.4)) {
        return Some(Err("chain_broken"));
    }
    if chain.iter().any(|g| g.6) {
        return Some(Err("expired"));
    }
    if chain.iter().any(|g| g.7) {
        return Some(Err("suspended"));
    }
    if !conn.5.contains(method) {
        return Some(Err("method_not_allowed"));
    }
    if conn.3 != "none" && !conn.4 {
        return Some(Err("no_secret"));
    }
    Some(Ok(root.4.clone()))
}

pub async fn answer(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
) -> Option<String> {
    let a = parse(args)?;
    if me.kind != "agent" {
        return Some(err("not_agent", "only agents delegate"));
    }
    let conn: Option<ConnRow> = sqlx::query_as(CONNECTOR_SQL)
        .bind(&a.connector)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some(conn) = conn else {
        return deny(write, me, &a, "no_connector", None).await;
    };
    let scope = format!("connector:{}", conn.0);
    let parent: Option<(String, Option<String>, i32, bool, bool)> = sqlx::query_as(PARENT_SQL)
        .bind(&me.id)
        .bind(&scope)
        .bind(a.days)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some((parent_id, parent_limits, parent_depth, parent_w, outlives)) = parent else {
        return deny(write, me, &a, "not_granted", None).await;
    };
    let Some(pl) = limits_of(parent_limits.as_deref())? else {
        return deny(write, me, &a, "not_granted", None).await;
    };
    let root = match live_chain(read, &conn, &scope, &parent_id, &pl).await? {
        Ok(root) => root,
        Err(code) => return deny(write, me, &a, "parent_invalid", Some(code)).await,
    };
    if parent_depth < 1 {
        return deny(write, me, &a, "no_delegate_depth", None).await;
    }
    if a.delegate_depth > parent_depth - 1 {
        return deny(write, me, &a, "depth_too_deep", None).await;
    }
    // `parseLimits` — 메서드는 zod 가 이미 거른 뒤라 연결 허용 여부와 경로 모양만 남는다.
    if !a.methods.iter().all(|m| conn.5.contains(m)) {
        return deny(
            write,
            me,
            &a,
            "bad_limits",
            Some("연결이 허용하지 않은 메서드다"),
        )
        .await;
    }
    let path_ok = if a.path_prefix.contains('%') || a.path_prefix.contains('?') {
        false
    } else {
        safe_path_plain(&a.path_prefix)?
    };
    if !path_ok {
        return deny(
            write,
            me,
            &a,
            "bad_limits",
            Some("limits.pathPrefix 는 / 로 시작하는 안전한 경로다"),
        )
        .await;
    }
    if pl.path_prefix.contains('%') {
        return None;
    }
    if !a.methods.iter().all(|m| pl.methods.contains(m))
        || !path_covered_plain(&a.path_prefix, &pl.path_prefix)
    {
        return deny(write, me, &a, "wider_than_parent", None).await;
    }
    // 첫째 만료 판정(지금 뒤·30일 안)은 `days` 1..=30 이라 늘 지난다.
    if outlives {
        return deny(
            write,
            me,
            &a,
            "bad_expiry",
            Some("expiresAt must not outlive the grant it comes from"),
        )
        .await;
    }
    let handle = a.to.strip_prefix('@').unwrap_or(&a.to);
    let target: Option<(String, Option<String>)> = sqlx::query_as(TARGET_SQL)
        .bind(handle)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some((target_id, target_owner)) = target else {
        return deny(write, me, &a, "no_target", None).await;
    };
    if target_id == me.id {
        return deny(write, me, &a, "self", None).await;
    }
    if target_owner.as_deref() != Some(root.as_str()) {
        return deny(write, me, &a, "not_root_owner_agent", None).await;
    }
    type Existing = (
        String,
        Option<String>,
        Option<String>,
        i32,
        bool,
        Option<String>,
        bool,
    );
    let existing: Option<Existing> = sqlx::query_as(EXISTING_SQL)
        .bind(&target_id)
        .bind(&scope)
        .bind(a.days)
        .fetch_optional(read)
        .await
        .ok()?;
    if existing
        .as_ref()
        .is_some_and(|e| e.1.as_deref() != Some(parent_id.as_str()))
    {
        return deny(write, me, &a, "already_granted", None).await;
    }
    // 같은 위임이 다시 오면 아무것도 쓰지 않고 그 줄을 답한다(L1). 원인(`cause`)은 이 길에서 쓰지 않는다.
    if let Some((id, _, Some(el), depth, w, reason, near)) = &existing {
        let wanted = parent_w || a.write_needs_human_cause;
        if let Some(el) = limits_of(Some(el))? {
            let mut x = el.methods.clone();
            x.sort();
            let mut y = a.methods.clone();
            y.sort();
            if *near
                && x == y
                && el.path_prefix == a.path_prefix
                && *depth == a.delegate_depth
                && *w == wanted
            {
                let pending = reason.as_deref() == Some("pending_approval");
                let note = if pending {
                    "waiting for the root person to approve"
                } else {
                    "given — from the next turn"
                };
                return Some(super::respond::text_result(&format!(
                    "{{\"grantId\":{},\"pending\":{},\"note\":{}}}",
                    Value::from(id.as_str()),
                    pending,
                    Value::from(note)
                )));
            }
        }
    }
    let recent: i32 = sqlx::query_scalar(RECENT_SQL)
        .bind(&me.id)
        .bind(&target_id)
        .fetch_one(read)
        .await
        .ok()?;
    if recent >= DAILY_PER_PAIR {
        return deny(write, me, &a, "rate_limited", None).await;
    }
    // 원인 확인(security F1). 확인된 원인이면 즉시 유효 판정과 시스템 줄(루트 사람 부름)이 TS 몫이다 — 여기까지 Rust 는 쓰지 않았다.
    if let Some(c) = cause {
        if !crate::core::msg_read::is_uuid(c) {
            return None;
        }
        let hit: Option<i32> = sqlx::query_scalar(CAUSE_SQL)
            .bind(c)
            .bind(&me.id)
            .fetch_optional(read)
            .await
            .ok()?;
        if hit.is_some() {
            return None;
        }
    }
    // 원인이 확인되지 않았다 — TS 도 늘 대기(`pending`)이고 시스템 줄을 쓰지 않는다.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    let w = parent_w || a.write_needs_human_cause;
    let new = NewGrant {
        target: &target_id,
        scope: &scope,
        parent: &parent_id,
        root: &root,
        expires_at: crate::core::msg_post::iso_ms(now_ms + i64::from(a.days) * 86_400_000),
        now: crate::core::msg_post::iso_ms(now_ms),
        w,
    };
    let grant_id = write_pending(write, me, &a, &new, cause).await.ok()?;
    Some(super::respond::text_result(&format!(
        "{{\"grantId\":{},\"pending\":true,\"note\":{}}}",
        Value::from(grant_id.as_str()),
        Value::from("waiting for the root person to approve")
    )))
}

struct NewGrant<'a> {
    target: &'a str,
    scope: &'a str,
    parent: &'a str,
    root: &'a str,
    expires_at: String,
    now: String,
    w: bool,
}

/// TS `limits`(`parseLimits` 의 결과 — methods 는 겹침을 뺀 차례 그대로).
fn limits_json(a: &Args) -> Value {
    serde_json::json!({ "methods": a.methods, "pathPrefix": a.path_prefix })
}

/// TS `grant.delegate.pending` 감사 detail.
fn pending_detail(grant_id: &str, a: &Args, n: &NewGrant<'_>, cause: Option<&str>) -> Value {
    serde_json::json!({
        "grantId": grant_id,
        "parentGrantId": n.parent,
        "scope": n.scope,
        "limits": limits_json(a),
        "expiresAt": n.expires_at,
        "delegateDepth": a.delegate_depth,
        "writeNeedsHumanCause": n.w,
        "rootAccountId": n.root,
        "causeMessageId": cause,
    })
}

/// 줄 upsert·감사·`grant.changed` 를 한 트랜잭션에(TS 는 따로 쓰지만 어느 하나가 실패하면 Rust 는 롤백하고 TS 에 넘긴다).
async fn write_pending(
    write: &PgPool,
    me: &Account,
    a: &Args,
    n: &NewGrant<'_>,
    cause: Option<&str>,
) -> Result<String, sqlx::Error> {
    let mut tx = write.begin().await?;
    let id: String = sqlx::query_scalar(UPSERT_SQL)
        .bind(n.target)
        .bind(n.scope)
        .bind(&me.id)
        .bind(&n.expires_at)
        .bind(limits_json(a).to_string())
        .bind(a.delegate_depth)
        .bind(n.w)
        .bind(n.parent)
        .bind(&n.now)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(PENDING_AUDIT_SQL)
        .bind(&me.id)
        .bind(n.target)
        .bind(pending_detail(&id, a, n, cause).to_string())
        .execute(&mut *tx)
        .await?;
    crate::write::emit_event(
        &mut tx,
        &serde_json::json!({ "type": "grant.changed", "accountId": n.target, "audience": "all" }),
    )
    .await?;
    tx.commit().await?;
    Ok(id)
}

/// TS `deny` — 감사 줄(target = 연결 이름, detail = {code, to}) 뒤 `{error:{code, message: code}}`.
async fn deny(
    write: &PgPool,
    me: &Account,
    a: &Args,
    code: &'static str,
    message: Option<&str>,
) -> Option<String> {
    let detail = serde_json::json!({ "code": code, "to": a.to });
    sqlx::query(AUDIT_SQL)
        .bind(&me.id)
        .bind(&a.connector)
        .bind(detail.to_string())
        .execute(write)
        .await
        .ok()?;
    Some(err(code, message.unwrap_or(code)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok() -> Value {
        json!({ "to": "@bot", "connector": "gh-api", "methods": ["GET"], "pathPrefix": "/repos", "days": 7 })
    }

    #[test]
    fn parse_matches_zod() {
        assert_eq!(
            parse(&ok()),
            Some(Args {
                to: "@bot".into(),
                connector: "gh-api".into(),
                methods: vec!["GET".into()],
                path_prefix: "/repos".into(),
                days: 7,
                delegate_depth: 0,
                write_needs_human_cause: false,
            })
        );
        let bad = |k: &str, v: Value| {
            let mut o = ok();
            o[k] = v;
            assert!(parse(&o).is_none(), "{k}");
        };
        bad("to", json!(""));
        bad("connector", json!("Gh"));
        bad("connector", json!("-x"));
        bad("methods", json!([]));
        bad("methods", json!(["HEAD"]));
        bad("pathPrefix", json!(""));
        bad("days", json!(0));
        bad("days", json!(31));
        bad("days", json!(1.5));
        bad("delegateDepth", json!(2));
        bad("writeNeedsHumanCause", json!("yes"));
        assert!(parse(&json!([])).is_none());
        let mut o = ok();
        o["delegateDepth"] = json!(1);
        o["writeNeedsHumanCause"] = json!(true);
        o["extra"] = json!(1);
        assert!(parse(&o).is_some());
    }

    #[test]
    fn paths_match_ts() {
        assert_eq!(safe_path_plain("/repos/x"), Some(true));
        assert_eq!(safe_path_plain("/repos/../x"), Some(false));
        assert_eq!(safe_path_plain("//x"), Some(false));
        assert_eq!(safe_path_plain("/a;b"), Some(false));
        assert_eq!(safe_path_plain("/a\x0bb"), Some(false));
        assert_eq!(safe_path_plain("/a%2fb"), None);
        assert!(path_covered_plain("/api/x", "/api"));
        assert!(path_covered_plain("/api", "/api"));
        assert!(!path_covered_plain("/apix", "/api"));
        assert!(path_covered_plain("/api/x", "/api/"));
        assert!(!path_covered_plain("/api", "/api/"));
        assert!(wire_is_identity("/repos/a-b_c~"));
        assert!(!wire_is_identity("/r{x}"));
        assert_eq!(
            limits_of(Some(r#"{"methods":["GET"],"pathPrefix":"/r"}"#)),
            Some(Some(Limits {
                methods: vec!["GET".into()],
                path_prefix: "/r".into()
            }))
        );
        assert_eq!(limits_of(Some("null")), Some(None));
        assert_eq!(limits_of(Some(r#"{"methods":[1]}"#)), None);
    }

    #[test]
    fn writes_only_declared_tables() {
        assert!(GRANT_DELEGATE_PRIVILEGES.iter().all(|(c, p)| {
            (c.starts_with("audit_log.") && *p == "INSERT")
                || c.starts_with("account_grant.")
                || (*c == "event_outbox" && *p == "INSERT")
        }));
        assert!(!AUDIT_SQL.to_lowercase().contains("returning"));
        // upsert 가 고치는 칸은 모두 UPDATE 로, 넣는 칸은 모두 INSERT 로 적혀 있다.
        for col in [
            "granted_by",
            "granted_at",
            "expires_at",
            "limits",
            "delegate_depth",
            "write_needs_human_cause",
            "parent_grant_id",
            "suspended_at",
            "suspend_reason",
        ] {
            assert!(UPSERT_SQL.contains(&format!("{col} = ")), "{col}");
            assert!(
                GRANT_DELEGATE_PRIVILEGES.contains(&(&*format!("account_grant.{col}"), "UPDATE")),
                "{col}"
            );
        }
    }

    #[test]
    fn pending_detail_matches_ts() {
        let a = parse(&ok()).unwrap();
        let n = NewGrant {
            target: "t",
            scope: "connector:c",
            parent: "p",
            root: "r",
            expires_at: "2026-01-08T00:00:00.000Z".into(),
            now: "2026-01-01T00:00:00.000Z".into(),
            w: true,
        };
        assert_eq!(
            pending_detail("g", &a, &n, None),
            json!({
                "grantId": "g", "parentGrantId": "p", "scope": "connector:c",
                "limits": { "methods": ["GET"], "pathPrefix": "/repos" },
                "expiresAt": "2026-01-08T00:00:00.000Z", "delegateDepth": 0, "writeNeedsHumanCause": true,
                "rootAccountId": "r", "causeMessageId": null,
            })
        );
    }
}

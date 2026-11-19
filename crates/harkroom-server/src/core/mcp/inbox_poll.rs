//! MCP `inbox.poll` 의 빈 즉답 갈래(TS `mcpPlugin.ts` `inbox.poll`). Rust 는 **기다리지 않는 폴**(`timeoutMs` 없음·0)에
//! 버전·임대가 없을 때 답한다. 줄이 없으면 — 그때 TS 는 `{entries:[],messages:[]}` 를 내고, 에이전트면
//! `stopRequestedAt`(키는 늘 있다)을 덧붙인다. 줄이 있으면 `{entries,messages}`(본문 펼치기·시스템 줄 표시)에 에이전트면
//! `memoryRev` — 위임 스위치(`HARKROOM_DELEGATION_V2`)가 없으면 TS. 그 밖은 모두 `None`(→ TS): (허브가 없을 때의) 긴 폴, (쓰기 풀이 없을 때의) `version` 기록·`lease`
//! 임대(쓰기 — 쓰기 풀에 [`INBOX_LEASE_PRIVILEGES`] 가 있으면 [`answer_full`] 이 TS `leaseInboxEntries` 처럼 걸고 임대 걸린 줄을 빼고 읽는다),
//! (쓰기 풀에 [`INBOX_POLL_WRITE_PRIVILEGES`] 가 없을 때의) 옛 러너 접기·아직 승인 안 된 종료 요청 — 있으면 [`answer_full`] 이 TS 처럼 쓴다(P6-1),
//! zod 를 못 지나는 인자, DB 오류. 읽기만 한다 — 쓰기 권한(`*_PRIVILEGES`)이 필요 없다.
//!
//! `version` 이 온 폴([`answer_versioned`])은 쓰기 풀에 [`RUNNER_VERSION_PRIVILEGES`] 가 있을 때만 Rust 가 답한다 — 답이 정해진 뒤
//! TS `recordRunnerVersion` 처럼 값이 바뀔 때만 쓰고(프로세스 안 10분 캐시), 위임 v2 에서 `delegation_update` 를 모르는 러너라도
//! 버전이 `0.4.426` 이상이면(TS `knowsDelegationFollowup`) 사유를 `delegation_followup` 으로 바꿔 싣는다. 그보다 옛 러너(버전을 안 밝힌 러너 포함)는
//! TS 처럼 그 줄을 읽음으로 접고 뺀다([`fold_old_runner`]) — 읽기마다(첫 읽기·긴 폴 뒤 다시 읽기) 먼저 접는다. 접기 쓰기 풀이 없으면 TS.
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

/// TS `recordRunnerVersion` 의 UPSERT — 값이 바뀔 때만 행을 고친다.
const RUNNER_VERSION_SQL: &str = "insert into agent_runner_version (account_id, version, seen_at) \
     values ($1::uuid, $2, now()) \
     on conflict (account_id) do update set version = excluded.version, seen_at = excluded.seen_at \
     where agent_runner_version.version <> excluded.version";

/// [`RUNNER_VERSION_SQL`] 이 쓰는 칸(INSERT·UPDATE)과 `on conflict`·`where` 가 읽는 칸(SELECT). 빠지면 `version` 이 온 폴은 TS.
pub const RUNNER_VERSION_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_runner_version.account_id", "INSERT"),
    ("agent_runner_version.version", "INSERT"),
    ("agent_runner_version.seen_at", "INSERT"),
    ("agent_runner_version.version", "UPDATE"),
    ("agent_runner_version.seen_at", "UPDATE"),
    ("agent_runner_version.account_id", "SELECT"),
    ("agent_runner_version.version", "SELECT"),
];

/// TS `RUNNER_VERSION_CACHE_TTL_MS`.
const RUNNER_VERSION_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

type VersionCache =
    std::sync::Mutex<std::collections::HashMap<String, (String, std::time::Instant)>>;
fn version_cache() -> &'static VersionCache {
    static C: OnceLock<VersionCache> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// 이 프로세스가 같은 값을 최근(시한 안)에 기록했으면 참 — TS `recorded` 맵 조회.
fn version_cached(c: &VersionCache, account: &str, version: &str, now: std::time::Instant) -> bool {
    let m = c.lock().unwrap_or_else(|p| p.into_inner());
    m.get(account)
        .is_some_and(|(v, at)| v == version && now.duration_since(*at) < RUNNER_VERSION_TTL)
}

/// TS `recordRunnerVersion` — 실패한 쓰기는 기억하지 않는다.
async fn record_runner_version(
    write: &PgPool,
    account: &str,
    version: &str,
) -> Result<(), sqlx::Error> {
    let c = version_cache();
    if version_cached(c, account, version, std::time::Instant::now()) {
        return Ok(());
    }
    sqlx::query(RUNNER_VERSION_SQL)
        .bind(account)
        .bind(version)
        .execute(write)
        .await?;
    c.lock().unwrap_or_else(|p| p.into_inner()).insert(
        account.to_owned(),
        (version.to_owned(), std::time::Instant::now()),
    );
    Ok(())
}

/// TS `DELEGATION_FOLLOWUP_RUNNER_MIN`.
const DELEGATION_FOLLOWUP_RUNNER_MIN: [f64; 3] = [0.0, 4.0, 426.0];

/// TS `knowsDelegationFollowup` — `compareRelease(version.replace(/^v/, ''), '0.4.426') >= 0`. 못 읽으면 거짓.
fn knows_delegation_followup(version: Option<&str>) -> bool {
    let Some(v) = version.filter(|v| !v.is_empty()) else {
        return false;
    };
    let v = v.strip_prefix('v').unwrap_or(v);
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    for (p, min) in parts.iter().zip(DELEGATION_FOLLOWUP_RUNNER_MIN) {
        // JS `Number(...)` 와 같은 값(아주 긴 숫자도 f64 로).
        let n: f64 = p.parse().unwrap_or(f64::NAN);
        if n != min {
            return n > min;
        }
    }
    true
}

/// `{...e, reason: 'delegation_followup'}` — 맨 겉 `reason` 값만 그 자리에서 바꾼다(칸 순서 그대로).
fn to_followup(entry: &str) -> Option<String> {
    let (a, b) = super::tools::top_string_span(entry, "reason")?;
    Some(format!(
        "{}\"delegation_followup\"{}",
        &entry[..a],
        &entry[b..]
    ))
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

/// TS `ackAgentStop` — 승인 안 된 종료 요청에 수령 시각을 찍는다(경합에서 이미 찍혔으면 0줄 — TS 도 값을 그대로 싣는다).
const AGENT_STOP_ACK_SQL: &str = "update agent_config set stop_acked_at = now() \
      where account_id = $1::uuid and stop_requested_at is not null and stop_acked_at is null";

/// TS `inbox.poll` 의 옛 러너 접기 — `update inbox set read_at = now() where account_id = $1 and id = any($2::bigint[]) and read_at is null`.
const FOLD_SQL: &str = "update inbox set read_at = now() \
      where account_id = $1::uuid and id = any($2::bigint[]) and read_at is null";

/// [`FOLD_SQL`]·[`AGENT_STOP_ACK_SQL`] 이 쓰는 칸(UPDATE)과 `where` 가 읽는 칸(SELECT). 빠지면 옛 러너 접기·승인 안 된 종료 요청은 TS.
/// 운영 GRANT 는 이미 있다 — `update (read_at) on inbox`(inbox.read)·`update (stop_acked_at) on agent_config`(GET /agent/config).
pub const INBOX_POLL_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("inbox.read_at", "UPDATE"),
    ("inbox.id", "SELECT"),
    ("inbox.account_id", "SELECT"),
    ("inbox.read_at", "SELECT"),
    ("agent_config.stop_acked_at", "UPDATE"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.stop_requested_at", "SELECT"),
    ("agent_config.stop_acked_at", "SELECT"),
];

/// 옛 러너면 참 — 위임 v2 가 켜졌고, 러너가 `delegation_update` 를 밝히지 않았고, `delegation_followup` 도 모른다(TS 의 `else` 갈래).
fn folds_for(v2: bool, args: &Value, version: Option<&str>) -> bool {
    let knows_update = args
        .get("inboxReasons")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(|r| r == "delegation_update"));
    v2 && !knows_update && !knows_delegation_followup(version)
}

/// 접을 줄의 id — 사유가 `delegation_update` 인 줄. 못 읽는 줄이 있으면 `None`(→ TS).
fn fold_ids(rows: &[crate::core::inbox_list::InboxRow]) -> Option<Vec<i64>> {
    let mut ids = Vec::new();
    for r in rows {
        let v: Value = serde_json::from_str(&r.body).ok()?;
        if v.get("reason").and_then(Value::as_str) == Some("delegation_update") {
            ids.push(r.id);
        }
    }
    Some(ids)
}

/// TS `fetchUnread` 의 옛 러너 접기 — 읽기 **전에** 접을 줄을 읽음으로 바꾼다. 그 뒤의 읽기는 그 줄을 보지 않는다(TS 가 걸러 낸 목록과 같다).
/// 접을 일이 없으면 아무것도 쓰지 않는다. 접을 줄이 있는데 쓰기 풀이 없거나 쓰기가 실패하면 `None`(→ TS — 아직 아무 답도 내지 않았다).
async fn fold_old_runner(
    pool: &PgPool,
    fold: Option<&PgPool>,
    me: &Account,
    args: &Value,
    version: Option<&str>,
    leased: bool,
) -> Option<()> {
    // 접기는 v2 에서만 일어난다. 스위치를 모르면 줄이 있을 때 [`batch`] 가 TS 로 넘긴다 — 여기서는 건너뛴다.
    let v2 = crate::core::msg_post::delegation_v2(
        std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref(),
    )
    .unwrap_or(false);
    if !folds_for(v2, args, version) {
        return Some(());
    }
    let rows = list_inbox(pool, &me.id, unread(leased), false).await.ok()?;
    let ids = fold_ids(&rows)?;
    if ids.is_empty() {
        return Some(());
    }
    sqlx::query(FOLD_SQL)
        .bind(&me.id)
        .bind(&ids)
        .execute(fold?)
        .await
        .ok()?;
    Some(())
}

/// zod 를 지나고 Rust 가 답할 꼴이면 참 — `timeoutMs` 는 없거나 0, `version`·`lease` 는 없어야(있으면 TS 가 쓴다).
fn quick(args: &Value, allow_version: bool) -> bool {
    quick_with(args, allow_version, false)
        && !args.as_object().is_some_and(|o| o.contains_key("lease"))
}

/// TS `INBOX_LEASE_MS`.
const INBOX_LEASE_MS: i32 = 120_000;
/// JS `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// TS `leaseInboxEntries` 의 첫 문장 — 이 러너가 쥐었다가 이제 안 쥔(안 읽은) 항목을 푼다.
const UNLEASE_SQL: &str = "update inbox set claimed_by = null, claimed_until = null \
     where account_id = $1::uuid and claimed_by = $2 and read_at is null and not (id = any($3::bigint[]))";
/// 둘째 문장 — 쥔 항목에 임대를 건다(쥔 것이 없으면 TS 처럼 부르지 않는다).
const LEASE_SQL: &str = "update inbox set claimed_by = $2, claimed_until = now() + make_interval(secs => $4::int / 1000.0) \
     where account_id = $1::uuid and id = any($3::bigint[]) and read_at is null";

/// [`UNLEASE_SQL`]·[`LEASE_SQL`] 이 쓰는 칸(UPDATE)과 `where` 가 읽는 칸(SELECT). 빠지면 `lease` 가 온 폴은 TS.
pub const INBOX_LEASE_PRIVILEGES: &[(&str, &str)] = &[
    ("inbox.claimed_by", "UPDATE"),
    ("inbox.claimed_until", "UPDATE"),
    ("inbox.id", "SELECT"),
    ("inbox.account_id", "SELECT"),
    ("inbox.claimed_by", "SELECT"),
    ("inbox.read_at", "SELECT"),
];

/// zod `lease: z.object({ runnerId: z.string().min(1).max(128), holding: z.array(int 1..=MAX_SAFE_INTEGER).max(1000) }).optional()`.
/// 없으면 `Some(None)`, 못 지나면 `None`.
fn parse_lease(args: &Value) -> Option<Option<(String, Vec<i64>)>> {
    let Some(v) = args.get("lease") else {
        return Some(None);
    };
    let o = v.as_object()?;
    let runner = o.get("runnerId")?.as_str()?;
    if !(1..=128).contains(&runner.encode_utf16().count()) {
        return None;
    }
    let a = o.get("holding")?.as_array()?;
    if a.len() > 1000 {
        return None;
    }
    let mut holding = Vec::with_capacity(a.len());
    for x in a {
        let f = x.as_f64()?;
        if f.fract() != 0.0 || !(1.0..=MAX_SAFE_INTEGER).contains(&f) {
            return None;
        }
        holding.push(f as i64);
    }
    Some(Some((runner.to_owned(), holding)))
}

/// TS `leaseInboxEntries`.
async fn lease_entries(
    write: &PgPool,
    account: &str,
    runner: &str,
    holding: &[i64],
) -> Result<(), sqlx::Error> {
    sqlx::query(UNLEASE_SQL)
        .bind(account)
        .bind(runner)
        .bind(holding)
        .execute(write)
        .await?;
    if holding.is_empty() {
        return Ok(());
    }
    sqlx::query(LEASE_SQL)
        .bind(account)
        .bind(runner)
        .bind(holding)
        .bind(INBOX_LEASE_MS)
        .execute(write)
        .await?;
    Ok(())
}

/// 이 폴이 읽을 갈래 — `lease` 가 왔으면 임대 걸린 줄을 뺀다(TS `skipLeased: lease !== undefined`).
fn unread(leased: bool) -> InboxQuery {
    if leased {
        InboxQuery::UnreadUnleased
    } else {
        InboxQuery::Unread { since: None }
    }
}

/// `timeoutMs: z.number().int().min(0).max(25_000).optional()` — 없으면 0. 못 지나면 `None`.
fn timeout_ms(args: &Value) -> Option<u64> {
    match args.get("timeoutMs") {
        None => Some(0),
        Some(v) => {
            let f = v.as_f64()?;
            (f.fract() == 0.0 && (0.0..=25_000.0).contains(&f)).then_some(f as u64)
        }
    }
}

/// [`quick`] 에 긴 폴(`timeoutMs > 0`)까지 받을지(`allow_wait`).
fn quick_with(args: &Value, allow_version: bool, allow_wait: bool) -> bool {
    let o = match args {
        Value::Object(o) => o,
        _ => return false,
    };
    let timeout_ok = match timeout_ms(args) {
        Some(0) => true,
        Some(_) => allow_wait,
        None => false,
    };
    let reasons_ok = match o.get("inboxReasons") {
        None => true,
        Some(v) => v
            .as_array()
            .is_some_and(|a| a.len() <= 32 && a.iter().all(Value::is_string)),
    };
    let version_ok = match o.get("version") {
        None => true,
        Some(v) => allow_version && v.is_string(),
    };
    // `lease` 는 [`answer_full`] 이 따로 본다(쓰기 풀이 있을 때만).
    timeout_ok && reasons_ok && version_ok
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
    if !quick(args, false) {
        return None;
    }
    respond(pool, None, me, args, None, false).await
}

/// `version` 이 온 폴 — 답이 정해지면 TS 처럼 버전을 기록하고(빈 글자는 기록하지 않는다, TS `if (version)`) 답한다. 기록이 실패하면 TS.
///
/// `hub` 이 있으면 긴 폴(`timeoutMs > 0`)도 받는다 — TS 처럼 첫 읽기 **전에** 이벤트 허브를 구독하고, 비었으면 이 계정의
/// `inbox.updated` 가 오거나 시한이 될 때까지 기다린 뒤 다시 읽는다. 기다리기 전에 TS 로 넘길 갈래(줄이 있는데 고쳐 쓸 일·승인 안 된
/// 종료 요청)가 보이면 기다리지 않고 넘긴다 — TS 가 처음부터 다시 기다리지 않게.
///
/// `fold` 는 [`INBOX_POLL_WRITE_PRIVILEGES`] 쓰기 풀 — 옛 러너 접기와 승인 안 된 종료 요청의 수령 기록을 TS 처럼 여기서 쓴다. 없으면 그 둘은 TS.
pub async fn answer_full(
    read: &PgPool,
    write: Option<&PgPool>,
    hub: Option<&crate::core::events::Hub>,
    lease_write: Option<&PgPool>,
    fold: Option<&PgPool>,
    me: &Account,
    args: &Value,
) -> Option<String> {
    if !quick_with(args, write.is_some(), hub.is_some()) {
        return None;
    }
    let lease = parse_lease(args)?;
    let leased = lease.is_some();
    // TS 순서: (버전 기록) → 임대 → 읽기. 임대는 같은 값으로 다시 걸어도 같으니, 뒤에서 TS 로 넘겨도 TS 가 다시 건다.
    if let Some((runner, holding)) = &lease {
        lease_entries(lease_write?, &me.id, runner, holding)
            .await
            .ok()?;
    }
    let version = args.get("version").and_then(Value::as_str);
    let wait = timeout_ms(args)?;
    let out = match hub.filter(|_| wait > 0) {
        Some(h) => wait_then_respond(read, fold, me, args, version, h, wait, leased).await?,
        None => respond(read, fold, me, args, version, leased).await?,
    };
    if let (Some(w), Some(v)) = (write, version.filter(|v| !v.is_empty())) {
        record_runner_version(w, &me.id, v).await.ok()?;
    }
    Some(out)
}

fn drain_tx() -> &'static tokio::sync::watch::Sender<bool> {
    static D: OnceLock<tokio::sync::watch::Sender<bool>> = OnceLock::new();
    D.get_or_init(|| tokio::sync::watch::channel(false).0)
}

/// 종료가 시작됐다(TS `lifecycle.onDrain`) — 기다리던 긴 폴을 깨우고, 이후의 폴은 기다리지 않는다. 종료가 25초 폴을 붙잡지 않게.
pub fn begin_drain() {
    drain_tx().send_replace(true);
}

/// 이 계정의 `inbox.updated` 면 참(TS `e.type === 'inbox.updated' && e.accountId === account.id`).
fn wakes(e: &Value, account: &str) -> bool {
    e.get("type").and_then(Value::as_str) == Some("inbox.updated")
        && e.get("accountId").and_then(Value::as_str) == Some(account)
}

#[allow(clippy::too_many_arguments)]
async fn wait_then_respond(
    pool: &PgPool,
    fold: Option<&PgPool>,
    me: &Account,
    args: &Value,
    version: Option<&str>,
    hub: &crate::core::events::Hub,
    wait_ms: u64,
    leased: bool,
) -> Option<String> {
    use tokio::sync::broadcast::error::{RecvError, TryRecvError};
    // 첫 읽기 전에 구독한다 — 그 왕복 사이에 온 깨움을 잃지 않게(TS 주석과 같은 까닭).
    let mut rx = hub.subscribe();
    let mut drain = drain_tx().subscribe();
    fold_old_runner(pool, fold, me, args, version, leased).await?;
    let rows = list_inbox(pool, &me.id, unread(leased), false).await.ok()?;
    if !rows.is_empty() {
        return respond(pool, fold, me, args, version, leased).await;
    }
    // 비었는데 승인 안 된 종료 요청이 있고 수령을 쓸 풀이 없으면 TS 가 답한다 — 기다리기 전에 넘긴다. 풀이 있으면 TS 처럼
    // 기다린 뒤 다시 읽으며 수령을 찍는다([`respond`]).
    if me.kind == "agent" && fold.is_none() {
        let stop = sqlx::query_as::<_, (Option<String>, bool)>(AGENT_STOP_SQL)
            .bind(&me.id)
            .fetch_optional(pool)
            .await
            .ok()?;
        if matches!(stop, Some((Some(_), false))) {
            return None;
        }
    }
    // 첫 읽기 동안 이미 깨움이 왔으면 기다리지 않는다. 놓친 것이 있으면(lagged) 깨운 것으로 본다.
    let mut woken = false;
    loop {
        match rx.try_recv() {
            Ok(e) if wakes(&e, &me.id) => {
                woken = true;
                break;
            }
            Ok(_) => {}
            Err(TryRecvError::Lagged(_)) => {
                woken = true;
                break;
            }
            Err(_) => break,
        }
    }
    // 종료 중이면 기다리지 않는다(TS `draining`). 기다리는 동안 종료가 오면 깨어난다.
    if !woken && !*drain.borrow_and_update() {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(wait_ms), async {
            let drained = async {
                let _ = drain.wait_for(|d| *d).await;
            };
            tokio::pin!(drained);
            loop {
                tokio::select! {
                    _ = &mut drained => return,
                    r = rx.recv() => match r {
                        Ok(e) if wakes(&e, &me.id) => return,
                        Ok(_) => {}
                        Err(RecvError::Lagged(_)) => return,
                        // 허브가 닫히면 종료·시한까지 기다린다.
                        Err(RecvError::Closed) => {
                            let _ = (&mut drained).await;
                            return;
                        }
                    },
                }
            }
        })
        .await;
    }
    // 깨웠거나 시한을 다 기다렸다 — TS 처럼 다시 읽어 답한다.
    respond(pool, fold, me, args, version, leased).await
}

async fn respond(
    pool: &PgPool,
    fold: Option<&PgPool>,
    me: &Account,
    args: &Value,
    version: Option<&str>,
    leased: bool,
) -> Option<String> {
    // TS `fetchUnread` 처럼 읽기마다 먼저 접는다.
    fold_old_runner(pool, fold, me, args, version, leased).await?;
    // 빈 목록에는 위임 요약이 붙지 않으니 `v2` 값과 무관하다.
    let rows = list_inbox(pool, &me.id, unread(leased), false).await.ok()?;
    let agent = me.kind == "agent";
    if !rows.is_empty() {
        return batch(pool, me, args, &rows, agent, version, leased).await;
    }
    let mut stop = if agent {
        sqlx::query_as::<_, (Option<String>, bool)>(AGENT_STOP_SQL)
            .bind(&me.id)
            .fetch_optional(pool)
            .await
            .ok()?
    } else {
        None
    };
    // TS `readAgentStop` — 승인 안 된 요청이면 수령을 찍고 요청 시각을 싣는다. 쓸 풀이 없으면 [`empty_text`] 가 `None`(→ TS).
    if let (Some((Some(_), acked @ false)), Some(w)) = (stop.as_mut(), fold) {
        sqlx::query(AGENT_STOP_ACK_SQL)
            .bind(&me.id)
            .execute(w)
            .await
            .ok()?;
        *acked = true;
    }
    empty_text(agent, stop)
}

async fn batch(
    pool: &PgPool,
    me: &Account,
    args: &Value,
    rows: &[crate::core::inbox_list::InboxRow],
    agent: bool,
    version: Option<&str>,
    leased: bool,
) -> Option<String> {
    // TS 는 스위치가 없으면 꺼짐으로 본다 — Rust 는 값이 없으면 모르니 TS 로(`msg_post::delegation_v2`).
    let v2 = crate::core::msg_post::delegation_v2(
        std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref(),
    )?;
    // 위에서 `v2=false` 로 읽었으니, 켜졌으면 위임 요약이 붙은 줄로 다시 읽는다.
    let rows = if v2 {
        list_inbox(pool, &me.id, unread(leased), true).await.ok()?
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
        // 옛 러너(163 미만)의 줄은 [`fold_old_runner`] 가 읽기 전에 접었다 — 그 사이에 새로 온 줄(경합)만 여기 닿는다. TS 로.
        if !knows_delegation_followup(version) {
            return None;
        }
        for (e, r) in entries.iter_mut().zip(&reasons) {
            if r.as_deref() == Some("delegation_update") {
                *e = to_followup(e)?;
            }
        }
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
    fn lease_args_follow_zod() {
        assert_eq!(parse_lease(&json!({})), Some(None));
        assert_eq!(
            parse_lease(
                &json!({ "lease": { "runnerId": "r", "holding": [1, 9007199254740991_i64], "x": 1 } })
            ),
            Some(Some(("r".to_owned(), vec![1, 9_007_199_254_740_991])))
        );
        assert_eq!(
            parse_lease(&json!({ "lease": { "runnerId": "r", "holding": [] } })),
            Some(Some(("r".to_owned(), vec![])))
        );
        let many: Vec<i64> = (1..=1001).collect();
        for bad in [
            json!({ "lease": null }),
            json!({ "lease": { "holding": [] } }),
            json!({ "lease": { "runnerId": "", "holding": [] } }),
            json!({ "lease": { "runnerId": "r".repeat(129), "holding": [] } }),
            json!({ "lease": { "runnerId": "r" } }),
            json!({ "lease": { "runnerId": "r", "holding": [0] } }),
            json!({ "lease": { "runnerId": "r", "holding": [1.5] } }),
            json!({ "lease": { "runnerId": "r", "holding": ["1"] } }),
            json!({ "lease": { "runnerId": "r", "holding": [9007199254740992_i64] } }),
            json!({ "lease": { "runnerId": "r", "holding": many } }),
        ] {
            assert_eq!(parse_lease(&bad), None, "{bad}");
        }
        assert!(matches!(unread(true), InboxQuery::UnreadUnleased));
        assert!(matches!(unread(false), InboxQuery::Unread { since: None }));
    }

    #[test]
    fn old_runner_fold_like_ts() {
        // TS `else` 갈래: v2 켜짐 · `delegation_update` 를 안 밝힘 · `knowsDelegationFollowup` 거짓.
        assert!(folds_for(true, &json!({}), None));
        assert!(folds_for(true, &json!({}), Some("0.4.425")));
        assert!(folds_for(
            true,
            &json!({ "inboxReasons": ["mention"] }),
            Some("bad")
        ));
        assert!(!folds_for(false, &json!({}), None));
        assert!(!folds_for(true, &json!({}), Some("0.4.426")));
        assert!(!folds_for(
            true,
            &json!({ "inboxReasons": ["delegation_update"] }),
            None
        ));
        let row = |id: i64, reason: &str| crate::core::inbox_list::InboxRow {
            id,
            body: json!({ "id": id, "reason": reason }).to_string(),
            root: String::new(),
        };
        assert_eq!(
            fold_ids(&[
                row(3, "mention"),
                row(5, "delegation_update"),
                row(9, "delegation_update")
            ]),
            Some(vec![5, 9])
        );
        assert_eq!(fold_ids(&[row(3, "mention")]), Some(vec![]));
        let bad = crate::core::inbox_list::InboxRow {
            id: 1,
            body: "{".into(),
            root: String::new(),
        };
        assert_eq!(fold_ids(&[bad]), None);
        assert!(
            FOLD_SQL
                .ends_with("account_id = $1::uuid and id = any($2::bigint[]) and read_at is null")
        );
        assert!(FOLD_SQL.starts_with("update inbox set read_at = now()"));
        assert!(AGENT_STOP_ACK_SQL.ends_with(
            "account_id = $1::uuid and stop_requested_at is not null and stop_acked_at is null"
        ));
        for (c, p) in [
            ("inbox.read_at", "UPDATE"),
            ("agent_config.stop_acked_at", "UPDATE"),
            ("agent_config.stop_requested_at", "SELECT"),
            ("inbox.account_id", "SELECT"),
        ] {
            assert!(INBOX_POLL_WRITE_PRIVILEGES.contains(&(c, p)), "{c} {p}");
        }
    }

    #[test]
    fn lease_sql_like_ts() {
        assert!(
            UNLEASE_SQL
                .contains("claimed_by = $2 and read_at is null and not (id = any($3::bigint[]))")
        );
        assert!(LEASE_SQL.contains("make_interval(secs => $4::int / 1000.0)"));
        assert!(LEASE_SQL.ends_with("id = any($3::bigint[]) and read_at is null"));
        assert_eq!(INBOX_LEASE_MS, 120_000);
        for c in ["claimed_by", "claimed_until"] {
            assert!(INBOX_LEASE_PRIVILEGES.contains(&(&format!("inbox.{c}") as &str, "UPDATE")));
        }
        for c in ["id", "account_id", "claimed_by", "read_at"] {
            assert!(INBOX_LEASE_PRIVILEGES.contains(&(&format!("inbox.{c}") as &str, "SELECT")));
        }
    }

    #[test]
    fn wait_args_follow_zod() {
        assert_eq!(timeout_ms(&json!({})), Some(0));
        assert_eq!(timeout_ms(&json!({ "timeoutMs": 25000 })), Some(25_000));
        assert_eq!(timeout_ms(&json!({ "timeoutMs": 25001 })), None);
        assert_eq!(timeout_ms(&json!({ "timeoutMs": -1 })), None);
        assert_eq!(timeout_ms(&json!({ "timeoutMs": 1.5 })), None);
        assert_eq!(timeout_ms(&json!({ "timeoutMs": "5" })), None);
        assert!(quick_with(&json!({ "timeoutMs": 5000 }), false, true));
        assert!(!quick_with(&json!({ "timeoutMs": 5000 }), false, false));
        // `lease` 는 `quick_with` 가 아니라 `answer_full`(쓰기 풀 있을 때)이 본다. 쓰기 없는 `quick` 은 여전히 넘긴다.
        assert!(quick_with(
            &json!({ "timeoutMs": 5000, "lease": { "runnerId": "r", "holding": [] } }),
            false,
            true
        ));
        assert!(!quick(
            &json!({ "lease": { "runnerId": "r", "holding": [] } }),
            true
        ));
        assert!(!quick_with(
            &json!({ "timeoutMs": 5000, "version": "1" }),
            false,
            true
        ));
        assert!(quick_with(
            &json!({ "timeoutMs": 5000, "version": "1" }),
            true,
            true
        ));
    }

    #[test]
    fn drain_is_sticky_for_new_polls() {
        begin_drain();
        assert!(*drain_tx().subscribe().borrow());
    }

    #[test]
    fn wakes_only_own_inbox_updated() {
        assert!(wakes(
            &json!({ "type": "inbox.updated", "accountId": "a" }),
            "a"
        ));
        assert!(!wakes(
            &json!({ "type": "inbox.updated", "accountId": "b" }),
            "a"
        ));
        assert!(!wakes(
            &json!({ "type": "message.created", "accountId": "a" }),
            "a"
        ));
    }

    #[test]
    fn quick_version_only_when_allowed() {
        assert!(quick(&json!({ "version": "0.4.426" }), true));
        assert!(quick(&json!({ "version": "" }), true));
        assert!(!quick(&json!({ "version": 1 }), true));
        assert!(!quick(&json!({ "version": "1", "timeoutMs": 5 }), true));
        assert!(!quick(
            &json!({ "version": "1", "lease": { "runnerId": "r", "holding": [] } }),
            true
        ));
    }

    #[test]
    fn followup_version_matches_ts() {
        for (v, want) in [
            (None, false),
            (Some(""), false),
            (Some("0.4.426"), true),
            (Some("v0.4.426"), true),
            (Some("0.4.425"), false),
            (Some("0.5.0"), true),
            (Some("1.0.0"), true),
            (Some("0.3.999"), false),
            (Some("0.4.426-rc1"), false),
            (Some("0.4"), false),
            (Some("vv0.4.426"), false),
            (Some("0.4.0426"), true),
        ] {
            assert_eq!(knows_delegation_followup(v), want, "{v:?}");
        }
    }

    #[test]
    fn followup_rewrites_top_reason_only() {
        assert_eq!(
            to_followup(
                r#"{"id":1,"reason":"delegation_update","x":{"reason":"delegation_update"}}"#
            )
            .unwrap(),
            r#"{"id":1,"reason":"delegation_followup","x":{"reason":"delegation_update"}}"#
        );
        assert!(to_followup(r#"{"id":1}"#).is_none());
    }

    #[test]
    fn version_cache_ttl() {
        let c: VersionCache = Default::default();
        let t = std::time::Instant::now();
        assert!(!version_cached(&c, "a", "1", t));
        c.lock().unwrap().insert("a".into(), ("1".into(), t));
        assert!(version_cached(&c, "a", "1", t));
        assert!(!version_cached(&c, "a", "2", t));
        assert!(!version_cached(&c, "b", "1", t));
        assert!(!version_cached(&c, "a", "1", t + RUNNER_VERSION_TTL));
    }

    #[test]
    fn runner_version_privileges_cover_sql() {
        let l = RUNNER_VERSION_SQL.to_lowercase();
        assert!(l.contains("insert into agent_runner_version"));
        for (col, _) in RUNNER_VERSION_PRIVILEGES {
            let c = col.strip_prefix("agent_runner_version.").unwrap();
            assert!(l.contains(c), "{c}");
        }
    }

    #[test]
    fn quick_only_for_no_wait_no_write() {
        assert!(quick(&json!({}), false));
        assert!(quick(
            &json!({ "timeoutMs": 0, "inboxReasons": ["mention"], "claudeLane": 1 }),
            false
        ));
        for bad in [
            json!(null),
            json!({ "timeoutMs": 25000 }),
            json!({ "timeoutMs": "0" }),
            json!({ "version": "1" }),
            json!({ "lease": { "runnerId": "r", "holding": [] } }),
            json!({ "inboxReasons": [1] }),
        ] {
            assert!(!quick(&bad, false), "{bad}");
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

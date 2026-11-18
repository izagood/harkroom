//! S5.4 — `POST /agent/merge-checks`(TS `mergeRoutes.ts` → `mergeGrants.ts::checkMerge`) — **부분 이식**.
//!
//! Rust 는 판정 전의 두 갈래만 답한다: 오퍼레이터를 거치지 않은 요청(403 `forbidden`)과 zod 모양이 틀린 본문(400 `bad_request`).
//! 쓰기 풀에 [`MERGE_CHECKS_DENY_PRIVILEGES`] 가 다 있으면 그림자 감사가 비는 이른 거절([`early_denial`] — 403 `lease_invalid`·400 `bad_repo`,
//! `repo.merge.denied` 감사 포함)도 Rust 가 답한다. [`MERGE_CHECKS_ALLOW_PRIVILEGES`] 까지 있으면 흔한 허락 길(위임 스위치 꺼짐·임대에 위임장 없음·
//! 1회 승인 없음·머지 grant 있음·사람 턴 또는 `allow_agent_cause`)도 Rust 가 `repo.merge.checked`·`mandate.shadow` 감사와 함께 답한다.
//! 그 밖의 모양이 맞는 요청은 전부 TS 로 넘긴다 — 임대·사슬 판정(`checkMergeByChain`)·위임 판정·1회 승인 소모·`merge_denial`·카드·
//! 그림자 감사(`mandate.shadow`)는 아직 TS 몫이다. 넘기는 쪽은 임대를 읽기만 하고 쓰지 않는다.
//!
//! `POST /agent/merge-results`(TS `reportMerge`)도 같은 꼴로 부분 이식한다 — 403 `forbidden`·400 `bad_request` 만 Rust,
//! 읽기 풀([`MERGE_RESULTS_PRIVILEGES`])이 있으면 N1 관문(403 `lease_invalid`·400 `bad_repo`·409 `already_reported`/`not_checked`)도
//! Rust 가 답한다. 글 경로와 [`MERGE_RESULTS_WRITE_PRIVILEGES`] 까지 있으면 받을 `failed` 보고(CI 거절이면 `recordCiDenial`·`denialId` 까지)와 `merged` 보고
//! (무시한 체크 꼬리·`obsoleteMergeCards` 카드 닫기·`noteOnceGhUserUsed` gh 이름 메모 포함)도 Rust 가 적는다 — 시스템 줄·감사·201 `{ messageId }`.
//! `queued` 보고도 위임 v2 스위치가 꺼졌다고 확실하면(감시 없음) Rust 가 적는다. 스위치가 켜졌거나 모르는 「큐」 줄(감시)이 필요한 보고는 쓰기 전에 TS 로 넘긴다.
use super::grant_reads::through_operator;
use super::merge_approval_peek::str_len_ok;
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::json_err;
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value, json};
use std::net::SocketAddr;
use std::sync::Arc;

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token, repo, number and a 40-hex headSha are required";

/// zod `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`.
fn gh_user_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 39
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// zod `{ leaseId, token, repo, number, headSha, ghUser? }` 모양만 본다(남는 키는 zod 처럼 무시).
pub fn shape_ok(body: Option<&Value>) -> bool {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => match v.as_object() {
            Some(o) => o,
            None => return false,
        },
    };
    let ok = (|| {
        if !is_uuid(o.get("leaseId")?.as_str()?) {
            return None;
        }
        str_len_ok(o.get("token")?, 1, 200)?;
        str_len_ok(o.get("repo")?, 3, 201)?;
        let n = o.get("number")?.as_f64()?;
        if !(n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0) {
            return None;
        }
        let h = o.get("headSha")?.as_str()?;
        if !(h.len() == 40 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))) {
            return None;
        }
        if let Some(g) = o.get("ghUser")
            && !gh_user_ok(g.as_str()?)
        {
            return None;
        }
        Some(())
    })();
    ok.is_some()
}

const BAD_RESULT: &str = "leaseId, token, repo, number, headSha and result are required";

/// 키가 없거나 `null` 이면 통과(zod `.nullable().optional()`), 아니면 길이 0..=max 문자열.
fn opt_null_str(o: &Map<String, Value>, k: &str, max: usize) -> Option<()> {
    match o.get(k) {
        None | Some(Value::Null) => Some(()),
        Some(v) => str_len_ok(v, 0, max).map(|_| ()),
    }
}

/// zod `z.array(z.string().max(1000)).max(100)`.
fn str_array_ok(v: &Value) -> Option<()> {
    let a = v.as_array()?;
    if a.len() > 100 {
        return None;
    }
    for x in a {
        str_len_ok(x, 0, 1000)?;
    }
    Some(())
}

/// TS `/agent/merge-results` 의 zod 모양 — `base` + `result`·`mergeSha?`·`error?`·`ciRefusal?`·`ignoredChecks?`·
/// `noPrChecks?`·`ghUserUsed?`(남는 키는 무시).
pub fn results_shape_ok(body: Option<&Value>) -> bool {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => match v.as_object() {
            Some(o) => o,
            None => return false,
        },
    };
    let ok = (|| {
        if !is_uuid(o.get("leaseId")?.as_str()?) {
            return None;
        }
        str_len_ok(o.get("token")?, 1, 200)?;
        str_len_ok(o.get("repo")?, 3, 201)?;
        let n = o.get("number")?.as_f64()?;
        if !(n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0) {
            return None;
        }
        if !sha_ok(o.get("headSha")?.as_str()?) {
            return None;
        }
        if !matches!(o.get("result")?.as_str()?, "merged" | "queued" | "failed") {
            return None;
        }
        match o.get("mergeSha") {
            None | Some(Value::Null) => {}
            Some(v) => {
                if !sha_ok(v.as_str()?) {
                    return None;
                }
            }
        }
        opt_null_str(o, "error", 1000)?;
        match o.get("ciRefusal") {
            None | Some(Value::Null) => {}
            Some(v) => {
                let c = v.as_object()?;
                str_len_ok(c.get("code")?, 0, 40)?;
                opt_null_str(c, "mergeState", 40)?;
                str_array_ok(c.get("checks")?)?;
            }
        }
        if let Some(v) = o.get("ignoredChecks") {
            str_array_ok(v)?;
        }
        if let Some(v) = o.get("noPrChecks") {
            v.as_bool()?;
        }
        opt_null_str(o, "ghUserUsed", 100)?;
        Some(())
    })();
    ok.is_some()
}

fn sha_ok(h: &str) -> bool {
    h.len() == 40 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// `merge-results` 의 N1 관문(읽기만)에 쓰는 권한. 없으면 관문 없이 403/400 만 Rust 가 답한다.
pub const MERGE_RESULTS_PRIVILEGES: &[(&str, &str)] =
    &[("secret_turn_lease", "SELECT"), ("audit_log", "SELECT")];

/// TS `readLease` 중 이 라우트가 쓰는 칸(보고는 턴이 끝난 뒤 올 수 있어 `ended` 는 보지 않는다).
const RESULTS_LEASE_SQL: &str = "select l.id::text, l.agent_id::text, l.operator_id::text, \
       l.expires_at <= $3::timestamptz \
     from secret_turn_lease l where l.id = $1::uuid and l.token_hash = $2::text";

/// TS `reportMerge` 의 `trail` select.
const TRAIL_SQL: &str = "select action from audit_log \
      where action in ('repo.merge.checked', 'repo.merge.merged', 'repo.merge.queued', 'repo.merge.failed') \
        and target = $1 and detail->>'leaseId' = $2 and (detail->>'number')::int = $3::bigint and detail->>'headSha' = $4";

pub struct ResultsState {
    pub up: Upstream,
    pub read: Option<sqlx::PgPool>,
    /// 받을 `failed` 보고(CI 거절 아님)를 Rust 가 적는 글 경로 — 쓰기 풀에 [`MERGE_RESULTS_WRITE_PRIVILEGES`] 까지 있을 때만.
    pub post: Option<super::msg_post::PostState>,
}

/// 받을 보고 중 Rust 가 적는 갈래(`result: failed`·CI 거절 아님)가 읽고 쓰는 칸. 글 경로 칸은
/// `msg_post::MESSAGE_POST_PRIVILEGES` 로 따로 본다. 하나라도 없으면 받을 보고는 TS 로 넘긴다.
pub const MERGE_RESULTS_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "SELECT"),
    ("audit_log", "SELECT"),
    ("audit_log", "INSERT"),
    ("merge_approval.id", "SELECT"),
    ("merge_approval.approved_by", "SELECT"),
    ("merge_approval.ci_override", "SELECT"),
    ("merge_approval.used_lease_id", "SELECT"),
    ("merge_approval.scope", "SELECT"),
    ("merge_approval.pr_number", "SELECT"),
    ("merge_approval.head_sha", "SELECT"),
    ("merge_approval.gh_user", "SELECT"),
    ("merge_approval.approved_checks", "SELECT"),
    ("merge_approval.denial_id", "SELECT"),
    ("merge_denial.id", "SELECT"),
    ("merge_denial.scope", "SELECT"),
    ("merge_denial.pr_number", "SELECT"),
    ("merge_denial.used_at", "SELECT"),
    ("merge_denial.obsoleted_at", "SELECT"),
    ("merge_denial.obsoleted_at", "UPDATE"),
    ("merge_denial.agent_id", "SELECT"),
    ("merge_denial.channel_id", "SELECT"),
    ("merge_denial.thread_root_id", "SELECT"),
    ("merge_denial.head_sha", "SELECT"),
    ("merge_denial.expires_at", "SELECT"),
    ("merge_denial.reason", "SELECT"),
    ("merge_denial.created_at", "SELECT"),
    ("merge_denial.lease_id", "UPDATE"),
    ("merge_denial.failed_checks", "UPDATE"),
    ("merge_denial.agent_id", "INSERT"),
    ("merge_denial.scope", "INSERT"),
    ("merge_denial.pr_number", "INSERT"),
    ("merge_denial.head_sha", "INSERT"),
    ("merge_denial.channel_id", "INSERT"),
    ("merge_denial.thread_root_id", "INSERT"),
    ("merge_denial.lease_id", "INSERT"),
    ("merge_denial.expires_at", "INSERT"),
    ("merge_denial.reason", "INSERT"),
    ("merge_denial.failed_checks", "INSERT"),
    ("permission_request.kind", "SELECT"),
    ("permission_request.status", "SELECT"),
    ("permission_request.target", "SELECT"),
    ("permission_request.denial_id", "SELECT"),
    ("permission_request.id", "SELECT"),
    ("permission_request.agent_id", "SELECT"),
    ("permission_request.card_message_id", "SELECT"),
    ("permission_request.status", "UPDATE"),
    ("permission_request.decided_at", "UPDATE"),
    ("merge_denial.card_message_id", "SELECT"),
    ("message.meta", "UPDATE"),
    ("account_grant", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("account", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("message", "SELECT"),
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
];

/// 받을 보고의 임대(채널·스레드까지).
const POST_LEASE_SQL: &str = "select l.id::text, l.agent_id::text, l.operator_id::text, l.channel_id::text, \
       l.thread_root_id::text, l.expires_at <= $3::timestamptz \
     from secret_turn_lease l where l.id = $1::uuid and l.token_hash = $2::text";

/// TS `reportMerge` 의 `trail` select(위임 사슬 뿌리까지).
const POST_TRAIL_SQL: &str = "select action, detail->'viaChain' from audit_log \
      where action in ('repo.merge.checked', 'repo.merge.merged', 'repo.merge.queued', 'repo.merge.failed') \
        and target = $1 and detail->>'leaseId' = $2 and (detail->>'number')::int = $3::bigint and detail->>'headSha' = $4";

/// TS `reportMerge` 의 `usedApproval` select.
const USED_APPROVAL_SQL: &str = "select id::text, approved_by::text, ci_override, approved_checks \
       from merge_approval where used_lease_id = $1::uuid and scope = $2 and pr_number = $3::bigint and head_sha = $4";

/// JS 참 값(`x.viaChain` 의 `&&`).
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// TS `isCiRefusal`.
pub fn is_ci_refusal(c: Option<&Value>) -> bool {
    let Some(c) = c.and_then(Value::as_object) else {
        return false;
    };
    let code = c.get("code").and_then(Value::as_str);
    code == Some("ci_not_green")
        || (code == Some("not_mergeable")
            && c.get("mergeState").and_then(Value::as_str) == Some("UNSTABLE"))
}

/// Rust 가 적을 수 있는 보고인가 — `failed`(CI 거절 포함)·`merged`(카드 닫기·gh 이름 메모 포함)·`queued`(무시한 체크 포함). 감시
/// 가 필요한 `queued` 는 `report_failed` 가 DB 를 보고 TS 로 넘긴다.
pub fn rust_reportable(o: &Value) -> bool {
    matches!(
        o.get("result").and_then(Value::as_str),
        Some("failed" | "merged" | "queued")
    )
}

/// TS `checkNamesForBody` — 이름마다 코드 스팬, 멘션·토큰 글자는 비슷한 글자로.
pub fn check_names_for_body(names: &[String]) -> String {
    names
        .iter()
        .map(|n| {
            format!(
                "`{}`",
                n.replace('`', "'")
                    .replace('@', "＠")
                    .replace('<', "‹")
                    .replace('>', "›")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// TS `checkNamesText`.
pub fn check_names_text(names: &[String]) -> String {
    names
        .join(", ")
        .replace('@', "＠")
        .replace('<', "‹")
        .replace('>', "›")
}

/// TS `grewAfterApproval` — CI 무시 승인인데 래퍼가 다시 읽은 무시 목록에 승인 때 없던 이름이 있다.
pub fn grew_after_approval(ci_override: bool, ignored: &[String], approved: &[String]) -> bool {
    ci_override && ignored.iter().any(|n| !approved.contains(n))
}

/// TS `ignoredTail`.
fn ignored_tail(ci_override: bool, ignored: &[String], grew: bool) -> String {
    let mut t = String::new();
    if ci_override {
        t.push_str(" · CI 실패 무시 승인");
    }
    if !ignored.is_empty() {
        t.push_str(&format!(" · 무시: {}", check_names_for_body(ignored)));
    }
    if grew {
        t.push_str(" (승인 뒤 늘어남)");
    }
    t
}

/// TS `tailVariant`.
fn tail_variant(ci_override: bool, ignored: &[String], grew: bool) -> Option<&'static str> {
    if ignored.is_empty() {
        None
    } else if !ci_override {
        Some("Ignoring")
    } else if grew {
        Some("CiOverrideGrew")
    } else {
        Some("CiOverride")
    }
}

const APPROVAL_GH_SQL: &str = "select gh_user is null from merge_approval where id = $1::uuid";

const HANDLE_SQL: &str = "select handle from account where id = $1::uuid";

/// TS `merged` 줄(무시한 체크 0개) — `failed_line` 의 meta 를 고쳐 쓴다.
#[allow(clippy::too_many_arguments)]
pub fn merged_line(
    repo: &str,
    number: i64,
    head_sha: &str,
    merge_sha: Option<&str>,
    error: Option<&str>,
    granter: Option<(&str, &str)>,
    granter_id: Option<&str>,
    via_approval: bool,
    ci_override: bool,
    no_pr_checks: bool,
    chain_root_id: Option<&str>,
    ignored: &[String],
    grew: bool,
) -> (String, Map<String, Value>) {
    let (_, mut meta) = failed_line(
        repo,
        number,
        head_sha,
        merge_sha,
        error,
        granter_id,
        via_approval,
        ci_override,
        chain_root_id,
    );
    let sha: String = merge_sha.unwrap_or(head_sha).chars().take(9).collect();
    let tail = ignored_tail(ci_override, ignored, grew);
    let mut body = format!("🔀 {repo}#{number} 머지됨 · {sha}");
    if let Some((_, h)) = granter {
        body.push_str(&format!(" · 권한: {h}"));
    }
    body.push_str(&tail);
    body.push_str(" (래퍼 보고)");
    if let Some(Value::Object(m)) = meta.get_mut("merge") {
        m.insert("result".into(), json!("merged"));
        if !ignored.is_empty() {
            m.insert("ignoredChecks".into(), json!(ignored));
        }
        if grew {
            m.insert("grewAfterApproval".into(), json!(true));
        }
        if no_pr_checks {
            m.insert("noPrChecks".into(), json!(true));
        }
    }
    meta.remove("i18n");
    let clip = |s: &str| super::api_results::js_slice(s, 200);
    if tail.is_empty() {
        let i18n = match granter {
            Some((id, _)) => json!({ "key": "system.merge.mergedGranted", "args": {
                "repo": clip(repo), "number": number, "sha": sha, "granterId": clip(id) } }),
            None => json!({ "key": "system.merge.merged", "args": {
                "repo": clip(repo), "number": number, "sha": sha } }),
        };
        meta.insert("i18n".into(), i18n);
    } else if let (Some(v), Some((id, _))) = (tail_variant(ci_override, ignored, grew), granter) {
        meta.insert(
            "i18n".into(),
            json!({ "key": format!("system.merge.merged{v}"), "args": {
                "repo": clip(repo), "number": number, "sha": sha, "granterId": clip(id),
                "checks": clip(&check_names_text(ignored)) } }),
        );
    }
    (body, meta)
}

/// TS `queued` 줄(무시한 체크 0개) — `merged_line` 의 meta 를 고쳐 쓴다.
#[allow(clippy::too_many_arguments)]
pub fn queued_line(
    repo: &str,
    number: i64,
    head_sha: &str,
    merge_sha: Option<&str>,
    error: Option<&str>,
    granter: Option<(&str, &str)>,
    granter_id: Option<&str>,
    via_approval: bool,
    ci_override: bool,
    no_pr_checks: bool,
    chain_root_id: Option<&str>,
    ignored: &[String],
    grew: bool,
) -> (String, Map<String, Value>) {
    let (_, mut meta) = merged_line(
        repo,
        number,
        head_sha,
        merge_sha,
        error,
        granter,
        granter_id,
        via_approval,
        ci_override,
        no_pr_checks,
        chain_root_id,
        ignored,
        grew,
    );
    let head: String = head_sha.chars().take(9).collect();
    let tail = ignored_tail(ci_override, ignored, grew);
    let mut body = format!("📥 {repo}#{number} 머지 큐에 넣음 · head {head}");
    if let Some((_, h)) = granter {
        body.push_str(&format!(" · 권한: {h}"));
    }
    body.push_str(&tail);
    body.push_str(" (래퍼 보고)");
    if let Some(Value::Object(m)) = meta.get_mut("merge") {
        m.insert("result".into(), json!("queued"));
    }
    meta.remove("i18n");
    let clip = |s: &str| super::api_results::js_slice(s, 200);
    if let (false, Some(v), Some((id, _))) = (
        tail.is_empty(),
        tail_variant(ci_override, ignored, grew),
        granter,
    ) {
        meta.insert(
            "i18n".into(),
            json!({ "key": format!("system.merge.queued{v}"), "args": {
                "repo": clip(repo), "number": number, "head": head, "granterId": clip(id),
                "checks": clip(&check_names_text(ignored)) } }),
        );
    }
    if tail.is_empty() {
        let i18n = match granter {
            Some((id, _)) => json!({ "key": "system.merge.queuedGranted", "args": {
                "repo": clip(repo), "number": number, "head": head, "granterId": clip(id) } }),
            None => json!({ "key": "system.merge.queued", "args": {
                "repo": clip(repo), "number": number, "head": head } }),
        };
        meta.insert("i18n".into(), i18n);
    }
    (body, meta)
}

/// TS `failed` 줄 — 본문과 `meta`(i18n 은 CI 무시 승인 꼬리가 없을 때만).
#[allow(clippy::too_many_arguments)]
pub fn failed_line(
    repo: &str,
    number: i64,
    head_sha: &str,
    merge_sha: Option<&str>,
    error: Option<&str>,
    granter_id: Option<&str>,
    via_approval: bool,
    ci_override: bool,
    chain_root_id: Option<&str>,
) -> (String, Map<String, Value>) {
    let head: String = head_sha.chars().take(9).collect();
    let body = format!("⛔ {repo}#{number} 머지 실패 · head {head} (래퍼 보고)");
    let mut merge = Map::new();
    merge.insert("repo".into(), json!(repo));
    merge.insert("number".into(), json!(number));
    merge.insert("headSha".into(), json!(head_sha));
    merge.insert("mergeSha".into(), json!(merge_sha));
    merge.insert("result".into(), json!("failed"));
    merge.insert("grantedBy".into(), json!(granter_id));
    merge.insert("viaApproval".into(), json!(via_approval));
    merge.insert(
        "error".into(),
        json!(error.map(|e| super::api_results::js_slice(e, 1000))),
    );
    if ci_override {
        merge.insert("ciOverride".into(), json!(true));
    }
    if let Some(c) = chain_root_id {
        merge.insert("chainRootId".into(), json!(c));
    }
    let mut meta = Map::new();
    meta.insert("merge".into(), Value::Object(merge));
    if !ci_override {
        meta.insert(
            "i18n".into(),
            json!({ "key": "system.merge.failed", "args": {
                "repo": super::api_results::js_slice(repo, 200), "number": number, "head": head } }),
        );
    }
    (body, meta)
}

/// 위임 v2 스위치가 꺼졌다고 확실한가(값이 없으면 모른다 → TS) — 그러면 `queued` 보고는 감시 없이 줄·감사뿐이다.
fn queued_without_watch() -> bool {
    super::msg_post::delegation_v2(std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref())
        == Some(false)
}

enum Report {
    Refused(&'static str),
    ToTs,
    Posted(String, Option<String>),
}

/// TS `sanitizeCheckNames` — 제어·서식 문자를 빼고 다듬어 80자(UTF-16)로 자르고, 겹침 없이 20개까지.
pub fn sanitize_check_names(names: Option<&Value>) -> Vec<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"[\p{Cc}\p{Cf}\x{2028}\x{2029}]").unwrap());
    let mut out: Vec<String> = Vec::new();
    let Some(arr) = names.and_then(Value::as_array) else {
        return out;
    };
    for n in arr {
        let Some(n) = n.as_str() else { continue };
        let clean = re.replace_all(n, "");
        let clean = super::api_results::js_slice(clean.trim(), 80)
            .trim()
            .to_owned();
        if !clean.is_empty() && !out.contains(&clean) {
            out.push(clean);
        }
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// TS `recordCiDenial` 의 다시 쓰기(같은 head 의 안 쓴 CI 거절 기록).
const CI_REUSE_SQL: &str = "update merge_denial set lease_id = $7::uuid, failed_checks = $9 \
      where id = (select id from merge_denial \
                   where agent_id = $1::uuid and scope = $2 and channel_id = $3::uuid and thread_root_id = $4::uuid and pr_number = $5::bigint and head_sha = $6 \
                     and used_at is null and obsoleted_at is null and expires_at > $8::timestamptz and reason = 'ci_not_green' \
                   order by created_at desc limit 1) \
      returning id::text";

/// TS `obsoleteOtherHeads`(ci = true).
const CI_OBSOLETE_SQL: &str = "update merge_denial set obsoleted_at = $7::timestamptz \
      where agent_id = $1::uuid and scope = $2 and channel_id = $3::uuid and thread_root_id = $4::uuid and pr_number = $5::bigint and head_sha <> $6 \
        and used_at is null and obsoleted_at is null \
        and (reason = 'ci_not_green') = true";

const CI_RECENT_SQL: &str = "select count(*)::int from merge_denial where agent_id = $1::uuid \
      and created_at > $2::timestamptz - interval '24 hours'";

const CI_INSERT_SQL: &str = "insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at, reason, failed_checks) \
     values ($1::uuid, $2, $3::bigint, $4, $5::uuid, $6::uuid, $7::uuid, $8::timestamptz + interval '24 hours', 'ci_not_green', $9) returning id::text";

/// TS `MERGE_DENIAL_DAILY_CAP`.
const MERGE_DENIAL_DAILY_CAP: i32 = 20;

#[allow(clippy::too_many_arguments)]
async fn record_ci_denial(
    w: &sqlx::PgPool,
    agent: &str,
    scope: &str,
    channel: &str,
    thread_root: &str,
    lease_id: &str,
    number: i64,
    head_sha: &str,
    checks: &[String],
    now: &str,
) -> sqlx::Result<Option<String>> {
    let reused: Option<String> = sqlx::query_scalar(CI_REUSE_SQL)
        .bind(agent)
        .bind(scope)
        .bind(channel)
        .bind(thread_root)
        .bind(number)
        .bind(head_sha)
        .bind(lease_id)
        .bind(now)
        .bind(checks)
        .fetch_optional(w)
        .await?;
    if reused.is_some() {
        return Ok(reused);
    }
    sqlx::query(CI_OBSOLETE_SQL)
        .bind(agent)
        .bind(scope)
        .bind(channel)
        .bind(thread_root)
        .bind(number)
        .bind(head_sha)
        .bind(now)
        .execute(w)
        .await?;
    let recent: i32 = sqlx::query_scalar(CI_RECENT_SQL)
        .bind(agent)
        .bind(now)
        .fetch_one(w)
        .await?;
    if recent >= MERGE_DENIAL_DAILY_CAP {
        return Ok(None);
    }
    let id: String = sqlx::query_scalar(CI_INSERT_SQL)
        .bind(agent)
        .bind(scope)
        .bind(number)
        .bind(head_sha)
        .bind(channel)
        .bind(thread_root)
        .bind(lease_id)
        .bind(now)
        .bind(checks)
        .fetch_one(w)
        .await?;
    Ok(Some(id))
}

const GH_CARD_SQL: &str = "update message m \
        set meta = jsonb_set(m.meta, '{permissionRequest}', (m.meta->'permissionRequest') || jsonb_build_object('ghUserUsed', $2::text)) \
       from permission_request r join merge_approval a on a.denial_id = r.denial_id \
      where a.id = $1::uuid and a.gh_user is null and r.status = 'approved_once' and m.id = r.card_message_id \
        and m.deleted_at is null and m.meta ? 'permissionRequest' \
      returning m.id::text";

const GH_MIRROR_SQL: &str = "update message \
          set meta = jsonb_set(meta, '{permissionMirror}', (meta->'permissionMirror') || jsonb_build_object('ghUserUsed', $2::text)) \
        where meta->'ask'->>'mirrorOf' = $1 and deleted_at is null and meta ? 'permissionMirror' \
          and coalesce((meta->'permissionMirror'->>'neutral')::boolean, false) = false \
        returning id::text";

/// TS `noteOnceGhUserUsed` — 카드와 중립 아닌 거울에 고른 gh 이름을 적고 `message.updated` 를 낸다(한 tx).
async fn note_once_gh_user_used(
    w: &sqlx::PgPool,
    approval_id: &str,
    gh_user_used: &str,
) -> sqlx::Result<()> {
    let mut tx = w.begin().await?;
    let cards: Vec<String> = sqlx::query_scalar(GH_CARD_SQL)
        .bind(approval_id)
        .bind(gh_user_used)
        .fetch_all(&mut *tx)
        .await?;
    for card in &cards {
        let mirrors: Vec<String> = sqlx::query_scalar(GH_MIRROR_SQL)
            .bind(card)
            .bind(gh_user_used)
            .fetch_all(&mut *tx)
            .await?;
        for id in std::iter::once(card).chain(mirrors.iter()) {
            if let Some(row) = super::msg_read::message_by_id(&mut *tx, id).await? {
                let message: Value =
                    serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
                if let Some(channel) = message.get("channelId").and_then(Value::as_str) {
                    let audience = super::audience::audience_on(&mut tx, channel)
                        .await?
                        .to_json();
                    crate::write::emit_event(
                        &mut tx,
                        &json!({ "type": "message.updated", "message": message, "audience": audience }),
                    )
                    .await?;
                }
            }
        }
    }
    tx.commit().await
}

/// TS `reportMerge` 의 `failed`(CI 거절 아님) 갈래 — 관문부터 줄·감사까지.
async fn report_failed(
    st: &super::msg_post::PostState,
    agent: &str,
    operator: &str,
    o: &Value,
) -> sqlx::Result<Report> {
    use super::merge_approval_peek as pk;
    use super::msg_post::{Origin, Outcome, PostBody, channel_is_dm, post_in_tx};
    let w = &st.write;
    let g = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
    // `queued` 는 TS `autoWatchOnQueued` 가 위임 v2 스위치가 켜졌을 때 감시를 건다 — 꺼졌다고 **확실할** 때만 Rust 가 적는다.
    if g("result").as_deref() == Some("queued") && !queued_without_watch() {
        return Ok(Report::ToTs);
    }
    let Some(number) = pk::positive_int(o.get("number").unwrap_or(&Value::Null)) else {
        return Ok(Report::ToTs);
    };
    // TS 의 `(detail->>'number')::int = $3` — int4 를 넘는 PR 번호는 TS 쿼리 오류 갈래다. TS 에 맡긴다.
    if number > i64::from(i32::MAX) {
        return Ok(Report::ToTs);
    }
    let now = pk::db_now(w).await?;
    type Lease = (String, String, Option<String>, String, String, bool);
    let lease: Option<Lease> = sqlx::query_as(POST_LEASE_SQL)
        .bind(g("leaseId").unwrap_or_default())
        .bind(pk::sha256_hex(&g("token").unwrap_or_default()))
        .bind(&now)
        .fetch_optional(w)
        .await?;
    let (lease_id, channel, thread_root): (String, String, String) = match lease {
        Some((id, a, op, c, t, expired))
            if a == agent && op.as_deref() == Some(operator) && !expired =>
        {
            (id, c, t)
        }
        _ => return Ok(Report::Refused("lease_invalid")),
    };
    let Some(scope) = pk::repo_scope(&g("repo").unwrap_or_default()) else {
        return Ok(Report::Refused("bad_repo"));
    };
    let repo = scope["repo:".len()..].to_owned();
    let head_sha = g("headSha").unwrap_or_default();
    let trail: Vec<(String, Option<Value>)> = sqlx::query_as(POST_TRAIL_SQL)
        .bind(&scope)
        .bind(&lease_id)
        .bind(number)
        .bind(&head_sha)
        .fetch_all(w)
        .await?;
    if trail.iter().any(|(a, _)| a != "repo.merge.checked") {
        return Ok(Report::Refused("already_reported"));
    }
    if trail.is_empty() {
        return Ok(Report::Refused("not_checked"));
    }
    let chain_root_id = trail
        .iter()
        .find_map(|(_, v)| v.as_ref().filter(|v| js_truthy(v)))
        .and_then(|v| v.get("rootId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let owner = repo.split_once('/').map_or(repo.as_str(), |(o, _)| o);
    static GRANT_SQL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let grant_sql: &'static str = GRANT_SQL.get_or_init(|| {
        format!(
            "select \"grantedBy\"::text from ({}) g",
            super::channels::frag("repo_grant_for")
        )
    });
    let grant_by: Option<Option<String>> = sqlx::query_scalar(grant_sql)
        .bind(agent)
        .bind(vec![scope.clone(), format!("repo:{owner}/*")])
        .bind(&scope)
        .bind(None::<String>)
        .bind("repo.merge")
        .fetch_optional(w)
        .await?;
    let used: Option<(String, String, bool, Vec<String>)> = sqlx::query_as(USED_APPROVAL_SQL)
        .bind(&lease_id)
        .bind(&scope)
        .bind(number)
        .bind(&head_sha)
        .fetch_optional(w)
        .await?;
    let approved_by = used.as_ref().map(|u| u.1.clone());
    let ci_override = used.as_ref().is_some_and(|u| u.2);
    let granter_id = approved_by.clone().or(grant_by.flatten());
    let merge_sha = g("mergeSha");
    let result = g("result");
    let merged = result.as_deref() == Some("merged");
    let queued = result.as_deref() == Some("queued");
    let no_pr_checks = (merged || queued) && o.get("noPrChecks") == Some(&Value::Bool(true));
    let ignored = if merged || queued {
        sanitize_check_names(o.get("ignoredChecks"))
    } else {
        Vec::new()
    };
    let grew = grew_after_approval(
        ci_override,
        &ignored,
        used.as_ref().map_or(&[][..], |u| &u.3[..]),
    );
    let mut gh_memo: Option<(String, String)> = None;
    let (body, mut meta) = if merged || queued {
        // 계정을 비운 승인 + 고른 gh 이름이면 감사에 남기고 `noteOnceGhUserUsed`(카드·거울 고치기)를 한다.
        let gh_used = g("ghUserUsed").filter(|u| gh_user_ok(u));
        if let (Some((id, _, _, _)), Some(u)) = (&used, &gh_used) {
            let blank: Option<bool> = sqlx::query_scalar(APPROVAL_GH_SQL)
                .bind(id)
                .fetch_optional(w)
                .await?;
            match blank {
                Some(true) => gh_memo = Some((id.clone(), u.clone())),
                Some(false) => {}
                None => return Ok(Report::ToTs),
            }
        }
        let handle: Option<String> = match &granter_id {
            Some(id) => {
                sqlx::query_scalar(HANDLE_SQL)
                    .bind(id)
                    .fetch_optional(w)
                    .await?
            }
            None => None,
        };
        let granter = granter_id.as_deref().zip(handle.as_deref());
        let line = if merged { merged_line } else { queued_line };
        line(
            &repo,
            number,
            &head_sha,
            merge_sha.as_deref(),
            g("error").as_deref(),
            granter,
            granter_id.as_deref(),
            approved_by.is_some(),
            ci_override,
            no_pr_checks,
            chain_root_id.as_deref(),
            &ignored,
            grew,
        )
    } else {
        failed_line(
            &repo,
            number,
            &head_sha,
            merge_sha.as_deref(),
            g("error").as_deref(),
            granter_id.as_deref(),
            approved_by.is_some(),
            ci_override,
            chain_root_id.as_deref(),
        )
    };
    if let (Some((_, u)), Some(Value::Object(m))) = (&gh_memo, meta.get_mut("merge")) {
        m.insert("ghUserUsed".into(), json!(u));
        m.insert("ghUserChosenBy".into(), json!("operator"));
    }
    let audience = super::audience::audience_for(w, &channel).await?.to_json();
    let is_dm = channel_is_dm(w, &channel).await?;
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: Some(thread_root.clone()),
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        ..Origin::default()
    };
    let row = match post_in_tx(
        st, &channel, agent, true, &input, None, &audience, is_dm, &origin,
    )
    .await?
    {
        Outcome::Posted { row, .. } => row,
        Outcome::ToTs => return Ok(Report::ToTs),
        _ => return Ok(Report::Refused("post_failed")),
    };
    let message: Value = serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
    let message_id = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut detail = json!({
        "number": number, "headSha": head_sha, "mergeSha": merge_sha, "operatorId": operator,
        "leaseId": lease_id, "messageId": message_id,
    });
    if let Some((id, by, _, _)) = &used {
        detail["approvalId"] = json!(id);
        detail["approvedBy"] = json!(by);
        detail["ciOverride"] = json!(ci_override);
    }
    if !ignored.is_empty() {
        detail["ignoredChecks"] = json!(ignored);
    }
    if grew {
        detail["grewAfterApproval"] = json!(true);
    }
    if let Some((_, u)) = &gh_memo {
        detail["ghUserUsed"] = json!(u);
        detail["ghUserChosenBy"] = json!("operator");
    }
    if no_pr_checks {
        detail["noPrChecks"] = json!(true);
    }
    let ci_checks = (!merged && !queued && is_ci_refusal(o.get("ciRefusal")))
        .then(|| sanitize_check_names(o.get("ciRefusal").and_then(|c| c.get("checks"))));
    let mut denial_id = None;
    if let Some(checks) = &ci_checks {
        denial_id = record_ci_denial(
            w,
            agent,
            &scope,
            &channel,
            &thread_root,
            &lease_id,
            number,
            &head_sha,
            checks,
            &now,
        )
        .await?;
        let c = &o["ciRefusal"];
        detail["ciRefusal"] = json!({
            "code": c.get("code").cloned().unwrap_or(Value::Null),
            "mergeState": c.get("mergeState").cloned().unwrap_or(Value::Null),
            "checks": checks,
        });
        detail["denialId"] = json!(denial_id);
    }
    crate::write::record_audit(
        w,
        crate::write::AuditEntry {
            action: if merged {
                "repo.merge.merged"
            } else if queued {
                "repo.merge.queued"
            } else {
                "repo.merge.failed"
            },
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&scope),
            ip: None,
            detail,
        },
    )
    .await;
    // n6: 계정을 비운 1회 승인이면 그 권한 카드(와 거울)에 고른 이름을 적는다. 실패해도 보고는 남는다.
    if let Some((id, u)) = &gh_memo {
        let _ = note_once_gh_user_used(w, id, u).await;
    }
    // Q3-a: 통과한 판정 뒤의 `merged` 보고면 그 PR 의 기다리는 머지 카드를 모든 에이전트에 걸쳐 닫는다. 실패해도 보고는 남는다.
    if merged {
        let _ = super::merge_closed::obsolete_merge_cards(
            w,
            &scope,
            number,
            "merged",
            agent,
            &now,
            None,
            json!({}),
        )
        .await;
    }
    Ok(Report::Posted(message_id, denial_id))
}

/// N1 관문 전의 거절(`lease_invalid`·`bad_repo`·`already_reported`·`not_checked`) — 쓰기 전 읽기만이라 TS 와 같은 순서로 답한다.
/// `None` 이면 받을 보고 — TS 가 줄·거절 기록·감사를 쓴다.
async fn results_refusal(
    pool: &sqlx::PgPool,
    agent: &str,
    operator: &str,
    o: &Value,
) -> sqlx::Result<Option<&'static str>> {
    let g = |k: &str| {
        o.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let number = super::merge_approval_peek::positive_int(o.get("number").unwrap_or(&Value::Null));
    let now = super::merge_approval_peek::db_now(pool).await?;
    let lease: Option<(String, String, Option<String>, bool)> = sqlx::query_as(RESULTS_LEASE_SQL)
        .bind(g("leaseId"))
        .bind(super::merge_approval_peek::sha256_hex(&g("token")))
        .bind(&now)
        .fetch_optional(pool)
        .await?;
    let lease_id = match lease {
        Some((id, a, op, expired)) if a == agent && op.as_deref() == Some(operator) && !expired => {
            id
        }
        _ => return Ok(Some("lease_invalid")),
    };
    let Some(scope) = super::merge_approval_peek::repo_scope(&g("repo")) else {
        return Ok(Some("bad_repo"));
    };
    let Some(number) = number else {
        // i64 를 넘는 수 — TS 는 쿼리 오류. TS 에 맡긴다.
        return Ok(None);
    };
    let trail: Vec<String> = sqlx::query_scalar(TRAIL_SQL)
        .bind(&scope)
        .bind(&lease_id)
        .bind(number)
        .bind(g("headSha"))
        .fetch_all(pool)
        .await?;
    if trail.iter().any(|a| a != "repo.merge.checked") {
        return Ok(Some("already_reported"));
    }
    if trail.is_empty() {
        return Ok(Some("not_checked"));
    }
    Ok(None)
}

pub async fn results_route(
    State(st): State<Arc<ResultsState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    if !results_shape_ok(parsed.as_ref()) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_RESULT);
    }
    if let (Some(post), Some(op), Some(body)) = (
        st.post.as_ref(),
        auth.operator.as_ref().map(|o| o.id.as_str()),
        parsed.as_ref(),
    ) && rust_reportable(body)
    {
        match report_failed(post, &me.id, op, body).await {
            Ok(Report::Refused(code)) => {
                let status = match code {
                    "bad_repo" => StatusCode::BAD_REQUEST,
                    "lease_invalid" => StatusCode::FORBIDDEN,
                    _ => StatusCode::CONFLICT,
                };
                return json_err(status, code, &format!("merge result not recorded: {code}"));
            }
            Ok(Report::Posted(id, denial)) => {
                use axum::response::IntoResponse;
                let mut out = json!({ "messageId": id });
                if let Some(d) = denial {
                    out["denialId"] = json!(d);
                }
                return (
                    StatusCode::CREATED,
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "application/json; charset=utf-8",
                    )],
                    out.to_string(),
                )
                    .into_response();
            }
            Ok(Report::ToTs) => {}
            Err(e) => return crate::directory::internal(e),
        }
    }
    if let (Some(pool), Some(op), Some(body)) = (
        st.read.as_ref(),
        auth.operator.as_ref().map(|o| o.id.as_str()),
        parsed.as_ref(),
    ) {
        match results_refusal(pool, &me.id, op, body).await {
            Ok(Some(code)) => {
                let status = match code {
                    "bad_repo" => StatusCode::BAD_REQUEST,
                    "lease_invalid" => StatusCode::FORBIDDEN,
                    _ => StatusCode::CONFLICT,
                };
                return json_err(status, code, &format!("merge result not recorded: {code}"));
            }
            Ok(None) => {}
            Err(e) => return crate::directory::internal(e),
        }
    }
    super::msg_post::to_ts(st.up.clone(), peer, parts, bytes).await
}

/// `merge-checks` 의 이른 거절(`lease_invalid`·`bad_repo`)을 Rust 가 답할 때 쓰기 풀에 있어야 하는 권한 — 임대 정본 문장
/// (`grant_read_lease`)이 읽는 표와 `repo.merge.denied` 감사 쓰기. 하나라도 없으면 모양이 맞는 요청은 전부 TS 로 넘긴다.
pub const MERGE_CHECKS_DENY_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "SELECT"),
    ("message", "SELECT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("audit_log", "INSERT"),
];

pub struct ChecksState {
    pub up: Upstream,
    /// 이른 거절 경로 — 쓰기 풀에 [`MERGE_CHECKS_DENY_PRIVILEGES`] 가 다 있을 때만.
    pub deny: Option<sqlx::PgPool>,
    /// 흔한 허락 길 — 쓰기 풀에 [`MERGE_CHECKS_ALLOW_PRIVILEGES`] 까지 다 있을 때만.
    pub allow: Option<sqlx::PgPool>,
}

/// 흔한 허락 길(사슬 판정·위임 없음·1회 승인 없음·grant 있음·사람 턴 또는 `allow_agent_cause`)에 더 있어야 하는 권한.
pub const MERGE_CHECKS_ALLOW_PRIVILEGES: &[(&str, &str)] =
    &[("account_grant", "SELECT"), ("merge_approval", "SELECT")];

/// 1회 승인이 있는지만 본다(TS 는 같은 조건으로 소모한다). 있으면 TS 로 넘긴다.
const APPROVAL_EXISTS_SQL: &str = "select exists (select 1 from merge_approval \
     where agent_id = $1::uuid and scope = $2 and pr_number = $3 and head_sha = $4 \
       and channel_id = $5::uuid and thread_root_id = $6::uuid and used_at is null and expires_at > $7::timestamptz \
       and (not ci_override or $8::boolean))";

/// TS `shadowOrigin` 의 문장.
const SHADOW_ORIGIN_SQL: &str = "select m.kind, m.meta ? 'automation', a.kind, \
            m.mandate_id is not null, \
            exists (select 1 from message r where r.id = coalesce($2::uuid, m.thread_root_id, m.id) and r.mandate_id is not null) \
       from (select 1) one \
       left join message m on m.id = $1::uuid \
       left join account a on a.id = m.author_id";

/// TS `shadowOrigin` 의 `causeKind` 고르기.
pub fn shadow_cause_kind(
    msg_kind: Option<&str>,
    automation: Option<bool>,
    author_kind: Option<&str>,
) -> &'static str {
    match msg_kind {
        None | Some("") => "unknown",
        Some("wake") => "wake",
        Some("system") => "system",
        _ if automation == Some(true) => "automation",
        _ => match author_kind {
            Some("human") => "human",
            Some("agent") => "agent",
            _ => "unknown",
        },
    }
}

/// 사슬 판정이 grant 로 통과할 때 TS 가 남기는 `repo.merge.checked` detail(사슬 없이).
pub fn checked_detail(
    o: &Value,
    operator: &str,
    lease: &super::lease_read::LeaseRow,
    granted_by: &str,
    grant_scope: &str,
) -> Value {
    let by_human = lease.cause_by_human();
    json!({
        "number": o.get("number").cloned().unwrap_or(Value::Null),
        "headSha": o.get("headSha").cloned().unwrap_or(Value::Null),
        "operatorId": operator,
        "leaseId": lease.id,
        "grantedBy": granted_by,
        "grantScope": grant_scope,
        "causeByHuman": by_human,
        "viaAskAnswer": by_human && lease.cause_kind.as_deref() != Some("human"),
    })
}

/// 위임 스위치가 꺼졌고 임대에 위임장이 없을 때 TS `shadowMandate` 의 `mandate.shadow` detail(`findLine` 은 위임장 없이 null).
pub fn shadow_detail_no_mandate(
    agent: &str,
    scope: &str,
    lease_id: &str,
    origin: (&str, bool, bool),
) -> Value {
    json!({
        "enforced": "chain",
        "chainVerdict": "allowed",
        "mandateVerdict": "denied",
        "mandateId": null,
        "agentId": agent,
        "repo": scope,
        "leaseId": lease_id,
        "lineId": null,
        "lineVia": null,
        "causeKind": origin.0,
        "rootHasKey": origin.1,
        "causeHasKey": origin.2,
    })
}

async fn shadow_origin(
    pool: &sqlx::PgPool,
    l: &super::lease_read::LeaseRow,
) -> sqlx::Result<(&'static str, bool, bool)> {
    type Row = (
        Option<String>,
        Option<bool>,
        Option<String>,
        Option<bool>,
        Option<bool>,
    );
    let r: Option<Row> = sqlx::query_as(SHADOW_ORIGIN_SQL)
        .bind(l.cause_message_id.as_deref())
        .bind(l.thread_root_id.as_deref())
        .fetch_optional(pool)
        .await?;
    Ok(match r {
        Some((mk, auto, ak, cause_key, root_key)) => (
            shadow_cause_kind(mk.as_deref(), auto, ak.as_deref()),
            root_key == Some(true),
            cause_key == Some(true),
        ),
        None => ("unknown", false, false),
    })
}

/// 흔한 허락 길. `None` 이면 아무것도 쓰지 않았다 — TS 로 넘긴다.
async fn checks_allow(
    pool: &sqlx::PgPool,
    agent: &str,
    operator: &str,
    o: &Value,
    lease: &super::lease_read::LeaseRow,
    now: &str,
) -> sqlx::Result<Option<Response>> {
    let g = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default();
    if super::lease_read::mandate_enforced_env() || lease.mandate_id.is_some() {
        return Ok(None);
    }
    let (Some(scope), Some(number), Some(channel), Some(root)) = (
        super::merge_approval_peek::repo_scope(g("repo")),
        o.get("number").and_then(Value::as_i64),
        lease.channel_id.as_deref(),
        lease.thread_root_id.as_deref(),
    ) else {
        return Ok(None);
    };
    let by_human = lease.cause_by_human();
    let approval: bool = sqlx::query_scalar(APPROVAL_EXISTS_SQL)
        .bind(agent)
        .bind(&scope)
        .bind(number)
        .bind(g("headSha"))
        .bind(channel)
        .bind(root)
        .bind(now)
        .bind(by_human)
        .fetch_one(pool)
        .await?;
    if approval {
        return Ok(None);
    }
    static GRANT_SQL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let grant_sql: &'static str = GRANT_SQL.get_or_init(|| {
        format!(
            "select \"grantedBy\"::text, scope, \
             to_char(\"grantedAt\" at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \"allowAgentCause\" from ({}) g",
            super::channels::frag("repo_grant_for")
        )
    });
    let owner = scope["repo:".len()..]
        .split_once('/')
        .map_or("", |(o, _)| o);
    type GrantRow = (Option<String>, String, Option<String>, Option<bool>);
    let grant: Option<GrantRow> = sqlx::query_as(grant_sql)
        .bind(agent)
        .bind(vec![scope.clone(), format!("repo:{owner}/*")])
        .bind(&scope)
        .bind(channel)
        .bind("repo.merge")
        .fetch_optional(pool)
        .await?;
    let Some((Some(granted_by), grant_scope, granted_at, allow_agent)) = grant else {
        return Ok(None);
    };
    if !by_human && allow_agent != Some(true) {
        // 사슬(`causeChainRoot`)과 `cause_not_human` 카드는 TS 몫.
        return Ok(None);
    }
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "repo.merge.checked",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&scope),
            ip: None,
            detail: checked_detail(o, operator, lease, &granted_by, &grant_scope),
        },
    )
    .await;
    // 그림자 — 실패해도 판정은 그대로 나간다(출처 조회가 실패하면 unknown).
    let origin = shadow_origin(pool, lease)
        .await
        .unwrap_or(("unknown", false, false));
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "mandate.shadow",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(&scope),
            ip: None,
            detail: shadow_detail_no_mandate(agent, &scope, &lease.id, origin),
        },
    )
    .await;
    Ok(Some(super::grant_reads::ok_no_store(&json!({
        "allowed": true,
        "repo": &scope["repo:".len()..],
        "grantedBy": granted_by,
        "grantedAt": granted_at,
        "causeByHuman": by_human,
        "channelId": lease.channel_id,
        "threadRootId": lease.thread_root_id,
    }))))
}

/// TS `checkMergeByChain` 의 첫 두 거절 중 **그림자 감사(`shadowMandate`)가 아무것도 남기지 않는** 갈래만 고른다.
/// - 임대가 없거나 에이전트·오퍼레이터가 다르다 → `lease_invalid`(그림자는 같은 조건에서 바로 돌아간다).
/// - 임대는 맞고 저장소 모양이 틀렸다 → 끝남·만료면 `lease_invalid`, 아니면 `bad_repo`(그림자는 `repoScope` 가 없으면 돌아간다).
///
/// `None` 이면 TS 몫이다: 끝나거나 만료된 임대 + 맞는 저장소(그림자가 `findLine` 을 돈다)와 그 뒤 모든 판정
/// (1회 승인 소모·위임 줄·사슬 판정·`merge_denial`·카드·`repo.merge.checked`).
pub fn early_denial(
    lease: Option<&super::lease_read::LeaseRow>,
    agent: &str,
    operator: &str,
    repo: &str,
) -> Option<&'static str> {
    let l = match lease {
        Some(l) if l.agent_id == agent && l.operator_id.as_deref() == Some(operator) => l,
        _ => return Some("lease_invalid"),
    };
    if super::merge_approval_peek::repo_scope(repo).is_some() {
        return None;
    }
    Some(if l.expired || l.ended {
        "lease_invalid"
    } else {
        "bad_repo"
    })
}

/// TS `deny` 의 `repo.merge.denied` 감사 `detail` — `leaseId` 는 임대가 통과했을 때(`bad_repo`)만.
pub fn denied_detail(code: &str, o: &Value, operator: &str, lease_id: Option<&str>) -> Value {
    json!({
        "code": code,
        "number": o.get("number").cloned().unwrap_or(Value::Null),
        "headSha": o.get("headSha").cloned().unwrap_or(Value::Null),
        "operatorId": operator,
        "leaseId": lease_id,
    })
}

/// 이른 거절을 감사에 적고 응답한다. `None` 이면 TS 로 넘긴다(아무것도 쓰지 않았다).
async fn checks_early(
    pool: &sqlx::PgPool,
    allow: bool,
    agent: &str,
    operator: &str,
    o: &Value,
) -> sqlx::Result<Option<Response>> {
    let g = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default();
    let now = super::merge_approval_peek::db_now(pool).await?;
    let lease = super::lease_read::read_lease(pool, g("leaseId"), g("token"), &now).await?;
    let Some(code) = early_denial(lease.as_ref(), agent, operator, g("repo")) else {
        return match lease.as_ref() {
            Some(l) if allow && !l.expired && !l.ended => {
                checks_allow(pool, agent, operator, o, l, &now).await
            }
            _ => Ok(None),
        };
    };
    let lease_id = (code == "bad_repo")
        .then(|| lease.as_ref().map(|l| l.id.as_str()))
        .flatten();
    let scope = super::merge_approval_peek::repo_scope(g("repo"));
    crate::write::record_audit(
        pool,
        crate::write::AuditEntry {
            action: "repo.merge.denied",
            actor_id: Some(agent),
            actor_handle: None,
            target: Some(scope.as_deref().unwrap_or(g("repo"))),
            ip: None,
            detail: denied_detail(code, o, operator, lease_id),
        },
    )
    .await;
    let status = if code == "bad_repo" {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::FORBIDDEN
    };
    let mut r = json_err(status, code, &format!("merge not allowed: {code}"));
    r.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(Some(r))
}

pub async fn checks_route(
    State(st): State<Arc<ChecksState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    if !shape_ok(parsed.as_ref()) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    }
    if let (Some(pool), Some(op), Some(o)) = (
        st.deny.as_ref(),
        auth.operator.as_ref().map(|o| o.id.as_str()),
        parsed.as_ref(),
    ) {
        match checks_early(pool, st.allow.is_some(), &me.id, op, o).await {
            Ok(Some(r)) => return r,
            Ok(None) => {}
            Err(e) => return crate::directory::internal(e),
        }
    }
    super::msg_post::to_ts(st.up.clone(), peer, parts, bytes).await
}

pub fn routes(
    up: Upstream,
    checks_deny: Option<sqlx::PgPool>,
    checks_allow: Option<sqlx::PgPool>,
    results_read: Option<sqlx::PgPool>,
    results_post: Option<super::msg_post::PostState>,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<ChecksState>>::new()
        .post("/agent/merge-checks", checks_route)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth.clone(),
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors.clone(),
                crate::cors::layer,
            ))
        })
        .finish();
    let rt = Table::<Arc<ResultsState>>::new()
        .post("/agent/merge-results", results_route)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    let mut http = t.http;
    http.extend(rt.http);
    let mut sockets = t.sockets;
    sockets.extend(rt.sockets);
    crate::route_table::Routes {
        router: t
            .router
            .with_state(Arc::new(ChecksState {
                up: up.clone(),
                deny: checks_deny,
                allow: checks_allow,
            }))
            .merge(rt.router.with_state(Arc::new(ResultsState {
                up,
                read: results_read,
                post: results_post,
            }))),
        http,
        sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lease(agent: &str, op: &str) -> crate::core::lease_read::LeaseRow {
        crate::core::lease_read::LeaseRow {
            id: "L".into(),
            agent_id: agent.into(),
            operator_id: Some(op.into()),
            ..Default::default()
        }
    }

    #[test]
    fn early_denial_like_ts() {
        // 임대 없음·남의 임대 → lease_invalid(그림자는 비어 있다).
        assert_eq!(early_denial(None, "a", "o", "o/r"), Some("lease_invalid"));
        assert_eq!(
            early_denial(Some(&lease("b", "o")), "a", "o", "o/r"),
            Some("lease_invalid")
        );
        assert_eq!(
            early_denial(Some(&lease("a", "x")), "a", "o", "bad"),
            Some("lease_invalid")
        );
        let mut no_op = lease("a", "o");
        no_op.operator_id = None;
        assert_eq!(
            early_denial(Some(&no_op), "a", "o", "o/r"),
            Some("lease_invalid")
        );
        // 맞는 임대 + 틀린 저장소 → bad_repo, 끝남·만료면 lease_invalid.
        assert_eq!(
            early_denial(Some(&lease("a", "o")), "a", "o", "nope"),
            Some("bad_repo")
        );
        let mut ex = lease("a", "o");
        ex.expired = true;
        assert_eq!(
            early_denial(Some(&ex), "a", "o", "nope"),
            Some("lease_invalid")
        );
        let mut en = lease("a", "o");
        en.ended = true;
        assert_eq!(
            early_denial(Some(&en), "a", "o", "nope"),
            Some("lease_invalid")
        );
        // 그림자가 findLine 을 도는 갈래와 판정 본문은 TS 몫.
        assert_eq!(early_denial(Some(&ex), "a", "o", "O/R"), None);
        assert_eq!(
            early_denial(Some(&lease("a", "o")), "a", "o", " Owner/Repo "),
            None
        );
    }

    #[test]
    fn denied_detail_like_ts() {
        let o = json!({ "number": 7, "headSha": "a".repeat(40), "repo": "x" });
        assert_eq!(
            denied_detail("lease_invalid", &o, "op", None),
            json!({ "code": "lease_invalid", "number": 7, "headSha": "a".repeat(40), "operatorId": "op", "leaseId": null })
        );
        assert_eq!(
            denied_detail("bad_repo", &o, "op", Some("L"))["leaseId"],
            json!("L")
        );
    }

    #[test]
    fn deny_privileges_cover_lease_sql() {
        let f = crate::core::channels::frag("grant_read_lease");
        for t in [
            "secret_turn_lease",
            "message",
            "account",
            "agent_config",
            "channel",
            "channel_member",
            "agent_invoker",
        ] {
            assert!(f.contains(t), "{t}");
            assert!(MERGE_CHECKS_DENY_PRIVILEGES.contains(&(t, "SELECT")), "{t}");
        }
        assert!(MERGE_CHECKS_DENY_PRIVILEGES.contains(&("audit_log", "INSERT")));
    }

    #[test]
    fn shadow_origin_like_ts() {
        assert_eq!(shadow_cause_kind(None, None, None), "unknown");
        assert_eq!(
            shadow_cause_kind(Some("wake"), Some(true), Some("human")),
            "wake"
        );
        assert_eq!(shadow_cause_kind(Some("system"), None, None), "system");
        assert_eq!(
            shadow_cause_kind(Some("text"), Some(true), Some("human")),
            "automation"
        );
        assert_eq!(
            shadow_cause_kind(Some("text"), Some(false), Some("human")),
            "human"
        );
        assert_eq!(
            shadow_cause_kind(Some("text"), None, Some("agent")),
            "agent"
        );
        assert_eq!(shadow_cause_kind(Some("text"), None, None), "unknown");
    }

    #[test]
    fn allow_audits_like_ts() {
        let mut l = lease("a", "o");
        l.cause_kind = Some("human".into());
        let o = json!({ "number": 5, "headSha": "b".repeat(40) });
        assert_eq!(
            checked_detail(&o, "o", &l, "g", "repo:x/*"),
            json!({ "number": 5, "headSha": "b".repeat(40), "operatorId": "o", "leaseId": "L", "grantedBy": "g",
                    "grantScope": "repo:x/*", "causeByHuman": true, "viaAskAnswer": false })
        );
        // 자기 카드에 정할 수 있는 사람이 답한 턴 → viaAskAnswer.
        let mut ask = lease("a", "o");
        ask.cause_kind = Some("agent".into());
        ask.cause_ask_author_id = Some("a".into());
        ask.ask_answered_by = Some("h".into());
        ask.ask_answerer_kind = Some("human".into());
        ask.ask_answerer_owns_agent = Some(true);
        assert_eq!(
            checked_detail(&o, "o", &ask, "g", "repo:x/y")["viaAskAnswer"],
            json!(true)
        );
        let d = shadow_detail_no_mandate("a", "repo:x/y", "L", ("human", false, true));
        assert_eq!(d["enforced"], "chain");
        assert_eq!(d["chainVerdict"], "allowed");
        assert_eq!(d["mandateVerdict"], "denied");
        assert_eq!(d["mandateId"], Value::Null);
        assert_eq!(d["lineId"], Value::Null);
        assert_eq!(d["causeHasKey"], true);
        assert_eq!(d["rootHasKey"], false);
        assert!(d.get("viaApproval").is_none());
    }

    #[test]
    fn shape_like_zod() {
        let ok = json!({ "leaseId": "00000000-0000-4000-8000-000000000000", "token": "t", "repo": "o/r", "number": 3, "headSha": "a".repeat(40), "ghUser": "bot-1", "x": 1 });
        assert!(shape_ok(Some(&ok)));
        assert!(!shape_ok(None));
        for (k, v) in [
            ("number", json!(0)),
            ("number", json!(1.5)),
            ("headSha", json!("A".repeat(40))),
            ("repo", json!("ab")),
            ("ghUser", json!("-bad")),
            ("ghUser", json!(null)),
        ] {
            let mut b = ok.clone();
            b[k] = v;
            assert!(!shape_ok(Some(&b)), "{k}");
        }
    }

    #[test]
    fn results_shape_like_zod() {
        let ok = json!({ "leaseId": "00000000-0000-4000-8000-000000000000", "token": "t", "repo": "o/r", "number": 3,
            "headSha": "a".repeat(40), "result": "merged", "mergeSha": null, "error": null,
            "ciRefusal": { "code": "checks_failed", "mergeState": null, "checks": ["ci"] },
            "ignoredChecks": ["x"], "noPrChecks": true, "ghUserUsed": null, "extra": 1 });
        assert!(results_shape_ok(Some(&ok)));
        assert!(!results_shape_ok(None));
        for (k, v) in [
            ("result", json!("done")),
            ("mergeSha", json!("B".repeat(40))),
            ("error", json!("e".repeat(1001))),
            ("ciRefusal", json!({ "code": "c" })),
            ("ignoredChecks", json!(null)),
            ("noPrChecks", json!(null)),
            ("ghUserUsed", json!(1)),
        ] {
            let mut b = ok.clone();
            b[k] = v;
            assert!(!results_shape_ok(Some(&b)), "{k}");
        }
    }

    #[test]
    fn failed_line_like_ts() {
        let h = "a".repeat(40);
        let (body, meta) = failed_line(
            "o/r",
            7,
            &h,
            None,
            Some("boom"),
            Some("g1"),
            false,
            false,
            None,
        );
        assert_eq!(body, "⛔ o/r#7 머지 실패 · head aaaaaaaaa (래퍼 보고)");
        assert_eq!(
            Value::Object(meta),
            json!({ "merge": { "repo": "o/r", "number": 7, "headSha": h, "mergeSha": null, "result": "failed",
                "grantedBy": "g1", "viaApproval": false, "error": "boom" },
                "i18n": { "key": "system.merge.failed", "args": { "repo": "o/r", "number": 7, "head": "aaaaaaaaa" } } })
        );
        let (_, meta) = failed_line(
            "o/r",
            7,
            &h,
            None,
            None,
            Some("a1"),
            true,
            true,
            Some("root"),
        );
        assert!(meta.get("i18n").is_none());
        assert_eq!(meta["merge"]["ciOverride"], json!(true));
        assert_eq!(meta["merge"]["chainRootId"], json!("root"));
        let src = include_str!("../../../../packages/server/src/services/mergeGrants.ts");
        assert!(src.contains(
            "`⛔ ${repo}#${r.number} 머지 실패 · head ${r.headSha.slice(0, 9)} (래퍼 보고)`"
        ));
        assert!(src.contains("systemI18n('system.merge.failed', { repo, number: r.number, head: r.headSha.slice(0, 9) })"));
    }

    #[test]
    fn reportable_only_plain_failed() {
        assert!(rust_reportable(&json!({ "result": "failed" })));
        assert!(rust_reportable(
            &json!({ "result": "failed", "ciRefusal": { "code": "not_mergeable", "mergeState": "DIRTY", "checks": [] } })
        ));
        assert!(rust_reportable(
            &json!({ "result": "failed", "ciRefusal": { "code": "ci_not_green", "checks": [] } })
        ));
        assert!(is_ci_refusal(Some(
            &json!({ "code": "not_mergeable", "mergeState": "UNSTABLE", "checks": [] })
        )));
        assert!(!is_ci_refusal(Some(
            &json!({ "code": "not_mergeable", "mergeState": "DIRTY" })
        )));
        assert!(rust_reportable(&json!({ "result": "merged" })));
        assert!(rust_reportable(&json!({ "result": "queued" })));
        assert!(rust_reportable(
            &json!({ "result": "queued", "ignoredChecks": ["x"] })
        ));
        assert!(!rust_reportable(&json!({ "result": "other" })));
    }

    #[test]
    fn sanitize_check_names_like_ts() {
        assert!(sanitize_check_names(None).is_empty());
        assert!(sanitize_check_names(Some(&json!("x"))).is_empty());
        let long = "a".repeat(100);
        let got = sanitize_check_names(Some(&json!([
            " ci\u{200b} ",
            3,
            "ci",
            "",
            "\u{0007}",
            "l\u{2028}int",
            long
        ])));
        assert_eq!(
            got,
            vec!["ci".to_owned(), "lint".to_owned(), "a".repeat(80)]
        );
        let many: Vec<String> = (0..30).map(|i| format!("c{i}")).collect();
        assert_eq!(sanitize_check_names(Some(&json!(many))).len(), 20);
        let src = include_str!("../../../../packages/server/src/services/mergeDenials.ts");
        assert!(src.contains("n.replace(/[\\p{Cc}\\p{Cf}\\u2028\\u2029]/gu, '').trim().slice(0, CHECK_NAME_MAX).trim()"));
        assert!(src.contains("export const CHECK_NAME_MAX = 80;"));
        assert!(src.contains("export const CHECK_NAMES_MAX = 20;"));
        let g = include_str!("../../../../packages/server/src/services/mergeGrants.ts");
        assert!(g.contains("export const MERGE_DENIAL_DAILY_CAP = 20;"));
        assert!(g.contains("export const MERGE_DENIAL_TTL_MS = 24 * 3_600_000;"));
    }

    #[test]
    fn queued_line_like_ts() {
        let h = "b".repeat(40);
        let (body, meta) = queued_line(
            "o/r",
            7,
            &h,
            None,
            None,
            Some(("g1", "kim")),
            Some("g1"),
            false,
            false,
            true,
            None,
            &[],
            false,
        );
        assert_eq!(
            body,
            "📥 o/r#7 머지 큐에 넣음 · head bbbbbbbbb · 권한: kim (래퍼 보고)"
        );
        assert_eq!(meta["merge"]["result"], json!("queued"));
        assert_eq!(meta["merge"]["noPrChecks"], json!(true));
        assert_eq!(meta["merge"]["mergeSha"], Value::Null);
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.merge.queuedGranted", "args": { "repo": "o/r", "number": 7, "head": "bbbbbbbbb", "granterId": "g1" } })
        );
        let (body, meta) = queued_line(
            "o/r",
            7,
            &h,
            None,
            None,
            None,
            None,
            false,
            false,
            false,
            None,
            &[],
            false,
        );
        assert_eq!(body, "📥 o/r#7 머지 큐에 넣음 · head bbbbbbbbb (래퍼 보고)");
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.merge.queued", "args": { "repo": "o/r", "number": 7, "head": "bbbbbbbbb" } })
        );
        let (body, meta) = queued_line(
            "o/r",
            7,
            &h,
            None,
            None,
            None,
            None,
            true,
            true,
            false,
            None,
            &[],
            false,
        );
        assert_eq!(
            body,
            "📥 o/r#7 머지 큐에 넣음 · head bbbbbbbbb · CI 실패 무시 승인 (래퍼 보고)"
        );
        assert!(meta.get("i18n").is_none());
    }

    #[test]
    fn merged_line_like_ts() {
        let h = "b".repeat(40);
        let m = "c".repeat(40);
        let (body, meta) = merged_line(
            "o/r",
            7,
            &h,
            Some(&m),
            None,
            Some(("g1", "kim")),
            Some("g1"),
            true,
            false,
            true,
            None,
            &[],
            false,
        );
        assert_eq!(body, "🔀 o/r#7 머지됨 · ccccccccc · 권한: kim (래퍼 보고)");
        assert_eq!(meta["merge"]["result"], json!("merged"));
        assert_eq!(meta["merge"]["noPrChecks"], json!(true));
        assert_eq!(meta["merge"]["viaApproval"], json!(true));
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.merge.mergedGranted", "args": { "repo": "o/r", "number": 7, "sha": "ccccccccc", "granterId": "g1" } })
        );
        let (body, meta) = merged_line(
            "o/r",
            7,
            &h,
            None,
            None,
            None,
            Some("g1"),
            false,
            false,
            false,
            None,
            &[],
            false,
        );
        assert_eq!(body, "🔀 o/r#7 머지됨 · bbbbbbbbb (래퍼 보고)");
        assert_eq!(meta["i18n"]["key"], json!("system.merge.merged"));
        assert!(meta["merge"].get("noPrChecks").is_none());
        let (body, meta) = merged_line(
            "o/r",
            7,
            &h,
            None,
            None,
            None,
            None,
            true,
            true,
            false,
            None,
            &[],
            false,
        );
        assert_eq!(
            body,
            "🔀 o/r#7 머지됨 · bbbbbbbbb · CI 실패 무시 승인 (래퍼 보고)"
        );
        assert!(meta.get("i18n").is_none());
        assert!(rust_reportable(
            &json!({ "result": "merged", "ignoredChecks": [] })
        ));
        assert!(rust_reportable(
            &json!({ "result": "merged", "ignoredChecks": ["x"] })
        ));
        let src = include_str!("../../../../packages/server/src/services/mergeGrants.ts");
        assert!(src.contains("`📥 ${repo}#${r.number} 머지 큐에 넣음 · head ${r.headSha.slice(0, 9)}` + (granter ? ` · 권한: ${granter}` : '') + ignoredTail + ' (래퍼 보고)'"));
        let watch = include_str!("../../../../packages/server/src/services/prWatch.ts");
        assert!(watch.contains("if (!delegationV2Enabled()) return null;"));
        assert!(src.contains("`🔀 ${repo}#${r.number} 머지됨 · ${(r.mergeSha ?? r.headSha).slice(0, 9)}` + (granter ? ` · 권한: ${granter}` : '') + ignoredTail + ' (래퍼 보고)'"));
    }

    #[test]
    fn ignored_checks_like_ts() {
        let names = vec!["a`b".to_owned(), "@x<y>".to_owned()];
        assert_eq!(check_names_for_body(&names), "`a'b`, `＠x‹y›`");
        assert_eq!(check_names_text(&names), "a`b, ＠x‹y›");
        let approved = vec!["a`b".to_owned()];
        assert!(grew_after_approval(true, &names, &approved));
        assert!(!grew_after_approval(false, &names, &approved));
        assert!(!grew_after_approval(true, &approved, &approved));
        let h = "b".repeat(40);
        let ci = vec!["ci".to_owned()];
        // 무시만(CI 무시 승인 아님) + 권한 이름 → Ignoring 표지.
        let (body, meta) = merged_line(
            "o/r",
            7,
            &h,
            None,
            None,
            Some(("g1", "kim")),
            Some("g1"),
            false,
            false,
            false,
            None,
            &ci,
            false,
        );
        assert_eq!(
            body,
            "🔀 o/r#7 머지됨 · bbbbbbbbb · 권한: kim · 무시: `ci` (래퍼 보고)"
        );
        assert_eq!(meta["merge"]["ignoredChecks"], json!(["ci"]));
        assert!(meta["merge"].get("grewAfterApproval").is_none());
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.merge.mergedIgnoring", "args": { "repo": "o/r", "number": 7, "sha": "bbbbbbbbb", "granterId": "g1", "checks": "ci" } })
        );
        // CI 무시 승인 + 늘어남.
        let (body, meta) = queued_line(
            "o/r",
            7,
            &h,
            None,
            None,
            Some(("g1", "kim")),
            Some("g1"),
            true,
            true,
            false,
            None,
            &ci,
            true,
        );
        assert_eq!(
            body,
            "📥 o/r#7 머지 큐에 넣음 · head bbbbbbbbb · 권한: kim · CI 실패 무시 승인 · 무시: `ci` (승인 뒤 늘어남) (래퍼 보고)"
        );
        assert_eq!(meta["merge"]["grewAfterApproval"], json!(true));
        assert_eq!(meta["merge"]["result"], json!("queued"));
        assert_eq!(
            meta["i18n"],
            json!({ "key": "system.merge.queuedCiOverrideGrew", "args": { "repo": "o/r", "number": 7, "head": "bbbbbbbbb", "granterId": "g1", "checks": "ci" } })
        );
        let (_, meta) = merged_line(
            "o/r",
            7,
            &h,
            None,
            None,
            Some(("g1", "kim")),
            Some("g1"),
            true,
            true,
            false,
            None,
            &ci,
            false,
        );
        assert_eq!(meta["i18n"]["key"], json!("system.merge.mergedCiOverride"));
        // 권한 이름이 없으면 꼬리가 있어도 표지 없이 본문만.
        let (body, meta) = merged_line(
            "o/r", 7, &h, None, None, None, None, false, false, false, None, &ci, false,
        );
        assert_eq!(body, "🔀 o/r#7 머지됨 · bbbbbbbbb · 무시: `ci` (래퍼 보고)");
        assert!(meta.get("i18n").is_none());
        let src = include_str!("../../../../packages/server/src/services/mergeGrants.ts");
        assert!(src.contains("const grewAfterApproval = ciOverride && ignored.some((n) => !usedApproval!.approvedChecks.includes(n));"));
        assert!(src.contains("+ (ignored.length ? ` · 무시: ${checkNamesForBody(ignored)}` : '') + (grewAfterApproval ? ' (승인 뒤 늘어남)' : '');"));
        assert!(src.contains("const tailVariant = ignored.length ? (ciOverride ? (grewAfterApproval ? 'CiOverrideGrew' : 'CiOverride') : 'Ignoring') : null;"));
        let d = include_str!("../../../../packages/server/src/services/mergeDenials.ts");
        assert!(d.contains("return names.map((n) => `\\`${n.replace(/`/g, \"'\").replace(/@/g, '＠').replace(/</g, '‹').replace(/>/g, '›')}\\``).join(', ');"));
        assert!(d.contains(
            "return names.join(', ').replace(/@/g, '＠').replace(/</g, '‹').replace(/>/g, '›');"
        ));
    }

    #[test]
    fn gh_user_memo_sql_like_ts() {
        let src = include_str!("../../../../packages/server/src/services/permissionRequests.ts");
        assert!(src.contains("where a.id = $1 and a.gh_user is null and r.status = 'approved_once' and m.id = r.card_message_id"));
        assert!(GH_CARD_SQL.contains("where a.id = $1::uuid and a.gh_user is null and r.status = 'approved_once' and m.id = r.card_message_id"));
        assert!(src.contains(
            "and coalesce((meta->'permissionMirror'->>'neutral')::boolean, false) = false"
        ));
        assert!(GH_MIRROR_SQL.contains(
            "and coalesce((meta->'permissionMirror'->>'neutral')::boolean, false) = false"
        ));
        let g = include_str!("../../../../packages/server/src/services/mergeGrants.ts");
        assert!(g.contains("const ghUserUsedDetail = usedApproval && usedApproval.ghUser === null && ghUserUsed ? { ghUserUsed, ghUserChosenBy: 'operator' } : {};"));
        assert!(!gh_user_ok("-bad"));
        assert!(gh_user_ok("bot-1"));
    }
}

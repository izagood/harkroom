//! S5.4 12a — 머지 거절 권한 카드(`message.ask` 의 `mergeDenialId`)의 **순수** 조각. TS `services/permissionRequests.ts` 의
//! `oneLineReason`·`permissionCardOptions`·`cardLine`·`permissionBodyTargetLine`·`permissionCardBody`(merge 갈래)·`onceMeta` 와
//! `mcp/mcpPlugin.ts` 의 머지 거절 이유 글·카드 물음을 같은 글자로 옮긴다. DB 는 만지지 않는다.

use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// TS `PERMISSION_GRANT_TTL_MS` — 7일.
pub const PERMISSION_GRANT_TTL_MS: i64 = 7 * 86_400_000;
/// TS `PERMISSION_REQUEST_TTL_MS` — 요청에 답할 수 있는 시한(하루).
pub const PERMISSION_REQUEST_TTL_MS: i64 = 86_400_000;
/// TS `PERMISSION_REQUESTS_PER_DAY`.
pub const PERMISSION_REQUESTS_PER_DAY: i64 = 20;

/// 거절 기록의 PR·head·사유(TS `once` 칸).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Once {
    pub number: i64,
    pub head_sha: String,
    pub reason: String,
    pub failed_checks: Vec<String>,
}

impl Once {
    pub fn ci(&self) -> bool {
        self.reason == "ci_not_green"
    }

    /// TS `onceMeta` — CI 거절이면 `failedChecks`(없으면 빈 목록)를 싣는다.
    pub fn meta(&self) -> Value {
        let mut m = Map::new();
        m.insert("number".into(), json!(self.number));
        m.insert("headSha".into(), json!(self.head_sha));
        m.insert("reason".into(), json!(self.reason));
        if self.ci() {
            m.insert("failedChecks".into(), json!(self.failed_checks));
        }
        Value::Object(m)
    }
}

pub(crate) fn js_space(c: char) -> bool {
    crate::core::cause_link::js_trim_char(c)
}

/// JS `s.slice(0, n)`(UTF-16 단위). 서로게이트 쌍 한가운데면 그 짝은 뺀다(JS 는 짝 잃은 서로게이트를 남긴다 — 뒤에 서는 글에서 jsonb 가 거절할 글자).
fn slice_utf16(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if used + w > n {
            return &s[..i];
        }
        used += w;
    }
    s
}

/// TS `oneLineReason` — 서식 글자(`\p{Cf}`) 지움 → 줄바꿈 무리를 빈칸 하나로 → `` ` * _ # | [ ] `` 지움 → JS `\s+` 를 빈칸 하나로 →
/// `trim` → 맨 앞 `>`·빈칸 지움 → UTF-16 300 단위.
pub fn one_line_reason(reason: &str) -> String {
    static CF: OnceLock<regex::Regex> = OnceLock::new();
    let cf = CF.get_or_init(|| regex::Regex::new(r"\p{Cf}").unwrap());
    let s = cf.replace_all(reason, "");
    let mut out = String::with_capacity(s.len());
    let mut in_break = false;
    for c in s.chars() {
        if matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
            continue;
        }
        in_break = false;
        if matches!(c, '`' | '*' | '_' | '#' | '|' | '[' | ']') {
            continue;
        }
        out.push(c);
    }
    let mut collapsed = String::with_capacity(out.len());
    let mut in_space = false;
    for c in out.chars() {
        if js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let t = collapsed.trim_matches(js_space);
    let t = t.trim_start_matches(|c: char| c == '>' || js_space(c));
    slice_utf16(t, 300).to_owned()
}

/// TS `permissionCardOptions('merge', { ciOnce, mandate })` — 거절 카드의 [이번 한 번]은 선택지에 없다(패널이 그린다).
pub fn merge_card_options(ci_once: bool, mandate: bool) -> Value {
    let deny = json!({ "id": "deny", "label": "거절" });
    if ci_once {
        return json!([deny]);
    }
    let standing = if mandate {
        json!({ "id": "approve_mandate", "label": "이 위임장 동안", "recommended": true })
    } else {
        json!({ "id": "approve_new_mandate", "label": "이 스레드로 위임장 만들고 더하기", "recommended": true })
    };
    json!([standing, deny])
}

/// TS `permissionCardOptions(kind, { mandate })`(거절 아님, tool·merge) — tool 은 위임장이 있으면 보조 [이번 턴만](t1).
pub fn plain_card_options(kind: &str, mandate: bool) -> Value {
    if kind == "tool" && mandate {
        return json!([
            { "id": "approve_mandate", "label": "이 위임장 동안", "recommended": true },
            { "id": "approve_turn", "label": "이번 턴만" },
            { "id": "deny", "label": "거절" },
        ]);
    }
    merge_card_options(false, mandate)
}

/// TS `cardLine('merge', target, once, hasMandate)` — `target` 은 저장한 꼴(`repo:owner/name`).
pub fn merge_card_line(target: &str, once: Option<&Once>, has_mandate: bool) -> Value {
    let mut limits = Map::new();
    if !once.is_some_and(Once::ci) {
        limits.insert(
            if has_mandate {
                "approve_mandate"
            } else {
                "approve_new_mandate"
            }
            .into(),
            json!({ "untilMs": PERMISSION_GRANT_TTL_MS }),
        );
    }
    if let Some(o) = once {
        let mut l = Map::new();
        l.insert("pr".into(), json!(o.number));
        l.insert("head".into(), json!(o.head_sha));
        l.insert("uses".into(), json!(1));
        if o.ci() {
            l.insert("ciOverride".into(), json!(true));
        }
        limits.insert("approve_once".into(), Value::Object(l));
    }
    json!({ "cap": "merge", "scope": target, "limits": limits })
}

/// TS `permissionBodyTargetLine`(merge) — CI 거절 카드면 없다. `target` 은 `owner/name`.
pub fn merge_body_target_line(target: &str, once: Option<&Once>) -> Option<String> {
    (!once.is_some_and(Once::ci)).then(|| format!("머지 `{target}`"))
}

/// TS `permissionCardBody`(merge, 경고 없음 — merge 요청은 경고가 없다, 줄 `line` 은 늘 있다). `target` 은 `owner/name`,
/// `reason` 은 meta 에 적은(이미 [`one_line_reason`] 을 거친) 값 — TS 처럼 한 번 더 거친다.
pub fn merge_card_body(
    target: &str,
    once: Option<&Once>,
    agent_handle: &str,
    reason: &str,
) -> String {
    let r = one_line_reason(reason);
    if let Some(o) = once.filter(|o| o.ci()) {
        let names = crate::core::merge_checks::check_names_for_body(&o.failed_checks);
        let head = slice_utf16(&o.head_sha, 9);
        let checks = if names.is_empty() {
            String::new()
        } else {
            format!("\n실패한 체크: {names}")
        };
        return format!(
            "권한 요청 · {agent_handle}\nCI 실패 무시하고 이번 한 번 머지 `{target}` PR #{} · head {head}{checks}\n이유: {r}",
            o.number
        );
    }
    let line = merge_body_target_line(target, once).unwrap_or_default();
    format!("권한 요청 · {agent_handle}\n{line}\n이유: {r}")
}

/// TS `raisePermission` 의 카드 물음.
pub fn merge_card_prompt(ci: bool) -> &'static str {
    if ci {
        "CI 실패를 무시하고 이번 한 번 머지할까?"
    } else {
        "권한을 줄까?"
    }
}

/// TS `message.ask`(mergeDenialId) 가 `raisePermission` 에 넘기는 이유 글 — 거절 사유 + 에이전트가 쓴 본문.
pub fn merge_denial_reason(number: i64, reason: Option<&str>, body: &str) -> String {
    let why = match reason {
        Some("cause_not_human") => "사람이 띄운 턴이 아니라서(cause_not_human)",
        Some("ci_not_green") => "CI 가 초록이 아니라서(ci_not_green)",
        Some("no_mandate_line") => "위임장에 맞는 머지 줄이 없어서(no_mandate_line)",
        _ => "권한 없음(not_granted)으로",
    };
    format!("PR #{number} 머지가 {why} 막혔다 — {body}")
}

/// 새 요청의 카드 meta `permissionRequest`(TS `openPermissionRequest` 의 `created.meta`, merge · 거절에서 온 요청).
/// `target` 은 저장한 꼴(`repo:owner/name`). 칸 차례도 TS 와 같다. 위임 있는 턴이면 `mandate` 에 (위임 id, 칩)을 주고, `once` 뒤에 `mandateId`·`mandate` 가 선다.
#[allow(clippy::too_many_arguments)]
pub fn merge_request_meta(
    request_id: &str,
    agent_id: &str,
    owner: Option<&str>,
    target: &str,
    reason: &str,
    once: &Once,
    requested_at: &str,
    expires_at: &str,
    mandate: Option<(&str, Value)>,
) -> Value {
    let short = target.strip_prefix("repo:").unwrap_or(target);
    let has_mandate = mandate.is_some();
    let mut m = Map::new();
    m.insert("requestId".into(), json!(request_id));
    m.insert("agentId".into(), json!(agent_id));
    m.insert("ownerAccountId".into(), json!(owner));
    m.insert("kind".into(), json!("merge"));
    m.insert("target".into(), json!(short));
    m.insert("channelId".into(), Value::Null);
    m.insert("warnings".into(), json!([]));
    m.insert("reason".into(), json!(one_line_reason(reason)));
    m.insert("once".into(), once.meta());
    if let Some((id, chip)) = mandate {
        m.insert("mandateId".into(), json!(id));
        m.insert("mandate".into(), chip);
    }
    m.insert(
        "line".into(),
        merge_card_line(target, Some(once), has_mandate),
    );
    if let Some(l) = merge_body_target_line(short, Some(once)) {
        m.insert("bodyTargetLine".into(), json!(l));
    }
    m.insert("requestedAt".into(), json!(requested_at));
    m.insert("expiresAt".into(), json!(expires_at));
    Value::Object(m)
}

/// 카드 글의 ask meta(TS `raisePermission` 의 `meta` — 모델 신고 칸은 글 쓰는 길이 더한다).
/// 선택지는 TS `permissionCardOptions('merge', { ciOnce, mandate: !!mandateId })` — 위임 있는 턴이면 [이 위임장 동안].
pub fn merge_card_meta(permission_request: Value, ci: bool) -> Map<String, Value> {
    let mandate = permission_request.get("mandateId").is_some();
    let mut m = Map::new();
    m.insert("kind".into(), json!("ask"));
    m.insert(
        "ask".into(),
        json!({
            "options": merge_card_options(ci, mandate),
            "to": { "kind": "human" },
            "prompt": merge_card_prompt(ci),
        }),
    );
    m.insert("permissionRequest".into(), permission_request);
    m
}

/// TS `openPermissionRequest` 의 하루 상한 셈(`created_at > now - 1일`).
pub const REQUEST_COUNT_SQL: &str = "select count(*)::bigint from permission_request \
     where agent_id = $1::uuid and created_at > $2::timestamptz - interval '1 day'";

/// TS `openPermissionRequest` 의 요청 줄(tool·merge · 위임 없음). 거절에서 오지 않은 요청은 `denial_id` 가 null.
pub const REQUEST_INSERT_SQL: &str = "insert into permission_request \
     (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, denial_id, mandate_id) \
     values ($1::uuid, $2, $3, $4, $5::text[], $6::uuid, $7::uuid, $8::timestamptz, $9::timestamptz, $10::uuid, $11::uuid) \
     returning id::text";

/// TS `supersedeOlderRequests`(거절 카드 — `denialPr` 가 있다: 같은 PR 의 카드만, 살아 있는 pending 도 대체).
pub const SUPERSEDE_OLDER_SQL: &str = "update permission_request \
        set superseded_by = $6::uuid, \
            status = case when status = 'pending' then 'superseded' else status end, \
            decided_at = coalesce(decided_at, $7::timestamptz) \
      where agent_id = $1::uuid and kind = $2 and target = $3 and channel_id = $4::uuid and thread_root_id = $5::uuid \
        and id <> $6::uuid and superseded_by is null \
        and ($8::int is null or denial_id in (select d.id from merge_denial d where d.scope = $3 and d.pr_number = $8)) \
        and (status = 'expired' or (status = 'pending' and (expires_at <= $7::timestamptz or $8::int is not null)))";

/// TS `recordAudit({ action: 'permission.requested', actorId: agent, target: agent, detail })`.
pub const REQUEST_AUDIT_SQL: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('permission.requested', $1::uuid, $2, $3::jsonb)";

/// TS `linkPermissionCard` 의 잇기(옛 카드 닫기 `closeSupersededCards` 는 뒤처리).
pub const LINK_CARD_SQL: &str = "update permission_request set card_message_id = $2::uuid \
     where id = $1::uuid and card_message_id is null";

/// 요청 줄 세우기·잇기에 드는 쓰기 풀 칸. 하나라도 없으면 TS.
pub const REQUEST_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("permission_request.id", "SELECT"),
    ("permission_request.agent_id", "SELECT"),
    ("permission_request.kind", "SELECT"),
    ("permission_request.target", "SELECT"),
    ("permission_request.channel_id", "SELECT"),
    ("permission_request.thread_root_id", "SELECT"),
    ("permission_request.status", "SELECT"),
    ("permission_request.expires_at", "SELECT"),
    ("permission_request.created_at", "SELECT"),
    ("permission_request.denial_id", "SELECT"),
    ("permission_request.superseded_by", "SELECT"),
    ("permission_request.decided_at", "SELECT"),
    ("permission_request.card_message_id", "SELECT"),
    ("permission_request.agent_id", "INSERT"),
    ("permission_request.kind", "INSERT"),
    ("permission_request.target", "INSERT"),
    ("permission_request.reason", "INSERT"),
    ("permission_request.warnings", "INSERT"),
    ("permission_request.channel_id", "INSERT"),
    ("permission_request.thread_root_id", "INSERT"),
    ("permission_request.created_at", "INSERT"),
    ("permission_request.expires_at", "INSERT"),
    ("permission_request.denial_id", "INSERT"),
    ("permission_request.mandate_id", "INSERT"),
    ("permission_request.superseded_by", "UPDATE"),
    ("permission_request.status", "UPDATE"),
    ("permission_request.decided_at", "UPDATE"),
    ("permission_request.card_message_id", "UPDATE"),
    ("merge_denial.id", "SELECT"),
    ("merge_denial.scope", "SELECT"),
    ("merge_denial.pr_number", "SELECT"),
    ("audit_log", "INSERT"),
];

/// 요청 줄 세우기 결과.
pub enum Opened {
    Created { request_id: String },
    TooMany,
}

/// 요청 하나 — 세우기 차례에 드는 값.
#[derive(Debug)]
pub struct NewRequest<'a> {
    pub kind: &'a str,
    pub agent: &'a str,
    /// 저장한 꼴(tool: 정규 규칙 / merge: `repo:owner/name`).
    pub target: &'a str,
    pub reason: &'a str,
    pub warnings: &'a [&'a str],
    pub channel: &'a str,
    pub thread: &'a str,
    /// 거절에서 온 머지 요청이면 그 기록 id 와 PR 번호.
    pub denial: Option<(&'a str, i64)>,
    /// 요청을 낸 턴의 위임(W4, P6-2b) — 없으면 null.
    pub mandate: Option<&'a str>,
    pub now: &'a str,
    pub expires: &'a str,
}

/// TS `openPermissionRequest` 의 세우기 차례(tool·merge · 위임 없음): 하루 상한 → insert → supersede → 감사.
/// 한 tx 안에서 부른다. `now`·`expires` 는 ISO 문자열(`expires = now + 하루`).
pub async fn open_request(
    tx: &mut sqlx::PgConnection,
    r: &NewRequest<'_>,
) -> Result<Opened, sqlx::Error> {
    let n: i64 = sqlx::query_scalar(REQUEST_COUNT_SQL)
        .bind(r.agent)
        .bind(r.now)
        .fetch_one(&mut *tx)
        .await?;
    if n >= PERMISSION_REQUESTS_PER_DAY {
        return Ok(Opened::TooMany);
    }
    let id: String = sqlx::query_scalar(REQUEST_INSERT_SQL)
        .bind(r.agent)
        .bind(r.kind)
        .bind(r.target)
        .bind(r.reason)
        .bind(r.warnings)
        .bind(r.channel)
        .bind(r.thread)
        .bind(r.now)
        .bind(r.expires)
        .bind(r.denial.map(|d| d.0))
        .bind(r.mandate)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(SUPERSEDE_OLDER_SQL)
        .bind(r.agent)
        .bind(r.kind)
        .bind(r.target)
        .bind(r.channel)
        .bind(r.thread)
        .bind(&id)
        .bind(r.now)
        .bind(r.denial.and_then(|d| i32::try_from(d.1).ok()))
        .execute(&mut *tx)
        .await?;
    sqlx::query(REQUEST_AUDIT_SQL)
        .bind(r.agent)
        .bind(r.agent)
        .bind(request_audit_detail(
            &id, r.kind, r.target, r.warnings, r.channel, r.thread,
        ))
        .execute(&mut *tx)
        .await?;
    Ok(Opened::Created { request_id: id })
}

/// TS 감사 `detail` — `{ requestId, kind, target, warnings, channelId, threadRootId }`.
pub fn request_audit_detail(
    id: &str,
    kind: &str,
    target: &str,
    warnings: &[&str],
    channel: &str,
    thread: &str,
) -> String {
    json!({
        "requestId": id, "kind": kind, "target": target, "warnings": warnings,
        "channelId": channel, "threadRootId": thread,
    })
    .to_string()
}

/// shared `TOOL_RULE_WARNING_ORDER` 와 `TOOL_RULE_WARNING_HEAD_KO`(그리는 순서대로).
pub const TOOL_RULE_WARNING_HEAD_KO: &[(&str, &str)] = &[
    ("runs_arbitrary", "무엇이든 돌릴 수 있다"),
    ("executes_in_workload", "돌고 있는 서버 안에서 실행한다"),
    ("mutates_remote", "원격 상태를 바꾼다"),
    ("unclassified", "무엇을 하는지 판정하지 못했다"),
    ("reads_file", "파일을 읽는다"),
    ("short_prefix", "접두가 짧다"),
    ("uses_github_account", "GitHub 계정으로 돈다"),
];

/// TS `permissionBodyWarningLine` — 아는 경고를 그리는 순서대로 ko 머리 낱말로 잇는다. 없으면 `None`.
pub fn body_warning_line(warnings: &[&str]) -> Option<String> {
    let heads: Vec<&str> = TOOL_RULE_WARNING_HEAD_KO
        .iter()
        .filter(|(w, _)| warnings.contains(w))
        .map(|(_, h)| *h)
        .collect();
    (!heads.is_empty()).then(|| format!("⚠ {}", heads.join(" · ")))
}

/// TS `cardLine('tool', rule, undefined, hasMandate)` — 위임장이 있으면 `approve_mandate` 와 [이번 턴만]의 `approve_turn`.
pub fn tool_card_line(rule: &str, has_mandate: bool) -> Value {
    if has_mandate {
        return json!({ "cap": "tool", "scope": rule, "limits": {
            "approve_mandate": { "untilMs": PERMISSION_GRANT_TTL_MS }, "approve_turn": { "turn": true } } });
    }
    json!({ "cap": "tool", "scope": rule, "limits": { "approve_new_mandate": { "untilMs": PERMISSION_GRANT_TTL_MS } } })
}

/// TS `permissionCardBody`(tool·merge · 거절 아님 · 줄 있음). `target` 은 보이는 꼴(tool: 규칙 / merge: `owner/name`),
/// `reason` 은 meta 에 적은 값 — TS 처럼 한 번 더 거친다.
pub fn plain_card_body(
    kind: &str,
    target: &str,
    warnings: &[&str],
    agent_handle: &str,
    reason: &str,
) -> String {
    let warn = body_warning_line(warnings).map_or(String::new(), |l| format!("\n{l}"));
    let line = if kind == "tool" {
        format!("명령 허용 `{target}`")
    } else {
        format!("머지 `{target}`")
    };
    format!(
        "권한 요청 · {agent_handle}\n{line}{warn}\n이유: {}",
        one_line_reason(reason)
    )
}

/// 거절에서 오지 않은 새 요청의 카드 meta `permissionRequest`(TS `openPermissionRequest` 의 `created.meta`, tool·merge · 위임 없는 턴).
/// `target` 은 저장한 꼴(tool: 규칙 / merge: `repo:owner/name`). 요청 id 는 카드 tx 의 훅이 채운다.
#[allow(clippy::too_many_arguments)]
pub fn plain_request_meta(
    kind: &str,
    agent_id: &str,
    owner: Option<&str>,
    target: &str,
    channel: &str,
    warnings: &[&str],
    reason: &str,
    requested_at: &str,
    expires_at: &str,
    mandate: Option<(&str, Value)>,
) -> Value {
    let tool = kind == "tool";
    let has_mandate = mandate.is_some();
    let short = if tool {
        target
    } else {
        target.strip_prefix("repo:").unwrap_or(target)
    };
    let mut m = Map::new();
    m.insert("requestId".into(), json!(""));
    m.insert("agentId".into(), json!(agent_id));
    m.insert("ownerAccountId".into(), json!(owner));
    m.insert("kind".into(), json!(kind));
    m.insert("target".into(), json!(short));
    m.insert(
        "channelId".into(),
        if tool { json!(channel) } else { Value::Null },
    );
    m.insert("warnings".into(), json!(warnings));
    if let Some(l) = body_warning_line(warnings) {
        m.insert("bodyWarningLine".into(), json!(l));
    }
    m.insert("reason".into(), json!(one_line_reason(reason)));
    if let Some((id, chip)) = mandate {
        m.insert("mandateId".into(), json!(id));
        m.insert("mandate".into(), chip);
    }
    if tool {
        m.insert("line".into(), tool_card_line(target, has_mandate));
        m.insert(
            "bodyTargetLine".into(),
            json!(format!("명령 허용 `{short}`")),
        );
    } else {
        m.insert("line".into(), merge_card_line(target, None, has_mandate));
        if let Some(l) = merge_body_target_line(short, None) {
            m.insert("bodyTargetLine".into(), json!(l));
        }
    }
    m.insert("requestedAt".into(), json!(requested_at));
    m.insert("expiresAt".into(), json!(expires_at));
    Value::Object(m)
}

/// 거절에서 오지 않은 카드 글의 ask meta(TS `raisePermission`, tool·merge). 위임 있는 턴이면 선택지가 [이 위임장 동안] 꼴.
pub fn plain_card_meta(permission_request: Value) -> Map<String, Value> {
    let kind = permission_request["kind"]
        .as_str()
        .unwrap_or("tool")
        .to_owned();
    let mandate = permission_request.get("mandateId").is_some();
    let mut m = merge_card_meta(permission_request, false);
    if let Some(Value::Object(ask)) = m.get_mut("ask") {
        ask.insert("options".into(), plain_card_options(&kind, mandate));
    }
    m
}

/// 카드 스레드에 위임장을 세울 수 있는가 — [`super::mandate_card_thread`] 의 머리 글 조건(소유자가 정할 때)을 잠그지 않고 읽는다:
/// 이 채널의 지워지지 않은 글, 자동화 글 아님, 소유자 본인이나 그 소유자의 에이전트가 쓴 글. $1 머리 $2 채널 $3 소유자.
pub const CARD_THREAD_OPEN_SQL: &str = "select exists (select 1 from message m where m.id = $1::uuid and m.channel_id = $2::uuid \
     and m.deleted_at is null and not (coalesce(m.meta, '{}'::jsonb) ? 'automation') \
     and (m.author_id = $3::uuid or exists (select 1 from agent_config c where c.account_id = m.author_id and c.owner_account_id = $3::uuid)))";

/// 위임장을 세울 수 없는 스레드의 머지 거절 카드 — [이 스레드로 위임장 만들고 더하기]를 선택지와 줄 한도에서 뺀다.
/// 누르면 늘 409 `mandate_unavailable` 이던 버튼이 추천으로 서 있었다. 남는 것은 once 칸의 [이번 한 번](주 버튼)과 [거절] — CI 카드와 같은 꼴이다.
pub fn drop_new_mandate(meta: &mut Map<String, Value>) {
    if let Some(Value::Array(opts)) = meta.get_mut("ask").and_then(|a| a.get_mut("options")) {
        opts.retain(|o| o.get("id").and_then(Value::as_str) != Some("approve_new_mandate"));
    }
    if let Some(limits) = meta
        .get_mut("permissionRequest")
        .and_then(|p| p.get_mut("line"))
        .and_then(|l| l.get_mut("limits"))
        .and_then(Value::as_object_mut)
    {
        limits.remove("approve_new_mandate");
    }
}

/// TS `too_many` 거절 글.
pub fn too_many_message() -> String {
    format!("at most {PERMISSION_REQUESTS_PER_DAY} permission requests a day")
}

/// TS `enqueueAskPush` — golden `enqueue_ask_push` 조각 그대로.
pub fn enqueue_ask_push_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        v["enqueue_ask_push"]
            .as_str()
            .expect("golden fragment enqueue_ask_push")
            .to_owned()
    })
}

/// 카드 잇기·푸시에 드는 쓰기 풀 칸(`push_job` INSERT 와 조각이 읽는 표).
pub const LINK_PUSH_PRIVILEGES: &[(&str, &str)] = &[
    ("push_job", "INSERT"),
    ("account", "SELECT"),
    ("push_device", "SELECT"),
    ("account_block", "SELECT"),
    ("message", "SELECT"),
];

/// TS `raisePermission` 의 글 뒤: `linkPermissionCard`(잇기 — replayed 여도 잇는다) → 새 글이고 소유자가 inbox 로 알림받지
/// 않았으면 `enqueueAskPush`. 옛 카드 닫기(`closeSupersededCards`)는 여기 없다 — 부르는 쪽이 대체된 옛 카드가 없을 때만 Rust 로 온다.
pub async fn link_and_push(
    write: &sqlx::PgPool,
    request_id: &str,
    card_id: &str,
    owner: Option<&str>,
    notified: &[String],
    replayed: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(LINK_CARD_SQL)
        .bind(request_id)
        .bind(card_id)
        .execute(write)
        .await?;
    if let Some(o) = owner
        && !replayed
        && !notified.iter().any(|n| n == o)
    {
        sqlx::query(enqueue_ask_push_sql())
            .bind(o)
            .bind(card_id)
            .execute(write)
            .await?;
    }
    Ok(())
}

/// TS `raisePermission` 의 답 — `{ requestId, cardMessageId, pending: true, expiresAt }`(칸 차례 그대로).
pub fn created_result(request_id: &str, card_id: &str, expires_at: &str) -> String {
    format!(
        "{{\"requestId\":{},\"cardMessageId\":{},\"pending\":true,\"expiresAt\":{}}}",
        Value::from(request_id),
        Value::from(card_id),
        Value::from(expires_at)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn once(reason: &str, checks: &[&str]) -> Once {
        Once {
            number: 42,
            head_sha: "0123456789abcdef".into(),
            reason: reason.into(),
            failed_checks: checks.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn one_line_reason_like_ts() {
        assert_eq!(
            one_line_reason("  > hi\r\n\n`there`  *x*_#|[y]\u{202e} "),
            "hi there xy"
        );
        assert_eq!(one_line_reason(">> > quote <link>"), "quote <link>");
        assert_eq!(
            one_line_reason("a\u{2028}\u{2029}b\u{3000}\u{3000}c"),
            "a b c"
        );
        // U+0085 는 JS `\s` 가 아니다.
        assert_eq!(one_line_reason("a\u{85}b"), "a\u{85}b");
        assert_eq!(one_line_reason(&"가".repeat(400)).chars().count(), 300);
        // 이모지(서로게이트 쌍) 한가운데서 자르면 그 짝은 뺀다.
        let s = format!("{}😀", "a".repeat(299));
        assert_eq!(one_line_reason(&s), "a".repeat(299));
        assert_eq!(one_line_reason("  "), "");
    }

    #[test]
    fn options_like_ts() {
        assert_eq!(
            merge_card_options(false, false),
            json!([
                { "id": "approve_new_mandate", "label": "이 스레드로 위임장 만들고 더하기", "recommended": true },
                { "id": "deny", "label": "거절" }
            ])
        );
        assert_eq!(
            merge_card_options(false, true),
            json!([
                { "id": "approve_mandate", "label": "이 위임장 동안", "recommended": true },
                { "id": "deny", "label": "거절" }
            ])
        );
        assert_eq!(
            merge_card_options(true, false),
            json!([{ "id": "deny", "label": "거절" }])
        );
    }

    #[test]
    fn drop_new_mandate_leaves_once_and_deny() {
        let o = once("no_mandate_line", &[]);
        let m = merge_request_meta("r", "a", Some("o"), "repo:a/b", "why", &o, "t0", "t1", None);
        let mut meta = merge_card_meta(m, false);
        drop_new_mandate(&mut meta);
        assert_eq!(
            meta["ask"]["options"],
            json!([{ "id": "deny", "label": "거절" }])
        );
        assert_eq!(
            meta["permissionRequest"]["line"]["limits"],
            json!({ "approve_once": { "pr": 42, "head": "0123456789abcdef", "uses": 1 } })
        );
        // 위임 있는 턴의 [이 위임장 동안]은 건드리지 않는다.
        let m = merge_request_meta(
            "r",
            "a",
            Some("o"),
            "repo:a/b",
            "why",
            &o,
            "t0",
            "t1",
            Some(("m", json!({}))),
        );
        let mut meta = merge_card_meta(m, false);
        let before = meta.clone();
        drop_new_mandate(&mut meta);
        assert_eq!(meta, before);
    }

    #[test]
    fn card_line_like_ts() {
        let o = once("not_granted", &[]);
        assert_eq!(
            merge_card_line("repo:a/b", Some(&o), false),
            json!({ "cap": "merge", "scope": "repo:a/b", "limits": {
                "approve_new_mandate": { "untilMs": 604_800_000 },
                "approve_once": { "pr": 42, "head": "0123456789abcdef", "uses": 1 }
            }})
        );
        let c = once("ci_not_green", &["lint"]);
        assert_eq!(
            merge_card_line("repo:a/b", Some(&c), true),
            json!({ "cap": "merge", "scope": "repo:a/b", "limits": {
                "approve_once": { "pr": 42, "head": "0123456789abcdef", "uses": 1, "ciOverride": true }
            }})
        );
        assert_eq!(
            merge_card_line("repo:a/b", None, true),
            json!({ "cap": "merge", "scope": "repo:a/b", "limits": { "approve_mandate": { "untilMs": 604_800_000 } } })
        );
    }

    #[test]
    fn once_meta_like_ts() {
        assert_eq!(
            once("not_granted", &["x"]).meta(),
            json!({ "number": 42, "headSha": "0123456789abcdef", "reason": "not_granted" })
        );
        assert_eq!(
            once("ci_not_green", &[]).meta(),
            json!({ "number": 42, "headSha": "0123456789abcdef", "reason": "ci_not_green", "failedChecks": [] })
        );
    }

    #[test]
    fn body_like_ts() {
        let o = once("not_granted", &[]);
        assert_eq!(
            merge_card_body(
                "a/b",
                Some(&o),
                "@forge",
                "PR #42 머지가 막혔다 — `go`\n now"
            ),
            "권한 요청 · @forge\n머지 `a/b`\n이유: PR 42 머지가 막혔다 — go now"
        );
        let c = once("ci_not_green", &["lint`@x", "<t>"]);
        assert_eq!(
            merge_card_body("a/b", Some(&c), "@forge", "r"),
            "권한 요청 · @forge\nCI 실패 무시하고 이번 한 번 머지 `a/b` PR #42 · head 012345678\n실패한 체크: `lint'＠x`, `‹t›`\n이유: r"
        );
        let c0 = once("ci_not_green", &[]);
        assert_eq!(
            merge_card_body("a/b", Some(&c0), "@f", "r"),
            "권한 요청 · @f\nCI 실패 무시하고 이번 한 번 머지 `a/b` PR #42 · head 012345678\n이유: r"
        );
        assert_eq!(merge_body_target_line("a/b", Some(&c0)), None);
    }

    #[test]
    fn reason_and_prompt_like_ts() {
        assert_eq!(
            merge_denial_reason(7, Some("ci_not_green"), "please"),
            "PR #7 머지가 CI 가 초록이 아니라서(ci_not_green) 막혔다 — please"
        );
        assert_eq!(
            merge_denial_reason(7, None, "b"),
            "PR #7 머지가 권한 없음(not_granted)으로 막혔다 — b"
        );
        assert_eq!(
            merge_denial_reason(7, Some("cause_not_human"), "b"),
            "PR #7 머지가 사람이 띄운 턴이 아니라서(cause_not_human) 막혔다 — b"
        );
        assert_eq!(
            merge_denial_reason(7, Some("no_mandate_line"), "b"),
            "PR #7 머지가 위임장에 맞는 머지 줄이 없어서(no_mandate_line) 막혔다 — b"
        );
        assert_eq!(
            merge_card_prompt(true),
            "CI 실패를 무시하고 이번 한 번 머지할까?"
        );
        assert_eq!(merge_card_prompt(false), "권한을 줄까?");
    }

    #[test]
    fn request_meta_like_ts() {
        let o = once("not_granted", &[]);
        let m = merge_request_meta(
            "r1",
            "a1",
            Some("o1"),
            "repo:a/b",
            "x\ny",
            &o,
            "2026-11-18T00:00:00.000Z",
            "2026-11-19T00:00:00.000Z",
            None,
        );
        let keys: Vec<&str> = m.as_object().unwrap().keys().map(String::as_str).collect();
        let mut want = vec![
            "requestId",
            "agentId",
            "ownerAccountId",
            "kind",
            "target",
            "channelId",
            "warnings",
            "reason",
            "once",
            "line",
            "bodyTargetLine",
            "requestedAt",
            "expiresAt",
        ];
        want.sort_unstable();
        let mut got = keys.clone();
        got.sort_unstable();
        assert_eq!(got, want);
        assert_eq!(m["target"], "a/b");
        assert_eq!(m["reason"], "x y");
        assert_eq!(m["bodyTargetLine"], "머지 `a/b`");
        assert_eq!(m["channelId"], Value::Null);
        let meta = merge_card_meta(m, false);
        assert_eq!(meta["ask"]["prompt"], "권한을 줄까?");
        assert_eq!(meta["ask"]["to"], json!({ "kind": "human" }));
    }

    #[test]
    fn request_meta_with_mandate_like_ts() {
        // TS openPermissionRequest(denial + mandateId): mandateId·mandate 칸, line 은 approve_mandate, 선택지는 [이 위임장 동안]·거절.
        let o = once("not_granted", &[]);
        let chip = json!({ "id": "d1", "name": "", "ownerId": "o1", "startedAt": "2026-11-18T00:00:00.000Z" });
        let m = merge_request_meta(
            "r1",
            "a1",
            Some("o1"),
            "repo:a/b",
            "x",
            &o,
            "2026-11-18T00:00:00.000Z",
            "2026-11-19T00:00:00.000Z",
            Some(("d1", chip.clone())),
        );
        assert_eq!(m["mandateId"], "d1");
        assert_eq!(m["mandate"], chip);
        assert!(m["line"]["limits"].get("approve_mandate").is_some());
        assert!(m["line"]["limits"].get("approve_new_mandate").is_none());
        let meta = merge_card_meta(m.clone(), false);
        assert_eq!(meta["ask"]["options"][0]["id"], "approve_mandate");
        assert_eq!(meta["ask"]["options"][1]["id"], "deny");
        // CI 거절 카드는 위임이 있어도 거절 하나뿐이다.
        assert_eq!(
            merge_card_meta(m, true)["ask"]["options"],
            json!([{ "id": "deny", "label": "거절" }])
        );
    }

    #[test]
    fn request_sql_follows_ts() {
        assert!(SUPERSEDE_OLDER_SQL.contains("d.pr_number = $8"));
        assert!(SUPERSEDE_OLDER_SQL.contains("$8::int is not null"));
        assert!(REQUEST_INSERT_SQL.contains("$5::text[]"));
        assert!(LINK_CARD_SQL.contains("card_message_id is null"));
        assert_eq!(too_many_message(), "at most 20 permission requests a day");
        let d: Value = serde_json::from_str(&request_audit_detail(
            "r",
            "merge",
            "repo:a/b",
            &[],
            "c",
            "t",
        ))
        .unwrap();
        assert_eq!(
            d,
            json!({ "requestId": "r", "kind": "merge", "target": "repo:a/b", "warnings": [], "channelId": "c", "threadRootId": "t" })
        );
        assert!(REQUEST_WRITE_PRIVILEGES.contains(&("audit_log", "INSERT")));
    }

    #[test]
    fn link_push_like_ts() {
        assert!(enqueue_ask_push_sql().contains("'ask'"));
        assert_eq!(
            created_result("r", "m", "2026-11-19T00:00:00.000Z"),
            r#"{"requestId":"r","cardMessageId":"m","pending":true,"expiresAt":"2026-11-19T00:00:00.000Z"}"#
        );
    }
}

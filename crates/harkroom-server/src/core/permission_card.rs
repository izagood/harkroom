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

fn js_space(c: char) -> bool {
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

/// 새 요청의 카드 meta `permissionRequest`(TS `openPermissionRequest` 의 `created.meta`, merge · 위임 없는 턴).
/// `target` 은 저장한 꼴(`repo:owner/name`). 칸 차례도 TS 와 같다.
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
) -> Value {
    let short = target.strip_prefix("repo:").unwrap_or(target);
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
    m.insert("line".into(), merge_card_line(target, Some(once), false));
    if let Some(l) = merge_body_target_line(short, Some(once)) {
        m.insert("bodyTargetLine".into(), json!(l));
    }
    m.insert("requestedAt".into(), json!(requested_at));
    m.insert("expiresAt".into(), json!(expires_at));
    Value::Object(m)
}

/// 카드 글의 ask meta(TS `raisePermission` 의 `meta` — 모델 신고 칸은 글 쓰는 길이 더한다).
pub fn merge_card_meta(permission_request: Value, ci: bool) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("kind".into(), json!("ask"));
    m.insert(
        "ask".into(),
        json!({
            "options": merge_card_options(ci, false),
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

/// TS `openPermissionRequest` 의 요청 줄(merge · 거절에서 온 것 · 위임 없음 — `warnings` 는 빈 배열).
pub const REQUEST_INSERT_SQL: &str = "insert into permission_request \
     (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at, denial_id, mandate_id) \
     values ($1::uuid, 'merge', $2, $3, '{}', $4::uuid, $5::uuid, $6::timestamptz, $7::timestamptz, $8::uuid, null) \
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

/// TS `openPermissionRequest` 의 세우기 차례(merge · 거절에서 온 요청 · 위임 없음): 하루 상한 → insert → supersede → 감사.
/// 한 tx 안에서 부른다. `now`·`expires` 는 ISO 문자열(`expires = now + 하루`).
#[allow(clippy::too_many_arguments)]
pub async fn open_merge_request(
    tx: &mut sqlx::PgConnection,
    agent: &str,
    target: &str,
    reason: &str,
    channel: &str,
    thread: &str,
    denial_id: &str,
    denial_pr: i64,
    now: &str,
    expires: &str,
) -> Result<Opened, sqlx::Error> {
    let n: i64 = sqlx::query_scalar(REQUEST_COUNT_SQL)
        .bind(agent)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
    if n >= PERMISSION_REQUESTS_PER_DAY {
        return Ok(Opened::TooMany);
    }
    let id: String = sqlx::query_scalar(REQUEST_INSERT_SQL)
        .bind(agent)
        .bind(target)
        .bind(reason)
        .bind(channel)
        .bind(thread)
        .bind(now)
        .bind(expires)
        .bind(denial_id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(SUPERSEDE_OLDER_SQL)
        .bind(agent)
        .bind("merge")
        .bind(target)
        .bind(channel)
        .bind(thread)
        .bind(&id)
        .bind(now)
        .bind(i32::try_from(denial_pr).ok())
        .execute(&mut *tx)
        .await?;
    sqlx::query(REQUEST_AUDIT_SQL)
        .bind(agent)
        .bind(agent)
        .bind(request_audit_detail(&id, target, channel, thread))
        .execute(&mut *tx)
        .await?;
    Ok(Opened::Created { request_id: id })
}

/// TS 감사 `detail` — `{ requestId, kind, target, warnings, channelId, threadRootId }`.
pub fn request_audit_detail(id: &str, target: &str, channel: &str, thread: &str) -> String {
    json!({
        "requestId": id, "kind": "merge", "target": target, "warnings": [],
        "channelId": channel, "threadRootId": thread,
    })
    .to_string()
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
    fn request_sql_follows_ts() {
        assert!(SUPERSEDE_OLDER_SQL.contains("d.pr_number = $8"));
        assert!(SUPERSEDE_OLDER_SQL.contains("$8::int is not null"));
        assert!(REQUEST_INSERT_SQL.contains("'merge'"));
        assert!(LINK_CARD_SQL.contains("card_message_id is null"));
        assert_eq!(too_many_message(), "at most 20 permission requests a day");
        let d: Value =
            serde_json::from_str(&request_audit_detail("r", "repo:a/b", "c", "t")).unwrap();
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

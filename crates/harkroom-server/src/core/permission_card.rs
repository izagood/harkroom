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
}

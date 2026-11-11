//! `harkroom-operator hook …` 의 판정 부분 — TS `packages/operator/src/hookCli.ts` 를 옮긴다(s21b-3d-3b-1, 기본 node 그대로).
//! 프로세스·소켓·파일 밖에서 시험할 수 있는 순수 함수만 둔다. 하위 명령 갈래(`hookMain`)·`posttool`(`peekContext`)은 다음 PR 이다.
//!
//! 지켜야 할 경계(TS 와 같다):
//! - `pretool`(구독형): 승인된 정확한 명령이면 allow, 그 밖은 결정 없음(무출력). 오퍼레이터에 묻기 전에 `validate_exact_command` 로 거른다.
//! - `lane`(API 키): allow 를 **내지 않는다** — 결정 없음 또는 deny. 입력을 못 읽으면 deny(fail-closed).
//! - `tail`(codex 꼬리 막기): 이 채널 규칙에 좁게 맞으면 결정 없음, 승인 낱말을 건드리면 deny, 그 밖 결정 없음. 못 읽으면 deny.
//! - `permission`: allow 를 내지 않는다 — 변수 경로 rm·AskUserQuestion 만 deny, 세 번째 거절부터 멈추라는 문구.
//! - `notify`: `permission_prompt` 일 때만 시각 한 줄.
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::merge::ToolReply;
use crate::tool_rules::{ExactCommandVerdict, validate_exact_command};
use crate::turn_command::COMMAND_CHECK_TOOL;

pub const HOOK_TIMEOUT_MS: u64 = 10_000;
pub const HOOK_STDIN_MAX: usize = 256 * 1024;

/// TS `LANE_HOOK_TOOLS`(`@harkroom/shared/providerLane`).
pub const LANE_HOOK_TOOLS: [&str; 3] = ["Bash", "WebFetch", "WebSearch"];

pub const LANE_HOOK_DENY_REASON: &str = "harkroom: this API-key agent may only use owner-approved tools. Ask with the harkroom permission.request tool (kind \"tool\") for this exact use, e.g. Bash(<the exact full command>); once approved it opens from the next turn.";

pub const LANE_HOOK_SHELL_REASON: &str = "harkroom: this command has shell characters (> | & ; $ ` ( ) { } \\ or a line break), and approved rules never cover those, even inside quotes. Run the plain command without redirection (such as 2>&1), pipes, chaining or substitution. If no approved rule covers the plain command, ask with the harkroom permission.request tool (kind \"tool\") for it.";

pub const LANE_HOOK_TAIL_REASON: &str = "harkroom: this command contains an owner-approved command but is not exactly it (extra arguments, a wrapper or quoting). Run the approved command exactly as approved, or ask with the harkroom permission.request tool (kind \"tool\") for this exact full command; once approved it opens from the next turn.";

pub const PERMISSION_STOP_AFTER: u32 = 3;
pub const PERMISSION_RM_REASON: &str = "harkroom: this rm targets a path built from shell variables, which needs interactive approval — and no human is at this terminal. Rewrite it so the path is checked or literal: use ${VAR:?} for every variable in the path (e.g. rm -rf \"${P:?}/sub\"), or write the absolute path literally. Then run it again.";
pub const PERMISSION_ASK_REASON: &str = "harkroom: no human is at this terminal, so AskUserQuestion cannot be answered. Choose yourself and continue. If the decision truly belongs to a person, ask with the harkroom message.ask tool (a card in the thread) instead.";
pub const PERMISSION_STOP_REASON: &str = "harkroom: this turn has hit repeated permission denials. Stop retrying: report what you were trying to do and what was blocked with the harkroom message.fail tool, then end the turn.";

/// JS 의 `\s`·`trim` 공백(WhiteSpace + LineTerminator). Rust `char::is_whitespace` 와 달리 U+0085 는 빼고 U+FEFF 는 넣는다.
fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

fn js_words(s: &str) -> Vec<&str> {
    s.split(is_js_ws).filter(|w| !w.is_empty()).collect()
}

/// TS `SHELL_META` — `[;&|\`$<>(){}\\\n\r]`.
fn is_shell_meta(c: char) -> bool {
    matches!(
        c,
        ';' | '&' | '|' | '`' | '$' | '<' | '>' | '(' | ')' | '{' | '}' | '\\' | '\n' | '\r'
    )
}

fn has_shell_meta(s: &str) -> bool {
    s.chars().any(is_shell_meta)
}

/// JS 의 `\s` 를 정규식 문자 집합으로(위 `is_js_ws` 와 같은 집합).
const JS_WS_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// TS `variablePathRm` 의 정규식. `\b` 는 JS 처럼 ASCII 낱말 경계다.
static VARIABLE_PATH_RM: LazyLock<Regex> = LazyLock::new(|| {
    let ws = JS_WS_CLASS;
    Regex::new(&format!(
        r"(?:^|[;&|({{\n]|(?-u:\b)(?:do|then|else|xargs|sudo)[{ws}])[{ws}]*(?:command[{ws}]+)?rm[{ws}][^;&|\n]*\$"
    ))
    .expect("variable path rm regex")
});

static PROGRAM_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[{JS_WS_CLASS}]*([A-Za-z0-9_./-]{{1,64}})")).expect("program head regex")
});

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn command_of(input: &Value) -> Option<&str> {
    input
        .get("tool_input")
        .and_then(|t| t.get("command"))
        .and_then(Value::as_str)
}

/// `Bash(<inner>)` 의 inner(TS `/^Bash\((.+)\)$/s`).
fn bash_inner(rule: &str) -> Option<&str> {
    let inner = rule.strip_prefix("Bash(")?.strip_suffix(')')?;
    (!inner.is_empty()).then_some(inner)
}

fn pre_tool_decision(decision: &str, reason: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason } })
}

pub fn lane_deny(reason: &str) -> Value {
    pre_tool_decision("deny", reason)
}

/// TS `decideHook` — 구독형 턴의 PreToolUse. `ask` 는 오퍼레이터 도구 한 번(턴 밖·연결 실패는 `None`).
pub fn decide_hook(raw: &str, ask: impl FnOnce(&str, Value) -> Option<ToolReply>) -> Option<Value> {
    let input: Value = serde_json::from_str(raw).ok()?;
    if str_field(&input, "tool_name") != Some("Bash") {
        return None;
    }
    let command = match validate_exact_command(command_of(&input)?) {
        ExactCommandVerdict::Ok { command, .. } => command,
        ExactCommandVerdict::Refused(_) => return None,
    };
    let mut args = serde_json::Map::new();
    args.insert("command".into(), Value::String(command));
    if let Some(cwd) = str_field(&input, "cwd") {
        args.insert("cwd".into(), Value::String(cwd.to_string()));
    }
    if let Some(id) = str_field(&input, "tool_use_id") {
        args.insert("toolUseId".into(), Value::String(id.to_string()));
    }
    let reply = ask(COMMAND_CHECK_TOOL, Value::Object(args))?;
    if !reply.ok {
        return None;
    }
    let out: Value = serde_json::from_str(&reply.text).ok()?;
    if out.get("allow") != Some(&Value::Bool(true)) {
        return None;
    }
    let grant = str_field(&out, "grantId")?;
    let short: String = grant.chars().take(8).collect();
    Some(pre_tool_decision(
        "allow",
        &format!("harkroom: owner-approved exact command (grant {short})"),
    ))
}

/// TS `laneBashAllowed` — claude 판정보다 **좁다**.
pub fn lane_bash_allowed(rules: &[String], command: Option<&str>) -> bool {
    let cmd = command.map(js_trim).unwrap_or("");
    if cmd.is_empty() || has_shell_meta(cmd) {
        return false;
    }
    for rule in rules {
        let Some(inner) = bash_inner(rule) else {
            continue;
        };
        let inner = js_trim(inner);
        if let Some(prefix) = inner.strip_suffix(":*") {
            let prefix = js_trim(prefix);
            if !prefix.is_empty()
                && (cmd == prefix
                    || cmd
                        .strip_prefix(prefix)
                        .is_some_and(|rest| rest.starts_with(' ')))
            {
                return true;
            }
        } else if cmd == inner {
            return true;
        }
    }
    false
}

/// TS `laneToolListed`.
pub fn lane_tool_listed(rules: &[String], tool: &str) -> bool {
    if tool == "Read" {
        return true;
    }
    if LANE_HOOK_TOOLS.contains(&tool) {
        return rules.iter().any(|r| r == tool);
    }
    for rule in rules {
        let name = rule.split('(').next().unwrap_or("");
        if name == tool {
            return true;
        }
        if name.starts_with("mcp__")
            && name.split("__").count() == 2
            && tool
                .strip_prefix(name)
                .is_some_and(|rest| rest.starts_with("__"))
        {
            return true;
        }
    }
    false
}

fn shell_or(command: Option<&str>, otherwise: &'static str) -> &'static str {
    if command.is_some_and(|c| has_shell_meta(js_trim(c))) {
        LANE_HOOK_SHELL_REASON
    } else {
        otherwise
    }
}

/// TS `decideLaneHook` — `None` = 결정 없음, `Some` = deny. JSON 이 객체가 아니어도 deny 다(TS 는 `null` 에서 throw — 아래 시험 참조).
pub fn decide_lane_hook(raw: &str, rules: &[String]) -> Option<Value> {
    let Ok(input) = serde_json::from_str::<Value>(raw) else {
        return Some(lane_deny(LANE_HOOK_DENY_REASON));
    };
    let tool = str_field(&input, "tool_name").unwrap_or("");
    if tool.is_empty() {
        return Some(lane_deny(LANE_HOOK_DENY_REASON));
    }
    if tool == "Bash" {
        let command = command_of(&input);
        if lane_bash_allowed(rules, command) {
            return None;
        }
        return Some(lane_deny(shell_or(command, LANE_HOOK_DENY_REASON)));
    }
    if lane_tool_listed(rules, tool) {
        None
    } else {
        Some(lane_deny(LANE_HOOK_DENY_REASON))
    }
}

fn rule_words(rules: &[String]) -> Vec<Vec<&str>> {
    let mut out = Vec::new();
    for rule in rules {
        let Some(inner) = bash_inner(rule) else {
            continue;
        };
        let mut inner = js_trim(inner);
        if let Some(p) = inner.strip_suffix(":*") {
            inner = js_trim(p);
        }
        let words = js_words(inner);
        if !words.is_empty() {
            out.push(words);
        }
    }
    out
}

/// TS `touchesApprovedRule` — codex 규칙 맞춤보다 **넓게** 본다.
pub fn touches_approved_rule(rules: &[String], command: Option<&str>) -> bool {
    let cmd = command.unwrap_or("");
    if js_trim(cmd).is_empty() {
        return false;
    }
    let patterns = rule_words(rules);
    if patterns.is_empty() {
        return false;
    }
    let stripped: String = cmd
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '\\'))
        .collect();
    stripped.split(is_shell_meta).map(js_words).any(|words| {
        patterns
            .iter()
            .any(|p| p.len() <= words.len() && words.windows(p.len()).any(|w| w == p.as_slice()))
    })
}

/// TS `decideTailHook`.
pub fn decide_tail_hook(raw: &str, rules: &[String], reach: &[String]) -> Option<Value> {
    let Ok(input) = serde_json::from_str::<Value>(raw) else {
        return Some(lane_deny(LANE_HOOK_DENY_REASON));
    };
    let tool = str_field(&input, "tool_name").unwrap_or("");
    if tool.is_empty() {
        return Some(lane_deny(LANE_HOOK_DENY_REASON));
    }
    if tool != "Bash" {
        return None;
    }
    let command = command_of(&input);
    if lane_bash_allowed(rules, command) {
        return None;
    }
    let all: Vec<String> = reach.iter().chain(rules.iter()).cloned().collect();
    if !touches_approved_rule(&all, command) {
        return None;
    }
    Some(lane_deny(shell_or(command, LANE_HOOK_TAIL_REASON)))
}

pub fn post_tool_output(text: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": text } })
}

/// TS `notifyGateLine`.
pub fn notify_gate_line(raw: &str, now_ms: f64) -> Option<String> {
    let input: Value = serde_json::from_str(raw).ok()?;
    if str_field(&input, "notification_type") != Some("permission_prompt") {
        return None;
    }
    Some(format!("{}\n", now_ms.floor() as i64))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    RmVariablePath,
    AskUserQuestion,
    Other,
}

impl PermissionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionKind::RmVariablePath => "rm_variable_path",
            PermissionKind::AskUserQuestion => "ask_user_question",
            PermissionKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionClass {
    pub tool: String,
    pub kind: PermissionKind,
    pub program: Option<String>,
}

/// TS `variablePathRm`.
pub fn variable_path_rm(command: &str) -> bool {
    VARIABLE_PATH_RM.is_match(command)
}

/// TS `classifyPermissionRequest` — 기록에는 명령 전문을 남기지 않는다(첫 낱말만).
pub fn classify_permission_request(raw: &str) -> Option<PermissionClass> {
    let input: Value = serde_json::from_str(raw).ok()?;
    let tool = str_field(&input, "tool_name")?.to_string();
    if tool == "AskUserQuestion" {
        return Some(PermissionClass {
            tool,
            kind: PermissionKind::AskUserQuestion,
            program: None,
        });
    }
    if tool == "Bash"
        && let Some(command) = command_of(&input)
    {
        let program = PROGRAM_HEAD
            .captures(command)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        let kind = if variable_path_rm(command) {
            PermissionKind::RmVariablePath
        } else {
            PermissionKind::Other
        };
        return Some(PermissionClass {
            tool,
            kind,
            program,
        });
    }
    Some(PermissionClass {
        tool,
        kind: PermissionKind::Other,
        program: None,
    })
}

fn permission_deny(message: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": message } } })
}

/// TS `decidePermissionHook` — `prior_denials` 는 이 턴에서 이미 낸 거절 수. 결정 없음이면 `.1` 이 `None`.
pub fn decide_permission_hook(
    raw: &str,
    prior_denials: u32,
) -> Option<(PermissionClass, Option<Value>)> {
    let c = classify_permission_request(raw)?;
    let decision = match c.kind {
        PermissionKind::Other => None,
        _ if prior_denials + 1 >= PERMISSION_STOP_AFTER => {
            Some(permission_deny(PERMISSION_STOP_REASON))
        }
        PermissionKind::RmVariablePath => Some(permission_deny(PERMISSION_RM_REASON)),
        PermissionKind::AskUserQuestion => Some(permission_deny(PERMISSION_ASK_REASON)),
    };
    Some((c, decision))
}

/// TS `countTurnDenials` — 그날 기록에서 이 턴이 낸 거절 수. 깨진 줄은 세지 않는다.
pub fn count_turn_denials(jsonl: &str, turn: &str) -> u32 {
    jsonl
        .split('\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|r| {
            str_field(r, "turn") == Some(turn)
                && str_field(r, "event") == Some("decided")
                && str_field(r, "decision") == Some("deny")
        })
        .count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(r: &[&str]) -> Vec<String> {
        r.iter().map(|s| s.to_string()).collect()
    }

    fn bash(cmd: &str) -> String {
        json!({ "tool_name": "Bash", "tool_input": { "command": cmd } }).to_string()
    }

    const K: &str = "kubectl --kubeconfig /x --context rc get pods";

    fn reason(v: &Value) -> &str {
        v["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap()
    }

    #[test]
    fn pretool_allows_only_granted_exact_command() {
        let raw = json!({ "tool_name": "Bash", "tool_input": { "command": K }, "cwd": "/w", "tool_use_id": "tu1" }).to_string();
        let mut seen = None;
        let out = decide_hook(&raw, |name, args| {
            seen = Some((name.to_string(), args));
            Some(ToolReply {
                ok: true,
                text: json!({ "allow": true, "grantId": "abcdef0123456789" }).to_string(),
            })
        })
        .unwrap();
        let (name, args) = seen.unwrap();
        assert_eq!(name, "command.check");
        assert_eq!(
            args,
            json!({ "command": K, "cwd": "/w", "toolUseId": "tu1" })
        );
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(
            reason(&out),
            "harkroom: owner-approved exact command (grant abcdef01)"
        );
    }

    #[test]
    fn pretool_silent_on_everything_else() {
        let yes = || {
            Some(ToolReply {
                ok: true,
                text: json!({ "allow": true, "grantId": "g" }).to_string(),
            })
        };
        // 셸 이어 붙이기는 소켓도 열지 않는다.
        assert!(
            decide_hook(
                &bash("kubectl --kubeconfig /x --context rc get pods && rm x"),
                |_, _| panic!("asked")
            )
            .is_none()
        );
        assert!(decide_hook("not json", |_, _| panic!("asked")).is_none());
        assert!(decide_hook("null", |_, _| panic!("asked")).is_none());
        assert!(
            decide_hook(&json!({ "tool_name": "Read" }).to_string(), |_, _| panic!(
                "asked"
            ))
            .is_none()
        );
        assert!(decide_hook(&bash(K), |_, _| None).is_none());
        assert!(
            decide_hook(&bash(K), |_, _| Some(ToolReply {
                ok: false,
                text: "{}".into()
            }))
            .is_none()
        );
        assert!(
            decide_hook(&bash(K), |_, _| Some(ToolReply {
                ok: true,
                text: json!({ "allow": false }).to_string()
            }))
            .is_none()
        );
        assert!(
            decide_hook(&bash(K), |_, _| Some(ToolReply {
                ok: true,
                text: json!({ "allow": true }).to_string()
            }))
            .is_none()
        );
        assert!(
            decide_hook(&bash(K), |_, _| Some(ToolReply {
                ok: true,
                text: "null".into()
            }))
            .is_none()
        );
        assert!(decide_hook(&bash(K), |_, _| yes()).is_some());
    }

    #[test]
    fn lane_bash_is_narrow() {
        let r = rules(&[
            "Bash(gh pr view:*)",
            "Bash(git status)",
            "Bash()",
            "WebFetch",
        ]);
        assert!(lane_bash_allowed(&r, Some("gh pr view")));
        assert!(lane_bash_allowed(&r, Some("  gh pr view 12  ")));
        assert!(!lane_bash_allowed(&r, Some("gh pr viewer")));
        assert!(!lane_bash_allowed(&r, Some("gh pr view 1 2>&1")));
        assert!(!lane_bash_allowed(&r, Some("gh pr view\t1")));
        assert!(lane_bash_allowed(&r, Some("git status")));
        assert!(!lane_bash_allowed(&r, Some("git status -s")));
        assert!(!lane_bash_allowed(&r, None));
        assert!(!lane_bash_allowed(&r, Some("   ")));
        assert!(!lane_bash_allowed(&rules(&["Bash(:*)"]), Some("x")));
    }

    #[test]
    fn lane_tool_listing() {
        let r = rules(&[
            "WebFetch(domain:x.com)",
            "WebSearch",
            "mcp__harkroom",
            "mcp__a__b",
            "Glob(src/**)",
        ]);
        assert!(lane_tool_listed(&r, "Read"));
        assert!(lane_tool_listed(&r, "WebSearch"));
        assert!(
            !lane_tool_listed(&r, "WebFetch"),
            "웹 도구는 맨 이름 규칙만"
        );
        assert!(lane_tool_listed(&r, "mcp__harkroom__message_post"));
        assert!(!lane_tool_listed(&r, "mcp__harkroomx__y"));
        assert!(lane_tool_listed(&r, "mcp__a__b"));
        assert!(
            !lane_tool_listed(&r, "mcp__a__b__c"),
            "mcp__a__b 는 서버 접두가 아니다"
        );
        assert!(lane_tool_listed(&r, "Glob"));
        assert!(!lane_tool_listed(&r, "Write"));
    }

    #[test]
    fn lane_hook_decisions() {
        let r = rules(&["Bash(gh pr view:*)", "mcp__harkroom"]);
        assert!(decide_lane_hook(&bash("gh pr view 3"), &r).is_none());
        assert_eq!(
            reason(&decide_lane_hook(&bash("gh pr view 3 | cat"), &r).unwrap()),
            LANE_HOOK_SHELL_REASON
        );
        assert_eq!(
            reason(&decide_lane_hook(&bash("ls"), &r).unwrap()),
            LANE_HOOK_DENY_REASON
        );
        assert!(
            decide_lane_hook(&json!({ "tool_name": "mcp__harkroom__x" }).to_string(), &r).is_none()
        );
        assert!(decide_lane_hook(&json!({ "tool_name": "Write" }).to_string(), &r).is_some());
        for bad in [
            "{",
            "null",
            "[]",
            "5",
            "{}",
            r#"{"tool_name":""}"#,
            r#"{"tool_name":3}"#,
        ] {
            assert_eq!(
                reason(&decide_lane_hook(bad, &r).unwrap()),
                LANE_HOOK_DENY_REASON,
                "{bad}"
            );
        }
        assert_eq!(
            decide_lane_hook("{", &r).unwrap()["hookSpecificOutput"]["permissionDecision"],
            "deny"
        );
    }

    #[test]
    fn touches_rule_broadly() {
        let r = rules(&["Bash(gh pr merge:*)"]);
        for c in [
            "gh pr merge 1",
            "\"gh\" pr merge 1",
            "FOO=1 gh pr merge 1",
            "bash -lc 'gh pr merge 1'",
            "ls && gh pr merge 1",
            "echo $(gh pr merge 1)",
        ] {
            assert!(touches_approved_rule(&r, Some(c)), "{c}");
        }
        assert!(!touches_approved_rule(&r, Some("gh pr view 1")));
        assert!(!touches_approved_rule(&r, Some("  ")));
        assert!(!touches_approved_rule(
            &rules(&["Read"]),
            Some("gh pr merge")
        ));
    }

    #[test]
    fn tail_hook_decisions() {
        let here = rules(&["Bash(gh pr view:*)"]);
        let reach = rules(&["Bash(gh pr merge:*)"]);
        assert!(decide_tail_hook(&bash("gh pr view 1"), &here, &reach).is_none());
        assert_eq!(
            reason(&decide_tail_hook(&bash("gh pr merge 1"), &here, &reach).unwrap()),
            LANE_HOOK_TAIL_REASON
        );
        assert_eq!(
            reason(&decide_tail_hook(&bash("x; gh pr merge 1"), &here, &reach).unwrap()),
            LANE_HOOK_SHELL_REASON
        );
        // 이 채널 규칙의 꼬리도 막힌다(reach 를 빠뜨려도).
        assert!(decide_tail_hook(&bash("sudo gh pr view 1"), &here, &[]).is_some());
        assert!(decide_tail_hook(&bash("ls"), &here, &reach).is_none());
        assert!(
            decide_tail_hook(&json!({ "tool_name": "Write" }).to_string(), &here, &reach).is_none()
        );
        assert!(decide_tail_hook("{", &here, &reach).is_some());
        assert!(decide_tail_hook("{}", &here, &reach).is_some());
    }

    #[test]
    fn notify_line_only_for_permission_prompt() {
        assert_eq!(
            notify_gate_line(r#"{"notification_type":"permission_prompt"}"#, 1234.9),
            Some("1234\n".into())
        );
        assert_eq!(
            notify_gate_line(r#"{"notification_type":"idle_prompt"}"#, 1.0),
            None
        );
        assert_eq!(notify_gate_line("null", 1.0), None);
        assert_eq!(notify_gate_line("{", 1.0), None);
    }

    #[test]
    fn variable_path_rm_shapes() {
        for c in [
            "rm -rf $DIR/x",
            "cd a; rm \"$P/sub\"",
            "for f in *; do rm $f; done",
            "if x; then\nrm -r ${A}/${B}\nfi",
            "find . | xargs rm $X",
            "sudo rm $Y",
            "command rm -f $Z",
            "(rm $Q)",
        ] {
            assert!(variable_path_rm(c), "{c}");
        }
        for c in [
            "rm -rf /tmp/x",
            "echo rm $x",
            "rm x; echo $y",
            "undo rm $x",
            "dorm $x",
        ] {
            assert!(!variable_path_rm(c), "{c}");
        }
    }

    #[test]
    fn permission_hook_decisions() {
        let c = classify_permission_request(&bash("  rm -rf $T/x")).unwrap();
        assert_eq!(
            (c.kind, c.program.as_deref()),
            (PermissionKind::RmVariablePath, Some("rm"))
        );
        let c = classify_permission_request(&bash("$(x)")).unwrap();
        assert_eq!((c.kind, c.program), (PermissionKind::Other, None));
        let long = "a".repeat(70);
        assert_eq!(
            classify_permission_request(&bash(&long))
                .unwrap()
                .program
                .unwrap()
                .len(),
            64
        );
        assert!(classify_permission_request("null").is_none());
        assert!(classify_permission_request("{}").is_none());
        assert_eq!(
            classify_permission_request(r#"{"tool_name":"Bash"}"#)
                .unwrap()
                .kind,
            PermissionKind::Other
        );

        let ask = json!({ "tool_name": "AskUserQuestion" }).to_string();
        let msg = |d: &Value| {
            d["hookSpecificOutput"]["decision"]["message"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let (_, d) = decide_permission_hook(&ask, 0).unwrap();
        assert_eq!(msg(&d.unwrap()), PERMISSION_ASK_REASON);
        let (_, d) = decide_permission_hook(&bash("rm $X"), 1).unwrap();
        assert_eq!(msg(&d.unwrap()), PERMISSION_RM_REASON);
        let (_, d) = decide_permission_hook(&bash("rm $X"), 2).unwrap();
        assert_eq!(msg(&d.unwrap()), PERMISSION_STOP_REASON);
        let (c, d) = decide_permission_hook(&bash("ls"), 5).unwrap();
        assert_eq!((c.kind.as_str(), d), ("other", None));
    }

    #[test]
    fn counts_turn_denials() {
        let log = [
            json!({ "turn": "t1", "event": "decided", "decision": "deny" }).to_string(),
            json!({ "turn": "t1", "event": "decided", "decision": "none" }).to_string(),
            json!({ "turn": "t2", "event": "decided", "decision": "deny" }).to_string(),
            json!({ "turn": "t1", "event": "hook_error" }).to_string(),
            "{broken".to_string(),
            "null".to_string(),
            json!({ "turn": "t1", "event": "decided", "decision": "deny" }).to_string(),
        ]
        .join("\n");
        assert_eq!(count_turn_denials(&log, "t1"), 2);
        assert_eq!(count_turn_denials("", "t1"), 0);
    }

    /// TS `hookCli.test.ts`·`permissionHook.test.ts` 의 사례를 그대로 옮긴 대조.
    #[test]
    fn ts_parity_cases() {
        let rules_ = rules(&[
            "Bash(gh pr list -R cli/cli --limit 3)",
            "Bash(kubectl --context lab get:*)",
        ]);
        assert!(
            decide_tail_hook(&bash("gh pr list -R cli/cli --limit 3"), &rules_, &rules_).is_none()
        );
        assert!(
            decide_tail_hook(&bash("kubectl --context lab get pods -A"), &rules_, &rules_)
                .is_none()
        );
        for c in ["ls -la", "gh issue list", "cat a.txt | wc -l"] {
            assert!(
                decide_tail_hook(&bash(c), &rules_, &rules_).is_none(),
                "{c}"
            );
        }
        assert!(
            decide_tail_hook(
                &json!({ "tool_name": "apply_patch", "tool_input": {} }).to_string(),
                &rules_,
                &rules_
            )
            .is_none()
        );
        assert_eq!(
            reason(
                &decide_tail_hook(
                    &bash("gh pr list -R cli/cli --limit 3 https://example.com"),
                    &rules_,
                    &rules_
                )
                .unwrap()
            ),
            LANE_HOOK_TAIL_REASON
        );
        for c in [
            "\"gh\" pr list -R cli/cli --limit 3",
            "bash -lc 'gh pr list -R cli/cli --limit 3'",
            "FOO=1 gh pr list -R cli/cli --limit 3",
            "gh  pr  list -R cli/cli --limit 3 x",
            "true && gh pr list -R cli/cli --limit 3",
            "gh pr list -R cli/cli --limit 3 > out.txt",
            "kubectl --context lab get pods; id",
        ] {
            assert!(
                decide_tail_hook(&bash(c), &rules_, &rules_).is_some(),
                "{c}"
            );
        }
        assert_eq!(
            reason(
                &decide_tail_hook(
                    &bash("gh pr list -R cli/cli --limit 3 > out.txt"),
                    &rules_,
                    &rules_
                )
                .unwrap()
            ),
            LANE_HOOK_SHELL_REASON
        );
        assert!(decide_tail_hook("not json", &rules_, &rules_).is_some());
        assert!(
            decide_tail_hook(&json!({ "tool_input": {} }).to_string(), &rules_, &rules_).is_some()
        );
        assert!(decide_tail_hook(&bash("gh pr list -R cli/cli --limit 3 x"), &[], &[]).is_none());
        assert!(!touches_approved_rule(
            &rules(&["Read", "mcp__github"]),
            Some("gh pr list")
        ));

        let a = rules(&["Bash(gh pr list -R cli/cli --limit 3)"]);
        let b = rules(&["Bash(gh run list -R cli/cli --limit 5)"]);
        let union: Vec<String> = a.iter().chain(b.iter()).cloned().collect();
        assert!(decide_tail_hook(&bash("gh pr list -R cli/cli --limit 3"), &b, &union).is_some());
        assert!(decide_tail_hook(&bash("gh run list -R cli/cli --limit 5"), &b, &union).is_none());
        assert!(
            decide_tail_hook(
                &bash("gh run list -R cli/cli --limit 5 --json name"),
                &b,
                &union
            )
            .is_some()
        );
        assert!(decide_tail_hook(&bash("gh run list -R cli/cli --limit 5 x"), &b, &[]).is_some());

        assert!(lane_tool_listed(&rules(&["WebFetch"]), "WebFetch"));
        assert!(!lane_tool_listed(
            &rules(&["WebFetch(domain:example.com)"]),
            "WebFetch"
        ));
        assert!(!lane_bash_allowed(
            &rules(&["Bash(git status:*)"]),
            Some("git statusx")
        ));

        for c in [
            "rm -rf $P/x",
            "cd /a && rm -f \"$D\"/*",
            "for b in a; do rm -rf $P/$b; done",
            "x; rm ${A}/${B}",
        ] {
            assert!(variable_path_rm(c), "{c}");
        }
        for c in [
            "rm -rf /tmp/x",
            "echo $P; rm -rf /tmp/x",
            "git rm --cached file",
            "npm run rmdir $X",
            "rm a | grep $X",
        ] {
            assert!(!variable_path_rm(c), "{c}");
        }
        assert!(
            decide_permission_hook(&bash("rm -rf /tmp/literal/dir"), 0)
                .unwrap()
                .1
                .is_none()
        );
    }
}

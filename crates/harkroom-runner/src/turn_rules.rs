//! 턴 권한 상수와 hook 설정 빌더(`turn.ts` 의 `READONLY_*`·`LANE_*`·`MERGE_DENY_RULES`·`commandHookSettings`·`laneHookSettings`·
//! `settingsArgs` 등, s8 B3d-1). 프리셋·`buildTurnCommand` 가 이것을 argv 에 싣는다(B3d-2).
//!
//! TS 와 다른 점: hook 명령에 박는 오퍼레이터 경로에 셸이 해석하는 글자(`$`·백틱·`"`·`\`·제어 문자)가 있으면 **거절**한다
//! (TS 는 `JSON.stringify` 로 감싸기만 해 큰따옴표 안에서 `$`·백틱이 셸에 풀릴 수 있었다 — #1940 security 낮음).

use std::fmt;
use std::sync::LazyLock;

use base64::Engine;
use harkroom_proto::tool_rules::{ToolRuleVerdict, validate_tool_rule};
use regex::Regex;
use serde_json::{Map, Value, json};

/// 읽기 전용(`dontAsk`) 멘션 턴에 여는 harkroom 도구 이름(접두 `mcp__harkroom__` 앞).
const READONLY_HARKROOM_TOOLS: &[&str] = &[
    "message_post",
    "message_report",
    "message_fail",
    "message_ask",
    "message_progress",
    "message_react",
    "message_unreact",
    "message_read",
    "message_search",
    "thread_note",
    "thread_note_list",
    "thread_plan",
    "thread_plan_item",
    "memory_get",
    "memory_list",
    "memory_search",
    "turn_wake",
    "attachment_fetch",
    "attachment_upload",
    "account_me",
    "account_list",
    "channel_list",
    "channel_doc",
    "workspace_guide",
];

/// `READONLY_ALLOW` — `ToolSearch` 와 이름으로 고른 harkroom 도구. 읽기 내장 도구는 넣지 않는다(security F1).
pub static READONLY_ALLOW: LazyLock<Vec<String>> = LazyLock::new(|| {
    std::iter::once("ToolSearch".to_string())
        .chain(
            READONLY_HARKROOM_TOOLS
                .iter()
                .map(|t| format!("mcp__harkroom__{t}")),
        )
        .collect()
});

/// `READONLY_DENY` — 셸·웹은 통째로 막는다.
pub const READONLY_DENY: &[&str] = &["Bash", "WebFetch", "WebSearch"];

/// `READONLY_TOOLS` — 읽기 전용 턴이 볼 수 있는 내장 도구 목록(못박음, security F1).
pub const READONLY_TOOLS: &[&str] = &["ToolSearch", "Read", "Grep", "Glob"];

/// `READONLY_RULES` — 값은 쉼표로 이은 한 토큰(백그라운드 조립이 정확히 떼어 낸다).
pub static READONLY_RULES: LazyLock<Vec<String>> = LazyLock::new(|| {
    vec![
        "--disallowedTools".into(),
        READONLY_DENY.join(","),
        "--allowedTools".into(),
        READONLY_ALLOW.join(","),
        "--tools".into(),
        READONLY_TOOLS.join(","),
    ]
});

/// `LANE_BASE_ALLOW` — API 키 연결 턴 기본 허용. 쓰기는 경로 규칙으로만, 맨 이름 `Edit`·`Write`·`Read` 는 넣지 않는다.
pub const LANE_BASE_ALLOW: &[&str] = &[
    "ToolSearch",
    "TodoWrite",
    "Edit(./**)",
    "Write(./**)",
    "Agent",
    "Skill",
    "mcp__harkroom",
    "mcp__avcs",
];

/// `LANE_DENY` — 다음 턴의 도구·지시·MCP 를 바꾸는 작업 폴더 파일.
pub const LANE_DENY: &[&str] = &[
    "Edit(./.claude/**)",
    "Write(./.claude/**)",
    "Edit(./CLAUDE.md)",
    "Write(./CLAUDE.md)",
    "Edit(./CLAUDE.local.md)",
    "Write(./CLAUDE.local.md)",
    "Edit(./.mcp.json)",
    "Write(./.mcp.json)",
];

pub const GRANT_DELEGATE_TOOL: &str = "mcp__harkroom__grant_delegate";
pub const PERMISSION_REQUEST_TOOL: &str = "mcp__harkroom__permission_request";

/// `POST_TOOLS` — 구독형 auto 멘션 턴에서 분류기 없이 여는 발화 도구(정확한 이름 넷).
pub const POST_TOOLS: &[&str] = &[
    "mcp__harkroom__message_post",
    "mcp__harkroom__message_report",
    "mcp__harkroom__message_fail",
    "mcp__harkroom__message_progress",
];

/// `MENTION_DENY_TOOLS` — auto 멘션 턴에서 빼는 내장 도구(답할 사람이 없는 선택 화면).
pub const MENTION_DENY_TOOLS: &[&str] = &["AskUserQuestion"];

pub const MERGE_DENY_RULES: &[&str] = &[
    "Bash(gh pr merge:*)",
    "Bash(gh api -X PUT:*)",
    "Bash(gh api --method PUT:*)",
    "Bash(git push origin main)",
    "Bash(git push origin HEAD:main)",
    "Bash(git push -u origin main)",
    "Bash(git push --force origin main)",
];

pub const SETTINGS_SELF_EDIT_DENY_RULES: &[&str] = &[
    "Edit(**/.claude/settings.json)",
    "Edit(**/.claude/settings.local.json)",
];

/// `configSettingsDenyRules` — 계정 config 의 settings.json(security R2). 절대 경로는 `//` 로 시작한다(claude 문법).
pub fn config_settings_deny_rules(claude_config_dir: Option<&str>) -> Vec<String> {
    match claude_config_dir {
        None => vec![
            "Edit(~/.claude/settings.json)".into(),
            "Edit(~/.claude/settings.local.json)".into(),
        ],
        Some(dir) => {
            let abs = dir.trim_end_matches('/');
            vec![
                format!("Edit(/{abs}/settings.json)"),
                format!("Edit(/{abs}/settings.local.json)"),
            ]
        }
    }
}

/// `safeToolAllows` — 서버와 같은 판정(`validate_tool_rule`)에서 정규형 그대로인 것만 남긴다.
pub fn safe_tool_allows<S: AsRef<str>>(rules: &[S]) -> Vec<String> {
    rules
        .iter()
        .map(AsRef::as_ref)
        .filter(|r| matches!(validate_tool_rule(r), ToolRuleVerdict::Ok { rule, .. } if rule == *r))
        .map(str::to_string)
        .collect()
}

/// shared `LANE_HOOK_RULE`(오퍼레이터 `hook_run` 과 같은 식).
static LANE_HOOK_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$").expect("정규식"));

/// shared `encodeLaneHookRules` — 꼴이 맞는 규칙만 JSON 배열로, base64url(패딩 없음).
pub fn encode_lane_hook_rules<S: AsRef<str>>(rules: &[S]) -> String {
    let kept: Vec<&str> = rules
        .iter()
        .map(AsRef::as_ref)
        .filter(|r| LANE_HOOK_RULE.is_match(r))
        .collect();
    let body = serde_json::to_string(&kept).expect("문자열 배열");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body)
}

/// hook 설정 조립 거절. 경로 값은 싣지 않는다(로그·화면으로 새지 않게).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnRulesError {
    /// 오퍼레이터 경로에 셸이 해석하는 글자가 있다.
    UnsafeOperatorPath,
    /// 앞 설정(`pre_settings`)이 JSON 객체가 아니다.
    BadPreSettings,
}

impl fmt::Display for TurnRulesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsafeOperatorPath => f.write_str("operator path has shell-unsafe characters"),
            Self::BadPreSettings => f.write_str("pre-settings is not a JSON object"),
        }
    }
}

impl std::error::Error for TurnRulesError {}

/// hook 명령에 넣을 오퍼레이터 경로 — 큰따옴표로 감싼다(TS `JSON.stringify` 와 같은 글자). 큰따옴표 안에서도 셸이 푸는
/// `$`·백틱·`"`·`\` 와 제어 문자(개행 포함)는 거절한다.
fn quoted_operator(operator_bin: &str) -> Result<String, TurnRulesError> {
    if operator_bin.is_empty()
        || operator_bin
            .chars()
            .any(|c| matches!(c, '$' | '`' | '"' | '\\') || c.is_control())
    {
        return Err(TurnRulesError::UnsafeOperatorPath);
    }
    Ok(format!("\"{operator_bin}\""))
}

fn hook_entry(matcher: &str, command: String) -> Value {
    json!({ "matcher": matcher, "hooks": [{ "type": "command", "command": command, "timeout": 15 }] })
}

/// `commandHookSettings` — 「정확한 명령」 PreToolUse hook(Bash 에만).
pub fn command_hook_settings(operator_bin: &str) -> Result<String, TurnRulesError> {
    let command = format!("{} hook pretool", quoted_operator(operator_bin)?);
    Ok(json!({ "hooks": { "PreToolUse": [hook_entry("Bash", command)] } }).to_string())
}

/// `laneHookSettings` — API 키 연결 턴의 PreToolUse hook(모든 도구). hook 이 죽으면 차단 종료 2.
pub fn lane_hook_settings<S: AsRef<str>>(
    operator_bin: &str,
    allow_rules: &[S],
) -> Result<String, TurnRulesError> {
    let command = format!(
        "{} hook pretool --lane {} || exit 2",
        quoted_operator(operator_bin)?,
        encode_lane_hook_rules(allow_rules)
    );
    Ok(json!({ "hooks": { "PreToolUse": [hook_entry("*", command)] } }).to_string())
}

/// `postToolHookEntry` — 턴 도중 새 글 hook. 음수는 0(TS: 안전 정수 아니면 0).
pub fn post_tool_hook_entry(operator_bin: &str, since_seq: i64) -> Result<Value, TurnRulesError> {
    let since = since_seq.max(0);
    Ok(hook_entry(
        "*",
        format!(
            "{} hook posttool --since {since}",
            quoted_operator(operator_bin)?
        ),
    ))
}

/// `permissionRequestHookEntry` — 하네스 물음 hook.
pub fn permission_request_hook_entry(operator_bin: &str) -> Result<Value, TurnRulesError> {
    Ok(hook_entry(
        "*",
        format!("{} hook permission", quoted_operator(operator_bin)?),
    ))
}

/// `notificationHookEntry` — 「확인을 기다려 멈춤」 신호 hook.
pub fn notification_hook_entry(operator_bin: &str) -> Result<Value, TurnRulesError> {
    Ok(hook_entry(
        "*",
        format!("{} hook notify", quoted_operator(operator_bin)?),
    ))
}

fn parse_object(pre: Option<&str>) -> Result<Map<String, Value>, TurnRulesError> {
    match pre {
        None => Ok(Map::new()),
        Some(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(m)) => Ok(m),
            _ => Err(TurnRulesError::BadPreSettings),
        },
    }
}

/// `{...base, hooks: {...base.hooks, ...add}}` — 있던 키 자리는 그대로, 새 키는 뒤에.
fn merge_hooks(
    mut base: Map<String, Value>,
    add: Vec<(&str, Value)>,
) -> Result<String, TurnRulesError> {
    let mut hooks = match base.get("hooks") {
        Some(Value::Object(h)) => h.clone(),
        _ => Map::new(),
    };
    for (k, v) in add {
        hooks.insert(k.to_string(), v);
    }
    base.insert("hooks".into(), Value::Object(hooks));
    Ok(Value::Object(base).to_string())
}

/// `withPostToolHook`.
pub fn with_post_tool_hook(
    pre_settings: Option<&str>,
    operator_bin: &str,
    since_seq: i64,
) -> Result<String, TurnRulesError> {
    let entry = post_tool_hook_entry(operator_bin, since_seq)?;
    merge_hooks(
        parse_object(pre_settings)?,
        vec![("PostToolUse", json!([entry]))],
    )
}

/// `settingsArgs` — PreToolUse 설정에 새 글 hook·물음 hook 을 합쳐 한 장의 `--settings` 로. 아무것도 없으면 빈 배열.
pub fn settings_args(
    pre_settings: Option<&str>,
    operator_bin: &str,
    post_tool_since_seq: Option<i64>,
    permission_hook: bool,
) -> Result<Vec<String>, TurnRulesError> {
    if post_tool_since_seq.is_none() && !permission_hook {
        return Ok(pre_settings
            .map(|s| vec!["--settings".to_string(), s.to_string()])
            .unwrap_or_default());
    }
    let merged = match post_tool_since_seq {
        Some(seq) => Some(with_post_tool_hook(pre_settings, operator_bin, seq)?),
        None => pre_settings.map(str::to_string),
    };
    if !permission_hook {
        return Ok(vec!["--settings".into(), merged.expect("post 있음")]);
    }
    let out = merge_hooks(
        parse_object(merged.as_deref())?,
        vec![
            (
                "PermissionRequest",
                json!([permission_request_hook_entry(operator_bin)?]),
            ),
            (
                "Notification",
                json!([notification_hook_entry(operator_bin)?]),
            ),
        ],
    )?;
    Ok(vec!["--settings".into(), out])
}

#[cfg(test)]
#[path = "turn_rules_tests.rs"]
mod tests;

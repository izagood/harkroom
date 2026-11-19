//! S5.4 — MCP `permission.request`(권한 요청 111) 의 **거절 앞머리**만 Rust 가 답한다. TS `mcpPlugin.ts` 의 같은 도구와
//! `services/permissionRequests.ts::openPermissionRequest`, shared `validateToolRule`·`repoScope`·`repoGrantScope` 의 거절을
//! 같은 순서·같은 글자로 옮긴다:
//! 인자(zod) → `not_agent`(계정 kind) → `forbidden`(채널 보임) → `bad_request`(kind 와 인자 짝) → `not_agent`(agent_config 줄) →
//! kind=tool: `empty` → `dangerous_flag` → mcp 꼴(`mcp__harkroom__*` 는 `unsupported_tool`) → `unsupported_tool` → `too_broad` →
//! `wildcard` → `shell_syntax` → `bad_chars` → `interpreter` → `operator_wrapper` → `too_broad`(접두 낱말 하나) /
//! kind=merge: `org_wide` → `bad_repo`.
//!
//! **이 묶음은 아무것도 쓰지 않는다** — TS 도 이 거절들에서는 쓰지 않는다(감사 줄 없음). 그래서 쓰기 권한 표가 없고 읽기 풀로만 답한다.
//!
//! - **TS 로 넘기는 것**(`None`): zod 가 받지 않을 인자 · kind=command 전부(`openCommandRequest`) · 받아들여지는 규칙·저장소
//!   (이미 있는 grant·기다리는 요청·하루 상한·요청 줄·카드 글은 TS) · 머리가 `gh`·`git` 인 Bash 규칙(`checkGh`·`checkGitPush`) ·
//!   ASCII 밖 글자가 든 규칙·저장소(JS `trim`·`toLowerCase` 와 맞추지 않는다) · DB 오류.
use super::tools::err;
use crate::auth::Account;
use crate::core::cause_link::MODEL_ID_MAX;
use crate::core::channels::is_uuid;
use serde_json::Value;
use sqlx::PgPool;

const AGENT_SQL: &str = "select 1 from account a join agent_config c on c.account_id = a.id \
     where a.id = $1::uuid and a.kind = 'agent'";

/// shared `INTERPRETERS`.
const INTERPRETERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "env",
    "sudo",
    "su",
    "doas",
    "xargs",
    "eval",
    "exec",
    "command",
    "builtin",
    "nohup",
    "time",
    "timeout",
    "nice",
    "watch",
    "script",
    "osascript",
    "open",
    "python",
    "python3",
    "node",
    "deno",
    "bun",
    "ruby",
    "perl",
    "php",
    "lua",
    "npx",
    "pnpx",
    "bunx",
    "uvx",
    "caffeinate",
    "stdbuf",
    "unbuffer",
    "chroot",
    "setsid",
    "flock",
    "busybox",
    "strace",
    "ltrace",
    "gdb",
    "lldb",
    "expect",
    "ionice",
    "taskset",
    "pkexec",
    "runuser",
    "systemd-run",
    "launchctl",
    "arch",
    "chronic",
    "doppler",
    "op",
];
/// shared `INTERPRETER_VERSIONED` 의 머리(소문자 — 판정 앞에 머리를 소문자로 바꾼다).
const INTERPRETER_VERSIONED: &[&str] = &[
    "python",
    "node",
    "ruby",
    "perl",
    "php",
    "lua",
    "luajit",
    "pwsh",
    "powershell",
    "bash",
    "zsh",
    "ksh",
    "tclsh",
    "wish",
    "irb",
    "jshell",
    "r",
    "rscript",
];

#[derive(Debug, PartialEq)]
enum Kind {
    Tool,
    Merge,
    Command,
}

#[derive(Debug, PartialEq)]
struct Args<'a> {
    kind: Kind,
    rule: Option<&'a str>,
    command: Option<&'a str>,
    repo: Option<&'a str>,
    channel_id: &'a str,
}

fn utf16_in(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.encode_utf16().count())
}

/// zod `z.string().min(min).max(max).optional()` — 없으면 `Some(None)`, 틀린 꼴이면 `None`.
fn opt_str<'a>(
    o: &'a serde_json::Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Option<Option<&'a str>> {
    match o.get(key) {
        None => Some(None),
        Some(v) => v.as_str().filter(|s| utf16_in(s, min, max)).map(Some),
    }
}

fn parse(args: &Value) -> Option<Args<'_>> {
    let o = args.as_object()?;
    let kind = match o.get("kind")?.as_str()? {
        "tool" => Kind::Tool,
        "merge" => Kind::Merge,
        "command" => Kind::Command,
        _ => return None,
    };
    let rule = opt_str(o, "rule", 1, 300)?;
    let command = opt_str(o, "command", 1, 300)?;
    let repo = opt_str(o, "repo", 3, 201)?;
    if !o
        .get("reason")?
        .as_str()
        .is_some_and(|s| utf16_in(s, 1, 500))
    {
        return None;
    }
    let channel_id = o.get("channelId")?.as_str().filter(|s| is_uuid(s))?;
    o.get("threadRootId")?.as_str().filter(|s| is_uuid(s))?;
    opt_str(o, "model", 1, MODEL_ID_MAX)?;
    Some(Args {
        kind,
        rule,
        command,
        repo,
        channel_id,
    })
}

/// shared `RULE_REFUSAL_MESSAGE` 중 Rust 가 내는 것.
fn rule_message(code: &str) -> &'static str {
    match code {
        "empty" => "rule is empty",
        "unsupported_tool" => {
            "only Bash(<command prefix>:*), Bash(<exact command>) or one non-harkroom mcp__<server>__<tool> can be requested"
        }
        "wildcard" => "a wildcard is only allowed as the trailing :* of a Bash prefix",
        "too_broad" => {
            "rule is too broad — name the command with at least two fixed words before :*"
        }
        "shell_syntax" => "rule must be one command — no ; & | ` > < $( or newlines",
        "dangerous_flag" => "--dangerously-* flags are never granted",
        "interpreter" => {
            "a shell, interpreter or command runner as the first word would allow anything"
        }
        "operator_wrapper" => "the harkroom-operator wrapper is opened by the runner itself",
        "bad_chars" => {
            "rule may only use letters, digits, spaces and _ . / @ = : + % - — no quotes, backslashes, brackets or commas"
        }
        _ => unreachable!("rule_message {code}"),
    }
}

/// `/^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i` — 칸 글자에 `_` 가 들어 있어 JS 처럼 되짚어 맞춘다.
fn mcp_rule(rule: &str) -> bool {
    let ok = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let b = rule.as_bytes();
    if b.len() < 5 || !b[..5].eq_ignore_ascii_case(b"mcp__") {
        return false;
    }
    let rest = &b[5..];
    if !rest.iter().all(|c| ok(*c)) {
        return false;
    }
    // 어느 `__` 에서 갈라도 앞뒤가 비지 않으면 맞는다.
    (1..rest.len().saturating_sub(2)).any(|i| rest[i] == b'_' && rest[i + 1] == b'_')
}

/// shared `validateToolRule` 의 거절 앞머리. `Some(code)` 거절, `None` 은 TS 몫(받아들여지거나 gh·git·ASCII 밖).
fn tool_refusal(input: &str) -> Option<&'static str> {
    if !input.is_ascii() {
        return None;
    }
    let rule = input.trim_matches(|c: char| c.is_ascii_whitespace() || c == '\x0b');
    if rule.is_empty() {
        return Some("empty");
    }
    // TOOL_RULE_MAX_CHARS(300) — zod 가 이미 300 까지만 받는다.
    if rule.to_ascii_lowercase().contains("--dangerously") {
        return Some("dangerous_flag");
    }
    if mcp_rule(rule) {
        if rule.to_ascii_lowercase().starts_with("mcp__harkroom__") {
            return Some("unsupported_tool");
        }
        return None;
    }
    let Some(body) = rule.strip_prefix("Bash(").and_then(|r| r.strip_suffix(')')) else {
        return Some("unsupported_tool");
    };
    let ws = |c: char| c.is_ascii_whitespace() || c == '\x0b';
    let mut body = body.trim_matches(ws);
    let prefix = body.ends_with(":*");
    if prefix {
        body = body[..body.len() - 2].trim_matches(ws);
    }
    if body.is_empty() || body == "*" {
        return Some("too_broad");
    }
    if body.contains('*') {
        return Some("wildcard");
    }
    if body.contains([';', '&', '|', '`', '<', '>', '\n', '\r'])
        || body.contains("$(")
        || body.contains("${")
    {
        return Some("shell_syntax");
    }
    if !body
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b" _./@=:+%-".contains(&c))
    {
        return Some("bad_chars");
    }
    let words: Vec<&str> = body.split(' ').filter(|w| !w.is_empty()).collect();
    let head = words[0]
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let versioned = INTERPRETER_VERSIONED.iter().any(|p| {
        head.strip_prefix(p)
            .is_some_and(|t| t.bytes().all(|c| c.is_ascii_digit() || c == b'.'))
    });
    if INTERPRETERS.contains(&head.as_str()) || versioned {
        return Some("interpreter");
    }
    if body.to_ascii_lowercase().contains("harkroom-operator") {
        return Some("operator_wrapper");
    }
    if prefix && words.len() < 2 {
        return Some("too_broad");
    }
    // gh·git 은 `checkGh`·`checkGitPush`(TS), 그 밖은 받아들여진다 — 둘 다 TS 몫이다.
    None
}

fn owner_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 100
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| name_char(*c))
}
fn name_char(c: u8) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
}

/// shared `repoGrantScope`·`repoScope` 순서의 거절. `Some(code)` 거절, `None` 은 TS 몫(받아들여지거나 ASCII 밖).
fn repo_refusal(repo: &str) -> Option<&'static str> {
    if !repo.is_ascii() {
        return None;
    }
    let s = repo
        .trim_matches(|c: char| c.is_ascii_whitespace() || c == '\x0b')
        .to_ascii_lowercase();
    let (exact, org) = match s.split_once('/') {
        Some((o, n)) if owner_ok(o) => (
            !n.is_empty() && n.len() <= 100 && n.bytes().all(name_char),
            n == "*",
        ),
        _ => (false, false),
    };
    if org {
        return Some("org_wide");
    }
    if !exact {
        return Some("bad_repo");
    }
    None
}

pub async fn answer(read: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    if me.kind != "agent" {
        return Some(err("not_agent", "only an agent can request a permission"));
    }
    if !crate::core::msg_read::channel_visible(read, &me.id, a.channel_id)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    if (a.kind == Kind::Tool) != a.rule.is_some()
        || (a.kind == Kind::Merge) != a.repo.is_some()
        || (a.kind == Kind::Command) != a.command.is_some()
    {
        return Some(err(
            "bad_request",
            "kind \"tool\" takes `rule`, kind \"merge\" takes `repo`, kind \"command\" takes `command` — exactly one",
        ));
    }
    // TS `raisePermission` 의 `mandateForAgentPost` 는 읽기뿐이고 거절을 내지 않는다.
    let agent: Option<i32> = sqlx::query_scalar(AGENT_SQL)
        .bind(&me.id)
        .fetch_optional(read)
        .await
        .ok()?;
    if agent.is_none() {
        return Some(err("not_agent", "only an agent can request a permission"));
    }
    match a.kind {
        Kind::Command => None,
        Kind::Tool => tool_refusal(a.rule?).map(|c| err(c, rule_message(c))),
        Kind::Merge => repo_refusal(a.repo?).map(|c| match c {
            "org_wide" => err(
                c,
                "an organization-wide grant (owner/*) is not requested from a card — ask for the one repository, or ask the owner to grant owner/* in settings",
            ),
            _ => err(c, "repo must be one <owner>/<name>"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "11111111-1111-1111-1111-111111111111";

    #[test]
    fn parse_matches_zod() {
        let ok = json!({ "kind": "tool", "rule": "Bash(ls)", "reason": "r", "channelId": C, "threadRootId": C });
        assert!(parse(&ok).is_some());
        for bad in [
            json!({ "kind": "x", "reason": "r", "channelId": C, "threadRootId": C }),
            json!({ "kind": "tool", "rule": "", "reason": "r", "channelId": C, "threadRootId": C }),
            json!({ "kind": "tool", "rule": null, "reason": "r", "channelId": C, "threadRootId": C }),
            json!({ "kind": "merge", "repo": "ab", "reason": "r", "channelId": C, "threadRootId": C }),
            json!({ "kind": "tool", "reason": "", "channelId": C, "threadRootId": C }),
            json!({ "kind": "tool", "reason": "r", "channelId": "x", "threadRootId": C }),
            json!({ "kind": "tool", "reason": "r", "channelId": C }),
            json!({ "kind": "tool", "reason": "r", "channelId": C, "threadRootId": C, "model": "" }),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn tool_refusals_follow_shared() {
        for (rule, want) in [
            ("   ", Some("empty")),
            ("Bash(kubectl get --DANGEROUSLY-x)", Some("dangerous_flag")),
            ("mcp__harkroom__message_post", Some("unsupported_tool")),
            ("MCP__HarkRoom__x", Some("unsupported_tool")),
            ("mcp__github__get_pr", None),
            ("mcp__a_b__c", None),
            ("mcp____x", Some("unsupported_tool")),
            ("Read(/etc)", Some("unsupported_tool")),
            ("Bash(*)", Some("too_broad")),
            ("Bash(:*)", Some("too_broad")),
            ("Bash()", Some("too_broad")),
            ("Bash(ls *)", Some("wildcard")),
            ("Bash(ls; rm)", Some("shell_syntax")),
            ("Bash(ls && rm)", Some("shell_syntax")),
            ("Bash(echo $(id))", Some("shell_syntax")),
            ("Bash(ls \"x\")", Some("bad_chars")),
            ("Bash(ls, rm)", Some("bad_chars")),
            ("Bash(bash -c x)", Some("interpreter")),
            ("Bash(/usr/bin/python3.12 x)", Some("interpreter")),
            ("Bash(Rscript x)", Some("interpreter")),
            ("Bash(node22 x)", Some("interpreter")),
            ("Bash(kubectl harkroom-operator)", Some("operator_wrapper")),
            ("Bash(kubectl:*)", Some("too_broad")),
            ("Bash(kubectl get:*)", None),
            ("Bash(gh pr merge 1)", None),
            ("Bash(git push origin main)", None),
            ("Bash(ls é)", None),
        ] {
            assert_eq!(tool_refusal(rule), want, "{rule}");
        }
    }

    #[test]
    fn repo_refusals_follow_shared() {
        for (repo, want) in [
            ("Izagood/*", Some("org_wide")),
            ("a/b", None),
            (" Izagood/Harkroom ", None),
            ("*/*", Some("bad_repo")),
            ("owner", Some("bad_repo")),
            ("a/b/c", Some("bad_repo")),
            ("-a/b", Some("bad_repo")),
            ("a/b*", Some("bad_repo")),
        ] {
            assert_eq!(repo_refusal(repo), want, "{repo}");
        }
    }

    #[test]
    fn messages_follow_ts() {
        let ts = include_str!("../../../../../packages/server/src/services/permissionRequests.ts");
        for c in [
            "empty",
            "unsupported_tool",
            "wildcard",
            "too_broad",
            "shell_syntax",
            "dangerous_flag",
            "interpreter",
            "operator_wrapper",
            "bad_chars",
        ] {
            assert!(
                ts.contains(&format!("  {c}: '{}',", rule_message(c))),
                "{c}"
            );
        }
        let shared = include_str!("../../../../../packages/shared/src/toolRules.ts");
        for w in INTERPRETERS {
            assert!(shared.contains(&format!("'{w}'")), "{w}");
        }
        assert!(shared.contains("const SHELL_SYNTAX = /[;&|`<>\\n\\r]|\\$\\(|\\$\\{/;"));
        assert!(shared.contains("const BODY_CHARS = /^[A-Za-z0-9 _./@=:+%-]+$/;"));
    }
}

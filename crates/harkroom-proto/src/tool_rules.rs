//! shared `toolRules.ts` 의 `validateToolRule`·`validateExactCommand` 이식. 오퍼레이터(s21b-3b)에서 옮겼다 — 러너의 codex 규칙 파일
//! (`codexRulesFile`)·턴 규칙 거르기도 서버·hook 과 **같은 판정**을 써야 해서다. TS 정본과의 일치는 오퍼레이터
//! `golden/tool_rules.json` 시험이 고정한다(오퍼레이터가 이 모듈을 다시 내보낸다).

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

pub const TOOL_RULE_MAX_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleKind {
    BashPrefix,
    BashExact,
    McpTool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolRuleVerdict {
    Ok {
        rule: String,
        kind: RuleKind,
        warnings: Vec<&'static str>,
    },
    Refused(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandFileArg {
    pub path: String,
    pub flag: String,
    pub secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExactCommandVerdict {
    Ok {
        command: String,
        warnings: Vec<&'static str>,
        files: Vec<CommandFileArg>,
    },
    Refused(&'static str),
}

fn re(s: &str) -> Regex {
    Regex::new(s).expect("고정 정규식")
}

static BODY_CHARS: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9 _./@=:+%-]+$"));
static INTERPRETER_VERSIONED: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^(python|node|ruby|perl|php|lua|luajit|pwsh|powershell|bash|zsh|ksh|tclsh|wish|irb|jshell|R|Rscript)[\d.]*$",
    )
});
static SHELL_SYNTAX: LazyLock<Regex> = LazyLock::new(|| re(r"[;&|`<>\n\r]|\$\(|\$\{"));
static MCP_TOOL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^mcp__[a-z0-9_-]+__[a-z0-9_-]+$"));
static POS_FLAG: LazyLock<Regex> = LazyLock::new(|| re(r"^-[A-Za-z]$|^--[a-z-]+$"));
static GH_WRITE_FLAG: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(-X|--method)|^-[fF]|^--(field|raw-field|input)"));
static PROTECTED_REF: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)(^|[:+])(main|master|head)$|refs/heads/|^:"));
static MAIN_PART: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(main|master|head)$"));
static FIND_EXEC: LazyLock<Regex> = LazyLock::new(|| re(r"^-(exec|execdir|ok|okdir)$"));
static ENV_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z_][A-Za-z0-9_]*="));
static OCI_CHART: LazyLock<Regex> = LazyLock::new(|| re(r"^oci://[^/]+/."));
static SHORT_FLAG: LazyLock<Regex> = LazyLock::new(|| re(r"^-[A-Za-z]$"));

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

const CONTAINER_MUTATE: &[&str] = &[
    "rm", "rmi", "kill", "stop", "restart", "start", "pause", "unpause", "update", "create",
    "push", "prune",
];
const COMPOSE_MUTATE: &[&str] = &[
    "up", "down", "rm", "stop", "restart", "start", "kill", "pause", "unpause", "create", "push",
    "build",
];
const CONTAINER_EXEC: &[&str] = &["exec", "run", "cp", "attach"];
const COMPOSE_EXEC: &[&str] = &["exec", "run", "cp", "attach"];

fn exec_subcommands(head: &str) -> Option<&'static [&'static str]> {
    Some(match head {
        "kubectl" => &[
            "exec",
            "debug",
            "attach",
            "cp",
            "port-forward",
            "proxy",
            "run",
        ],
        "oc" => &["exec", "debug", "rsh", "cp", "port-forward"],
        "docker" | "podman" | "nerdctl" => CONTAINER_EXEC,
        "docker-compose" | "podman-compose" => COMPOSE_EXEC,
        "ssh" => &["*"],
        _ => return None,
    })
}

fn mutate_subcommands(head: &str) -> Option<&'static [&'static str]> {
    Some(match head {
        "kubectl" => &[
            "delete", "apply", "patch", "edit", "replace", "scale", "drain", "cordon", "uncordon",
            "rollout", "annotate", "label", "create", "set", "taint",
        ],
        "helm" => &[
            "install",
            "upgrade",
            "uninstall",
            "rollback",
            "delete",
            "test",
        ],
        "git" => &["push"],
        "gh" => &[
            "api", "workflow", "release", "repo", "secret", "variable", "label", "issue",
        ],
        "terraform" => &[
            "apply",
            "destroy",
            "import",
            "taint",
            "untaint",
            "force-unlock",
        ],
        "docker" | "podman" | "nerdctl" => CONTAINER_MUTATE,
        "docker-compose" | "podman-compose" => COMPOSE_MUTATE,
        "rm" => &["*"],
        _ => return None,
    })
}

type Nested = (
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
);

fn nested_subcommands(head: &str) -> Option<&'static [Nested]> {
    const DOCKER: &[Nested] = &[
        ("compose", COMPOSE_EXEC, COMPOSE_MUTATE),
        ("stack", &[], &["deploy", "up", "rm", "remove", "down"]),
        (
            "service",
            &[],
            &["create", "update", "scale", "rollback", "rm", "remove"],
        ),
        (
            "swarm",
            &[],
            &[
                "init",
                "join",
                "leave",
                "update",
                "unlock",
                "join-token",
                "ca",
            ],
        ),
    ];
    const PODMAN: &[Nested] = &[
        ("compose", COMPOSE_EXEC, COMPOSE_MUTATE),
        ("machine", &["ssh"], &[]),
    ];
    const NERDCTL: &[Nested] = &[("compose", COMPOSE_EXEC, COMPOSE_MUTATE)];
    const TERRAFORM: &[Nested] = &[("state", &[], &["rm", "mv", "push", "replace-provider"])];
    Some(match head {
        "docker" => DOCKER,
        "podman" => PODMAN,
        "nerdctl" => NERDCTL,
        "terraform" => TERRAFORM,
        _ => return None,
    })
}

const GH_READ_ACTIONS: &[&str] = &["list", "view", "status", "diff", "checks"];

fn gh_write_actions(sub: &str) -> Option<&'static [&'static str]> {
    Some(match sub {
        "pr" => &[
            "create",
            "comment",
            "close",
            "edit",
            "reopen",
            "ready",
            "review",
            "lock",
            "unlock",
            "revert",
            "update-branch",
        ],
        "run" => &["rerun", "cancel", "delete"],
        _ => return None,
    })
}

/// JS `String.prototype.trim` — 공백류와 BOM.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn positionals(words: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 1;
    while i < words.len() {
        let w = words[i];
        if w.starts_with('-') {
            if !w.contains('=')
                && POS_FLAG.is_match(w)
                && i + 1 < words.len()
                && !words[i + 1].starts_with('-')
            {
                i += 1;
            }
            i += 1;
            continue;
        }
        out.push(w.to_string());
        i += 1;
    }
    out
}

fn gh_writes(words: &[&str], pos: &[String]) -> bool {
    words.iter().any(|w| GH_WRITE_FLAG.is_match(w))
        || pos.iter().any(|w| w.to_lowercase() == "graphql")
}

fn check_gh(words: &[&str], prefix: bool) -> Option<&'static str> {
    if words.iter().any(|w| w.to_lowercase().contains("merge")) {
        return Some("merge_bypass");
    }
    let pos = positionals(words);
    let p0 = pos.first().map(String::as_str);
    if matches!(p0, Some("alias" | "extension" | "ext")) {
        return Some("merge_bypass");
    }
    if p0 == Some("repo") && pos.get(1).map(String::as_str) == Some("sync") {
        return Some("merge_bypass");
    }
    if p0 == Some("api") {
        if prefix {
            return Some("gh_api_write");
        }
        return gh_writes(words, &pos).then_some("gh_api_write");
    }
    if prefix && pos.len() < 2 {
        return Some("too_broad");
    }
    None
}

fn check_git_push(words: &[&str], prefix: bool) -> Option<&'static str> {
    if !positionals(words).iter().any(|w| w == "push") {
        return None;
    }
    if prefix {
        return Some("merge_bypass");
    }
    if words.iter().any(|w| *w == "--all" || *w == "--mirror") {
        return Some("merge_bypass");
    }
    let at = words.iter().position(|w| *w == "push")?;
    let after: Vec<&str> = words[at + 1..]
        .iter()
        .copied()
        .filter(|w| !w.starts_with('-'))
        .collect();
    let refs = after.get(1..).unwrap_or(&[]);
    if refs.is_empty() {
        return Some("merge_bypass");
    }
    refs.iter()
        .any(|r| {
            r.contains('@')
                || PROTECTED_REF.is_match(r)
                || r.split(':').any(|p| MAIN_PART.is_match(p))
        })
        .then_some("merge_bypass")
}

fn runs_arbitrary(head: &str, sub: Option<&str>, words: &[&str]) -> bool {
    const ARB: &[&str] = &[
        "awk", "gawk", "sed", "make", "just", "ssh", "tmux", "screen", "rsync", "parallel", "vim",
        "vi", "nvim", "emacs", "java", "sqlite3", "tar",
    ];
    if ARB.contains(&head) {
        return true;
    }
    if head == "git" && sub == Some("config") {
        return true;
    }
    if head == "find" && words.iter().any(|w| FIND_EXEC.is_match(w)) {
        return true;
    }
    if head == "find" {
        return true;
    }
    if head == "git" && words.contains(&"-c") {
        return true;
    }
    const PKG: &[&str] = &[
        "uv", "npm", "pnpm", "yarn", "cargo", "go", "poetry", "pipenv", "bundle", "mvn", "gradle",
    ];
    PKG.contains(&head) && matches!(sub, Some("run" | "exec" | "x" | "dlx" | "test" | "install"))
}

fn subcommand_of<'a>(words: &[&'a str]) -> Option<&'a str> {
    let mut i = 1;
    while i < words.len() {
        let w = words[i];
        if w.starts_with('-') {
            if !w.contains('=') && i + 1 < words.len() && !words[i + 1].starts_with('-') {
                i += 1;
            }
            i += 1;
            continue;
        }
        return Some(w);
    }
    None
}

fn hits(subs: Option<&[&str]>, sub: Option<&str>) -> bool {
    let Some(subs) = subs else { return false };
    subs.contains(&"*") || sub.is_some_and(|s| subs.contains(&s))
}

fn gh_mutates(words: &[&str], prefix: bool) -> bool {
    let pos = positionals(words);
    let p0 = pos.first().map(String::as_str).unwrap_or("");
    if let Some(writes) = gh_write_actions(p0) {
        return words[1..].iter().any(|w| writes.contains(w));
    }
    if !hits(mutate_subcommands("gh"), pos.first().map(String::as_str)) {
        return false;
    }
    if p0 == "api" {
        if prefix {
            return true;
        }
        return gh_writes(words, &pos);
    }
    prefix || !GH_READ_ACTIONS.contains(&pos.get(1).map(String::as_str).unwrap_or(""))
}

pub fn validate_tool_rule(input: &str) -> ToolRuleVerdict {
    use ToolRuleVerdict::Refused;
    let rule = js_trim(input);
    if rule.is_empty() {
        return Refused("empty");
    }
    if rule.encode_utf16().count() > TOOL_RULE_MAX_CHARS {
        return Refused("too_long");
    }
    if rule.to_lowercase().contains("--dangerously") {
        return Refused("dangerous_flag");
    }
    if MCP_TOOL.is_match(rule) {
        if rule.to_lowercase().starts_with("mcp__harkroom__") {
            return Refused("unsupported_tool");
        }
        return ToolRuleVerdict::Ok {
            rule: rule.to_string(),
            kind: RuleKind::McpTool,
            warnings: vec![],
        };
    }
    let Some(inner) = rule.strip_prefix("Bash(").and_then(|r| r.strip_suffix(')')) else {
        return Refused("unsupported_tool");
    };
    let mut body = js_trim(inner);
    let prefix = body.ends_with(":*");
    if prefix {
        body = js_trim(&body[..body.len() - 2]);
    }
    if body.is_empty() || body == "*" {
        return Refused("too_broad");
    }
    if body.contains('*') {
        return Refused("wildcard");
    }
    if SHELL_SYNTAX.is_match(body) {
        return Refused("shell_syntax");
    }
    if !BODY_CHARS.is_match(body) {
        return Refused("bad_chars");
    }
    let words: Vec<&str> = body.split(' ').filter(|w| !w.is_empty()).collect();
    let head = words[0].rsplit('/').next().unwrap_or("").to_lowercase();
    let head = head.as_str();
    if INTERPRETERS.contains(&head) || INTERPRETER_VERSIONED.is_match(head) {
        return Refused("interpreter");
    }
    if body.to_lowercase().contains("harkroom-operator") {
        return Refused("operator_wrapper");
    }
    let sub = subcommand_of(&words);
    if prefix && words.len() < 2 {
        return Refused("too_broad");
    }
    if head == "gh"
        && let Some(c) = check_gh(&words, prefix)
    {
        return Refused(c);
    }
    if head == "git"
        && let Some(c) = check_git_push(&words, prefix)
    {
        return Refused(c);
    }

    let mut warnings = Vec::new();
    let risky = head != "gh"
        && (exec_subcommands(head).is_some()
            || mutate_subcommands(head).is_some()
            || nested_subcommands(head).is_some());
    let bare: Vec<(usize, &str)> = if risky {
        words
            .iter()
            .enumerate()
            .filter(|(i, w)| *i > 0 && !w.starts_with('-'))
            .map(|(i, w)| (i, *w))
            .collect()
    } else {
        vec![]
    };
    let any_in = |list: Option<&[&str]>, from: usize| -> bool {
        list.is_some_and(|l| {
            l.contains(&"*") || bare.iter().any(|(i, w)| *i >= from && l.contains(w))
        })
    };
    let (mut nested_exec, mut nested_mutate, mut nested_unpinned) = (false, false, false);
    if risky {
        for (key, exec, mutate) in nested_subcommands(head).unwrap_or(&[]) {
            let Some(&(at, _)) = bare.iter().find(|(_, w)| w == key) else {
                continue;
            };
            nested_exec |= any_in(Some(exec), at + 1);
            nested_mutate |= any_in(Some(mutate), at + 1);
            if prefix && sub == Some(*key) && subcommand_of(&words[at..]).is_none() {
                nested_unpinned = true;
            }
        }
    }
    let unpinned = prefix && risky && (sub.is_none() || nested_unpinned);
    let exec_hit = if risky {
        any_in(exec_subcommands(head), 0)
    } else {
        hits(exec_subcommands(head), sub)
    };
    if unpinned || nested_exec || exec_hit {
        warnings.push("executes_in_workload");
    }
    let mutate_hit = if head == "gh" {
        gh_mutates(&words, prefix)
    } else if risky {
        any_in(mutate_subcommands(head), 0)
    } else {
        hits(mutate_subcommands(head), sub)
    };
    if unpinned || nested_mutate || mutate_hit {
        warnings.push("mutates_remote");
    }
    if runs_arbitrary(head, sub, &words) {
        warnings.push("runs_arbitrary");
    }
    if prefix && words.len() < 3 {
        warnings.push("short_prefix");
    }
    if head == "gh" {
        warnings.push("uses_github_account");
    }
    let normalized = format!(
        "Bash({}{})",
        words.join(" "),
        if prefix { ":*" } else { "" }
    );
    ToolRuleVerdict::Ok {
        rule: normalized,
        kind: if prefix {
            RuleKind::BashPrefix
        } else {
            RuleKind::BashExact
        },
        warnings,
    }
}

const COMMON_FILE_FLAGS: &[&str] = &[
    "--patch-file",
    "--env-file",
    "--from-env-file",
    "--config",
    "--kubeconfig",
];

fn credential_file_flags(head: &str) -> &'static [&'static str] {
    match head {
        "kubectl" => &[
            "--client-key",
            "--client-certificate",
            "--certificate-authority",
        ],
        "helm" => &["--key-file", "--cert-file", "--ca-file", "--kube-ca-file"],
        _ => &[],
    }
}

fn head_file_flags(head: &str) -> &'static [&'static str] {
    match head {
        "kubectl" => &["-f", "--filename", "--kustomize", "-k", "--from-file"],
        "helm" => &["-f", "--values", "--set-file"],
        _ => &[],
    }
}

fn is_secret_flag(flag: &str) -> bool {
    ["--kubeconfig", "--env-file", "--from-env-file", "--config"].contains(&flag)
        || credential_file_flags("kubectl").contains(&flag)
        || credential_file_flags("helm").contains(&flag)
}

const KUBECTL_SUBCOMMANDS: &[&str] = &[
    "get",
    "describe",
    "logs",
    "events",
    "top",
    "explain",
    "api-resources",
    "api-versions",
    "version",
    "cluster-info",
    "auth",
    "wait",
    "diff",
    "apply",
    "create",
    "replace",
    "patch",
    "delete",
    "scale",
    "rollout",
    "label",
    "annotate",
    "set",
    "autoscale",
    "expose",
    "cordon",
    "uncordon",
    "drain",
    "taint",
    "exec",
    "attach",
    "port-forward",
    "debug",
    "run",
];
const HELM_SUBCOMMANDS: &[&str] = &[
    "status",
    "list",
    "ls",
    "get",
    "history",
    "rollback",
    "uninstall",
    "install",
    "upgrade",
    "template",
    "test",
];
const HELM_CHART_SUBCOMMANDS: &[&str] = &["install", "upgrade", "template"];
const HELM_FORBIDDEN_FLAGS: &[&str] = &[
    "--post-renderer",
    "--post-renderer-args",
    "--repo",
    "--plugins",
];

fn has_flag_value(words: &[&str], flag: &str) -> bool {
    let eq = format!("{flag}=");
    words.iter().enumerate().any(|(i, w)| {
        (*w == flag && i + 1 < words.len() && !words[i + 1].starts_with('-')) || w.starts_with(&eq)
    })
}

fn check_command_shape(head: &str, words: &[&str]) -> Option<&'static str> {
    if head != "kubectl" && head != "helm" {
        return Some("unsupported_head");
    }
    let sub = subcommand_of(words);
    if head == "kubectl" {
        return (!sub.is_some_and(|s| KUBECTL_SUBCOMMANDS.contains(&s)))
            .then_some("unsupported_subcommand");
    }
    let Some(sub) = sub.filter(|s| HELM_SUBCOMMANDS.contains(s)) else {
        return Some("unsupported_subcommand");
    };
    if words.iter().any(|w| {
        HELM_FORBIDDEN_FLAGS
            .iter()
            .any(|f| *w == *f || w.starts_with(&format!("{f}=")))
    }) {
        return Some("unsupported_flag");
    }
    if HELM_CHART_SUBCOMMANDS.contains(&sub) {
        let i = words.iter().position(|w| *w == sub)?;
        let release = words.get(i + 1).copied();
        let chart = words.get(i + 2).copied();
        let bad_release =
            release.is_none_or(|r| r.is_empty() || r.starts_with('-') || r.contains('/'));
        let bad_chart = chart.is_none_or(|c| c.is_empty() || !OCI_CHART.is_match(c));
        if bad_release || bad_chart {
            return Some("chart_not_pinned");
        }
        if chart.is_some_and(|c| c.contains(".."))
            || words.iter().filter(|w| w.starts_with("oci://")).count() != 1
        {
            return Some("chart_not_pinned");
        }
        if !has_flag_value(words, "--version") {
            return Some("chart_not_pinned");
        }
    }
    None
}

fn is_clean_absolute_path(p: &str) -> bool {
    if !p.starts_with('/') || p.encode_utf16().count() < 2 || p.ends_with('/') {
        return false;
    }
    p[1..]
        .split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn command_file_args(head: &str, words: &[&str]) -> Result<Vec<CommandFileArg>, &'static str> {
    let mut flags: Vec<&str> = COMMON_FILE_FLAGS.to_vec();
    flags.extend_from_slice(head_file_flags(head));
    flags.extend_from_slice(credential_file_flags(head));
    if head == "kubectl" && words[1..].contains(&"logs") {
        flags.retain(|x| *x != "-f");
    }
    let short: Vec<&str> = flags
        .iter()
        .copied()
        .filter(|x| SHORT_FLAG.is_match(x))
        .collect();
    let mut files: Vec<CommandFileArg> = Vec::new();
    let mut add = |flag: &str, raw: Option<&str>| -> Option<&'static str> {
        let raw = raw?;
        let path = if (flag == "--set-file" || flag == "--from-file") && raw.contains('=') {
            &raw[raw.find('=').unwrap_or(0) + 1..]
        } else {
            raw
        };
        if !is_clean_absolute_path(path) {
            return Some("relative_path");
        }
        files.push(CommandFileArg {
            path: path.into(),
            flag: flag.into(),
            secret: is_secret_flag(flag),
        });
        None
    };
    let mut i = 1;
    while i < words.len() {
        let w = words[i];
        let bad = if flags.contains(&w) {
            let r = match words.get(i + 1) {
                None => Some("relative_path"),
                Some(v) => add(w, Some(v)),
            };
            i += 1;
            r
        } else if w.starts_with("--")
            && w.contains('=')
            && flags.contains(&&w[..w.find('=').unwrap_or(0)])
        {
            let at = w.find('=').unwrap_or(0);
            add(&w[..at], Some(&w[at + 1..]))
        } else if short.iter().any(|x| w.starts_with(x) && w.len() > x.len()) {
            Some("glued_flag")
        } else if let Some(rest) = w.strip_prefix('@') {
            add("@", Some(rest))
        } else {
            None
        };
        if let Some(b) = bad {
            return Err(b);
        }
        i += 1;
    }
    let mut out: Vec<CommandFileArg> = Vec::new();
    for f in files {
        if let Some(prev) = out.iter_mut().find(|p| p.path == f.path) {
            prev.secret = prev.secret || f.secret;
        } else {
            out.push(f);
        }
    }
    Ok(out)
}

/// 「정확한 명령」 판정과 정규형 — TS `validateExactCommand`.
pub fn validate_exact_command(input: &str) -> ExactCommandVerdict {
    use ExactCommandVerdict::Refused;
    let command = js_trim(input);
    if command.is_empty() {
        return Refused("empty");
    }
    if command.ends_with(":*") {
        return Refused("wildcard");
    }
    let rule = match validate_tool_rule(&format!("Bash({command})")) {
        ToolRuleVerdict::Refused(c) => return Refused(c),
        ToolRuleVerdict::Ok {
            kind: RuleKind::BashExact,
            rule,
            warnings,
        } => (rule, warnings),
        ToolRuleVerdict::Ok { .. } => return Refused("unsupported_tool"),
    };
    let normalized = rule.0["Bash(".len()..rule.0.len() - 1].to_string();
    let words: Vec<&str> = normalized.split(' ').collect();
    if ENV_PREFIX.is_match(words[0]) {
        return Refused("env_prefix");
    }
    if words[0].contains('/') {
        return Refused("path_head");
    }
    let head = words[0].to_lowercase();
    if let Some(c) = check_command_shape(&head, &words) {
        return Refused(c);
    }
    let files = match command_file_args(&head, &words) {
        Ok(f) => f,
        Err(c) => return Refused(c),
    };
    if head == "kubectl" || head == "helm" {
        let ctx = if head == "kubectl" {
            "--context"
        } else {
            "--kube-context"
        };
        if !files.iter().any(|f| f.flag == "--kubeconfig") || !has_flag_value(&words, ctx) {
            return Refused("needs_kubeconfig");
        }
    }
    let mut warnings = rule.1;
    if !files.is_empty() {
        warnings.push("reads_file");
    }
    ExactCommandVerdict::Ok {
        command: normalized,
        warnings,
        files,
    }
}

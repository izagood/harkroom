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
//! - **TS 로 넘기는 것**(`None`): zod 가 받지 않을 인자 · 받아들여지는 규칙·저장소·명령
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
        "too_long" => "rule is too long (300 characters max)",
        "merge_bypass" => {
            "merging goes through the merge wrapper — request kind \"merge\" with the repository instead"
        }
        "gh_api_write" => {
            "`gh api` is granted only as one exact read call — no prefix rule, -X/--method, -f/-F/--input or graphql"
        }
        "env_prefix" => {
            "no NAME=value prefix — pass it as a flag (e.g. kubectl --kubeconfig <path>)"
        }
        "path_head" => {
            "a script called by path is not granted as an exact command — run it yourself or ask for a tool rule"
        }
        "relative_path" => {
            "file arguments (-f, --patch-file, --values, --kubeconfig, @file …) must be absolute, clean paths"
        }
        "glued_flag" => {
            "write file flags apart from their value (-f /abs/path), not glued (-f/abs or -f=/abs)"
        }
        "needs_kubeconfig" => {
            "kubectl/helm need both --kubeconfig <absolute path> and --context (helm: --kube-context)"
        }
        "unsupported_head" => {
            "an exact command can only be kubectl or helm for now — run other tools yourself or ask for a tool rule"
        }
        "unsupported_subcommand" => {
            "that kubectl/helm subcommand (or plugin) is not granted as an exact command"
        }
        "unsupported_flag" => {
            "helm --post-renderer/--repo/--plugins are not granted as an exact command"
        }
        "chart_not_pinned" => {
            "helm install/upgrade/template need `<release> oci://<chart>` right after the subcommand and --version"
        }
        // 모르는 거절 코드 — 판정 표가 새 코드를 낼 때 시험(`messages_follow_ts`)이 잡는다.
        _ => "rule is not accepted",
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

// ── P6-2a: 받아들여지는 tool·merge 요청 ──────────────────────────────────────────────────────────────────────────────

/// 에이전트의 소유자(TS `openPermissionRequest` 첫 읽기).
const OWNER_SQL: &str = "select c.owner_account_id::text from account a join agent_config c on c.account_id = a.id \
     where a.id = $1::uuid and a.kind = 'agent'";

/// TS `openPermissionRequest` 의 「이미 있는 grant」.
pub(crate) const LIVE_GRANT_SQL: &str = "select (extract(epoch from expires_at) * 1000)::bigint from account_grant \
     where account_id = $1::uuid and capability = $2 and scope = $3 and (expires_at is null or expires_at > $4::timestamptz) \
     limit 1";

/// TS `openPermissionRequest` 의 「이미 기다리는 요청」(거절에서 오지 않은 요청 — `denial` 이 null).
pub(crate) const PENDING_SQL: &str = "select id::text, card_message_id::text from permission_request \
     where agent_id = $1::uuid and kind = $2 and target = $3 and thread_root_id = $4::uuid and channel_id = $5::uuid \
       and status = 'pending' and expires_at > $6::timestamptz \
     order by created_at desc limit 1";

/// TS `closeSupersededCards` 의 옛 요청 읽기.
pub(crate) const SUPERSEDED_OLD_SQL: &str = "select id::text, status, card_message_id::text from permission_request \
     where superseded_by = $1::uuid and card_message_id is not null";

/// TS `closeSupersededCards` — 대체된(대기였던) 요청 카드의 `permissionRequest` 상태 칸.
pub(crate) const SUPERSEDED_PR_META_SQL: &str = "update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb) \
     where id = $1::uuid and meta ? 'permissionRequest'";

/// TS `closeSupersededCards` — 아직 열린 옛 카드를 `superseded` 로 닫는다.
pub(crate) const SUPERSEDED_ASK_CLOSE_SQL: &str = "update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb) \
     where id = $1::uuid and meta ? 'ask' and meta->'ask'->>'closedAt' is null and meta->'ask'->'answeredWith' is null \
     returning id::text";

/// 옛 카드 닫기에 더 쓰는 쓰기 풀 칸(글 `meta` UPDATE·outbox·거울 맞추기 inbox).
pub(crate) const SUPERSEDE_CARD_PRIVILEGES: &[(&str, &str)] = &[
    ("permission_request.id", "SELECT"),
    ("permission_request.status", "SELECT"),
    ("permission_request.card_message_id", "SELECT"),
    ("permission_request.superseded_by", "SELECT"),
    ("message.meta", "SELECT"),
    ("message.deleted_at", "SELECT"),
    ("message.meta", "UPDATE"),
    ("inbox", "INSERT"),
    ("event_outbox", "INSERT"),
];

/// TS `closeSupersededCards` — 새 카드가 커밋된 뒤 부른다. 대기였다가 대체된 요청은 카드의 `permissionRequest` 에 상태를 적고,
/// 열린 옛 카드는 `superseded`(대신한 새 카드 id)로 닫는다. 바뀐 카드마다 `message.updated`, 닫힌 카드는 거울도 맞춘다.
/// 닫힌 옛 카드를 담은 묶음에는 새 카드를 줄로 옮긴다(TS `carryBundleItem`, [`crate::core::ask_bundle_add::carry_bundle_item`] —
/// `message.ask` 의 대신하기와 같은 함수). TS 처럼 그 실패는 삼키고 거울 닫기로 간다.
/// TS 처럼 새 카드는 이미 섰으므로 실패는 기록만 한다.
async fn close_superseded_cards(write: &PgPool, new_request: &str, new_card: &str) {
    use crate::core::ask_sync::{announce_updated, sync_ask_mirrors};
    let r: Result<(), sqlx::Error> = async {
        let mut conn = write.acquire().await?;
        let old: Vec<(String, String, String)> = sqlx::query_as(SUPERSEDED_OLD_SQL)
            .bind(new_request)
            .fetch_all(&mut *conn)
            .await?;
        let at = crate::core::msg_post::iso_ms(crate::core::msg_post::now_ms());
        for (_, status, card) in &old {
            if status == "superseded" {
                sqlx::query(SUPERSEDED_PR_META_SQL)
                    .bind(card)
                    .bind(
                        serde_json::json!({ "status": "superseded", "supersededBy": new_request, "decidedAt": at })
                            .to_string(),
                    )
                    .execute(&mut *conn)
                    .await?;
            }
            let closed: Option<String> = sqlx::query_scalar(SUPERSEDED_ASK_CLOSE_SQL)
                .bind(card)
                .bind(
                    serde_json::json!({ "closedAt": at, "closedReason": "superseded", "supersededBy": new_card })
                        .to_string(),
                )
                .fetch_optional(&mut *conn)
                .await?;
            if closed.is_none() && status != "superseded" {
                continue;
            }
            announce_updated(&mut conn, card).await?;
            if closed.is_some() {
                if let Err(e) =
                    crate::core::ask_bundle_add::carry_bundle_item(&mut conn, card, new_card).await
                {
                    eprintln!("permission.request: carry bundle item {card} -> {new_card} failed: {e}");
                }
                sync_ask_mirrors(&mut conn, "permission.request supersedes", card).await?;
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        eprintln!("permission.request: supersede follow-up failed: {e}");
    }
}

/// TS `cardMandateMeta` 의 위임장 읽기(시작 시각은 ms).
pub(crate) const MANDATE_CHIP_SQL: &str = "select channel_id::text, owner_account_id::text, \
       (extract(epoch from created_at) * 1000)::bigint from mandate where id = $1::uuid";

/// TS `mandateChipName` 의 읽기 — 그 스레드 머리의 작업 항목 제목(위임 소유자 것), 위임 머리 글 본문.
pub(crate) const MANDATE_CHIP_NAME_SQL: &str = "select (select w.title from work_item w \
              where w.thread_root_id = d.thread_root_id and w.owner_account_id = d.owner_account_id \
              order by w.updated_at desc limit 1) as title, \
            m.body \
       from mandate d left join message m on m.id = d.root_message_id and m.deleted_at is null \
      where d.id = $1::uuid";

/// 위임장 칩 이름의 길이(TS `MANDATE_NAME_MAX`).
const MANDATE_NAME_MAX: usize = 40;

/// JS `\s`(ECMAScript WhiteSpace + LineTerminator).
const JS_SPACE_CLASS: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// TS `stripMentions` — `<@uuid>` 와 (맨 앞·빈칸 뒤) `@이름` 을 빈칸으로 → `oneLineReason`.
fn strip_mentions(body: &str) -> String {
    use std::sync::OnceLock;
    static TOKEN: OnceLock<regex::Regex> = OnceLock::new();
    static HANDLE: OnceLock<regex::Regex> = OnceLock::new();
    let token = TOKEN.get_or_init(|| regex::Regex::new(r"(?i)<@[0-9a-f-]{36}>").unwrap());
    let handle = HANDLE.get_or_init(|| {
        regex::Regex::new(&format!(r"(?:^|{JS_SPACE_CLASS})@[A-Za-z0-9_.\-]+")).unwrap()
    });
    let s = token.replace_all(body, " ");
    let s = handle.replace_all(&s, " ");
    crate::core::permission_card::one_line_reason(&s)
}

/// TS `clip` — trim 뒤 코드 포인트 40개 넘으면 잘라 `…`.
fn clip(s: &str) -> String {
    let t = s.trim_matches(crate::core::permission_card::js_space);
    if t.chars().count() > MANDATE_NAME_MAX {
        format!("{}…", t.chars().take(MANDATE_NAME_MAX).collect::<String>())
    } else {
        t.to_owned()
    }
}

/// TS `mandateChipName` 의 순수 부분.
fn chip_name(title: Option<&str>, body: Option<&str>) -> Option<String> {
    use crate::core::permission_card::{js_space, one_line_reason};
    if let Some(t) = title.filter(|t| !t.trim_matches(js_space).is_empty()) {
        return Some(clip(&one_line_reason(t)));
    }
    Some(clip(&strip_mentions(body.unwrap_or("")))).filter(|s| !s.is_empty())
}

/// TS `cardMandateMeta` — 위임장 칩. 이름은 위임장 뿌리 채널을 카드 채널의 청중이 다 볼 때만(security F1). 못 읽으면 `None`(→ TS).
pub(super) async fn card_mandate_meta(
    read: &PgPool,
    mandate: &str,
    card_channel: &str,
) -> Option<Value> {
    use crate::core::msg_post::iso_ms;
    let row: Option<(String, String, i64)> = sqlx::query_as(MANDATE_CHIP_SQL)
        .bind(mandate)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some((channel, owner, started)) = row else {
        return Some(serde_json::json!({ "id": mandate, "name": "" }));
    };
    let same = channel == card_channel;
    let sees = same || {
        let ra = crate::core::audience::audience_for(read, &channel)
            .await
            .ok()?;
        let ma = crate::core::audience::audience_for(read, card_channel)
            .await
            .ok()?;
        super::message_ask::audience_sees_root(same, &ra, &ma)
    };
    let name = if sees {
        let r: Option<(Option<String>, Option<String>)> = sqlx::query_as(MANDATE_CHIP_NAME_SQL)
            .bind(mandate)
            .fetch_optional(read)
            .await
            .ok()?;
        r.and_then(|(t, b)| chip_name(t.as_deref(), b.as_deref()))
    } else {
        None
    };
    Some(serde_json::json!({
        "id": mandate, "name": name.unwrap_or_default(), "ownerId": owner, "startedAt": iso_ms(started),
    }))
}

/// 이 갈래의 읽기 풀 칸.
pub(crate) const ACCEPT_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.expires_at", "SELECT"),
    ("permission_request.id", "SELECT"),
    ("permission_request.agent_id", "SELECT"),
    ("permission_request.kind", "SELECT"),
    ("permission_request.target", "SELECT"),
    ("permission_request.thread_root_id", "SELECT"),
    ("permission_request.channel_id", "SELECT"),
    ("permission_request.status", "SELECT"),
    ("permission_request.expires_at", "SELECT"),
    ("permission_request.created_at", "SELECT"),
    ("permission_request.card_message_id", "SELECT"),
    ("permission_request.superseded_by", "SELECT"),
];

/// TS `raisePermission` 의 `alreadyGranted` 답(칸 차례 그대로).
fn already_granted_result(expires_at: Option<&str>) -> String {
    format!(
        "{{\"alreadyGranted\":true,\"expiresAt\":{},\"message\":{}}}",
        expires_at.map_or(Value::Null, Value::from),
        Value::from(
            "already granted — it applies from the next turn in this channel. If a shell command was refused anyway, run it plain: no redirection (such as 2>&1), pipes, chaining or substitution"
        )
    )
}

/// TS `raisePermission` 의 `existing` 답.
fn existing_result(request_id: &str, card: Option<&str>) -> String {
    format!(
        "{{\"requestId\":{},\"cardMessageId\":{},\"pending\":true,\"message\":{}}}",
        Value::from(request_id),
        card.map_or(Value::Null, Value::from),
        Value::from("the same request is already waiting for the owner in this thread"),
    )
}

/// 받아들여진 tool·merge 요청의 정규 대상: `(저장할 target, grant capability, grant scope, warnings)`.
/// `Err(code)` 는 거절, `Ok(None)` 은 TS 몫(ASCII 밖).
type Target = (String, &'static str, String, Vec<&'static str>);
fn accepted_target(a: &Args<'_>) -> Result<Option<Target>, &'static str> {
    use harkroom_proto::tool_rules::{ToolRuleVerdict, validate_tool_rule};
    match a.kind {
        Kind::Tool => {
            let rule = a.rule.ok_or("bad_request")?;
            if !rule.is_ascii() {
                return Ok(None);
            }
            match validate_tool_rule(rule) {
                ToolRuleVerdict::Refused(c) => Err(c),
                ToolRuleVerdict::Ok { rule, warnings, .. } => {
                    let scope = format!("tool:{}:{rule}", a.channel_id);
                    Ok(Some((rule, "tool.allow", scope, warnings)))
                }
            }
        }
        Kind::Merge => {
            let repo = a.repo.ok_or("bad_request")?;
            if !repo.is_ascii() {
                return Ok(None);
            }
            if let Some(c) = repo_refusal(repo) {
                return Err(c);
            }
            let Some(t) = crate::core::merge_approval_peek::repo_scope(repo) else {
                return Err("bad_repo");
            };
            Ok(Some((t.clone(), "repo.merge", t, Vec::new())))
        }
        Kind::Command => Ok(None),
    }
}

// ── P6-2c: kind=command ─────────────────────────────────────────────────────────────────────────────────────────────

/// TS `openCommandRequest` 의 「이미 있는 grant」 — 같은 스레드의 같은 명령, 쓰지 않은 1회짜리이거나 기한 안의 1시간짜리.
const COMMAND_LIVE_SQL: &str = "select (extract(epoch from expires_at) * 1000)::bigint from command_grant \
     where agent_id = $1::uuid and channel_id = $2::uuid and thread_root_id = $3::uuid and command = $4 \
       and expires_at > $5::timestamptz and (not single_use or used_at is null) \
     order by expires_at desc limit 1";

/// TS `openCommandRequest` 의 `file_digests` 적기.
const COMMAND_DIGESTS_SQL: &str =
    "update permission_request set file_digests = $2::jsonb where id = $1::uuid";

/// kind=command 에 더 읽는 칸.
const COMMAND_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("command_grant.agent_id", "SELECT"),
    ("command_grant.channel_id", "SELECT"),
    ("command_grant.thread_root_id", "SELECT"),
    ("command_grant.command", "SELECT"),
    ("command_grant.expires_at", "SELECT"),
    ("command_grant.single_use", "SELECT"),
    ("command_grant.used_at", "SELECT"),
];

/// kind=command 에 더 쓰는 칸.
const COMMAND_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("permission_request.id", "SELECT"),
    ("permission_request.file_digests", "UPDATE"),
];

/// 받아들여진 명령: `(정규 명령, warnings, 맞춘 파일)`. `Err(답)` 은 거절, `Ok(None)` 은 TS 몫(ASCII 밖·Rust 가 글자를 모르는 거절 코드·
/// 엄격 해독이 못 읽은 헤더).
type AcceptedCommand = (
    String,
    Vec<&'static str>,
    Vec<crate::core::permission_command::MatchedFile>,
);
fn accepted_command(
    command: &str,
    header: &crate::core::permission_command::Header,
) -> Result<Option<AcceptedCommand>, String> {
    use crate::core::permission_command::{Header, files_refusal_message, match_files};
    use harkroom_proto::tool_rules::{ExactCommandVerdict, validate_exact_command};
    if !command.is_ascii() {
        return Ok(None);
    }
    let (cmd, warnings, want) = match validate_exact_command(command) {
        ExactCommandVerdict::Refused(c) => {
            let m = rule_message(c);
            if m == rule_message("") {
                return Ok(None);
            }
            return Err(err(c, m));
        }
        ExactCommandVerdict::Ok {
            command,
            warnings,
            files,
        } => (command, warnings, files),
    };
    let got = match header {
        Header::ToTs => return Ok(None),
        Header::Absent => None,
        Header::Digests(d) => Some(d.as_slice()),
    };
    match match_files(&want, got) {
        Ok(f) => Ok(Some((cmd, warnings, f))),
        Err(c) => Err(err(c, files_refusal_message(c))),
    }
}

/// TS `raisePermission` 의 `alreadyGranted` 답(kind=command).
fn command_already_granted_result(expires_at: Option<&str>) -> String {
    format!(
        "{{\"alreadyGranted\":true,\"expiresAt\":{},\"message\":{}}}",
        expires_at.map_or(Value::Null, Value::from),
        Value::from("already granted in this thread — run exactly that command now")
    )
}

/// TS `openCommandRequest` 의 `created.meta`. 요청 id 는 카드 tx 의 훅이 채운다.
#[allow(clippy::too_many_arguments)]
fn command_request_meta(
    agent_id: &str,
    owner: Option<&str>,
    command: &str,
    channel: &str,
    thread: &str,
    warnings: &[&str],
    files: &[crate::core::permission_command::MatchedFile],
    reason: &str,
    requested_at: &str,
    expires_at: &str,
    mandate: Option<(&str, Value)>,
) -> Value {
    use crate::core::permission_card as pc;
    use serde_json::json;
    let mut m = serde_json::Map::new();
    m.insert("requestId".into(), json!(""));
    m.insert("agentId".into(), json!(agent_id));
    m.insert("ownerAccountId".into(), json!(owner));
    m.insert("kind".into(), json!("command"));
    m.insert("target".into(), json!(command));
    m.insert("channelId".into(), json!(channel));
    m.insert("threadRootId".into(), json!(thread));
    m.insert("warnings".into(), json!(warnings));
    if let Some(l) = pc::body_warning_line(warnings) {
        m.insert("bodyWarningLine".into(), json!(l));
    }
    if !files.is_empty() {
        m.insert(
            "files".into(),
            Value::Array(files.iter().map(|f| f.meta()).collect()),
        );
    }
    if let Some((id, chip)) = mandate {
        m.insert("mandateId".into(), json!(id));
        m.insert("mandate".into(), chip);
    }
    m.insert(
        "line".into(),
        crate::core::permission_command::card_line(command),
    );
    m.insert("reason".into(), json!(pc::one_line_reason(reason)));
    m.insert("requestedAt".into(), json!(requested_at));
    m.insert("expiresAt".into(), json!(expires_at));
    Value::Object(m)
}

fn refusal(code: &'static str) -> String {
    match code {
        "org_wide" => err(
            code,
            "an organization-wide grant (owner/*) is not requested from a card — ask for the one repository, or ask the owner to grant owner/* in settings",
        ),
        "bad_repo" => err(code, "repo must be one <owner>/<name>"),
        _ => err(code, rule_message(code)),
    }
}

/// P6-2a — [`answer`] 가 `None`(받아들여지는 tool·merge 요청)일 때 TS `raisePermission`·`openPermissionRequest` 를 대신한다:
/// 이미 있는 grant → `alreadyGranted` / 기다리는 요청 → `existing` / 그 밖은 하루 상한 → 요청 줄 → 감사 → 카드 글 → 잇기 → 푸시를
/// **카드 글과 같은 tx** 로, 커밋 뒤 대체된 옛 카드 닫기(P6-2b). 위임 있는 턴이면 요청 줄에 `mandate_id`, 카드에 위임장 칩·[이 위임장 동안]
/// 선택지(P6-2b). 대체한 옛 카드가 묶음에 담겨 있으면 새 카드를 그 묶음의 줄로 옮긴다(0-1 ④). `None`(→ TS): kind=command · ASCII 밖 · 쓰기/읽기 칸 없음 ·
/// 글 올리기 풀 없음 · DB 오류.
pub async fn accept(
    read: &PgPool,
    st: Option<&crate::core::msg_post::PostState>,
    me: &Account,
    args: &Value,
    (cause, turn, operator): (Option<&str>, Option<&str>, bool),
    command_files: &crate::core::permission_command::Header,
) -> Option<String> {
    use crate::core::msg_post::{iso_ms, now_ms};
    use crate::core::permission_card as pc;
    use crate::core::permission_command as pcmd;
    let a = parse(args)?;
    let st = st?;
    if me.kind != "agent" {
        return None;
    }
    // P6-2c: kind=command 는 정확한 명령 판정 → 파일 해시 맞추기(TS `openCommandRequest` 의 앞 두 걸음).
    let mut files: Option<Vec<pcmd::MatchedFile>> = None;
    let (target, cap, scope, warnings) = if a.kind == Kind::Command {
        match accepted_command(a.command?, command_files) {
            Ok(Some((cmd, w, f))) => {
                files = Some(f);
                (cmd, "command", String::new(), w)
            }
            Ok(None) => return None,
            Err(answer) => return Some(answer),
        }
    } else {
        match accepted_target(&a) {
            Ok(Some(t)) => t,
            Ok(None) => return None,
            Err(c) => return Some(refusal(c)),
        }
    };
    let mut read_privs = ACCEPT_READ_PRIVILEGES.to_vec();
    if files.is_some() {
        read_privs.extend_from_slice(COMMAND_READ_PRIVILEGES);
    }
    if !crate::write::missing_in(read, &read_privs, &[])
        .await
        .ok()?
        .is_empty()
    {
        return None;
    }
    let mut privs = pc::REQUEST_WRITE_PRIVILEGES.to_vec();
    if files.is_some() {
        privs.extend_from_slice(COMMAND_WRITE_PRIVILEGES);
    }
    privs.extend_from_slice(pc::LINK_PUSH_PRIVILEGES);
    privs.extend_from_slice(super::message_ask::DENIAL_CARD_PATCH_PRIVILEGES);
    // P6-2b: 대체될 옛 카드가 있는지는 tx 안에서야 알므로 닫기 칸도 미리 본다.
    privs.extend_from_slice(SUPERSEDE_CARD_PRIVILEGES);
    if !crate::write::missing_in(&st.write, &privs, crate::core::ask::ASK_SEQUENCE_PRIVILEGES)
        .await
        .ok()?
        .is_empty()
    {
        return None;
    }
    let owner: Option<Option<String>> = sqlx::query_scalar(OWNER_SQL)
        .bind(&me.id)
        .fetch_optional(read)
        .await
        .ok()?;
    let owner = owner?; // `not_agent` 는 [`answer`] 가 답했다.
    let now = now_ms();
    let (now_iso, expires_iso) = (iso_ms(now), iso_ms(now + pc::PERMISSION_REQUEST_TTL_MS));
    // W4(P6-2b): 요청을 낸 턴의 위임 — 그 원인으로 받은 살아 있는 턴 임대의 것(TS `mandateForAgentPost`). 오퍼레이터를 거치지 않은 부름이면 없다.
    let mandate: Option<String> = match cause.filter(|_| operator) {
        Some(c) => {
            let mut conn = st.write.acquire().await.ok()?;
            crate::core::cause_link::mandate_for_agent_post(&mut conn, &me.id, c, now, iso_ms)
                .await
                .ok()?
        }
        None => None,
    };
    let thread = args.get("threadRootId")?.as_str()?;
    let live: Option<Option<i64>> = if files.is_some() {
        sqlx::query_scalar(COMMAND_LIVE_SQL)
            .bind(&me.id)
            .bind(a.channel_id)
            .bind(thread)
            .bind(&target)
            .bind(&now_iso)
            .fetch_optional(read)
            .await
            .ok()?
    } else {
        sqlx::query_scalar(LIVE_GRANT_SQL)
            .bind(&me.id)
            .bind(cap)
            .bind(&scope)
            .bind(&now_iso)
            .fetch_optional(read)
            .await
            .ok()?
    };
    if let Some(exp) = live {
        let exp = exp.map(iso_ms);
        return Some(super::respond::text_result(&if files.is_some() {
            command_already_granted_result(exp.as_deref())
        } else {
            already_granted_result(exp.as_deref())
        }));
    }
    let kind = match a.kind {
        Kind::Tool => "tool",
        Kind::Merge => "merge",
        Kind::Command => "command",
    };
    let pending: Option<(String, Option<String>)> = sqlx::query_as(PENDING_SQL)
        .bind(&me.id)
        .bind(kind)
        .bind(&target)
        .bind(thread)
        .bind(a.channel_id)
        .bind(&now_iso)
        .fetch_optional(read)
        .await
        .ok()?;
    if let Some((id, card)) = pending {
        return Some(super::respond::text_result(&existing_result(
            &id,
            card.as_deref(),
        )));
    }
    let reason = args.get("reason")?.as_str()?;
    let chip = match mandate.as_deref() {
        Some(m) => Some((m, card_mandate_meta(read, m, a.channel_id).await?)),
        None => None,
    };
    let (card_body, meta) = match &files {
        Some(f) => {
            let pr_meta = command_request_meta(
                &me.id,
                owner.as_deref(),
                &target,
                a.channel_id,
                thread,
                &warnings,
                f,
                reason,
                &now_iso,
                &expires_iso,
                chip,
            );
            let body = pcmd::card_body(
                &format!("@{}", me.handle),
                &target,
                &warnings,
                f,
                pr_meta["reason"].as_str()?,
            );
            let mut m = pc::merge_card_meta(pr_meta, false);
            if let Some(Value::Object(ask)) = m.get_mut("ask") {
                ask.insert("options".into(), pcmd::card_options());
            }
            (body, m)
        }
        None => {
            let pr_meta = pc::plain_request_meta(
                kind,
                &me.id,
                owner.as_deref(),
                &target,
                a.channel_id,
                &warnings,
                reason,
                &now_iso,
                &expires_iso,
                chip,
            );
            let shown = pr_meta["target"].as_str()?.to_owned();
            let body = pc::plain_card_body(
                kind,
                &shown,
                &warnings,
                &format!("@{}", me.handle),
                pr_meta["reason"].as_str()?,
            );
            (body, pc::plain_card_meta(pr_meta))
        }
    };
    let mut sub = serde_json::Map::new();
    sub.insert("channelId".into(), Value::from(a.channel_id));
    sub.insert("body".into(), Value::from(card_body));
    sub.insert("threadRootId".into(), Value::from(thread));
    if let Some(m) = args.get("model") {
        sub.insert("model".into(), m.clone());
    }
    let hook = RequestHook {
        req: pc::NewRequest {
            kind,
            agent: &me.id,
            target: &target,
            reason,
            warnings: &warnings,
            channel: a.channel_id,
            thread,
            denial: None,
            mandate: mandate.as_deref(),
            now: &now_iso,
            expires: &expires_iso,
        },
        owner: owner.as_deref(),
        file_digests: files.as_deref().map(pcmd::canonical_digests_json),
        request_id: std::sync::OnceLock::new(),
        closes_old: std::sync::OnceLock::new(),
    };
    let posted = super::msg_post::post_card(
        st,
        me,
        &Value::Object(sub),
        meta,
        cause,
        turn,
        operator,
        Some(&hook),
    )
    .await?;
    let card_id = match posted {
        Ok((id, _)) => id,
        Err(answer) => return Some(answer),
    };
    let request_id = hook.request_id.get()?;
    if hook.closes_old.get() == Some(&true) {
        close_superseded_cards(&st.write, request_id, &card_id).await;
    }
    Some(super::respond::text_result(&pc::created_result(
        request_id,
        &card_id,
        &expires_iso,
    )))
}

/// 요청 줄(하루 상한 → insert → supersede → 감사) → meta 의 requestId → 잇기 → 푸시를 카드 글과 같은 tx 에서(머지 거절 카드와 같은 꼴).
#[derive(Debug)]
struct RequestHook<'a> {
    req: crate::core::permission_card::NewRequest<'a>,
    owner: Option<&'a str>,
    /// kind=command 면 요청 줄 `file_digests` 에 둘 꼴(TS `canonicalDigests`, 파일이 없어도 `[]`).
    file_digests: Option<String>,
    request_id: std::sync::OnceLock<String>,
    /// 이 tx 에서 대체한 옛 요청에 카드가 붙어 있었나 — 커밋 뒤 [`close_superseded_cards`] 를 부를지.
    closes_old: std::sync::OnceLock<bool>,
}

impl crate::core::msg_post::BeforeCommit for RequestHook<'_> {
    fn run<'b>(
        &'b self,
        tx: &'b mut sqlx::Transaction<'static, sqlx::Postgres>,
        message_id: &'b str,
        notified: &'b std::collections::HashSet<String>,
    ) -> crate::core::msg_post::BeforeCommitFuture<'b> {
        use super::message_ask::{DENIAL_CARD_PATCH_SQL, denial_hook_outcome, denial_needs_push};
        use crate::core::permission_card as pc;
        Box::pin(async move {
            let opened = pc::open_request(tx, &self.req).await?;
            let request_id = match denial_hook_outcome(opened) {
                Ok(id) => id,
                Err(rej) => return Ok(Some(rej)),
            };
            if let Some(d) = &self.file_digests {
                sqlx::query(COMMAND_DIGESTS_SQL)
                    .bind(&request_id)
                    .bind(d)
                    .execute(&mut **tx)
                    .await?;
            }
            let old: Vec<(String, String, String)> = sqlx::query_as(SUPERSEDED_OLD_SQL)
                .bind(&request_id)
                .fetch_all(&mut **tx)
                .await?;
            let _ = self.closes_old.set(!old.is_empty());
            sqlx::query(DENIAL_CARD_PATCH_SQL)
                .bind(message_id)
                .bind(&request_id)
                .execute(&mut **tx)
                .await?;
            sqlx::query(pc::LINK_CARD_SQL)
                .bind(&request_id)
                .bind(message_id)
                .execute(&mut **tx)
                .await?;
            if denial_needs_push(self.owner, notified) {
                sqlx::query(pc::enqueue_ask_push_sql())
                    .bind(self.owner)
                    .bind(message_id)
                    .execute(&mut **tx)
                    .await?;
            }
            let _ = self.request_id.set(request_id);
            Ok(None)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "11111111-1111-1111-1111-111111111111";

    #[test]
    fn command_accept_shapes() {
        use crate::core::permission_command::{Digest, Header};
        const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let kc = "kubectl --kubeconfig /k/c --context x get pods";
        // --kubeconfig 는 파일을 읽는다 — 잰 것이 없으면 files_unmeasured, 다른 경로면 files_mismatch(TS matchFileDigests).
        let e = accepted_command(kc, &Header::Absent).unwrap_err();
        assert!(e.contains("files_unmeasured"), "{e}");
        let other = Header::Digests(vec![Digest {
            path: "/k/x".into(),
            sha256: SHA.into(),
            size: 1,
            preview: Some("p".into()),
        }]);
        assert!(
            accepted_command(kc, &other)
                .unwrap_err()
                .contains("files_mismatch")
        );
        let same = Header::Digests(vec![Digest {
            path: "/k/c".into(),
            sha256: SHA.into(),
            size: 1,
            preview: Some("p".into()),
        }]);
        let (cmd, _, f) = accepted_command(kc, &same).unwrap().unwrap();
        assert_eq!(cmd, kc);
        assert_eq!(f.len(), 1);
        // 정확한 명령 거절은 shared 글자 그대로.
        assert!(
            accepted_command("ls -l", &Header::Absent)
                .unwrap_err()
                .contains("unsupported_head")
        );
        // ASCII 밖·엄격 해독이 못 읽은 헤더는 TS.
        assert_eq!(accepted_command("kubectl get ü", &Header::Absent), Ok(None));
        assert_eq!(accepted_command(kc, &Header::ToTs), Ok(None));
    }

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
            "too_long",
            "merge_bypass",
            "gh_api_write",
            "env_prefix",
            "path_head",
            "relative_path",
            "glued_flag",
            "needs_kubeconfig",
            "unsupported_head",
            "unsupported_subcommand",
            "unsupported_flag",
            "chart_not_pinned",
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

    /// P6-2b: 옛 카드 닫기 문장이 TS `closeSupersededCards` 의 조건을 그대로 갖는다(답·닫힘 있는 카드는 건드리지 않음).
    #[test]
    fn supersede_close_sql_follows_ts() {
        assert!(
            SUPERSEDED_OLD_SQL.contains("superseded_by = $1::uuid and card_message_id is not null")
        );
        assert!(SUPERSEDED_PR_META_SQL.contains("meta ? 'permissionRequest'"));
        assert!(SUPERSEDED_ASK_CLOSE_SQL.contains("meta->'ask'->>'closedAt' is null"));
        assert!(SUPERSEDED_ASK_CLOSE_SQL.contains("meta->'ask'->'answeredWith' is null"));
        assert!(SUPERSEDE_CARD_PRIVILEGES.contains(&("message.meta", "UPDATE")));
        assert!(SUPERSEDE_CARD_PRIVILEGES.contains(&("message.deleted_at", "SELECT")));
    }

    /// P6-2b: TS `stripMentions`·`clip`·`mandateChipName` 의 순수 부분.
    #[test]
    fn mandate_chip_name_like_ts() {
        let u = "0188b1f6-f69d-44af-8c27-bcfb63b1469C";
        assert_eq!(
            strip_mentions(&format!("<@{u}> 배포 @harkroom 봐 줘")),
            "배포 봐 줘"
        );
        assert_eq!(strip_mentions("a@b.c 메일"), "a@b.c 메일");
        assert_eq!(strip_mentions("@a @b 끝"), "끝");
        assert_eq!(strip_mentions("@a@b 끝"), "@b 끝");
        assert_eq!(strip_mentions("x\u{3000}@a y"), "x y");
        assert_eq!(chip_name(Some("  "), Some("@a 본문")), Some("본문".into()));
        assert_eq!(
            chip_name(Some("작업 `제목`"), Some("b")),
            Some("작업 제목".into())
        );
        assert_eq!(chip_name(None, Some("@a")), None);
        assert_eq!(chip_name(None, None), None);
        let long = "가".repeat(41);
        assert_eq!(
            chip_name(None, Some(&long)),
            Some(format!("{}…", "가".repeat(40)))
        );
        assert_eq!(
            chip_name(None, Some(&"가".repeat(40))),
            Some("가".repeat(40))
        );
    }

    /// P6-2b: 위임 있는 턴의 카드 — 선택지·줄·meta 칸이 TS `permissionCardOptions`·`cardLine`·`openPermissionRequest` 와 같다.
    #[test]
    fn mandate_card_follows_ts() {
        use crate::core::permission_card as pc;
        let chip =
            json!({ "id": C, "name": "n", "ownerId": C, "startedAt": "2026-01-01T00:00:00.000Z" });
        let m = pc::plain_request_meta(
            "tool",
            C,
            Some(C),
            "Bash(ls)",
            C,
            &[],
            "r",
            "t0",
            "t1",
            Some((C, chip.clone())),
        );
        assert_eq!(m["mandateId"], json!(C));
        assert_eq!(m["mandate"], chip);
        assert_eq!(
            m["line"]["limits"],
            json!({ "approve_mandate": { "untilMs": 604_800_000 }, "approve_turn": { "turn": true } })
        );
        let card = pc::plain_card_meta(m);
        let ids: Vec<&str> = card["ask"]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["approve_mandate", "approve_turn", "deny"]);
        let mm = pc::plain_request_meta(
            "merge",
            C,
            Some(C),
            "repo:a/b",
            C,
            &[],
            "r",
            "t0",
            "t1",
            Some((C, chip)),
        );
        assert_eq!(
            mm["line"]["limits"],
            json!({ "approve_mandate": { "untilMs": 604_800_000 } })
        );
        let card = pc::plain_card_meta(mm);
        let ids: Vec<&str> = card["ask"]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["approve_mandate", "deny"]);
        let plain =
            pc::plain_request_meta("tool", C, None, "Bash(ls)", C, &[], "r", "t0", "t1", None);
        assert!(plain.get("mandateId").is_none() && plain.get("mandate").is_none());
        let card = pc::plain_card_meta(plain);
        assert_eq!(
            card["ask"]["options"][0]["id"],
            json!("approve_new_mandate")
        );
        assert_eq!(card["ask"]["options"].as_array().unwrap().len(), 2);
    }
}

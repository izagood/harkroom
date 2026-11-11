//! codex 턴에 소유자 승인 명령을 연다(codex 권한 동등화 2단) — 정본 `packages/agent/src/codexRules.ts` 와 shared
//! `providerLane.ts` 의 `codexRulesFile`·`encodeCodexHookSpec`. 샌드박스는 그대로 바닥에 두고, 승인된 명령만 codex 명령 규칙으로 꺼낸다:
//!
//! - 규칙 파일 `<codexHome>/rules/harkroom.rules` — 이 에이전트의 **모든 채널** 승인 규칙의 합(서버 `reach`). codex 는 기동 때 이
//!   파일을 읽고 맞는 명령을 샌드박스 밖에서 돌린다.
//! - 턴 hook(`<codexHome>/hooks.json`, `harkroom-operator hook pretool --codex`) — 그 턴 **채널**의 규칙으로 다시 거르고, 밖으로 나갈
//!   명령의 실행 위치를 확인한다. hook 명령은 고정이다(신뢰 hash 가 턴마다 바뀌지 않게) — 턴마다 다른 값은 턴 env 로 간다.
//! - hook 신뢰 — codex 는 신뢰 기록이 없는 hook 을 돌리지 않는다. codex 자신(`app-server` 의 `hooks/list`)이 낸 hash 를 config 에
//!   적고, 다시 물어 `trusted` 를 확인한다. 확인하지 못하면 턴을 띄우지 않는다.
//!
//! 규칙 파일을 쓰지 않는 경우(= 승인 명령도 샌드박스 안): 옛 서버(합을 안 줌)·잰 판 밖의 codex·codex 홈이 샌드박스 쓰기 자리 안.
//! 그때는 남은 규칙 파일을 지운다 — codex 는 이 홈에서 뜨는 모든 턴에 그 파일을 싣는다.
//!
//! 정본과 다른 점(좁히는 쪽): `hooks/list` 의 줄 중 꼴이 맞지 않는 것은 버린다(정본은 그대로 실어 `undefined` 를 config 에 적을
//! 수 있다). 신뢰 절 끝 표시 뒤가 개행이 아니면 한 글자를 먹지 않는다. 오류 `Display` 에는 경로·입력 값이 없다(`local_detail`).
//! 아직 어디에도 연결하지 않는다 — 턴 조립·부르는 자리는 B3d.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use harkroom_proto::tool_rules::{RuleKind, ToolRuleVerdict, validate_tool_rule};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::workspace_trust::edit_codex_config;

/// 규칙 파일·hook 을 쓰는 codex 판(정확 일치, security W5). 대화 기록·hook 입력·신뢰 기록 꼴을 이 판에서 쟀다.
pub const CODEX_RULES_VERSIONS: &[&str] = &["0.154.0"];

/// codex 턴 hook 이 읽는 턴 env 이름(shared `CODEX_HOOK_SPEC_ENV`, 오퍼레이터 `codex_hook.rs` 와 같은 값).
pub const CODEX_HOOK_SPEC_ENV: &str = "HARKROOM_CODEX_HOOK";

const RULES_HEADER: &str =
    "# harkroom: owner-approved commands (written by the runner each turn; do not edit)";

static VERSION_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^codex-cli (\d+\.\d+\.\d+)$").expect("고정 정규식"));
/// `validateToolRule` 의 본문 글자와 같다 — 한 번 더 걸러 Starlark 문자열 밖으로 나갈 글자가 없게 한다.
static CODEX_RULE_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_./@=:+%-]+$").expect("고정 정규식"));
static LANE_HOOK_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$").expect("고정 정규식"));

pub fn codex_rules_version_ok(raw: Option<&str>) -> bool {
    VERSION_LINE
        .captures(raw.unwrap_or("").trim())
        .is_some_and(|c| CODEX_RULES_VERSIONS.contains(&&c[1]))
}

pub fn codex_rules_path(codex_home: &Path) -> PathBuf {
    codex_home.join("rules").join("harkroom.rules")
}

pub fn codex_hooks_path(codex_home: &Path) -> PathBuf {
    codex_home.join("hooks.json")
}

/// shared `codexRulesFile` — 승인 규칙 중 셸 규칙만 codex `prefix_rule` 로 옮긴다. 판정(`validate_tool_rule`)을 못 지나거나
/// 낱말에 Starlark 문자열 밖으로 나갈 글자가 있으면 조용히 뺀다. 같은 꼴은 한 줄로.
pub fn codex_rules_file<S: AsRef<str>>(rules: &[S]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut lines = vec![RULES_HEADER.to_string()];
    for raw in rules {
        let ToolRuleVerdict::Ok { rule, kind, .. } = validate_tool_rule(raw.as_ref()) else {
            continue;
        };
        if kind == RuleKind::McpTool {
            continue;
        }
        let Some(inner) = rule
            .strip_prefix("Bash(")
            .and_then(|r| r.strip_suffix(')'))
            .filter(|r| !r.is_empty())
        else {
            continue;
        };
        let mut body = inner.trim();
        if let Some(b) = body.strip_suffix(":*") {
            body = b.trim();
        }
        let words: Vec<&str> = body.split_whitespace().collect();
        if words.is_empty() || words.iter().any(|w| !CODEX_RULE_WORD.is_match(w)) {
            continue;
        }
        let quoted: Vec<String> = words.iter().map(|w| json_str(w)).collect();
        let pattern = format!("[{}]", quoted.join(", "));
        if !seen.insert(pattern.clone()) {
            continue;
        }
        lines.push(format!(
            "prefix_rule(pattern = {pattern}, decision = \"allow\")"
        ));
    }
    format!("{}\n", lines.join("\n"))
}

/// shared `encodeCodexHookSpec` — 꼴이 맞는 규칙만 싣는 base64url(덧붙임 없음) JSON.
pub fn encode_codex_hook_spec<S: AsRef<str>>(
    rules: &[S],
    reach: &[S],
    codex_home: &Path,
) -> String {
    let keep = |rs: &[S]| -> Vec<String> {
        rs.iter()
            .map(|r| r.as_ref())
            .filter(|r| LANE_HOOK_RULE.is_match(r))
            .map(str::to_string)
            .collect()
    };
    let doc = json!({
        "rules": keep(rules),
        "reach": keep(reach),
        "codexHome": codex_home.to_string_lossy(),
    });
    URL_SAFE_NO_PAD.encode(doc.to_string())
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).expect("문자열 직렬화")
}

/// hook 명령. `env -i` 로 codex 본체의 env(다리 열쇠·API 키)를 넘기지 않고, 판정에 쓰는 셋만 이름으로 다시 싣는다 — codex 가
/// hook 을 셸로 띄우므로 `"$이름"` 이 codex 의 env 값으로 풀린다. hook 이 어떤 길로 죽어도 차단 종료 코드 2 로 끝낸다.
pub fn codex_hook_command(operator_bin: &str) -> String {
    format!(
        "/usr/bin/env -i PATH=\"$PATH\" CODEX_HOME=\"$CODEX_HOME\" {CODEX_HOOK_SPEC_ENV}=\"${CODEX_HOOK_SPEC_ENV}\" {} hook pretool --codex || exit 2",
        json_str(operator_bin)
    )
}

pub fn codex_hooks_json(operator_bin: &str) -> String {
    let doc = json!({ "hooks": { "PreToolUse": [{ "matcher": ".*", "hooks": [{ "type": "command", "command": codex_hook_command(operator_bin) }] }] } });
    format!(
        "{}\n",
        serde_json::to_string_pretty(&doc).expect("JSON 직렬화")
    )
}

/// `hooks/list` 의 한 줄(쓰는 칸만).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHookListEntry {
    pub key: String,
    pub source_path: String,
    pub event_name: String,
    #[serde(default)]
    pub command: Option<String>,
    pub current_hash: String,
    pub trust_status: String,
}

/// codex 샌드박스(workspace-write)가 쓰기를 여는 자리 — 작업 폴더와 임시 폴더들. `temp_dir()` 는 `TMPDIR` 을 읽는다.
pub fn sandbox_writable_roots(workspace_dir: &Path) -> Vec<PathBuf> {
    vec![
        workspace_dir.to_path_buf(),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        PathBuf::from("/var/tmp"),
        std::env::temp_dir(),
    ]
}

/// codex 홈이 샌드박스 쓰기 자리 **밖**인가(security W1). 안이면 모델이 규칙 파일·hook·신뢰 기록·대화 기록을 고쳐 쓸 수 있다.
/// 실제 경로로 비교하고(마디 단위), 위·아래·같은 자리 모두 안으로 본다. 홈을 못 읽으면 거짓.
pub fn codex_home_outside_writable(codex_home: &Path, roots: &[PathBuf]) -> bool {
    let Ok(home) = fs::canonicalize(codex_home) else {
        return false;
    };
    for root in roots {
        if root.as_os_str().is_empty() {
            continue;
        }
        if let Ok(real) = fs::canonicalize(root)
            && (home.starts_with(&real) || real.starts_with(&home))
        {
            return false;
        }
    }
    true
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// 같은 글이면 쓰지 않는다. 폴더 0700, 0600 임시 파일 → rename(링크 대상을 덮지 않는다).
fn write_if_changed(path: &Path, text: &str) -> io::Result<()> {
    if fs::read_to_string(path).is_ok_and(|now| now == text) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = PathBuf::from(format!(
        "{}.{}.{millis}.tmp",
        path.to_string_lossy(),
        std::process::id()
    ));
    let written = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

const STATE_BEGIN: &str = "# harkroom:hook-trust begin (written by the runner; do not edit)";
const STATE_END: &str = "# harkroom:hook-trust end";

/// config.toml 에서 러너의 hook 신뢰 절을 바꿔 넣는다. 같은 값이면 `None`(쓰지 않음).
pub fn with_hook_trust(text: &str, key: &str, hash: &str) -> Option<String> {
    let block = format!(
        "{STATE_BEGIN}\n[hooks.state.{}]\nenabled = true\ntrusted_hash = {}\n{STATE_END}\n",
        json_str(key),
        json_str(hash)
    );
    if let Some(start) = text.find(STATE_BEGIN)
        && let Some(rel) = text[start..].find(STATE_END)
    {
        let mut stop = start + rel + STATE_END.len();
        if text[stop..].starts_with('\n') {
            stop += 1;
        }
        if text[start..stop] == block {
            return None;
        }
        return Some(format!("{}{block}{}", &text[..start], &text[stop..]));
    }
    let sep = if text.is_empty() || text.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    Some(format!("{text}{sep}\n{block}"))
}

/// `list_codex_hooks` 실패. 문구에 경로·codex 출력이 없다.
#[derive(Debug)]
pub enum ListHooksError {
    Spawn(io::Error),
    TimedOut,
    Exited,
    Failed,
}

impl fmt::Display for ListHooksError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Spawn(_) => "codex app-server 를 띄우지 못했다",
            Self::TimedOut => "codex hooks/list timed out",
            Self::Exited => "codex app-server exited before answering",
            Self::Failed => "codex hooks/list failed",
        })
    }
}

impl std::error::Error for ListHooksError {}

pub struct ListHooksOpts<'a> {
    pub codex_bin: &'a Path,
    pub codex_home: &'a Path,
    pub cwd: &'a Path,
    pub path: &'a str,
    pub home: Option<&'a Path>,
    pub timeout: Duration,
}

fn rpc_line(v: &Value) -> String {
    format!("{v}\n")
}

/// codex 자신에게 이 홈의 hook 목록을 묻는다(`codex app-server` → `hooks/list`). hash 를 우리가 짜 맞추지 않는 이유: hash 는
/// codex 가 정규화한 hook 선언에서 나오고 그 칸이 판마다 바뀔 수 있다. env 는 PATH·CODEX_HOME(·HOME)만.
pub fn list_codex_hooks(opts: &ListHooksOpts) -> Result<Vec<CodexHookListEntry>, ListHooksError> {
    let mut cmd = Command::new(opts.codex_bin);
    cmd.arg("app-server")
        .current_dir(opts.cwd)
        .env_clear()
        .env("PATH", opts.path)
        .env("CODEX_HOME", opts.codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(h) = opts.home {
        cmd.env("HOME", h);
    }
    let mut child = cmd.spawn().map_err(ListHooksError::Spawn)?;
    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::channel::<String>();
    // 읽기 스레드는 자식이 죽어 파이프가 닫히면 끝난다. 손자가 파이프를 쥐면 남을 수 있어 join 하지 않는다.
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + opts.timeout;
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "harkroom-runner", "version": "0" } } });
    let mut result = stdin
        .write_all(rpc_line(&init).as_bytes())
        .map_err(|_| ListHooksError::Exited);
    let out = loop {
        if let Err(e) = result {
            break Err(e);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match rx.recv_timeout(left) {
            Ok(l) => l,
            Err(mpsc::RecvTimeoutError::Timeout) => break Err(ListHooksError::TimedOut),
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err(ListHooksError::Exited),
        };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            result = Ok(());
            continue;
        };
        match msg.get("id").and_then(Value::as_i64) {
            Some(1) => {
                let next = rpc_line(&json!({ "jsonrpc": "2.0", "method": "initialized" }))
                    + &rpc_line(
                        &json!({ "jsonrpc": "2.0", "id": 2, "method": "hooks/list", "params": { "cwds": [opts.cwd.to_string_lossy()] } }),
                    );
                result = stdin
                    .write_all(next.as_bytes())
                    .map_err(|_| ListHooksError::Exited);
            }
            Some(2) => {
                let data = msg
                    .get("result")
                    .and_then(|r| r.get("data"))
                    .and_then(Value::as_array);
                break match (msg.get("error"), data) {
                    (None, Some(data)) => Ok(data
                        .iter()
                        .filter_map(|d| d.get("hooks").and_then(Value::as_array))
                        .flatten()
                        .filter_map(|h| serde_json::from_value(h.clone()).ok())
                        .collect()),
                    _ => Err(ListHooksError::Failed),
                };
            }
            _ => result = Ok(()),
        }
    };
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    out
}

/// 바깥(codex 판·hook 목록·로그)을 바꿔 끼우는 자리. 시험은 가짜를 넣는다.
pub trait CodexRulesDeps {
    /// `codex --version` 출력 — 턴마다 묻는다(판은 러너 모르게 바뀔 수 있다). 못 읽으면 `None`.
    fn version(&self) -> Option<String>;
    fn list_hooks(
        &self,
        codex_home: &Path,
        cwd: &Path,
    ) -> Result<Vec<CodexHookListEntry>, ListHooksError>;
    fn log(&self, _line: &str) {}
    /// 샌드박스 쓰기 자리 목록(기본 `sandbox_writable_roots`).
    fn writable_roots(&self, workspace_dir: &Path) -> Vec<PathBuf> {
        sandbox_writable_roots(workspace_dir)
    }
}

/// 규칙 파일을 **쓰지 않는** codex 길(읽기 전용·열쇠 없는 멘션 턴, 대화형 턴, 백그라운드)에서 띄우기 전에 부른다(security F1).
/// 잰 판 밖이거나 판을 못 읽으면 남은 규칙 파일을 지운다. 잰 판이면 그대로 둔다(그 턴의 hook 은 판정 값이 없어 막는다).
pub fn sweep_codex_rules(codex_home: &Path, deps: &dyn CodexRulesDeps) -> io::Result<()> {
    if codex_rules_version_ok(deps.version().as_deref()) {
        return Ok(());
    }
    deps.log("[codexRules] 잰 판 밖의 codex — 남은 규칙 파일을 지운다");
    remove_if_exists(&codex_rules_path(codex_home))
}

#[derive(Debug)]
pub enum CodexRulesError {
    /// codex 가 러너의 hook 을 신뢰하는지 확인하지 못했다 — 부르는 쪽은 턴을 띄우지 않는다.
    HookUntrusted,
    Io(io::Error),
}

impl CodexRulesError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::HookUntrusted => "codex_hook_untrusted",
            Self::Io(_) => "codex_rules_io",
        }
    }

    /// 로컬 로그 전용 — io 오류 문구까지 싣는다.
    pub fn local_detail(&self) -> String {
        match self {
            Self::HookUntrusted => self.to_string(),
            Self::Io(e) => format!("{self} ({e})"),
        }
    }
}

impl From<io::Error> for CodexRulesError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl fmt::Display for CodexRulesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HookUntrusted => f.write_str(
                "codex 가 러너의 명령 hook 을 신뢰하는지 확인하지 못해 턴을 띄우지 않았다(codex_hook_untrusted) — 러너 로그를 보라",
            ),
            Self::Io(_) => f.write_str("codex 규칙 파일·hook 을 갖추지 못했다 — 러너 로그를 보라"),
        }
    }
}

impl std::error::Error for CodexRulesError {}

pub struct PrepareCodexRules<'a> {
    pub codex_home: &'a Path,
    pub workspace_dir: &'a Path,
    pub operator_bin: &'a str,
    /// 그 턴 채널의 승인 규칙.
    pub rules: &'a [String],
    /// 이 에이전트의 모든 채널 승인 규칙의 합. `None` = 옛 서버(합을 안 줌).
    pub reach: Option<&'a [String]>,
}

/// 이 턴의 codex 규칙 파일·hook·hook 신뢰를 갖춘다. 돌려주는 env 를 그 턴의 codex env 에 얹는다(규칙을 쓰지 않으면 빈 표).
/// hook 신뢰를 확인하지 못하면 `HookUntrusted` — 부르는 쪽은 턴을 띄우지 않는다.
pub fn prepare_codex_rules(
    opts: &PrepareCodexRules,
    deps: &dyn CodexRulesDeps,
) -> Result<BTreeMap<String, String>, CodexRulesError> {
    let rules_path = codex_rules_path(opts.codex_home);
    let off = |why: &str| -> Result<BTreeMap<String, String>, CodexRulesError> {
        deps.log(&format!(
            "[codexRules] 규칙 파일을 쓰지 않는다({why}) — 승인 명령도 샌드박스 안에서 돈다"
        ));
        remove_if_exists(&rules_path)?;
        Ok(BTreeMap::new())
    };
    let Some(reach) = opts.reach else {
        return off("서버가 규칙 합을 주지 않음");
    };
    if !codex_rules_version_ok(deps.version().as_deref()) {
        return off("잰 판 밖의 codex");
    }
    if !codex_home_outside_writable(opts.codex_home, &deps.writable_roots(opts.workspace_dir)) {
        return off("codex 홈이 샌드박스 쓰기 자리 안");
    }

    // hook 을 먼저 갖추고 신뢰를 확인한 **뒤에** 규칙 파일을 쓴다 — 그 사이에 뜨는 다른 턴이 hook 없이 규칙만 싣지 않게.
    let hooks_path = codex_hooks_path(opts.codex_home);
    write_if_changed(&hooks_path, &codex_hooks_json(opts.operator_bin))?;
    let hooks_str = hooks_path.to_string_lossy().into_owned();
    let ours = || -> Vec<CodexHookListEntry> {
        deps.list_hooks(opts.codex_home, opts.workspace_dir)
            .unwrap_or_default()
            .into_iter()
            .filter(|h| h.source_path == hooks_str && h.event_name == "preToolUse")
            .collect()
    };
    let mut mine = ours();
    if let [only] = mine.as_slice()
        && only.trust_status != "trusted"
    {
        let (key, hash) = (only.key.clone(), only.current_hash.clone());
        edit_codex_config(&opts.codex_home.join("config.toml"), |text| {
            with_hook_trust(text, &key, &hash)
        })?;
        mine = ours();
    }
    if !matches!(mine.as_slice(), [only] if only.trust_status == "trusted") {
        remove_if_exists(&rules_path)?;
        return Err(CodexRulesError::HookUntrusted);
    }
    write_if_changed(&rules_path, &codex_rules_file(reach))?;
    Ok(BTreeMap::from([(
        CODEX_HOOK_SPEC_ENV.to_string(),
        encode_codex_hook_spec(opts.rules, reach, opts.codex_home),
    )]))
}

#[cfg(test)]
mod tests;

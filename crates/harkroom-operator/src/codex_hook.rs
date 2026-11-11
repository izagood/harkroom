//! `hook pretool --codex` 의 판정 — TS `packages/operator/src/codexHook.ts` 와 shared `providerLane.ts` 의
//! `parseCodexRulesFile`·`decodeCodexHookSpec` 이식(s21b-3d-3b-2b).
//!
//! - 그 턴 채널의 규칙으로 판정한다(`decide_tail_hook` 그대로). 합집합은 러너가 준 값과 **지금 규칙 파일**을 함께 본다.
//! - 판정을 통과해 **밖으로 나갈** 명령(그 턴 규칙에 맞는 셸 명령)만 실행 위치를 본다: codex 대화 기록 꼬리에서 그 호출 한 줄을
//!   찾아, 실행 폴더가 턴의 작업 폴더와 같을 때만 통과한다. 기록을 못 읽거나 줄이 하나가 아니면 막는다.
//! - 규칙 밖 명령은 판단하지 않는다(codex 샌드박스 안에서 돈다).
//!
//! TS 보다 좁은 곳: 상대 `workdir` 는 글자로 접은 경로(`path.join`)와 실제로 따라간 경로가 **둘 다** 작업 폴더여야 통과한다
//! (TS 는 글자로 접은 쪽만 본다 — `sub/..` 의 `sub` 가 심링크면 두 값이 갈린다).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use regex::Regex;
use serde_json::Value;

use crate::hook_cli::{LANE_HOOK_DENY_REASON, decide_tail_hook, lane_bash_allowed, lane_deny};
use crate::local_mcp::js_trim;

/// 대화 기록에서 읽는 꼬리의 상한.
pub const CODEX_TRANSCRIPT_TAIL_BYTES: u64 = 8 * 1024 * 1024;

/// 규칙 파일 자리 — 러너(`codexRulesPath`)와 같은 값.
pub const CODEX_RULES_RELATIVE: &str = "rules/harkroom.rules";

/// shared `CODEX_HOOK_SPEC_ENV`.
pub const CODEX_HOOK_SPEC_ENV: &str = "HARKROOM_CODEX_HOOK";

pub const CODEX_HOOK_WORKDIR_REASON: &str = "harkroom: an owner-approved command runs only in this turn's working folder. Run it again without a different working directory (workdir).";

/// shared `CODEX_RULE_WORD`.
static CODEX_RULE_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_./@=:+%-]+$").expect("정규식"));
static PREFIX_RULE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^prefix_rule\(pattern = \[(.*)\], decision = "allow"\)$"#).expect("정규식")
});
/// shared `LANE_HOOK_RULE`(hook_run 과 같은 식).
static LANE_HOOK_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$").expect("정규식"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexHookSpec {
    pub rules: Vec<String>,
    pub reach: Vec<String>,
    pub codex_home: String,
}

/// shared `parseCodexRulesFile` — 러너가 쓴 꼴 말고 다른 줄이 하나라도 있으면 `None`(부르는 쪽이 막는다).
pub fn parse_codex_rules_file(text: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let line = js_trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let m = PREFIX_RULE_LINE.captures(line)?;
        let mut words = Vec::new();
        for part in m.get(1).map_or("", |g| g.as_str()).split(", ") {
            let w: Value = serde_json::from_str(part).ok()?;
            let w = w.as_str()?;
            if !CODEX_RULE_WORD.is_match(w) {
                return None;
            }
            words.push(w.to_string());
        }
        if words.is_empty() {
            return None;
        }
        out.push(format!("Bash({})", words.join(" ")));
    }
    Some(out)
}

/// shared `decodeCodexHookSpec` — 풀지 못하면 `None`(부르는 쪽이 막는다).
pub fn decode_codex_hook_spec(value: &str) -> Option<CodexHookSpec> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let engine = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let bytes = engine.decode(value).ok()?;
    let p: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let list = |k: &str| -> Option<Vec<String>> {
        p.get(k)?
            .as_array()?
            .iter()
            .map(|r| {
                r.as_str()
                    .filter(|s| LANE_HOOK_RULE.is_match(s))
                    .map(str::to_string)
            })
            .collect()
    };
    let rules = list("rules")?;
    let reach = list("reach")?;
    let codex_home = p.get("codexHome")?.as_str()?;
    if !codex_home.starts_with('/') {
        return None;
    }
    Some(CodexHookSpec {
        rules,
        reach,
        codex_home: codex_home.to_string(),
    })
}

/// TS `hookMain` 의 codex 갈래 — 턴 env 값이 있으면 그것을 풀고(못 풀면 `None` = 막기), 없으면 `CODEX_HOME` 이 절대 경로일 때
/// 채널 규칙 없는 판정(규칙 파일의 명령에 닿으면 막고 그 밖은 넘김).
pub fn codex_spec_from_env(env: &dyn Fn(&str) -> Option<String>) -> Option<CodexHookSpec> {
    match env(CODEX_HOOK_SPEC_ENV).filter(|v| !v.is_empty()) {
        Some(raw) => decode_codex_hook_spec(&raw),
        None => env("CODEX_HOME")
            .filter(|h| h.starts_with('/'))
            .map(|h| CodexHookSpec {
                rules: vec![],
                reach: vec![],
                codex_home: h,
            }),
    }
}

/// 규칙 파일을 지금 읽은 승인 규칙. 파일이 없으면 빈 목록, 읽었는데 꼴이 다르거나 못 읽으면 `None`(막는다).
fn rules_file_now(codex_home: &str) -> Option<Vec<String>> {
    match std::fs::read(Path::new(codex_home).join(CODEX_RULES_RELATIVE)) {
        Ok(b) => parse_codex_rules_file(&String::from_utf8_lossy(&b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(vec![]),
        Err(_) => None,
    }
}

/// 파일 끝 `max` 바이트. 앞이 잘렸으면 첫 (잘린) 줄을 버린다(줄바꿈이 없으면 TS 처럼 그대로 둔다).
fn read_tail(path: &Path, max: u64) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let size = f.metadata()?.len();
    let start = size.saturating_sub(max);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(size - start).read_to_end(&mut buf)?;
    let body = if start == 0 {
        &buf[..]
    } else {
        match buf.iter().position(|&b| b == b'\n') {
            Some(i) => &buf[i + 1..],
            None => &buf[..],
        }
    };
    Ok(String::from_utf8_lossy(body).into_owned())
}

/// Node `path.join` 처럼 글자로 접는다(`.`·`..` 정리, 루트 위로는 못 간다).
fn lexical_join(base: &Path, rel: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in base.join(rel).components() {
        match c {
            Component::ParentDir => {
                if out.parent().is_some() {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k)?.as_str()
}

/// TS `checkCodexWorkdir` — 통과면 `None`, 아니면 거절(security W1~W3).
pub fn check_codex_workdir(
    input: &Value,
    command: &str,
    codex_home: &str,
    tail_bytes: u64,
) -> Option<Value> {
    let deny = || Some(lane_deny(CODEX_HOOK_WORKDIR_REASON));
    let (Some(transcript_path), Some(id)) = (
        str_of(input, "transcript_path"),
        str_of(input, "tool_use_id"),
    ) else {
        return deny();
    };
    if id.is_empty() {
        return deny();
    }
    let Some(cwd) = str_of(input, "cwd").filter(|c| Path::new(c).is_absolute()) else {
        return deny();
    };
    let inner = || -> Option<bool> {
        let home = std::fs::canonicalize(codex_home).ok()?;
        let transcript = std::fs::canonicalize(transcript_path).ok()?;
        if transcript == home || !transcript.starts_with(&home) {
            return Some(false);
        }
        let tail = read_tail(&transcript, tail_bytes).ok()?;
        let mut matches: Vec<serde_json::Map<String, Value>> = Vec::new();
        for line in tail.split('\n') {
            if !line.contains(id) {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let payload = rec.get("payload");
            if rec.get("type").and_then(Value::as_str) != Some("response_item")
                || payload
                    .and_then(|p| p.get("call_id"))
                    .and_then(Value::as_str)
                    != Some(id)
            {
                continue;
            }
            let payload = payload?;
            let ty = payload.get("type").and_then(Value::as_str);
            // 이미 결과가 적힌 호출 id 는 지금 호출이 아니다.
            if ty == Some("function_call_output") {
                return Some(false);
            }
            if ty != Some("function_call") {
                continue;
            }
            let args = payload.get("arguments").and_then(Value::as_str)?;
            let Ok(Value::Object(args)) = serde_json::from_str::<Value>(args) else {
                return Some(false);
            };
            matches.push(args);
        }
        if matches.len() != 1 {
            return Some(false);
        }
        let args = &matches[0];
        match args.get("cmd").and_then(Value::as_str) {
            Some(c) if js_trim(c) == js_trim(command) => {}
            _ => return Some(false),
        }
        let wd = match args.get("workdir") {
            None | Some(Value::Null) => return Some(true),
            Some(Value::String(s)) if !s.is_empty() => s.as_str(),
            _ => return Some(false),
        };
        let cwd_real = std::fs::canonicalize(cwd).ok()?;
        let wd_path = Path::new(wd);
        let (lexical, physical) = if wd_path.is_absolute() {
            (lexical_join(Path::new("/"), wd_path), wd_path.to_path_buf())
        } else {
            (
                lexical_join(Path::new(cwd), wd_path),
                Path::new(cwd).join(wd_path),
            )
        };
        let a = std::fs::canonicalize(lexical).ok()?;
        let b = std::fs::canonicalize(physical).ok()?;
        Some(a == cwd_real && b == cwd_real)
    };
    if inner() == Some(true) { None } else { deny() }
}

/// TS `decideCodexHook` — 막으면 거절, 판단하지 않으면 `None`.
pub fn decide_codex_hook(raw: &str, spec: &CodexHookSpec) -> Option<Value> {
    decide_codex_hook_with(raw, spec, CODEX_TRANSCRIPT_TAIL_BYTES)
}

pub fn decide_codex_hook_with(raw: &str, spec: &CodexHookSpec, tail_bytes: u64) -> Option<Value> {
    let Ok(input) = serde_json::from_str::<Value>(raw) else {
        return Some(lane_deny(LANE_HOOK_DENY_REASON));
    };
    let is_bash = str_of(&input, "tool_name") == Some("Bash");
    let file_rules = if is_bash {
        match rules_file_now(&spec.codex_home) {
            Some(r) => r,
            None => return Some(lane_deny(LANE_HOOK_DENY_REASON)),
        }
    } else {
        vec![]
    };
    let reach: Vec<String> = spec
        .reach
        .iter()
        .chain(file_rules.iter())
        .cloned()
        .collect();
    if let Some(d) = decide_tail_hook(raw, &spec.rules, &reach) {
        return Some(d);
    }
    // 여기까지 온 셸 명령 가운데 그 턴 규칙에 맞는 것만 밖으로 나간다(W4) — 그것만 실행 위치를 본다.
    let command = input.get("tool_input").and_then(|t| str_of(t, "command"));
    match command {
        Some(c) if is_bash && lane_bash_allowed(&spec.rules, Some(c)) => {
            check_codex_workdir(&input, c, &spec.codex_home, tail_bytes)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;

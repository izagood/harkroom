//! 하네스가 받는 모델 목록 — TS `packages/operator/src/harnessModels.ts` 이식(s9 G5).
//!
//! hello·`capabilities` 의 `harnesses.<하네스>.models` 로 올린다. 서버는 이 목록으로 스레드 모델 지정을
//! 거르고(`checkOffered`), 에이전트 설정·스레드 칩의 모델 고르개도 이것으로 그린다. 목록이 없으면 서버는
//! 「모른다」로 보고 무엇이든 받는다 — 그래서 Rust 오퍼레이터가 이것을 안 실으면 틀린 모델 이름이 게시 때
//! 걸러지지 않고 턴에서 죽는다.
//!
//! 묻는 수단(TS 와 같다):
//! - codex: `codex debug models` — 카탈로그 JSON. `visibility` 가 없거나 `list` 인 것만, `priority` 순.
//! - opencode: `opencode models` — 한 줄에 `provider/model` 하나.
//! - claude-code: 목록 명령이 없다 — `--model` 도움말이 밝힌 별칭 넷만 싣는다(실행하지 않는다).
//!
//! 실패는 `None`(모른다)이다. 빈 목록(없다)과 구별한다 — 모를 때 칸을 아예 싣지 않아야 화면이 직접 입력으로
//! 물러서고 서버도 막지 않는다.
//!
//! TS 와 다른 점 하나: TS 는 kilo·pi·omp 가 설치돼 있으면 그 하네스에도 `opencode models` 를 부른다(분기가
//! `claude-code`·`codex` 밖을 모두 opencode 로 본다). 여기서는 그 셋을 묻지 않고 「모른다」로 둔다 — 다른
//! 하네스의 목록을 그 하네스 것으로 올리지 않는다.
use serde_json::{Map, Value, json};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::harnesses::fallback_bin_dir;

/// `claude --help` 의 `--effort` 설명이 밝힌 값(TS `CLAUDE_EFFORTS`). 별칭 넷이 같은 목록을 쓴다.
pub const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `claude --help` 의 `--model` 설명이 예로 드는 별칭(TS `CLAUDE_MODEL_ALIASES`).
pub const CLAUDE_MODEL_ALIASES: [(&str, &str); 4] = [
    ("fable", "Fable (latest)"),
    ("opus", "Opus (latest)"),
    ("sonnet", "Sonnet (latest)"),
    ("haiku", "Haiku (latest)"),
];

/// 한 번의 조회가 기다리는 상한(TS `LIST_TIMEOUT_MS`). codex 는 카탈로그를 네트워크로 새로 받는다.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(20);

/// stdout 상한(TS `maxBuffer` 8MiB). 넘으면 실패(모른다)로 본다.
const MAX_STDOUT: u64 = 8 * 1024 * 1024;

/// 목록을 묻는 하네스(이 순서로 잰다).
pub const LISTED_HARNESSES: [&str; 3] = ["claude-code", "codex", "opencode"];

pub fn claude_models() -> Vec<Value> {
    CLAUDE_MODEL_ALIASES
        .iter()
        .map(|(id, label)| json!({ "id": id, "label": label, "efforts": CLAUDE_EFFORTS }))
        .collect()
}

/// codex 카탈로그의 `supported_reasoning_levels` → effort 이름들. 모양이 다르거나 비면 `None`.
fn codex_efforts(levels: Option<&Value>) -> Option<Vec<String>> {
    let out: Vec<String> = levels?
        .as_array()?
        .iter()
        .filter_map(|l| l.get("effort")?.as_str())
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .collect();
    (!out.is_empty()).then_some(out)
}

/// TS `parseCodexModels` — `codex debug models` 출력 → 사람이 고르는 목록. 모양이 다르면 `None`.
pub fn parse_codex_models(stdout: &str) -> Option<Vec<Value>> {
    let doc: Value = serde_json::from_str(stdout).ok()?;
    let models = doc.get("models")?.as_array()?;
    let mut picked: Vec<&Value> = models
        .iter()
        .filter(|m| m.get("slug").is_some_and(Value::is_string))
        .filter(|m| match m.get("visibility") {
            None => true,
            Some(v) => v.as_str() == Some("list"),
        })
        .collect();
    let priority = |m: &Value| {
        m.get("priority")
            .and_then(Value::as_f64)
            .unwrap_or(f64::INFINITY)
    };
    // 안정 정렬 — 같은 priority·priority 없음은 카탈로그 순서를 지킨다(TS Array.sort 와 같다).
    picked.sort_by(|a, b| priority(a).total_cmp(&priority(b)));
    Some(
        picked
            .into_iter()
            .map(|m| {
                let mut out = Map::new();
                out.insert("id".into(), m["slug"].clone());
                if let Some(label) = m.get("display_name").and_then(Value::as_str)
                    && !label.is_empty()
                {
                    out.insert("label".into(), json!(label));
                }
                if let Some(efforts) = codex_efforts(m.get("supported_reasoning_levels")) {
                    out.insert("efforts".into(), json!(efforts));
                }
                Value::Object(out)
            })
            .collect(),
    )
}

/// TS 정규식 `^[^\s/]+\/\S+$` — 첫 `/` 앞은 공백·`/` 없는 한 낱말, 뒤는 공백 없는 한 낱말.
fn is_provider_model(line: &str) -> bool {
    let Some((head, rest)) = line.split_once('/') else {
        return false;
    };
    !head.is_empty()
        && !rest.is_empty()
        && !head.chars().any(char::is_whitespace)
        && !rest.chars().any(char::is_whitespace)
}

/// TS `parseOpencodeModels` — `provider/model` 모양이 아닌 줄(경고 등)은 버리고, 겹치면 한 번만.
pub fn parse_opencode_models(stdout: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in stdout.split('\n') {
        let line = raw.trim();
        if !is_provider_model(line) || !seen.insert(line.to_string()) {
            continue;
        }
        out.push(json!({ "id": line }));
    }
    out
}

/// 하네스를 실행해 stdout 을 받는다. 실패·0 아닌 종료·시간 초과는 `None`.
pub type Exec<'a> = dyn Fn(&str, &[&str], &str) -> Option<String> + 'a;

/// 기본 실행기 — `PATH` 만 바꿔 부르고, `timeout` 을 넘기면 죽인다. stdout 은 따로 읽는다(카탈로그가
/// 파이프 버퍼보다 커도 막히지 않게).
pub fn system_exec(bin: &str, args: &[&str], path: &str, timeout: Duration) -> Option<String> {
    let mut child = Command::new(bin)
        .args(args)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stdout.take(MAX_STDOUT + 1).read_to_end(&mut buf).ok()?;
        (buf.len() as u64 <= MAX_STDOUT).then_some(buf)
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50))
            }
            // 실패·시간 초과 — 읽는 스레드는 기다리지 않는다(죽인 하네스의 자식이 파이프를 쥐고 있을 수 있다).
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let buf = reader.join().ok().flatten()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 러너와 같은 PATH 규칙(TS `listHarnessModels`) — 로그인 셸 PATH 뒤에 설치 관례 자리를 붙인다.
pub fn harness_path(harness: &str, login_path: Option<&str>, home: &Path) -> String {
    let mut parts: Vec<String> = login_path
        .filter(|p| !p.is_empty())
        .map(|p| vec![p.to_string()])
        .unwrap_or_default();
    if let Some(rel) = fallback_bin_dir(harness) {
        parts.push(home.join(rel).to_string_lossy().into_owned());
    }
    parts.join(":")
}

/// TS `listHarnessModels` — 그 하네스의 모델 목록, 모르면 `None`.
pub fn list_harness_models(
    harness: &str,
    login_path: Option<&str>,
    home: &Path,
    exec: &Exec,
) -> Option<Vec<Value>> {
    match harness {
        "claude-code" => Some(claude_models()),
        "codex" => parse_codex_models(&exec(
            "codex",
            &["debug", "models"],
            &harness_path(harness, login_path, home),
        )?),
        "opencode" => Some(parse_opencode_models(&exec(
            "opencode",
            &["models"],
            &harness_path(harness, login_path, home),
        )?)),
        _ => None,
    }
}

/// 설치된 하네스마다 목록을 잰다(TS communities.ts 의 기동 측정). 모르는 하네스는 칸이 없다.
pub fn measure(
    harnesses: &Map<String, Value>,
    login_path: Option<&str>,
    home: &Path,
    exec: &Exec,
) -> Map<String, Value> {
    let mut out = Map::new();
    for h in LISTED_HARNESSES {
        let installed = harnesses
            .get(h)
            .and_then(|v| v.get("installed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !installed {
            continue;
        }
        if let Some(list) = list_harness_models(h, login_path, home, exec) {
            out.insert(h.to_string(), Value::Array(list));
        }
    }
    out
}

/// TS `withModels` — 잰 목록이 있는 하네스에만 `models` 를 붙인다(`{installed, loggedIn, models}` 순).
pub fn with_models(
    mut harnesses: Map<String, Value>,
    models: &Map<String, Value>,
) -> Map<String, Value> {
    for (h, v) in harnesses.iter_mut() {
        if let (Some(list), Some(obj)) = (models.get(h), v.as_object_mut()) {
            obj.insert("models".into(), list.clone());
        }
    }
    harnesses
}

#[cfg(test)]
mod tests;

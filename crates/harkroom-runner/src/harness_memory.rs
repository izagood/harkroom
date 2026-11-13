//! 정본 `harnessMemory.ts` — 하네스 파일 메모리 **수확 알림**(메모리 고도화 U5).
//!
//! claude 는 `<CLAUDE_CONFIG_DIR>/projects/<cwd>/memory/` 에 파일로 기억을 적는데, 러너의 cwd 는 스레드마다 달라 거기 적힌 것은
//! 그 스레드에서만 보인다. 하네스를 끄거나 옮기지 않고 **알린다** — 새로 생기거나 바뀐 파일이 있으면 다음 턴 프롬프트에 목록을
//! 싣고 `memory.set` 으로 옮기라고 말한다. 알린 상태는 `<stateDir>/harness-memory-seen/<키 sha256 앞 32자>.json` 에 성공한 턴
//! 뒤에만 저장한다(`commit`).
//!
//! 정본과 다른 점: 이름 정렬은 UTF-8 바이트 순(정본은 UTF-16 코드 단위 순 — 보조 평면 글자가 섞일 때만 갈린다), 글자 수 자르기
//! (머리 2000·설명 200)는 유니코드 스칼라 단위(정본은 UTF-16 단위)다.

use std::fs;
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::prompt::escape_for_prompt;
use crate::turn_files::write_private;

pub const HARNESS_MEMORY_SEEN_DIR: &str = "harness-memory-seen";
/// 한 턴에 싣는 파일 수 상한 — 넘치면 "그 밖에 N개"로 줄인다.
pub const HARNESS_MEMORY_MAX_LISTED: usize = 10;
/// 파일마다 읽는 앞부분 바이트 수(정본 `READ_HEAD_BYTES`).
const READ_HEAD_BYTES: usize = 8192;

/// 정본 `claudeProjectDirName` — 영숫자가 아닌 글자는 전부 `-`(UTF-16 단위마다 하나라 보조 평면 글자는 `--`).
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .flat_map(|c| {
            let n = if c.is_ascii_alphanumeric() {
                0
            } else {
                c.len_utf16()
            };
            let keep = (n == 0).then_some(c);
            keep.into_iter().chain(std::iter::repeat_n('-', n))
        })
        .collect()
}

/// 정본 `claudeMemoryDir`. `config_dir` 이 없으면 claude 기본(`~/.claude`)을 본다.
pub fn claude_memory_dir(
    config_dir: Option<&Path>,
    home: &Path,
    cwd: &str,
    dir_under_config: &str,
) -> PathBuf {
    let base = config_dir.map_or_else(|| home.join(".claude"), Path::to_path_buf);
    base.join(dir_under_config)
        .join(claude_project_dir_name(cwd))
        .join("memory")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessMemoryFile {
    pub name: String,
    pub mtime_ms: i64,
    /// 프론트매터의 `description:` 한 줄(있으면).
    pub description: Option<String>,
}

static DESCRIPTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^description:\s*(.+)$").expect("정적 정규식"));

fn read_entry(dir: &Path, name: &str) -> Option<HarnessMemoryFile> {
    let path = dir.join(name);
    // 링크는 따르지 않는다 — 폴더 밖 파일을 끌어오지 않게 일반 파일만 받는다.
    let st = fs::symlink_metadata(&path).ok()?;
    if !st.file_type().is_file() {
        return None;
    }
    let mtime_ms = st
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    // 앞 8KB만 읽는다 — 머리 2000자(UTF-16 단위 최대 6000바이트)는 그 안에 다 든다.
    let mut raw = Vec::with_capacity(READ_HEAD_BYTES);
    // 검사와 열기 사이에 링크로 바뀌어도 따라가지 않는다(턴 연결 nit ①) — `O_NOFOLLOW` 로 연다.
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .ok()?
        .take(READ_HEAD_BYTES as u64)
        .read_to_end(&mut raw)
        .ok()?;
    let head: String = String::from_utf8_lossy(&raw).chars().take(2000).collect();
    let description = DESCRIPTION
        .captures(&head)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().chars().take(200).collect());
    Some(HarnessMemoryFile {
        name: name.to_owned(),
        mtime_ms,
        description,
    })
}

/// 정본 `scanHarnessMemory`. 인덱스(`MEMORY.md`)는 뺀다. 디렉터리가 없으면 빈 목록, 읽는 사이 지워진 파일은 없는 것으로 친다.
pub fn scan_harness_memory(dir: &Path) -> Vec<HarnessMemoryFile> {
    let Ok(rd) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut names: Vec<String> = rd
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
        .iter()
        .filter(|n| n.as_str() != "MEMORY.md" && n.ends_with(".md"))
        .filter_map(|n| read_entry(dir, n))
        .collect()
}

/// 정본 `HarnessMemoryNotice`. `commit` 은 성공한 턴 뒤에만 부른다.
#[derive(Debug)]
pub struct HarnessMemoryNotice {
    pub lines: Vec<String>,
    dir: PathBuf,
    file: PathBuf,
    next: Map<String, Value>,
}

impl HarnessMemoryNotice {
    /// 본 목록을 적는다. 실패는 삼키고 로그 한 줄 — 다음 턴이 다시 알린다.
    pub fn commit(&self) {
        let res = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.dir)
            .and_then(|()| {
                let mut root = Map::new();
                root.insert("files".into(), Value::Object(self.next.clone()));
                let body =
                    serde_json::to_string(&Value::Object(root)).map_err(std::io::Error::other)?;
                write_private(&self.file, &body)
            });
        if let Err(e) = res {
            eprintln!("[harnessMemory] 본 목록 저장 실패 — 다음 턴이 다시 알린다: {e}");
        }
    }
}

fn seen_file(state_dir: &Path, key: &str) -> PathBuf {
    let hex: String = Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    state_dir
        .join(HARNESS_MEMORY_SEEN_DIR)
        .join(format!("{}.json", &hex[..32]))
}

fn load_seen(file: &Path) -> Map<String, Value> {
    fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v.get("files") {
            Some(Value::Object(m)) => Some(m.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// 정본 `planHarnessMemoryNotice`. 본 목록과 mtime 이 다른 파일만 알린다.
pub fn plan_harness_memory_notice(
    state_dir: &Path,
    key: &str,
    files: &[HarnessMemoryFile],
) -> HarnessMemoryNotice {
    let file = seen_file(state_dir, key);
    let seen = load_seen(&file);
    let fresh: Vec<&HarnessMemoryFile> = files
        .iter()
        .filter(|f| seen.get(&f.name).and_then(Value::as_f64) != Some(f.mtime_ms as f64))
        .collect();
    let next: Map<String, Value> = files
        .iter()
        .map(|f| (f.name.clone(), Value::from(f.mtime_ms)))
        .collect();
    let mut lines = vec![];
    if !fresh.is_empty() {
        lines.push("<harness-memory>".to_owned());
        lines.push("이 스레드의 하네스 파일 메모리(작업 디렉터리 기준이라 **다른 스레드에서는 안 보인다**)에 새로 적히거나".to_owned());
        lines.push("바뀐 파일이 있다. 다른 스레드·다른 턴에서도 쓸 것이면 `memory.set` 으로 옮겨라(주제는 `mem/<이름>`,".to_owned());
        lines.push(
            "한 작업의 경위는 `kind: \"journal\"`). 이 스레드에서만 쓸 메모면 그대로 둬도 된다."
                .to_owned(),
        );
        for f in fresh.iter().take(HARNESS_MEMORY_MAX_LISTED) {
            let desc = f
                .description
                .as_deref()
                .filter(|d| !d.is_empty())
                .map(|d| format!(" — {}", escape_for_prompt(d)))
                .unwrap_or_default();
            lines.push(format!("- {}{desc}", escape_for_prompt(&f.name)));
        }
        if fresh.len() > HARNESS_MEMORY_MAX_LISTED {
            lines.push(format!(
                "- …그 밖에 {}개",
                fresh.len() - HARNESS_MEMORY_MAX_LISTED
            ));
        }
        lines.push("</harness-memory>".to_owned());
    }
    HarnessMemoryNotice {
        lines,
        dir: state_dir.join(HARNESS_MEMORY_SEEN_DIR),
        file,
        next,
    }
}

#[cfg(test)]
#[path = "harness_memory_tests.rs"]
mod tests;

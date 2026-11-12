//! 화면으로 끝을 아는 하네스(codex·opencode·omp)의 **기록 읽개** — 정본 `codexSessions.ts`·`opencodeSessions.ts`·
//! `harnessLastSaid.ts`·`harnessTurnEnd.ts`·`opencodeTurnState.ts`.
//!
//! - 세션 찾기: codex 는 `<sessions>/<yyyy>/<mm>/<dd>/rollout-<시각>-<uuid>.jsonl` 의 첫 줄(`session_meta.cwd`)로, opencode 는
//!   `opencode session list --format json` 의 `directory` 로 이 턴의 워크스페이스와 맞춘다(둘 다 실경로로 비교).
//! - 끝말(`read_harness_last_said`): 화면 답 대신 원문을 옮기려고 읽는다. **끝 판정에는 쓰지 않는다**.
//! - 턴 끝(`read_harness_turn_end`·`read_opencode_turn_state`): 화면은 언제 물을지만 정하고 끝은 기록이 정한다.
//!
//! 모두 **던지지 않는다** — 못 읽으면 `None` 이고 부르는 쪽은 화면 판정으로 돌아간다. `since_ms` 앞의 기록은 이 턴의 것이 아니다
//! (되살린 세션은 앞 턴의 끝으로 끝나 있다).
//!
//! 정본과 다른 점: ① 디렉터리는 이름순으로 훑는다(정본은 OS 가 준 순서 — 같은 id 의 파일이 둘일 때만 갈린다) ② rollout 첫 줄은
//! 16MiB 까지만 읽는다(넘으면 그 파일은 맞지 않은 것으로 친다) ③ 시각은 ISO(`…Z`·`…±HH:MM`)만 읽는다(정본 `Date.parse` 는 더 넓다)
//! ④ opencode 명령은 자식 프로세스 그룹째 시한 안에서 걷는다(`pi_home::run_capped_with`).

use std::cmp::Ordering;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, UNIX_EPOCH};

use regex::Regex;
use serde_json::Value;

use crate::adapter::{
    AgentHarness, LastSaidRecord, TurnEndRecord, last_said_record_of, turn_end_record_of,
};
use crate::config::Env;
use crate::omp_home::omp_session_file;
use crate::pi_home::run_capped_with;
use crate::poll_loop::parse_iso_offset_ms;

/// 파일 시각의 반올림·클럭 오차 여유(정본 `MTIME_TOLERANCE_MS`·`TIME_TOLERANCE_MS`).
const TIME_TOLERANCE_MS: i64 = 2000;
/// 차례 표지는 끝쪽에 있다 — 꼬리만 읽는다(정본 `ROLLOUT_TAIL_BYTES`).
pub const ROLLOUT_TAIL_BYTES: u64 = 1024 * 1024;
/// rollout 첫 줄 상한(정본에는 없다 — 맨 위 ②).
const FIRST_LINE_MAX_BYTES: u64 = 16 * 1024 * 1024;
const OPENCODE_TIMEOUT: Duration = Duration::from_secs(20);
const OPENCODE_LIST_MAX_BYTES: usize = 8 * 1024 * 1024;
const OPENCODE_EXPORT_MAX_BYTES: usize = 32 * 1024 * 1024;

static ROLLOUT_FILE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^rollout-.*\.jsonl$").expect("정규식"));
static FILENAME_UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$",
    )
    .expect("정규식")
});

/// 기록이 말하는 차례 상태(정본 `RecordedTurnEnd`·opencode `'ended' | 'working'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordedTurnEnd {
    Working,
    Ended,
}

// ───────────────────────── codex 세션 찾기(정본 codexSessions.ts) ─────────────────────────

/// `dir` 아래 `rollout-*.jsonl` 을 재귀로 모은다. 링크는 따라가지 않는다(정본 `withFileTypes`). 없으면 빈 목록.
fn walk_rollout_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = rd.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    let mut files = Vec::new();
    for entry in entries {
        let Ok(ft) = entry.file_type() else { continue };
        let full = entry.path();
        if ft.is_dir() {
            files.extend(walk_rollout_files(&full));
        } else if ft.is_file() && ROLLOUT_FILE_RE.is_match(&entry.file_name().to_string_lossy()) {
            files.push(full);
        }
    }
    files
}

fn read_first_line(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file.take(FIRST_LINE_MAX_BYTES));
    let mut buf = Vec::new();
    reader.read_until(b'\n', &mut buf).ok()?;
    if buf.is_empty() {
        return None;
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 실경로. 대상이 없으면 절대 경로로 만들고 `.`·`..` 만 정리한다(정본 `realpath` → `resolve`).
fn normalize_cwd(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|d| d.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn extract_filename_uuid(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    FILENAME_UUID_RE.captures(&name).map(|c| c[1].to_string())
}

/// `payload.id` 를 쓰고, 파일명 uuid 와 어긋나면 파일명을 믿는다(정본 `resolveSessionId`).
fn resolve_session_id(path: &Path, payload: &serde_json::Map<String, Value>) -> Option<String> {
    let filename_id = extract_filename_uuid(path);
    let payload_id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let (Some(p), Some(f)) = (&payload_id, &filename_id)
        && p != f
    {
        eprintln!("[codexSessions] payload.id 가 파일명의 uuid 와 다르다 — 파일명을 신뢰한다");
        return filename_id;
    }
    payload_id.or(filename_id)
}

fn match_rollout_file(path: &Path, target_cwd: &Path) -> Option<String> {
    let line = read_first_line(path)?;
    let parsed: Value = serde_json::from_str(&line).ok()?;
    let obj = parsed.as_object()?;
    if obj.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = obj.get("payload")?.as_object()?;
    let cwd = payload.get("cwd")?.as_str()?;
    if normalize_cwd(Path::new(cwd)) != target_cwd {
        return None;
    }
    resolve_session_id(path, payload)
}

/// 정본 `codexRolloutFileFor` — 파일 이름 끝의 uuid 가 `session_id` 인 rollout. 경로는 id 로 짓지 않고 훑은 이름과 비교만 한다.
pub fn codex_rollout_file_for(sessions_dir: &Path, session_id: &str) -> Option<PathBuf> {
    walk_rollout_files(sessions_dir)
        .into_iter()
        .find(|f| extract_filename_uuid(f).as_deref() == Some(session_id))
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    let d = m.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(d.as_millis()).ok()
}

/// 정본 `findCodexSessionId` — mtime 최신부터(같으면 경로 역순) 훑어 `session_meta.cwd` 가 `cwd` 이고 `since_ms` 뒤에 쓰인 첫 파일의 id.
pub fn find_codex_session_id(sessions_dir: &Path, cwd: &Path, since_ms: i64) -> Option<String> {
    let target = normalize_cwd(cwd);
    let mut candidates: Vec<(PathBuf, i64)> = walk_rollout_files(sessions_dir)
        .into_iter()
        .filter_map(|f| mtime_ms(&f).map(|m| (f, m)))
        .collect();
    candidates.sort_by(|a, b| match b.1.cmp(&a.1) {
        Ordering::Equal => b.0.cmp(&a.0),
        o => o,
    });
    candidates
        .into_iter()
        .filter(|(_, m)| *m >= since_ms - TIME_TOLERANCE_MS)
        .find_map(|(f, _)| match_rollout_file(&f, &target))
}

// ───────────────────────── opencode 세션 찾기(정본 opencodeSessions.ts) ─────────────────────────

/// opencode 를 부를 자리 — 명령·환경(통째로 바꾼다)·턴의 워크스페이스(목록이 프로젝트 단위라 거기서 묻는다).
#[derive(Clone, Copy)]
pub struct OpencodeCall<'a> {
    pub command: &'a Path,
    pub env: &'a Env,
    pub cwd: &'a Path,
}

/// 정본 `findOpencodeSessionId` — `session list` 에서 `directory` 가 워크스페이스(실경로)이고 `since_ms` 뒤에 만든 가장 새 세션.
pub fn find_opencode_session_id(call: OpencodeCall<'_>, since_ms: i64) -> Option<String> {
    let args = ["session", "list", "--format", "json", "-n", "50"].map(String::from);
    let out = match run_capped_with(
        call.command,
        &args,
        call.env,
        call.cwd,
        OPENCODE_LIST_MAX_BYTES,
        OPENCODE_TIMEOUT,
    ) {
        Ok(out) => out,
        Err(e) => {
            // 「명령을 못 불렀다」와 「세션이 없다」를 가르려고 한 줄 남긴다(정본 2026-09-23).
            let name = call
                .command
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            eprintln!("[opencodeSessions] 목록 명령 실패 ({name}): {e}");
            return None;
        }
    };
    pick_opencode_session(&out, call.cwd, since_ms)
}

/// `session list` 출력에서 고른다(명령 없이 시험하려고 나눴다).
pub fn pick_opencode_session(json: &str, cwd: &Path, since_ms: i64) -> Option<String> {
    let rows: Value = serde_json::from_str(json).ok()?;
    let want = normalize_cwd(cwd);
    let mut best: Option<(String, f64)> = None;
    for row in rows.as_array()? {
        let (Some(id), Some(dir)) = (
            row.get("id").and_then(Value::as_str),
            row.get("directory").and_then(Value::as_str),
        ) else {
            continue;
        };
        if normalize_cwd(Path::new(dir)) != want {
            continue;
        }
        let at = row
            .get("created")
            .and_then(Value::as_f64)
            .or_else(|| row.get("updated").and_then(Value::as_f64))
            .unwrap_or(0.0);
        if at + (TIME_TOLERANCE_MS as f64) < since_ms as f64 {
            continue;
        }
        if best.as_ref().is_none_or(|(_, b)| at > *b) {
            best = Some((id.to_string(), at));
        }
    }
    best.map(|(id, _)| id)
}

fn opencode_export(call: OpencodeCall<'_>, id: &str) -> Option<String> {
    let args = ["export".to_string(), id.to_string()];
    run_capped_with(
        call.command,
        &args,
        call.env,
        call.cwd,
        OPENCODE_EXPORT_MAX_BYTES,
        OPENCODE_TIMEOUT,
    )
    .ok()
}

// ───────────────────────── 기록 해석 ─────────────────────────

fn records_backward(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.split('\n')
        .rev()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
}

fn record_at(rec: &Value) -> Option<i64> {
    rec.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_offset_ms)
}

fn joined_text(items: &[Value], kind: &str) -> Option<String> {
    let said = items
        .iter()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some(kind))
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let said = said.trim();
    (!said.is_empty()).then(|| said.to_string())
}

/// 정본 `lastSaidFromCodexRollout` — 마지막 assistant 글. 그 뒤에 도구 호출이 있으면 끝말이 아니다.
pub fn last_said_from_codex_rollout(text: &str, since_ms: i64) -> Option<String> {
    for rec in records_backward(text) {
        if rec.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        if record_at(&rec).is_none_or(|at| at < since_ms) {
            return None;
        }
        let payload = rec.get("payload");
        let kind = payload.and_then(|p| p.get("type")).and_then(Value::as_str);
        if matches!(kind, Some("function_call" | "custom_tool_call")) {
            return None;
        }
        let role = payload.and_then(|p| p.get("role")).and_then(Value::as_str);
        let content = payload
            .and_then(|p| p.get("content"))
            .and_then(Value::as_array);
        let (Some("message"), Some("assistant"), Some(content)) = (kind, role, content) else {
            continue;
        };
        return joined_text(content, "output_text");
    }
    None
}

/// `export` 의 마지막 메시지가 이 턴에 끝난 assistant(도구 호출 대기 아님)인가 — 끝말·턴 끝 공통 판정.
fn opencode_last_message(json: &str) -> Option<Value> {
    let root: Value = serde_json::from_str(json).ok()?;
    root.get("messages")?.as_array()?.last().cloned()
}

fn opencode_finished(info: &Value, since_ms: i64) -> bool {
    let time = info.get("time");
    let created = time.and_then(|t| t.get("created")).and_then(Value::as_f64);
    let completed = time
        .and_then(|t| t.get("completed"))
        .and_then(Value::as_f64);
    let finish = info.get("finish").and_then(Value::as_str);
    created.is_some_and(|c| c >= since_ms as f64)
        && info.get("role").and_then(Value::as_str) == Some("assistant")
        && completed.is_some()
        && finish.is_some_and(|f| f != "tool-calls")
}

/// 정본 `lastSaidFromOpencodeExport`.
pub fn last_said_from_opencode_export(json: &str, since_ms: i64) -> Option<String> {
    let last = opencode_last_message(json)?;
    let info = last.get("info")?;
    if !info.is_object() || !opencode_finished(info, since_ms) {
        return None;
    }
    joined_text(last.get("parts")?.as_array()?, "text")
}

/// 정본 `opencodeTurnStateFromExport` — `None` 은 **모른다**(형식이 다르다·메시지가 없다). 이 턴 앞의 메시지면 `Working`.
pub fn opencode_turn_state_from_export(json: &str, since_ms: i64) -> Option<RecordedTurnEnd> {
    let last = opencode_last_message(json)?;
    let info = last.get("info").filter(|i| i.is_object())?;
    Some(if opencode_finished(info, since_ms) {
        RecordedTurnEnd::Ended
    } else {
        RecordedTurnEnd::Working
    })
}

/// 정본 `turnEndFromCodexRollout` — 마지막 차례 표지(`task_started` → 일하는 중, `task_complete`·`turn_aborted` → 끝).
pub fn turn_end_from_codex_rollout(text: &str, since_ms: i64) -> Option<RecordedTurnEnd> {
    for rec in records_backward(text) {
        if rec.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let kind = rec
            .get("payload")
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str);
        let state = match kind {
            Some("task_started") => RecordedTurnEnd::Working,
            Some("task_complete" | "turn_aborted") => RecordedTurnEnd::Ended,
            _ => continue,
        };
        if record_at(&rec).is_none_or(|at| at < since_ms) {
            return None;
        }
        return Some(state);
    }
    None
}

/// 정본 `turnEndFromOmpSession` — 도구 결과·사용자 입력이나 `toolUse` 로 끝난 assistant 면 일하는 중, 그 밖의 `stopReason` 이면 끝.
pub fn turn_end_from_omp_session(text: &str, since_ms: i64) -> Option<RecordedTurnEnd> {
    for rec in records_backward(text) {
        if rec.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if record_at(&rec).is_none_or(|at| at < since_ms) {
            return None;
        }
        let msg = rec.get("message");
        let role = msg.and_then(|m| m.get("role")).and_then(Value::as_str);
        if matches!(role, Some("toolResult" | "user")) {
            return Some(RecordedTurnEnd::Working);
        }
        let stop = msg
            .and_then(|m| m.get("stopReason"))
            .and_then(Value::as_str);
        return match (role, stop) {
            (Some("assistant"), Some("toolUse")) => Some(RecordedTurnEnd::Working),
            (Some("assistant"), Some(_)) => Some(RecordedTurnEnd::Ended),
            _ => None,
        };
    }
    None
}

/// 꼬리 [`ROLLOUT_TAIL_BYTES`]. 잘린 첫 줄은 해석에서 저절로 빠진다(정본 `readTail`). 링크는 따라간다(정본 `open`).
fn read_tail(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let len = size.min(ROLLOUT_TAIL_BYTES);
    file.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = Vec::with_capacity(usize::try_from(len).ok()?);
    file.take(len).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn read_whole(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

// ───────────────────────── 하네스별 묻기 ─────────────────────────

pub struct HarnessLastSaidOpts<'a> {
    pub session_id: Option<&'a str>,
    pub since_ms: i64,
    pub codex_sessions_dir: &'a Path,
    pub opencode: OpencodeCall<'a>,
}

/// 정본 `readHarnessLastSaid` — 이 턴의 마지막 말. 못 읽으면 `None`(호출자는 화면 답으로 돌아간다).
pub fn read_harness_last_said(
    harness: AgentHarness,
    opts: &HarnessLastSaidOpts<'_>,
) -> Option<String> {
    match last_said_record_of(harness)? {
        LastSaidRecord::CodexRollout => {
            let file = codex_rollout_file_for(opts.codex_sessions_dir, opts.session_id?)?;
            last_said_from_codex_rollout(&read_whole(&file)?, opts.since_ms)
        }
        LastSaidRecord::OpencodeExport => {
            let id = match opts.session_id {
                Some(id) => id.to_string(),
                None => find_opencode_session_id(opts.opencode, opts.since_ms)?,
            };
            last_said_from_opencode_export(&opencode_export(opts.opencode, &id)?, opts.since_ms)
        }
    }
}

pub struct HarnessTurnEndOpts<'a> {
    /// 첫 턴은 아직 모른다 — `cwd` 로 찾는다.
    pub session_id: Option<&'a str>,
    pub cwd: &'a Path,
    pub since_ms: i64,
    pub codex_sessions_dir: &'a Path,
    /// omp 턴만 있다.
    pub omp_home: Option<&'a Path>,
}

/// 정본 `readHarnessTurnEnd` — 기록이 말하는 차례 상태. 읽을 기록이 없거나 못 읽으면 `None`.
pub fn read_harness_turn_end(
    harness: AgentHarness,
    opts: &HarnessTurnEndOpts<'_>,
) -> Option<RecordedTurnEnd> {
    match turn_end_record_of(harness)? {
        TurnEndRecord::OmpSession => {
            let file = omp_session_file(opts.omp_home?, opts.session_id?)?;
            turn_end_from_omp_session(&read_tail(&file)?, opts.since_ms)
        }
        TurnEndRecord::CodexRollout => {
            let id = match opts.session_id {
                Some(id) => id.to_string(),
                None => find_codex_session_id(opts.codex_sessions_dir, opts.cwd, opts.since_ms)?,
            };
            let file = codex_rollout_file_for(opts.codex_sessions_dir, &id)?;
            turn_end_from_codex_rollout(&read_tail(&file)?, opts.since_ms)
        }
    }
}

/// 정본 `readOpencodeTurnState` — 세션 id 를 모르면(첫 턴) 워크스페이스로 찾는다. 명령 실패·형식 불일치는 `None`(모른다).
pub fn read_opencode_turn_state(
    call: OpencodeCall<'_>,
    session_id: Option<&str>,
    since_ms: i64,
) -> Option<RecordedTurnEnd> {
    let id = match session_id {
        Some(id) => id.to_string(),
        None => find_opencode_session_id(call, since_ms)?,
    };
    opencode_turn_state_from_export(&opencode_export(call, &id)?, since_ms)
}

#[cfg(test)]
#[path = "harness_records_tests.rs"]
mod tests;

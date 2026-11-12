//! 하네스가 **자기 입으로** 낸 사실을 세션 기록(JSONL)에서 읽는다(B4-2f-1). 정본은
//! `packages/agent/src/harnessErrors.ts` — 왜 PTY tail 이 아니라 기록인지(앞이 잘림·사람 입력 에코)는 정본 머리
//! 주석이 정본이다. 하네스 출력 파싱이 아니라 「디스크의 사실 관측」이다.
//!
//! 전부 **던지지 않는다**(정본과 같다) — 못 읽으면 `None` 이고 호출자는 판정을 하지 않는다.
//! 정본 575줄의 함수를 전부 옮겼다: API 에러·자란 시각·턴 상태·하위 작업·꼬리 읽기·끝말·권한 거부·macOS 권한
//! 대기·MCP 헤더 거절·입력 줄 자람. 각 함수의 「왜」(사건·실측)는 정본 주석이 정본이고 여기엔 요지만 둔다.
//!
//! 정본과 다른 점 하나: `describeInput` 의 `JSON.stringify` 는 `serde_json::to_string`(키 순서 보존)이라 정수가
//! 아닌 수(`1.0`)의 표기가 다를 수 있다 — 사람에게 보이는 거부 통지의 입력 요약에만 쓰여 판정에는 닿지 않는다.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde_json::Value;

use crate::adapter::{AgentHarness, reads_session_transcript};
use crate::poll_loop::parse_iso_offset_ms;
use crate::review_fork::claude_session_file_path;

/// 세션 파일을 찾는 자리 — 정본 `opts.configDir`·`projectsDir`(홈 아래 `~/.claude`).
#[derive(Debug, Clone, Copy, Default)]
pub struct TranscriptDirs<'a> {
    pub config_dir: Option<&'a Path>,
    pub home: Option<&'a Path>,
}

/// 정본 `HarnessApiError` — 하네스 문구 원문. 여기서 해석하지 않는다(판정은 정책 쪽).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessApiError {
    pub text: String,
}

/// 정본 `textOf` — `message.content` 가 문자열이면 그대로, 배열이면 `text` 칸을 이어 붙인다. 비면 `None`.
pub(crate) fn text_of(record: &Value) -> Option<String> {
    content_text(record.get("message")?.get("content")?)
}

/// `text_of` 의 몸 — `content` 값 하나에서 텍스트를 뽑는다(정본 `textOf({ message: { content } })`).
fn content_text(content: &Value) -> Option<String> {
    let joined = match content {
        Value::String(s) => s.trim().to_owned(),
        Value::Array(parts) => parts
            .iter()
            .map(|p| p.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect::<String>()
            .trim()
            .to_owned(),
        _ => return None,
    };
    (!joined.is_empty()).then_some(joined)
}

fn session_file(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
) -> Option<std::path::PathBuf> {
    // 기록을 읽을 줄 모르는 하네스는 멈춘다 — 억지로 읽으면 tail 폴백을 가린다(정본).
    if !reads_session_transcript(harness) {
        return None;
    }
    let id = session_id.filter(|s| !s.is_empty())?;
    claude_session_file_path(id, dirs.config_dir, dirs.home)
}

/// 정본 `readLastApiError` — 이 세션에서 하네스가 **마지막으로** 낸 API 에러.
/// `since_ms` 가 있으면 그 시각 이후 레코드만 센다. 시각을 모르는 레코드는 세지 않는다.
pub fn read_last_api_error(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
    since_ms: Option<i64>,
) -> Option<HarnessApiError> {
    let path = session_file(harness, session_id, dirs)?;
    let raw = fs::read(&path).ok()?;
    let raw = String::from_utf8_lossy(&raw);
    let mut last: Option<String> = None;
    for line in raw.split('\n') {
        // 값싼 사전 거르기(정본) — 대부분의 줄에는 이 필드가 없다.
        if !line.contains("isApiErrorMessage") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue; // 깨진 줄 하나가 나머지를 막지 않는다
        };
        if record.get("isApiErrorMessage") != Some(&Value::Bool(true)) {
            continue;
        }
        if let Some(since) = since_ms {
            let at = record
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_iso_offset_ms);
            match at {
                Some(at) if at >= since => {}
                _ => continue,
            }
        }
        if let Some(t) = text_of(&record) {
            last = Some(t);
        }
    }
    last.map(|text| HarnessApiError { text })
}

/// 정본 `sessionTranscriptMtimeMs` — 기록 파일이 마지막으로 자란 시각(ms). 못 읽으면 `None`(판정하지 않는다).
/// 정본 `stat` 처럼 링크를 따라간다.
pub fn session_transcript_mtime_ms(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
) -> Option<i64> {
    let path = session_file(harness, session_id, dirs)?;
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(ms).ok()
}

/// 레코드의 `timestamp` 를 ms 로. 문자열이 아니거나 못 읽으면 `None`(정본 `Date.parse` → NaN).
fn record_at_ms(record: &Value) -> Option<i64> {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_offset_ms)
}

/// 정본 `!Number.isFinite(at) || at < sinceMs` — `since` 가 있을 때 이 시각이 그 앞이거나 모르면 참.
fn before_since(at: Option<i64>, since_ms: Option<i64>) -> bool {
    match since_ms {
        None => false,
        Some(since) => at.is_none_or(|at| at < since),
    }
}

fn is_true(record: &Value, key: &str) -> bool {
    record.get(key) == Some(&Value::Bool(true))
}

fn type_is(record: &Value, ty: &str) -> bool {
    record.get("type").and_then(Value::as_str) == Some(ty)
}

/// 정본 `readTranscriptTurnState` 의 값 — `None` 은 판정할 수 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptTurnState {
    /// `since_ms` 이후 마지막 대화 레코드가 `stop_reason: end_turn` 인 어시스턴트 말(API 에러 아님).
    Ended,
    /// 마지막 대화 레코드가 도구 호출·도구 결과·새 입력이거나, 이 턴의 대화가 아직 시작되지 않았다.
    Working,
}

/// 정본 `readTranscriptTurnState` — 이 턴에서 하네스가 자기 차례를 끝냈는가. 꼬리 256KB 만 거꾸로 본다.
/// `system/turn_duration` 같은 비대화 레코드·곁가지(sidechain)는 건너뛴다.
pub fn read_transcript_turn_state(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
    since_ms: Option<i64>,
) -> Option<TranscriptTurnState> {
    let text = tail_for(harness, session_id, dirs)?;
    for line in text.split('\n').rev() {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !type_is(&record, "user") && !type_is(&record, "assistant") {
            continue;
        }
        if is_true(&record, "isSidechain") {
            continue;
        }
        // 이 턴 이전의 말이다 — 이 턴의 대화는 아직 시작되지 않았다(정본).
        if before_since(record_at_ms(&record), since_ms) {
            return Some(TranscriptTurnState::Working);
        }
        let ended = type_is(&record, "assistant")
            && !is_true(&record, "isApiErrorMessage")
            && record
                .get("message")
                .and_then(|m| m.get("stop_reason"))
                .and_then(Value::as_str)
                == Some("end_turn");
        return Some(if ended {
            TranscriptTurnState::Ended
        } else {
            TranscriptTurnState::Working
        });
    }
    None
}

/// 정본 `readTranscriptPendingBackground` — 턴을 끝낸 하네스에 남은 자식 작업 수(서브에이전트 + 워크플로).
/// `None` 은 **모른다**(이 턴의 `turn_duration` 이 아직 없음 등) — 호출자는 유예 쪽을 고른다.
pub fn read_transcript_pending_background(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
    since_ms: Option<i64>,
) -> Option<f64> {
    let text = tail_for(harness, session_id, dirs)?;
    for line in text.split('\n').rev() {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if is_true(&record, "isSidechain") {
            continue;
        }
        if type_is(&record, "user") || type_is(&record, "assistant") {
            // 이 턴의 대화가 turn_duration 보다 뒤에 있다 — 아직 안 적혔거나 턴이 이어지고 있다.
            return None;
        }
        if !type_is(&record, "system")
            || record.get("subtype").and_then(Value::as_str) != Some("turn_duration")
        {
            continue;
        }
        if before_since(record_at_ms(&record), since_ms) {
            return None;
        }
        // 정본 `n(v)` — 유한한 양수만 세고 나머지(없음·음수·문자열)는 0.
        let n = |key: &str| {
            record
                .get(key)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v > 0.0)
                .unwrap_or(0.0)
        };
        return Some(n("pendingBackgroundAgentCount") + n("pendingWorkflowCount"));
    }
    None
}

/// 정본 `TAIL_BYTES` — 기록은 수 MB 가 되고 꼬리 읽개는 몇 초마다 돈다.
pub const TAIL_BYTES: u64 = 256 * 1024;

/// 정본 `readTranscriptTail` — 기록 파일의 꼬리 [`TAIL_BYTES`] 를 읽는다. 앞이 잘렸으면 잘린 첫 줄(반쪽 JSON)을
/// 버린다(개행이 없으면 정본 `slice(indexOf+1)` 처럼 통째로 둔다). 정본 `open` 처럼 링크를 따라간다. 던지지 않는다.
pub fn read_transcript_tail(session_id: &str, dirs: TranscriptDirs<'_>) -> Option<String> {
    let path = claude_session_file_path(session_id, dirs.config_dir, dirs.home)?;
    let mut file = fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let len = size.min(TAIL_BYTES);
    file.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = Vec::with_capacity(usize::try_from(len).ok()?);
    file.take(len).read_to_end(&mut buf).ok()?;
    let body = if len < size {
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => &buf[i + 1..],
            None => &buf[..],
        }
    } else {
        &buf[..]
    };
    Some(String::from_utf8_lossy(body).into_owned())
}

/// 하네스·세션을 확인하고 꼬리를 읽는다 — 꼬리 읽개 공통 머리(정본의 `readsSessionTranscript`·`!sessionId` 두 줄).
fn tail_for(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
) -> Option<String> {
    if !reads_session_transcript(harness) {
        return None;
    }
    let id = session_id.filter(|s| !s.is_empty())?;
    read_transcript_tail(id, dirs)
}

/// 정본 `recordsSince` — 꼬리의 줄들 중 `since_ms` 이후의 주 대화(user·assistant, 곁가지 아님) 레코드만, 앞에서부터.
pub fn records_since(text: &str, since_ms: Option<i64>) -> Vec<Value> {
    text.split('\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|r| (type_is(r, "user") || type_is(r, "assistant")) && !is_true(r, "isSidechain"))
        .filter(|r| !before_since(record_at_ms(r), since_ms))
        .collect()
}

/// 정본 `readLastAssistantText` — 이 턴에서 하네스가 차례를 끝내며 남긴 마지막 말(`end_turn` 어시스턴트 레코드의
/// 텍스트만 — 도구 호출 사이의 혼잣말은 끝의 이유가 아니다).
pub fn read_last_assistant_text(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
    since_ms: Option<i64>,
) -> Option<String> {
    let text = tail_for(harness, session_id, dirs)?;
    records_since(&text, since_ms).iter().rev().find_map(|r| {
        let end_turn = type_is(r, "assistant")
            && !is_true(r, "isApiErrorMessage")
            && r.get("message")
                .and_then(|m| m.get("stop_reason"))
                .and_then(Value::as_str)
                == Some("end_turn");
        if end_turn { text_of(r) } else { None }
    })
}

/// 정본 `PermissionDenial` — 권한 분류기가 거부한 도구 호출 하나. 값은 원문이고 가리기는 호출자가 한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionDenial {
    /// 짝 맞춤과 중복 제거의 열쇠.
    pub tool_use_id: String,
    /// 도구 이름. 짝 `tool_use` 가 꼬리 밖이면 `?`.
    pub tool: String,
    /// Bash 는 명령, 그 밖은 입력 JSON. 짝이 없으면 빈 문자열.
    pub input: String,
    /// 분류기가 댄 이유 원문. 못 읽으면 `(이유 없음)`.
    pub reason: String,
}

/// 정본 `DENIAL_HEAD` — 로컬·서버 쪽 분류기가 같은 머리를 쓴다(2026-09-30 실측).
const DENIAL_HEAD: &str =
    "Permission for this action was denied by the Claude Code auto mode classifier.";
static DENIAL_REASON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)Reason: (.+?)\. If you ").expect("DENIAL_REASON"));

/// 도구 결과(`tool_result`)의 본문 — 문자열이면 원문 그대로, 배열이면 `text_of` 와 같이(정본).
fn tool_result_body(part: &Value) -> String {
    match part.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(c) => content_text(c).unwrap_or_default(),
        None => String::new(),
    }
}

/// 정본 `describeInput` — Bash 는 명령 그 자체, 그 밖은 JSON 한 줄. 입력이 없으면 빈 문자열.
fn describe_input(input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    if let Some(cmd) = input.get("command").and_then(Value::as_str) {
        return cmd.to_owned();
    }
    serde_json::to_string(input).unwrap_or_default()
}

/// 정본 `String(part.name ?? '?')`.
fn tool_name(part: &Value) -> String {
    match part.get("name") {
        None | Some(Value::Null) => "?".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// 레코드의 `message.content` 배열 조각들(배열이 아니면 빈 것).
fn content_parts(record: &Value) -> &[Value] {
    record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// 정본 `readPermissionDenials` — 이 턴에 권한 분류기가 거부한 도구 호출들(앞에서부터). 도구 결과 원문의 **머리**로만
/// 판정한다 — 에이전트가 말 속에 같은 문장을 인용해도 어시스턴트 텍스트라 걸리지 않는다. 짝(`tool_use`)은 시각과
/// 무관하게 모으고 거부 결과만 `since_ms` 로 거른다.
pub fn read_permission_denials(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
    since_ms: Option<i64>,
) -> Vec<PermissionDenial> {
    let Some(text) = tail_for(harness, session_id, dirs) else {
        return Vec::new();
    };
    let mut uses: HashMap<String, (String, String)> = HashMap::new();
    let mut out = Vec::new();
    for r in records_since(&text, None) {
        let at = record_at_ms(&r);
        for part in content_parts(&r) {
            if !part.is_object() {
                continue;
            }
            let ty = part.get("type").and_then(Value::as_str);
            if ty == Some("tool_use")
                && let Some(id) = part.get("id").and_then(Value::as_str)
            {
                uses.insert(
                    id.to_owned(),
                    (tool_name(part), describe_input(part.get("input"))),
                );
                continue;
            }
            let Some(use_id) = part.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            if ty != Some("tool_result") || before_since(at, since_ms) {
                continue;
            }
            let body = tool_result_body(part);
            if !body.starts_with(DENIAL_HEAD) {
                continue;
            }
            let (tool, input) = uses
                .get(use_id)
                .cloned()
                .unwrap_or_else(|| ("?".to_owned(), String::new()));
            let reason = DENIAL_REASON
                .captures(&body)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().trim().to_owned())
                .unwrap_or_else(|| "(이유 없음)".to_owned());
            out.push(PermissionDenial {
                tool_use_id: use_id.to_owned(),
                tool,
                input,
                reason,
            });
        }
    }
    out
}

/// 정본 `MacPermissionWait['state']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacPermissionState {
    /// 결과 없이 오래 걸림 — 권한 창이 떠 있을 공산.
    Waiting,
    /// 하네스(Bash) 시한에 걸림.
    Timeout,
    /// 거부됨(-1743, errAEEventNotPermitted).
    Denied,
}

/// 정본 `MacPermissionWait` — macOS 권한 창(TCC) 앞에 선 osascript 호출 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacPermissionWait {
    pub tool_use_id: String,
    pub state: MacPermissionState,
    /// `tell application "…"` 의 앱 이름. 못 읽으면 `None`.
    pub target: Option<String>,
    /// 명령 원문(가리기는 호출자가 한다).
    pub input: String,
}

static APPLE_EVENT_DENIED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-1743\b|Not authori[sz]ed to send Apple events|Apple 이벤트를 보낼 권한")
        .expect("APPLE_EVENT_DENIED")
});
static BASH_TIMEOUT_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Command did not complete within its \d+s timeout").expect("BASH_TIMEOUT_HEAD")
});
static OSASCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[\s;&|(])osascript\b").expect("OSASCRIPT"));
static TELL_APP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tell application "([^"\n]{1,80})""#).expect("TELL_APP"));

/// 정본 `MAC_PERMISSION_PENDING_MS` — osascript 는 보통 몇 초 안에 끝난다. 이만큼 결과가 없으면 창 앞에 선 것으로 본다.
pub const MAC_PERMISSION_PENDING_MS: i64 = 15_000;

/// 정본 `readMacPermissionWaits` — 이 턴에 macOS 권한 창 앞에 선 osascript 호출들. 결과 판정(거부·시한)이 앞에서부터,
/// 그 뒤에 결과 없는 호출(`Waiting`)이 호출 순서로 온다(정본 순서). 러너는 **알리기만** 한다 — 허용하거나 돌아가지 않는다.
pub fn read_mac_permission_waits(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
    since_ms: Option<i64>,
    now_ms: i64,
    pending_ms: i64,
) -> Vec<MacPermissionWait> {
    let Some(text) = tail_for(harness, session_id, dirs) else {
        return Vec::new();
    };
    // 정본 `Map` 의 순서(처음 넣은 자리)를 지킨다 — 같은 id 를 다시 넣으면 값만 바뀐다.
    let mut order: Vec<String> = Vec::new();
    let mut uses: HashMap<String, (String, Option<i64>)> = HashMap::new();
    let mut done: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let of = |id: &str, state, command: &str| MacPermissionWait {
        tool_use_id: id.to_owned(),
        state,
        target: TELL_APP
            .captures(command)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_owned()),
        input: command.to_owned(),
    };
    for r in records_since(&text, None) {
        let at = record_at_ms(&r);
        for part in content_parts(&r) {
            if !part.is_object() {
                continue;
            }
            let ty = part.get("type").and_then(Value::as_str);
            if ty == Some("tool_use")
                && part.get("name").and_then(Value::as_str) == Some("Bash")
                && let Some(id) = part.get("id").and_then(Value::as_str)
            {
                let command = part
                    .get("input")
                    .and_then(|i| i.get("command"))
                    .and_then(Value::as_str);
                if let Some(command) = command.filter(|c| OSASCRIPT.is_match(c))
                    && uses
                        .insert(id.to_owned(), (command.to_owned(), at))
                        .is_none()
                {
                    order.push(id.to_owned());
                }
                continue;
            }
            if ty != Some("tool_result") {
                continue;
            }
            let Some(use_id) = part.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let Some((command, _)) = uses.get(use_id) else {
                continue;
            };
            done.insert(use_id.to_owned());
            if before_since(at, since_ms) {
                continue;
            }
            let body = tool_result_body(part);
            if APPLE_EVENT_DENIED.is_match(&body) {
                out.push(of(use_id, MacPermissionState::Denied, command));
            } else if BASH_TIMEOUT_HEAD.is_match(&body) {
                out.push(of(use_id, MacPermissionState::Timeout, command));
            }
        }
    }
    for id in &order {
        if done.contains(id) {
            continue;
        }
        let Some((command, Some(at))) = uses.get(id) else {
            continue; // 시각을 모르는 호출은 기다림을 잴 수 없다
        };
        if since_ms.is_some_and(|since| *at < since) {
            continue;
        }
        if now_ms - at >= pending_ms {
            out.push(of(id, MacPermissionState::Waiting, command));
        }
    }
    out
}

/// 정본 `AUTH_HEADER_REJECTED` — 헤더로 받은 토큰을 MCP 서버가 401 로 거절했을 때 claude 가 붙이는 코드(2.1.286 실측).
const AUTH_HEADER_REJECTED: &str = "AUTH_HEADER_REJECTED";

/// 정본 `readMcpAuthRejections` — 이 턴에 우리가 구운 `Authorization` 헤더를 거절당한 MCP 서버 이름들(중복 없이 처음 본
/// 순서로). `attachment.failedMcpServers[].errorCode` 로만 판정한다 — `error` 문구는 서버 본문이 섞여 해석하지 않는다.
pub fn read_mcp_auth_rejections(
    harness: AgentHarness,
    session_id: Option<&str>,
    dirs: TranscriptDirs<'_>,
    since_ms: Option<i64>,
) -> Vec<String> {
    let Some(text) = tail_for(harness, session_id, dirs) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        // 싸게 먼저 거른다 — 꼬리 대부분은 이 코드가 없다(정본).
        if !line.contains(AUTH_HEADER_REJECTED) {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !type_is(&record, "attachment") || is_true(&record, "isSidechain") {
            continue;
        }
        if before_since(record_at_ms(&record), since_ms) {
            continue;
        }
        let Some(failed) = record
            .get("attachment")
            .and_then(|a| a.get("failedMcpServers"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for f in failed {
            if f.get("errorCode").and_then(Value::as_str) != Some(AUTH_HEADER_REJECTED) {
                continue;
            }
            let Some(name) = f.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !name.is_empty() && !out.iter().any(|n| n == name) {
                out.push(name.to_owned());
            }
        }
    }
    out
}

/// 정본 `sessionTranscriptGrewSince` — `since_ms` 이후 시각이 찍힌 **사람 입력 줄**(`type:"user"`, 메타·곁가지 제외)이
/// 기록에 생겼는가. mtime 이 아닌 이유: `claude -r` 은 입력을 받기 전에 메타 줄로 파일을 건드린다(2.1.295 실측).
/// **판정할 수 없으면 참이다**(기록을 못 읽는 하네스·세션 미상) — 거짓이면 그 턴들이 매번 사람을 부른다.
/// 파일을 못 읽으면 거짓(첫 턴: 아직 파일이 없다).
pub fn session_transcript_grew_since(
    harness: AgentHarness,
    session_id: Option<&str>,
    since_ms: i64,
    dirs: TranscriptDirs<'_>,
) -> bool {
    if !reads_session_transcript(harness) {
        return true;
    }
    let Some(id) = session_id.filter(|s| !s.is_empty()) else {
        return true;
    };
    let Some(text) = read_transcript_tail(id, dirs) else {
        return false;
    };
    text.split('\n')
        .filter(|line| line.contains("\"user\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|r| {
            type_is(&r, "user")
                && !is_true(&r, "isMeta")
                && !is_true(&r, "isSidechain")
                && record_at_ms(&r).is_some_and(|at| at >= since_ms)
        })
}

#[cfg(test)]
#[path = "harness_errors_tests.rs"]
mod tests;

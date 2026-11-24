//! 턴 토큰 읽기(PX0) — 턴이 끝난 뒤 그 턴의 하네스 기록에서 usage 합계를 읽어 턴 끝 보고(`POST /agent/activity`)의
//! 선택 칸 `tokens` 로 싣는다. **측정만 한다** — 읽지 못하면 칸을 싣지 않고(「모름」, 0 이 아니다) 턴 결과에 닿지 않는다.
//!
//! - 읽는 것은 claude 꼴 기록(jsonl)의 assistant 레코드 `message.usage` 뿐이다. 기록을 읽을 줄 모르는 하네스는 `None`.
//! - 같은 응답이 내용 조각마다 여러 줄로 적힌다(같은 `message.id`, 같은 usage) — id 마다 **마지막 줄 하나만** 센다.
//! - 턴 시작 뒤 레코드만 센다. 시각을 모르는 레코드는 세지 않는다(지난 턴 것을 이번 턴 것으로 집지 않는다).
//! - 싣는 것은 수와 이름(하네스·모델 id)뿐 — 글·프롬프트·경로는 싣지 않는다.

use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::{Value, json};

use crate::adapter::{AgentHarness, reads_session_transcript};
use crate::poll_loop::parse_iso_offset_ms;

/// 이보다 큰 기록은 읽지 않는다(「모름」) — 턴 끝을 붙잡지 않는다.
pub const MAX_TRANSCRIPT_BYTES: u64 = 256 * 1024 * 1024;
/// 모델 id 길이 상한(글자). 서버도 같은 상한으로 다시 자른다.
pub const MODEL_ID_MAX_CHARS: usize = 80;

/// 턴 하나의 토큰 합계. 캐시 칸이 기록에 없으면 0 으로 더한다(그 응답이 캐시를 쓰지 않았다).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// 센 응답 수(`message.id` 단위).
    pub messages: u64,
    /// 마지막으로 본 모델 id — 하네스가 준 글자 그대로(길이만 자른다).
    pub model: Option<String>,
}

fn count(usage: &serde_json::Map<String, Value>, key: &str) -> u64 {
    usage.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// 줄들에서 `since_ms` 뒤 assistant 레코드의 usage 를 더한다. 깨진 줄·usage 없는 줄은 건너뛴다. 하나도 못 세면 `None`.
pub fn sum_claude_usage<I, S>(lines: I, since_ms: i64) -> Option<TurnTokens>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    // (message.id, usage 넷) — 같은 id 는 뒤 줄이 덮는다. id 없는 레코드는 각자 하나로 센다.
    let mut seen: Vec<(Option<String>, [u64; 4])> = Vec::new();
    let mut model = None;
    for line in lines {
        let line = line.as_ref();
        // 싼 걸러내기 — usage 가 없는 줄(도구 결과 등 큰 줄)은 JSON 으로 열지 않는다.
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if rec.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let at = rec
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_offset_ms);
        if at.is_none_or(|at| at < since_ms) {
            continue;
        }
        let Some(msg) = rec.get("message") else {
            continue;
        };
        let Some(Value::Object(u)) = msg.get("usage") else {
            continue;
        };
        let nums = [
            count(u, "input_tokens"),
            count(u, "output_tokens"),
            count(u, "cache_read_input_tokens"),
            count(u, "cache_creation_input_tokens"),
        ];
        // 하네스가 스스로 지어낸 줄(API 를 부르지 않았다)은 모델 id 로 삼지 않는다.
        if let Some(m) = msg.get("model").and_then(Value::as_str)
            && !m.is_empty()
            && m != "<synthetic>"
        {
            model = Some(m.chars().take(MODEL_ID_MAX_CHARS).collect::<String>());
        }
        let id = msg.get("id").and_then(Value::as_str).map(str::to_owned);
        match seen
            .iter_mut()
            .rev()
            .find(|(k, _)| id.is_some() && *k == id)
        {
            Some(slot) => slot.1 = nums,
            None => seen.push((id, nums)),
        }
    }
    if seen.is_empty() {
        return None;
    }
    let mut t = TurnTokens {
        messages: seen.len() as u64,
        model,
        ..TurnTokens::default()
    };
    for (_, n) in &seen {
        t.input = t.input.saturating_add(n[0]);
        t.output = t.output.saturating_add(n[1]);
        t.cache_read = t.cache_read.saturating_add(n[2]);
        t.cache_write = t.cache_write.saturating_add(n[3]);
    }
    Some(t)
}

/// 이 턴의 기록 파일에서 토큰 합계를 읽는다. 기록을 읽을 줄 모르는 하네스·없는 파일·너무 큰 파일·읽기 실패는 `None`.
pub fn read_turn_tokens(
    harness: AgentHarness,
    transcript: Option<&Path>,
    since_ms: i64,
) -> Option<TurnTokens> {
    if !reads_session_transcript(harness) {
        return None;
    }
    let file = std::fs::File::open(transcript?).ok()?;
    if file.metadata().ok()?.len() > MAX_TRANSCRIPT_BYTES {
        return None;
    }
    // 줄 하나가 UTF-8 이 아니면 거기서 멈춘다 — 그 앞까지 센 것만 쓴다.
    sum_claude_usage(BufReader::new(file).lines().map_while(Result::ok), since_ms)
}

/// 턴 끝 보고에 싣는 본문(`{ "tokens": { … } }`). 모델을 모르면 그 칸은 없다.
pub fn activity_body(harness: AgentHarness, t: &TurnTokens, duration_ms: u64) -> Value {
    let mut tokens = json!({
        "harness": harness.as_str(),
        "input": t.input,
        "output": t.output,
        "cacheRead": t.cache_read,
        "cacheWrite": t.cache_write,
        "messages": t.messages,
        "durationMs": duration_ms,
    });
    if let Some(m) = &t.model {
        tokens["model"] = json!(m);
    }
    json!({ "tokens": tokens })
}

#[cfg(test)]
#[path = "turn_tokens_tests.rs"]
mod tests;

//! 정본 `mentionScheduler.ts` 의 잎 판정(B4-1b-1) — 상수·재시도 간격·카드 답 사유·깨움 대상·묶음 자격.
//! 스케줄러 본체(`createMentionScheduler`, admit·유예·자리·계정 축)는 B4-1b-2 가 이 위에 얹는다.
//! 입력은 서버가 준 inbox 줄(`serde_json::Value`) 그대로다 — 정본이 meta 를 `unknown` 으로 받아 모양을 하나씩
//! 확인하는 것과 같게, 모양이 다르면 「없음」으로 떨어진다.

use serde_json::Value;

/// 카드에 선택지 대신 글로 답했다는 표지(`@harkroom/shared` `ASK_TEXT_OPTION_ID`).
pub const ASK_TEXT_OPTION_ID: &str = "__text__";

/// 조종이 이만큼 이어지면 스레드에 `막힘`으로 한 번 세운다(정본 `DEFER_WARN_MS`).
pub const DEFER_WARN_MS: u64 = 10 * 60_000;
/// 또는 대기가 이만큼 쌓이면(정본 `DEFER_WARN_PENDING`).
pub const DEFER_WARN_PENDING: usize = 3;
/// 앞 턴 대기 통지 장부의 상한. 넘으면 오래된 것부터 지운다.
pub const BLOCKED_NOTICED_MAX: usize = 500;
/// 한 턴으로 묶는 멘션 수의 상한.
pub const BUNDLE_MAX_ENTRIES: usize = 10;
/// 이 횟수만큼 실패한 entry 는 묶지 않고 하나씩 띄운다.
pub const BUNDLE_MAX_FAILURES: u32 = 2;
/// 끝났는데 읽음 처리가 안 된 entry 를 「다시 띄우지 않는다」로 기억하는 상한.
pub const DONE_UNREAD_MAX_MS: u64 = 24 * 60 * 60 * 1000;
/// 읽음 처리까지 끝낸 entry 를 「다시 띄우지 않는다」로 기억하는 시간.
pub const RECENTLY_DONE_MS: u64 = 10 * 60 * 1000;
/// 관문 때문에 접어 둔 멘션을 기다리는 상한.
pub const GATE_WAIT_MAX_MS: u64 = 2 * 60 * 60 * 1000;
/// 턴 임대가 아직 정해지지 않은 멘션을 다시 묻는 간격.
pub const LEASE_RETRY_MS: u64 = 15_000;
/// 임대를 다시 묻는 상한(서버 `LEASE_REISSUE_STALE_MS` 6분 + 폴·재시도 간격).
pub const LEASE_WAIT_MAX_MS: u64 = 8 * 60_000;
/// 한 멘션을 관문 때문에 접어 다시 띄우는 횟수 상한(#1047 security F1 안전판).
pub const GATE_REQUEUE_MAX: u32 = 5;

/// 앞 턴 대기 통지를 올리는 사유 — 사람이 부른 것만(정본 `BLOCKED_NOTICE_REASONS`).
pub fn is_blocked_notice_reason(reason: &str) -> bool {
    matches!(reason, "mention" | "thread_reply" | "dm" | "team_mention")
}

/// 정본 `isInvalidToolInput` — 서버가 도구 입력을 검증에서 거절했나(MCP `-32602`).
/// `code` 는 오류 객체의 숫자 칸, `message` 는 그 문구다.
pub fn is_invalid_tool_input(code: Option<i64>, message: &str) -> bool {
    if code == Some(-32602) {
        return true;
    }
    let lower = message.to_lowercase();
    lower.contains("-32602")
        || lower.contains("invalid arguments")
        || lower.contains("invalid enum")
}

/// 정본 `backoffFor` — `tried` 번 실패한 entry 가 다음 시도까지 쉬는 시간(30초 → 60초 상한).
/// 사다리는 정본 `policy.ts::nextBackoffMs`(2배·60초 상한)와 같은 [`crate::link::next_backoff_ms`].
pub fn backoff_for(tried: u32) -> u64 {
    let mut ms = 30_000;
    for _ in 1..tried {
        ms = crate::link::next_backoff_ms(ms);
    }
    ms
}

fn ask_meta(meta: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    meta?.get("ask")?.as_object()
}

/// 정본 `askClosedNote` — 카드가 답 없이 닫혔을 때 턴에게 주는 사유.
pub fn ask_closed_note(meta: Option<&Value>) -> &'static str {
    let expired = ask_meta(meta)
        .and_then(|a| a.get("closedReason"))
        .and_then(Value::as_str)
        == Some("expired");
    if expired {
        "내가 낸 권한 요청이 승인 없이 시한을 넘겨 만료됐다 — 아직 그 권한이 필요하면 permission.request 로 다시 청하고, 필요 없으면 그것 없이 접어라"
    } else {
        "내가 낸 선택지에 사람이 답하지 않기로 했다 — 그 선택을 기다리지 말고, 지금 아는 것으로 접거나 다른 길을 골라라(같은 물음을 다시 내지 마라)"
    }
}

/// 사람이 카드에 직접 쓴 답.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrittenAnswer {
    pub by: Option<String>,
    pub text: String,
}

fn ask_written_answer(meta: Option<&Value>) -> Option<WrittenAnswer> {
    let ask = ask_meta(meta)?;
    if ask.get("answeredWith").and_then(Value::as_str) != Some(ASK_TEXT_OPTION_ID) {
        return None;
    }
    let text = ask.get("answeredText")?.as_str()?.to_string();
    let by = ask
        .get("answeredBy")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(WrittenAnswer { by, text })
}

fn ask_answered_note(meta: Option<&Value>) -> String {
    let ask = ask_meta(meta);
    let Some(picked) = ask
        .and_then(|a| a.get("answeredWith"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return "내가 낸 선택지에 답이 왔다(어느 것인지 스레드에서 확인해라)".to_string();
    };
    let label = ask
        .and_then(|a| a.get("options"))
        .and_then(Value::as_array)
        .and_then(|opts| {
            opts.iter()
                .find(|o| o.get("id").and_then(Value::as_str) == Some(picked))
        })
        .and_then(|o| o.get("label"))
        .and_then(Value::as_str);
    format!(
        "내가 낸 선택지에 답이 왔다 — 고른 것: {}",
        label.unwrap_or(picked)
    )
}

/// 정본 `askAnsweredWake` 의 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskAnsweredWake {
    pub reason: String,
    pub written: Option<WrittenAnswer>,
}

/// 정본 `askAnsweredWake` — 답이 온 깨움. 직접 쓴 답의 글은 사유에 넣지 않고 `written` 으로 따로 준다.
pub fn ask_answered_wake(id: &str, meta: Option<&Value>) -> AskAnsweredWake {
    if let Some(written) = ask_written_answer(meta) {
        return AskAnsweredWake {
            reason: format!(
                "내가 낸 카드 harkroom://message/{id} 에 사람이 선택지 대신 글로 답했다 — 바로 아래 줄이 그 카드의 답이다. 같은 스레드의 다른 카드는 그대로 열려 있다"
            ),
            written: Some(written),
        };
    }
    let ask = ask_meta(meta);
    if ask
        .and_then(|a| a.get("answeredWith"))
        .and_then(Value::as_str)
        == Some(ASK_TEXT_OPTION_ID)
    {
        // 거울에는 글이 없다 — 글은 원본 카드에만 있다.
        let source = ask
            .and_then(|a| a.get("mirrorOf"))
            .and_then(Value::as_str)
            .map(|m| format!(" — 그 글은 원본 카드 harkroom://message/{m} 에 있다"))
            .unwrap_or_default();
        return AskAnsweredWake {
            reason: format!(
                "내가 낸 카드 harkroom://message/{id} 에 사람이 선택지 대신 글로 답했다{source}"
            ),
            written: None,
        };
    }
    AskAnsweredWake {
        reason: ask_answered_note(meta),
        written: None,
    }
}

/// 깨움 보고처(`meta.wake.reportTo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeReportTo {
    pub channel_id: String,
    pub thread_root_id: String,
}

fn wake_meta(meta: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    meta?.get("wake")?.as_object()
}

/// 정본 `prompt.ts::wakeReportTo`.
pub fn wake_report_to(meta: Option<&Value>) -> Option<WakeReportTo> {
    let r = wake_meta(meta)?.get("reportTo")?.as_object()?;
    Some(WakeReportTo {
        channel_id: r.get("channelId")?.as_str()?.to_string(),
        thread_root_id: r.get("threadRootId")?.as_str()?.to_string(),
    })
}

/// 정본 `prompt.ts::wakeWatch` — `true` 만 참.
pub fn wake_watch(meta: Option<&Value>) -> bool {
    wake_meta(meta).and_then(|w| w.get("watch")) == Some(&Value::Bool(true))
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// 정본 `prompt.ts::wakeOrigin` — 감시일 때만, uuid 꼴 문자열만.
pub fn wake_origin(meta: Option<&Value>) -> Option<String> {
    if !wake_watch(meta) {
        return None;
    }
    let o = wake_meta(meta)?.get("origin")?.as_str()?;
    is_uuid(o).then(|| o.to_string())
}

/// 깨움 턴의 대상(정본 `MentionTarget['wake']`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeTarget {
    pub reason: String,
    pub report_to: Option<WakeReportTo>,
    /// 보고처가 있을 때만 — 예약한 때(대기 줄 seq).
    pub scheduled_seq: Option<i64>,
    /// 보고처가 있을 때만 — 예약을 건 턴(`meta.turnId`).
    pub scheduled_turn_id: Option<String>,
    pub watch: bool,
    pub origin: Option<String>,
}

/// 정본 `wakeTarget` — inbox 의 깨움 메시지 한 줄(`body`·`seq`·`meta`)에서.
pub fn wake_target(mention: &Value) -> WakeTarget {
    let meta = mention.get("meta").filter(|m| !m.is_null());
    let report_to = wake_report_to(meta);
    let has_report = report_to.is_some();
    WakeTarget {
        reason: mention
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        scheduled_seq: if has_report {
            mention.get("seq").and_then(Value::as_i64)
        } else {
            None
        },
        scheduled_turn_id: if has_report {
            meta.and_then(|m| m.get("turnId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        },
        report_to,
        watch: wake_watch(meta),
        origin: wake_origin(meta),
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(_) => true,
    }
}

/// 정본 `isPlainMention` — 한 턴으로 묶어도 되는 부름인가. 사람이 그냥 부른 글·답글뿐이다.
pub fn is_plain_mention(entry: &Value, mention: &Value) -> bool {
    let reason = entry
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(reason, "mention" | "thread_reply" | "dm") {
        return false;
    }
    if ["team", "delegation", "delegatedBy", "viaEdit", "startedIn"]
        .iter()
        .any(|k| truthy(entry.get(*k)))
    {
        return false;
    }
    // 정본 `entry.canceledWakes?.length` — 빈 배열은 거짓.
    if entry
        .get("canceledWakes")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
    {
        return false;
    }
    if mention.get("kind").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let Some(meta) = mention.get("meta").and_then(Value::as_object) else {
        return true;
    };
    let kind = meta.get("kind").and_then(Value::as_str);
    !(matches!(kind, Some("ask") | Some("wake"))
        || meta.contains_key("automation")
        || meta.contains_key("automationId")
        || meta.contains_key("planStart"))
}

#[cfg(test)]
#[path = "mention_scheduler_tests.rs"]
mod tests;

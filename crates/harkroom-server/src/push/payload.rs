//! 푸시 페이로드(S5.3 C5e-2) — TS `packages/server/src/services/push/payload.ts` 를 옮긴 순수 함수. 무엇이 Apple 을 지나 잠금 화면에
//! 뜨는지가 이 파일로 정해진다. TS 결과와 같은지는 `golden/push_payload.json`(TS `rustPushPayloadGolden.test.ts` 가 씀)으로 대조한다.
//!
//! - 미리보기가 꺼져 있으면 본문이나 그 일부를 **어디에도** 싣지 않는다(`hk` 도). 사유는 `loc-key` 로만.
//! - 켜져 있으면 그 시점 본문의 멘션을 이름으로 바꾼 뒤 120자(코드 포인트)로 자른다. 비밀 가림은 부르는 쪽이 먼저 거른다.
use crate::core::mention_parse::{JS_WS, render_mentions};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushReason {
    Mention,
    ThreadReply,
    Dm,
    Ask,
}

impl PushReason {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "mention" => Self::Mention,
            "thread_reply" => Self::ThreadReply,
            "dm" => Self::Dm,
            "ask" => Self::Ask,
            _ => return None,
        })
    }
    /// 기기 prefs 의 스위치 이름(TS `PREF_KEY`).
    pub fn pref_key(self) -> &'static str {
        match self {
            Self::Mention => "mention",
            Self::ThreadReply => "threadReply",
            Self::Dm => "dm",
            Self::Ask => "ask",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushKind {
    Ask,
    Fail,
    Gate,
    Done,
    AgentReply,
    Mention,
    ThreadReply,
    Dm,
}

impl PushKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Fail => "fail",
            Self::Gate => "gate",
            Self::Done => "done",
            Self::AgentReply => "agent_reply",
            Self::Mention => "mention",
            Self::ThreadReply => "thread_reply",
            Self::Dm => "dm",
        }
    }
    fn loc_key(self) -> &'static str {
        match self {
            Self::Mention => "PUSH_REASON_MENTION",
            Self::ThreadReply => "PUSH_REASON_THREAD_REPLY",
            Self::Dm => "PUSH_REASON_DM",
            Self::Ask => "PUSH_REASON_ASK",
            Self::Fail => "PUSH_REASON_FAIL",
            Self::Gate => "PUSH_REASON_GATE",
            Self::Done => "PUSH_REASON_DONE",
            Self::AgentReply => "PUSH_REASON_REPLIES",
        }
    }
    fn subtitle_key(self) -> Option<&'static str> {
        Some(match self {
            Self::Mention => "PUSH_SUB_MENTION",
            Self::ThreadReply => "PUSH_SUB_THREAD_REPLY",
            Self::Ask => "PUSH_SUB_ASK",
            Self::Fail => "PUSH_SUB_FAIL",
            Self::Gate => "PUSH_SUB_GATE",
            Self::Done => "PUSH_SUB_DONE",
            Self::AgentReply => "PUSH_SUB_REPLIES",
            Self::Dm => return None,
        })
    }
}

pub const PUSH_PREVIEW_MAX: usize = 120;
/// 같은 스레드의 에이전트 보통 답은 이 간격 안에 한 번만 울린다(ms).
pub const PUSH_REPLY_SOUND_WINDOW_MS: u64 = 10 * 60_000;
/// 결정·실패·관문이 집중 모드를 뚫는 간격(ms).
pub const PUSH_URGENT_WINDOW_MS: u64 = 60_000;

pub struct ClassifyInput<'a> {
    pub reason: PushReason,
    pub author_is_agent: bool,
    pub meta_kind: Option<&'a str>,
    pub failure_code: Option<&'a str>,
    pub mine_thread: bool,
}

/// TS `classifyPush`.
pub fn classify_push(i: &ClassifyInput<'_>) -> PushKind {
    if i.reason == PushReason::Ask || i.meta_kind == Some("ask") {
        return PushKind::Ask;
    }
    if i.meta_kind == Some("failure") {
        return if i.failure_code == Some("account_gate") {
            PushKind::Gate
        } else {
            PushKind::Fail
        };
    }
    if i.reason == PushReason::Dm {
        return PushKind::Dm;
    }
    if i.author_is_agent {
        if i.meta_kind == Some("report") {
            return PushKind::Done;
        }
        if i.mine_thread {
            return PushKind::AgentReply;
        }
    }
    if i.reason == PushReason::Mention {
        PushKind::Mention
    } else {
        PushKind::ThreadReply
    }
}

/// TS `isUrgentPush`.
pub fn is_urgent(k: PushKind) -> bool {
    matches!(k, PushKind::Ask | PushKind::Fail | PushKind::Gate)
}

/// TS `pushTitle`.
pub fn push_title(author_handle: Option<&str>, channel_name: Option<&str>) -> String {
    if let Some(c) = channel_name.filter(|c| !c.is_empty()) {
        return format!("#{c}");
    }
    match author_handle.filter(|h| !h.is_empty()) {
        Some(h) => format!("@{h}"),
        None => "Harkroom".to_string(),
    }
}

/// TS `pushThreadKey` — DM(채널 이름 없음)은 대화마다, 채널은 스레드마다.
pub fn push_thread_key<'a>(
    channel_id: &'a str,
    channel_name: Option<&str>,
    thread_root_id: Option<&'a str>,
    message_id: &'a str,
) -> &'a str {
    if channel_name.is_none() {
        return channel_id;
    }
    thread_root_id.unwrap_or(message_id)
}

/// TS `pushCollapseId`.
pub fn push_collapse_id(kind: PushKind, thread_key: &str, message_id: &str) -> String {
    match kind {
        PushKind::AgentReply | PushKind::Done => format!("reply:{thread_key}"),
        PushKind::Ask | PushKind::Fail | PushKind::Gate => {
            format!("{}:{message_id}", kind.as_str())
        }
        _ => message_id.to_string(),
    }
}

static WS_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{JS_WS}]+")).expect("ws regex"));
static WS_EDGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^[{JS_WS}]+|[{JS_WS}]+$")).expect("ws edge regex"));

/// TS `previewText` — 멘션을 이름으로, 공백 묶음을 한 칸으로, 앞뒤를 깎고 120 코드 포인트로 자른다.
pub fn preview_text(body: &str, id_to_handle: &HashMap<String, String>) -> String {
    let rendered = render_mentions(body, id_to_handle);
    let flat = WS_RUN.replace_all(&rendered, " ");
    let flat = WS_EDGE.replace_all(&flat, "").into_owned();
    let n = flat.chars().count();
    if n > PUSH_PREVIEW_MAX {
        let mut s: String = flat.chars().take(PUSH_PREVIEW_MAX - 1).collect();
        s.push('…');
        s
    } else {
        flat
    }
}

pub struct PayloadInput<'a> {
    pub kind: PushKind,
    pub account_id: &'a str,
    pub message_id: &'a str,
    pub channel_id: &'a str,
    pub thread_root_id: Option<&'a str>,
    pub author_handle: Option<&'a str>,
    /// 채널이면 이름, DM 이면 `None`.
    pub channel_name: Option<&'a str>,
    pub badge: Option<i64>,
    /// `None` 이면 미리보기를 싣지 않는다. 있으면 이미 가림을 거친 저장 본문.
    pub preview_body: Option<&'a str>,
    pub id_to_handle: &'a HashMap<String, String>,
    pub reply_count: i64,
    pub option_count: i64,
    pub sound: bool,
}

/// TS `buildPushPayload`.
pub fn build_push_payload(i: &PayloadInput<'_>) -> Value {
    let mut alert = Map::new();
    alert.insert(
        "title".into(),
        json!(push_title(i.author_handle, i.channel_name)),
    );
    if let Some(key) = i.kind.subtitle_key() {
        // TS `authorHandle ?? 'Harkroom'` — 빈 글자는 그대로 둔다(제목과 다르다).
        let who = i.author_handle.unwrap_or("Harkroom");
        let args = if i.kind == PushKind::AgentReply {
            json!([i.reply_count.max(1).to_string(), who])
        } else {
            json!([who])
        };
        alert.insert("subtitle-loc-key".into(), json!(key));
        alert.insert("subtitle-loc-args".into(), args);
    }
    let preview = i
        .preview_body
        .map(|b| preview_text(b, i.id_to_handle))
        .unwrap_or_default();
    if !preview.is_empty() {
        alert.insert("body".into(), json!(preview));
    } else if i.kind == PushKind::AgentReply {
        alert.insert("loc-key".into(), json!(i.kind.loc_key()));
        alert.insert("loc-args".into(), json!([i.reply_count.max(1).to_string()]));
    } else if i.kind == PushKind::Ask && i.option_count > 0 {
        alert.insert("loc-key".into(), json!("PUSH_REASON_ASK_OPTIONS"));
        alert.insert("loc-args".into(), json!([i.option_count.to_string()]));
    } else {
        alert.insert("loc-key".into(), json!(i.kind.loc_key()));
    }
    let level = match (is_urgent(i.kind), i.sound) {
        (true, true) => "time-sensitive",
        (true, false) => "active",
        (false, true) => "active",
        (false, false) => "passive",
    };
    let mut aps = Map::new();
    aps.insert("alert".into(), Value::Object(alert));
    if let Some(b) = i.badge {
        aps.insert("badge".into(), json!(b));
    }
    if i.sound {
        aps.insert("sound".into(), json!("default"));
    }
    aps.insert("interruption-level".into(), json!(level));
    aps.insert(
        "thread-id".into(),
        json!(push_thread_key(
            i.channel_id,
            i.channel_name,
            i.thread_root_id,
            i.message_id
        )),
    );
    json!({
        "aps": Value::Object(aps),
        "hk": {
            "v": 1,
            "accountId": i.account_id,
            "messageId": i.message_id,
            "channelId": i.channel_id,
            "threadRootId": i.thread_root_id,
        }
    })
}

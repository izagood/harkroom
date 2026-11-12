//! 턴이 끝난 뒤 「어디에 말했나」를 본다(정본 `mentionTurn.ts::reportPromiseCheck`·`offAnchorEvidence`, `prompt.ts::offAnchorPosts`·
//! `offAnchorNotice`·`reportMissedNotice`).
//!
//! - **보고처 약속**: 깨움 턴이 `turn.wake` 의 `reportTo` 로 약속한 스레드에 아무 말 없이 끝났으면 그 스레드에 실패 카드를 남긴다.
//!   진행 설명(progress)도 보고로 센다 — 기다리는 사람에게는 「봤다」는 신호다. 깨움 줄만 세지 않는다.
//! - **앵커 밖 발화**: 앵커에는 말이 없는데 같은 채널의 다른 스레드에 이 턴의 글이 있으면 그 링크 문장을 침묵 통지에 싣는다.
//!
//! 둘 다 관측이다 — 통지의 조건이 아니라 통지를 더 좋게 만드는 정황이라, 읽기 실패로 턴 결과를 바꾸지 않는다.
//! 서버 접근은 [`ReportIo`] 뒤에 있다(실구현은 MCP 클라이언트).
//!
//! 아직 아무 데서도 부르지 않는다 — 턴 흐름에 붙이는 것은 TurnAttempt 조각이다.

use serde_json::Value;

use crate::mcp::{FailOpts, HarkroomMcpClient};
use crate::mention_scheduler::WakeReportTo;
use crate::mention_turn_parts::wrote_by_turn;
use crate::prompt::{MESSAGE_KIND_WAKE, NON_UTTERANCE_KINDS};
use crate::rest::RunnerLink;
use crate::turn_posts::{TurnOwnership, owned_by_turn};

/// 정본 `MESSAGE_PERMALINK_PREFIX`.
pub const MESSAGE_PERMALINK_PREFIX: &str = "harkroom://message/";
/// 보고처 판정에서 한 번에 읽는 글 수(#1208 n4).
pub const REPORT_CHECK_PAGE: u32 = 200;
/// 보고처 판정의 쪽 수 상한. 200 × 10 = 턴 동안 2,000 글까지 본다.
pub const REPORT_CHECK_MAX_PAGES: usize = 10;
/// 앵커 밖 발화를 볼 때 채널에서 읽는 글 수 — 기본 30 은 바쁜 채널에서 내 발화를 창 밖으로 밀어낸다.
pub const OFF_ANCHOR_READ_LIMIT: u32 = 200;

fn seq(m: &Value) -> i64 {
    m.get("seq")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn str_of<'a>(m: &'a Value, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str)
}

/// 글이 속한 스레드 = `threadRootId ?? id`.
fn thread_of(m: &Value) -> Option<&str> {
    str_of(m, "threadRootId").or_else(|| str_of(m, "id"))
}

/// 정본 `offAnchorPosts` — 이 턴이 앵커 밖(같은 채널의 다른 스레드)에 쓴 발화.
///
/// 발화의 정의는 `count_own_posts_since` 와 같다(progress·wake 제외). 턴 id 가 이 턴과 같은 글만 잡는다(`TurnOwnership::Link`) —
/// 턴 id 가 없는 글·턴 id 없이 부른 경우는 하나도 잡지 않는다(단정하는 문구에 모르는 글을 싣지 않는다).
/// 앵커가 `None`(채널 최상위)이면 `threadRootId` 가 있는 글만 앵커 밖이다.
pub fn off_anchor_posts<'a>(
    messages: &'a [Value],
    me_id: &str,
    anchor: Option<&str>,
    since_seq: i64,
    turn_id: Option<&str>,
) -> Vec<&'a Value> {
    messages
        .iter()
        .filter(|m| {
            if str_of(m, "authorId") != Some(me_id)
                || seq(m) <= since_seq
                || str_of(m, "kind").is_some_and(|k| NON_UTTERANCE_KINDS.contains(&k))
            {
                return false;
            }
            if !owned_by_turn(m, turn_id, TurnOwnership::Link) {
                return false;
            }
            match anchor {
                None => m.get("threadRootId").is_some_and(|v| !v.is_null()),
                Some(a) => thread_of(m) != Some(a),
            }
        })
        .collect()
}

/// 잡힌 글들의 스레드 id(처음 나온 순서, 중복 없음).
fn stray_roots<'a>(posts: &[&'a Value]) -> Vec<&'a str> {
    let mut roots: Vec<&str> = Vec::new();
    for r in posts.iter().filter_map(|m| thread_of(m)) {
        if !roots.contains(&r) {
            roots.push(r);
        }
    }
    roots
}

/// 정본 `offAnchorNotice` — 침묵 통지에 실을 링크 한 줄. 잡힌 것이 없으면 `None`.
pub fn off_anchor_notice(posts: &[&Value]) -> Option<String> {
    if posts.is_empty() {
        return None;
    }
    let links: Vec<String> = stray_roots(posts)
        .into_iter()
        .map(|id| format!("{MESSAGE_PERMALINK_PREFIX}{id}"))
        .collect();
    Some(format!(
        "이 요청의 답은 다른 스레드에 올렸습니다: {}",
        links.join(" · ")
    ))
}

/// 정본 `reportMissedNotice` — 약속한 보고처에 말없이 끝난 깨움 턴의 경고. `reason` 이 `None` 이면 사유를 싣지 않는다
/// (앵커와 보고처의 채널이 다를 때 — 비공개 앵커의 사유가 공개 보고처로 옮겨 적히지 않게, #1208 security n2).
pub fn report_missed_notice(reason: Option<&str>, anchor: &str) -> String {
    let head = match reason {
        None => {
            "이 스레드에 보고하기로 한 예약이 깨어났지만 여기에 아무 말 없이 끝났다.".to_string()
        }
        Some(r) => format!(
            "이 스레드에 보고하기로 한 예약이 깨어났지만 여기에 아무 말 없이 끝났다 — 사유: {r}"
        ),
    };
    format!(
        "{head}\n그 턴은 {MESSAGE_PERMALINK_PREFIX}{anchor} 스레드에서 돌았다. 결과는 그쪽을 본다."
    )
}

/// 보고처·채널 읽기와 실패 카드. 실패는 사유 문자열로 돌려주고 던지지 않는다.
pub trait ReportIo {
    /// `message.read`(스레드) — `since` 뒤 가장 오래된 `limit` 개.
    fn read_thread(
        &mut self,
        channel_id: &str,
        thread_root_id: &str,
        since: i64,
        limit: u32,
    ) -> Result<Vec<Value>, String>;
    /// `message.read`(채널 전체, 스레드 답 포함).
    fn read_channel_since(
        &mut self,
        channel_id: &str,
        since: i64,
        limit: u32,
    ) -> Result<Vec<Value>, String>;
    /// `message.fail`.
    fn fail(
        &mut self,
        channel_id: &str,
        body: &str,
        thread_root_id: &str,
        opts: &FailOpts,
    ) -> Result<(), String>;
}

impl<L: RunnerLink> ReportIo for &HarkroomMcpClient<L> {
    fn read_thread(
        &mut self,
        channel_id: &str,
        thread_root_id: &str,
        since: i64,
        limit: u32,
    ) -> Result<Vec<Value>, String> {
        HarkroomMcpClient::read_thread(self, channel_id, Some(thread_root_id), Some(since), limit)
            .map_err(|e| e.message)
    }
    fn read_channel_since(
        &mut self,
        channel_id: &str,
        since: i64,
        limit: u32,
    ) -> Result<Vec<Value>, String> {
        HarkroomMcpClient::read_channel_since(self, channel_id, since, limit).map_err(|e| e.message)
    }
    fn fail(
        &mut self,
        channel_id: &str,
        body: &str,
        thread_root_id: &str,
        opts: &FailOpts,
    ) -> Result<(), String> {
        HarkroomMcpClient::fail(self, channel_id, body, Some(thread_root_id), opts)
            .map(|_| ())
            .map_err(|e| e.message)
    }
}

/// 보고처에서 찾은 결과(정본 `ownReportSince` 의 `{id} | 'too_busy' | null`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnReport {
    /// 기준선 뒤의 내 보고(그 글 id).
    Found(String),
    /// 쪽 수 상한까지 읽고도 끝에 닿지 못했다 — 판정을 접는다.
    TooBusy,
    /// 끝까지 읽었는데 없다.
    Missing,
}

/// 정본 `ownReportSince` — 보고처에서 기준선 뒤의 내 보고를 찾는다. **창을 넘겨 끝까지 읽는다**(#1208 security n4): 한 번 읽기는
/// `seq > since` 중 가장 오래된 limit 개라, 보고처가 바쁘면 내 보고가 창 밖으로 밀린다.
/// 깨움 줄과 예약을 건 턴(`scheduled_turn_id`)이 쓴 글은 보고로 치지 않는다.
pub fn own_report_since(
    io: &mut impl ReportIo,
    me_id: &str,
    report_to: &WakeReportTo,
    base_seq: i64,
    scheduled_turn_id: Option<&str>,
) -> Result<OwnReport, String> {
    let mut since = base_seq;
    for _ in 0..REPORT_CHECK_MAX_PAGES {
        let there = io.read_thread(
            &report_to.channel_id,
            &report_to.thread_root_id,
            since,
            REPORT_CHECK_PAGE,
        )?;
        let found = there.iter().find(|m| {
            str_of(m, "authorId") == Some(me_id)
                && seq(m) > base_seq
                && str_of(m, "kind") != Some(MESSAGE_KIND_WAKE)
                && !wrote_by_turn(m, scheduled_turn_id)
        });
        if let Some(m) = found {
            return Ok(OwnReport::Found(
                str_of(m, "id").unwrap_or_default().to_string(),
            ));
        }
        let last = there.iter().map(seq).fold(since, i64::max);
        if there.is_empty() || last <= since {
            return Ok(OwnReport::Missing);
        }
        since = last;
    }
    Ok(OwnReport::TooBusy)
}

/// 보고처 약속 확인의 입력.
pub struct ReportPromise<'a> {
    pub me_id: &'a str,
    pub report_to: &'a WakeReportTo,
    /// 예약 시점의 보고처 seq 기준선.
    pub base_seq: i64,
    /// 예약을 건 턴의 id — 그 턴이 쓴 글은 이번 보고가 아니다.
    pub scheduled_turn_id: Option<&'a str>,
    /// 예약 사유.
    pub reason: &'a str,
    /// 이 턴의 앵커(깨움 턴이 돈 스레드).
    pub anchor: &'a str,
    pub anchor_channel_id: &'a str,
}

/// 정본 `reportPromiseCheck` — 보고처에 말이 없으면 거기에 실패 카드를 남긴다. 다 못 읽었으면(`TooBusy`) 경고하지 않는다
/// (근거 없이 경고하지 않는다). 돌려주는 값은 판정 결과다 — 읽기·발화 실패는 `Err` 로 돌려준다(호출자가 로그만 남긴다).
pub fn report_promise_check(
    io: &mut impl ReportIo,
    p: &ReportPromise<'_>,
) -> Result<OwnReport, String> {
    let found = own_report_since(io, p.me_id, p.report_to, p.base_seq, p.scheduled_turn_id)?;
    match &found {
        OwnReport::Found(_) => return Ok(found),
        OwnReport::TooBusy => {
            eprintln!(
                "[mentionTurn] 보고처 {} 가 너무 바빠 보고 여부를 다 못 읽었다 — 경고하지 않는다",
                p.report_to.thread_root_id
            );
            return Ok(found);
        }
        OwnReport::Missing => {}
    }
    eprintln!(
        "[mentionTurn] 깨움 턴이 보고처 {} 에 말하지 않고 끝났다 — 거기에 경고를 남긴다",
        p.report_to.thread_root_id
    );
    let same_channel = p.report_to.channel_id == p.anchor_channel_id;
    let notice = report_missed_notice(same_channel.then_some(p.reason), p.anchor);
    io.fail(
        &p.report_to.channel_id,
        &notice,
        &p.report_to.thread_root_id,
        &FailOpts {
            retryable: false,
            what: Some("약속한 스레드에 보고하지 않고 깨움 턴이 끝났다".to_string()),
            ..FailOpts::default()
        },
    )?;
    Ok(found)
}

/// 정본 `offAnchorEvidence` — 앵커 밖 발화가 있으면 침묵 통지에 실을 링크 문장. **던지지 않는다** — 읽기 실패는 로그만 남기고 `None`.
pub fn off_anchor_evidence(
    io: &mut impl ReportIo,
    key: &str,
    me_id: &str,
    channel_id: &str,
    anchor: Option<&str>,
    turn_start_seq: i64,
    turn_id: &str,
) -> Option<String> {
    let channel_wide =
        match io.read_channel_since(channel_id, turn_start_seq, OFF_ANCHOR_READ_LIMIT) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[mentionTurn] {key}: 앵커 밖 발화 관측 실패(통지는 그대로 나간다) — {e}"
                );
                return None;
            }
        };
    let strays = off_anchor_posts(&channel_wide, me_id, anchor, turn_start_seq, Some(turn_id));
    if strays.is_empty() {
        return None;
    }
    eprintln!(
        "[mentionTurn] {key}: 앵커에는 발화가 없는데 같은 채널의 다른 스레드에 내 발화가 {}건 있다 — \
         이 턴이 남의 앵커의 요청을 대신했을 수 있다(2026-09-08 사고와 같은 모양). 대상 스레드: {}",
        strays.len(),
        stray_roots(&strays).join(", ")
    );
    off_anchor_notice(&strays)
}

#[cfg(test)]
#[path = "turn_report_tests.rs"]
mod tests;

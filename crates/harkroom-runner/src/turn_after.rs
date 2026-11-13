//! 성공한 턴 뒤의 「관측·통보」 실행(정본 `mentionTurn.ts` 정상 종료 갈래의 `try { … }` 블록) — [`after_turn_plan`] 이 고른
//! [`AfterTurnPlan`] 을 실제 글·반응·progress·실패 줄로 옮긴다.
//!
//! 싣는 말은 모두 기존 문구 함수를 거친다(`background_cut_notice`·`silent_turn_notice`·`silent_wake_notice`·
//! `watch_missed_notice`·고정 문장) — 에이전트·하네스가 쓴 말은 그 함수들이 `quoted_line`·`one_line` 으로 가린다.
//! 여기서 새로 만드는 문구는 없다. 본문은 서버 상한([`BODY_LIMIT`], UTF-16 단위)으로 자른다(정본 `.slice(0, BODY_LIMIT)`).
//!
//! 정본처럼 **best-effort** 다: 첫 오류에서 멈추고 `Err` 를 돌려주면 호출자가 로그만 남긴다(세션 상태는 이미 저장됐다).
//! 하네스 끝말·앵커 밖 정황 같은 비싼 읽기는 그 갈래에 들어설 때만 [`AfterIo`] 에 묻는다.
//!
//! 아직 아무 데서도 부르지 않는다 — 턴 흐름에 붙이는 것은 TurnAttempt 조각이다.

use crate::mcp::FailOpts;
use crate::prompt_system::BODY_LIMIT;
use crate::silent_notice::{
    SILENT_ACK_EMOJI, SilentTurnInput, SilentTurnNotice, background_cut_notice, silent_turn_notice,
    silent_wake_notice,
};
use crate::turn_notice::{NudgeCaller, quoted_line};
use crate::turn_success::{
    AfterTurnPlan, DELEGATION_REPORT_MISSED_NOTICE, SilentPath, watch_missed_notice,
};

/// 침묵 통지에 실을 끝말 묶음(정본 `recordSaid`·`harnessSaid`·`end.screenSaid` 고르기의 결과).
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SilentSaid {
    /// 통지에 인용할 마지막 말(`recordSaid ?? harnessSaid ?? screenSaid`).
    pub last_said: Option<String>,
    /// 기록이 말해 주지 않을 때의 화면 답(`recordSaid === null ? screenSaid : null`).
    pub screen_answer: Option<String>,
    /// API 키 연결 하네스의 기록 끝말(`harnessSaid`).
    pub record_answer: Option<String>,
    /// 화면으로 끝을 알았다(`recordSaid === null && end.screenEnded`).
    pub screen_ended: bool,
}

/// 이 턴의 고정 사실. 비밀을 담으므로 `Debug` 를 달지 않는다.
pub struct AfterFacts<'a> {
    pub key: &'a str,
    pub channel_id: &'a str,
    /// 앵커(답을 남길 스레드). 채널 최상위면 `None`.
    pub anchor: Option<&'a str>,
    /// 이 턴을 부른 멘션(대기 줄) id — ✅ 와 실패 줄의 `mention_id`.
    pub mention_id: &'a str,
    pub caller: NudgeCaller,
    /// 대리 글 머리 — API 키 연결 턴에서만 부른 글 작성자 멘션(`@handle\n\n`), 아니면 빈 문자열.
    pub proxy_head: &'a str,
    /// 기록 대리 게시(API 키 연결 턴).
    pub record_proxy: bool,
    /// 예약 사유(감시 끊김 줄에 가려 싣는다).
    pub wake_reason: &'a str,
    /// 하위 에이전트를 기다린 시간(정본 `backgroundWaitMs ?? turnTimeoutMs`).
    pub background_wait_ms: u64,
    pub pat: &'a str,
    pub secrets: &'a [String],
}

/// 서버 쓰기와 지연 읽기. 쓰기 실패는 사유 문자열로 돌려준다.
pub trait AfterIo {
    /// 하네스 기록의 마지막 말(정본 `readLastSaid … .catch(() => null)`) — 실패는 `None`.
    fn last_said(&mut self) -> Option<String>;
    /// 침묵 통지용 끝말 묶음(재촉 여부·기록·화면을 가른 결과).
    fn silent_said(&mut self) -> SilentSaid;
    /// 앵커 밖 발화 정황(`off_anchor_evidence`) — 던지지 않는다.
    fn off_anchor(&mut self) -> Option<String>;
    /// 보고처 약속 확인(`report_promise_check`).
    fn report_promise(&mut self) -> Result<(), String>;
    fn post(&mut self, channel_id: &str, body: &str, anchor: Option<&str>) -> Result<(), String>;
    fn progress(
        &mut self,
        channel_id: &str,
        body: &str,
        anchor: Option<&str>,
    ) -> Result<(), String>;
    fn react(&mut self, channel_id: &str, message_id: &str, emoji: &str) -> Result<(), String>;
    fn fail(
        &mut self,
        channel_id: &str,
        body: &str,
        anchor: Option<&str>,
        opts: &FailOpts,
    ) -> Result<(), String>;
    fn log(&mut self, line: &str);
}

/// 정본 `.slice(0, BODY_LIMIT)` — UTF-16 단위로 자르되 서로게이트 쌍을 가르지 않는다.
pub fn clip_body(body: &str) -> &str {
    let mut units = 0usize;
    for (i, c) in body.char_indices() {
        units += c.len_utf16();
        if units > BODY_LIMIT {
            return &body[..i];
        }
    }
    body
}

fn said_tail(said: &str) -> String {
    if said.is_empty() {
        String::new()
    } else {
        format!(" (마지막 말: {said})")
    }
}

/// 정본 정상 종료 갈래의 관측·통보. 첫 오류에서 멈춘다.
pub fn apply_after_turn(
    plan: &AfterTurnPlan,
    f: &AfterFacts<'_>,
    io: &mut impl AfterIo,
) -> Result<(), String> {
    if plan.post_count > 1 {
        io.log(&format!(
            "[mentionTurn] {}: 결과 발화가 {}건이다 — 한 턴에 한 번만 발화해야 한다",
            f.key, plan.post_count
        ));
    }
    match plan.silent {
        SilentPath::BackgroundCut { count } => {
            let said = io.last_said();
            let body = background_cut_notice(
                count,
                f.background_wait_ms,
                said.as_deref(),
                f.pat,
                f.secrets,
            );
            io.post(f.channel_id, clip_body(&body), f.anchor)?;
        }
        SilentPath::SilentTurn => silent_turn(f, io)?,
        SilentPath::WakeAck => {
            let said = io.last_said();
            let line = quoted_line(said.as_deref(), f.pat, f.secrets);
            io.log(&format!(
                "[mentionTurn] {}: 다시 예약하고 글 없이 끝났다 — ✅ 만 단다{}",
                f.key,
                said_tail(&line)
            ));
            io.react(f.channel_id, f.mention_id, SILENT_ACK_EMOJI)?;
        }
        SilentPath::WakeProgress => {
            let said = io.last_said();
            let body = silent_wake_notice(said.as_deref(), f.pat, f.secrets);
            io.progress(f.channel_id, clip_body(&body), f.anchor)?;
        }
        SilentPath::Nothing => {}
    }
    if plan.check_report_promise {
        io.report_promise()?;
    }
    if plan.watch_missed {
        io.log(&format!(
            "[mentionTurn] {}: 감시 예약으로 깨어난 턴이 다음 예약도 끝 보고도 없이 끝났다 — 실패 줄을 남긴다",
            f.key
        ));
        let body = watch_missed_notice(f.wake_reason, f.pat, f.secrets);
        io.fail(
            f.channel_id,
            clip_body(&body),
            f.anchor,
            &FailOpts {
                retryable: false,
                what: Some("감시 예약으로 깨어난 턴이 다음 예약 없이 끝났다".to_string()),
                ..FailOpts::default()
            },
        )?;
    }
    if plan.delegation_report_missed {
        io.log(&format!(
            "[mentionTurn] {}: 넘겨받은 일을 끝 보고 없이 끝냈다 — 실패 줄을 남긴다",
            f.key
        ));
        io.fail(
            f.channel_id,
            DELEGATION_REPORT_MISSED_NOTICE,
            f.anchor,
            &FailOpts {
                retryable: true,
                mention_id: Some(f.mention_id.to_string()),
                ..FailOpts::default()
            },
        )?;
    }
    Ok(())
}

fn silent_turn(f: &AfterFacts<'_>, io: &mut impl AfterIo) -> Result<(), String> {
    let said = io.silent_said();
    let off = io.off_anchor();
    let notice = silent_turn_notice(&SilentTurnInput {
        caller: f.caller,
        last_said: said.last_said.as_deref(),
        off_anchor: off.as_deref(),
        pat: f.pat,
        secrets: f.secrets,
        screen_answer: said.screen_answer.as_deref(),
        proxy_head: f.proxy_head,
        record_answer: said.record_answer.as_deref(),
        screen_ended: said.screen_ended,
        record_proxy: f.record_proxy,
    });
    match notice {
        SilentTurnNotice::React { emoji } => {
            let line = quoted_line(said.last_said.as_deref(), f.pat, f.secrets);
            io.log(&format!(
                "[mentionTurn] {}: 덧붙일 말 없이 끝났다 — ✅ 만 단다{}",
                f.key,
                said_tail(&line)
            ));
            io.react(f.channel_id, f.mention_id, emoji)
        }
        SilentTurnNotice::Fail { body } => io.fail(
            f.channel_id,
            clip_body(&body),
            f.anchor,
            &FailOpts {
                retryable: true,
                mention_id: Some(f.mention_id.to_string()),
                ..FailOpts::default()
            },
        ),
        SilentTurnNotice::Post { body, .. } => io.post(f.channel_id, clip_body(&body), f.anchor),
    }
}

/// [`AfterIo`] 실구현 — **나르기만** 한다. 본문은 [`apply_after_turn`] 이 기존 문구 함수로 이미 만들었고, 여기서는
/// 그 글을 MCP 로 보낼 뿐 새 문구를 만들거나 고치지 않는다. 지연 읽기(끝말·정황·보고처 확인)는 턴 연결이 닫개로 준다.
pub struct McpAfterIo<'a, L: crate::rest::RunnerLink> {
    pub client: &'a crate::mcp::HarkroomMcpClient<L>,
    pub last_said: Box<dyn FnMut() -> Option<String> + 'a>,
    pub silent_said: Box<dyn FnMut() -> SilentSaid + 'a>,
    pub off_anchor: Box<dyn FnMut() -> Option<String> + 'a>,
    pub report_promise: Box<dyn FnMut() -> Result<(), String> + 'a>,
}

impl<L: crate::rest::RunnerLink> AfterIo for McpAfterIo<'_, L> {
    fn last_said(&mut self) -> Option<String> {
        (self.last_said)()
    }
    fn silent_said(&mut self) -> SilentSaid {
        (self.silent_said)()
    }
    fn off_anchor(&mut self) -> Option<String> {
        (self.off_anchor)()
    }
    fn report_promise(&mut self) -> Result<(), String> {
        (self.report_promise)()
    }
    fn post(&mut self, channel_id: &str, body: &str, anchor: Option<&str>) -> Result<(), String> {
        self.client
            .post(channel_id, body, anchor)
            .map(|_| ())
            .map_err(|e| e.message)
    }
    fn progress(
        &mut self,
        channel_id: &str,
        body: &str,
        anchor: Option<&str>,
    ) -> Result<(), String> {
        self.client
            .progress(channel_id, body, anchor)
            .map(|_| ())
            .map_err(|e| e.message)
    }
    fn react(&mut self, channel_id: &str, message_id: &str, emoji: &str) -> Result<(), String> {
        self.client
            .add_reaction(channel_id, message_id, emoji)
            .map_err(|e| e.message)
    }
    fn fail(
        &mut self,
        channel_id: &str,
        body: &str,
        anchor: Option<&str>,
        opts: &FailOpts,
    ) -> Result<(), String> {
        self.client
            .fail(channel_id, body, anchor, opts)
            .map(|_| ())
            .map_err(|e| e.message)
    }
    fn log(&mut self, line: &str) {
        eprintln!("{line}");
    }
}

#[cfg(test)]
#[path = "turn_after_io_tests.rs"]
mod io_tests;

#[cfg(test)]
#[path = "turn_after_tests.rs"]
mod tests;

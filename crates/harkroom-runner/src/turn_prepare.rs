//! `AttemptParts::prepare` 의 몸통 — 정본 `runMentionTurn` 의 준비 구간(기록 고르기 → 세션 → 스레드 두 페이지 →
//! 부른 글 채우기 → 턴 프롬프트). 판정 조각은 `turn_prep`·`prompt_turn` 이고, 여기는 그 차례와 서버 읽기만 잇는다.
//!
//! 지키는 것:
//! - **다른 채널·스레드 글을 섞지 않는다** — 서버가 돌려준 두 페이지에서 이 턴의 채널·스레드 글만 남긴 뒤 합친다.
//! - 서버에서 읽은 글(스레드 글·깨움·위임·팀 등)은 **턴 프롬프트의 데이터 칸**(`TurnPromptInput`)으로만 간다 — 지시문
//!   (시스템 프롬프트) 쪽으로 가는 길이 이 함수에 없다.
//! - 계정 폴더(`config_dir`)는 이 함수에 들어오지 않는다(계정 축은 이름·풀만) — 프롬프트에 실릴 길이 없다.

use std::collections::HashMap;

use serde_json::Value;

use crate::adapter::AgentHarness;
use crate::mention_target::MentionTarget;
use crate::prompt_turn::{TurnClock, TurnPrompt, TurnPromptInput, TurnWake, build_turn_prompt};
use crate::session_store::SessionRecord;
use crate::turn_prep::{
    AccountAxis, FedRows, RecordChoice, TurnSession, choose_turn_session, fill_asked_rows,
    fresh_record, merge_thread_pages, reconcile_record,
};

/// 준비가 서버에서 읽는 것.
pub trait PrepareIo {
    /// 커서 뒤 가장 옛 페이지와 최신 페이지(정본 `readThread` 두 번).
    fn thread_pages(
        &mut self,
        channel_id: &str,
        thread_root_id: &str,
        since: u64,
    ) -> Result<(Vec<Value>, Vec<Value>), String>;
}

/// 준비의 이 턴 재료.
pub struct PrepareInput<'a> {
    pub target: &'a MentionTarget,
    pub harness: AgentHarness,
    /// 계정 축 — 이름·풀만(폴더는 받지 않는다).
    pub axis: AccountAxis<'a>,
    /// 이 스레드의 저장된 기록.
    pub record: Option<SessionRecord>,
    /// 기록이 없을 때 쓸 작업 폴더.
    pub new_workspace_dir: &'a str,
    pub me_id: &'a str,
    pub handles: &'a HashMap<String, String>,
    pub now: Option<TurnClock>,
    /// 깨움 턴의 사유 등(정본 `opts.wake`) — 서버가 준 데이터.
    pub wake: Option<TurnWake>,
}

/// 준비 결과.
pub struct Prepared {
    pub session: TurnSession,
    pub fed: FedRows,
    pub gap_after_seq: Option<u64>,
    pub prompt: TurnPrompt,
}

/// 준비 실패 — 종류만(서버 오류 원문은 로컬 로그로만).
#[derive(Debug, PartialEq, Eq)]
pub enum PrepareError {
    ThreadUnreadable,
}

fn in_thread(m: &Value, channel_id: &str, root: &str) -> bool {
    let s = |k: &str| m.get(k).and_then(Value::as_str);
    s("channelId") == Some(channel_id)
        && (s("threadRootId") == Some(root)
            || (s("threadRootId").is_none() && s("id") == Some(root)))
}

/// 정본 준비 구간.
pub fn prepare_turn(
    io: &mut impl PrepareIo,
    i: PrepareInput<'_>,
    new_id: &mut dyn FnMut() -> String,
) -> Result<Prepared, PrepareError> {
    let t = i.target;
    let rec = match reconcile_record(i.record, i.harness, i.axis, new_id) {
        RecordChoice::Use(r) => r,
        RecordChoice::NeedWorkspace => {
            fresh_record(i.new_workspace_dir.to_string(), i.harness, i.axis, new_id)
        }
    };
    let session = choose_turn_session(rec, t.scheduled_wake(), new_id);
    let cursor = session.rec.last_fed_seq;
    let (oldest, latest) = io
        .thread_pages(&t.channel_id, &t.thread_root_id, cursor)
        .map_err(|e| {
            eprintln!("[mentionTurn] 스레드 읽기 실패 — {e}");
            PrepareError::ThreadUnreadable
        })?;
    let keep = |v: Vec<Value>| -> Vec<Value> {
        v.into_iter()
            .filter(|m| in_thread(m, &t.channel_id, &t.thread_root_id))
            .collect()
    };
    let (merged, gap_after_seq) = merge_thread_pages(&keep(oldest), &keep(latest), cursor);
    let inbox_mention = t.wake.is_none().then_some(&t.mention_row);
    let fed = fill_asked_rows(merged, inbox_mention, &t.bundled_rows, cursor);
    let prompt = build_turn_prompt(&TurnPromptInput {
        messages: &fed.thread,
        last_fed_seq: i64::try_from(cursor).unwrap_or(i64::MAX),
        me_id: i.me_id,
        handles: i.handles,
        channel_id: &t.channel_id,
        thread_root_id: Some(&t.thread_root_id),
        now: i.now,
        wake: i.wake,
        watch_origin: None,
        canceled_wakes: (!t.canceled_wakes.is_empty()).then_some(&t.canceled_wakes[..]),
        started_in: t.started_in.as_ref(),
        team: t.team.as_ref(),
        delegation: t.delegation.as_ref(),
        delegation_followup: t.delegation_followup.as_ref(),
        delegation_update: t.delegation_update.as_ref(),
        delegations: (!t.delegations.is_empty()).then_some(&t.delegations[..]),
        delegated_by: t.delegated_by.as_ref(),
        edited_mention: t.edited_mention.as_ref(),
        fresh_wake: session.fresh_wake,
        unseen_own_after_seq: session
            .rec
            .unseen_own_after_seq
            .and_then(|v| i64::try_from(v).ok()),
        bundled_ids: (!fed.bundled_ids.is_empty()).then_some(&fed.bundled_ids[..]),
        mention_id: Some(&t.mention_id),
        gap_after_seq: gap_after_seq.and_then(|v| i64::try_from(v).ok()),
        after_cancel_by: session.rec.canceled_by.as_deref(),
    });
    Ok(Prepared {
        session,
        fed,
        gap_after_seq,
        prompt,
    })
}

#[cfg(test)]
#[path = "turn_prepare_tests.rs"]
mod tests;

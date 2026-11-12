//! 멘션 턴 준비(`mentionTurn.ts::runMentionTurn` 1091~1330 의 판정 절반, B4-2d).
//!
//! 세션 기록 고르기(하네스·계정·풀이 바뀌면 대화만 버림), 스레드 두 페이지 합치기, 부른 글·묶인 글 채우기,
//! 이어받기·깨움 새 세션 판정, 이 턴 뒤 기록 저장 꼴. 서버 읽기·프롬프트 조립·하네스 실행은 부르는 쪽(턴 루프 조각) 몫이다.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::adapter::{AgentHarness, has_account_pool};
use crate::session_store::SessionRecord;

/// 이 턴의 계정 축(배정기가 고른 claude 계정과 그 풀).
#[derive(Clone, Copy, Debug, Default)]
pub struct AccountAxis<'a> {
    pub account: Option<&'a str>,
    pub pool: Option<&'a str>,
}

/// [`reconcile_record`] 의 결과.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordChoice {
    /// 이 기록으로 턴을 돈다(옛 기록 그대로·풀만 채움·대화만 버리고 작업 폴더 재사용).
    Use(SessionRecord),
    /// 기록이 없다 — 작업 폴더를 정한 뒤 [`fresh_record`] 로 만든다.
    NeedWorkspace,
}

fn preassigns(harness: AgentHarness) -> bool {
    crate::turn_preset::preassigns_session_id(harness).unwrap_or(false)
}

fn pooled(harness: AgentHarness) -> bool {
    has_account_pool(harness).unwrap_or(false)
}

/// 새 기록. claude 처럼 id 를 미리 정하는 하네스면 `new_id()` 로 받는다.
pub fn fresh_record(
    workspace_dir: String,
    harness: AgentHarness,
    axis: AccountAxis<'_>,
    new_id: &mut dyn FnMut() -> String,
) -> SessionRecord {
    SessionRecord {
        workspace_dir,
        session_id: preassigns(harness).then(&mut *new_id),
        harness,
        last_fed_seq: 0,
        turns_run: 0,
        claude_account: axis.account.map(str::to_string),
        claude_pool: Some(axis.pool.map(str::to_string)),
        unseen_own_after_seq: None,
        canceled_by: None,
    }
}

/// 정본의 기록 고르기. **계정 축은 계정 풀이 있는 하네스에만 뜻이 있다** — opencode 처럼 풀이 없는
/// 하네스에서 계정이 바뀌었다고 세션을 버리면 두 번째 턴이 맥락을 잃는다(2026-09-25 실측).
/// 풀은 그 칸을 적은 레코드만 잰다(옛 레코드를 재면 업데이트 순간 모든 스레드가 세션을 잃는다).
pub fn reconcile_record(
    rec: Option<SessionRecord>,
    harness: AgentHarness,
    axis: AccountAxis<'_>,
    new_id: &mut dyn FnMut() -> String,
) -> RecordChoice {
    let Some(mut rec) = rec else {
        return RecordChoice::NeedWorkspace;
    };
    let pool_axis = pooled(harness);
    let account_changed = pool_axis
        && (rec.claude_account.as_deref() != axis.account
            || rec
                .claude_pool
                .as_ref()
                .is_some_and(|p| p.as_deref() != axis.pool));
    if rec.harness != harness || account_changed {
        // 대화 기억(세션 id·커서)만 버리고 작업 폴더는 재사용한다 — 산출물은 하네스와 무관하다.
        return RecordChoice::Use(fresh_record(rec.workspace_dir, harness, axis, new_id));
    }
    // 풀을 적기 전의 옛 레코드는 이 턴의 풀로 채운다(security n2) — 이어 가는 세션은 이 풀의 디렉터리에 있다.
    if rec.claude_pool.is_none() && pool_axis {
        rec.claude_pool = Some(axis.pool.map(str::to_string));
    }
    RecordChoice::Use(rec)
}

fn seq_of(m: &Value) -> u64 {
    m.get("seq").and_then(Value::as_u64).unwrap_or(0)
}

fn id_of(m: &Value) -> &str {
    m.get("id").and_then(Value::as_str).unwrap_or_default()
}

/// 정본 `mergeThreadPages`. 커서 뒤 가장 옛 페이지와 최신 페이지를 id 로 합쳐 seq 순으로 둔다.
/// 둘이 맞닿지 않으면(옛 페이지 끝 < 최신 페이지 처음) 틈의 시작을 `gap_after_seq` 로 돌려준다.
pub fn merge_thread_pages(
    oldest: &[Value],
    latest: &[Value],
    cursor: u64,
) -> (Vec<Value>, Option<u64>) {
    // 같은 id 는 뒤(최신 페이지)의 값이 이긴다 — 정본 `Map.set` 과 같고, 처음 나온 자리는 지킨다.
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for m in oldest.iter().chain(latest) {
        let id = id_of(m).to_string();
        if by_id.insert(id.clone(), m.clone()).is_none() {
            order.push(id);
        }
    }
    let mut messages: Vec<Value> = order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect();
    messages.sort_by_key(seq_of);
    let old_ids: HashSet<&str> = oldest.iter().map(id_of).collect();
    let old_max = oldest.iter().map(seq_of).filter(|&s| s > cursor).max();
    let late_min = latest
        .iter()
        .filter(|m| seq_of(m) > cursor && !old_ids.contains(id_of(m)))
        .map(seq_of)
        .min();
    match (old_max, late_min) {
        (Some(o), Some(l)) if l > o => (messages, Some(o)),
        _ => (messages, None),
    }
}

/// 부른 글·묶인 글 채우기의 결과.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FedRows {
    /// 두 페이지 밖의 부른 글·묶인 글까지 채운 스레드(seq 순).
    pub thread: Vec<Value>,
    /// 이 턴이 처리하는 묶인 글 id(오래된 순). 👀 신호와 프롬프트의 `bundledIds`.
    pub bundled_ids: Vec<String>,
    /// 측정 B1: 처리하는 글 중 가장 옛 글의 `createdAt`.
    pub oldest_asked_at: Option<String>,
    /// 측정 B1: 처리하는 글을 앞 턴이 이미 다 봤나(빈 턴 후보).
    pub asked_already_seen: bool,
}

/// 정본의 부른 글 채우기. 깨움·위임 결말은 부른 글이 할 일이 아니라서 채우지 않는다(`inbox_mention = None`).
pub fn fill_asked_rows(
    mut thread: Vec<Value>,
    inbox_mention: Option<&Value>,
    bundled_rows: &[Value],
    fed_before: u64,
) -> FedRows {
    let Some(mention) = inbox_mention else {
        return FedRows {
            thread,
            ..FedRows::default()
        };
    };
    let mut added = false;
    if !thread.iter().any(|m| id_of(m) == id_of(mention)) {
        thread.push(mention.clone());
        added = true;
    }
    for row in bundled_rows {
        if !thread.iter().any(|m| id_of(m) == id_of(row)) {
            thread.push(row.clone());
            added = true;
        }
    }
    if added {
        thread.sort_by_key(seq_of);
    }
    let handled: Vec<&Value> = bundled_rows
        .iter()
        .chain(std::iter::once(mention))
        .collect();
    FedRows {
        thread,
        bundled_ids: bundled_rows.iter().map(|r| id_of(r).to_string()).collect(),
        oldest_asked_at: handled[0]
            .get("createdAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        asked_already_seen: fed_before > 0 && handled.iter().all(|r| seq_of(r) <= fed_before),
    }
}

/// 이어받기 판정. `turns_run == 0` 이거나 세션 id 가 없으면(codex 발견 실패) 새로 시작한다 —
/// id 없이 resume 으로 조립하면 그 스레드가 재시도 한도까지 영원히 실패한다.
pub fn resumable(rec: &SessionRecord) -> bool {
    !(rec.turns_run == 0 || rec.session_id.is_none())
}

/// 이 턴의 세션 고르기 결과.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnSession {
    /// 이 턴이 쓰는 기록(깨움 새 세션이면 새 id·`turns_run` 0).
    pub rec: SessionRecord,
    /// 스레드에 남아 있던 기록 — 깨움 새 세션이면 저장할 때 이것을 지킨다.
    pub stored: SessionRecord,
    pub fresh_wake: bool,
    pub is_first_turn: bool,
}

/// 정본의 `freshWake`: 예약으로 깨어난 턴은 큰 세션을 이어받지 않고 버리는 작은 세션으로 돈다
/// (깨움 턴이 비용의 ~38% 였다). 이어받을 세션이 없으면 평소 경로다.
pub fn choose_turn_session(
    rec: SessionRecord,
    scheduled_wake: bool,
    new_id: &mut dyn FnMut() -> String,
) -> TurnSession {
    let can_resume = resumable(&rec);
    let fresh_wake = scheduled_wake && can_resume;
    let stored = rec.clone();
    let rec = if fresh_wake {
        SessionRecord {
            session_id: preassigns(rec.harness).then(&mut *new_id),
            turns_run: 0,
            ..rec
        }
    } else {
        rec
    };
    TurnSession {
        rec,
        stored,
        fresh_wake,
        is_first_turn: !can_resume || fresh_wake,
    }
}

/// 정본 `persist` 의 저장 꼴. 깨움 세션이면 옛 기록을 지키고 경계(`unseen_own_after_seq`)만 적는다 —
/// 커서도 전진시키지 않는다. 평범한 턴은 커서가 전진했으면 경계·중단 표식을 지운다(이미 보여 줬다).
pub fn record_to_persist(
    session: &TurnSession,
    next: SessionRecord,
    advanced: bool,
    baseline: u64,
    canceled_by: Option<&str>,
) -> SessionRecord {
    if session.fresh_wake {
        let stored = &session.stored;
        let unseen = stored
            .unseen_own_after_seq
            .unwrap_or(baseline)
            .min(baseline);
        return SessionRecord {
            unseen_own_after_seq: Some(unseen),
            canceled_by: canceled_by
                .map(str::to_string)
                .or(stored.canceled_by.clone()),
            ..stored.clone()
        };
    }
    let mut out = next;
    if advanced {
        out.unseen_own_after_seq = None;
    }
    if let Some(c) = canceled_by {
        out.canceled_by = Some(c.to_string());
    } else if advanced {
        out.canceled_by = None;
    }
    out
}

/// 발화 판정의 기준선 — 합친 스레드의 진짜 끝(옛 페이지 끝을 쓰면 이 턴의 답을 못 본다).
pub fn turn_start_seq(thread: &[Value]) -> u64 {
    thread.iter().map(seq_of).max().unwrap_or(0)
}

#[cfg(test)]
#[path = "turn_prep_tests.rs"]
mod tests;

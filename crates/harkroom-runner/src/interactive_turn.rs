//! 새 터미널 턴(정본 `interactiveTurn.ts` `spawn`, 분기 ③)의 장부 절반 — B-2c 1부.
//!
//! PTY·명령 조립과 떨어진, 조종 장부([`SharedControl`])에 닿는 판정만 여기 둔다. 띄우는 쪽은 이것만 부른다:
//!
//! - [`claim`]: 등록 직전 재검사와 등록을 **한 잠금 안에서** 한다. 정본은 「이 아래 register 까지 await 이 없어야
//!   한다」로 지키던 것을 Rust 는 잠금 하나로 지킨다 — 재검사와 등록 사이에 멘션 예약이 끼면 같은 스레드에 PTY 가
//!   둘 뜬다(한 하네스 세션을 두 프로세스가 밟는다).
//! - [`advance_last_fed_seq`]: 턴 끝 `lastFedSeq` 전진. 대기 멘션의 **최소 seq − 1 로 클램프**한다(스펙 §5-2 결정 7) —
//!   클램프가 없으면 유예됐다 풀려나는 멘션의 델타 프롬프트가 비어 그 부름이 조용히 사라진다.
//! - [`settle`]: 턴 끝의 장부 순서 — 클램프 재료(min seq)를 읽고 → 대기 장부를 비우고 → 등록을 푼다. 해제가
//!   마지막이다: 해제되는 순간 받아들이기가 유예를 풀고, 그 멘션 턴은 방금 저장한 `lastFedSeq` 를 읽어야 한다.

use crate::turn_registry::{SharedControl, TurnKind, TurnRecord, lock_control};

/// 정본 `MENTION_STARTING_REJECTION` — 기다려도 멘션 턴이 등록되지 않았다. 사람 화면에 그대로 뜬다.
pub const MENTION_STARTING_REJECTION: &str =
    "이 스레드에 멘션 턴이 막 시작되는 중이다 — 잠시 뒤 다시 열어라";

/// 정본 `NO_RELAY_REJECTION` — 등록된 턴에 중계 세션이 없다.
pub const NO_RELAY_REJECTION: &str =
    "이 스레드에 멘션 턴이 진행 중이지만 관찰 릴레이가 없다 — 턴이 끝난 뒤 다시 열어라";

/// [`claim`] 의 결말.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// 이 스레드는 이제 이 인터랙티브 턴의 것이다(등록됨). 값은 열린 세션 id.
    Registered(String),
    /// 이미 도는 턴이 있다 — 그 세션에 붙는다(정본 분기 ①·②, `created: false`).
    Attach(String),
    /// 멘션 턴이 예약됐지만 아직 등록 전이다 — 기다렸다 다시 부른다(정본 `awaitMentionStart`).
    MentionStarting,
    /// 등록된 턴이 있지만 중계 세션이 없다(정본 `NO_RELAY_REJECTION`).
    NoRelay,
}

/// 등록 직전 재검사 + 세션 열기 + 등록을 한 잠금으로. `running_mention` 은 중계 장부가 아는 그 스레드의 멘션
/// 세션(멘션 턴은 아직 레지스트리에 등록하지 않으므로 중계 장부가 「도는 멘션」의 원천이다).
///
/// `open_session` 은 **등록하기로 정했을 때만** 잠금 안에서 한 번 불린다 — 세션을 열고 거절하면 화면에 빈 세션이 남는다.
/// 잠금 순서는 조종 장부 → 중계 장부 하나뿐이다(중계 장부는 조종 장부를 잡지 않는다).
pub fn claim(
    control: &SharedControl,
    thread_key: &str,
    opened_by_handle: &str,
    running_mention: Option<String>,
    open_session: impl FnOnce() -> String,
) -> Claim {
    let mut c = lock_control(control);
    if let Some(rec) = c.registry.get(thread_key) {
        return match &rec.session_id {
            Some(id) => Claim::Attach(id.clone()),
            None => Claim::NoRelay,
        };
    }
    if c.registry.mention_starting(thread_key) {
        return Claim::MentionStarting;
    }
    if let Some(id) = running_mention {
        return Claim::Attach(id);
    }
    let session_id = open_session();
    c.registry
        .register(
            thread_key,
            TurnRecord {
                kind: TurnKind::Interactive,
                session_id: Some(session_id.clone()),
                opened_by_handle: Some(opened_by_handle.to_string()),
            },
        )
        // 위에서 같은 잠금으로 빈 자리를 봤다 — 실패하면 장부 결함이다.
        .expect("빈 자리를 본 같은 잠금 안의 등록");
    Claim::Registered(session_id)
}

/// 턴 끝 `lastFedSeq`. `max_seq` 는 그 사이 스레드에 쌓인 가장 큰 seq, `min_pending` 은 대기 멘션의 최소 seq.
/// 절대 뒤로 가지 않는다.
pub fn advance_last_fed_seq(current: u64, max_seq: u64, min_pending: Option<i64>) -> u64 {
    let advanced = match min_pending {
        Some(min) => {
            let cap = u64::try_from(min.saturating_sub(1)).unwrap_or(0);
            max_seq.min(cap)
        }
        None => max_seq,
    };
    current.max(advanced)
}

/// 턴 끝의 장부 순서. `persist` 는 대기 최소 seq 를 받아 세션 기록을 저장한다(실패해도 장부는 놓는다 —
/// 저장 실패는 다음 멘션이 같은 구간을 다시 먹는 쪽으로 기운다, 소실보다 낫다).
pub fn settle(control: &SharedControl, thread_key: &str, persist: impl FnOnce(Option<i64>)) {
    let min_pending = lock_control(control).queue.min_seq(thread_key);
    persist(min_pending);
    let mut c = lock_control(control);
    c.queue.clear(thread_key);
    c.registry.release(thread_key);
}

#[cfg(test)]
#[path = "interactive_turn_tests.rs"]
mod tests;

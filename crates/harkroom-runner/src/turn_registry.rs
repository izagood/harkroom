//! 턴 레지스트리와 멘션 대기 장부(B4-1a). 정본은 `turnRegistry.ts`·`mentionQueue.ts`(#337).
//!
//! - [`TurnRegistry`]: 「이 스레드에 지금 어떤 턴이 돌고 있는가」의 유일한 원천. 인메모리다 — 프로세스가 곧 턴이라
//!   러너가 죽으면 턴도 같이 죽고, 디스크에 남기면 「죽은 인터랙티브 턴이 조종 중」이라는 거짓이 살아남는다.
//! - [`MentionQueue`]: 사람이 조종 중인 스레드의 멘션 유예 장부. **큐가 아니다 — 큐는 서버 inbox 다.** 여기에는
//!   통지 중복 판정·`lastFedSeq` 클램프 재료(최소 seq)·조종이 얼마나 오래 붙잡았는지만 든다.
//!
//! 둘 다 잠금을 스스로 갖지 않는다 — 쓰는 쪽(스케줄러·인터랙티브)이 `Mutex` 하나로 감싼다.

use std::collections::{HashMap, HashSet};

/// 턴의 종류(`TurnMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnKind {
    Mention,
    Interactive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnRecord {
    pub kind: TurnKind,
    /// 이 턴을 attach 로 보는 릴레이 세션 id. 릴레이가 없는 멘션 턴은 `None`.
    pub session_id: Option<String>,
    /// 인터랙티브 턴에서만 — 터미널을 연 사람의 handle(유예 통지 문구에 들어간다).
    pub opened_by_handle: Option<String>,
}

/// 지금 이 스레드에 사람의 조종이 걸려 있다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadControl {
    pub opened_by_handle: Option<String>,
}

#[derive(Debug)]
pub struct AlreadyRegistered {
    pub thread_key: String,
    pub existing: TurnKind,
}

impl std::fmt::Display for AlreadyRegistered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "TurnRegistry: '{}' 에 이미 {:?} 턴이 등록돼 있다 — 호출자가 3분기(interactiveTurn)나 유예(main 루프)를 건너뛴 결함이다",
            self.thread_key, self.existing
        )
    }
}

#[derive(Default)]
pub struct TurnRegistry {
    turns: HashMap<String, TurnRecord>,
    reserved: HashSet<String>,
}

impl TurnRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 턴 시작에 등록한다. 같은 스레드에 이미 턴이 있으면 **거절한다** — 조용히 덮으면 첫 턴의 `release` 가
    /// 둘째 턴의 등록을 지워 유예가 풀리고, 같은 세션에 PTY 가 둘 뜬다.
    pub fn register(&mut self, thread_key: &str, rec: TurnRecord) -> Result<(), AlreadyRegistered> {
        if let Some(existing) = self.turns.get(thread_key) {
            return Err(AlreadyRegistered {
                thread_key: thread_key.to_string(),
                existing: existing.kind,
            });
        }
        self.turns.insert(thread_key.to_string(), rec);
        Ok(())
    }

    /// 턴의 끝에서 부른다. 없는 키를 지우는 것은 무해하다.
    pub fn release(&mut self, thread_key: &str) {
        self.turns.remove(thread_key);
    }

    /// 멘션을 유예해야 하는가 — 유예 판정은 이 하나다.
    pub fn control_of(&self, thread_key: &str) -> Option<ThreadControl> {
        match self.turns.get(thread_key) {
            Some(t) if t.kind == TurnKind::Interactive => Some(ThreadControl {
                opened_by_handle: t.opened_by_handle.clone(),
            }),
            _ => None,
        }
    }

    pub fn get(&self, thread_key: &str) -> Option<&TurnRecord> {
        self.turns.get(thread_key)
    }

    /// 멘션 턴을 띄우기로 정했지만 아직 `register` 전인 스레드(2026-10-07). 예약은 턴이 아니다 —
    /// `get`·`control_of`·`register` 는 예약을 보지 않는다. 보는 쪽은 인터랙티브 open 하나다.
    pub fn reserve_mention(&mut self, thread_key: &str) {
        self.reserved.insert(thread_key.to_string());
    }

    pub fn unreserve_mention(&mut self, thread_key: &str) {
        self.reserved.remove(thread_key);
    }

    /// 멘션 턴이 시작되는 중인가(예약은 있고 아직 등록은 안 됐다).
    pub fn mention_starting(&self, thread_key: &str) -> bool {
        self.reserved.contains(thread_key) && !self.turns.contains_key(thread_key)
    }

    /// 이 종류의 턴이 도는 스레드들(러너 종료 때 인터랙티브 PTY 회수가 돈다).
    pub fn keys_of(&self, kind: TurnKind) -> Vec<String> {
        let mut keys: Vec<String> = self
            .turns
            .iter()
            .filter(|(_, r)| r.kind == kind)
            .map(|(k, _)| k.clone())
            .collect();
        keys.sort();
        keys
    }
}

/// 한 번의 조종(인터랙티브 턴 하나) 동안의 대기 장부.
struct Episode {
    /// entryId → 그 멘션의 seq.
    entries: HashMap<i64, i64>,
    since_ms: i64,
    warned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeferResult {
    /// 이 entry 의 **첫** 유예인가 — 대기 통지는 이때만 올린다.
    pub should_notify: bool,
    /// 지금 이 스레드에 대기 중인 멘션 수.
    pub pending: usize,
    /// 이 조종이 멘션을 붙잡고 있는 시간(ms). 첫 유예에서는 0.
    pub held_ms: i64,
    /// 상한 경고를 이미 냈는가.
    pub warned: bool,
}

#[derive(Default)]
pub struct MentionQueue {
    by_thread: HashMap<String, Episode>,
}

impl MentionQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// 멘션 하나를 유예로 적는다. 시각은 인자로 받는다(스케줄러의 주입 시계).
    pub fn defer(&mut self, thread_key: &str, entry_id: i64, seq: i64, at_ms: i64) -> DeferResult {
        let ep = self
            .by_thread
            .entry(thread_key.to_string())
            .or_insert_with(|| Episode {
                entries: HashMap::new(),
                since_ms: at_ms,
                warned: false,
            });
        let should_notify = !ep.entries.contains_key(&entry_id);
        ep.entries.insert(entry_id, seq);
        DeferResult {
            should_notify,
            pending: ep.entries.len(),
            // 시계가 뒤로 갈 수 있다 — 음수 경과를 상한 판정에 넣지 않는다.
            held_ms: (at_ms - ep.since_ms).max(0),
            warned: ep.warned,
        }
    }

    /// 상한 경고를 냈다고 적는다(에피소드당 1회).
    pub fn mark_warned(&mut self, thread_key: &str) {
        if let Some(ep) = self.by_thread.get_mut(thread_key) {
            ep.warned = true;
        }
    }

    /// 대기 멘션의 최소 seq. 없으면 `None`.
    pub fn min_seq(&self, thread_key: &str) -> Option<i64> {
        self.by_thread
            .get(thread_key)
            .and_then(|ep| ep.entries.values().min().copied())
    }

    /// 인터랙티브가 끝났다 — 장부를 지운다. 다음 조종의 같은 entry 유예는 새 통지다.
    pub fn clear(&mut self, thread_key: &str) {
        self.by_thread.remove(thread_key);
    }
}

#[cfg(test)]
#[path = "turn_registry_tests.rs"]
mod tests;

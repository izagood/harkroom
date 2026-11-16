//! 새 터미널 턴(정본 `interactiveTurn.ts` `spawn` 의 `state`·`onViewerCount`·`onCancel`·`onSpawn`·`reclaim`)의 회수 상태 기계 — B-2c 2부.
//!
//! PTY·타이머와 떨어진 판정만 둔다. 띄우는 쪽은 사건(뷰어 수·중단·spawn·끝·유예 만료)을 넘기고, 돌려받은 [`Act`] 만 한다:
//!
//! - **고아 회수**(스펙 §5-2 결정 5): 뷰어 0 이 유예(기본 60초)를 시작하고, 0 이 아닌 수가 취소한다. 이미 유예 중이면
//!   다시 세우지 않는다 — 세우면 유예가 늘어난다.
//! - **중단**(#686): 유예 없이 바로 회수한다. 중단은 **먼저 적고** 회수한다 — 그 사이 뷰어 프레임이 회수를 되돌리지 않게.
//!   중단된 조종은 다시 붙잡히지 않는다(뒤의 뷰어 수는 버린다).
//! - **뜨기 전 중단·물러남**: PTY 손잡이가 없으면 회수할 것이 없다 — 표지만 세워 두고 spawn 순간 받는다(정본 #707 판례).
//!   물러남도 중단처럼 표지를 남긴다 — 안 남기면 뜨기 전에 물러남을 받은 턴이 spawn 순간 고아 유예(60초)로 떨어진다.
//! - **spawn 순간 뷰어 수 재생**: 아직 아무 소식이 없으면 0 으로 친다(attach 전 — 유예가 흐른다). 이미 들은 값이 있으면 그 값을
//!   다시 쓴다 — 무조건 0 으로 재면 보고 있는 사람 앞에서 60초 뒤 PTY 가 죽는다.
//! - 회수는 SIGTERM 이 1차, 유예(kill grace) 안에 안 죽으면 SIGKILL.

/// 띄우는 쪽이 할 일.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    /// 고아 유예 타이머를 세운다(끝나면 [`InteractiveLife::orphan_fired`]).
    StartOrphan,
    /// 세워 둔 고아 유예 타이머를 거둔다.
    CancelOrphan,
    /// SIGTERM 을 보내고 kill grace 타이머를 세운다(끝나면 [`InteractiveLife::kill_grace_fired`]).
    Terminate,
    /// SIGKILL.
    Kill,
}

#[derive(Debug, Default)]
pub struct InteractiveLife {
    spawned: bool,
    exited: bool,
    orphan_pending: bool,
    terminating: bool,
    canceled_by: Option<String>,
    /// 러너가 물러난다 — 중단처럼 다시 붙잡히지 않고, 뜨기 전이면 spawn 순간 회수한다.
    shutting_down: bool,
    /// 서버가 마지막으로 말해 준 뷰어 수. `None` = 아직 못 들었다.
    last_viewer_count: Option<i64>,
}

impl InteractiveLife {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn canceled_by(&self) -> Option<&str> {
        self.canceled_by.as_deref()
    }

    pub fn shutting_down(&self) -> bool {
        self.shutting_down
    }

    /// 중단이든 물러남이든 회수가 정해졌다 — 뷰어 수가 되돌리지 못한다.
    fn doomed(&self) -> bool {
        self.canceled_by.is_some() || self.shutting_down
    }

    pub fn exited(&self) -> bool {
        self.exited
    }

    fn reclaim(&mut self, out: &mut Vec<Act>) {
        if self.exited || !self.spawned || self.terminating {
            return;
        }
        self.terminating = true;
        out.push(Act::Terminate);
    }

    fn drop_orphan(&mut self, out: &mut Vec<Act>) {
        if self.orphan_pending {
            self.orphan_pending = false;
            out.push(Act::CancelOrphan);
        }
    }

    /// 서버의 뷰어 수.
    pub fn viewer_count(&mut self, count: i64) -> Vec<Act> {
        let mut out = Vec::new();
        if self.exited || self.doomed() {
            return out;
        }
        self.last_viewer_count = Some(count);
        if !self.spawned {
            // 손잡이가 없다 — 값만 기억했다가 spawn 순간 재생한다.
            return out;
        }
        if count > 0 {
            self.drop_orphan(&mut out);
        } else if !self.orphan_pending {
            self.orphan_pending = true;
            out.push(Act::StartOrphan);
        }
        out
    }

    /// 사람이 [중단] 을 눌렀다.
    pub fn cancel(&mut self, by_handle: &str) -> Vec<Act> {
        let mut out = Vec::new();
        if self.exited || self.canceled_by.is_some() {
            return out;
        }
        self.canceled_by = Some(by_handle.to_string());
        self.drop_orphan(&mut out);
        self.reclaim(&mut out);
        out
    }

    /// PTY 가 떴다(입력 통로를 이은 뒤 부른다).
    pub fn spawned(&mut self) -> Vec<Act> {
        let mut out = Vec::new();
        if self.exited || self.spawned {
            return out;
        }
        self.spawned = true;
        if self.doomed() {
            self.reclaim(&mut out);
            return out;
        }
        let replay = self.last_viewer_count.unwrap_or(0);
        out.extend(self.viewer_count(replay));
        out
    }

    /// 고아 유예가 끝났다.
    pub fn orphan_fired(&mut self) -> Vec<Act> {
        let mut out = Vec::new();
        if !self.orphan_pending {
            return out;
        }
        self.orphan_pending = false;
        self.reclaim(&mut out);
        out
    }

    /// SIGTERM 뒤 유예가 끝났다.
    pub fn kill_grace_fired(&mut self) -> Vec<Act> {
        if self.exited || !self.terminating {
            return Vec::new();
        }
        vec![Act::Kill]
    }

    /// 러너가 물러난다 — 기다릴 답이 없으므로 바로 회수한다. 뜨기 전이면 표지만 세우고 spawn 순간 회수한다.
    pub fn shutdown(&mut self) -> Vec<Act> {
        let mut out = Vec::new();
        if self.exited {
            return out;
        }
        self.shutting_down = true;
        self.drop_orphan(&mut out);
        self.reclaim(&mut out);
        out
    }

    /// PTY 가 끝났다(어느 길이든). 남은 타이머를 거둔다.
    pub fn exit(&mut self) -> Vec<Act> {
        let mut out = Vec::new();
        if self.exited {
            return out;
        }
        self.exited = true;
        self.drop_orphan(&mut out);
        out
    }
}

#[cfg(test)]
#[path = "interactive_life_tests.rs"]
mod tests;

//! 러너 풀(I1a, 그림자) — 「깨움 하나에 칸을 빌려 러너를 띄우고, 턴이 끝나면 반납한다」를 **세기만** 한다.
//!
//! 스위치 `HARKROOM_RUNNER_POOL=shadow`(기본 꺼짐) 뒤에 있다. 켜도 러너를 띄우거나 내리지 않는다 — 상주 러너가 그대로 정본이다.
//! 이 모듈은 풀이 정본이었다면 어떻게 됐을지를 장부로 흉내 낸다:
//!
//! - 깨움(`wake` 프레임)이 왔는데 그 에이전트에 열린 빌림이 없다 → 칸이 있으면 **빌림**(러너를 띄웠을 자리), 없으면 **대기**.
//! - 열린 빌림이 있다 → **이어 씀**(같은 러너가 받았을 깨움).
//! - 그 에이전트의 러너가 턴 칸을 잡았다가 전부 놓았다 → **반납**(러너가 끝났을 자리).
//! - 빌린 뒤 [`EMPTY_AFTER_MS`] 안에 턴 칸을 한 번도 잡지 않았다 → **빈 빌림**(띄웠지만 할 일이 없었을 러너).
//!
//! 칸의 진실은 [`crate::turn_slots::TurnSlots`] 하나다 — 여기서는 따로 세지 않고, 빌림 판정 때 그 값을 받아 본다.
//! 에이전트 id·깨움 id 말고는 아무것도 적지 않는다(글 내용은 프레임에도 오지 않는다).

use std::collections::HashMap;

/// 스위치 이름.
pub const RUNNER_POOL_ENV: &str = "HARKROOM_RUNNER_POOL";
/// 빌린 뒤 이만큼 턴 칸을 안 잡으면 빈 빌림으로 닫는다.
pub const EMPTY_AFTER_MS: u64 = 120_000;
/// 장부가 드는 열린 빌림 수 상한 — 넘으면 가장 오래된 것을 빈 빌림으로 닫는다(프레임이 장부를 끝없이 키우지 못하게).
pub const OPEN_CAP: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolMode {
    Off,
    /// 세기만 한다.
    Shadow,
}

/// `shadow` 일 때만 켠다. 그 밖의 값(`on` 포함 — 아직 없는 단계)·없음은 꺼짐이다.
pub fn mode(value: Option<&str>) -> PoolMode {
    if value.map(str::trim) == Some("shadow") {
        PoolMode::Shadow
    } else {
        PoolMode::Off
    }
}

/// 깨움 하나를 본 결과.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 이 오퍼레이터가 돌리는 에이전트가 아니다.
    NotMine,
    /// 칸을 빌려 러너를 띄웠을 것이다.
    Borrow,
    /// 이미 빌린 러너가 받았을 것이다.
    Reuse,
    /// 풀이 차서 기다렸을 것이다(빌림은 열지 않는다 — 다음 깨움에서 다시 본다).
    WaitFull,
}

/// 누적 수치. 전부 「그랬을 것」의 수다.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub borrow: u64,
    pub reuse: u64,
    pub wait_full: u64,
    pub not_mine: u64,
    /// 턴을 돌리고 반납한 빌림.
    pub returned: u64,
    /// 턴 없이 닫힌 빌림.
    pub empty: u64,
    /// 반납된 빌림들이 열려 있던 시간의 합(ms) — 평균 = `held_ms / returned`.
    pub held_ms: u64,
}

struct Lease {
    runner_id: String,
    opened_at: u64,
    /// 턴 칸을 한 번이라도 잡았나.
    took_slot: bool,
}

#[derive(Default)]
pub struct PoolShadow {
    open: HashMap<String, Lease>,
    counts: Counts,
}

impl PoolShadow {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn counts(&self) -> Counts {
        self.counts
    }

    pub fn open_len(&self) -> usize {
        self.open.len()
    }

    /// 턴 없이 오래 열려 있던 빌림을 닫는다.
    fn sweep(&mut self, now: u64) {
        let before = self.open.len();
        self.open
            .retain(|_, l| l.took_slot || now.saturating_sub(l.opened_at) < EMPTY_AFTER_MS);
        self.counts.empty += (before - self.open.len()) as u64;
    }

    /// 깨움 하나. `runner` 는 그 에이전트의 지금 세대 러너 id(없으면 이 기기 것이 아니다),
    /// `in_use`·`max` 는 방금 읽은 턴 칸(상한 없음이면 `None`)이다.
    pub fn on_wake(
        &mut self,
        agent_id: &str,
        runner: Option<&str>,
        in_use: usize,
        max: Option<u32>,
        now: u64,
    ) -> Decision {
        self.sweep(now);
        let Some(runner) = runner else {
            self.counts.not_mine += 1;
            return Decision::NotMine;
        };
        if let Some(lease) = self.open.get_mut(agent_id) {
            // 러너 세대가 바뀌었으면 칸 통지가 새 id 로 온다 — 따라간다.
            if lease.runner_id != runner {
                lease.runner_id = runner.to_string();
            }
            self.counts.reuse += 1;
            return Decision::Reuse;
        }
        // 풀의 빈 칸 = 상한 − (돌고 있는 턴 + 아직 턴을 안 잡은 빌림). 뒤 것을 빼지 않으면 몰린 깨움이 전부 빌린다.
        let pending = self.open.values().filter(|l| !l.took_slot).count();
        if max.is_some_and(|m| in_use + pending >= m as usize) {
            self.counts.wait_full += 1;
            return Decision::WaitFull;
        }
        if self.open.len() >= OPEN_CAP
            && let Some(oldest) = self
                .open
                .iter()
                .min_by_key(|(_, l)| l.opened_at)
                .map(|(a, _)| a.clone())
        {
            self.open.remove(&oldest);
            self.counts.empty += 1;
        }
        self.open.insert(
            agent_id.to_string(),
            Lease {
                runner_id: runner.to_string(),
                opened_at: now,
                took_slot: false,
            },
        );
        self.counts.borrow += 1;
        Decision::Borrow
    }

    /// 러너 하나가 쥔 턴 칸 수가 바뀌었다([`crate::turn_slots::TurnSlots`] 의 통지). 반납이면 `true`.
    pub fn on_slots(&mut self, runner_id: &str, held: usize, now: u64) -> bool {
        let Some(agent) = self
            .open
            .iter()
            .find(|(_, l)| l.runner_id == runner_id)
            .map(|(a, _)| a.clone())
        else {
            return false;
        };
        if held > 0 {
            if let Some(l) = self.open.get_mut(&agent) {
                l.took_slot = true;
            }
            return false;
        }
        match self.open.get(&agent) {
            Some(l) if l.took_slot => {
                self.counts.returned += 1;
                self.counts.held_ms += now.saturating_sub(l.opened_at);
                self.open.remove(&agent);
                true
            }
            _ => false,
        }
    }

    /// 로그 한 줄 — 수치뿐이다.
    pub fn describe(&self) -> String {
        let c = self.counts;
        format!(
            "빌림 {} · 이어 씀 {} · 대기 {} · 반납 {}(평균 {}초) · 빈 빌림 {} · 남의 것 {} · 열림 {}",
            c.borrow,
            c.reuse,
            c.wait_full,
            c.returned,
            c.held_ms.checked_div(c.returned).unwrap_or(0) / 1000,
            c.empty,
            c.not_mine,
            self.open.len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_reads_only_shadow() {
        assert_eq!(mode(Some("shadow")), PoolMode::Shadow);
        assert_eq!(mode(Some(" shadow ")), PoolMode::Shadow);
        for v in [
            None,
            Some(""),
            Some("on"),
            Some("1"),
            Some("true"),
            Some("off"),
        ] {
            assert_eq!(mode(v), PoolMode::Off, "{v:?}");
        }
    }

    #[test]
    fn first_wake_borrows_and_later_wakes_reuse_until_returned() {
        let mut p = PoolShadow::new();
        assert_eq!(
            p.on_wake("a1", Some("r1"), 0, Some(4), 1_000),
            Decision::Borrow
        );
        assert_eq!(
            p.on_wake("a1", Some("r1"), 0, Some(4), 2_000),
            Decision::Reuse
        );
        // 턴 칸을 잡았다가 다 놓으면 반납이다.
        assert!(!p.on_slots("r1", 1, 3_000));
        assert!(!p.on_slots("r1", 2, 4_000));
        assert!(!p.on_slots("r1", 1, 5_000));
        assert!(p.on_slots("r1", 0, 11_000));
        assert_eq!(p.open_len(), 0);
        // 반납 뒤의 깨움은 다시 빌린다.
        assert_eq!(
            p.on_wake("a1", Some("r1"), 0, Some(4), 12_000),
            Decision::Borrow
        );
        let c = p.counts();
        assert_eq!(
            (c.borrow, c.reuse, c.returned, c.held_ms),
            (2, 1, 1, 10_000)
        );
    }

    #[test]
    fn unknown_agent_is_counted_and_opens_nothing() {
        let mut p = PoolShadow::new();
        assert_eq!(p.on_wake("x", None, 0, Some(4), 0), Decision::NotMine);
        assert_eq!(p.open_len(), 0);
        assert_eq!(p.counts().not_mine, 1);
    }

    #[test]
    fn full_pool_waits_and_counts_borrows_that_have_no_turn_yet() {
        let mut p = PoolShadow::new();
        // 상한 2, 돌고 있는 턴 1 — 한 번은 빌리고, 그 빌림이 아직 턴을 안 잡았어도 다음은 기다린다.
        assert_eq!(p.on_wake("a1", Some("r1"), 1, Some(2), 0), Decision::Borrow);
        assert_eq!(
            p.on_wake("a2", Some("r2"), 1, Some(2), 1),
            Decision::WaitFull
        );
        assert_eq!(p.open_len(), 1);
        // 상한 없음이면 기다리지 않는다.
        assert_eq!(p.on_wake("a2", Some("r2"), 99, None, 2), Decision::Borrow);
        assert_eq!(p.counts().wait_full, 1);
    }

    #[test]
    fn borrow_without_a_turn_closes_as_empty() {
        let mut p = PoolShadow::new();
        assert_eq!(p.on_wake("a1", Some("r1"), 0, Some(4), 0), Decision::Borrow);
        // 칸을 0 으로 통지받아도 잡은 적이 없으면 반납이 아니다.
        assert!(!p.on_slots("r1", 0, 10));
        assert_eq!(p.open_len(), 1);
        // 기한이 지난 뒤의 깨움은 앞 빌림을 빈 빌림으로 닫고 새로 빌린다.
        assert_eq!(
            p.on_wake("a1", Some("r1"), 0, Some(4), EMPTY_AFTER_MS),
            Decision::Borrow
        );
        let c = p.counts();
        assert_eq!((c.borrow, c.empty, c.returned), (2, 1, 0));
    }

    #[test]
    fn turn_holding_lease_is_never_swept() {
        let mut p = PoolShadow::new();
        p.on_wake("a1", Some("r1"), 0, None, 0);
        p.on_slots("r1", 1, 5);
        assert_eq!(
            p.on_wake("a1", Some("r1"), 1, None, EMPTY_AFTER_MS * 10),
            Decision::Reuse
        );
        assert_eq!(p.counts().empty, 0);
    }

    #[test]
    fn new_runner_generation_keeps_the_lease_and_follows_slot_notices() {
        let mut p = PoolShadow::new();
        p.on_wake("a1", Some("r1"), 0, None, 0);
        assert_eq!(p.on_wake("a1", Some("r2"), 0, None, 1), Decision::Reuse);
        // 옛 세대의 통지는 이 빌림과 상관없다.
        assert!(!p.on_slots("r1", 1, 2));
        p.on_slots("r2", 1, 3);
        assert!(p.on_slots("r2", 0, 4));
    }

    #[test]
    fn slot_notice_for_runner_without_lease_is_ignored() {
        let mut p = PoolShadow::new();
        assert!(!p.on_slots("r9", 1, 0));
        assert!(!p.on_slots("r9", 0, 1));
        assert_eq!(p.counts(), Counts::default());
    }

    #[test]
    fn open_leases_are_capped() {
        let mut p = PoolShadow::new();
        for i in 0..OPEN_CAP + 3 {
            let a = format!("a{i}");
            // 같은 시각이라 기한 쓸기는 돌지 않는다.
            assert_eq!(p.on_wake(&a, Some("r"), 0, None, 7), Decision::Borrow);
        }
        assert_eq!(p.open_len(), OPEN_CAP);
        assert_eq!(p.counts().empty, 3);
    }

    #[test]
    fn describe_is_numbers_only() {
        let mut p = PoolShadow::new();
        p.on_wake("agent-secret-name", Some("runner-x"), 0, None, 0);
        let line = p.describe();
        assert!(line.starts_with("빌림 1"), "{line}");
        assert!(!line.contains("agent-secret-name") && !line.contains("runner-x"));
    }
}

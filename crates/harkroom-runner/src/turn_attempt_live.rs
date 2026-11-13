//! `TurnAttempt` struct 의 두 자리 — 턴 도중 바뀌는 값을 **지금 값**으로 읽는 관문 닫개, 그리고 `McpAfterIo` 의 지연 읽기
//! 닫개(앵커 밖 정황·보고처 약속 확인).
//!
//! - 관문: [`LiveTurn`] 이 펜스(`TurnLife::fenced_out`)와 사람의 [중단](`canceled_by`)을 잠금 안에 쥔다. [`LiveTurn::gate`] 는
//!   부를 **때마다** 둘을 새로 읽어 [`spawn_gate`] 를 부른다 — 값을 복사해 닫개에 가두지 않는다. 펜스 감시·[중단] 처리는
//!   다른 스레드에서 [`LiveTurn::fence_lost`]·[`LiveTurn::cancel`] 로 적는다.
//! - 지연 읽기: [`off_anchor_reader`] 는 #2005 [`off_anchor_evidence`] 를, [`report_promise_runner`] 는 #2005·#2006
//!   [`report_promise_check`](사유를 `one_line` 으로 가리고 `@`→`＠`)를 **그대로** 부른다. 문구를 새로 짓지 않는다.

use std::sync::{Mutex, MutexGuard};

use crate::turn_life::TurnLife;
use crate::turn_probe_records::{SpawnBlocked, spawn_gate};
use crate::turn_report::{ReportIo, ReportPromise, off_anchor_evidence, report_promise_check};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// 턴 도중 바뀌는 펜스·[중단] — 관문이 지금 값으로 읽는다.
#[derive(Default)]
pub struct LiveTurn {
    life: Mutex<TurnLife>,
    canceled_by: Mutex<Option<String>>,
}

impl LiveTurn {
    pub fn new(life: TurnLife) -> Self {
        Self {
            life: Mutex::new(life),
            canceled_by: Mutex::new(None),
        }
    }

    /// 턴 임대를 잃었다(정본 `onFenceLost` 의 `end.fencedOut = true`).
    pub fn fence_lost(&self) {
        lock(&self.life).fenced_out = true;
    }

    /// 사람이 [중단] 했다(정본 `end.canceledBy`). 처음 적힌 사람이 남는다.
    pub fn cancel(&self, by: &str) {
        let mut c = lock(&self.canceled_by);
        if c.is_none() {
            *c = Some(by.to_string());
        }
    }

    pub fn canceled_by(&self) -> Option<String> {
        lock(&self.canceled_by).clone()
    }

    pub fn fenced_out(&self) -> bool {
        lock(&self.life).fenced_out
    }

    /// 지금 값으로 [`spawn_gate`] — `attempt_once` 의 `gate` 로 넘긴다(`&mut || live.gate()`).
    pub fn gate(&self) -> Result<(), SpawnBlocked> {
        let canceled = lock(&self.canceled_by).is_some();
        spawn_gate(&lock(&self.life), canceled)
    }
}

/// 앵커 밖 발화 정황 — 정본 `offAnchorEvidence`(#2005) 그대로. 던지지 않는다.
pub struct OffAnchorArgs<'a> {
    pub key: &'a str,
    pub me_id: &'a str,
    pub channel_id: &'a str,
    pub anchor: Option<&'a str>,
    pub turn_start_seq: i64,
    pub turn_id: &'a str,
}

pub fn off_anchor_reader<'a, I: ReportIo + 'a>(
    mut io: I,
    a: OffAnchorArgs<'a>,
) -> Box<dyn FnMut() -> Option<String> + 'a> {
    Box::new(move || {
        off_anchor_evidence(
            &mut io,
            a.key,
            a.me_id,
            a.channel_id,
            a.anchor,
            a.turn_start_seq,
            a.turn_id,
        )
    })
}

/// 보고처 약속 확인 — 정본 `reportPromiseCheck`(#2005, 사유 가림 #2006) 그대로. 판정 결과는 버리고 읽기·발화 실패만 올린다.
pub fn report_promise_runner<'a, I: ReportIo + 'a>(
    mut io: I,
    p: ReportPromise<'a>,
) -> Box<dyn FnMut() -> Result<(), String> + 'a> {
    Box::new(move || report_promise_check(&mut io, &p).map(|_| ()))
}

#[cfg(test)]
#[path = "turn_attempt_live_tests.rs"]
mod tests;

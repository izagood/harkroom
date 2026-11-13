//! [`WatchLoopFn`] 실물을 짓는다 — `MentionParts::spawn` 이 [`crate::mention_parts::run_beside`] 로 PTY 옆에서 도는 감시 루프.
//!
//! **루프는 그 시도의 감시 자리와 감시 목록만 쥔다**(security ②-2 조건 ③): 지을 때 잡는 것은 설정(`EndConfig`·주기)과
//! 짓개(`make`)뿐이다. 감시 자리(`Watch`)와 가림 목록(`NoticeSecrets`)은 **부를 때마다** `run_beside` 가 넘기는 그 시도의 것을
//! 받아 `make` 에 건네고, 탐침 IO·SIGTERM([`terminate_on_watch`])·펜스는 모두 그것으로 짓는다. 그래서 앞 시도의 자리·목록이
//! 다음 시도의 루프에 남을 길이 없다. `make` 도 자리를 잡지 말고 받은 인자로만 짓는다(실물 짓개는 ③ 실배선 몫).
//!
//! 주기 차례·잠금 규칙은 [`run_watch_guarded`] 그대로다(멈춤 → 턴 끝 → 펜스(자리 값) → 탐침(잠금 밖) → 되쓰기 → 거뒀으면 멈춤).

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use crate::mention_parts::{LoopCtx, WatchLoopFn};
use crate::turn_end::EndConfig;
use crate::turn_probe::{ProbeIo, ProbeState};
use crate::turn_probe_records::NoticeSecrets;
use crate::turn_probe_rest::FenceCheck;
use crate::turn_watch::{Watch, WatchStops, run_watch_guarded, terminate_on_watch};

/// 한 시도의 감시 루프 재료 — 그 시도의 자리·목록으로 지은 것.
pub struct LoopParts<I: ProbeIo> {
    pub io: I,
    pub probe: ProbeState,
    /// 턴 끝 신호. 없으면 보지 않는다.
    pub ended: Option<Arc<AtomicBool>>,
    /// 임대 잃음 확인. 없으면 보지 않는다.
    pub fence: Option<FenceCheck>,
}

/// 그 시도의 감시 자리·감시 목록·시도 문맥을 받아 [`LoopParts`] 를 짓는다.
pub type MakeLoop<'a, I> =
    Box<dyn Fn(&Watch, &NoticeSecrets, &LoopCtx) -> LoopParts<I> + Send + Sync + 'a>;

/// 감시 루프 몸통을 짓는다. 돌 때마다 받은 자리·목록으로 `make` 를 불러 탐침 재료를 짓고, SIGTERM 도 그 자리의 손잡이로 보낸다.
pub fn watch_loop_fn<'a, I: ProbeIo + 'a>(
    make: MakeLoop<'a, I>,
    cfg: EndConfig,
    probe_ms: Duration,
) -> WatchLoopFn<'a> {
    Box::new(
        move |watch: &Watch, notice: &NoticeSecrets, ctx: &LoopCtx, stop: &AtomicBool| {
            let mut p = make(watch, notice, ctx);
            run_watch_guarded(
                watch,
                &mut p.probe,
                &cfg,
                &mut p.io,
                probe_ms,
                WatchStops {
                    stop,
                    ended: p.ended.as_deref(),
                    fence: p.fence.as_mut(),
                    terminate: Some(terminate_on_watch(watch)),
                },
            );
        },
    )
}

#[cfg(test)]
#[path = "turn_watch_loop_tests.rs"]
mod tests;

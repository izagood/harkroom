//! 「터미널 열기」(`interactive.open`) 처리자 — 정본 `interactiveTurn.ts` `open` 의 **붙기 갈래**.
//!
//! - API 키 lane 러너는 붙기·새로 열기 모두 막는다(정본 `deps.providerLane`, security F1).
//! - 그 스레드에 멘션 턴이 돌고 있으면 그 턴의 중계 세션 id 를 `created: false` 로 돌려준다 — 새 PTY 를 띄우지 않고
//!   진행 중인 화면에 사람을 붙인다(정본 분기 ①). 그 PTY 는 TUI 라 사람이 직접 칠 수 있다(관문 화면 답하기).
//! - 아무 턴도 없으면 새 인터랙티브 PTY 를 띄운다(분기 ③) — 띄우개([`Spawner`], `RunnerMaker::interactive_open`)에 넘긴다.
//!   띄우개가 아직 없으면(기동 중·시험) 조용히 버리지 않고 무엇이 안 되는지 사람 화면에 바로 답한다(버리면 서버가 504 로 끝난다).
//!
//! 장부와 처리자는 서로를 안다(처리자가 장부의 세션을 찾고, 장부가 처리자를 부른다). 그래서 처리자는 장부를 약한
//! 고리(`Weak`)로, 장부가 선 **뒤에** 채워지는 칸으로 쥔다.

use std::sync::{Arc, OnceLock, Weak};

use crate::relay_session::{InteractiveOpenHandler, InteractiveOpenRequest, RelaySessions};

/// 정본 `PROVIDER_LANE_INTERACTIVE_REJECTION`(`@harkroom/shared/providerLane`). 앞 코드로 앱이 문장을 고른다.
pub const PROVIDER_LANE_INTERACTIVE_REJECTION: &str =
    "interactive_unsupported: API 키로 도는 에이전트는 아직 터미널 열기를 지원하지 않는다";

/// 도는 턴이 없는데 띄우개 칸이 아직 비었을 때(기동 직후 잠깐). **`interactive_unsupported:` 머리를 붙이지 않는다** —
/// 그 머리는 앱이 「API 키 에이전트는 터미널을 못 연다」 문장과 [열기] 버튼 숨김으로 읽는 표지라(`laneCodes.ts`
/// `isInteractiveUnsupported`), 구독 계정 에이전트에도 API 키 문구가 떴다. 머리 없는 문장은 앱이 열기 실패 사유로 그대로
/// 보이고 [열기]를 남긴다 — 잠시 뒤 다시 누르면 된다.
pub const NEW_INTERACTIVE_UNSUPPORTED: &str = "이 러너는 아직 새 터미널 턴을 띄울 준비가 안 됐다 — 이 스레드에 멘션 턴이 도는 동안에는 그 화면에 붙을 수 있다";

/// 장부가 아직 없다(기동 중) — 정본 `러너가 아직 기동 중이다` 문구.
pub const RUNNER_STARTING: &str = "러너가 아직 기동 중이다 — 잠시 뒤 다시 열어라";

/// 처리자가 장부를 찾는 칸. `RelaySessions::new` 뒤에 [`fill`] 로 채운다.
pub type LedgerCell = Arc<OnceLock<Weak<RelaySessions>>>;

/// 새 터미널 턴 띄우개(분기 ③). 장부·짓개가 선 뒤 [`fill_spawner`] 로 채운다.
pub type Spawner =
    Arc<dyn Fn(&InteractiveOpenRequest) -> Result<(String, bool), String> + Send + Sync>;
pub type SpawnerCell = Arc<OnceLock<Spawner>>;

pub fn spawner_cell() -> SpawnerCell {
    Arc::new(OnceLock::new())
}

pub fn fill_spawner(cell: &SpawnerCell, spawner: Spawner) {
    let _ = cell.set(spawner);
}

pub fn ledger_cell() -> LedgerCell {
    Arc::new(OnceLock::new())
}

pub fn fill(cell: &LedgerCell, ledger: &Arc<RelaySessions>) {
    let _ = cell.set(Arc::downgrade(ledger));
}

/// 한 요청의 판정 — 시험이 장부 없이 갈래를 본다.
pub fn decide(
    provider_lane: bool,
    ledger: Option<&RelaySessions>,
    spawner: Option<&Spawner>,
    req: &InteractiveOpenRequest,
) -> Result<(String, bool), String> {
    if provider_lane {
        return Err(PROVIDER_LANE_INTERACTIVE_REJECTION.to_string());
    }
    let Some(ledger) = ledger else {
        return Err(RUNNER_STARTING.to_string());
    };
    match ledger.mention_session_of(&req.channel_id, &req.thread_root_id) {
        Some(session_id) => Ok((session_id, false)),
        None => match spawner {
            Some(spawn) => spawn(req),
            None => Err(NEW_INTERACTIVE_UNSUPPORTED.to_string()),
        },
    }
}

/// 링크에 꽂을 처리자.
pub fn handler(
    cell: LedgerCell,
    spawner: SpawnerCell,
    provider_lane: bool,
) -> InteractiveOpenHandler {
    Arc::new(move |req: InteractiveOpenRequest| {
        let ledger = cell.get().and_then(Weak::upgrade);
        decide(provider_lane, ledger.as_deref(), spawner.get(), &req)
    })
}

#[cfg(test)]
#[path = "interactive_open_tests.rs"]
mod tests;

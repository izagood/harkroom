//! harkroom 오퍼레이터의 Rust 판(S2, Rust 전환). **A1 은 `merge` 래퍼의 클라이언트 쪽과 P5 파일 잠금만** 옮긴다 —
//! 정본은 `packages/operator/src/main.ts::mergeMain`·`callOperatorTool`, `turnMerge.ts::parseMergeArgs`, `fileLock.ts` 다.
//! A2 는 앱 ↔ 오퍼레이터 소켓 서버(P3)의 문지기와 `ping`·`listRunners` 를 옮긴다(`socket`·`endpoint`·`serve`).
//! A3b 는 러너 표(`spawnRunner`·`killRunner`·`runnerExit` 이벤트, `runners`)와 `operators.json` 색인 읽기(`index`)를 옮긴다.
//! A5a 는 로컬 설정의 에이전트 항목(`operatorAgent*` 4개, `local_agents`)을 옮긴다.
//! A5b 는 머지 래퍼의 gh 계정(`operatorMerge*` 3개, `local_merge`)을 옮긴다.
//! A5c 는 이 머신의 MCP 정의(`operatorMcp*` 4개, `local_mcp`)를 옮긴다.
//! A5d 는 원격 MCP 의 OAuth(`operatorMcpAuth*` 3개와 목록의 `auth` 칸, `mcp_oauth`)를 옮긴다. refresh·토큰 굽기는 러너 쪽(s21)이다.
//! 아직 앱에 실리지 않는다(번들·스위치는 A4).
//!
//! `merge` 는 에이전트 지시문·허용 규칙(`Bash(…harkroom-operator merge:*)`)이 **이름·인자·한 줄 JSON 출력·종료 코드**에
//! 기대는 경계(P4)다. 그래서 TS 와 같은 입력에 **바이트까지 같은** 출력을 내야 한다 — `tests/merge_golden.rs` 가
//! TS 가 실제로 낸 출력(`golden/merge.json`)과 비교한다.
//! 파일 잠금(P5)은 전환 동안 Node·Rust 오퍼레이터가 **같은 잠금 파일**을 번갈아 잡는다 — `tests/file_lock_xlang.rs`.
pub mod adopt;
pub mod api_cli;
pub mod assignments;
pub mod bridge;
pub mod callback_page;
pub mod claude_accounts;
pub mod claude_login;
pub mod claude_usage_poller;
pub mod codex_accounts;
pub mod codex_hook;
pub mod codex_login;
pub mod community;
pub mod endpoint;
pub mod file_lock;
pub mod forward;
pub mod harnesses;
pub mod hello;
pub mod hook_cli;
pub mod hook_run;
pub mod index;
pub mod local_agents;
pub mod local_mcp;
pub mod local_merge;
pub mod mcp_bridge;
pub mod mcp_config;
pub mod mcp_oauth;
pub mod merge;
pub mod pr_gate;
pub mod provider_usage;
pub mod relay_mux;
pub mod retiring;
pub mod runner_ledger;
pub mod runner_link;
pub mod runner_log;
pub mod runners;
pub mod serve;
pub mod server_link;
pub mod socket;
pub mod tool_rules;
pub mod turn_api;
pub mod turn_command;
pub mod turn_keys;
pub mod turn_leases;
pub mod turn_merge;
pub mod turn_peek;
pub mod turn_pr_status;
pub mod turn_secrets;
pub mod turn_slots;
pub mod turn_uploads;
pub mod wipe;
pub mod ws_dialer;

/// 시험 전용: 러너 시험의 fork 와, 소켓을 bind 했다 닫아 「잔해」를 만드는 시험이 겹치지 않게 한다.
/// fork 와 exec 사이에 자식이 그 듣는 fd 를 잠깐 물려받으면 잔해가 「살아 있음」으로 보인다(로컬 1/9 재현).
#[cfg(test)]
pub(crate) static FORK_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(test)]
pub(crate) fn fork_guard() -> std::sync::MutexGuard<'static, ()> {
    FORK_GUARD.lock().unwrap_or_else(|p| p.into_inner())
}

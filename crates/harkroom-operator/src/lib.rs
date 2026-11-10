//! harkroom 오퍼레이터의 Rust 판(S2, Rust 전환). **A1 은 `merge` 래퍼의 클라이언트 쪽과 P5 파일 잠금만** 옮긴다 —
//! 정본은 `packages/operator/src/main.ts::mergeMain`·`callOperatorTool`, `turnMerge.ts::parseMergeArgs`, `fileLock.ts` 다.
//! A2 는 앱 ↔ 오퍼레이터 소켓 서버(P3)의 문지기와 `ping`·`listRunners` 를 옮긴다(`socket`·`endpoint`·`serve`).
//! 아직 앱에 실리지 않는다(번들·스위치는 A4).
//!
//! `merge` 는 에이전트 지시문·허용 규칙(`Bash(…harkroom-operator merge:*)`)이 **이름·인자·한 줄 JSON 출력·종료 코드**에
//! 기대는 경계(P4)다. 그래서 TS 와 같은 입력에 **바이트까지 같은** 출력을 내야 한다 — `tests/merge_golden.rs` 가
//! TS 가 실제로 낸 출력(`golden/merge.json`)과 비교한다.
//! 파일 잠금(P5)은 전환 동안 Node·Rust 오퍼레이터가 **같은 잠금 파일**을 번갈아 잡는다 — `tests/file_lock_xlang.rs`.
pub mod endpoint;
pub mod file_lock;
pub mod merge;
pub mod serve;
pub mod socket;

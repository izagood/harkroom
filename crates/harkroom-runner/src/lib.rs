//! harkroom 러너의 Rust 이식(S3 B3). 정본은 `packages/agent/src` 이다 — 아직 오퍼레이터는 node 러너를 띄운다.
//!
//! - `adapter`: 하네스 어댑터 표 6종과 조회 함수(`adapters/*`). 하네스 홈·작업 폴더 신뢰는 B3c 다음 조각.
//! - `config`: 오퍼레이터가 spawn 때 심는 env(`config.ts`).
//! - `link`: 오퍼레이터 unix 소켓 링크 클라이언트(`relay.ts` 의 연결·요청 부분). 세션(PTY)은 B3b.
//! - `rest`: `HarkroomAgentClient` 의 REST 절반(`http.forward`)과 턴 열쇠(`harkroom.ts`·`turnKeys.ts`). MCP 절반은 `mcp`.
//! - `pty`: PTY 턴의 순수 절반(`pty.ts` 앞부분 — 명령 조립·붙여넣기 정리·준비/관문 판정·링 버퍼·출력 합치기). PTY 실행은 B3b-2.
//! - `pty_proc`·`pty_record`: PTY 실행의 프로세스 절반(openpty·spawn·write/resize/kill 승격·읽기)과 녹화(B3b-2a). 주입 상태 기계와 턴 루프(`run_pty_turn`)는 `pty_turn`(B3b-2b).
//! - `codex_home`·`workspace_trust`: 격리 `CODEX_HOME`(활성 codex 계정 링크)과 하네스 신뢰·계정 설정 걷기(B3c-2a). 장부 고르기·연결은 B3d.
//! - `codex_rules`: codex 승인 명령 규칙 파일·턴 hook·hook 신뢰(`codexRules.ts`·shared `codexRulesFile`, B3c-2c-4). 부르는 자리는 B3d.
//! - `relay_session`: 중계 세션 장부(`relay.ts` 의 세션 절반 — ring·replay·input·resize·뷰어 수·중단·인터랙티브 열기, B3b-2c).
//! - `opencode_home`: opencode·kilo 격리 XDG 홈의 순수 절반(`opencodeHome.ts` — 권한 표·이름·모델 문법·JSONC). 잠금·홈 만들기는 다음 조각.
//! - `pi_home`: pi 격리 상태 루트(`piHome.ts` — 링크·설정 고르기·MCP 표·읽기 전용 도구 목록, B3c-2c-1). lane 스레드 홈·`models.json` 은 `pi_lane`(B3c-2c-2).
//! - `turn_rules`: 턴 권한 상수·hook 설정 빌더(`turn.ts` 앞 절반, B3d-1). 프리셋·`buildTurnCommand` 연결은 B3d-2.
//! - `account_assign`: 스레드별 claude 계정 배정(`accountAssign.ts` 와 shared 조각, B3e-2). 턴 흐름 연결은 다음 조각.
//! - `thread_note_pin`·`memory_cache`: 스레드 메모 고정과 러너 메모리 캐시(`threadNotePin.ts`·`memoryCache.ts`, B3e-1a). `prompt` 는 `escapeForPrompt` 조각.
//! - `bg_executor`: 백그라운드 회차의 순수 절반(`bgExecutor.ts` — 창·argv·지시문·MCP 설정·프롬프트, B3e-5a). 틱 루프는 B3e-5b.
//! - `review_fork`: 턴 뒤 리뷰 포크(`reviewFork.ts` — 인자·결과 파싱·켜기 스위치·카운터·포크 실행, B3e-4). 턴 루프 연결은 B3e-7.
//! - `provider_lane`: 전용 제공사 경로의 러너 절반(`providerLane.ts` — 턴 키 받기·턴 파일·lane/턴 MCP 설정). 턴 흐름에는 아직 안 붙였다.
//! - `mcp`: `HarkroomAgentClient` 의 MCP 절반(`call()`·`inbox.poll`·`message.*`·기억·계획·bg) — 링크의 `mcp.request`.
//! - `session_store`·`turn_prep`: 스레드 세션 기록(`sessions.ts`)과 멘션 턴 준비 판정(`runMentionTurn` 앞부분, B4-2d). 턴 루프 연결은 다음 조각.
//! - `harness_memory`: 하네스 파일 메모리 수확 알림(`harnessMemory.ts`, B4-2e-2). 턴 흐름 연결은 다음 조각.
//! - `poll_loop`·`turn_registry`: 폴 루프와 턴 레지스트리·멘션 대기 장부(`main.ts` 루프·`stop.ts`·`idleStop.ts`·`turnRegistry.ts`·`mentionQueue.ts`, B4-1a). 스케줄러는 trait 뒤 — `mentionScheduler` 는 B4-1b.

pub mod account_assign;
pub mod account_failover;
pub mod account_marks;
pub mod adapter;
pub mod bg_executor;
pub mod bg_tick;
pub mod call_maker;
pub mod codex_home;
pub mod codex_rules;
pub mod config;
pub mod fail_text;
pub mod harness_errors;
pub mod harness_memory;
pub mod harness_records;
pub mod lane_guard;
pub mod link;
pub mod mcp;
pub mod memory_cache;
pub mod memory_pin;
pub mod mention_admit;
pub mod mention_admit_deps;
pub mod mention_body;
pub mod mention_call;
pub mod mention_clients;
pub mod mention_deps;
pub mod mention_hooks;
pub mod mention_inputs;
pub mod mention_ledger;
pub mod mention_parts;
pub mod mention_run;
pub mod mention_sched;
pub mod mention_scheduler;
pub mod mention_settle;
pub mod mention_target;
pub mod mention_turn_parts;
pub mod mention_watch;
pub mod omp_home;
pub mod opencode_home;
pub mod pi_home;
pub mod pi_lane;
pub mod poll_admit;
pub mod poll_loop;
pub mod poll_sched;
pub mod prompt;
pub mod prompt_sections;
pub mod prompt_system;
pub mod prompt_turn;
pub mod provider_lane;
pub mod pty;
pub mod pty_proc;
pub mod pty_record;
pub mod pty_turn;
pub mod relay_session;
pub mod rest;
pub mod review_fork;
pub mod runner_wire;
pub mod secret_scrub;
pub mod session_store;
pub mod silent_notice;
pub mod skills_sync;
pub mod thread_claims;
pub mod thread_model;
pub mod thread_note_pin;
pub mod thread_plan_pin;
pub mod turn_after;
pub mod turn_after_source;
pub mod turn_assemble;
pub mod turn_attempt;
pub mod turn_attempt_account;
pub mod turn_attempt_fold;
pub mod turn_attempt_live;
pub mod turn_attempt_relay;
pub mod turn_attempt_run;
pub mod turn_command;
pub mod turn_end;
pub mod turn_env;
pub mod turn_env_plan;
pub mod turn_failure;
pub mod turn_files;
pub mod turn_gate;
pub mod turn_io;
pub mod turn_lane_first;
pub mod turn_launch;
pub mod turn_launch_io;
pub mod turn_life;
pub mod turn_mcp_plan;
pub mod turn_notice;
pub mod turn_nudge_io;
pub mod turn_outcome;
pub mod turn_outcome_source;
pub mod turn_parts;
pub mod turn_policy;
pub mod turn_posts;
pub mod turn_prep;
pub mod turn_prepare;
pub mod turn_prepare_io;
pub mod turn_preset;
pub mod turn_probe;
pub mod turn_probe_io;
pub mod turn_probe_make;
pub mod turn_probe_records;
pub mod turn_probe_rest;
pub mod turn_probe_sink;
pub mod turn_probe_state;
pub mod turn_registry;
pub mod turn_report;
pub mod turn_rules;
pub mod turn_run;
pub mod turn_success;
pub mod turn_watch;
pub mod turn_watch_loop;
pub mod workspace;
pub mod workspace_trust;

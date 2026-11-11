//! harkroom 러너의 Rust 이식(S3 B3). 정본은 `packages/agent/src` 이다 — 아직 오퍼레이터는 node 러너를 띄운다.
//!
//! - `config`: 오퍼레이터가 spawn 때 심는 env(`config.ts`).
//! - `link`: 오퍼레이터 unix 소켓 링크 클라이언트(`relay.ts` 의 연결·요청 부분). 세션(PTY)은 B3b.
//! - `rest`: `HarkroomAgentClient` 의 REST 절반(`http.forward`)과 턴 열쇠(`harkroom.ts`·`turnKeys.ts`). MCP 절반은 `mcp`.
//! - `mcp`: `HarkroomAgentClient` 의 MCP 절반(`call()`·`inbox.poll`·`message.*`·기억·계획·bg) — 링크의 `mcp.request`.

pub mod config;
pub mod link;
pub mod mcp;
pub mod rest;

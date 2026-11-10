//! harkroom 서버의 Rust 앞단(S5.1a, Rust 전환). 아직 운영에 배포하지 않는다.
//!
//! 라우트를 하나씩 Rust 로 옮기는 동안(strangler) 이 프로세스가 HTTP 를 먼저 받는다. 지금은 **모든 HTTP 요청을 TS 서버로
//! 그대로 넘긴다** — 옮긴 라우트가 생기면 그 경로만 여기서 답한다. WebSocket 경로(`/ws` 등)는 Ingress 가 처음부터 TS 로 보내므로
//! 여기로 오는 업그레이드 요청은 거절한다.
pub mod auth;
pub mod proxy;
pub mod schema;

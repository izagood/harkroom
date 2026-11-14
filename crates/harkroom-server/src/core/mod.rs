//! S5.3 코어(C0 뼈대) — TS 서버가 프로세스 메모리로 쥐던 것을 Rust 로 옮기는 자리. 스위치 `HARKROOM_CORE`(`ts` 기본 · `rust`)가
//! `rust` 일 때만 마운트한다 — 기본값으로는 앞단 동작이 지금과 같다(운영 Ingress 는 `/ws` 를 아직 TS 로 보낸다, C6 에서 바꾼다).
//!
//! C0 가 담는 것: POST `/ws-ticket` · GET `/ws`(TS `ws/wsPlugin.ts`·`tickets.ts`·`heartbeat.ts`·`appHeartbeat.ts`·`socketLifetime.ts`·
//! `credentials.ts`·`typing.ts`) · 이벤트 공급(outbox LISTEN → 프로세스 안 팬아웃, TS `eventBus.ts` 와 같은 순서·모양 검사).
//! 에이전트 presence(MCP `presence.ts`)는 C3 몫이라 지금 스냅샷에는 사람 소켓만 실린다.
pub mod audience;
pub mod events;
pub mod operator_hub;
pub mod tickets;
pub mod typing;
pub mod ws;

/// `HARKROOM_CORE` — 모르는 값이면 기동을 멈춘다(조용히 켜지거나 꺼지지 않게).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreMode {
    Ts,
    Rust,
}

pub fn parse_mode(raw: Option<&str>) -> Result<CoreMode, String> {
    match raw.map(str::trim).unwrap_or("") {
        "" | "ts" => Ok(CoreMode::Ts),
        "rust" => Ok(CoreMode::Rust),
        v => Err(format!(
            "HARKROOM_CORE={v:?} is not understood — use ts or rust"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parse() {
        assert_eq!(parse_mode(None), Ok(CoreMode::Ts));
        assert_eq!(parse_mode(Some(" ts ")), Ok(CoreMode::Ts));
        assert_eq!(parse_mode(Some("rust")), Ok(CoreMode::Rust));
        assert!(parse_mode(Some("Rust")).is_err());
        assert!(parse_mode(Some("on")).is_err());
    }
}

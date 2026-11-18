//! 서버에 알리는 러너 판(`inbox.poll` 의 `version` → `AgentView.runnerVersion`).
//!
//! 오퍼레이터는 러너를 띄울 때 자기 번들 판을 `AGENT_VERSION` 으로 심는다(`harkroom-operator` `assignments.rs`).
//! 화면의 뒤처짐 판정은 그 값을 **배정된 오퍼레이터의 판**과 견준다(desktop `runnerVersions.ts`). 그래서 러너는
//! 컴파일 때 박힌 crate 판(`CARGO_PKG_VERSION`, 늘 `0.1.0`)이 아니라 이 값을 보고해야 한다 — crate 판을 보내면
//! 모든 러너가 `0.1.0 · 뒤처짐` 으로 그려진다(2026-11-18 실측).
//!
//! 없거나 비었으면 `unknown` 이다(TS 러너와 같은 값). 화면은 이것을 「모른다」로 세고 뒤처짐으로 단정하지 않는다.

/// `AGENT_VERSION` 을 못 받았을 때 보고하는 값 — desktop `UNKNOWN_RUNNER_VERSION` 과 같다.
pub const UNKNOWN_RUNNER_VERSION: &str = "unknown";

/// `get` 은 환경 읽기(시험이 바꿔 끼운다).
pub fn runner_version(get: impl Fn(&str) -> Option<String>) -> String {
    get("AGENT_VERSION")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| UNKNOWN_RUNNER_VERSION.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_operator_bundle_version_not_crate_version() {
        let v = runner_version(|k| (k == "AGENT_VERSION").then(|| "0.4.820".to_string()));
        assert_eq!(v, "0.4.820");
        assert_ne!(v, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn missing_or_blank_is_unknown() {
        assert_eq!(runner_version(|_| None), "unknown");
        assert_eq!(runner_version(|_| Some("  ".into())), "unknown");
    }
}

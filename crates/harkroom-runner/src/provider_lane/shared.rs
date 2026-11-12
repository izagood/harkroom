//! `@harkroom/shared/providerLane` 에서 러너 lane 이 쓰는 최소 조각 — 잰 판 목록·base URL 고르기·실패 코드 접기.
//!
//! 실패 코드 목록 자체는 `harkroom_proto::p1::PROVIDER_LANE_FAILURE_CODES`(골든과 같은지 proto 시험이 본다)를 쓴다.

use harkroom_proto::p1::PROVIDER_LANE_FAILURE_CODES;

/// opencode 잰 판.
pub const OPENCODE_LANE_MEASURED_VERSIONS: &[&str] = &["1.18.32", "1.19.4"];
/// codex 잰 판.
pub const CODEX_LANE_MEASURED_VERSIONS: &[&str] = &["0.154.0"];
/// omp 잰 판.
pub const OMP_LANE_MEASURED_VERSIONS: &[&str] = &["18.12.6"];
/// kilo 잰 판.
pub const KILO_LANE_MEASURED_VERSIONS: &[&str] = &["7.8.17"];
/// pi 잰 판.
pub const PI_LANE_MEASURED_VERSIONS: &[&str] = &["1.4.0"];

/// 정본 `providerLaneFailureCode` — 목록 밖은 `unknown`.
pub fn provider_lane_failure_code(raw: &str) -> &'static str {
    PROVIDER_LANE_FAILURE_CODES
        .iter()
        .copied()
        .find(|c| *c == raw)
        .unwrap_or("unknown")
}

/// JS `String.prototype.trim` 이 걷는 글자(유니코드 공백 + BOM).
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// 정본 `normalizeProviderBaseUrl` 의 좁은 판(오퍼레이터 `local_agents.rs` 와 같은 규칙).
/// `https://<호스트>[:포트][/경로]`(루프백만 `http:`)를 받아 `scheme://host[:port]<경로, 끝 / 없음>` 을 돌려준다.
/// 받지 않는 것: 사용자 정보·쿼리·조각, 호스트에 ASCII 영숫자·`.`·`-` 밖의 글자(IPv6 는 `[::1]` 만),
/// 경로에 퍼센트 인코딩이 필요한 글자, `.`·`..` 조각. scheme·호스트는 소문자로, 기본 포트는 뗀다(URL 과 같게).
pub fn normalize_provider_base_url(raw: &str) -> Option<String> {
    let s = js_trim(raw);
    if s.is_empty() || s.len() > 512 {
        return None;
    }
    let (scheme, rest) = s.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    if rest.contains(['?', '#', '@', '\\']) {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = &authority[..=end];
        let port = match &authority[end + 1..] {
            "" => None,
            t => Some(t.strip_prefix(':')?),
        };
        if host != "[::1]" {
            return None;
        }
        (host.to_string(), port)
    } else {
        let (h, p) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        if h.is_empty()
            || !h
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        {
            return None;
        }
        (h.to_ascii_lowercase(), p)
    };
    let port = match port {
        None | Some("") => None,
        Some(p) => {
            if !p.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if n > 65535 {
                return None;
            }
            let default = if scheme == "https" { 443 } else { 80 };
            (n != default).then_some(n)
        }
    };
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
    if scheme == "http" && !loopback {
        return None;
    }
    if !path
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'-' | b'.' | b'_' | b'~'))
    {
        return None;
    }
    // `.`·`..` 조각은 URL 이 접는다 — 접지 않고 거절한다.
    if path.split('/').any(|seg| seg == "." || seg == "..") {
        return None;
    }
    let path = path.trim_end_matches('/');
    let port = port.map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{scheme}://{host}{port}{path}"))
}

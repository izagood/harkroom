//! S5.4 AT7(준비) — 들어오는 hook 의 서명·토큰 검증. TS `services/automationIngress.ts` 의 `verifyBearer`·`verifyGithubSignature`·
//! `safeEqual` 을 옮긴다. 줄(`POST /hooks/github/:id` 등)은 `automation_hooks` 가 쓴다.
//!
//! - 비교는 늘 상수 시간(XOR 누적 — `ring::constant_time` 은 0.17 에서 deprecated). 길이가 다르면 바로 false(TS `safeEqual` 과 같다 — 길이는 숨기지 않는다).
//! - 비밀 값(토큰 해시·열린 서명 키)은 이 모듈 밖으로 내보내지 않고 기록하지 않는다.
use ring::{digest, hmac};

/// TS `safeEqual` — 바이트 길이가 같고 내용이 같을 때만 true(상수 시간).
pub fn safe_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    // 모든 바이트를 XOR 로 모은다(일찍 끝내지 않는다). `black_box` 로 최적화가 가지를 만들지 못하게 한다.
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// TS `hashIngressKey` — sha256 16진수(소문자).
pub fn hash_ingress_key(key: &str) -> String {
    hex::encode(digest::digest(&digest::SHA256, key.as_bytes()))
}

/// TS `verifyBearer` — `Authorization: Bearer <키>` 의 sha256 이 저장된 해시와 같은가.
pub fn verify_bearer(token_hash: Option<&str>, header: Option<&str>) -> bool {
    let (Some(want), Some(h)) = (token_hash, header) else {
        return false;
    };
    let Some(key) = h.strip_prefix("Bearer ") else {
        return false;
    };
    // JS `String#trim` 근사 — ASCII 공백.
    let key = key.trim_matches(|c: char| c.is_ascii_whitespace());
    safe_equal(hash_ingress_key(key).as_bytes(), want.as_bytes())
}

/// TS `verifyGithubSignature` — `X-Hub-Signature-256: sha256=<hex>` 를 원문 바이트로 검증한다. `key` 는 열린 서명 비밀.
pub fn verify_github_signature(key: &[u8], raw: &[u8], header: Option<&str>) -> bool {
    let Some(h) = header.filter(|h| h.starts_with("sha256=")) else {
        return false;
    };
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), raw);
    let want = format!("sha256={}", hex::encode(tag.as_ref()));
    safe_equal(want.as_bytes(), h.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(key: &[u8], body: &[u8]) -> String {
        let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), body);
        format!("sha256={}", hex::encode(tag.as_ref()))
    }

    #[test]
    fn github_signature_good() {
        // GitHub 문서의 예: secret "It's a Secret to Everybody", payload "Hello, World!".
        let h = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        assert!(verify_github_signature(
            b"It's a Secret to Everybody",
            b"Hello, World!",
            Some(h)
        ));
    }

    #[test]
    fn github_signature_bad() {
        let good = sig(b"k", b"body");
        assert!(!verify_github_signature(b"other", b"body", Some(&good)));
        assert!(!verify_github_signature(b"k", b"body2", Some(&good)));
        let mut flipped = good.clone().into_bytes();
        let last = flipped.len() - 1;
        flipped[last] = if flipped[last] == b'0' { b'1' } else { b'0' };
        assert!(!verify_github_signature(
            b"k",
            b"body",
            Some(std::str::from_utf8(&flipped).unwrap())
        ));
        assert!(!verify_github_signature(b"k", b"body", None));
        assert!(!verify_github_signature(b"k", b"body", Some(&good[7..])));
        // 대문자 16진수는 TS 와 같이 거절(글자 비교).
        assert!(!verify_github_signature(
            b"k",
            b"body",
            Some(&format!("sha256={}", good[7..].to_uppercase()))
        ));
    }

    #[test]
    fn length_mismatch_is_false() {
        let good = sig(b"k", b"body");
        assert!(!verify_github_signature(
            b"k",
            b"body",
            Some(&good[..good.len() - 1])
        ));
        assert!(!verify_github_signature(
            b"k",
            b"body",
            Some(&format!("{good}0"))
        ));
        assert!(!safe_equal(b"abc", b"abcd"));
        assert!(safe_equal(b"", b""));
    }

    #[test]
    fn bearer() {
        let h = hash_ingress_key("tok");
        assert!(verify_bearer(Some(&h), Some("Bearer tok")));
        assert!(verify_bearer(Some(&h), Some("Bearer  tok ")));
        assert!(!verify_bearer(Some(&h), Some("Bearer tok2")));
        assert!(!verify_bearer(Some(&h), Some("bearer tok")));
        assert!(!verify_bearer(None, Some("Bearer tok")));
        assert!(!verify_bearer(Some(&h), None));
    }
}

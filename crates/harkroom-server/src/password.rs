//! 비밀번호 해시(S5.4 decision 1) — TS `argon2`(node-argon2 0.41) 의 `argon2.hash` / `argon2.verify` 와 같은 PHC 문자열.
//!
//! node-argon2 기본값을 그대로 쓴다: argon2id, v=19, m=65536(KiB), t=3, p=4, 소금 16바이트, 해시 32바이트.
//! 결과는 `$argon2id$v=19$m=65536,t=3,p=4$<소금 b64>$<해시 b64>` (패딩 없는 base64) — TS 가 만든 해시를 Rust 가
//! 검증하고, Rust 가 만든 해시를 TS 가 검증한다. 검증은 해시 문자열에 적힌 변수로 한다(node-argon2 `verify` 와 같다).
//!
//! 해시·검증은 **의도적으로 비싼** 연산이다(64MiB·3회). async 핸들러는 [`hash_async`]·[`verify_async`] 로
//! 블로킹 스레드에 넘긴다.
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};

/// node-argon2 `memoryCost` 기본값(KiB).
pub const M_COST: u32 = 65_536;
/// node-argon2 `timeCost` 기본값.
pub const T_COST: u32 = 3;
/// node-argon2 `parallelism` 기본값.
pub const P_COST: u32 = 4;
/// node-argon2 `hashLength` 기본값.
pub const HASH_LEN: usize = 32;
/// node-argon2 `saltLength` 기본값.
pub const SALT_LEN: usize = 16;

fn hasher() -> Argon2<'static> {
    let params = Params::new(M_COST, T_COST, P_COST, Some(HASH_LEN)).expect("valid argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// TS `argon2.hash(password)`. 소금은 OS 난수 16바이트.
pub fn hash(password: &str) -> String {
    let mut salt = [0u8; SALT_LEN];
    getrandom::fill(&mut salt).expect("os random");
    hash_with_salt(password, &salt)
}

fn hash_with_salt(password: &str, salt: &[u8]) -> String {
    hasher()
        .hash_password_with_salt(password.as_bytes(), salt)
        .expect("argon2 hash")
        .to_string()
}

/// TS `argon2.verify(hash, password)`. 해시 문자열이 깨졌으면 TS 는 던지고(500) 여기서는 `false` 다 —
/// 저장된 해시는 이 모듈·TS 가 만든 것뿐이라 깨진 값은 실제로 오지 않는다.
pub fn verify(hash: &str, password: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), hash)
        .is_ok()
}

/// [`hash`] 를 블로킹 스레드에서.
pub async fn hash_async(password: String) -> String {
    tokio::task::spawn_blocking(move || hash(&password))
        .await
        .expect("argon2 hash task")
}

/// [`verify`] 를 블로킹 스레드에서.
pub async fn verify_async(hash: String, password: String) -> bool {
    tokio::task::spawn_blocking(move || verify(&hash, &password))
        .await
        .expect("argon2 verify task")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phc_format_matches_node_argon2_defaults() {
        let h = hash("correct horse");
        let parts: Vec<&str> = h.split('$').collect();
        // ["", "argon2id", "v=19", "m=65536,t=3,p=4", salt, hash]
        assert_eq!(parts.len(), 6, "{h}");
        assert_eq!(parts[1], "argon2id");
        assert_eq!(parts[2], "v=19");
        assert_eq!(parts[3], "m=65536,t=3,p=4");
        assert_eq!(parts[4].len(), 22, "16-byte salt, unpadded b64");
        assert_eq!(parts[5].len(), 43, "32-byte hash, unpadded b64");
        assert!(
            !parts[4].contains('=') && !parts[5].contains('='),
            "no padding"
        );
    }

    #[test]
    fn verify_roundtrip_and_wrong_password() {
        let h = hash("correct horse");
        assert!(verify(&h, "correct horse"));
        assert!(!verify(&h, "correct horsf"));
        assert!(!verify(&h, ""));
    }

    #[test]
    fn salt_is_random() {
        assert_ne!(hash("same"), hash("same"));
    }

    #[test]
    fn deterministic_with_fixed_salt() {
        let salt = [7u8; SALT_LEN];
        let a = hash_with_salt("pw", &salt);
        assert_eq!(a, hash_with_salt("pw", &salt));
        assert!(
            a.starts_with("$argon2id$v=19$m=65536,t=3,p=4$BwcHBwcHBwcHBwcHBwcHBw$"),
            "{a}"
        );
    }

    /// 해시에 적힌 변수로 검증한다(node-argon2 `verify` 와 같다) — 다른 변수로 만든 해시도 통과해야 한다.
    #[test]
    fn verify_uses_params_from_hash() {
        let params = Params::new(1024, 1, 1, Some(32)).unwrap();
        let cheap = Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_with_salt(b"pw", &[1u8; 16])
            .unwrap()
            .to_string();
        assert!(cheap.contains("$m=1024,t=1,p=1$"), "{cheap}");
        assert!(verify(&cheap, "pw"));
        assert!(!verify(&cheap, "px"));
    }

    /// node-argon2 0.41.1 `argon2.hash('correct horse battery staple')`(기본값, TS 와 같은 호출) 이 실제로 만든 해시.
    /// 시험용 문자열이라 비밀이 아니다. TS 가 저장한 해시를 Rust 가 검증할 수 있다는 고정 증거.
    const NODE_ARGON2_VECTOR: &str = "$argon2id$v=19$m=65536,t=3,p=4$Ra25GV2EygyvSHism6QUVg$wEKL9X33N8AfCrZbDHExMD4fpIWTXVPs/Xm8JPX1ogE";

    #[test]
    fn verifies_real_node_argon2_hash() {
        assert!(verify(NODE_ARGON2_VECTOR, "correct horse battery staple"));
        assert!(!verify(NODE_ARGON2_VECTOR, "correct horse battery stapl"));
        assert!(!verify(NODE_ARGON2_VECTOR, "Correct horse battery staple"));
        assert!(!verify(NODE_ARGON2_VECTOR, ""));
    }

    #[test]
    fn malformed_hash_is_false() {
        assert!(!verify("not-a-hash", "pw"));
        assert!(!verify("", "pw"));
    }

    #[tokio::test]
    async fn async_wrappers() {
        let h = hash_async("pw".into()).await;
        assert!(verify_async(h, "pw".into()).await);
    }
}

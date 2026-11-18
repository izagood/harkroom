//! TS `secretBox.ts`(v1 봉투, 065) — 서버가 원문을 다시 읽어야 하는 자동화 웹훅 비밀. 키는 `HARKROOM_SECRET_KEY` 한 줄을
//! sha256 으로 32바이트로 늘린 것이고 AAD 가 없다. 형식: `v1.<iv b64>.<tag b64>.<ciphertext b64>`.
//! v2(비밀 보관소)와는 다른 봉투다 — [`super::keyring`] 참고.
use std::fmt;

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

pub(crate) const SECRET_KEY_ENV: &str = "HARKROOM_SECRET_KEY";

const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

pub(crate) struct SecretBox {
    key: Zeroizing<[u8; 32]>,
}

impl fmt::Debug for SecretBox {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBox(<redacted>)")
    }
}

impl SecretBox {
    /// TS `createSecretBox` — 앞뒤 공백을 뗀 값이 비면 None(꺼짐).
    pub(crate) fn new(raw_key: Option<&str>) -> Option<Self> {
        let t = raw_key.map(super::js::trim).filter(|t| !t.is_empty())?;
        let digest = Sha256::digest(t.as_bytes());
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&digest);
        Some(Self { key })
    }

    #[allow(dead_code)] // 자동화 웹훅 라우트를 옮기는 PR 에서 기동이 부른다.
    pub(crate) fn from_env() -> Option<Self> {
        let raw = Zeroizing::new(std::env::var(SECRET_KEY_ENV).ok()?);
        Self::new(Some(raw.as_str()))
    }

    #[allow(dead_code)] // 자동화 웹훅 비밀을 봉인하는 라우트(이전 대기)가 쓴다.
    pub(crate) fn seal(&self, plain: &str) -> String {
        let mut iv = [0u8; IV_LEN];
        getrandom::fill(&mut iv).expect("os random");
        self.seal_with(plain, &iv)
    }

    pub(crate) fn seal_with(&self, plain: &str, iv: &[u8; IV_LEN]) -> String {
        let cipher = Aes256Gcm::new_from_slice(&self.key[..]).expect("32-byte key");
        let nonce = Nonce::try_from(&iv[..]).expect("12-byte nonce");
        let mut buf = Zeroizing::new(plain.as_bytes().to_vec());
        let tag = cipher
            .encrypt_inout_detached(&nonce, b"", buf.as_mut_slice().into())
            .expect("AES-GCM encrypt");
        [
            "v1".to_owned(),
            STANDARD.encode(iv),
            STANDARD.encode(tag.as_slice()),
            STANDARD.encode(buf.as_slice()),
        ]
        .join(".")
    }

    /// TS `open` — 형식·키·값이 맞지 않으면 None(던지지 않는다). 원문이 UTF-8 이 아니면 TS 는 U+FFFD 로 바꾸지만
    /// 봉인은 언제나 문자열에서 오므로 여기서는 None 으로 거절한다.
    pub(crate) fn open(&self, sealed: &str) -> Option<Zeroizing<String>> {
        let mut parts = sealed.split('.');
        let (v, iv, tag, ct) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        // TS 는 `split('.')` 의 앞 넷만 본다(뒤 칸은 무시).
        if v != "v1" || iv.is_empty() || tag.is_empty() || ct.is_empty() {
            return None;
        }
        let iv = STANDARD.decode(iv).ok()?;
        let tag = STANDARD.decode(tag).ok()?;
        if iv.len() != IV_LEN || tag.len() != TAG_LEN {
            return None;
        }
        let mut buf = Zeroizing::new(STANDARD.decode(ct).ok()?);
        let cipher = Aes256Gcm::new_from_slice(&self.key[..]).ok()?;
        let nonce = Nonce::try_from(&iv[..]).ok()?;
        let tag = Tag::try_from(&tag[..]).ok()?;
        if cipher
            .decrypt_inout_detached(&nonce, b"", buf.as_mut_slice().into(), &tag)
            .is_err()
        {
            buf.zeroize();
            return None;
        }
        let bytes = std::mem::take(&mut *buf);
        match String::from_utf8(bytes) {
            Ok(s) => Some(Zeroizing::new(s)),
            Err(e) => {
                let mut b = e.into_bytes();
                b.zeroize();
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// node `crypto` 로 TS `secretBox.ts` 와 같은 절차(sha256 키·iv 0x22×12)로 만든 값.
    const TS_V1: &str = "v1.IiIiIiIiIiIiIiIi.eTAeJU7rCbNBYqXLpCrskQ==.AmmMj4ZK9KeaVZWySSmgzQ==";

    fn sb() -> SecretBox {
        SecretBox::new(Some("  my webhook key\n")).expect("box")
    }

    #[test]
    fn opens_ts_ciphertext() {
        assert_eq!(
            sb().open(TS_V1).as_deref().map(String::as_str),
            Some("whsec_abc 비밀")
        );
    }

    #[test]
    fn seals_same_bytes_as_ts() {
        assert_eq!(sb().seal_with("whsec_abc 비밀", &[0x22; 12]), TS_V1);
    }

    #[test]
    fn round_trip_random_iv() {
        let b = sb();
        let s = b.seal("x");
        assert_eq!(b.open(&s).as_deref().map(String::as_str), Some("x"));
    }

    #[test]
    fn rejects_wrong_key_and_bad_shapes() {
        let other = SecretBox::new(Some("other")).expect("box");
        assert!(other.open(TS_V1).is_none());
        assert!(sb().open("v2.a.b.c").is_none());
        assert!(sb().open("v1.IiIi.eTAeJU7rCbNBYqXLpCrskQ==.AmmM").is_none());
        assert!(sb().open("v1..x.y").is_none());
        assert!(SecretBox::new(Some("   ")).is_none());
        assert!(SecretBox::new(None).is_none());
    }
}

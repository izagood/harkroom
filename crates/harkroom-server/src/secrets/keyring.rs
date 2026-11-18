//! v2 봉투 열기 — TS `secretKeyring.ts` 의 `parseKey`·`loadSecretKeys`·`createSecretKeyring(...).open`·`keyCheckValue`.
//!
//! 형식: `v2.<kid>.<salt b64>.<iv b64>.<tag b64>.<ct b64>`. 키 = HKDF-SHA256(KEK, salt, info=AAD) 32바이트,
//! AAD = `harkroom-secret-v2|<secretId>|<version>|<kind>|<kid>`, AES-256-GCM.
//!
//! 봉인(seal)은 옮기지 않는다 — Rust 는 열기만 한다. 칸 길이는 TS 와 같이 seal 이 쓰는 그대로만 받는다(salt 16·iv 12·
//! tag 16바이트). TS 보다 엄격한 곳은 하나(「의도된 차이」 b): 봉투 칸의 base64 는 표준 알파벳·패딩 있음만 받는다 — Node 디코더는
//! url-safe·패딩 없음·잡문자를 넘긴다. TS 가 만든 봉투는 언제나 표준 꼴이라 결과가 갈리지 않는다.
//!
//! 키 파일의 base64 는 TS 와 같게 읽는다(버려지는 끝 비트가 켜져 있어도 받는다) — 키를 받는지 마는지가 갈리면 기동이 갈린다.
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine as _;
use base64::alphabet;
use base64::engine::{GeneralPurpose, GeneralPurposeConfig, general_purpose::STANDARD};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2_011::Sha256;
use zeroize::{Zeroize, Zeroizing};

pub(crate) const KEYS_DIR_ENV: &str = "HARKROOM_SECRET_KEYS_DIR";
pub(crate) const ACTIVE_KID_ENV: &str = "HARKROOM_SECRET_KEY_ID";

const SALT_LEN: usize = 16;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// 마스터 키 32바이트. 힙에 두고(옮길 때 스택 사본이 남지 않게) drop 하면 지운다. `Debug` 는 가린다.
pub(crate) struct MasterKey(Box<Zeroizing<[u8; 32]>>);

impl MasterKey {
    fn zeroed() -> Self {
        Self(Box::new(Zeroizing::new([0u8; 32])))
    }
    fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

/// 연 비밀 값. drop 하면 지운다. `Debug` 는 가리고 `Clone`·`Display`·직렬화는 없다.
pub(crate) struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    #[cfg(test)]
    pub(crate) fn from_vec(v: Vec<u8>) -> Self {
        Self(Zeroizing::new(v))
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBytes(<redacted>)")
    }
}

/// TS `SecretAad`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SecretAad<'a> {
    pub secret_id: &'a str,
    pub version: i64,
    pub kind: SecretKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SecretKind {
    Text,
    File,
}

impl SecretKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::File => "file",
        }
    }
}

/// 키를 읽거나 키링을 세우다 난 오류. 글귀에는 파일 이름·kid 만 싣는다 — 파일 내용·키 바이트는 싣지 않는다.
#[derive(Debug)]
pub(crate) enum KeyError {
    /// 디렉터리·파일을 읽지 못함(없는 경로 포함).
    Io {
        file: Option<String>,
        kind: io::ErrorKind,
    },
    /// UTF-8 이 아닌 파일 이름(어느 kid 인지 정할 수 없다).
    BadFileName,
    /// 점으로 시작하지 않는 하위 디렉터리.
    NotAFile { file: String },
    /// 32바이트 키(hex 64자·base64 44자)가 아님.
    BadKeyFile { file: String },
    /// 점 파일 말고는 키 파일이 없음.
    NoKeys,
    /// 키가 둘 이상인데 활성 kid 를 정하지 않음.
    NeedActiveKid,
    /// 활성 kid 의 키가 없음.
    ActiveMissing { kid: String },
    /// kid 가 `^[a-z0-9][a-z0-9_-]{0,31}$` 가 아님.
    BadKid { kid: String },
}

impl KeyError {
    /// 골든·로그에서 갈래를 가르는 짧은 이름.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Io {
                kind: io::ErrorKind::NotFound,
                ..
            } => "io_not_found",
            Self::Io {
                kind: io::ErrorKind::IsADirectory,
                ..
            } => "not_a_file",
            Self::Io { .. } => "io",
            Self::BadFileName => "bad_file_name",
            Self::NotAFile { .. } => "not_a_file",
            Self::BadKeyFile { .. } => "bad_key_file",
            Self::NoKeys => "no_keys",
            Self::NeedActiveKid => "need_active_kid",
            Self::ActiveMissing { .. } => "active_missing",
            Self::BadKid { .. } => "bad_kid",
        }
    }
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                file: Some(file),
                kind,
            } => write!(f, "{KEYS_DIR_ENV}/{file}: read failed ({kind})"),
            Self::Io { file: None, kind } => write!(f, "{KEYS_DIR_ENV}: read failed ({kind})"),
            Self::BadFileName => write!(f, "{KEYS_DIR_ENV}: a file name is not UTF-8"),
            Self::NotAFile { file } => write!(f, "{KEYS_DIR_ENV}/{file}: is a directory"),
            Self::BadKeyFile { file } => {
                write!(
                    f,
                    "{KEYS_DIR_ENV}/{file}: not a 32-byte key (base64 44 chars or hex 64 chars)"
                )
            }
            Self::NoKeys => write!(f, "{KEYS_DIR_ENV}: no key files"),
            Self::NeedActiveKid => write!(
                f,
                "more than one key: set {ACTIVE_KID_ENV} to the active kid"
            ),
            Self::ActiveMissing { kid } => {
                write!(f, "secret keyring: no key for active kid '{kid}'")
            }
            Self::BadKid { kid } => write!(
                f,
                "secret keyring: kid '{kid}' must be [a-z0-9_-], at most 32 chars"
            ),
        }
    }
}

impl std::error::Error for KeyError {}

/// 키 파일의 base64 — TS `Buffer.from(t, 'base64')` 처럼 버려지는 끝 비트를 따지지 않는다(앞의 정규식이 꼴은 이미 거른다).
const KEY_B64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

/// TS `parseKey` — 앞뒤 공백(JS trim)을 무시하고 hex 64자 또는 base64 44자(끝 `=` 하나)인 정확히 32바이트.
pub(crate) fn parse_key(raw: &str) -> Option<MasterKey> {
    let t = super::js::trim(raw);
    let mut key = MasterKey::zeroed();
    if t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode_to_slice(t, &mut key.0[..]).ok()?;
        return Some(key);
    }
    let b = t.as_bytes();
    if b.len() == 44
        && b[43] == b'='
        && b[..43]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
    {
        // 44자는 많아야 33바이트로 풀린다 — 넉넉한 칸에 풀어 32바이트인지 본다. 칸도 지운다.
        let mut buf = Zeroizing::new([0u8; 48]);
        let n = KEY_B64.decode_slice(t, &mut buf[..]).ok()?;
        if n != 32 {
            return None;
        }
        key.0.copy_from_slice(&buf[..32]);
        return Some(key);
    }
    None
}

/// TS `keyCheckValue` — HMAC-SHA256(key, "harkroom-kcv-v1") 의 앞 16바이트.
pub(crate) fn key_check_value(key: &MasterKey) -> [u8; 16] {
    let mut mac = <Hmac<Sha256>>::new_from_slice(key.bytes()).expect("HMAC accepts any key length");
    mac.update(b"harkroom-kcv-v1");
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// TS `LoadedSecretKeys`.
pub(crate) struct LoadedSecretKeys {
    pub keys: Vec<(String, MasterKey)>,
    pub active_kid: String,
}

impl fmt::Debug for LoadedSecretKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoadedSecretKeys")
            .field(
                "kids",
                &self
                    .keys
                    .iter()
                    .map(|(k, _)| k.as_str())
                    .collect::<Vec<_>>(),
            )
            .field("active_kid", &self.active_kid)
            .finish()
    }
}

/// env 로 [`load_secret_keys`].
#[allow(dead_code)] // 붙이는 PR(C5e-2)에서 기동이 부른다.
pub(crate) fn load_secret_keys_from_env() -> Result<Option<LoadedSecretKeys>, KeyError> {
    let dir = std::env::var(KEYS_DIR_ENV).ok();
    let active = std::env::var(ACTIVE_KID_ENV).ok();
    load_secret_keys(dir.as_deref(), active.as_deref())
}

/// TS `loadSecretKeys`. env 값이 없거나 공백이면 `Ok(None)`(보관소 꺼짐). 지정했는데 읽을 수 없거나 키가 잘못됐으면 오류.
/// 점으로 시작하는 이름(k8s 볼륨의 `..data` 등)은 건너뛴다. 심링크는 따라간다. UTF-8 이 아닌 이름·하위 디렉터리는 오류.
pub(crate) fn load_secret_keys(
    dir: Option<&str>,
    active_kid: Option<&str>,
) -> Result<Option<LoadedSecretKeys>, KeyError> {
    let Some(d) = dir.map(super::js::trim).filter(|d| !d.is_empty()) else {
        return Ok(None);
    };
    fn io_err(file: Option<&str>) -> impl FnOnce(io::Error) -> KeyError + '_ {
        move |e| KeyError::Io {
            file: file.map(str::to_owned),
            kind: e.kind(),
        }
    }
    let mut keys: Vec<(String, MasterKey)> = Vec::new();
    for entry in fs::read_dir(Path::new(d)).map_err(io_err(None))? {
        let entry = entry.map_err(io_err(None))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| KeyError::BadFileName)?;
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // `metadata` 는 심링크를 따라간다.
        if fs::metadata(&path).map_err(io_err(Some(&name)))?.is_dir() {
            return Err(KeyError::NotAFile { file: name });
        }
        let raw = Zeroizing::new(fs::read(&path).map_err(io_err(Some(&name)))?);
        let key = std::str::from_utf8(&raw).ok().and_then(parse_key);
        let Some(key) = key else {
            return Err(KeyError::BadKeyFile { file: name });
        };
        keys.push((name, key));
    }
    if keys.is_empty() {
        return Err(KeyError::NoKeys);
    }
    let kid = match active_kid.map(super::js::trim).filter(|k| !k.is_empty()) {
        Some(k) => k.to_owned(),
        None if keys.len() == 1 => keys[0].0.clone(),
        None => return Err(KeyError::NeedActiveKid),
    };
    if !keys.iter().any(|(k, _)| *k == kid) {
        return Err(KeyError::ActiveMissing { kid });
    }
    Ok(Some(LoadedSecretKeys {
        keys,
        active_kid: kid,
    }))
}

/// `^[a-z0-9][a-z0-9_-]{0,31}$`
fn valid_kid(kid: &str) -> bool {
    let b = kid.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// TS `SecretKeyring`(열기만). 프로세스가 끝날 때까지 들고 있고, drop 하면 키를 지운다.
pub(crate) struct SecretKeyring {
    keys: Vec<(String, MasterKey)>,
    active_kid: String,
}

impl fmt::Debug for SecretKeyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretKeyring")
            .field("kids", &self.kids().collect::<Vec<_>>())
            .field("active_kid", &self.active_kid)
            .finish()
    }
}

impl SecretKeyring {
    /// TS `createSecretKeyring`.
    pub(crate) fn new(loaded: LoadedSecretKeys) -> Result<Self, KeyError> {
        if let Some((kid, _)) = loaded.keys.iter().find(|(k, _)| !valid_kid(k)) {
            return Err(KeyError::BadKid { kid: kid.clone() });
        }
        if !loaded.keys.iter().any(|(k, _)| *k == loaded.active_kid) {
            return Err(KeyError::ActiveMissing {
                kid: loaded.active_kid,
            });
        }
        Ok(Self {
            keys: loaded.keys,
            active_kid: loaded.active_kid,
        })
    }

    #[allow(dead_code)] // 붙이는 PR 에서 목록의 keyLost 판정이 쓴다.
    pub(crate) fn active_kid(&self) -> &str {
        &self.active_kid
    }

    /// 키 묶음을 돌려받는다 — 기동 확인([`super::verify`])이 kid 하나짜리 키링으로 풀어 본 뒤 키를 되찾는 데 쓴다.
    pub(crate) fn into_keys(self) -> Vec<(String, MasterKey)> {
        self.keys
    }

    pub(crate) fn kids(&self) -> impl Iterator<Item = &str> {
        self.keys.iter().map(|(k, _)| k.as_str())
    }

    /// TS `open`. 키가 없거나 AAD 가 다르거나 값이 망가졌으면 `None` — 갈래를 밖에 알리지 않는다.
    pub(crate) fn open(&self, sealed: &str, aad: &SecretAad<'_>) -> Option<SecretBytes> {
        let parts: Vec<&str> = sealed.split('.').collect();
        let [v, kid, salt, iv, tag, ct] = parts[..] else {
            return None;
        };
        if v != "v2" {
            return None;
        }
        let (_, kek) = self.keys.iter().find(|(k, _)| k == kid)?;
        let salt = decode_exact::<SALT_LEN>(salt)?;
        let iv = decode_exact::<IV_LEN>(iv)?;
        let tag = decode_exact::<TAG_LEN>(tag)?;
        // ct 를 담은 칸에서 그대로 푼다(decrypt_inout_detached = 옛 decrypt_in_place_detached). 실패하면 칸을 지우고 None.
        let mut buf = Zeroizing::new(STANDARD.decode(ct).ok()?);
        let aad_bytes = format!(
            "harkroom-secret-v2|{}|{}|{}|{}",
            aad.secret_id,
            aad.version,
            aad.kind.as_str(),
            kid
        );
        let mut okm = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(&salt[..]), kek.bytes())
            .expand(aad_bytes.as_bytes(), &mut okm[..])
            .ok()?;
        let cipher = Aes256Gcm::new_from_slice(&okm[..]).ok()?;
        let nonce = Nonce::try_from(&iv[..]).ok()?;
        let tag = Tag::try_from(&tag[..]).ok()?;
        match cipher.decrypt_inout_detached(
            &nonce,
            aad_bytes.as_bytes(),
            buf.as_mut_slice().into(),
            &tag,
        ) {
            Ok(()) => Some(SecretBytes(buf)),
            Err(_) => {
                buf.zeroize();
                None
            }
        }
    }
}

/// 표준 base64(패딩 있음)를 정확히 N 바이트로. 다른 길이·꼴이면 None.
impl SecretKeyring {
    /// TS `seal` — 활성 kid 로 봉인한다. salt 16·iv 12바이트는 OS 난수.
    pub(crate) fn seal(&self, plain: &[u8], aad: &SecretAad<'_>) -> String {
        let mut salt = [0u8; SALT_LEN];
        let mut iv = [0u8; IV_LEN];
        getrandom::fill(&mut salt).expect("os random");
        getrandom::fill(&mut iv).expect("os random");
        self.seal_with(plain, aad, &salt, &iv)
    }

    /// 난수를 밖에서 받는 봉인 — 시험이 TS 와 같은 바이트를 대조하는 데 쓴다.
    pub(crate) fn seal_with(
        &self,
        plain: &[u8],
        aad: &SecretAad<'_>,
        salt: &[u8; SALT_LEN],
        iv: &[u8; IV_LEN],
    ) -> String {
        let kid = self.active_kid.as_str();
        let (_, kek) = self
            .keys
            .iter()
            .find(|(k, _)| k == kid)
            .expect("active kid checked in new()");
        let aad_bytes = format!(
            "harkroom-secret-v2|{}|{}|{}|{}",
            aad.secret_id,
            aad.version,
            aad.kind.as_str(),
            kid
        );
        let mut okm = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(&salt[..]), kek.bytes())
            .expand(aad_bytes.as_bytes(), &mut okm[..])
            .expect("32 bytes is a valid HKDF-SHA256 length");
        let cipher = Aes256Gcm::new_from_slice(&okm[..]).expect("32-byte key");
        let nonce = Nonce::try_from(&iv[..]).expect("12-byte nonce");
        let mut buf = Zeroizing::new(plain.to_vec());
        let tag = cipher
            .encrypt_inout_detached(&nonce, aad_bytes.as_bytes(), buf.as_mut_slice().into())
            .expect("AES-GCM encrypt");
        [
            "v2".to_owned(),
            kid.to_owned(),
            STANDARD.encode(salt),
            STANDARD.encode(iv),
            STANDARD.encode(tag.as_slice()),
            STANDARD.encode(buf.as_slice()),
        ]
        .join(".")
    }
}

fn decode_exact<const N: usize>(s: &str) -> Option<Zeroizing<[u8; N]>> {
    let v = Zeroizing::new(STANDARD.decode(s).ok()?);
    if v.len() != N {
        return None;
    }
    let mut out = Zeroizing::new([0u8; N]);
    out.copy_from_slice(&v);
    Some(out)
}

#[cfg(test)]
mod seal_tests {
    use super::*;

    /// node `crypto` 로 TS `secretKeyring.ts` 의 `seal` 과 같은 절차(KEK 0..31·kid k1·salt 0x11×16·iv 0x22×12)로 만든 값.
    const TS_V2: &str = "v2.k1.EREREREREREREREREREREQ==.IiIiIiIiIiIiIiIi.Knn2uQfjEt1Cwl02xIEsVA==.pzKjuPAZxmhomgbODmw=";
    const AAD: SecretAad<'static> = SecretAad {
        secret_id: "00000000-0000-4000-8000-000000000001",
        version: 3,
        kind: SecretKind::Text,
    };

    fn ring() -> SecretKeyring {
        let mut k = MasterKey::zeroed();
        for (i, b) in k.0.iter_mut().enumerate() {
            *b = i as u8;
        }
        SecretKeyring::new(LoadedSecretKeys {
            keys: vec![("k1".to_owned(), k)],
            active_kid: "k1".to_owned(),
        })
        .expect("ring")
    }

    #[test]
    fn seal_matches_ts_bytes() {
        assert_eq!(
            ring().seal_with("hunter2 비밀".as_bytes(), &AAD, &[0x11; 16], &[0x22; 12]),
            TS_V2
        );
    }

    #[test]
    fn opens_ts_and_round_trips() {
        let r = ring();
        let got = r.open(TS_V2, &AAD).expect("open");
        assert_eq!(got.as_bytes(), "hunter2 비밀".as_bytes());
        let s = r.seal(b"abc", &AAD);
        assert_eq!(r.open(&s, &AAD).expect("open").as_bytes(), b"abc");
        let other = SecretAad { version: 4, ..AAD };
        assert!(r.open(&s, &other).is_none());
    }
}

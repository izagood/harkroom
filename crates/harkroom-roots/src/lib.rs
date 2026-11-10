//! 커뮤니티마다 오퍼레이터를 따로 두는 구조의 **뿌리 규칙**과 `operators.json` 색인 형식(경계 P5, S1·Rust 전환).
//!
//! 정본은 `packages/shared/src/operatorRoots.ts` 다. 지금 같은 규칙이 데스크톱 Tauri(`src-tauri/src/community_root.rs`)에
//! 손으로 한 벌 더 있다 — 이 crate 는 Rust 오퍼레이터(S2)와 Tauri 가 함께 쓸 한 벌이다. 아직 어디에도 연결하지 않는다.
//! 정본과 같은지는 `golden/roots.json`(TS 시험 `packages/shared/test/protoGolden.test.ts` 가 씀)으로 본다.
//!
//! ```text
//! <home>/.harkroom-agent/c/<sha256(baseUrl 끝 / 걷음) 앞 8자>/operator/operator-v1.sock
//! ```
//!
//! 오퍼레이터는 **여러 개 뜬다**(커뮤니티 하나 = 뿌리 하나 = 프로세스 하나). 그래서 이 crate 는 파일을 읽고 쓰지 않는
//! 순수 함수만 둔다 — 색인 파일의 잠금·쓰기 규칙은 오퍼레이터를 옮길 때(S2) 계약 시험과 함께 정한다.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// 앱 데이터 디렉터리 아래 색인 파일 이름.
pub const OPERATOR_ROOTS_INDEX_FILE: &str = "operators.json";
/// unix 소켓 경로 상한(바이트). 커널 상한(macOS 104·리눅스 108)보다 여유를 둔다.
pub const SOCKET_PATH_LIMIT_BYTES: usize = 100;
pub const COMMUNITY_ROOT_HASH_LENGTH: usize = 8;
/// 8자 해시가 다른 커뮤니티의 뿌리와 겹칠 때 쓰는 길이.
pub const COMMUNITY_ROOT_HASH_FALLBACK_LENGTH: usize = 16;
/// 오퍼레이터 소켓 프로토콜 판(`DAEMON_PROTOCOL_VERSION`) — 소켓 파일 이름에 들어간다.
pub const DAEMON_PROTOCOL_VERSION: u32 = 1;

/// `operators.json` 의 한 줄.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorRootEntry {
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy: Option<bool>,
}

/// `operators.json` 전체. 키는 `community_root_key(baseUrl)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorRootsIndex {
    pub version: u32,
    pub communities: BTreeMap<String, OperatorRootEntry>,
}

impl Default for OperatorRootsIndex {
    fn default() -> Self {
        Self {
            version: 1,
            communities: BTreeMap::new(),
        }
    }
}

/// 색인 키 = baseUrl 의 끝 `/` 를 모두 걷은 것.
pub fn community_root_key(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

/// sha256(키) 16진수 앞 `len` 자.
pub fn community_root_hash(base_url: &str, len: usize) -> String {
    let digest = Sha256::digest(community_root_key(base_url).as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..len.min(hex.len())].to_string()
}

pub fn computed_community_root(home: &str, base_url: &str, len: usize) -> String {
    join(&[
        home,
        ".harkroom-agent",
        "c",
        &community_root_hash(base_url, len),
    ])
}

/// 뿌리 아래 오퍼레이터 소켓·pid·토큰 자리(`daemonEndpointPaths`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointPaths {
    pub dir: String,
    pub socket_path: String,
    pub pid_path: String,
    pub token_path: String,
}

pub fn daemon_endpoint_paths(root: &str) -> EndpointPaths {
    let dir = join(&[root, "operator"]);
    let base = format!("operator-v{DAEMON_PROTOCOL_VERSION}");
    EndpointPaths {
        socket_path: join(&[&dir, &format!("{base}.sock")]),
        pid_path: join(&[&dir, &format!("{base}.pid")]),
        token_path: join(&[&dir, &format!("{base}.token")]),
        dir,
    }
}

/// `resolveCommunityRoot` 의 결과.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CommunityRootResolution {
    Ok {
        ok: True,
        root: String,
        #[serde(rename = "socketPath")]
        socket_path: String,
        #[serde(rename = "fromIndex")]
        from_index: bool,
    },
    Refused(Refusal),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum Refusal {
    SocketPathTooLong {
        ok: False,
        root: String,
        #[serde(rename = "socketPath")]
        socket_path: String,
        bytes: usize,
    },
    RootTaken {
        ok: False,
        root: String,
        #[serde(rename = "takenBy")]
        taken_by: String,
    },
}

/// JSON `true` 만 받는 표지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "bool", into = "bool")]
pub struct True;
impl TryFrom<bool> for True {
    type Error = &'static str;
    fn try_from(v: bool) -> Result<Self, Self::Error> {
        if v { Ok(True) } else { Err("expected true") }
    }
}
impl From<True> for bool {
    fn from(_: True) -> bool {
        true
    }
}
/// JSON `false` 만 받는 표지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "bool", into = "bool")]
pub struct False;
impl TryFrom<bool> for False {
    type Error = &'static str;
    fn try_from(v: bool) -> Result<Self, Self::Error> {
        if v { Err("expected false") } else { Ok(False) }
    }
}
impl From<False> for bool {
    fn from(_: False) -> bool {
        false
    }
}

/// 이 baseUrl 의 뿌리를 정한다. 색인에 있으면 그 자리, 없으면 계산한 자리 — 계산한 자리를 다른 커뮤니티가 쓰면 16자로 늘린다.
pub fn resolve_community_root(
    home: &str,
    base_url: &str,
    index: &OperatorRootsIndex,
) -> CommunityRootResolution {
    let key = community_root_key(base_url);
    let entry = index.communities.get(key);
    let owner_of = |r: &str| -> Option<String> {
        index
            .communities
            .iter()
            .find(|(k, e)| k.as_str() != key && same_root(&e.root, r))
            .map(|(k, _)| k.clone())
    };
    let mut root = match entry {
        Some(e) => e.root.clone(),
        None => computed_community_root(home, key, COMMUNITY_ROOT_HASH_LENGTH),
    };
    if entry.is_none() && owner_of(&root).is_some() {
        let longer = computed_community_root(home, key, COMMUNITY_ROOT_HASH_FALLBACK_LENGTH);
        if let Some(taken_by) = owner_of(&longer) {
            return CommunityRootResolution::Refused(Refusal::RootTaken {
                ok: False,
                root: longer,
                taken_by,
            });
        }
        root = longer;
    }
    let socket_path = daemon_endpoint_paths(&root).socket_path;
    let bytes = socket_path.len();
    if bytes > SOCKET_PATH_LIMIT_BYTES {
        return CommunityRootResolution::Refused(Refusal::SocketPathTooLong {
            ok: False,
            root,
            socket_path,
            bytes,
        });
    }
    CommunityRootResolution::Ok {
        ok: True,
        root,
        socket_path,
        from_index: entry.is_some(),
    }
}

/// 두 경로가 같은 자리인가 — node `path.resolve` 처럼 `.`·`..`·겹친 `/` 를 글자로만 접어 비교한다(디스크를 보지 않는다).
pub fn same_root(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}

fn normalize(p: &str) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in Path::new(p).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// node `path.join` 과 같게 `/` 로 잇는다(겹친 `/` 는 하나로).
fn join(parts: &[&str]) -> String {
    let mut s = String::new();
    for (i, p) in parts.iter().enumerate() {
        if i == 0 {
            s.push_str(p.trim_end_matches('/'));
        } else {
            s.push('/');
            s.push_str(p.trim_matches('/'));
        }
    }
    s
}

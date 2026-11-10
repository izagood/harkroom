//! 커뮤니티 뿌리 하나의 소켓 이름을 잡는다(S2 A2). 정본은 `packages/shared/src/daemonEndpoint.ts::claimDaemonEndpoint`.
//!
//! 오퍼레이터는 커뮤니티마다 하나씩 뜬다 — 뿌리는 `harkroom-roots` 가 정하고(`operator/operator-v1.sock`), 같은 뿌리에는
//! 하나만 산다. 흐름은 TS 와 같다: 임시 이름(`.p<hex>`)으로 bind → 0600 → `link(임시, 정규)` → 이기면 임시 이름을 지우고
//! pid 기록·토큰(0600)을 쓴다. 정규 이름이 이미 있으면 붙어 본다 — 답하면 **점유**(물러난다), 거절되면 잔해라 지우고 다시.
//!
//! A2 가 아직 옮기지 않은 것: TS 의 ABA 판정(잔해를 지우는 사이 다른 오퍼레이터가 이름을 잡은 경우)과 하드링크 미지원
//! 폴백. 둘 다 이 Rust 판이 앱에 실리기(A4) 전에 계약 시험과 함께 옮긴다.
use harkroom_proto::p3::DaemonIdentity;
use harkroom_roots::{EndpointPaths, daemon_endpoint_paths};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

const MAX_CLAIM_ATTEMPTS: u32 = 3;

#[derive(Debug)]
pub enum ClaimOutcome {
    Claimed {
        listener: UnixListener,
        paths: EndpointPaths,
        token: String,
    },
    /// 살아 있는 오퍼레이터가 이 뿌리를 쓴다.
    Occupied { paths: EndpointPaths },
}

/// `/dev/urandom` 에서 `n` 바이트를 16진수로.
pub fn random_hex(n: usize) -> std::io::Result<String> {
    let mut b = vec![0u8; n];
    fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn write_private(path: &str, body: &[u8]) -> std::io::Result<()> {
    let tmp = format!("{path}.{}", random_hex(4)?);
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(body)?;
    f.sync_all()?;
    fs::rename(&tmp, path)
}

/// 뿌리 `root` 의 정규 소켓 이름을 잡는다. 이기면 듣는 소켓과 새 토큰을 돌려준다.
pub fn claim(root: &str, identity: &DaemonIdentity) -> std::io::Result<ClaimOutcome> {
    let paths = daemon_endpoint_paths(root);
    fs::create_dir_all(&paths.dir)?;
    fs::set_permissions(&paths.dir, fs::Permissions::from_mode(0o700))?;
    for _ in 0..MAX_CLAIM_ATTEMPTS {
        let temp = format!("{}/.p{}", paths.dir, random_hex(5)?);
        let listener = UnixListener::bind(&temp)?;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
        match fs::hard_link(&temp, &paths.socket_path) {
            Ok(()) => {
                let _ = fs::remove_file(&temp);
                let token = random_hex(32)?;
                let pid = serde_json::to_vec(&serde_json::json!({
                    "pid": identity.pid,
                    "startedAtMs": identity.started_at_ms,
                    "entryPath": identity.entry_path,
                    "appVersion": identity.app_version,
                    "launchNonce": identity.launch_nonce,
                }))
                .map_err(std::io::Error::other)?;
                if let Err(e) = write_private(&paths.pid_path, &pid)
                    .and_then(|()| write_private(&paths.token_path, token.as_bytes()))
                {
                    // 소켓만 남은 정규 이름은 아무도 서비스하지 않는 잔해다 — 되감는다.
                    let _ = fs::remove_file(&paths.socket_path);
                    return Err(e);
                }
                return Ok(ClaimOutcome::Claimed {
                    listener,
                    paths,
                    token,
                });
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                drop(listener);
                let _ = fs::remove_file(&temp);
                if UnixStream::connect(&paths.socket_path).is_ok() {
                    return Ok(ClaimOutcome::Occupied { paths });
                }
                // 붙지 않는다 — 죽은 오퍼레이터의 잔해다. 치우고 다시.
                if Path::new(&paths.socket_path).exists() {
                    fs::remove_file(&paths.socket_path)?;
                }
            }
            Err(e) => {
                drop(listener);
                let _ = fs::remove_file(&temp);
                return Err(e);
            }
        }
    }
    Err(std::io::Error::other(format!(
        "엔드포인트 판정 불가: {} — {MAX_CLAIM_ATTEMPTS}회 시도했다",
        paths.socket_path
    )))
}

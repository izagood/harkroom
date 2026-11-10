//! 커뮤니티 뿌리 하나의 소켓 이름을 잡는다(S2 A2). 정본은 `packages/shared/src/daemonEndpoint.ts::claimDaemonEndpoint`.
//!
//! 오퍼레이터는 커뮤니티마다 하나씩 뜬다 — 뿌리는 `harkroom-roots` 가 정하고(`operator/operator-v1.sock`), 같은 뿌리에는
//! 하나만 산다. 흐름은 TS 와 같다: 임시 이름(`.p<hex>`)으로 bind → 0600 → `link(임시, 정규)` → 이기면 임시 이름을 지우고
//! pid 기록·토큰(0600)을 쓴다. 정규 이름이 이미 있으면 붙어 본다 — 답하면 **점유**(물러난다), 거절되면 잔해라 지우고 다시.
//!
//! 잔해 판정(A3a, security C1·C2)은 TS `tripleEvidenceSaysDead`·`reclaimSocketName` 과 같다:
//! inode 스냅샷 → connect → inode 스냅샷(바뀌었으면 ABA — 아무것도 지우지 않고 재시도) → 다시 connect →
//! pid 레코드의 프로세스가 죽었는가. 셋이 모두 서야 잔해다. connect 가 `ConnectionRefused`·`NotFound` 가 아닌
//! 이유로 실패하면(권한·자원 부족 등) 판정하지 않고 오류로 물러난다 — 살아 있는 오퍼레이터의 이름을 빼앗지 않는다.
//! 지울 때는 격리 이름으로 rename 한 뒤 inode 가 증거를 세운 그 파일인지 보고, 아니면 되돌린다.
//! 아직 옮기지 않은 것: 하드링크 미지원 파일시스템 폴백(macOS APFS 는 하드링크를 지원한다).
use harkroom_proto::p3::DaemonIdentity;
use harkroom_roots::{EndpointPaths, daemon_endpoint_paths};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};

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

/// connect 한 번의 결과(TS `probeSocket`). `Other` 는 잔해 판정에 쓰지 않는다(C1).
#[derive(Debug)]
pub enum Probe {
    Connected,
    Refused,
    Missing,
    Other(std::io::Error),
}

pub fn probe_socket(path: &str) -> Probe {
    // 소켓이 아닌 파일(보통 파일·심볼릭 링크 등)은 잔해가 아니다. Linux 는 이런 파일에 connect 하면 ECONNREFUSED 를
    // 돌려줘(macOS 는 다른 오류) 잔해로 읽힐 수 있으므로 connect 전에 lstat 으로 갈라 판정을 보류한다(C1).
    if let Ok(m) = fs::symlink_metadata(path)
        && !m.file_type().is_socket()
    {
        return Probe::Other(std::io::Error::new(
            ErrorKind::InvalidInput,
            "엔드포인트 이름이 소켓이 아니다",
        ));
    }
    match UnixStream::connect(path) {
        Ok(_) => Probe::Connected,
        Err(e) => match e.kind() {
            ErrorKind::ConnectionRefused => Probe::Refused,
            ErrorKind::NotFound => Probe::Missing,
            _ => Probe::Other(e),
        },
    }
}

type Inode = (u64, u64);

fn snapshot_inode(path: &str) -> Option<Inode> {
    fs::symlink_metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

/// `kill(pid, 0)`. EPERM 은 "있는데 내 것이 아니다"라 살아 있는 쪽으로 친다(TS `isProcessAlive`).
pub fn is_process_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: 신호 0 은 아무것도 보내지 않고 존재·권한만 묻는다.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn read_pid(pid_path: &str) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_slice(&fs::read(pid_path).ok()?).ok()?;
    v.get("pid")?.as_i64()
}

#[derive(Debug, PartialEq)]
enum Evidence {
    Alive,
    Retry,
    Dead(Option<Inode>),
}

fn usable(p: Probe) -> std::io::Result<Probe> {
    match p {
        // C1 — 권한·자원 부족 같은 오류는 "죽었다"는 증거가 아니다. 판정하지 않고 물러난다.
        Probe::Other(e) => Err(std::io::Error::new(
            e.kind(),
            format!("엔드포인트 판정 보류 — connect 가 잔해 신호가 아닌 오류로 실패했다: {e}"),
        )),
        p => Ok(p),
    }
}

/// 3중 증거(TS `tripleEvidenceSaysDead`). `Dead` 는 증거를 세운 파일의 inode 를 들고 온다.
fn triple_evidence(socket_path: &str, pid_path: &str) -> std::io::Result<Evidence> {
    let before = snapshot_inode(socket_path);
    match usable(probe_socket(socket_path))? {
        Probe::Connected => return Ok(Evidence::Alive),
        Probe::Missing => return Ok(Evidence::Retry),
        _ => {}
    }
    let after = snapshot_inode(socket_path);
    if before.is_none() || before != after {
        return Ok(Evidence::Retry); // ABA — 모은 증거는 이전 파일 것이다.
    }
    match usable(probe_socket(socket_path))? {
        Probe::Connected => return Ok(Evidence::Alive),
        Probe::Missing => return Ok(Evidence::Retry),
        _ => {}
    }
    if read_pid(pid_path).is_some_and(is_process_alive) {
        return Ok(Evidence::Alive);
    }
    Ok(Evidence::Dead(after))
}

/// 잔해로 판정된 정규 이름을 치운다(TS `reclaimSocketName`) — 격리 rename → inode 대조 → 지우거나 되돌린다.
fn reclaim_socket_name(socket_path: &str, evidenced: Option<Inode>) -> std::io::Result<()> {
    let hold = format!(
        "{socket_path}.hold-{}-{}",
        std::process::id(),
        random_hex(8)?
    );
    if fs::rename(socket_path, &hold).is_err() {
        return Ok(()); // 누가 먼저 치웠다.
    }
    if evidenced.is_some() && snapshot_inode(&hold) == evidenced {
        let _ = fs::remove_file(&hold);
        return Ok(());
    }
    eprintln!("엔드포인트: 격리한 소켓이 증거를 세운 파일이 아니다(ABA) — 되돌린다: {socket_path}");
    if fs::rename(&hold, socket_path).is_err() {
        let _ = fs::remove_file(&hold);
    }
    Ok(())
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
                match triple_evidence(&paths.socket_path, &paths.pid_path)? {
                    Evidence::Alive => return Ok(ClaimOutcome::Occupied { paths }),
                    // ABA 거나 이름이 이미 사라졌다 — 지우지 않고 다음 회차로.
                    Evidence::Retry => {}
                    Evidence::Dead(inode) => reclaim_socket_name(&paths.socket_path, inode)?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn dir() -> String {
        let d = format!("/tmp/hk-ep-{}", random_hex(4).unwrap());
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn stale_socket_without_pid_is_dead_and_reclaimed() {
        let d = dir();
        let sock = format!("{d}/s.sock");
        drop(UnixListener::bind(&sock).unwrap()); // 파일만 남는다
        let ev = triple_evidence(&sock, &format!("{d}/none.pid")).unwrap();
        let Evidence::Dead(ino) = ev else {
            panic!("{ev:?}")
        };
        reclaim_socket_name(&sock, ino).unwrap();
        assert!(!Path::new(&sock).exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn listening_socket_is_alive() {
        let d = dir();
        let sock = format!("{d}/s.sock");
        let _l = UnixListener::bind(&sock).unwrap();
        assert_eq!(
            triple_evidence(&sock, "/nonexistent").unwrap(),
            Evidence::Alive
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn refused_but_pid_alive_is_alive() {
        let d = dir();
        let sock = format!("{d}/s.sock");
        drop(UnixListener::bind(&sock).unwrap());
        let pid = format!("{d}/p.json");
        fs::write(&pid, format!("{{\"pid\":{}}}", std::process::id())).unwrap();
        assert_eq!(triple_evidence(&sock, &pid).unwrap(), Evidence::Alive);
        assert!(Path::new(&sock).exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_name_retries() {
        assert_eq!(
            triple_evidence("/tmp/hk-ep-none/x.sock", "/nonexistent").unwrap(),
            Evidence::Retry
        );
    }

    #[test]
    fn non_debris_connect_error_backs_off_without_deleting() {
        // 소켓이 아닌 보통 파일 — 잔해로 읽지 않는다(Linux connect 는 ECONNREFUSED 를 내므로 lstat 으로 먼저 거른다).
        let d = dir();
        let f = format!("{d}/s.sock");
        fs::write(&f, b"x").unwrap();
        let p = probe_socket(&f);
        assert!(matches!(p, Probe::Other(_)), "{p:?}");
        assert!(triple_evidence(&f, "/nonexistent").is_err());
        assert!(Path::new(&f).exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn reclaim_restores_when_inode_differs() {
        let d = dir();
        let sock = format!("{d}/s.sock");
        drop(UnixListener::bind(&sock).unwrap());
        let other = snapshot_inode(&sock).map(|(dev, ino)| (dev, ino + 1));
        reclaim_socket_name(&sock, other).unwrap();
        assert!(Path::new(&sock).exists(), "남의 것이면 되돌려야 한다");
        let leftovers = fs::read_dir(&d).unwrap().count();
        assert_eq!(leftovers, 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn pid_liveness() {
        assert!(is_process_alive(i64::from(std::process::id())));
        assert!(!is_process_alive(0));
        assert!(!is_process_alive(-1));
    }
}

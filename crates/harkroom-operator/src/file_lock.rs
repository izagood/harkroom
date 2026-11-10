//! `packages/operator/src/fileLock.ts`(P5, 격리 C안 P3)의 이식 — 같은 기계의 여러 오퍼레이터 프로세스가 한 파일을
//! 고칠 때 쓰는 배타 잠금. **TS 와 같은 잠금 파일을 번갈아 잡을 수 있어야 한다**(전환 동안 Node·Rust 오퍼레이터가 섞여
//! 돈다). 그래서 방식·파일 꼴을 글자까지 맞춘다:
//! - 잡기: `open(<lock>, O_CREAT|O_EXCL, 0600)` 에 `"<pid> <ms 시각> <무작위>\n"` 을 쓴다.
//! - 버려진 잠금: 주인 pid 가 죽었거나(`kill(pid,0)` = ESRCH) 시각이 `stale` 을 넘김. 내용이 깨졌으면 mtime 으로 잰다.
//! - 치우기·놓기: 옆 이름으로 rename 해 떼어 낸 뒤 내용이 기대와 같을 때만 지우고, 다르면 `link` 로 되돌린다.
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// TS `FILE_LOCK_STALE_MS`·`FILE_LOCK_TIMEOUT_MS` 와 같다.
pub const FILE_LOCK_STALE: Duration = Duration::from_secs(30);
pub const FILE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct FileLockOptions {
    pub stale: Duration,
    pub timeout: Duration,
    pub retry: Duration,
}

impl Default for FileLockOptions {
    fn default() -> Self {
        FileLockOptions {
            stale: FILE_LOCK_STALE,
            timeout: FILE_LOCK_TIMEOUT,
            retry: Duration::from_millis(50),
        }
    }
}

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

/// TS `processAlive`: `kill(pid, 0)` 이 되거나 EPERM 이면 살아 있다.
pub fn process_alive(pid: i32) -> bool {
    // SAFETY: 신호 0 은 아무것도 보내지 않고 대상의 존재·권한만 본다.
    if unsafe { kill(pid, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().kind() == io::ErrorKind::PermissionDenied
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 같은 pid 의 두 호출도 갈리게 붙이는 값(TS 의 randomUUID 자리) — 시각·카운터·주소로 만든다. 비밀이 아니라 구별용이다.
fn unique_token() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let local = 0u8;
    format!("{nanos:x}-{n:x}-{:x}", &local as *const u8 as usize)
}

/// 버려진 잠금이면 그 내용을 돌려준다(치울 때 같은 잠금인지 대조한다). 아니면 `None`.
fn stale_content(lock: &Path, now: u128, stale: Duration) -> Option<String> {
    let text = fs::read_to_string(lock).ok()?;
    let mtime = fs::metadata(lock).ok()?.modified().ok()?;
    let mtime_ms = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stale_ms = stale.as_millis();
    let mut parts = text.trim().split(' ');
    let pid = parts
        .next()
        .and_then(|p| p.parse::<i64>().ok())
        .filter(|p| *p > 0 && *p <= i32::MAX as i64);
    // TS 의 Number(atText) 는 소수도 받는다 — 유한한 수면 된다.
    let at = parts
        .next()
        .and_then(|a| a.parse::<f64>().ok())
        .filter(|a| a.is_finite());
    match (pid, at) {
        (Some(pid), Some(at)) => {
            let old = (now as f64) - at > stale_ms as f64;
            (!process_alive(pid as i32) || old).then_some(text)
        }
        _ => (now.saturating_sub(mtime_ms) > stale_ms).then_some(text),
    }
}

/// 잠금 파일이 아직 `expected` 그대로일 때만 지운다(TS `removeIfSame`). 지웠으면 true.
pub fn remove_if_same(lock: &Path, expected: &str) -> bool {
    let mut aside = lock.as_os_str().to_owned();
    aside.push(format!(".{}.{}.reap", std::process::id(), unique_token()));
    let aside = std::path::PathBuf::from(aside);
    if fs::rename(lock, &aside).is_err() {
        return false;
    }
    let text = fs::read_to_string(&aside).unwrap_or_default();
    if text == expected {
        let _ = fs::remove_file(&aside);
        return true;
    }
    let _ = fs::hard_link(&aside, lock); // 그 사이 새 잠금이 섰으면 되돌리지 못한다
    let _ = fs::remove_file(&aside);
    false
}

/// `lock` 을 잡고 `f` 를 돌린 뒤 놓는다. `f` 가 패닉해도 놓는다. 시한 안에 못 잡으면 `TimedOut`.
pub fn with_file_lock<T>(
    lock: &Path,
    opts: &FileLockOptions,
    f: impl FnOnce() -> T,
) -> io::Result<T> {
    let deadline = std::time::Instant::now() + opts.timeout;
    let mine = loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(lock)
        {
            Ok(mut file) => {
                let mine = format!("{} {} {}\n", std::process::id(), now_ms(), unique_token());
                file.write_all(mine.as_bytes())?;
                break mine;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if let Some(stale) = stale_content(lock, now_ms(), opts.stale) {
                    remove_if_same(lock, &stale);
                    continue;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "잠금을 못 잡았다({}ms): {}",
                            opts.timeout.as_millis(),
                            lock.display()
                        ),
                    ));
                }
                std::thread::sleep(opts.retry);
            }
            Err(e) => return Err(e),
        }
    };
    struct Release<'a>(&'a Path, String);
    impl Drop for Release<'_> {
        fn drop(&mut self) {
            // 내 것일 때만 놓는다 — 시한을 넘겨 남이 치우고 새로 잡았으면 그 잠금은 그대로 둔다.
            remove_if_same(self.0, &self.1);
        }
    }
    let _release = Release(lock, mine);
    Ok(f())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("hk-lock-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.join("usage.json.lock")
    }

    #[test]
    fn locks_and_releases_with_ts_file_shape() {
        let lock = tmp("shape");
        let seen = with_file_lock(&lock, &FileLockOptions::default(), || {
            fs::read_to_string(&lock).unwrap()
        })
        .unwrap();
        let parts: Vec<&str> = seen.trim_end_matches('\n').split(' ').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], std::process::id().to_string());
        assert!(parts[1].parse::<u128>().is_ok());
        assert!(seen.ends_with('\n'));
        assert!(!lock.exists(), "놓은 뒤 잠금 파일이 남았다");
    }

    #[test]
    fn times_out_on_live_lock_and_reaps_dead_owner() {
        let lock = tmp("dead");
        fs::write(&lock, format!("{} {} x\n", std::process::id(), now_ms())).unwrap();
        let opts = FileLockOptions {
            timeout: Duration::from_millis(120),
            ..Default::default()
        };
        assert_eq!(
            with_file_lock(&lock, &opts, || ()).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        // 없는 pid(아주 큰 값)의 잠금은 치우고 잡는다.
        fs::write(&lock, format!("{} {} x\n", i32::MAX - 7, now_ms())).unwrap();
        assert!(with_file_lock(&lock, &opts, || ()).is_ok());
        // 오래된 잠금은 주인이 살아 있어도 치운다.
        fs::write(
            &lock,
            format!("{} {} x\n", std::process::id(), now_ms() - 60_000),
        )
        .unwrap();
        assert!(with_file_lock(&lock, &opts, || ()).is_ok());
    }

    #[test]
    fn does_not_remove_someone_elses_lock() {
        let lock = tmp("other");
        fs::write(&lock, "1 2 theirs\n").unwrap();
        assert!(!remove_if_same(&lock, "1 2 mine\n"));
        assert_eq!(fs::read_to_string(&lock).unwrap(), "1 2 theirs\n");
        assert!(remove_if_same(&lock, "1 2 theirs\n"));
        assert!(!lock.exists());
    }

    #[test]
    fn threads_take_turns() {
        let lock = tmp("turns");
        let counter = lock.with_file_name("counter");
        fs::write(&counter, "0").unwrap();
        let hs: Vec<_> = (0..4)
            .map(|_| {
                let (lock, counter) = (lock.clone(), counter.clone());
                std::thread::spawn(move || {
                    for _ in 0..25 {
                        with_file_lock(
                            &lock,
                            &FileLockOptions {
                                retry: Duration::from_millis(1),
                                ..Default::default()
                            },
                            || {
                                let n: u32 = fs::read_to_string(&counter).unwrap().parse().unwrap();
                                fs::write(&counter, (n + 1).to_string()).unwrap();
                            },
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        hs.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(fs::read_to_string(&counter).unwrap(), "100");
    }
}

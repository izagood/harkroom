//! 디스크 여유가 모자라면 사람이 미리 적어 둔 폴더의 내용물을 비운다 — `HARKROOM_DISK_RECLAIM_DIRS`.
//!
//! 빌드 캐시처럼 다시 만들 수 있는 것이 디스크를 다 채우면 턴이 전부 실패한다. 오퍼레이터가 무엇을 지워도 되는지
//! 스스로 고르지 않는다 — 환경 변수에 적힌 폴더만, 그 내용물만 지운다(폴더 자체는 남긴다).
//!
//! 스위치: 환경 변수가 없거나 비어 있으면 아무것도 하지 않는다(스레드도 띄우지 않는다).
//!
//! [`INTERVAL`] 마다 다음이 모두 참일 때만 비운다([`should_reclaim`]):
//! - 목록이 비어 있지 않다
//! - 오퍼레이터 데이터 디렉터리가 놓인 디스크의 여유가 [`RECLAIM_BELOW_BYTES`] 밑이다(못 재면 비우지 않는다)
//! - 도는 `cargo`·`rustc` 프로세스가 없다(`ps` 를 못 돌리면 「있다」로 본다)
//!
//! 안전장치([`check_dir`]): 절대 경로가 아닌 것, `..` 이 든 것, 구성 요소가 [`MIN_COMPONENTS`] 개 미만인 것,
//! 홈·데이터 디렉터리와 그 조상(`/` 포함)은 버린다. 폴더 자체가 심볼릭 링크면 버리고, 실제 경로로 풀어 한 번 더 본다.
//! 내용물을 지울 때 심볼릭 링크를 따라가지 않는다(링크만 지운다).
//!
//! 경로는 이 기기의 로그에만 적는다 — 서버로 가는 값에는 싣지 않는다.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const ENV_DIRS: &str = "HARKROOM_DISK_RECLAIM_DIRS";
const GIB: u64 = 1024 * 1024 * 1024;
/// 여유가 이 밑이면 비운다.
pub const RECLAIM_BELOW_BYTES: u64 = 15 * GIB;
/// 재는 주기.
pub const INTERVAL: Duration = Duration::from_secs(300);
/// 경로 구성 요소(루트 빼고)의 최소 수 — `/a/b` 같은 얕은 자리는 받지 않는다.
pub const MIN_COMPONENTS: usize = 3;

/// 환경 변수 값을 플랫폼 경로 구분자로 나눈다. 빈 칸은 버린다.
pub fn parse_dirs(raw: Option<&OsStr>) -> Vec<PathBuf> {
    match raw {
        Some(v) => std::env::split_paths(v)
            .filter(|p| !p.as_os_str().is_empty())
            .collect(),
        None => Vec::new(),
    }
}

/// 이 폴더를 비워도 되는가(경로 글자만 본다 — 디스크를 읽지 않는다). 안 되면 까닭.
pub fn check_dir(dir: &Path, home: &Path, data_dir: &Path) -> Result<(), &'static str> {
    if !dir.is_absolute() {
        return Err("절대 경로가 아니다");
    }
    if dir.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("`..` 이 들어 있다");
    }
    let depth = dir
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if depth < MIN_COMPONENTS {
        return Err("경로가 너무 얕다");
    }
    // `starts_with` 는 구성 요소 단위다 — 같은 자리와 조상(`/` 포함)을 함께 잡는다.
    if home.starts_with(dir) {
        return Err("홈이거나 홈의 조상이다");
    }
    if data_dir.starts_with(dir) {
        return Err("오퍼레이터 데이터 디렉터리이거나 그 조상이다");
    }
    Ok(())
}

/// 세 조건이 모두 참일 때만 비운다. 여유를 못 쟀으면(`None`) 비우지 않는다.
pub fn should_reclaim(dir_count: usize, free: Option<u64>, build_running: bool) -> bool {
    dir_count > 0 && free.is_some_and(|f| f < RECLAIM_BELOW_BYTES) && !build_running
}

/// `ps -axo comm=` 출력에 실행 파일 이름이 정확히 `cargo`·`rustc` 인 줄이 있는가.
pub fn has_build_process(ps_out: &str) -> bool {
    ps_out.lines().any(|l| {
        let name = l.trim().rsplit('/').next().unwrap_or("");
        name == "cargo" || name == "rustc"
    })
}

/// 지금 빌드가 도는가. `ps` 를 못 돌리면 「돈다」로 본다(지우지 않는 쪽).
fn build_running() -> bool {
    match std::process::Command::new("ps")
        .args(["-axo", "comm="])
        .output()
    {
        Ok(o) if o.status.success() => has_build_process(&String::from_utf8_lossy(&o.stdout)),
        _ => true,
    }
}

/// 폴더의 내용물을 지운다(폴더는 남긴다). 심볼릭 링크는 링크만 지운다. 한 항목이 실패하면 로그만 남기고 계속한다.
pub fn empty_dir(dir: &Path, log: &dyn Fn(&str)) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log(&format!("디스크 비우기: 못 읽음 {} — {e}", dir.display()));
            return;
        }
    };
    for entry in entries {
        let res = entry.and_then(|ent| {
            let path = ent.path();
            // `file_type` 은 링크를 따라가지 않는다 — 폴더를 가리키는 링크는 여기서 폴더가 아니다.
            if ent.file_type()?.is_dir() {
                // `remove_dir_all` 도 안쪽 링크를 따라가지 않는다.
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            }
        });
        if let Err(e) = res {
            log(&format!("디스크 비우기: 항목 실패 {} — {e}", dir.display()));
        }
    }
}

/// 목록에서 안전장치를 지난 폴더만 비운다. 비운 폴더 수를 돌려준다. 없는 폴더는 조용히 건너뛴다.
pub fn reclaim(dirs: &[PathBuf], home: &Path, data_dir: &Path, log: &dyn Fn(&str)) -> usize {
    // 실제 경로로도 본다 — 링크를 거쳐 홈·데이터 디렉터리에 닿는 길을 막는다.
    let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (real_home, real_data) = (real(home), real(data_dir));
    let mut done = 0;
    for dir in dirs {
        if let Err(why) = check_dir(dir, home, data_dir) {
            log(&format!("디스크 비우기: 건너뜀 {} — {why}", dir.display()));
            continue;
        }
        let meta = match std::fs::symlink_metadata(dir) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            log(&format!(
                "디스크 비우기: 건너뜀 {} — 폴더가 아니거나 심볼릭 링크다",
                dir.display()
            ));
            continue;
        }
        let Ok(resolved) = std::fs::canonicalize(dir) else {
            continue;
        };
        if let Err(why) = check_dir(&resolved, &real_home, &real_data) {
            log(&format!(
                "디스크 비우기: 건너뜀 {} — 실제 경로: {why}",
                dir.display()
            ));
            continue;
        }
        empty_dir(&resolved, log);
        done += 1;
    }
    done
}

fn gb(v: Option<u64>) -> String {
    match v {
        Some(b) => format!("{:.1}GB", b as f64 / GIB as f64),
        None => "모름".to_string(),
    }
}

/// 한 줄 요약 — 「디스크 비우기: 폴더 N개, 여유 A → B」.
pub fn describe(done: usize, before: Option<u64>, after: Option<u64>) -> String {
    format!(
        "디스크 비우기: 폴더 {done}개, 여유 {} → {}",
        gb(before),
        gb(after)
    )
}

fn free_at(data_dir: &Path) -> Option<u64> {
    crate::device_capacity::measure(&[data_dir]).disk_free
}

/// 한 번 재고, 조건이 맞으면 비운다.
fn tick(dirs: &[PathBuf], home: &Path, data_dir: &Path, log: &dyn Fn(&str)) {
    let before = free_at(data_dir);
    // 여유가 넉넉하면 `ps` 를 돌리지 않는다.
    if !should_reclaim(dirs.len(), before, false) || build_running() {
        return;
    }
    let done = reclaim(dirs, home, data_dir, log);
    log(&describe(done, before, free_at(data_dir)));
}

/// 환경 변수를 읽어, 목록이 있으면 주기 스레드를 띄운다. 없으면 아무것도 하지 않는다. 프로세스와 함께 산다.
pub fn start(raw: Option<&OsStr>, home: PathBuf, data_dir: PathBuf) {
    let dirs = parse_dirs(raw);
    if dirs.is_empty() {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("disk-reclaim".into())
        .spawn(move || {
            let log = |line: &str| eprintln!("{line}");
            log(&format!(
                "디스크 비우기: 폴더 {}개를 지켜본다(여유 {} 밑에서 비운다)",
                dirs.len(),
                gb(Some(RECLAIM_BELOW_BYTES))
            ));
            loop {
                tick(&dirs, &home, &data_dir, &log);
                std::thread::sleep(INTERVAL);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const HOME: &str = "/h/u/me";
    const DATA: &str = "/h/u/me/app/data";

    fn check(dir: &str) -> Result<(), &'static str> {
        check_dir(Path::new(dir), Path::new(HOME), Path::new(DATA))
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hr-reclaim-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        // 임시 폴더가 링크 밑에 있는 OS 가 있다 — 실제 경로로 쓴다.
        std::fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn parse_splits_and_drops_blanks() {
        assert!(parse_dirs(None).is_empty());
        assert!(parse_dirs(Some(OsStr::new(""))).is_empty());
        let joined = std::env::join_paths(["/x/y/z", "", "/a/b/c"]).unwrap();
        assert_eq!(
            parse_dirs(Some(&joined)),
            vec![PathBuf::from("/x/y/z"), PathBuf::from("/a/b/c")]
        );
    }

    #[test]
    fn check_rejects_unsafe_dirs() {
        for bad in [
            "x/y/z",
            "/",
            "/x",
            "/x/y",
            "/x/y/../z/w",
            "/h",
            "/h/u",
            HOME,
            "/h/u/me/app",
            DATA,
        ] {
            assert!(check(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn check_accepts_deep_dirs_outside_and_under_home() {
        for ok in [
            "/x/y/z",
            "/x/y/z/w",
            "/h/u/me/cache",
            "/h/u/me/app/data/cache",
            "/h/u/me2/a",
        ] {
            assert_eq!(check(ok), Ok(()), "{ok}");
        }
    }

    #[test]
    fn should_reclaim_needs_every_condition() {
        let low = Some(RECLAIM_BELOW_BYTES - 1);
        assert!(should_reclaim(1, low, false));
        assert!(!should_reclaim(0, low, false));
        assert!(!should_reclaim(1, Some(RECLAIM_BELOW_BYTES), false));
        assert!(!should_reclaim(1, None, false));
        assert!(!should_reclaim(1, low, true));
    }

    #[test]
    fn ps_output_matches_exact_basenames_only() {
        assert!(has_build_process("/sbin/launchd\n/x/y/bin/cargo\n"));
        assert!(has_build_process("  rustc  \n"));
        assert!(!has_build_process(""));
        assert!(!has_build_process(
            "/x/bin/cargo-watch\nrustcx\n/x/cargo/bin/tool\nmycargo\n"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reclaim_empties_contents_without_following_links() {
        let root = tmp("empty");
        let (target, outside) = (root.join("cache"), root.join("outside"));
        std::fs::create_dir_all(target.join("sub/deep")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(target.join("a.txt"), "a").unwrap();
        std::fs::write(target.join("sub/deep/b.txt"), "b").unwrap();
        std::fs::write(outside.join("keep.txt"), "k").unwrap();
        std::os::unix::fs::symlink(&outside, target.join("link-dir")).unwrap();
        std::os::unix::fs::symlink(outside.join("keep.txt"), target.join("sub/link-file")).unwrap();

        let lines = Mutex::new(Vec::new());
        let log = |l: &str| lines.lock().unwrap().push(l.to_string());
        let missing = root.join("missing");
        let n = reclaim(
            &[target.clone(), missing],
            Path::new(HOME),
            Path::new(DATA),
            &log,
        );
        assert_eq!(n, 1);
        assert!(target.is_dir());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        assert_eq!(
            std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "k"
        );
        // 없는 폴더는 로그도 남기지 않는다.
        assert!(lines.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn reclaim_skips_symlinked_dir_and_protected_real_paths() {
        let root = tmp("guard");
        let (real, link) = (root.join("real"), root.join("link"));
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("keep.txt"), "k").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let log = |_: &str| {};
        // 폴더 자체가 링크다.
        assert_eq!(reclaim(&[link], Path::new(HOME), Path::new(DATA), &log), 0);
        // 홈·데이터 디렉터리(와 조상)는 목록에 있어도 비우지 않는다.
        let data = real.join("data");
        std::fs::create_dir_all(&data).unwrap();
        assert_eq!(reclaim(std::slice::from_ref(&real), &real, &data, &log), 0);
        assert_eq!(
            reclaim(&[real.clone(), data.clone()], Path::new(HOME), &data, &log),
            0
        );
        assert!(real.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn describe_shows_one_decimal_gb() {
        assert_eq!(
            describe(2, Some(3 * GIB / 2), Some(40 * GIB)),
            "디스크 비우기: 폴더 2개, 여유 1.5GB → 40.0GB"
        );
    }
}

//! Claude in Chrome 을 이 머신에서 열 수 있는가 — TS `chromeHost.ts` 의 `chromeNativeHostDirs`·`chromeHostAvailable` 이식(s9 G6).
//!
//! 판정 재료는 **파일 존재**뿐이다 — 확장이 실제로 브라우저에 켜져 있는지는 턴을 돌려 봐야 안다. 없는 것을 있다고 하지
//! 않는 쪽으로만 잰다. 열 수 있으려면 둘 다 참이어야 한다:
//! 1. **앱이 띄운 로컬 오퍼레이터다**(`--launch-nonce` 를 받았다). 앱 밖에서 뜬 오퍼레이터는 사람이 앞에 없는 기계일 수
//!    있다 — 거기서 브라우저를 여는 것은 설계 밖이라 native host 가 있어도 닫는다.
//! 2. 확장의 **native messaging host 매니페스트**가 브라우저 자리 중 하나에 있다.
use std::path::{Path, PathBuf};

pub const CHROME_NATIVE_HOST: &str = "com.anthropic.claude_browser_extension";

/// 지금 빌드의 플랫폼 이름(TS `process.platform` 과 같은 낱말).
pub const PLATFORM: &str = if cfg!(target_os = "macos") {
    "darwin"
} else if cfg!(target_os = "linux") {
    "linux"
} else {
    "other"
};

/// 매니페스트가 놓이는 사용자 단위 디렉터리(Chromium 계열 공식 자리). 시스템 단위 자리는 claude 가 쓰지 않는다.
pub fn native_host_dirs(platform: &str, home: &Path) -> Vec<PathBuf> {
    let (base, browsers): (PathBuf, &[&str]) = match platform {
        "darwin" => (
            home.join("Library").join("Application Support"),
            &[
                "Google/Chrome",
                "Google/Chrome Beta",
                "Google/Chrome Canary",
                "Chromium",
                "BraveSoftware/Brave-Browser",
                "Arc/User Data",
                "Microsoft Edge",
            ],
        ),
        "linux" => (
            home.join(".config"),
            &[
                "google-chrome",
                "google-chrome-beta",
                "chromium",
                "BraveSoftware/Brave-Browser",
                "microsoft-edge",
            ],
        ),
        _ => return Vec::new(),
    };
    browsers
        .iter()
        .map(|b| {
            let mut p = base.clone();
            for part in b.split('/') {
                p.push(part);
            }
            p.join("NativeMessagingHosts")
        })
        .collect()
}

/// TS `chromeHostAvailable`. `exists` 는 시험에서 바꿔 끼운다.
pub fn chrome_host_available(
    app_launched: bool,
    platform: &str,
    home: &Path,
    exists: impl Fn(&Path) -> bool,
) -> bool {
    if !app_launched {
        return false;
    }
    let file = format!("{CHROME_NATIVE_HOST}.json");
    native_host_dirs(platform, home)
        .iter()
        .any(|dir| exists(&dir.join(&file)))
}

/// 실제 파일 시스템으로 잰다. HOME 이 비면 닫힘.
pub fn chrome_host_on_disk(app_launched: bool, home: &str) -> bool {
    if home.is_empty() {
        return false;
    }
    chrome_host_available(app_launched, PLATFORM, Path::new(home), |p| p.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn darwin_dirs_match_ts() {
        let dirs = native_host_dirs("darwin", Path::new("/h"));
        assert_eq!(dirs.len(), 7);
        assert_eq!(
            dirs[0],
            PathBuf::from("/h/Library/Application Support/Google/Chrome/NativeMessagingHosts")
        );
        assert_eq!(
            dirs[5],
            PathBuf::from("/h/Library/Application Support/Arc/User Data/NativeMessagingHosts")
        );
    }

    #[test]
    fn linux_dirs_match_ts() {
        let dirs = native_host_dirs("linux", Path::new("/h"));
        assert_eq!(dirs.len(), 5);
        assert_eq!(
            dirs[3],
            PathBuf::from("/h/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
        );
    }

    #[test]
    fn other_platform_has_no_dirs() {
        assert!(native_host_dirs("win32", Path::new("/h")).is_empty());
        assert!(!chrome_host_available(
            true,
            "win32",
            Path::new("/h"),
            |_| true
        ));
    }

    #[test]
    fn not_app_launched_is_closed_even_with_manifest() {
        let asked = RefCell::new(0);
        let open = chrome_host_available(false, "darwin", Path::new("/h"), |_| {
            *asked.borrow_mut() += 1;
            true
        });
        assert!(!open);
        assert_eq!(
            *asked.borrow(),
            0,
            "앱이 띄운 것이 아니면 파일을 보지도 않는다"
        );
    }

    #[test]
    fn opens_when_any_browser_has_the_manifest() {
        let want = PathBuf::from(
            "/h/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.anthropic.claude_browser_extension.json",
        );
        assert!(chrome_host_available(
            true,
            "darwin",
            Path::new("/h"),
            |p| p == want
        ));
    }

    #[test]
    fn closed_without_manifest() {
        assert!(!chrome_host_available(
            true,
            "darwin",
            Path::new("/h"),
            |_| false
        ));
    }

    #[test]
    fn other_file_name_does_not_count() {
        let open = chrome_host_available(true, "darwin", Path::new("/h"), |p| {
            p.file_name().and_then(|n| n.to_str()) == Some("com.other.host.json")
        });
        assert!(!open);
    }

    #[test]
    fn on_disk_reads_real_files() {
        let home = std::env::temp_dir().join(format!("hk-chrome-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let h = home.to_string_lossy().into_owned();
        assert!(!chrome_host_on_disk(true, &h));
        if PLATFORM == "darwin" || PLATFORM == "linux" {
            let dir = native_host_dirs(PLATFORM, &home).remove(0);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{CHROME_NATIVE_HOST}.json")), "{}").unwrap();
            assert!(chrome_host_on_disk(true, &h));
            assert!(!chrome_host_on_disk(false, &h));
        }
        assert!(!chrome_host_on_disk(true, ""));
        let _ = std::fs::remove_dir_all(&home);
    }
}

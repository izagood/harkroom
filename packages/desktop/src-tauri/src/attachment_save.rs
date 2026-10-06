//! 첨부를 **사람이 고른 자리에** 저장한다 — macOS 저장 창을 띄우고, 고른 경로에 Rust 가 직접 쓴다.
//!
//! ## 왜 이것이 필요한가 (2026-10-06, jaebin 결정 95ab9c9b)
//!
//! 전에는 웹뷰가 objectURL 에 `download` 앵커를 달아 눌렀다(`controller.saveAttachment`). WKWebView 는 그
//! 다운로드를 **묻지 않고** 기본 위치에 썼다 — 첨부 카드를 누르기만 해도 파일이 생겼고, 어디에 생겼는지도
//! 알 수 없었다. 이 모듈의 저장 창에서 [취소]가 곧 "저장하지 않는다"이다.
//!
//! ## 경계 — 웹뷰가 고르는 것은 **이름 제안**뿐이다
//!
//! - 경로는 웹뷰가 주지 않는다. 저장 창에서 **사람이** 고른 경로에만 쓴다. 웹뷰가 넘기는 파일 이름은
//!   창의 기본값으로만 쓰고, 그마저 경로 구분자·제어 문자를 지운 마지막 조각만 남긴다(`suggested_name`).
//! - `tauri-plugin-fs` 를 등록하지 않고, `dialog:*` 권한도 capabilities 에 열지 않는다. dialog 플러그인은
//!   Rust 쪽 `app.dialog()` 를 쓰려고 등록할 뿐이다 — 웹뷰는 그 플러그인의 명령을 부를 수 없다.
//! - 저장한 경로는 웹뷰에 돌려주지 않는다. 돌려주는 것은 폴더 **이름**(토스트 문구)과 표(`token`)뿐이고,
//!   [Finder에서 보기]는 그 표로만 부른다(`reveal`). 웹뷰가 임의 경로를 Finder 에 띄울 자리가 없다.
//!
//! ## quarantine
//!
//! 남이 올린 파일이 이 앱을 지나 **검사 표지 없이** 디스크에 들어오면, 브라우저로 받은 같은 파일보다 약하게
//! 대우받는다 — `.app`·`.command` 를 열 때 Gatekeeper 가 묻지 않는다. 그래서 브라우저처럼
//! `com.apple.quarantine` 을 붙인다(D2). 붙이기에 실패해도 저장은 실패로 치지 않는다 — 파일은 이미 사람이
//! 고른 자리에 있고, 지우면 그것이 더 놀랍다. 대신 로그를 남긴다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 웹뷰가 파일 이름을 싣는 헤더. 값은 `encodeURIComponent` 로 감싼다 — 헤더는 ASCII 만 지난다.
pub const FILENAME_HEADER: &str = "x-harkroom-filename";

/// 이름을 못 쓸 때 저장 창에 넣는 기본 이름.
const FALLBACK_NAME: &str = "attachment";

/// 저장 창에 넣는 이름의 상한(글자). macOS 파일 이름 한도(255바이트)보다 넉넉히 안쪽이다.
const MAX_NAME_CHARS: usize = 200;

/// [Finder에서 보기] 표를 몇 개까지 기억하나. 토스트는 4초짜리라 마지막 몇 개면 된다.
const MAX_TOKENS: usize = 32;

/// 저장이 끝났을 때 웹뷰에 돌려주는 것.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// [Finder에서 보기] 에 다시 줄 표.
    pub token: u64,
    /// 사람이 고른 파일 이름(바꿨을 수 있다).
    pub name: String,
    /// 저장한 폴더의 이름(예: "Downloads"). 경로 전체가 아니다.
    pub folder: String,
}

/// 저장한 파일의 표. 경로는 여기에만 있다.
#[derive(Default)]
pub struct SavedFiles {
    inner: Mutex<(u64, HashMap<u64, PathBuf>)>,
}

impl SavedFiles {
    pub fn remember(&self, path: PathBuf) -> u64 {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (next, map) = &mut *guard;
        *next += 1;
        let token = *next;
        map.insert(token, path);
        // 오래된 것부터 버린다 — 표는 늘 커지기만 하므로 가장 작은 것이 가장 오래됐다.
        while map.len() > MAX_TOKENS {
            if let Some(oldest) = map.keys().min().copied() {
                map.remove(&oldest);
            }
        }
        token
    }

    pub fn lookup(&self, token: u64) -> Option<PathBuf> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.1.get(&token).cloned()
    }
}

/// `encodeURIComponent` 를 되돌린다. 잘못된 `%` 는 글자 그대로 둔다 — 이름 제안일 뿐이라 거절할 일이 아니다.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 저장 창의 기본 이름. 마지막 경로 조각만 남기고, 제어 문자를 지우고, 앞의 점(숨김 파일)을 뗀다.
/// 아무것도 안 남으면 `attachment`.
pub fn suggested_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if c == ':' { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        return FALLBACK_NAME.to_string();
    }
    trimmed.chars().take(MAX_NAME_CHARS).collect()
}

/// `com.apple.quarantine` 값. 모양은 `플래그;16진 초;내려받은 앱;` 이다(브라우저가 쓰는 것과 같은 꼴).
/// `0081` 은 "다른 앱이 내려받음"을 뜻하는 표지로, Chrome 이 쓰는 값과 같다.
pub fn quarantine_value(unix_secs: u64) -> String {
    format!("0081;{unix_secs:x};Harkroom;")
}

/// 폴더 이름(토스트 문구). 이름이 없는 루트면 경로 그대로.
pub fn folder_name(path: &Path) -> String {
    match path.parent() {
        Some(parent) => parent
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| parent.to_string_lossy().into_owned()),
        None => String::new(),
    }
}

/// 사람이 고른 경로에 쓰고 quarantine 을 붙인다. 이 함수는 **저장 창이 돌려준 경로만** 받는다.
pub fn write_chosen(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("파일을 쓰지 못했다: {e}"))?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Err(e) = imp::set_quarantine(path, &quarantine_value(secs)) {
        eprintln!("[attachment_save] quarantine 표지를 못 붙였다: {e}");
    }
    Ok(())
}

/// 저장 창을 띄워 고른 경로에 쓴다. 취소하면 `Ok(None)`.
///
/// **블로킹이다** — 저장 창이 닫힐 때까지 기다린다. 메인 스레드에서 부르면 창이 그 메인 스레드를 기다려
/// 굳는다. 부르는 쪽(`main.rs::save_attachment`)이 `spawn_blocking` 위에서 부른다.
pub fn save_with_dialog(app: &tauri::AppHandle, raw_name: &str, bytes: &[u8]) -> Result<Option<Saved>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .set_file_name(suggested_name(raw_name))
        .set_can_create_directories(true)
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| format!("저장 위치를 읽지 못했다: {e}"))?;
    write_chosen(&path, bytes)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let folder = folder_name(&path);
    let token = app.state::<SavedFiles>().remember(path);
    Ok(Some(Saved { token, name, folder }))
}

/// 표로 받은 파일을 Finder 에서 집어 보여 준다. 모르는 표면 거절한다.
pub fn reveal(files: &SavedFiles, token: u64) -> Result<(), String> {
    let path = files.lookup(token).ok_or_else(|| "모르는 저장 표다".to_string())?;
    imp::reveal(&path)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    const QUARANTINE_ATTR: &str = "com.apple.quarantine";

    pub fn set_quarantine(path: &Path, value: &str) -> Result<(), String> {
        let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let c_name = CString::new(QUARANTINE_ATTR).map_err(|e| e.to_string())?;
        // SAFETY: 두 C 문자열은 이 호출 동안 살아 있고, 값은 길이를 함께 넘긴다.
        let rc = unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                c_name.as_ptr(),
                value.as_ptr() as *const libc::c_void,
                value.len(),
                0,
                0,
            )
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }

    /// `NSWorkspace activateFileViewerSelectingURLs:` — Finder 를 앞으로 띄우고 그 파일을 고른다.
    /// 프로세스를 띄우지 않는다(`open -R` 을 쓰지 않는 이유: 이 크레이트의 프로세스 실행 자리는
    /// `runnerShellScope.test.ts` 가 개수로 고정한다).
    pub fn reveal(path: &Path) -> Result<(), String> {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSArray, NSString, NSURL};

        let s = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&s);
        let urls = NSArray::from_retained_slice(&[url]);
        NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::path::Path;

    pub fn set_quarantine(_path: &Path, _value: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn reveal(_path: &Path) -> Result<(), String> {
        Err("이 OS 에서는 Finder 에서 보기를 지원하지 않는다".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 이름_제안은_마지막_조각만_남긴다() {
        assert_eq!(suggested_name("rc68-SUMMARY.md"), "rc68-SUMMARY.md");
        assert_eq!(suggested_name("../../etc/passwd"), "passwd");
        assert_eq!(suggested_name("a\\b\\c.txt"), "c.txt");
        assert_eq!(suggested_name(".zshrc"), "zshrc");
        assert_eq!(suggested_name("a\u{0}b\nc"), "abc");
        assert_eq!(suggested_name("x:y.txt"), "x_y.txt");
        assert_eq!(suggested_name(""), "attachment");
        assert_eq!(suggested_name("dir/"), "attachment");
        assert_eq!(suggested_name(" .. "), "attachment");
        assert_eq!(suggested_name(&"가".repeat(300)).chars().count(), 200);
    }

    #[test]
    fn 퍼센트_인코딩을_되돌린다() {
        assert_eq!(percent_decode("rc68-SUMMARY.md"), "rc68-SUMMARY.md");
        assert_eq!(percent_decode("%EC%9A%94%EC%95%BD.md"), "요약.md");
        assert_eq!(percent_decode("a%20b"), "a b");
        // 잘못된 % 는 글자 그대로.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%4"), "%4");
    }

    #[test]
    fn quarantine_값의_모양() {
        assert_eq!(quarantine_value(0x6700_0000), "0081;67000000;Harkroom;");
    }

    #[test]
    fn 폴더_이름만_돌려준다() {
        assert_eq!(folder_name(Path::new("/Users/me/Downloads/a.md")), "Downloads");
        assert_eq!(folder_name(Path::new("/a.md")), "/");
    }

    #[test]
    fn 표는_최근_것만_기억한다() {
        let files = SavedFiles::default();
        let first = files.remember(PathBuf::from("/tmp/first"));
        for i in 0..MAX_TOKENS {
            files.remember(PathBuf::from(format!("/tmp/{i}")));
        }
        assert_eq!(files.lookup(first), None);
        let last = files.remember(PathBuf::from("/tmp/last"));
        assert_eq!(files.lookup(last), Some(PathBuf::from("/tmp/last")));
        assert!(reveal(&files, 999_999).is_err());
    }

    #[test]
    fn 고른_경로에_쓰고_표지를_붙인다() {
        let dir = std::env::temp_dir().join(format!("hk-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.md");
        write_chosen(&path, b"# hi").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"# hi");
        #[cfg(target_os = "macos")]
        {
            let out = std::process::Command::new("/usr/bin/xattr")
                .args(["-p", "com.apple.quarantine"])
                .arg(&path)
                .output()
                .unwrap();
            let v = String::from_utf8_lossy(&out.stdout);
            assert!(v.starts_with("0081;"), "quarantine 표지가 없다: {v:?}");
            assert!(v.trim_end().ends_with(";Harkroom;"));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

//! macOS **전체 디스크 접근(Full Disk Access)** 이 이 앱에 켜져 있는지 본다.
//!
//! ## 왜 필요한가 (실측, 2026-10-28, macOS 26.6)
//!
//! 에이전트가 실행한 프로그램(docker 자격 증명 도우미·claude CLI 등)이 다른 앱의 데이터를 열면 macOS 가
//! 「Harkroom이 다른 앱의 데이터에 접근하려고 함」을 묻는다 — 책임 프로세스가 이 앱이기 때문이다. tccd 기록을
//! 보면 sandboxd 는 그 창을 띄우기 전에 `kTCCServiceSystemPolicyAllFiles` 를 먼저 묻고, 허용이면 창을 띄우지
//! 않는다. 그래서 전체 디스크 접근을 켜면 창이 사라진다. 이 모듈은 화면이 그것을 **권할지·켜졌는지**를 알게 한다.
//!
//! ## 확인 방법과 지키는 선 (소유자 결정 2026-10-29, security S3·S4)
//!
//! - 보호 파일(사용자 TCC.db)을 **읽기 전용으로 열었다가 곧바로 닫는다**. 내용은 한 바이트도 읽지 않는다.
//!   전체 디스크 접근은 묻지 않고 조용히 거절하므로(EPERM) 확인 자체가 창을 띄우지 않는다.
//! - 결과는 이 앱 화면에만 간다. 로그·서버로 보내지 않는다. 웹뷰가 넘기는 값은 없다(명령에 파라미터가 없다).
//! - 비공개 TCC API 는 쓰지 않는다.
//!
//! ## 왜 새 프로세스로도 한 번 더 보나 (다시 시작 띠, 소유자 결정 #8)
//!
//! 권한을 켠 직후 **이미 떠 있는** 이 프로세스가 계속 막혀 있는지는 실측으로 확정되지 않았다. 그래서 이 프로세스가
//! 막혀 있으면 같은 실행 파일을 [`PROBE_ARG`] 하나만 붙여 새로 띄워 같은 확인을 시킨다. 새 프로세스는 열리고 이
//! 프로세스는 막혀 있으면 「켜졌지만 다시 시작해야 함」이다. 둘 다 같으면 그 값 그대로다 — 다시 시작이 필요
//! 없으면 띠도 뜨지 않는다.

use std::path::PathBuf;

/// 새 프로세스로 확인할 때 붙이는 유일한 인자. `main` 이 Tauri 를 띄우기 전에 이것을 보고 곧바로 끝난다.
pub const PROBE_ARG: &str = "--harkroom-fda-probe";

/// 확인 한 번의 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// 열렸다 — 전체 디스크 접근이 있다.
    Granted,
    /// EPERM·EACCES — 없다.
    Denied,
    /// 파일이 없거나 다른 오류 — 모른다. 모를 때는 권하지 않는다.
    Unknown,
}

impl Probe {
    fn exit_code(self) -> i32 {
        match self {
            Probe::Granted => 0,
            Probe::Denied => 1,
            Probe::Unknown => 2,
        }
    }

    fn from_exit_code(code: Option<i32>) -> Probe {
        match code {
            Some(0) => Probe::Granted,
            Some(1) => Probe::Denied,
            _ => Probe::Unknown,
        }
    }
}

/// 화면에 넘기는 상태. 문자열은 `packages/desktop/src/lib/fullDiskAccess.ts` 의 `FdaStatus` 와 같다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// macOS 14 미만·macOS 밖. 다른 앱 데이터 창이 없는 곳이라 권할 것이 없다.
    Unsupported,
    /// 개발 실행이거나 확인할 수 없다. 개발 실행은 책임 프로세스가 터미널이라 터미널의 권한을 보게 된다.
    Unknown,
    On,
    Off,
    /// 새 프로세스는 열리는데 이 프로세스는 막혀 있다.
    RestartNeeded,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Unsupported => "unsupported",
            Status::Unknown => "unknown",
            Status::On => "on",
            Status::Off => "off",
            Status::RestartNeeded => "restart",
        }
    }
}

/// **판정은 이 함수 하나다** — 확인 결과 둘을 상태로 바꾼다. `fresh` 는 `this` 가 막혔을 때만 본다.
pub fn decide(this: Probe, fresh: impl FnOnce() -> Probe) -> Status {
    match this {
        Probe::Granted => Status::On,
        Probe::Unknown => Status::Unknown,
        Probe::Denied => match fresh() {
            Probe::Granted => Status::RestartNeeded,
            Probe::Denied => Status::Off,
            Probe::Unknown => Status::Unknown,
        },
    }
}

/// 보호 파일 자리. `$HOME` 이 없으면 모른다.
fn protected_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/com.apple.TCC/TCC.db"))
}

/// 이 프로세스에서 확인한다. 열고 **곧바로 닫는다**(`File` 을 버린다) — 읽지 않는다.
pub fn probe_this_process() -> Probe {
    let Some(path) = protected_file() else { return Probe::Unknown };
    match std::fs::File::open(&path) {
        Ok(file) => {
            drop(file);
            Probe::Granted
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Probe::Denied,
        Err(_) => Probe::Unknown,
    }
}

/// 같은 실행 파일을 [`PROBE_ARG`] 하나만 붙여 새로 띄워 확인시킨다. 프로그램도 인자도 Rust 가 고정한다.
fn probe_fresh_process() -> Probe {
    let Ok(exe) = std::env::current_exe() else { return Probe::Unknown };
    let status = std::process::Command::new(exe)
        .arg(PROBE_ARG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(s) => Probe::from_exit_code(s.code()),
        Err(_) => Probe::Unknown,
    }
}

/// `main` 맨 앞에서 부른다. 확인용으로 띄워진 프로세스면 확인만 하고 **끝낸다**(Tauri 를 띄우지 않는다).
pub fn exit_if_probe_child() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new(PROBE_ARG)) && args.next().is_none() {
        std::process::exit(probe_this_process().exit_code());
    }
}

/// `ProductVersion` 의 주 버전. `SystemVersion.plist` 를 글자로 읽는다(프로세스를 띄우지 않는다).
fn macos_major() -> Option<u32> {
    let text = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    parse_product_major(&text)
}

fn parse_product_major(plist: &str) -> Option<u32> {
    let after = &plist[plist.find("<key>ProductVersion</key>")?..];
    let start = after.find("<string>")? + "<string>".len();
    let rest = &after[start..];
    rest[..rest.find('<')?].split('.').next()?.trim().parse().ok()
}

/// 화면이 묻는 지금 상태.
pub fn status() -> Status {
    if !cfg!(target_os = "macos") {
        return Status::Unsupported;
    }
    if cfg!(debug_assertions) {
        return Status::Unknown;
    }
    match macos_major() {
        Some(major) if major >= 14 => decide(probe_this_process(), probe_fresh_process),
        Some(_) => Status::Unsupported,
        None => Status::Unknown,
    }
}

/// 시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근 권한. 주소는 고정이다.
pub const SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

#[cfg(target_os = "macos")]
pub fn open_settings() -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let url = NSURL::URLWithString(&NSString::from_str(SETTINGS_URL)).ok_or("bad settings url")?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err("could not open System Settings".into())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn open_settings() -> Result<(), String> {
    Err("macOS only".into())
}

/// Finder 에서 이 앱 번들을 골라 보인다 — 설정 목록에 없을 때 끌어다 놓게. 프로세스를 띄우지 않는다.
#[cfg(target_os = "macos")]
pub fn reveal_app() -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSArray, NSString, NSURL};
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // …/Harkroom.app/Contents/MacOS/<실행 파일> → …/Harkroom.app
    let bundle = exe.ancestors().nth(3).ok_or("not inside an app bundle")?;
    if bundle.extension().and_then(|e| e.to_str()) != Some("app") {
        return Err("not inside an app bundle".into());
    }
    let url = NSURL::fileURLWithPath(&NSString::from_str(&bundle.to_string_lossy()));
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&[url]));
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn reveal_app() -> Result<(), String> {
    Err("macOS only".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_reads_fresh_only_when_this_process_is_denied() {
        assert_eq!(decide(Probe::Granted, || panic!("must not spawn")), Status::On);
        assert_eq!(decide(Probe::Unknown, || panic!("must not spawn")), Status::Unknown);
        assert_eq!(decide(Probe::Denied, || Probe::Granted), Status::RestartNeeded);
        assert_eq!(decide(Probe::Denied, || Probe::Denied), Status::Off);
        assert_eq!(decide(Probe::Denied, || Probe::Unknown), Status::Unknown);
    }

    #[test]
    fn exit_codes_round_trip() {
        for p in [Probe::Granted, Probe::Denied, Probe::Unknown] {
            assert_eq!(Probe::from_exit_code(Some(p.exit_code())), p);
        }
        // 신호로 죽었거나 모르는 코드는 모른다.
        assert_eq!(Probe::from_exit_code(None), Probe::Unknown);
        assert_eq!(Probe::from_exit_code(Some(101)), Probe::Unknown);
    }

    #[test]
    fn parses_product_major() {
        let plist = "<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>26.6.2</string>\n</dict>";
        assert_eq!(parse_product_major(plist), Some(26));
        assert_eq!(parse_product_major("<key>ProductVersion</key><string>13.7</string>"), Some(13));
        assert_eq!(parse_product_major("<dict></dict>"), None);
    }
}

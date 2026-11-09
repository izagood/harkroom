//! 「로그인할 때 자동으로 시작」 — macOS 로그인 항목(`SMAppService.mainAppService`, macOS 13+).
//!
//! ## 왜 앱째(mainApp)인가
//!
//! 오퍼레이터는 앱이 띄우는 자식이고, 오퍼레이터를 세우고 등록하는 일(`controller.ts::ensureOperatorAndRegister`)과
//! 러너를 띄우는 일은 앱(웹뷰)이 한다. 오퍼레이터만 로그인 항목(`SMAppService.agent` + LaunchAgent plist)으로 띄우면
//! 그 일을 앱 밖으로 옮겨야 하고, 앱이 나중에 떴을 때 이미 떠 있는 오퍼레이터와 두 갈래가 된다. 앱을 **창 없이**
//! 띄우면 지금 길이 그대로 돈다 — 그래서 앱째 띄운다.
//!
//! ## 왜 tauri-plugin-autostart 가 아닌가
//!
//! 그 플러그인의 macOS 구현은 LaunchAgent plist 를 직접 쓰거나 AppleScript 로 System Events 를 부른다 — 켜짐/꺼짐만
//! 알고 「macOS 승인 대기」를 읽지 못하며, AppleScript 길은 자동화 권한 창을 하나 더 띄운다. `SMAppService` 는
//! 새 크레이트 없이(이미 끌고 있는 objc2) 부를 수 있고 상태(꺼짐·켜짐·승인 필요)를 돌려준다.
//!
//! ## 표면
//!
//! 웹뷰가 넘기는 것은 켜기/끄기 불리언 하나뿐이다. 무엇을 등록할지(이 앱 번들)·어느 설정 화면을 열지는 여기서 정한다.

/// 웹뷰에 돌려주는 상태. 문자열 꼴은 `src/lib/loginItem.ts` 의 `LoginItemStatus` 와 같다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// macOS 13 미만·macOS 밖 — 묶음째 숨긴다.
    Unsupported,
    /// 등록 안 됨(한 번도 안 켰거나, 시스템 설정에서 지웠다).
    Off,
    /// 등록됨 — 다음 로그인 때 뜬다.
    On,
    /// 등록은 했는데 사람이 시스템 설정 › 로그인 항목에서 허용해야 한다.
    Approval,
    /// 그 밖(문서에 없는 값) — 지어내지 않는다.
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Unsupported => "unsupported",
            Status::Off => "off",
            Status::On => "on",
            Status::Approval => "approval",
            Status::Unknown => "unknown",
        }
    }

    /// `SMAppServiceStatus` 값 → 상태. 0 notRegistered · 1 enabled · 2 requiresApproval · 3 notFound.
    ///
    /// `mainApp` 의 3(notFound)은 꺼짐이다 — macOS 26 실측: 한 번도 등록 안 한 번들도, 등록했다가 시스템 설정
    /// › 로그인 항목에서 「-」로 지운 번들도 3 을 준다(`unregister` 뒤에만 0). 번들을 같은 자리에 갈아 끼워도(업데이트) 1 은 남는다.
    pub fn from_raw(raw: isize) -> Self {
        match raw {
            0 | 3 => Status::Off,
            1 => Status::On,
            2 => Status::Approval,
            _ => Status::Unknown,
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Status;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSError;

    // `SMAppService` 는 ServiceManagement 프레임워크에 있다. 클래스는 이름으로 찾으므로(`AnyClass::get`)
    // macOS 13 미만에서도 앱이 뜨고, 그때는 `Unsupported` 다.
    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    fn class() -> Option<&'static AnyClass> {
        AnyClass::get(c"SMAppService")
    }

    fn main_app() -> Option<Retained<AnyObject>> {
        let cls = class()?;
        // SAFETY: `+[SMAppService mainAppService]` 는 인자 없이 객체를 돌려준다(macOS 13+, 클래스가 있을 때만 여기 온다).
        unsafe { msg_send![cls, mainAppService] }
    }

    /// `SMAppServiceStatus` 날값. macOS 13 미만이면 None.
    pub fn raw_status() -> Option<isize> {
        let svc = main_app()?;
        // SAFETY: `status` 는 NSInteger(`SMAppServiceStatus`)를 돌려준다.
        Some(unsafe { msg_send![&*svc, status] })
    }

    pub fn status() -> Status {
        raw_status().map_or(Status::Unsupported, Status::from_raw)
    }

    pub fn set(enabled: bool) -> Result<Status, String> {
        let svc = main_app().ok_or("login items need macOS 13 or later")?;
        // SAFETY: 두 메서드 모두 `- (BOOL)xxxAndReturnError:(NSError **)` 꼴이다 — objc2 의 `_` 오류 관례가 그 꼴을 받는다.
        let res: Result<(), Retained<NSError>> = unsafe {
            if enabled {
                msg_send![&*svc, registerAndReturnError: _]
            } else {
                msg_send![&*svc, unregisterAndReturnError: _]
            }
        };
        match res {
            Ok(()) => Ok(status()),
            Err(e) => {
                // 꺼진 것을 또 끄면 macOS 가 오류를 낸다 — 바라는 결과(꺼짐)와 같으면 실패로 치지 않는다.
                let now = status();
                if !enabled && now == Status::Off {
                    return Ok(now);
                }
                Err(format!("{} (code {})", e.localizedDescription(), e.code()))
            }
        }
    }

    pub fn open_settings() -> Result<(), String> {
        let cls = class().ok_or("login items need macOS 13 or later")?;
        // SAFETY: `+[SMAppService openSystemSettingsLoginItems]` — 인자·반환 없음. 시스템 설정의 로그인 항목 화면을 연다.
        unsafe {
            let _: () = msg_send![cls, openSystemSettingsLoginItems];
        }
        Ok(())
    }

    /// 이 프로세스가 **로그인 항목으로** 떴는가. macOS 는 로그인 때 띄운 앱의 첫 Apple Event(`kAEOpenApplication`)에
    /// `keyAEPropData = keyAELaunchedAsLogInItem` 을 싣는다. 이 이벤트는 앱이 뜨는 동안(setup)만 「지금 이벤트」다.
    pub fn launched_at_login() -> bool {
        use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};
        const fn code(s: &[u8; 4]) -> u32 {
            u32::from_be_bytes(*s)
        }
        let Some(ev) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else {
            return false;
        };
        // `eventID`·`paramDescriptorForKeyword:` 는 objc2-foundation 에서 objc2-core-services 기능 뒤에 있다 — 크레이트를
        // 새로 들이지 않으려고 같은 메서드를 직접 부른다.
        // SAFETY: `- (AEEventID)eventID`(FourCharCode), `- (NSAppleEventDescriptor *)paramDescriptorForKeyword:(AEKeyword)`.
        let id: u32 = unsafe { msg_send![&*ev, eventID] };
        let prop: Option<Retained<NSAppleEventDescriptor>> =
            unsafe { msg_send![&*ev, paramDescriptorForKeyword: code(b"prdt")] };
        id == code(b"oapp") && prop.map(|d| d.enumCodeValue()) == Some(code(b"lgit"))
    }
}

#[cfg(target_os = "macos")]
pub use mac::{launched_at_login, open_settings, raw_status, set, status};

#[cfg(not(target_os = "macos"))]
pub fn status() -> Status {
    Status::Unsupported
}

#[cfg(not(target_os = "macos"))]
pub fn set(_enabled: bool) -> Result<Status, String> {
    Err("macOS only".into())
}

#[cfg(not(target_os = "macos"))]
pub fn open_settings() -> Result<(), String> {
    Err("macOS only".into())
}

#[cfg(not(target_os = "macos"))]
pub fn raw_status() -> Option<isize> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn launched_at_login() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::Status;

    #[test]
    fn raw_status_maps_not_found_to_off_and_the_rest_to_unknown() {
        assert_eq!(Status::from_raw(0), Status::Off);
        assert_eq!(Status::from_raw(1), Status::On);
        assert_eq!(Status::from_raw(2), Status::Approval);
        assert_eq!(Status::from_raw(3), Status::Off);
        assert_eq!(Status::from_raw(-1), Status::Unknown);
    }

    #[test]
    fn strings_match_the_webview_type() {
        let all = [Status::Unsupported, Status::Off, Status::On, Status::Approval, Status::Unknown];
        let names: Vec<_> = all.iter().map(|s| s.as_str()).collect();
        assert_eq!(names, ["unsupported", "off", "on", "approval", "unknown"]);
    }
}

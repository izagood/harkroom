//! 복구 키처럼 **한 번만 보이는 비밀**을 클립보드에 담고, 60초 뒤 그대로면 비운다.
//!
//! ## 왜 웹뷰가 아니라 여기서 하는가
//!
//! 웹뷰의 `navigator.clipboard.readText()` 는 WKWebView 에서 사용자 제스처를 요구한다 — 60초 뒤 타이머
//! 안에서는 거절되므로 "아직 그 값이면 지운다"를 웹 쪽에서 할 수 없다. 여기서는 내용을 읽지 않고
//! `NSPasteboard.changeCount` 만 본다: 쓴 직후의 값이 60초 뒤에도 같으면 그 사이 아무도 클립보드를 바꾸지
//! 않은 것이고, 그때만 비운다. 키를 다시 읽을 필요가 없으므로 웹뷰가 키를 들고 기다릴 필요도 없다.
//!
//! ## 클립보드 기록 앱에 남지 않게
//!
//! `org.nspasteboard.ConcealedType`·`TransientType` 표지를 함께 쓴다(nspasteboard.org 관례). Maccy·Raycast·
//! Alfred 같은 기록 앱은 이 표지가 있으면 저장하지 않는다. Universal Clipboard(기기 간 동기화)는 막지
//! 못한다 — 화면 경고 문구가 그것을 말한다.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

/// 비우기까지 기다리는 시간. 화면 문구(`RECOVERY_CLIPBOARD_CLEAR_MS`)와 같다.
pub const CLEAR_AFTER: Duration = Duration::from_secs(60);

/// 쓴 직후의 changeCount 와 지금 값이 같을 때만 비운다 — 판정만 따로 둬서 시험한다.
pub fn should_clear(written: isize, now: isize) -> bool {
    written == now
}

/// 아직 비우지 않은 마지막 쓰기의 changeCount. 없으면 `NONE`.
///
/// 60초가 지나기 전에 앱이 끝나면 비우기 스레드도 함께 죽는다 — 그러면 키가 클립보드에 남는다.
/// 종료 훅(`clear_on_exit`)이 이 값을 보고 한 번 더 비운다.
static PENDING: AtomicIsize = AtomicIsize::new(NONE);
const NONE: isize = isize::MIN;

/// 클립보드에 감춘 표지와 함께 쓰고, `CLEAR_AFTER` 뒤 그대로면 비운다. 비우기 예약까지 하면 `Ok`.
#[tauri::command]
pub fn clipboard_write_concealed(text: String) -> Result<(), String> {
    let written = imp::write_concealed(&text)?;
    drop(text);
    PENDING.store(written, Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR_AFTER);
        // 그 사이 더 새로 쓴 것이 있으면 그쪽 스레드·종료 훅에 맡긴다.
        if take_pending_if(written) {
            imp::clear_if_unchanged(written);
        }
    });
    Ok(())
}

/// 앱이 끝날 때 부른다(main.rs `RunEvent::Exit`). 아직 비우지 않은 쓰기가 있고 그 뒤 클립보드가
/// 바뀌지 않았으면 비운다. 사람이 그 사이 다른 것을 복사했으면 건드리지 않는다.
pub fn clear_on_exit() {
    let written = PENDING.swap(NONE, Ordering::SeqCst);
    if written != NONE {
        imp::clear_if_unchanged(written);
    }
}

/// `PENDING` 이 아직 `written` 이면 비우고 참. 다른 값(더 새 쓰기·이미 비움)이면 거짓.
fn take_pending_if(written: isize) -> bool {
    PENDING
        .compare_exchange(written, NONE, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;

    const PLAIN_TEXT: &str = "public.utf8-plain-text";
    const CONCEALED: &str = "org.nspasteboard.ConcealedType";
    const TRANSIENT: &str = "org.nspasteboard.TransientType";

    fn general() -> Result<*mut AnyObject, String> {
        let cls = AnyClass::get(c"NSPasteboard").ok_or("NSPasteboard unavailable")?;
        let pb: *mut AnyObject = unsafe { msg_send![cls, generalPasteboard] };
        if pb.is_null() {
            Err("no general pasteboard".into())
        } else {
            Ok(pb)
        }
    }

    /// 쓰고 나서의 changeCount 를 돌려준다.
    pub fn write_concealed(text: &str) -> Result<isize, String> {
        autoreleasepool(|_| unsafe {
            let pb = general()?;
            let _: isize = msg_send![pb, clearContents];
            let body = NSString::from_str(text);
            let ok: Bool =
                msg_send![pb, setString: &*body, forType: &*NSString::from_str(PLAIN_TEXT)];
            if !ok.as_bool() {
                return Err("pasteboard refused the text".into());
            }
            // 표지는 내용이 없어도 된다 — 형식이 있다는 것 자체가 신호다.
            let empty = NSString::from_str("");
            let _: Bool =
                msg_send![pb, setString: &*empty, forType: &*NSString::from_str(CONCEALED)];
            let _: Bool =
                msg_send![pb, setString: &*empty, forType: &*NSString::from_str(TRANSIENT)];
            let count: isize = msg_send![pb, changeCount];
            Ok(count)
        })
    }

    pub fn clear_if_unchanged(written: isize) {
        autoreleasepool(|_| unsafe {
            let Ok(pb) = general() else { return };
            let now: isize = msg_send![pb, changeCount];
            if super::should_clear(written, now) {
                let _: isize = msg_send![pb, clearContents];
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// macOS 밖에서는 표지·changeCount 를 쓸 수 없다 — 화면이 웹 복사로 물러나고 "비운다"고 말하지 않는다.
    pub fn write_concealed(_text: &str) -> Result<isize, String> {
        Err("unsupported".into())
    }
    pub fn clear_if_unchanged(_written: isize) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clears_only_when_nothing_changed_since_the_write() {
        assert!(should_clear(7, 7));
        assert!(!should_clear(7, 8));
    }

    #[test]
    fn the_exit_hook_and_the_timer_clear_a_write_at_most_once() {
        PENDING.store(41, Ordering::SeqCst);
        // 더 새 쓰기(42)가 오면 옛 타이머(41)는 손대지 않는다.
        PENDING.store(42, Ordering::SeqCst);
        assert!(!take_pending_if(41));
        // 새 쓰기의 타이머가 가져가면 종료 훅에는 남은 것이 없다.
        assert!(take_pending_if(42));
        assert_eq!(PENDING.swap(NONE, Ordering::SeqCst), NONE);
    }

    #[test]
    fn waits_the_same_sixty_seconds_the_screen_promises() {
        assert_eq!(CLEAR_AFTER, Duration::from_secs(60));
    }
}

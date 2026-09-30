//! macOS 창 머리(신호등)의 자리.
//!
//! **증상(2026-09-30, macOS 26):** Harkroom 의 신호등이 다른 앱(Slack·Chrome)보다 작아 보이고,
//! 창 꼭대기·왼쪽 모서리에 바짝 붙어 있었다.
//!
//! **원인:** macOS 26 은 신호등의 자리를 **창에 툴바가 있는지**로 정한다. `titleBarStyle:
//! "Overlay"` 는 제목 막대를 투명하게 만들 뿐 툴바를 달지 않으므로, 신호등이 툴바 없는 창의
//! 자리(창 모서리에서 9pt·중심 약 15.75pt)에 선다. 비교한 앱들은 툴바가 있는 창이다(Electron
//! 의 `hiddenInset` 이 빈 `NSToolbar` 를 다는 것과 같은 방식).
//!
//! **실측(창 캡처 2x):** 지름은 툴바가 있든 없든 **14pt 로 같다**. 달라지는 것은 자리다 —
//! 툴바 없음: 왼쪽 9pt·중심 15.75pt / `UnifiedCompact`: 12pt·19.75pt / `Unified`: 19pt·약 26pt.
//! "작아 보인다" 는 여백이 모자라 모서리에 눌린 인상이다.
//!
//! **고친 방법:** 창에 **빈 `NSToolbar`** 를 붙이고 스타일을 `UnifiedCompact` 로 둔다. 항목이 없어
//! 화면에 새로 그려지는 것은 없고, OS 가 신호등을 툴바 창의 자리로 옮긴다. `Unified` 는 신호등을
//! 너무 아래·안쪽(오른쪽 끝 79pt)으로 밀어 머리 줄(`TOP_BAR_H`)에서 벗어나고 사이드바 로고에 닿는다.
//! `trafficLightPosition`(tao 의 `inset_traffic_lights`)으로 숫자를 박는 길은 택하지 않았다 —
//! OS 판마다 달라지는 자리를 손으로 따라가게 된다.
//!
//! 머리 줄 높이(`TOP_BAR_H`)·로그인 화면 손잡이 띠(`MAC_TITLEBAR_H`)가 이 자리에 맞춰져 있다
//! (`src/lib/platform.ts`).

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::App) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};
    use tauri::Manager;

    // `setup` 은 메인 스레드에서 돈다. 아니라면 AppKit 을 만지지 않고 옛 모양으로 둔다.
    let Some(mtm) = MainThreadMarker::new() else { return };
    for window in app.webview_windows().values() {
        let Ok(ptr) = window.ns_window() else { continue };
        // SAFETY: Tauri 가 넘기는 포인터는 살아 있는 `NSWindow` 이고, 우리는 메인 스레드에 있다.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let toolbar = NSToolbar::new(mtm);
        // 툴바와 본문 사이의 가는 선. 머리 줄의 아래 테두리는 웹 쪽이 긋는다.
        #[allow(deprecated)]
        toolbar.setShowsBaselineSeparator(false);
        ns_window.setToolbar(Some(&toolbar));
        ns_window.setToolbarStyle(NSWindowToolbarStyle::UnifiedCompact);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::App) {}

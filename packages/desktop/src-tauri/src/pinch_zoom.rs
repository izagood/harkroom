//! 트랙패드 핀치를 화면(JS)에 알린다 — 미리보기(아티팩트) 배율을 핀치로 바꾸는 길.
//!
//! ## 왜 네이티브인가
//!
//! 미리보기는 교차 출처 iframe 이다. 포인터가 그 위에 있으면 WKWebView 는 핀치(`gesture*`·ctrl+wheel)를
//! **iframe 문서에만** 보내고 앱 문서는 아무것도 받지 못한다(탐침 실측 2026-10-27: iframe 이 없으면 앱 문서가
//! `gesturestart`·`gesturechange`·ctrl+wheel 을 받고, iframe 위에서는 0건). 앱 문서에서 듣는 길은 없다.
//! 그래서 앱 프로세스의 이벤트 루프에서 핀치(`NSEventTypeMagnify`)를 엿보고 그 창의 웹뷰에 알린다.
//!
//! ## 무엇을 하고 무엇을 안 하는가
//!
//! - **엿보기만 한다** — 이벤트를 그대로 돌려줘 웹뷰·페이지의 원래 처리는 바뀌지 않는다(지금 앱 문서는 핀치를
//!   쓰지 않고, WKWebView 의 `allowsMagnification` 은 꺼진 채다 — 앱 전체가 커지지 않는다).
//! - 화면에 넘기는 것은 숫자 다섯 개(위치·창 크기·단계·변화량)뿐이다. 페이지(iframe)에는 아무것도 넣지 않는다.
//! - 어느 칸 위에서 핀치했는지는 화면이 판단한다(`ArtifactPreview.tsx` 의 `harkroom:magnify`) — 미리보기 상자
//!   밖이면 무시한다.

/// 화면이 듣는 이벤트 이름. `ArtifactPreview.tsx` 와 같은 값.
pub const EVENT: &str = "harkroom:magnify";

/// 화면으로 보낼 스크립트. 모두 숫자라 문자열 이스케이프가 필요 없다 — 숫자가 아니면(NaN·무한) 보내지 않는다.
/// `x`·`y` 는 웹뷰 왼쪽 위 기준 점(pt), `w` 는 웹뷰 폭(pt) — 화면이 `innerWidth / w` 로 앱 배율을 걷어 CSS px 로 바꾼다.
pub fn dispatch_script(x: f64, y: f64, w: f64, phase: u64, magnification: f64) -> Option<String> {
    if ![x, y, w, magnification].iter().all(|v| v.is_finite()) || w <= 0.0 {
        return None;
    }
    Some(format!(
        "window.dispatchEvent(new CustomEvent('{EVENT}',{{detail:{{x:{x},y:{y},w:{w},phase:{phase},m:{magnification}}}}}))"
    ))
}

#[cfg(target_os = "macos")]
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use block2::RcBlock;
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use tauri::Manager as _;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        w: f64,
        h: f64,
    }
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    unsafe impl Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }

    /// `NSEventMaskMagnify` = 1 << `NSEventTypeMagnify`(30).
    const MASK_MAGNIFY: u64 = 1 << 30;

    let handle = app.clone();
    let block = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        if event.is_null() {
            return event;
        }
        unsafe {
            let phase: u64 = msg_send![event, phase];
            let magnification: f64 = msg_send![event, magnification];
            let mut window: *mut AnyObject = msg_send![event, window];
            let mut loc: Point = msg_send![event, locationInWindow];
            if window.is_null() {
                // 창이 붙지 않은 핀치(밖에서 이 프로세스로 보낸 이벤트)는 위치가 화면 좌표다 — 앞 창 기준으로 바꾼다.
                let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                window = msg_send![ns_app, keyWindow];
                if window.is_null() {
                    return event;
                }
                loc = msg_send![window, convertPointFromScreen: loc];
            }
            let content: *mut AnyObject = msg_send![window, contentView];
            if content.is_null() {
                return event;
            }
            let frame: Rect = msg_send![content, frame];
            // 창 좌표는 왼쪽 아래가 원점이다 — 웹뷰(왼쪽 위 원점)로 뒤집는다. 웹뷰는 콘텐츠 뷰를 꽉 채운다.
            let (x, y, w) = (loc.x, frame.size.h - loc.y, frame.size.w);
            let Some(js) = dispatch_script(x, y, w, phase, magnification) else {
                return event;
            };
            for (_, webview) in handle.webview_windows() {
                if matches!(webview.ns_window(), Ok(p) if p as *mut AnyObject == window) {
                    let _ = webview.eval(&js);
                    break;
                }
            }
        }
        event
    });
    unsafe {
        let monitor: *mut AnyObject = msg_send![
            class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: MASK_MAGNIFY,
            handler: &*block
        ];
        // 모니터는 앱이 끝날 때까지 산다 — 떼지 않는다. AppKit 이 돌려준 객체를 붙잡아 둔다.
        let _: *mut AnyObject = msg_send![monitor, retain];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

#[cfg(test)]
mod tests {
    use super::dispatch_script;

    #[test]
    fn 숫자만_싣는다() {
        let js = dispatch_script(10.5, 20.0, 800.0, 4, 0.05).unwrap();
        assert_eq!(
            js,
            "window.dispatchEvent(new CustomEvent('harkroom:magnify',{detail:{x:10.5,y:20,w:800,phase:4,m:0.05}}))"
        );
    }

    #[test]
    fn 숫자가_아니면_보내지_않는다() {
        assert!(dispatch_script(f64::NAN, 0.0, 800.0, 4, 0.1).is_none());
        assert!(dispatch_script(0.0, 0.0, 0.0, 4, 0.1).is_none());
        assert!(dispatch_script(0.0, 0.0, 800.0, 4, f64::INFINITY).is_none());
    }
}

//! OS 알림을 내보내고, 사용자가 그것을 **누른 것**을 웹뷰로 되돌리는 자리(`#542`).
//!
//! ## 왜 플러그인을 그대로 쓰지 못하나
//!
//! `tauri-plugin-notification` 은 알림을 띄우는 데는 충분하지만 **데스크탑에서 클릭을
//! 알려줄 수 없다.** 근거는 그 크레이트 안에 있다:
//!
//! - `src/desktop.rs` 의 `NotificationBuilder::show` 는 `title/body/icon/sound` 만
//!   `notify_rust` 로 넘기고 `extra`·`action_type_id` 를 **버린다**. 목적지를 실어 보낼
//!   자리가 없다.
//! - JS 쪽 `onAction()` 이 듣는 `actionPerformed` 채널을 등록·발신하는 코드는
//!   `src/mobile.rs` 에만 있다. macOS 에서는 리스너를 붙여도 영원히 울리지 않는다.
//!
//! 그래서 고치기 전 증상이 정확히 이것이었다: 알림을 누르면 앱이 앞으로 나오지만
//! (플러그인이 `notify_rust::set_application(bundle_id)` 를 부르므로 macOS 가 번들을
//! 활성화한다) **앱에는 아무 신호도 오지 않아** 화면이 그대로 있었다.
//!
//! ## 왜 델리게이트를 직접 잡는가 — 앞 판본은 스레드를 흘렸다
//!
//! 첫 판본은 `mac-notification-sys` 의 `wait_for_click(true)` 를 썼다. 동작은 했다
//! (실측 2026-09-07: 클릭 → 이벤트 → 이동). 그런데 **누르지 않은 알림마다 스레드가
//! 영구히 남았다.** 실측: 알림 6개를 안 누르고 두자 스레드가 27 → 34 로 늘고
//! 1분을 기다려도 32 에서 안 내려갔다. `sample` 로 뜬 스택이 이유를 그대로 보여줬다:
//!
//! ```text
//! mac_notification_sys::send_notification → rust_wait_for_notification → (condvar)
//! ```
//!
//! 그 크레이트는 배너 소멸을 `deliveredNotifications` **폴링**으로만 감지한다
//! (`objc/notify.m` 의 `wasAutoDismissed`). 배너가 알림센터로 밀려나면 그 목록에
//! **계속 남아** 있으므로 깨울 신호가 오지 않는다. 채팅 앱에서 이것은 "받은 알림 수만큼
//! 스레드가 쌓이고 앱을 다시 켤 때까지 안 줄어든다" 는 뜻이다.
//!
//! 크레이트가 대기를 끊을 수단(취소·타임아웃·delivered 제거)을 공개하지 않으므로 이것은
//! 배선 실수가 아니라 **모델이 안 맞는 것**이다: 알림당 스레드 하나를 막는 설계는 알림이
//! 드문 CLI 도구의 것이고, 이 앱의 것이 아니다.
//!
//! 그래서 `NSUserNotificationCenter` 의 델리게이트를 **직접 잡는다.** 클릭은 콜백으로
//! 오고, 대기하는 스레드는 **0개**다. 필요한 바인딩은 `objc2-foundation` 에 다 있고,
//! 그 크레이트는 이미 Tauri 가 끌고 있어 그래프가 늘지 않는다.
//!
//! ## `mac-notification-sys` 를 남겨 둔 한 가지 이유
//!
//! `set_application` 하나만 계속 쓴다. 그것이 하는 일은 알림 발신이 아니라 **`NSBundle`
//! 후킹**(`objc/notify.m::installNSBundleHook`)이다 — 번들 밖에서 뜬 개발 빌드는 자기
//! 번들 id 가 없어 `NSUserNotificationCenter` 가 알림을 아예 안 띄운다. 이 후크가 있어야
//! 개발 빌드에서도 알림 경로를 검증할 수 있다. 그 크레이트의 델리게이트는 `send_notification`
//! 을 부를 때만 세워지고 우리는 그것을 부르지 않으므로, 우리 델리게이트를 뺏길 일이 없다.

use serde::{Deserialize, Serialize};

/// 사용자가 알림을 눌렀을 때 웹뷰로 쏘는 이벤트. `src/lib/notify.ts` 의
/// `NOTIFICATION_OPEN_EVENT` 와 **같은 문자열**이어야 한다.
pub const OPEN_EVENT: &str = "notification://open";

/// 알림이 가리키는 곳. 웹뷰가 만들고, 눌리면 손대지 않고 그대로 돌려준다 —
/// Rust 는 이 값의 의미를 모른다(`src/lib/notify.ts::NotificationTarget`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTarget {
    community_id: String,
    message_id: String,
}

/// 알림을 내보낸다. **결과를 돌려주지 않는다** — 알림은 부가 기능이고, 호출부
/// (`createNotifier`)는 실패를 삼키도록 되어 있다. 여기서 `Err` 를 만들면 웹뷰가
/// 삼킬 것을 만들어 주는 일밖에 안 된다.
#[tauri::command]
pub fn notification_send(
    app: tauri::AppHandle,
    title: String,
    body: String,
    target: Option<NotificationTarget>,
) {
    #[cfg(target_os = "macos")]
    macos::send(app, title, body, target);

    #[cfg(not(target_os = "macos"))]
    other::send(app, title, body, target);
}

/// 앱 기동 때 한 번 불린다(`main.rs` 의 `setup`). macOS 밖에서는 할 일이 없다.
pub fn install(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    macos::install(app);

    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// `NSUserNotification` 계열은 macOS 11 에서 `UNUserNotificationCenter` 로 대체됐고
/// (아직 동작한다), 그래서 이 모듈은 컴파일러가 그 사실을 매 호출마다 되풀이하지 않게
/// 한 자리에서 끈다. **`UNUserNotificationCenter` 로 가지 않은 이유**는 그쪽이 서명된
/// 번들을 요구해서다: 개발 빌드(`cargo run` 으로 뜬 번들 밖 바이너리)에서는 알림이 아예
/// 안 뜨고, 그러면 알림 경로를 실물로 검증할 자리가 사라진다. 지금 이 앱이 쓰는 발신
/// 경로(`tauri-plugin-notification` → `notify_rust`)도 같은 API 위에 있으므로, 이 선택은
/// 새로 지는 빚이 아니라 **이미 서 있는 바닥을 그대로 쓰는 것**이다.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
mod macos {
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_foundation::{
        NSDictionary, NSObject, NSObjectProtocol, NSString, NSUserNotification,
        NSUserNotificationActivationType, NSUserNotificationCenter,
        NSUserNotificationCenterDelegate,
    };

    use super::{NotificationTarget, OPEN_EVENT};

    /// 목적지를 알림에 실어 나르는 `userInfo` 키. 우리 델리게이트만 읽는다.
    const TARGET_KEY: &str = "murmurTarget";

    /// 알림을 어느 앱의 것으로 띄울지. 플러그인의 `desktop.rs` 와 **같은 선택**이다 —
    /// 번들 밖에서 뜬 개발 빌드는 자기 번들 id 로 알림을 띄울 수 없다.
    ///
    /// 개발 중에는 알림이 Terminal 의 것으로 뜨므로 누르면 Terminal 이 앞으로 나온다.
    /// 그래도 델리게이트는 우리 프로세스의 것이라 **클릭 콜백은 정상으로 온다** —
    /// 화면 이동은 개발 빌드에서도 검증할 수 있고, 앞으로 나오는 앱만 다르다.
    fn bundle_identifier(app: &tauri::AppHandle) -> String {
        if tauri::is_dev() {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        }
    }

    struct Ivars {
        app: tauri::AppHandle,
    }

    define_class!(
        // SAFETY:
        // - 상위 클래스 `NSObject` 는 서브클래싱 요구사항이 없다.
        // - 이 타입은 `Drop` 을 구현하지 않는다.
        #[unsafe(super(NSObject))]
        // 델리게이트 콜백은 `NSUserNotificationCenter` 가 **메인 스레드로** 보낸다.
        // 타입에 그것을 적어 두면 다른 스레드에서 만드는 코드가 컴파일되지 않는다.
        #[thread_kind = MainThreadOnly]
        #[name = "MurmurNotificationDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            /// 사용자가 알림을 눌렀다. **여기가 이 파일의 존재 이유다.**
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(
                &self,
                center: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                // 본문 클릭과 액션 버튼만 "가겠다"는 뜻이다. `Replied`·`None` 으로 화면을
                // 옮기면 누르지 않은 알림이 화면을 끌고 간다.
                let kind = notification.activationType();
                if kind != NSUserNotificationActivationType::ContentsClicked
                    && kind != NSUserNotificationActivationType::ActionButtonClicked
                {
                    return;
                }
                let Some(target) = read_target(notification) else { return };

                // **치우는 것이 먼저다.** 아래에서 창을 활성화하는데, 알림이 센터에 남아
                // 있으면 macOS 가 그 활성화에 맞춰 같은 알림의 활성화를 **다시 전달한다** —
                // 실측(2026-09-07): 한 번 누른 클릭이 이벤트 2~3개가 되어 화면이 두 번
                // 움직였다. 순서를 바꾸면 그 되먹임이 그대로 돌아온다.
                //
                // 사용자에게도 이것이 맞다: 눌러서 그 대화로 갔으면 알림센터에 남을 이유가 없다.
                center.removeDeliveredNotification(notification);

                let app = &self.ivars().app;
                focus_main_window(app);
                {
                    use tauri::Emitter;
                    let _ = app.emit(OPEN_EVENT, target);
                }
            }

            /// 앱이 맨 앞에 있어도 배너를 띄운다.
            ///
            /// 기본값(`false`)이면 macOS 가 "앱을 보고 있으니 필요 없겠지" 하고 삼키는데,
            /// **무엇을 알릴지는 이미 웹뷰가 정한다**(`Controller.announceNewMessage` 의
            /// `document.hasFocus()` 가드). 여기서 한 번 더 판단하면 같은 질문에 두 곳이
            /// 답하게 되고, 창은 포커스가 없는데 앱은 활성인 상태에서 알림이 조용히 사라진다.
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _center: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                true
            }
        }
    );

    /// 알림에 실어 둔 목적지를 꺼낸다. 우리가 넣지 않은 알림(다른 경로로 뜬 것)은 `None` 이다.
    fn read_target(notification: &NSUserNotification) -> Option<NotificationTarget> {
        let info = notification.userInfo()?;
        let key = NSString::from_str(TARGET_KEY);
        let value = info.objectForKey(&key)?;
        // 우리가 넣은 것은 항상 `NSString` 이지만, `userInfo` 는 아무 객체나 담을 수 있는
        // 사전이다 — 다른 타입이 왔을 때 캐스트를 강행하지 않는다.
        let json = value.downcast_ref::<NSString>()?.to_string();
        serde_json::from_str(&json).ok()
    }

    /// 델리게이트를 세운다. **메인 스레드에서만** 불린다(`install` 이 그것을 보장한다).
    ///
    /// `NSUserNotificationCenter.delegate` 는 retain 하지 않는 프로퍼티라 우리가 객체를
    /// 살려 둬야 한다. 앱 수명 전체에 하나뿐이므로 **일부러 흘린다**(`forget`) — 수명을
    /// 관리할 소유자를 만드는 것보다 그 사실을 여기 적어 두는 쪽이 정확하다.
    fn set_delegate(app: &tauri::AppHandle, mtm: objc2::MainThreadMarker) {
        let delegate = Delegate::alloc(mtm).set_ivars(Ivars { app: app.clone() });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        // SAFETY: 델리게이트는 retain 되지 않는 프로퍼티이므로 객체가 센터보다 오래
        // 살아야 한다 — 바로 아래 `forget` 이 그 조건을 앱 수명으로 만든다.
        unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
        std::mem::forget(delegate);
    }

    /// `install` 이 두 번 불려도 델리게이트를 두 번 만들지 않는다.
    static INSTALLED: OnceLock<()> = OnceLock::new();

    pub fn install(app: &tauri::AppHandle) {
        // `NSBundle` 후크. 개발 빌드가 알림을 띄울 수 있게 하는 유일한 조건이고,
        // 릴리스에서는 자기 번들 id 를 그대로 넣는 것이라 아무것도 바꾸지 않는다.
        // 두 번째 호출부터 `AlreadySet` 을 돌려주므로 결과는 버린다.
        let _ = mac_notification_sys::set_application(&bundle_identifier(app));
        if INSTALLED.set(()).is_err() {
            return;
        }
        let app = app.clone();
        // `setup` 은 메인 스레드에서 돌지만 그것에 기대지 않는다 — 이 함수가 다른 자리에서
        // 불리게 되는 날 조용히 UB 가 되는 것보다, 여기서 메인 스레드로 보내는 편이 낫다.
        let _ = app.clone().run_on_main_thread(move || {
            let Some(mtm) = objc2::MainThreadMarker::new() else { return };
            set_delegate(&app, mtm);
        });
    }

    pub fn send(
        app: tauri::AppHandle,
        title: String,
        body: String,
        target: Option<NotificationTarget>,
    ) {
        // `userInfo` 는 알림을 만들 때 한 번 담기므로 여기서 직렬화한다. 실패하면 목적지
        // 없이 알린다 — 알림 자체를 잃는 것이 더 나쁘다.
        let target_json = target.as_ref().and_then(|t| serde_json::to_string(t).ok());
        // `NSUserNotification` 은 메인 스레드의 것이다. **막지 않는다** — 이 함수는
        // 커맨드 호출을 그대로 돌려보내고, 발신은 메인 루프의 다음 턴에 일어난다.
        let _ = app.run_on_main_thread(move || {
            let notification = NSUserNotification::new();
            notification.setTitle(Some(&NSString::from_str(&title)));
            notification.setInformativeText(Some(&NSString::from_str(&body)));
            if let Some(json) = target_json {
                let value = NSString::from_str(&json);
                let key = NSString::from_str(TARGET_KEY);
                let info = NSDictionary::from_slices(&[&*key], &[value.as_ref() as &objc2::runtime::AnyObject]);
                // SAFETY: `userInfo` 는 plist 로 직렬화 가능한 값만 담을 수 있다.
                // 여기 담는 것은 `NSString` 하나뿐이다.
                unsafe { notification.setUserInfo(Some(&info)) };
            }
            let center = NSUserNotificationCenter::defaultUserNotificationCenter();
            center.deliverNotification(&notification);
        });
    }

    /// macOS 가 알림 클릭에 번들을 활성화해 주지만 그것으로 **덜 되는 경우**가 있다:
    /// 창을 최소화했으면 활성화만으로는 안 보인다. 이동한 화면이 안 보이는 창에서
    /// 일어나면 사용자가 보는 것은 여전히 "아무 일도 안 났다" 다.
    fn focus_main_window(app: &tauri::AppHandle) {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod other {
    use super::NotificationTarget;

    /// macOS 밖에서는 플러그인에 그대로 맡긴다. 클릭은 받지 못한다 —
    /// 배포 대상이 `app`·`dmg` 뿐이라(`tauri.conf.json`) 이 경로에는 아직 사용자가 없고,
    /// 지금 없는 사용자를 위해 Windows/XDG 별 클릭 경로를 지어 두지 않는다.
    /// 그 플랫폼을 배포하게 되는 날 이 자리가 그 일의 위치를 가리킨다.
    pub fn send(
        app: tauri::AppHandle,
        title: String,
        body: String,
        _target: Option<NotificationTarget>,
    ) {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

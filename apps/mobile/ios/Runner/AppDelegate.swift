import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  /// 푸시 채널(`lib/push/push_platform.dart`). 엔진이 서기 전에 온 일(누른 알림)은 아래에 쌓아 두고
  /// Dart 가 `takeInitialOpen` 으로 가져간다.
  private var push: FlutterMethodChannel?
  /// 꺼진 앱을 알림으로 열었을 때의 `hk`. Dart 가 한 번 가져가면 비운다.
  private var pendingOpen: [String: Any]?
  /// 토큰을 기다리는 Dart 호출들. 시스템이 토큰(또는 실패)을 주면 한꺼번에 답한다.
  private var tokenWaiters: [FlutterResult] = []
  private var deviceToken: String?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // 누른 알림·앞에 떠 있을 때의 알림을 여기서 받는다. 엔진보다 먼저 정해야 꺼진 앱을 연 알림도 온다.
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // MARK: 원격 알림 토큰

  override func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    let hex = token.map { String(format: "%02x", $0) }.joined()
    deviceToken = hex
    let waiters = tokenWaiters
    tokenWaiters = []
    for w in waiters { w(["token": hex, "env": Self.apnsEnv]) }
  }

  override func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    let waiters = tokenWaiters
    tokenWaiters = []
    // 시뮬레이터·Push 없는 프로파일에서 온다. 토큰 없음으로 답한다 — 앱은 푸시 없이 돈다.
    for w in waiters { w(nil) }
  }

  /// 개발 빌드(Xcode)는 sandbox APNs, TestFlight·App Store 는 production 이다. 서버가 그 둘을 가른다.
  private static var apnsEnv: String {
    #if DEBUG
    return "sandbox"
    #else
    return "production"
    #endif
  }

  // MARK: 알림 표시·누름

  /// 앱이 앞에 떠 있을 때. **지금 보고 있는 그 채널·스레드의 알림만** 배너를 숨긴다 — 판단은 Dart 가 한다.
  /// Dart 가 답하지 못하면(엔진 없음·오류) 보여 준다. 숨겨서 놓치는 쪽이 더 나쁘다.
  override func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let show: UNNotificationPresentationOptions = [.banner, .list, .sound, .badge]
    guard let push = push, let hk = notification.request.content.userInfo["hk"] as? [String: Any] else {
      completionHandler(show)
      return
    }
    push.invokeMethod("shouldPresent", arguments: hk) { answer in
      completionHandler((answer as? Bool) == false ? [.badge] : show)
    }
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    // 기본 동작(알림 자체를 누름)만 받는다. 알림 액션 버튼은 v1 에 없다(security).
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
          let hk = response.notification.request.content.userInfo["hk"] as? [String: Any] else { return }
    if let push = push {
      push.invokeMethod("open", arguments: hk)
    } else {
      pendingOpen = hk
    }
  }

  private func handlePush(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) {
    let center = UNUserNotificationCenter.current()
    switch call.method {
    case "status":
      center.getNotificationSettings { settings in
        let s: String
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: s = "authorized"
        case .denied: s = "denied"
        default: s = "notDetermined"
        }
        DispatchQueue.main.async { result(s) }
      }
    case "request":
      center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
        DispatchQueue.main.async { result(granted) }
      }
    case "token":
      if let t = deviceToken {
        result(["token": t, "env": Self.apnsEnv])
        return
      }
      tokenWaiters.append(result)
      UIApplication.shared.registerForRemoteNotifications()
    case "takeInitialOpen":
      result(pendingOpen)
      pendingOpen = nil
    case "setBadge":
      let n = (call.arguments as? Int) ?? 0
      if #available(iOS 16.0, *) {
        center.setBadgeCount(n)
      } else {
        UIApplication.shared.applicationIconBadgeNumber = n
      }
      result(nil)
    case "wasPrompted":
      result(UserDefaults.standard.bool(forKey: "harkroom.push.prompted"))
    case "markPrompted":
      UserDefaults.standard.set(true, forKey: "harkroom.push.prompted")
      result(nil)
    case "openSettings":
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    // 첨부 시트가 [사진 찍기] 줄을 잠글지 묻는다(`lib/screens/attach_pickers.dart`).
    // Dart 쪽에서는 못 가른다 — iOS 의 `Platform.environment` 는 빈 맵이다.
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "HarkroomDevice") else { return }
    let pushChannel = FlutterMethodChannel(name: "harkroom/push", binaryMessenger: registrar.messenger())
    pushChannel.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { result(nil); return }
      self.handlePush(call, result)
    }
    push = pushChannel

    let device = FlutterMethodChannel(name: "harkroom/device", binaryMessenger: registrar.messenger())
    device.setMethodCallHandler { call, result in
      switch call.method {
      case "hasCamera":
        // 시뮬레이터는 사양대로 잠근다. iOS 26.5 시뮬레이터는 `isSourceTypeAvailable(.camera)`
        // 에 true 를 준다(실측) — 그 값만 믿으면 시뮬레이터에서도 줄이 열린다.
        #if targetEnvironment(simulator)
        result(false)
        #else
        result(UIImagePickerController.isSourceTypeAvailable(.camera))
        #endif
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }
}

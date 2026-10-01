import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    // 첨부 시트가 [사진 찍기] 줄을 잠글지 묻는다(`lib/screens/attach_pickers.dart`).
    // Dart 쪽에서는 못 가른다 — iOS 의 `Platform.environment` 는 빈 맵이다.
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "HarkroomDevice") else { return }
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

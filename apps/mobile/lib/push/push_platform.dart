import 'package:flutter/services.dart';

/// 이 기기의 알림 권한 상태.
enum PushPermission { notDetermined, denied, authorized }

/// 시스템이 준 APNs 토큰과 그 토큰이 속한 APNs 환경(개발 빌드 = sandbox).
class PushDeviceToken {
  const PushDeviceToken(this.token, this.env);
  final String token;
  final String env;
}

/// iOS 의 알림 표면. 실물은 [MethodChannelPush](네이티브 `AppDelegate.swift` 의 `harkroom/push`),
/// 시험은 가짜를 넣는다.
///
/// FCM·플러그인을 쓰지 않는다(결정 8) — 필요한 것은 권한·토큰·누름 셋이고, 시스템 API 로 바로 된다.
abstract class PushPlatform {
  Future<PushPermission> status();

  /// OS 권한 창을 띄운다. 허락하면 `true`.
  Future<bool> request();

  /// 토큰. 시뮬레이터·Push 없는 프로파일이면 `null`.
  Future<PushDeviceToken?> token();

  /// 꺼진 앱을 알림으로 열었으면 그 알림의 `hk`(한 번만 준다).
  Future<Map<String, Object?>?> takeInitialOpen();

  Future<void> setBadge(int count);

  /// 첫 로그인 뒤 안내 시트를 이미 띄웠나. 기기에 남는다(앱을 지우면 사라진다).
  Future<bool> wasPrompted();
  Future<void> markPrompted();

  Future<void> openSettings();

  /// 앱이 떠 있는 동안 누른 알림의 `hk`, 그리고 앞에 떠 있을 때 온 알림을 보일지 묻는 물음.
  /// `shouldPresent` 가 `false` 를 주면 배너를 숨긴다.
  void listen({
    required void Function(Map<String, Object?> hk) onOpen,
    required bool Function(Map<String, Object?> hk) shouldPresent,
  });
}

class MethodChannelPush implements PushPlatform {
  MethodChannelPush([MethodChannel? channel]) : _ch = channel ?? const MethodChannel('harkroom/push');

  final MethodChannel _ch;

  static Map<String, Object?>? _map(Object? v) =>
      v is Map ? v.map((k, val) => MapEntry('$k', val)) : null;

  @override
  Future<PushPermission> status() async => switch (await _ch.invokeMethod<String>('status')) {
        'authorized' => PushPermission.authorized,
        'denied' => PushPermission.denied,
        _ => PushPermission.notDetermined,
      };

  @override
  Future<bool> request() async => (await _ch.invokeMethod<bool>('request')) ?? false;

  @override
  Future<PushDeviceToken?> token() async {
    final m = _map(await _ch.invokeMethod<Object?>('token'));
    final t = m?['token'];
    final env = m?['env'];
    return t is String && env is String ? PushDeviceToken(t, env) : null;
  }

  @override
  Future<Map<String, Object?>?> takeInitialOpen() async => _map(await _ch.invokeMethod<Object?>('takeInitialOpen'));

  @override
  Future<void> setBadge(int count) => _ch.invokeMethod<void>('setBadge', count);

  @override
  Future<bool> wasPrompted() async => (await _ch.invokeMethod<bool>('wasPrompted')) ?? false;

  @override
  Future<void> markPrompted() => _ch.invokeMethod<void>('markPrompted');

  @override
  Future<void> openSettings() => _ch.invokeMethod<void>('openSettings');

  @override
  void listen({
    required void Function(Map<String, Object?> hk) onOpen,
    required bool Function(Map<String, Object?> hk) shouldPresent,
  }) {
    _ch.setMethodCallHandler((call) async {
      final hk = _map(call.arguments);
      if (hk == null) return null;
      switch (call.method) {
        case 'open':
          onOpen(hk);
          return null;
        case 'shouldPresent':
          return shouldPresent(hk);
      }
      return null;
    });
  }
}

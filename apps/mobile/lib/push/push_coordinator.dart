import 'dart:async';

import 'package:flutter/widgets.dart';

import '../state/app_state.dart' show AppPhase, AppState;
import 'push_platform.dart';
import 'push_target.dart';

/// 푸시의 앱 쪽 일을 모은다 — 기기 등록, 알림 누름, 배지.
///
/// - **등록:** 권한이 있으면 로그인해 둔 커뮤니티마다(만료 제외) `PUT /push/devices` 를 한다.
///   커뮤니티마다 서버가 따로라 등록도 따로다. 같은 (커뮤니티, 토큰, 기기 토큰) 은 한 번만 보낸다.
///   해제는 로그아웃·커뮤니티 제거가 한다([AppState] 의 `_revoke`).
/// - **누름:** [resolvePushTarget] 이 정한 곳만 연다. 다른 커뮤니티면 먼저 옮긴다. 화면을 여는 것은
///   [PushGate] 가 [pending] 을 가져가서 한다.
/// - **배지:** 지금 커뮤니티의 안 읽은 부름 + 다른 커뮤니티의 기다리는 수.
/// 위젯 트리에서 [PushCoordinator] 를 찾는다(나 화면의 「알림」 줄). 시험처럼 푸시가 없으면 null 이다.
class PushScope extends InheritedNotifier<PushCoordinator> {
  const PushScope({super.key, required PushCoordinator? push, required super.child}) : super(notifier: push);

  static PushCoordinator? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PushScope>()?.notifier;
}

class PushCoordinator extends ChangeNotifier {
  PushCoordinator(this.app, this.platform) {
    platform.listen(onOpen: open, shouldPresent: shouldPresent);
    app.addListener(_onApp);
    _lifecycle = AppLifecycleListener(onResume: resumed);
  }

  late final AppLifecycleListener _lifecycle;

  final AppState app;
  final PushPlatform platform;

  /// 열어야 할 곳. 그 커뮤니티로 들어간 뒤 [PushGate] 가 가져간다.
  PushTarget? pending;

  /// 이 기기의 알림 권한(모르면 null). 나 화면의 「알림」 줄이 읽는다.
  PushPermission? permission;

  /// 푸시를 끈 커뮤니티의 열쇠(M4). 이 커뮤니티 서버에는 등록하지 않는다.
  Set<String> muted = {};

  final Set<String> _registered = {};
  int? _badge;
  bool _started = false;

  /// 앱이 처음 준비되면 부른다. 꺼진 앱을 연 알림이 있으면 그것부터 처리한다.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      muted = await platform.mutedCommunities();
    } on Object {
      // 채널 없음 — 끈 커뮤니티 없음으로 둔다.
    }
    await refreshPermission();
    try {
      final initial = await platform.takeInitialOpen();
      if (initial != null) await open(initial);
    } on Object {
      // 엔진이 없는 시험 환경 등 — 알림이 없는 것과 같다.
    }
    await sync();
  }

  /// 앱이 다시 앞에 왔다. 배경에 있는 동안 아이콘 배지는 **푸시가 실어 온 그 서버의 수**로 덮였다
  /// (서버마다 따로 센다). 돌아오면 받은 것을 다시 읽고 배지를 이 앱이 아는 합으로 다시 세운다 —
  /// 값이 같아 보여도 한 번은 OS 에 다시 적는다.
  ///
  /// 다시 읽기가 실패해도(망 없음·서버 오류) 던지지 않는다 — lifecycle 콜백에서 새면 처리되지 않은
  /// Future 오류가 된다(security #1087). 배지는 아는 값으로라도 다시 적는다.
  Future<void> resumed() async {
    _badge = null;
    // 설정 앱에서 권한을 바꾸고 돌아왔을 수 있다.
    await refreshPermission();
    if (app.phase != AppPhase.ready) return;
    try {
      await app.loadInbox();
      await app.refreshOtherCounts();
    } on Object {
      // 다음에 다시 읽는다.
    }
    _onApp();
  }

  Future<void> refreshPermission() async {
    PushPermission? next;
    try {
      next = await platform.status();
    } on Object {
      next = null;
    }
    if (next != permission) {
      permission = next;
      notifyListeners();
    }
  }

  /// 이 커뮤니티의 알림을 켜고 끈다(M4). 끄면 그 서버에 등록을 풀고(`DELETE /push/devices/current`) 다시
  /// 등록하지 않는다. 남은 커뮤니티 수가 바뀌면 배지 설정도 달라지므로 다시 맞춘다.
  Future<void> setCommunityEnabled(String key, bool enabled) async {
    final next = {...muted};
    enabled ? next.remove(key) : next.add(key);
    muted = next;
    notifyListeners();
    try {
      await platform.setMutedCommunities(next);
    } on Object {
      // 기기에 못 적으면 이번 실행 동안만 유지된다.
    }
    _registered.removeWhere((m) => m.startsWith('$key|'));
    if (!enabled) {
      final c = app.communities.where((c) => c.key == key).firstOrNull;
      if (c != null && !c.isExpired) {
        try {
          await app.apiFor(c).unregisterPushDevice().timeout(const Duration(seconds: 5));
        } on Object {
          // 못 풀면 그 서버는 세션이 끝날 때까지 보낸다. 다시 끄면 다시 시도한다.
        }
      }
    }
    await sync();
  }

  void _onApp() {
    if (app.phase != AppPhase.ready) return;
    unawaited(sync());
    final badge = app.inboxUnread + app.otherWaiting.values.fold<int>(0, (a, b) => a + b);
    if (badge != _badge) {
      _badge = badge;
      unawaited(platform.setBadge(badge).catchError((Object _) {}));
    }
  }

  /// 권한이 있으면 아직 등록하지 않은 커뮤니티를 등록한다. 실패는 다음 기회(앱 상태 변화)에 다시 한다.
  /// 옛 서버(라우트 없음, 404)·거절(403)도 조용히 넘어간다 — 푸시가 안 될 뿐 앱은 돈다.
  ///
  /// 차례로 돈다: 앞 차례가 돌고 있으면 그것이 끝난 뒤 한 번 더 돈다. 부른 쪽은 **자기 차례가 끝날 때까지**
  /// 기다린다 — 끈 커뮤니티를 바꾼 직후 부르면 바뀐 목록으로 돈 결과를 받는다.
  Future<void> sync() {
    final next = _chain.then((_) => _syncOnce());
    _chain = next.catchError((Object _) {});
    return next;
  }

  Future<void> _chain = Future<void>.value();

  Future<void> _syncOnce() async {
    try {
      if (await platform.status() != PushPermission.authorized) return;
      final device = await platform.token();
      if (device == null) return;
      final receiving = app.communities.where((c) => !c.isExpired && !muted.contains(c.key)).toList();
      // 둘 이상이면 서버마다 배지를 적게 두지 않는다 — 한 서버는 자기 수만 알아서, 배경의 알림 하나가
      // 배지를 합계보다 줄인다(designer #1087). 그때는 앱이 앞에 올 때 합계로 적는다.
      final serverBadge = receiving.length < 2;
      for (final c in receiving) {
        final mark = '${c.key}|${c.token}|${device.token}|$serverBadge';
        if (_registered.contains(mark)) continue;
        try {
          await app.apiFor(c).registerPushDevice(token: device.token, env: device.env, badge: serverBadge);
          _registered.removeWhere((m) => m.startsWith('${c.key}|'));
          _registered.add(mark);
        } on Object {
          // 다음 기회에 다시 한다.
        }
      }
    } on Object {
      // 채널 없음(시험·시뮬레이터) — 푸시 없이 돈다.
    }
  }

  /// 안내 시트의 [켜기]. OS 권한 창을 띄우고, 허락하면 바로 등록한다.
  Future<bool> enable() async {
    await platform.markPrompted();
    final granted = await platform.request();
    await refreshPermission();
    if (granted) await sync();
    return granted;
  }

  /// 알림을 눌렀다.
  Future<void> open(Map<String, Object?> hk) async {
    final target = resolvePushTarget(hk, app.communities);
    if (target == null) return;
    pending = target;
    if (target.communityKey != app.activeKey || app.phase != AppPhase.ready) {
      final ok = await app.switchTo(target.communityKey);
      if (!ok) {
        // 만료된 커뮤니티 등 — 들어가지 못했으면 열 곳도 없다.
        if (identical(pending, target)) pending = null;
        return;
      }
    }
    notifyListeners();
  }

  /// [PushGate] 가 지금 열 것을 가져간다. 지금 커뮤니티의 것만 준다.
  PushTarget? takePending() {
    final t = pending;
    if (t == null || t.communityKey != app.activeKey || app.phase != AppPhase.ready) return null;
    pending = null;
    return t;
  }

  /// 앱이 앞에 떠 있을 때 온 알림을 보일지. **지금 보고 있는 그 채널의 알림만** 숨긴다(스레드 답글은
  /// 채널 화면에 안 보이므로 보인다).
  bool shouldPresent(Map<String, Object?> hk) {
    final target = resolvePushTarget(hk, app.communities);
    if (target == null) return true;
    final viewing = target.communityKey == app.activeKey &&
        app.openChannelId == target.channelId &&
        target.threadRootId == null;
    return !viewing;
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    app.removeListener(_onApp);
    super.dispose();
  }
}

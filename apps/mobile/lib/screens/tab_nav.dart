import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../state/app_scope.dart';
import '../state/app_state.dart';

/// 탭마다 자기 화면 쌓기(Navigator)를 둔다 — 하단 탭 바가 채널·스레드 안에서도 남게
/// (하단 네비 고정 D1·D2, 2026-10-14 소유자 「전부 A」).
///
/// 전에는 채널·스레드·인박스 상세가 **루트** Navigator 에 밀려 들어가 탭 바를 덮었다. 이제 탭 안에서
/// `Navigator.of(context)` 는 그 탭의 쌓기를 집는다 — 목록 → 채널 → 스레드는 그대로 두면 된다.
///
/// 전체 화면으로 떠야 하는 것은 두 갈래다:
/// - 미리보기·Lightbox·설정류·시트 — [pushRoot]·`useRootNavigator: true` 로 루트에 띄워 탭 바를 덮는다.
/// - 찾기 — 결과를 열고 뒤로 오면 결과가 남아야 하므로 **지금 탭의 쌓기**에 [BarlessPageRoute] 로 민다.
///   그 경로가 맨 위인 동안 탭 바를 숨긴다([barHidden]). 결과로 연 스레드는 그 위에 쌓여 탭 바가 돌아온다.
///
/// 탭 **밖**(부팅·푸시)에서 채널을 여는 길은 [openChannelScreen] 하나로 모은다.
class TabNavigators {
  TabNavigators();

  static const count = 4;
  static const home = 0;
  static const dms = 1;

  /// 지금 떠 있는 홈 화면의 쌓기. 홈 위(PushGate)·루트 화면(설정·미리보기)은 트리에서 이것을 못 찾는다.
  /// 홈이 없으면(로그인 전·시험) null — 그때 [openChannelScreen] 은 건네받은 Navigator 에 민다.
  static TabNavigators? active;

  final keys = List.generate(count, (i) => GlobalKey<NavigatorState>(debugLabel: 'tab-$i'));

  /// 탭마다 맨 위 경로를 지켜보는 눈 — 맨 위가 [BarlessPageRoute] 면 그 탭에서 탭 바를 숨긴다.
  late final observers = List.generate(count, (_) => _TopObserver());

  /// 그 탭의 맨 위가 탭 바를 숨기는 화면(찾기)인가.
  ValueListenable<bool> barHidden(int tab) => observers[tab].barless;

  /// 탭마다 맨 위로 굴리는 손잡이(D4 — 뿌리에서 한 번 더 누르면 맨 위로). 그 탭 뿌리 목록이
  /// [PrimaryScrollController] 로 이것을 집는다.
  final scrolls = List.generate(count, (_) => ScrollController());

  NavigatorState? navigator(int tab) => keys[tab].currentState;

  /// 탭 쌓기 넷을 모두 뿌리로 — 커뮤니티를 옮기거나 푸시로 들어올 때 앞 화면을 남기지 않는다.
  void popAll() {
    for (final k in keys) {
      k.currentState?.popUntil((r) => r.isFirst);
    }
  }

  void dispose() {
    for (final s in scrolls) {
      s.dispose();
    }
    for (final o in observers) {
      o.barless.dispose();
    }
  }
}

/// 탭 쌓기 안에 띄우되 **탭 바를 숨기는** 화면(찾기). 루트로 올리지 않는 까닭: 결과로 연 스레드에서
/// 뒤로 오면 결과가 그대로 남아야 한다 — 루트와 탭 쌓기는 서로 다른 쌓기라 그 사이를 오갈 수 없다.
class BarlessPageRoute<T> extends MaterialPageRoute<T> {
  BarlessPageRoute({required super.builder, super.settings});
}

class _TopObserver extends NavigatorObserver {
  final barless = ValueNotifier<bool>(false);
  Route<dynamic>? _top;

  void _set(Route<dynamic>? top) {
    _top = top;
    // 첫 경로는 Navigator 의 build 안에서 들어온다 — 값이 그대로면 알리지 않는다(뿌리는 늘 false).
    barless.value = top is BarlessPageRoute;
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _set(route);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (identical(route, _top)) _set(previousRoute);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (identical(route, _top)) _set(previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    if (identical(oldRoute, _top)) _set(newRoute);
  }
}

/// 찾기처럼 탭 바를 숨기는 화면을 민다.
/// - 탭 안(채널·스레드 머리의 돋보기)이면 그 탭 쌓기에.
/// - 홈 바깥 막대(찾기 버튼)면 **지금 탭**의 쌓기에.
/// - 루트에 이미 무엇이 떠 있으면(설정·미리보기) 그 위에 — 탭 쌓기에 밀면 덮인 채 안 보인다.
/// 홈이 없으면(로그인 전·시험) 가까운 Navigator 에.
Future<T?> pushBarless<T>(BuildContext context, WidgetBuilder builder) {
  final own = Navigator.of(context);
  final tabs = TabNavigators.active;
  if (tabs == null || tabs.keys.any((k) => k.currentState == own)) {
    return own.push(BarlessPageRoute<T>(builder: builder));
  }
  final root = Navigator.of(context, rootNavigator: true);
  final nav = root.canPop() ? null : tabs.navigator(AppScope.read(context).homeTab.clamp(0, TabNavigators.count - 1));
  return (nav ?? own).push(BarlessPageRoute<T>(builder: builder));
}

/// 그 채널이 사는 탭 — DM 은 DM 탭, 나머지는 홈.
int tabForChannel(AppState app, String channelId) {
  for (final c in app.channels) {
    if (c.id == channelId) return c.isDm ? TabNavigators.dms : TabNavigators.home;
  }
  return TabNavigators.home;
}

/// 루트 화면(찾기·미리보기·Lightbox·설정류)을 연다 — 탭 바를 덮는다.
Future<T?> pushRoot<T>(BuildContext context, Route<T> route) =>
    Navigator.of(context, rootNavigator: true).push(route);

/// 루트 쌓기 위의 것을 걷어낸다(찾기·시트·설정). 탭 쌓기는 그대로.
void popRootToHome(BuildContext context) =>
    Navigator.of(context, rootNavigator: true).popUntil((r) => r.isFirst);

/// 채널·스레드 화면을 연다.
///
/// - 탭 **안**에서 부르면 그 탭 쌓기에 민다 — 인박스에서 연 스레드는 인박스 탭에 남는다.
/// - 탭 **밖**(찾기 화면·푸시·부팅)에서 부르면 루트 위의 것을 걷고, 그 채널이 사는 탭을 골라
///   그 쌓기에 민다. [navigator] 를 주면(PushGate 처럼 홈 위에 있는 쪽) 그것을 탭 밖으로 본다.
Future<void> openChannelScreen(
  BuildContext context,
  String channelId,
  WidgetBuilder builder, {
  NavigatorState? navigator,
}) async {
  final nav = navigator ?? Navigator.of(context);
  final tabs = TabNavigators.active;
  final inTab = tabs != null && tabs.keys.any((k) => k.currentState == nav);
  final app = AppScope.read(context);
  final tab = tabForChannel(app, channelId);
  final target = tabs?.navigator(tab);
  // 탭 쌓기가 아직 붙지 않은 프레임(홈이 막 선 때)이면 건네받은 쪽에 민다 — 조용히 버리면 알림 탭이
  // 아무 일도 안 한 것이 된다(security #1368 n1).
  if (tabs == null || inTab || target == null) {
    await nav.push(MaterialPageRoute<void>(builder: builder));
    return;
  }
  Navigator.of(context, rootNavigator: true).popUntil((r) => r.isFirst);
  app.selectTab(tab);
  await target.push(MaterialPageRoute<void>(builder: builder));
}

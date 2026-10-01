import 'package:flutter/widgets.dart';

import 'app_state.dart';

/// [AppState] 를 위젯 나무에 건다.
///
/// `InheritedNotifier` 라 **값이 바뀌면 이것을 읽는 위젯만** 다시 그린다. 전역 변수로
/// 두면 상태가 바뀌어도 화면이 모르고, 매번 `setState` 를 부르면 안 바뀐 화면까지 다시
/// 그린다 — 메시지가 초당 몇 개씩 들어오는 화면에서 그 차이는 눈에 보인다.
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child})
      : super(notifier: state);

  static AppState of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope?.notifier != null, 'AppScope 가 위젯 나무에 없다 — 앱 루트에 두어야 한다.');
    return scope!.notifier!;
  }

  /// **구독하지 않고** 읽는다. 스크롤 듣기처럼 빌드 밖에서 부를 때 쓴다 — 거기서 [of] 를 부르면
  /// 의존이 빌드 밖에서 생긴다.
  static AppState read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<AppScope>();
    assert(scope?.notifier != null, 'AppScope 가 위젯 나무에 없다 — 앱 루트에 두어야 한다.');
    return scope!.notifier!;
  }
}

extension AppScopeContext on BuildContext {
  AppState get app => AppScope.of(this);
}

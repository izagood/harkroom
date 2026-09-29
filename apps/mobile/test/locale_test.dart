import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';

/// **한국어 기기에서 앱이 뜨는가.**
///
/// ## 왜 이 시험이 따로 있나 — 나머지 160개가 놓쳤다
///
/// 위젯 시험 바인딩의 기본 로케일은 **영어**다. 그래서 Flutter 가 기본으로 끼워 주는
/// `DefaultMaterialLocalizations`(영어 한 벌)로 전부 덮였고, `localizationsDelegates` 가
/// 통째로 빠져 있는데도 시험은 초록이었다.
///
/// 실제 시뮬레이터(`ko-KR`)에 처음 띄웠을 때 드러났다 — **첫 화면이 빨간 오류**였다:
/// *"No MaterialLocalizations found. AppBar widgets require MaterialLocalizations…"*
///
/// 기기 언어가 한국어인 사람에게는 **앱이 아예 안 뜬다**는 뜻이다. 그래서 여기서
/// **로케일을 직접 지정해** 그 경로를 돌린다.
void main() {
  AppState state() => AppState(
        sessions: SessionStore.inMemory(),
        connector: (Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다'),
      );

  for (final locale in supportedLocales) {
    testWidgets('${locale.languageCode} 로 앱이 오류 없이 뜬다', (tester) async {
      // 기기 언어를 그 언어로 고정한다. `supportedLocales` 에 있다고 뜨는 것이 아니라,
      // 그 언어의 **Material 문구**를 주는 delegate 가 있어야 뜬다.
      tester.platformDispatcher.localesTestValue = [locale];
      addTearDown(tester.platformDispatcher.clearLocalesTestValue);

      final app = state();
      addTearDown(app.dispose);
      await tester.pumpWidget(HarkroomApp(state: app));
      await tester.pumpAndSettle();

      // 빨간 오류 화면이 뜨면 여기서 잡힌다.
      expect(tester.takeException(), isNull);
      // 그 언어의 문구가 실제로 섰는지도 본다 — delegate 만 있고 우리 문구가 안 서면
      // 그것도 반쪽이다.
      expect(find.text(stringsFor(locale.languageCode).connectTitle), findsOneWidget);
    });
  }

  testWidgets('모르는 기기 언어는 영어로 떨어지고, 그래도 뜬다', (tester) async {
    tester.platformDispatcher.localesTestValue = const [Locale('ja')];
    addTearDown(tester.platformDispatcher.clearLocalesTestValue);

    final app = state();
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text(stringsFor('en').connectTitle), findsOneWidget);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/connect/connect_screen.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';

/// 화면이 **문구를 짓지 않고 고르는지** 본다. 버튼·입력칸은 글자가 아니라
/// `Key` 로 집는다 — 문구로 집으면 번역을 고칠 때마다 시험이 깨진다.
/// 주소가 통과하면 화면이 `context.app.setServer` 를 부른다 — 그래서 시험도 상태를
/// 달아 줘야 한다. 소켓은 열지 않는다.
AppState _state() => AppState(
      sessions: SessionStore.inMemory(),
      apiFactory: (base, token) => ApiClient(baseUrl: base, token: token),
      connector: (Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다'),
    );

Widget _app(String localeCode, [AppState? state]) => MaterialApp(
      // 배포되는 것과 같은 테마를 쓴다 — 갈라지면 시험이 다른 앱을 보게 된다.
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor(localeCode),
        child: AppScope(state: state ?? _state(), child: const ConnectScreen()),
      ),
    );

void main() {
  testWidgets('http:// 를 넣으면 ATS 사유를 말한다 (en)', (tester) async {
    await tester.pumpWidget(_app('en'));
    await tester.enterText(
        find.byKey(const Key('connect-server-url')), 'http://example.com');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pump();

    expect(find.text(stringsFor('en').connectErrorInsecure), findsOneWidget);
  });

  testWidgets('같은 오류가 한국어로도 선다', (tester) async {
    await tester.pumpWidget(_app('ko'));
    await tester.enterText(
        find.byKey(const Key('connect-server-url')), 'http://example.com');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pump();

    expect(find.text(stringsFor('ko').connectErrorInsecure), findsOneWidget);
  });

  testWidgets('https 주소는 오류 없이 통과하고 **다음 단계로 상태를 옮긴다**', (tester) async {
    final state = _state();
    await tester.pumpWidget(_app('en', state));
    await tester.enterText(
        find.byKey(const Key('connect-server-url')), 'https://example.com/');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pump();

    expect(find.text(stringsFor('en').connectErrorInsecure), findsNothing);
    expect(find.text(stringsFor('en').connectErrorMalformed), findsNothing);
    // 화면이 `Navigator` 를 부르지 않는다 — 어느 화면을 세울지는 상태 하나가 정한다.
    expect(state.phase, AppPhase.needsLogin);
    // 끝 슬래시는 떨어진 채로 저장된다.
    expect(state.baseUrl, 'https://example.com');
  });
}

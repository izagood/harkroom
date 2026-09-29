import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/connect/connect_screen.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:integration_test/integration_test.dart';

/// **진짜 기기(시뮬레이터)에서 도는 시험.**
///
/// ## 왜 위젯 시험만으로는 모자란가
///
/// 위젯 시험 160개가 전부 초록인데도 시뮬레이터에 처음 띄웠을 때 **첫 화면이 빨간
/// 오류**였다(`No MaterialLocalizations found` — 기기 언어가 한국어였다). 위젯 시험은
/// 기본 로케일이 영어라 그 경로를 한 번도 안 지났다.
///
/// 그런 것들 — 로케일, 플러그인 채널(Keychain·파일 고르기), ATS — 은 **진짜 런타임에서만**
/// 드러난다. 이 파일은 자격증명 없이 갈 수 있는 데까지를 그 런타임에서 돈다.
///
/// 돌리는 법: 시뮬레이터를 띄운 뒤
/// `flutter test integration_test/app_boots_test.dart`
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  AppState state() => AppState(
        // 키체인 대신 메모리를 쓴다 — 시험이 기기의 진짜 세션을 건드리지 않게.
        sessions: SessionStore.inMemory(),
        connector: (Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다'),
      );

  testWidgets('앱이 기기 언어로 오류 없이 뜬다', (tester) async {
    final app = state();
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await tester.pumpAndSettle();

    // 빨간 오류 화면이면 여기서 잡힌다 — 이 줄이 이 파일의 이유다.
    expect(tester.takeException(), isNull);
    expect(find.byType(ConnectScreen), findsOneWidget);
  });

  testWidgets('평문 http 주소는 저장 전에 사유와 함께 거절된다', (tester) async {
    // ATS 는 사유 없는 "연결 실패" 만 돌려주므로 앱이 먼저 말해야 한다.
    final app = state();
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('connect-server-url')), 'http://example.com');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pumpAndSettle();

    final t = stringsFor(WidgetsBinding.instance.platformDispatcher.locale.languageCode);
    expect(find.text(t.connectErrorInsecure), findsOneWidget);
    expect(app.phase, AppPhase.needsServer);
  });

  testWidgets('https 주소를 넣으면 로그인 화면으로 넘어간다', (tester) async {
    final app = state();
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await tester.pumpAndSettle();

    await tester.enterText(
        find.byKey(const Key('connect-server-url')), 'https://example.com/');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pumpAndSettle();

    expect(app.phase, AppPhase.needsLogin);
    // 끝 슬래시는 떨어진 채로 저장된다.
    expect(app.baseUrl, 'https://example.com');
    expect(find.byKey(const Key('login-submit')), findsOneWidget);
  });

  testWidgets('키체인 보관소가 기기에서 실제로 읽고 쓴다', (tester) async {
    // 플러그인 채널이 붙어 있는지 보는 것이 목적이다 — 위젯 시험에서는 이 경로가
    // 통째로 가짜였다. 앱의 진짜 세션과 섞이지 않게 **쓰고 나서 지운다.**
    final store = SessionStore.keychain();
    addTearDown(store.clear);

    await store.save(const StoredSessions(active: 'probe', communities: [
      StoredCommunity(
        accountId: 'probe',
        baseUrl: 'https://example.com',
        token: 'probe-token',
        handle: 'probe',
      ),
    ]));
    final loaded = await store.load();
    expect(loaded?.current?.accountId, 'probe');
  });
}

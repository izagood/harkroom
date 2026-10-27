import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:integration_test/integration_test.dart';

/// **페르소나별 한 바퀴** — 스토리보드(`packages/e2e/stories`)의 사람 유형마다 같은 앱이 다른 것을
/// 보여 주는지 본다. `live_tour_test.dart` 는 계정 하나로 "되는 것"을 돌고, 이 파일은 **권한 차이**를 돈다.
///
/// 시험 커뮤니티(매 회 시드된 `e2e-*` 계정)에서 페르소나 하나씩 돌린다. 값은 `--dart-define` 으로 받는다 —
/// 비밀번호는 파일에 두지 않는다. `E2E_SERVER` 가 비면 통째로 건너뛴다(CI 에는 시험 테넌트가 없다).
///
/// ```
/// flutter test integration_test/persona_test.dart \
///   --dart-define=E2E_SERVER=https://<시험 커뮤니티> \
///   --dart-define=E2E_PERSONA=P4 --dart-define=E2E_LOGIN=e2e-member --dart-define=E2E_PASSWORD=... \
///   --dart-define=E2E_ADMIN_LOGIN=e2e-admin --dart-define=E2E_ADMIN_PASSWORD=... \
///   --dart-define=E2E_CHANNEL=<공개 채널 id>
/// ```
///
/// 옆 통로(side)는 **관리자**로 로그인한 API 클라이언트다. 페르소나가 아닌 사람의 글을 넣어야 "남의 글"
/// 판정을 볼 수 있다. 넣은 글은 끝나면 지운다.
const _server = String.fromEnvironment('E2E_SERVER');
const _persona = String.fromEnvironment('E2E_PERSONA');
const _login = String.fromEnvironment('E2E_LOGIN');
const _password = String.fromEnvironment('E2E_PASSWORD');
const _adminLogin = String.fromEnvironment('E2E_ADMIN_LOGIN');
const _adminPassword = String.fromEnvironment('E2E_ADMIN_PASSWORD');
const _channel = String.fromEnvironment('E2E_CHANNEL');

/// 페르소나 → 역할. `packages/e2e/stories/personas.yaml` 과 같은 값이어야 한다 — 기기에서는 YAML 을 못 읽어
/// 여기 옮겨 두고, `packages/e2e/test/stories.test.ts` 가 두 곳이 같은지 검사한다.
const _personaRoles = <String, String>{
  'P2': 'admin',
  'P4': 'member',
  'P5': 'member',
  'P6': 'guest',
  'P8': 'member',
};

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final role = _personaRoles[_persona];
  final skip = _server.isEmpty;

  setUpAll(() {
    if (!skip && role == null) fail('E2E_PERSONA=$_persona 는 모르는 페르소나다(${_personaRoles.keys})');
  });

  testWidgets('$_persona: 서버가 보는 역할이 스토리보드와 같다', skip: skip, (tester) async {
    final me = ApiClient(baseUrl: _server);
    me.token = await me.login(_login, _password);
    final view = await me.me();
    expect(view.handle, _login);
    // MeView 는 아직 isAdmin 만 싣는다 — admin(과 owner) 여부로 대조한다.
    expect(view.isAdmin, role == 'admin', reason: '$_login 의 isAdmin');
  });

  testWidgets('$_persona: 남의 글 지우기는 admin 에게만 보인다', skip: skip, (tester) async {
    WidgetController.hitTestWarningShouldBeFatal = true;
    final nonce = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
    final side = ApiClient(baseUrl: _server);
    side.token = await side.login(_adminLogin, _adminPassword);
    final others = await side.postMessage(_channel, 'e2e persona $nonce');
    addTearDown(() => side.deleteMessage(_channel, others.id));

    final app = AppState(sessions: SessionStore.inMemory());
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await _signIn(tester);

    await _until(tester, find.byKey(Key('channel-$_channel')));
    await _tap(tester, find.byKey(Key('channel-$_channel')));
    final press = find.byKey(Key('message-press-${others.id}'));
    await _until(tester, press);
    await tester.ensureVisible(press);
    await tester.longPress(press);
    // 동작 시트가 뜬 것은 "답글"로 안다 — 누구에게나 있는 동작이다.
    await _until(tester, find.byKey(const Key('message-action-reply')));
    final delete = find.byKey(const Key('message-action-delete'));
    expect(delete, role == 'admin' ? findsOneWidget : findsNothing,
        reason: '$_persona($role) 에게 남의 글 [지우기]');
  });
}

Future<void> _signIn(WidgetTester tester) async {
  await _until(tester, find.byKey(const Key('connect-server-url')));
  await tester.enterText(find.byKey(const Key('connect-server-url')), _server);
  await _tap(tester, find.byKey(const Key('connect-continue')));
  await _until(tester, find.byKey(const Key('login-id')));
  await tester.enterText(find.byKey(const Key('login-id')), _login);
  await tester.enterText(find.byKey(const Key('login-password')), _password);
  await _tap(tester, find.byKey(const Key('login-submit')));
}

/// `live_tour_test.dart` 와 같은 이유로 `pumpAndSettle` 대신 프레임을 돌리며 기다린다(진짜 소켓이 열려 있다).
Future<void> _until(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 20),
}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('나타나지 않았다: $finder');
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.pump(const Duration(milliseconds: 400));
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(milliseconds: 100));
  await tester.tap(finder);
  await tester.pump();
}

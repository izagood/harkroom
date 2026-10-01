import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 여러 커뮤니티(M1, designer 판정 1~5). 서버 둘을 주소로 가른다 — acme 와 beta 는 계정·채널이 다르다.
http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

class _Fake {
  _Fake(this.name, this.meId, this.handle);
  final String name;
  final String meId;
  final String handle;

  /// 이 토큰이 아니면 401 — 만료를 흉내 낸다.
  String liveToken = 'tok';
  int meCalls = 0;

  /// `/auth/logout` 에 실려 온 토큰들(security F2).
  final logouts = <String?>[];
  int logoutStatus = 204;

  /// 이 서버가 `/auth/me` 에서 댈 계정 id. 바꾸면 남의 id 를 대는 서버가 된다(security F1).
  late String claimedId = meId;

  MockClient client(String? token) => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/logout') {
          logouts.add(req.headers['authorization']);
          return http.Response('', logoutStatus);
        }
        if (path == '/healthz') return _json({'ok': true, 'version': '0.3.129'});
        if (path == '/auth/login') {
          final body = jsonDecode(req.body) as Map<String, Object?>;
          if (body['password'] != 'pw') {
            return _json({'error': {'code': 'unauthorized', 'message': 'no'}}, 401);
          }
          return _json({'token': liveToken});
        }
        final auth = req.headers['authorization'];
        if (auth != 'Bearer $liveToken') {
          return _json({'error': {'code': 'unauthorized', 'message': '만료'}}, 401);
        }
        if (path == '/auth/me') {
          meCalls++;
          return _json({'id': claimedId, 'handle': handle, 'displayName': handle, 'isAdmin': false});
        }
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': '$name-c1', 'name': '$name-general', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.endsWith('/messages')) return _json({'messages': <Object?>[], 'hasMore': false});
        if (path.endsWith('/auto-mentions')) return _json({'autoMentions': <Object?>[]});
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

final _acme = _Fake('acme', 'acct-acme', 'jb');
final _beta = _Fake('beta', 'acct-beta', 'beta-jb');

const _acmeUrl = 'https://acme.example.com';
const _betaUrl = 'https://beta.example.com';

/// 행의 열쇠는 (origin, 계정 id) 다(security F1).
const _acmeKey = '$_acmeUrl#acct-acme';
const _betaKey = '$_betaUrl#acct-beta';

/// 붙기만 하고 아무 말도 없는 소켓 — 던지면 재연결 타이머가 시험 뒤에 남는다.
class _IdleConnection implements WsConnection {
  final _ctrl = StreamController<String>();

  @override
  int? get closeCode => null;

  @override
  Stream<String> get messages => _ctrl.stream;

  @override
  void send(String payload) {}

  @override
  Future<void> close() async {
    if (!_ctrl.isClosed) await _ctrl.close();
  }
}

Future<WsConnection> _noSocket(Uri _) async => _IdleConnection();

AppState _app(SessionStore store) => AppState(
      sessions: store,
      apiFactory: (base, token) => ApiClient(
        baseUrl: base,
        token: token,
        httpClient: (base == _acmeUrl ? _acme : _beta).client(token),
      ),
      connector: _noSocket,
    );

String _seed({String acmeToken = 'tok', String betaToken = 'tok', String active = 'acct-acme'}) =>
    jsonEncode({
      'active': active,
      'communities': [
        {'accountId': 'acct-acme', 'baseUrl': _acmeUrl, 'token': acmeToken, 'handle': 'jb'},
        {'accountId': 'acct-beta', 'baseUrl': _betaUrl, 'token': betaToken, 'handle': 'beta-jb'},
      ],
    });

/// 화면 전환(전체 화면 모달의 들고 나감)이 끝날 만큼 돌린다. 토스트(2초)보다는 짧게.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 16; i += 1) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  setUp(() {
    for (final f in [_acme, _beta]) {
      f.liveToken = 'tok';
      f.logouts.clear();
      f.logoutStatus = 204;
      f.claimedId = f.meId;
    }
  });

  group('상태', () {
    test('지금 커뮤니티의 토큰이 죽으면 그것만 만료로 남고, 다른 커뮤니티 토큰은 산다(판정 1·2)', () async {
      final store = SessionStore.inMemory(seed: _seed());
      _acme.liveToken = '새토큰';
      final app = _app(store);
      await app.boot();

      expect(app.phase, AppPhase.needsLogin);
      final kept = (await store.load())!.communities;
      expect(kept.map((c) => c.accountId), ['acct-acme', 'acct-beta']);
      expect(kept[0].isExpired, isTrue);
      expect(kept[1].token, 'tok');
    });

    test('옮기면 그 커뮤니티의 목록을 읽고, 앞 커뮤니티의 상태는 남기지 않는다', () async {
      final store = SessionStore.inMemory(seed: _seed());
      final app = _app(store);
      await app.boot();
      expect(app.channels.single.name, 'acme-general');
      await app.openChannel('acme-c1');
      expect(app.messages.containsKey('acme-c1'), isTrue);

      expect(await app.switchTo(_betaKey), isTrue);
      expect(app.phase, AppPhase.ready);
      expect(app.me!.handle, 'beta-jb');
      expect(app.baseUrl, _betaUrl);
      expect(app.channels.single.name, 'beta-general');
      expect(app.messages, isEmpty);
      expect((await store.load())!.active, _betaKey);
      // 앞 커뮤니티는 로그인된 채 남는다.
      expect(app.communities.every((c) => !c.isExpired), isTrue);
    });

    test('만료된 커뮤니티로는 옮기지 않는다 — 부르는 쪽이 다시 로그인을 띄운다', () async {
      final app = _app(SessionStore.inMemory(seed: _seed(betaToken: '')));
      await app.boot();
      expect(await app.switchTo(_betaKey), isFalse);
      expect(app.activeKey, _acmeKey);
      expect(app.phase, AppPhase.ready);
    });

    test('같은 계정으로 다시 로그인하면 행이 늘지 않고 제자리에서 갱신된다(판정 4)', () async {
      final store = SessionStore.inMemory(seed: _seed(acmeToken: '', active: 'acct-beta'));
      final app = _app(store);
      await app.boot();
      await app.renameCommunity(_acmeKey, '회사');

      final added = await app.addCommunity(_acmeUrl, 'jb', 'pw');
      expect(added.accountId, 'acct-acme');
      expect(app.communities.map((c) => c.accountId), ['acct-acme', 'acct-beta']);
      expect(app.communities.first.isExpired, isFalse);
      expect(app.communities.first.label, '회사');
      // 추가는 옮기지 않는다 — 옮기는 것은 화면이 닫힌 뒤 switchTo 다.
      expect(app.activeKey, _betaKey);
      expect((await store.load())!.communities.length, 2);
    });

    test('지금 커뮤니티에서 로그아웃하면 다음 커뮤니티로, 마지막이면 연결 화면으로', () async {
      final store = SessionStore.inMemory(seed: _seed());
      final app = _app(store);
      await app.boot();

      await app.signOutCommunity(_acmeKey);
      expect(app.phase, AppPhase.ready);
      expect(app.activeKey, _betaKey);
      expect(app.channels.single.name, 'beta-general');
      expect((await store.load())!.communities.single.accountId, 'acct-beta');

      await app.signOutCommunity(_betaKey);
      expect(app.phase, AppPhase.needsServer);
      expect(app.communities, isEmpty);
      expect(await store.load(), isNull);
    });

    test('다른 커뮤니티에서 로그아웃하면 지금 화면은 그대로다', () async {
      final store = SessionStore.inMemory(seed: _seed());
      final app = _app(store);
      await app.boot();
      final calls = _acme.meCalls;
      await app.signOutCommunity(_betaKey);
      expect(app.activeKey, _acmeKey);
      expect(app.phase, AppPhase.ready);
      expect(app.channels.single.name, 'acme-general');
      expect(_acme.meCalls, calls);
      expect((await store.load())!.communities.single.accountId, 'acct-acme');
    });

    test('다른 서버가 기존 계정 id 를 대도 기존 행은 그대로다 — 새 행이 선다(security F1)', () async {
      final store = SessionStore.inMemory(seed: _seed());
      final app = _app(store);
      await app.boot();
      await app.renameCommunity(_acmeKey, '회사');
      // beta 서버가 acme 의 계정 id 를 댄다.
      _beta.claimedId = 'acct-acme';

      final added = await app.addCommunity(_betaUrl, 'x', 'pw');
      expect(added.key, '$_betaUrl#acct-acme');
      expect(added.label, isNull);
      final acme = app.communities.firstWhere((c) => c.key == _acmeKey);
      expect(acme.baseUrl, _acmeUrl);
      expect(acme.token, 'tok');
      expect(acme.label, '회사');
      expect(app.communities.length, 3);
      final kept = (await store.load())!.communities.firstWhere((c) => c.key == _acmeKey);
      expect(kept.baseUrl, _acmeUrl);
      expect(kept.label, '회사');
    });

    test('로그아웃은 그 토큰으로 서버 세션을 끊는다 — 실패해도 로그아웃은 된다(security F2)', () async {
      final store = SessionStore.inMemory(seed: _seed());
      final app = _app(store);
      await app.boot();
      _beta.logoutStatus = 500;

      await app.signOutCommunity(_betaKey);
      expect(_beta.logouts, ['Bearer tok']);
      expect(_acme.logouts, isEmpty);
      expect(app.communities.single.key, _acmeKey);

      await app.signOutCommunity(_acmeKey);
      expect(_acme.logouts, ['Bearer tok']);
      expect(app.phase, AppPhase.needsServer);
    });

    test('모두 로그아웃은 커뮤니티마다 서버 세션을 끊는다 — 만료된 것은 건너뛴다', () async {
      final app = _app(SessionStore.inMemory(seed: _seed(betaToken: '')));
      await app.boot();
      await app.signOutAll();
      expect(_acme.logouts, ['Bearer tok']);
      expect(_beta.logouts, isEmpty);
    });

    test('모두 로그아웃은 보관본을 지우고 연결 화면으로', () async {
      final store = SessionStore.inMemory(seed: _seed());
      final app = _app(store);
      await app.boot();
      await app.signOutAll();
      expect(app.phase, AppPhase.needsServer);
      expect(app.communities, isEmpty);
      expect(await store.load(), isNull);
    });
  });

  group('나 탭', () {
    Future<AppState> pumpApp(WidgetTester tester, String seed) async {
      final app = _app(SessionStore.inMemory(seed: seed));
      addTearDown(app.dispose);
      await tester.pumpWidget(HarkroomApp(state: app));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('tab-me')));
      await _settle(tester);
      return app;
    }

    testWidgets('이 기기의 커뮤니티가 서고, 만료된 것은 「다시 로그인」 행으로 남는다', (tester) async {
      await pumpApp(tester, _seed(betaToken: ''));
      expect(find.byKey(Key('me-community-$_acmeKey')), findsOneWidget);
      expect(find.byKey(Key('me-community-$_betaKey')), findsOneWidget);
      expect(find.byKey(Key('me-community-expired-$_betaKey')), findsOneWidget);
      expect(find.byKey(Key('me-community-expired-$_acmeKey')), findsNothing);
    });

    testWidgets('추가 화면을 ✕ 로 닫으면 원래 커뮤니티 화면 그대로다(판정 3)', (tester) async {
      final app = await pumpApp(tester, _seed());
      await tester.tap(find.byKey(const Key('me-community-add')));
      await _settle(tester);
      expect(find.byKey(const Key('community-add')), findsOneWidget);

      await tester.tap(find.byKey(const Key('community-add-close')));
      await _settle(tester);
      expect(find.byKey(const Key('community-add')), findsNothing);
      expect(find.byKey(const Key('me-community-add')), findsOneWidget);
      expect(app.activeKey, _acmeKey);
      expect(app.phase, AppPhase.ready);
    });

    testWidgets('커뮤니티로 옮기면 토스트에 커뮤니티 이름과 내 핸들이 함께 나온다(판정 5)', (tester) async {
      final app = await pumpApp(tester, _seed());
      await tester.tap(find.byKey(Key('me-community-$_betaKey')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('community-switch')));
      await _settle(tester);

      expect(app.activeKey, _betaKey);
      final toast = find.byKey(const Key('community-switched-toast'));
      expect(toast, findsOneWidget);
      expect(
        find.descendant(of: toast, matching: find.textContaining('beta.example.com')),
        findsOneWidget,
      );
      expect(find.descendant(of: toast, matching: find.textContaining('@beta-jb')), findsOneWidget);
    });

    testWidgets('만료 행을 누르면 상세가 열리고, 거기서 로그아웃하면 행이 사라진다(designer 1)', (tester) async {
      final app = await pumpApp(tester, _seed(betaToken: ''));
      await tester.tap(find.byKey(Key('me-community-$_betaKey')));
      await _settle(tester);
      expect(find.byKey(const Key('community-detail')), findsOneWidget);
      expect(find.byKey(const Key('community-relogin')), findsOneWidget);

      await tester.tap(find.byKey(const Key('community-sign-out')));
      await _settle(tester);
      expect(find.byKey(Key('me-community-$_betaKey')), findsNothing);
      expect(app.communities.single.key, _acmeKey);
      expect(app.activeKey, _acmeKey);
    });

    testWidgets('「다시 로그인」은 주소가 채워진(고칠 수 없는) 모달을 열고, 로그인하면 그 행을 살려 옮긴다', (tester) async {
      final app = await pumpApp(tester, _seed(betaToken: ''));
      await tester.tap(find.byKey(Key('me-community-$_betaKey')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('community-relogin')));
      await _settle(tester);
      final url = tester.widget<TextField>(find.byKey(const Key('community-add-url')));
      expect(url.controller!.text, _betaUrl);
      expect(url.readOnly, isTrue);

      await tester.enterText(find.byKey(const Key('community-add-login-id')), 'beta-jb');
      await tester.enterText(find.byKey(const Key('community-add-password')), 'pw');
      await tester.tap(find.byKey(const Key('community-add-submit')));
      await _settle(tester);

      expect(app.activeKey, _betaKey);
      expect(app.communities.length, 2);
      expect(app.communities.every((c) => !c.isExpired), isTrue);
      expect(find.byKey(const Key('community-switched-toast')), findsOneWidget);
    });

    testWidgets('모두 로그아웃은 확인을 거친다', (tester) async {
      final app = await pumpApp(tester, _seed());
      await tester.tap(find.byKey(const Key('me-sign-out-all')));
      await _settle(tester);
      expect(find.byKey(const Key('me-sign-out-all-sheet')), findsOneWidget);
      expect(app.phase, AppPhase.ready);

      await tester.tap(find.byKey(const Key('me-sign-out-all-confirm')));
      await _settle(tester);
      expect(app.phase, AppPhase.needsServer);
    });
  });
}

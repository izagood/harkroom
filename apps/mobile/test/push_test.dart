import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/screens/me_screen.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/theme.dart';
import 'package:harkroom/push/push_coordinator.dart';
import 'package:harkroom/push/push_platform.dart';
import 'package:harkroom/push/push_target.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 푸시 ③(앱): 알림 누름이 갈 곳을 정하는 규칙, 기기 등록·해제, 안내 시트.
const _a = '11111111-1111-4111-8111-111111111111';
const _b = '22222222-2222-4222-8222-222222222222';
const _ch = '33333333-3333-4333-8333-333333333333';
const _root = '44444444-4444-4444-8444-444444444444';
const _acmeUrl = 'https://acme.example.com';
const _betaUrl = 'https://beta.example.com';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

/// 커뮤니티 서버 하나. 받은 푸시 요청을 적어 둔다.
class _Server {
  _Server(this.meId);
  final String meId;
  final pushCalls = <String>[];

  /// `/inbox` 를 망 오류로 끊는다.
  bool failInbox = false;

  /// 옛 서버 흉내 — prefs 를 실으면 400(strict).
  bool strictPrefs = false;

  /// #1088 이전 서버 흉내 — prefs 는 받지만 badge 키를 모른다.
  bool noBadgePrefs = false;

  MockClient client(String? token) => MockClient((req) async {
        final path = req.url.path;
        if (path == '/push/devices' || path == '/push/devices/current') {
          pushCalls.add('${req.method} $path ${req.method == 'PUT' ? req.body : ''}'.trim());
          if (req.method == 'PUT' &&
              ((strictPrefs && req.body.contains('"prefs"')) || (noBadgePrefs && req.body.contains('"badge"')))) {
            return _json({'error': {'code': 'validation', 'message': 'unrecognized key'}}, 400);
          }
          return req.method == 'PUT' ? _json({'id': 'd'}) : http.Response('', 204);
        }
        if (path == '/auth/logout') return http.Response('', 204);
        if (token != 'tok') return _json({'error': {'code': 'unauthorized', 'message': 'x'}}, 401);
        return switch (path) {
          '/auth/me' => _json({'id': meId, 'handle': 'me', 'displayName': 'me', 'isAdmin': false}),
          '/channels' => _json({'channels': [{'id': _ch, 'name': 'general', 'kind': 'standard'}]}),
          '/accounts' => _json({'accounts': <Object?>[]}),
          '/reads' => _json({'reads': <Object?>[]}),
          '/ws-ticket' => _json({'ticket': 'tk'}),
          _ when path.startsWith('/inbox') && failInbox => throw http.ClientException('망 없음'),
          _ when path.startsWith('/inbox') => _json({'entries': <Object?>[]}),
          _ when path.endsWith('/messages') => _json({'messages': <Object?>[], 'hasMore': false}),
          _ when path.endsWith('/auto-mentions') => _json({'autoMentions': <Object?>[]}),
          _ => _json({'error': {'code': 'not_found', 'message': path}}, 404),
        };
      });
}

class _Idle implements WsConnection {
  final _c = StreamController<String>();
  @override
  int? get closeCode => null;
  @override
  Stream<String> get messages => _c.stream;
  @override
  void send(String payload) {}
  @override
  Future<void> close() async => _c.close();
}

class _FakePush implements PushPlatform {
  Set<String> mutedStore = {};
  @override
  Future<Set<String>> mutedCommunities() async => {...mutedStore};
  @override
  Future<void> setMutedCommunities(Set<String> keys) async => mutedStore = {...keys};
  bool previewStore = false;
  @override
  Future<bool> showPreview() async => previewStore;
  @override
  Future<void> setShowPreview(bool on) async => previewStore = on;
  PushPermission perm = PushPermission.notDetermined;
  bool grant = true;
  bool prompted = false;
  int requests = 0;
  final badges = <int>[];
  Map<String, Object?>? initial;

  @override
  Future<PushPermission> status() async => perm;
  @override
  Future<bool> request() async {
    requests++;
    if (grant) perm = PushPermission.authorized;
    return grant;
  }

  @override
  Future<PushDeviceToken?> token() async => const PushDeviceToken('ab', 'sandbox');
  @override
  Future<Map<String, Object?>?> takeInitialOpen() async {
    final i = initial;
    initial = null;
    return i;
  }

  @override
  Future<void> setBadge(int count) async => badges.add(count);
  @override
  Future<bool> wasPrompted() async => prompted;
  @override
  Future<void> markPrompted() async => prompted = true;
  int settingsOpened = 0;
  @override
  Future<void> openSettings() async => settingsOpened++;
  @override
  void listen({required void Function(Map<String, Object?>) onOpen, required bool Function(Map<String, Object?>) shouldPresent}) {}
}

StoredCommunity _c(String url, String id, {String token = 'tok'}) =>
    StoredCommunity(accountId: id, baseUrl: url, token: token, handle: 'me');

Map<String, Object?> _hk(String accountId, {String? root, Object v = 1, String channel = _ch}) =>
    {'v': v, 'accountId': accountId, 'messageId': _root, 'channelId': channel, 'threadRootId': root};

void main() {
  group('resolvePushTarget', () {
    final both = [_c(_acmeUrl, _a), _c(_betaUrl, _b)];

    test('계정 id 가 맞는 커뮤니티가 하나면 그리로 간다', () {
      final t = resolvePushTarget(_hk(_b, root: _root), both)!;
      expect(t.communityKey, '$_betaUrl#$_b');
      expect(t.channelId, _ch);
      expect(t.threadRootId, _root);
    });

    test('맞는 커뮤니티가 없으면 아무것도 하지 않는다', () {
      expect(resolvePushTarget(_hk('55555555-5555-4555-8555-555555555555'), both), isNull);
    });

    test('같은 계정 id 가 두 커뮤니티에 있으면 추측하지 않는다(security #1070)', () {
      expect(resolvePushTarget(_hk(_a), [_c(_acmeUrl, _a), _c(_betaUrl, _a)]), isNull);
    });

    test('모양이 다른 hk 는 버린다 — 버전·UUID', () {
      expect(resolvePushTarget(_hk(_a, v: 2), both), isNull);
      expect(resolvePushTarget(_hk('acct-a'), both), isNull);
      expect(resolvePushTarget(_hk(_a, channel: '../x'), both), isNull);
      expect(resolvePushTarget(_hk(_a, root: 'nope'), both), isNull);
    });
  });

  group('PushCoordinator', () {
    late _Server acme;
    late _Server beta;
    late AppState app;
    late _FakePush push;

    Future<void> boot({String active = _a}) async {
      acme = _Server(_a);
      beta = _Server(_b);
      final store = MemorySessionStore(seed: jsonEncode({
        'active': active,
        'communities': [
          {'accountId': _a, 'baseUrl': _acmeUrl, 'token': 'tok', 'handle': 'me'},
          {'accountId': _b, 'baseUrl': _betaUrl, 'token': 'tok', 'handle': 'me'},
        ],
      }));
      app = AppState(
        sessions: store,
        apiFactory: (base, token) =>
            ApiClient(baseUrl: base, token: token, httpClient: (base == _acmeUrl ? acme : beta).client(token)),
        connector: (_) async => _Idle(),
      );
      push = _FakePush();
      await app.boot();
    }

    test('권한이 있으면 로그인해 둔 커뮤니티마다 한 번씩 등록한다', () async {
      await boot();
      push.perm = PushPermission.authorized;
      final c = PushCoordinator(app, push);
      await c.sync();
      await c.sync();
      // 커뮤니티가 둘이라 서버 배지는 끈다(M4 배지 a).
      expect(acme.pushCalls, ['PUT /push/devices {"token":"ab","platform":"ios","env":"sandbox","prefs":{"badge":false,"preview":false}}']);
      expect(beta.pushCalls, hasLength(1));
    });

    test('커뮤니티 알림을 끄면 그 서버의 등록을 풀고, 남은 하나는 서버 배지를 켠 채로 다시 등록한다', () async {
      await boot();
      push.perm = PushPermission.authorized;
      final c = PushCoordinator(app, push);
      await c.sync();
      await c.setCommunityEnabled('$_betaUrl#$_b', false);
      expect(beta.pushCalls.last, 'DELETE /push/devices/current');
      expect(acme.pushCalls.last, endsWith('"prefs":{"badge":true,"preview":false}}'));
      expect(push.mutedStore, {'$_betaUrl#$_b'});
      final betaCount = beta.pushCalls.length;
      await c.sync();
      expect(beta.pushCalls.length, betaCount);
      await c.setCommunityEnabled('$_betaUrl#$_b', true);
      expect(beta.pushCalls.last, startsWith('PUT'));
      expect(acme.pushCalls.last, endsWith('"prefs":{"badge":false,"preview":false}}'));
    });

    test('「내용 미리보기」를 켜면 기기에 적고 모든 커뮤니티에 preview 를 실어 다시 등록한다', () async {
      await boot();
      push.perm = PushPermission.authorized;
      final c = PushCoordinator(app, push);
      await c.sync();
      await c.setPreview(true);
      expect(push.previewStore, isTrue);
      expect(acme.pushCalls.last, endsWith('"prefs":{"badge":false,"preview":true}}'));
      expect(beta.pushCalls.last, endsWith('"preview":true}}'));
      // 다음 실행은 기기에 적힌 값으로 시작한다.
      final next = PushCoordinator(app, push);
      await next.start();
      expect(next.preview, isTrue);
    });

    test('옛 서버가 prefs 를 400 으로 거절하면 prefs 없이 다시 등록한다', () async {
      await boot();
      acme.strictPrefs = true;
      push.perm = PushPermission.authorized;
      await PushCoordinator(app, push).sync();
      expect(acme.pushCalls, hasLength(3));
      expect(acme.pushCalls.last, 'PUT /push/devices {"token":"ab","platform":"ios","env":"sandbox"}');
    });

    test('badge 를 모르는 서버(400)에도 미리보기 끄기는 닿는다 — preview 만 실어 다시 보낸다 (F1)', () async {
      await boot();
      acme.noBadgePrefs = true;
      push.perm = PushPermission.authorized;
      final c = PushCoordinator(app, push);
      await c.setPreview(true);
      await c.setPreview(false);
      expect(acme.pushCalls.last, 'PUT /push/devices {"token":"ab","platform":"ios","env":"sandbox","prefs":{"preview":false}}');
      expect(acme.pushCalls.where((x) => !x.contains('"prefs"')), isEmpty);
    });

    test('다시 앞에 올 때 다시 읽기가 실패해도 던지지 않는다', () async {
      await boot();
      final c = PushCoordinator(app, push);
      acme.failInbox = true;
      await c.resumed();
    });

    test('권한이 없으면 등록하지 않는다', () async {
      await boot();
      final c = PushCoordinator(app, push);
      await c.sync();
      expect(acme.pushCalls, isEmpty);
    });

    test('커뮤니티에서 로그아웃하면 그 서버의 등록을 푼다', () async {
      await boot();
      await app.signOutCommunity('$_betaUrl#$_b');
      expect(beta.pushCalls, ['DELETE /push/devices/current']);
      expect(acme.pushCalls, isEmpty);
    });

    test('다른 커뮤니티의 알림을 누르면 그리로 옮기고 열 곳을 남긴다', () async {
      await boot();
      final c = PushCoordinator(app, push);
      await c.open(_hk(_b, root: _root));
      expect(app.activeKey, '$_betaUrl#$_b');
      final t = c.takePending()!;
      expect(t.threadRootId, _root);
    });

    test('다른 커뮤니티로 옮기기 전에 화면을 내리게 한다(security #1092 L1) — 같은 커뮤니티면 안 내린다', () async {
      await boot();
      final c = PushCoordinator(app, push);
      final calls = <String?>[];
      c.beforeSwitch = () => calls.add(app.activeKey);
      await c.open(_hk(_a, root: _root));
      expect(calls, isEmpty);
      await c.open(_hk(_b, root: _root));
      // 옮기기 **전** 의 커뮤니티에서 불렸다.
      expect(calls, ['$_acmeUrl#$_a']);
    });

    test('계정 id 가 겹치면 누름은 아무것도 하지 않는다 — 옮기지도, 열지도 않는다', () async {
      await boot();
      app.communities = [_c(_acmeUrl, _a), _c(_betaUrl, _a)];
      final before = app.activeKey;
      final c = PushCoordinator(app, push);
      await c.open(_hk(_a));
      expect(app.activeKey, before);
      expect(c.pending, isNull);
    });

    test('보고 있는 채널의 알림만 배너를 숨긴다', () async {
      await boot();
      final c = PushCoordinator(app, push);
      expect(c.shouldPresent(_hk(_a)), isTrue);
      app.openChannelId = _ch;
      expect(c.shouldPresent(_hk(_a)), isFalse);
      expect(c.shouldPresent(_hk(_a, root: _root)), isTrue);
      expect(c.shouldPresent(_hk(_b)), isTrue);
    });
  });

  group('누름 → 화면 (④)', () {
    Future<(AppState, PushCoordinator)> pumpTwo(WidgetTester tester) async {
      final acme = _Server(_a);
      final beta = _Server(_b);
      final app = AppState(
        sessions: MemorySessionStore(seed: jsonEncode({
          'active': _a,
          'communities': [
            {'accountId': _a, 'baseUrl': _acmeUrl, 'token': 'tok', 'handle': 'me'},
            {'accountId': _b, 'baseUrl': _betaUrl, 'token': 'tok', 'handle': 'me'},
          ],
        })),
        apiFactory: (base, token) =>
            ApiClient(baseUrl: base, token: token, httpClient: (base == _acmeUrl ? acme : beta).client(token)),
        connector: (_) async => _Idle(),
      );
      // 시트가 화면을 덮지 않게 이미 물은 기기로 둔다.
      final push = PushCoordinator(app, _FakePush()..prompted = true);
      await tester.pumpWidget(HarkroomApp(state: app, push: push));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      return (app, push);
    }

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    testWidgets('다른 커뮤니티 스레드의 알림을 누르면 그 커뮤니티로 옮겨 그 스레드를 연다', (tester) async {
      final (app, push) = await pumpTwo(tester);
      expect(app.activeKey, '$_acmeUrl#$_a');
      unawaited(push.open(_hk(_b, root: _root)));
      await settle(tester);
      expect(app.activeKey, '$_betaUrl#$_b');
      final screen = tester.widget<ThreadScreen>(find.byType(ThreadScreen));
      expect((screen.channelId, screen.rootId), (_ch, _root));
      expect(push.pending, isNull);
    });

    testWidgets('지금 커뮤니티의 채널 알림은 옮기지 않고 그 채널을 연다', (tester) async {
      final (app, push) = await pumpTwo(tester);
      unawaited(push.open(_hk(_a)));
      await settle(tester);
      expect(app.activeKey, '$_acmeUrl#$_a');
      expect(tester.widget<MessageListScreen>(find.byType(MessageListScreen)).channelId, _ch);
    });

    testWidgets('겹치는 계정 id 의 알림은 아무 화면도 열지 않는다', (tester) async {
      final (app, push) = await pumpTwo(tester);
      app.communities = [_c(_acmeUrl, _a), _c(_betaUrl, _a)];
      unawaited(push.open(_hk(_a)));
      await settle(tester);
      expect(find.byType(MessageListScreen), findsNothing);
      expect(find.byType(ThreadScreen), findsNothing);
    });
  });

  group('배지 (④)', () {
    test('다시 앞에 오면 같은 값이라도 OS 배지를 다시 적는다 — 배경의 푸시가 서버별 수로 덮었으므로', () async {
      final acme = _Server(_a);
      final app = AppState(
        sessions: MemorySessionStore(seed: jsonEncode({
          'active': _a,
          'communities': [{'accountId': _a, 'baseUrl': _acmeUrl, 'token': 'tok', 'handle': 'me'}],
        })),
        apiFactory: (base, token) => ApiClient(baseUrl: base, token: token, httpClient: acme.client(token)),
        connector: (_) async => _Idle(),
      );
      final fake = _FakePush();
      final push = PushCoordinator(app, fake);
      await app.boot();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      final before = fake.badges.length;
      expect(fake.badges, isNotEmpty);
      await push.resumed();
      expect(fake.badges.length, before + 1);
      expect(fake.badges.last, 0);
    });
  });

  group('나 화면 「알림」 (M4)', () {
    Future<_FakePush> pumpMe(WidgetTester tester, PushPermission perm) async {
      final acme = _Server(_a);
      final app = AppState(
        sessions: MemorySessionStore(seed: jsonEncode({
          'active': _a,
          'communities': [{'accountId': _a, 'baseUrl': _acmeUrl, 'token': 'tok', 'handle': 'me'}],
        })),
        apiFactory: (base, token) => ApiClient(baseUrl: base, token: token, httpClient: acme.client(token)),
        connector: (_) async => _Idle(),
      );
      final fake = _FakePush()
        ..perm = perm
        ..prompted = true;
      final push = PushCoordinator(app, fake);
      await app.boot();
      await push.start();
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        builder: (context, child) => I18n(
          strings: stringsFor('ko'),
          child: AppScope(state: app, child: PushScope(push: push, child: child!)),
        ),
        home: const MeScreen(),
      ));
      await tester.pump();
      return fake;
    }

    testWidgets('아직 묻지 않았으면 [켜기] 가 OS 권한 창을 띄운다', (tester) async {
      final fake = await pumpMe(tester, PushPermission.notDetermined);
      await tester.tap(find.byKey(const Key('me-push-turn-on')));
      await tester.pump();
      expect(fake.requests, 1);
      expect(find.byKey(Key('me-push-community-$_acmeUrl#$_a')), findsOneWidget);
    });

    testWidgets('거부됐으면 [iOS 설정 열기] 를 보인다', (tester) async {
      final fake = await pumpMe(tester, PushPermission.denied);
      await tester.tap(find.byKey(const Key('me-push-open-settings')));
      expect(fake.settingsOpened, 1);
    });

    testWidgets('켜져 있으면 커뮤니티 스위치로 끈다', (tester) async {
      final fake = await pumpMe(tester, PushPermission.authorized);
      await tester.tap(find.byKey(Key('me-push-community-$_acmeUrl#$_a')));
      await tester.pump();
      expect(fake.mutedStore, {'$_acmeUrl#$_a'});
      expect(find.text('알림 끔'), findsOneWidget);
    });

    testWidgets('「내용 미리보기」는 기본 꺼짐이고 누르면 켜진다', (tester) async {
      final fake = await pumpMe(tester, PushPermission.authorized);
      final tile = find.byKey(const Key('me-push-preview'));
      expect(tester.widget<SwitchListTile>(tile).value, isFalse);
      expect(find.byKey(const Key('me-push-preview-divider')), findsOneWidget);
      await tester.tap(tile);
      await tester.pump();
      expect(fake.previewStore, isTrue);
      expect(tester.widget<SwitchListTile>(tile).value, isTrue);
    });

    testWidgets('권한이 없으면 「내용 미리보기」를 보이지 않는다', (tester) async {
      await pumpMe(tester, PushPermission.denied);
      expect(find.byKey(const Key('me-push-preview')), findsNothing);
    });
  });

  group('안내 시트', () {
    Future<(_FakePush, _Server)> pumpApp(WidgetTester tester) async {
      final acme = _Server(_a);
      final app = AppState(
        sessions: MemorySessionStore(seed: jsonEncode({
          'active': _a,
          'communities': [{'accountId': _a, 'baseUrl': _acmeUrl, 'token': 'tok', 'handle': 'me'}],
        })),
        apiFactory: (base, token) => ApiClient(baseUrl: base, token: token, httpClient: acme.client(token)),
        connector: (_) async => _Idle(),
      );
      final push = _FakePush();
      await tester.pumpWidget(HarkroomApp(state: app, push: PushCoordinator(app, push)));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      return (push, acme);
    }

    testWidgets('처음 들어오면 한 번 뜨고, [켜기] 는 OS 권한을 묻고 바로 등록한다', (tester) async {
      final (push, acme) = await pumpApp(tester);
      expect(find.byKey(const Key('push-prompt')), findsOneWidget);
      await tester.tap(find.byKey(const Key('push-prompt-enable')));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(push.requests, 1);
      expect(push.prompted, isTrue);
      expect(acme.pushCalls.where((c) => c.startsWith('PUT')), hasLength(1));
    });

    testWidgets('[나중에] 는 OS 권한을 묻지 않고, 다시 띄우지 않게 적는다', (tester) async {
      final (push, _) = await pumpApp(tester);
      await tester.tap(find.byKey(const Key('push-prompt-later')));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(push.requests, 0);
      expect(push.prompted, isTrue);
      expect(find.byKey(const Key('push-prompt')), findsNothing);
    });
  });
}

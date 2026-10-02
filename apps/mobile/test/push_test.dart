import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/push/push_coordinator.dart';
import 'package:harkroom/push/push_platform.dart';
import 'package:harkroom/push/push_target.dart';
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

  MockClient client(String? token) => MockClient((req) async {
        final path = req.url.path;
        if (path == '/push/devices' || path == '/push/devices/current') {
          pushCalls.add('${req.method} $path ${req.method == 'PUT' ? req.body : ''}'.trim());
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
  @override
  Future<void> openSettings() async {}
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
      expect(acme.pushCalls, ['PUT /push/devices {"token":"ab","platform":"ios","env":"sandbox"}']);
      expect(beta.pushCalls, hasLength(1));
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

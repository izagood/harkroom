import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// `grant.changed` 를 받으면 **나**의 `/auth/me` 를 다시 읽어 역할을 바로 반영한다(데스크톱 `controller.ts` 와
/// 같다). 전에는 이 이벤트를 몰라서, admin 이 된 사람도 앱을 다시 켤 때까지 남의 글 지우기를 못 봤다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

/// `/auth/me` 가 몇 번 불렸는지와 그때 줄 admin 여부를 시험이 바꾼다.
class _Server {
  bool admin = false;
  int meCalls = 0;

  /// 걸어 두면 `/auth/me` 답이 이것이 풀릴 때까지 늦는다(경합 시험).
  Completer<void>? holdMe;

  MockClient client() => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') {
          meCalls++;
          await holdMe?.future;
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': admin});
        }
        if (path == '/channels') return _json({'channels': <Object?>[]});
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        if (path == '/auth/logout') return http.Response('', 204);
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

Future<AppState> _boot(_Server server) async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client()),
    connector: (_) async => throw StateError('소켓 없음'),
  );
  await app.boot();
  return app;
}

/// `_refreshMe` 는 기다리지 않고 띄운다 — 마이크로태스크가 돌 틈을 준다.
Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  test('내 grant.changed 면 /auth/me 를 다시 읽어 역할이 바로 바뀌고 화면에 알린다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);
    expect(app.me?.isAdmin, isFalse);
    final before = server.meCalls;
    var notified = 0;
    app.addListener(() => notified++);

    server.admin = true;
    app.applyEvent({'type': 'grant.changed', 'accountId': 'me-1', 'audience': 'all'});
    await _settle();

    expect(server.meCalls, before + 1);
    expect(app.me?.isAdmin, isTrue);
    expect(notified, greaterThan(0));
  });

  test('남의 grant.changed·모양이 틀린 것은 /auth/me 를 부르지 않는다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);
    final before = server.meCalls;

    server.admin = true;
    app.applyEvent({'type': 'grant.changed', 'accountId': 'someone-else', 'audience': 'all'});
    app.applyEvent({'type': 'grant.changed', 'audience': 'all'});
    await _settle();

    expect(server.meCalls, before);
    expect(app.me?.isAdmin, isFalse);
  });

  test('다시 읽는 사이 로그아웃했으면 옛 답을 붓지 않는다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);

    server.admin = true;
    server.holdMe = Completer<void>();
    app.applyEvent({'type': 'grant.changed', 'accountId': 'me-1', 'audience': 'all'});
    await _settle();
    await app.signOut();
    server.holdMe!.complete();
    await _settle();

    expect(app.me, isNull);
  });
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 다시 붙은 뒤 따라잡기(`catchUp`)는 열어 둔 채널·스레드·reads·인박스를 **한꺼번에** 묻는다.
/// 예전에는 for 문으로 하나씩 기다려 N+M+2 왕복이 직렬로 쌓였다(왕복 하나 130~300ms).

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

const _channels = ['c1', 'c2', 'c3', 'c4', 'c5'];

Map<String, Object?> _row(String channelId, int seq) => {
      'id': '$channelId-m$seq',
      'seq': seq,
      'channelId': channelId,
      'authorId': 'a1',
      'body': '$channelId 의 $seq',
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 2).add(Duration(minutes: seq)).toIso8601String(),
    };

class _Server {
  /// 참이면 따라잡기 조회를 [gate] 가 열릴 때까지 붙잡아 동시에 몇 개가 떠 있는지 잰다.
  Completer<void>? gate;
  int inFlight = 0;
  int maxInFlight = 0;
  final failing = <String>{};

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        final q = req.url.queryParameters;
        final catchingUp = q.containsKey('since') || path == '/reads' || path.startsWith('/inbox');
        if (catchingUp && gate != null) {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await gate!.future;
          inFlight--;
        }
        if (path == '/auth/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
        }
        if (path == '/channels') {
          return _json({
            'channels': [for (final c in _channels) {'id': c, 'name': c, 'kind': 'standard'}],
          });
        }
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.contains('/auto-mentions')) return _json({'autoMentions': <Object?>[]});
        final m = RegExp(r'^/channels/([^/]+)/messages$').firstMatch(path);
        if (m != null) {
          final c = m.group(1)!;
          if (q.containsKey('since')) {
            if (failing.contains(c)) return _json({'error': {'code': 'internal', 'message': 'boom'}}, 500);
            // 끊긴 사이에 온 글 하나.
            return _json({'messages': [_row(c, 2)], 'hasMore': false});
          }
          return _json({'messages': [_row(c, 1)], 'hasMore': false});
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

Future<AppState> _open(_Server server) async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client),
    connector: (_) async => throw StateError('소켓 없음'),
  );
  await app.boot();
  for (final c in _channels) {
    await app.openChannel(c);
  }
  return app;
}

void main() {
  test('열어 둔 채널·reads·인박스를 한꺼번에 묻는다 — 하나씩 기다리지 않는다', () async {
    final server = _Server();
    final app = await _open(server);
    addTearDown(app.dispose);

    server.gate = Completer<void>();
    final pending = app.catchUp();
    // 다른 조회가 끝나기를 기다리지 않고 모두 떠 있어야 한다: 채널 5 + reads + 인박스.
    await pumpEventQueue();
    expect(server.maxInFlight, _channels.length + 2);
    server.gate!.complete();
    await pending;

    for (final c in _channels) {
      expect(app.messages[c]!.map((m) => m.seq), [1, 2], reason: c);
    }
  });

  test('하나가 실패해도 나머지 결과는 반영한다', () async {
    final server = _Server()..failing.add('c3');
    final app = await _open(server);
    addTearDown(app.dispose);

    await app.catchUp();

    expect(app.messages['c3']!.map((m) => m.seq), [1]);
    for (final c in _channels.where((c) => c != 'c3')) {
      expect(app.messages[c]!.map((m) => m.seq), [1, 2], reason: c);
    }
  });

  group('runLimited', () {
    test('동시에 도는 수를 상한으로 묶는다', () async {
      var running = 0;
      var peak = 0;
      final done = <int>[];
      final jobs = [
        for (var i = 0; i < 20; i++)
          () async {
            running++;
            if (running > peak) peak = running;
            await Future<void>.delayed(Duration(milliseconds: 1 + (i * 7) % 5));
            running--;
            done.add(i);
          },
      ];

      await runLimited(jobs, 8);

      expect(peak, 8);
      expect(done.toSet(), {for (var i = 0; i < 20; i++) i});
    });

    test('실패한 일이 있어도 나머지는 끝까지 돈다', () async {
      final done = <int>[];
      final jobs = [
        for (var i = 0; i < 5; i++)
          () async {
            if (i == 1) throw StateError('boom');
            await Future<void>.delayed(const Duration(milliseconds: 1));
            done.add(i);
          },
      ];

      await runLimited(jobs, 2);

      expect(done..sort(), [0, 2, 3, 4]);
    });

    test('일이 없으면 바로 끝난다', () async {
      await runLimited(const [], 8);
    });
  });
}

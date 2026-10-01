import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 스레드 옛 답글 페이지(서버 #1048 의 `?thread=&before=`). 긴 스레드는 첫 페이지에 최신 100 줄만
/// 오고, 위로 밀면 그 앞을 받는다. **옛 서버**는 스레드 `hasMore` 를 늘 `false` 로 주므로 그때는
/// 지금처럼 받지 않는다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

class _Server {
  _Server({required this.replies, this.oldServer = false});

  /// 답글 수. 루트는 seq 1, 답글은 seq 2.. 이다.
  final int replies;

  /// 참이면 #1048 전의 서버처럼 굴어 스레드 `hasMore` 를 늘 `false` 로 주고 `before` 를 무시한다.
  final bool oldServer;

  final asked = <Map<String, String>>[];
  bool failOlder = false;
  Future<void>? holdOlder;

  Map<String, Object?> _row(int seq) => {
        'id': seq == 1 ? 'root' : 'r$seq',
        'seq': seq,
        'channelId': 'c1',
        'threadRootId': seq == 1 ? null : 'root',
        'authorId': 'a1',
        'body': seq == 1 ? '원글' : '답글 $seq',
        'kind': 'user',
        'replyCount': seq == 1 ? replies : null,
        'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
      };

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
        }
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'task', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.contains('/agent-models')) return _json({'agentModels': <Object?>[]});
        if (path == '/channels/c1/messages') {
          final q = req.url.queryParameters;
          if (q['thread'] != 'root') return _json({'messages': <Object?>[], 'hasMore': false});
          asked.add(q);
          final limit = int.parse(q['limit'] ?? '200');
          final before = oldServer || q['before'] == null ? null : int.parse(q['before']!);
          if (before != null && holdOlder != null) await holdOlder;
          if (before != null && failOlder) {
            return _json({'error': {'code': 'internal', 'message': 'boom'}}, 500);
          }
          // 서버와 같은 뜻: 첫 페이지 = 루트 + 최신 limit 답글, 옛 페이지 = before 보다 앞선 답글만.
          final pool = [for (var s = 2; s <= replies + 1; s++) if (before == null || s < before) s];
          final page = pool.length > limit ? pool.sublist(pool.length - limit) : pool;
          final rows = [if (before == null) _row(1), ...page.map(_row)];
          final hasMore = !oldServer && page.isNotEmpty && page.first > 2;
          return _json({'messages': rows, 'hasMore': hasMore});
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
  await app.openThread('c1', 'root');
  return app;
}

void main() {
  test('긴 스레드는 첫 페이지 100 줄 + hasMore, 위로 밀면 그 앞을 차례로 받는다', () async {
    final server = _Server(replies: 250);
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(app.threads['root']!.length, 100);
    expect(app.threadRoots['root'], isNotNull);
    expect(app.threadHasMore['root'], isTrue);

    expect(await app.loadOlderThread('c1', 'root'), isTrue);
    // 첫 페이지의 가장 오래된 답글(seq 152)보다 앞을 물었다.
    expect(server.asked.last['before'], '152');
    expect(app.threads['root']!.length, 200);
    expect(await app.loadOlderThread('c1', 'root'), isTrue);
    expect(app.threads['root']!.length, 250);
    expect(app.threadHasMore['root'], isFalse);
    // 끝에 닿았다 — 더 가지 않는다. 답글은 seq 순, 루트는 답글에 섞이지 않는다.
    final n = server.asked.length;
    expect(await app.loadOlderThread('c1', 'root'), isFalse);
    expect(server.asked.length, n);
    final seqs = app.threads['root']!.map((m) => m.seq).toList();
    expect(seqs.first, 2);
    expect(seqs, [...seqs]..sort());
    expect(app.threads['root']!.any((m) => m.id == 'root'), isFalse);
  });

  test('옛 서버(hasMore 를 안 줌)에서는 옛 페이지를 부르지 않는다 — 지금처럼 최신 100 줄', () async {
    final server = _Server(replies: 250, oldServer: true);
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(app.threads['root']!.length, 100);
    expect(app.threadHasMore['root'], isFalse);
    final n = server.asked.length;
    expect(await app.loadOlderThread('c1', 'root'), isFalse);
    expect(server.asked.length, n);
    expect(app.loadingOlderThread, isEmpty);
    expect(app.olderThreadFailed, isEmpty);
  });

  test('못 받으면 olderThreadFailed 에 남고 스크롤로는 다시 부르지 않는다 — 다시 시도만 간다', () async {
    final server = _Server(replies: 150)..failOlder = true;
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(await app.loadOlderThread('c1', 'root'), isFalse);
    expect(app.olderThreadFailed, contains('root'));
    final n = server.asked.length;
    expect(await app.loadOlderThread('c1', 'root'), isFalse);
    expect(server.asked.length, n);
    server.failOlder = false;
    expect(await app.retryOlderThread('c1', 'root'), isTrue);
    expect(app.threads['root']!.length, 150);
    expect(app.olderThreadFailed, isEmpty);
  });

  test('다시 붙을 때(catchUp) 밀어 올려 받은 옛 답글을 지우지 않는다', () async {
    final server = _Server(replies: 150);
    final app = await _open(server);
    addTearDown(app.dispose);
    await app.loadOlderThread('c1', 'root');
    expect(app.threads['root']!.length, 150);
    await app.catchUp();
    expect(app.threads['root']!.length, 150);
  });

  test('받는 사이에 로그아웃하면 그 답은 붓지 않는다(세션 세대)', () async {
    final server = _Server(replies: 150);
    final app = await _open(server);
    addTearDown(app.dispose);
    final gate = Completer<void>();
    server.holdOlder = gate.future;
    final pending = app.loadOlderThread('c1', 'root');
    await Future<void>.delayed(Duration.zero);
    await app.signOut();
    gate.complete();
    expect(await pending, isFalse);
    expect(app.threads['root'], isNull);
    expect(app.threadHasMore, isEmpty);
    expect(app.olderThreadFailed, isEmpty);
  });
}

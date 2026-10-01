import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// **실기기 #task 에서 채널에 맨 아래 글 하나만 보였다.** 서버는 최상위와 스레드 답글을 섞어
/// 최근 N 줄을 주고, 채널 화면은 최상위만 그린다. 앱이 50 줄만 한 번 읽어서, 답글이 많은
/// 채널은 걸러 내면 한두 줄만 남았다. 이 파일이 그 모양의 채널을 가짜로 세운다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

/// seq 1..[total] 중 [rootEvery] 번째마다 최상위, 나머지는 그 앞 최상위의 답글.
List<Map<String, Object?>> _channel(int total, int rootEvery) {
  final out = <Map<String, Object?>>[];
  String? root;
  for (var seq = 1; seq <= total; seq++) {
    final isRoot = seq % rootEvery == 1;
    final id = 'm$seq';
    if (isRoot) root = id;
    out.add({
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': isRoot ? null : root,
      'authorId': 'a1',
      'body': '말 $seq',
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
    });
  }
  return out;
}

class _Server {
  _Server(this.all);
  final List<Map<String, Object?>> all;
  final asked = <Map<String, String>>[];

  /// 참이면 `before` 가 붙은 요청(이전 페이지)에 500 으로 답한다.
  bool failOlder = false;

  /// 있으면 `before` 가 붙은 요청의 답을 이것이 끝날 때까지 미룬다.
  Future<void>? holdOlder;

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
        if (path.endsWith('/read')) return _json(<String, Object?>{});
        if (path == '/channels/c1/messages') {
          // 서버와 같은 뜻: 최신 limit 줄(before 가 있으면 그보다 오래된 것 중 최신 limit 줄),
          // 오름차순, hasMore = 그보다 오래된 것이 남았는가.
          final q = req.url.queryParameters;
          asked.add(q);
          final limit = int.parse(q['limit'] ?? '200');
          final before = q['before'] == null ? null : int.parse(q['before']!);
          if (before != null && holdOlder != null) await holdOlder;
          if (before != null && failOlder) {
            return _json({'error': {'code': 'internal', 'message': 'boom'}}, 500);
          }
          final pool = all.where((m) => before == null || (m['seq']! as int) < before).toList();
          final page = pool.length > limit ? pool.sublist(pool.length - limit) : pool;
          final hasMore = page.isNotEmpty && (page.first['seq']! as int) > 1;
          return _json({'messages': page, 'hasMore': hasMore});
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
  await app.openChannel('c1');
  return app;
}

int _roots(AppState app) => app.messages['c1']!.where((m) => m.inChannelFeed).length;

void main() {
  test('첫 페이지는 서버 상한(500)으로 받는다 — 50 이면 답글 많은 채널이 비어 보였다', () async {
    final server = _Server(_channel(100, 1));
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(server.asked.first['limit'], '${AppState.channelPageSize}');
    expect(AppState.channelPageSize, 500);
  });

  test('답글뿐인 첫 페이지를 걸러 최상위가 모자라면 이전 페이지를 더 받는다', () async {
    // 3000 줄 중 100 줄마다 최상위 → 최근 500 줄에 최상위 5개뿐이다.
    final server = _Server(_channel(3000, 100));
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(_roots(app), greaterThanOrEqualTo(AppState.minVisibleRoots));
    // 더 받은 요청은 before 로 갔다.
    expect(server.asked.skip(1).every((q) => q['before'] != null), isTrue);
  });

  test('더 받는 것에는 상한이 있다 — 답글만 끝없는 채널에서 멈춘다', () async {
    final server = _Server(_channel(10000, 5000));
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(server.asked.length, 1 + AppState.maxBackfillPages);
  });

  test('loadOlder: 겹치지 않게 앞에 붙고, 끝에 닿으면 더 부르지 않는다', () async {
    final server = _Server(_channel(700, 1)); // 전부 최상위 → 첫 페이지로 충분
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(app.messages['c1']!.length, 500);
    expect(app.channelHasMore['c1'], isTrue);

    expect(await app.loadOlder('c1'), isTrue);
    final seqs = app.messages['c1']!.map((m) => m.seq).toList();
    expect(seqs.length, 700);
    expect(seqs.toSet().length, 700);
    expect(seqs.first, 1);
    expect(app.channelHasMore['c1'], isFalse);
    expect(feedTopOf(app, 'c1'), FeedTop.start);

    final before = server.asked.length;
    expect(await app.loadOlder('c1'), isFalse);
    expect(server.asked.length, before);
  });

  test('loadOlder 를 겹쳐 부르면 한 번만 간다', () async {
    final server = _Server(_channel(1200, 1));
    final app = await _open(server);
    addTearDown(app.dispose);
    final before = server.asked.length;
    await Future.wait([app.loadOlder('c1'), app.loadOlder('c1')]);
    expect(server.asked.length, before + 1);
  });

  test('이전 페이지를 못 받으면 olderFailed 에 남고, 스크롤로는 다시 부르지 않는다 — 다시 시도만 간다', () async {
    final server = _Server(_channel(1200, 1));
    final app = await _open(server);
    addTearDown(app.dispose);
    server.failOlder = true;
    expect(await app.loadOlder('c1'), isFalse);
    expect(app.olderFailed, contains('c1'));
    expect(app.messages['c1']!.length, 500); // 보이던 것은 그대로다.

    final before = server.asked.length;
    expect(await app.loadOlder('c1'), isFalse); // 스크롤이 다시 불러도
    expect(server.asked.length, before); // 서버에 가지 않는다.

    expect(feedTopOf(app, 'c1'), FeedTop.failed);
    server.failOlder = false;
    expect(await app.retryOlder('c1'), isTrue);
    expect(server.asked.length, before + 1);
    expect(app.olderFailed, isNot(contains('c1')));
  });

  test('받는 사이에 로그아웃하면 그 응답은 합치지 않는다(세션 세대)', () async {
    final server = _Server(_channel(1200, 1));
    final app = await _open(server);
    addTearDown(app.dispose);
    final gate = Completer<void>();
    server.holdOlder = gate.future;
    final pending = app.loadOlder('c1');
    await Future<void>.delayed(Duration.zero);
    await app.signOut();
    gate.complete();
    expect(await pending, isFalse);
    expect(app.messages['c1'], isNull);
    expect(app.channelHasMore, isEmpty);
    expect(app.olderFailed, isEmpty);
  });
}

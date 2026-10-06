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
  int replies;

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
          // 점프 창(`around`): 서버와 같이 그 seq 를 가운데 두고 앞뒤 절반씩, `hasMore` 는 늘 false.
          if (q['around'] != null) {
            final around = int.parse(q['around']!);
            final half = (limit / 2).ceil();
            final up = [for (var s = 1; s <= replies + 1; s++) if (s <= around) s];
            final dn = [for (var s = 1; s <= replies + 1; s++) if (s > around) s];
            final rows = [...(up.length > half ? up.sublist(up.length - half) : up), ...dn.take(half)];
            return _json({'messages': rows.map(_row).toList(), 'hasMore': false});
          }
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

  test('다시 붙을 때(catchUp)는 최신 페이지로 갈고, 옛 답글은 다시 밀어 받게 한다 — 끊긴 사이 지운 답글이 남지 않게', () async {
    final server = _Server(replies: 150);
    final app = await _open(server);
    addTearDown(app.dispose);
    await app.loadOlderThread('c1', 'root');
    expect(app.threads['root']!.length, 150);
    expect(app.threadHasMore['root'], isFalse);
    await app.catchUp();
    // 앞부분은 버리고, 서버가 아직 있다고 하니 다시 밀면 받는다.
    expect(app.threads['root']!.length, 100);
    expect(app.threadHasMore['root'], isTrue);
    expect(await app.loadOlderThread('c1', 'root'), isTrue);
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

  test('링크·찾기로 옛 답글에 갈 때는 그 자리의 창을 받아 합치고, 위로는 before 로 이어진다', () async {
    final server = _Server(replies: 250);
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(app.threads['root']!.length, 100);
    // 옛 답글 seq 120 — 최신 페이지(152..251)에 없다.
    await app.openThread('c1', 'root', aroundSeq: 120);
    expect(server.asked.last['around'], '120');
    final seqs = app.threads['root']!.map((m) => m.seq).toList();
    expect(seqs, contains(120));
    // 창은 **합쳐진다** — 읽던 최신 쪽이 남는다.
    expect(seqs, contains(251));
    expect(seqs, equals([...seqs]..sort()));
    expect(app.threadRoots['root'], isNotNull);
    // 창 응답의 hasMore(false)를 믿지 않고 위로 밀면 before 로 확인한다.
    expect(app.threadHasMore['root'], isTrue);
    expect(await app.loadOlderThread('c1', 'root'), isTrue);
    expect(server.asked.last['before'], seqs.first.toString());
  });

  test('이미 손에 든 줄이면 창을 받지 않고, 처음 여는 스레드는 창 한 번으로 연다', () async {
    final server = _Server(replies: 250);
    final app = await _open(server);
    addTearDown(app.dispose);
    final n = server.asked.length;
    await app.openThread('c1', 'root', aroundSeq: 200);
    expect(server.asked.length, n + 1);
    expect(server.asked.last.containsKey('around'), isFalse);

    final server2 = _Server(replies: 250);
    final app2 = AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me-1',
          'communities': [
            {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
          ],
        }),
      ),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server2.client),
      connector: (_) async => throw StateError('소켓 없음'),
    );
    addTearDown(app2.dispose);
    await app2.boot();
    await app2.openThread('c1', 'root', aroundSeq: 40);
    expect(server2.asked.length, 1);
    expect(server2.asked.single['around'], '40');
    expect(app2.threads['root']!.map((m) => m.seq), contains(40));
    expect(app2.threadLoad['root'], LoadState.loaded);
  });

  test('창이 꽉 차고 손에 든 최신 쪽과 안 닿으면 「최신 답글 빠짐」이 서고, 최신으로 가면 걷힌다 (#1191 후속 d1)', () async {
    final server = _Server(replies: 250);
    final app = await _open(server);
    addTearDown(app.dispose);
    // 최신 페이지 152..251 을 들고 seq 40 의 창(1..90)을 받는다 — 아래쪽 50 줄이 꽉 찼고(더 있을 수 있다)
    // 90 < 152 라 최신 쪽과 안 닿는다 → 빠짐. 위쪽이 39 줄뿐이라 창 전체는 100 이 안 되는데도 그렇다.
    await app.openThread('c1', 'root', aroundSeq: 40);
    expect(app.threadTailMissing, contains('root'));
    // 이어서 seq 120 의 창(71..170): 아래쪽 꽉 찼지만 170 ≥ 152 라 최신 쪽과 맞닿는다 → 빠짐이 걷힌다.
    await app.openThread('c1', 'root', aroundSeq: 120);
    expect(app.threadTailMissing, isEmpty);
    // 다시 멀리(seq 40 은 이미 손에 있어 창 없음) — 손에 없는 더 먼 자리는 없으니 새 앱으로 아래 시험이 본다.
    await app.openThread('c1', 'root', aroundSeq: 40);
    expect(app.threadTailMissing, isEmpty);
    // 빠진 상태를 다시 만들어 최신으로 가는 길을 본다.
    app.threadTailMissing.add('root');
    var asked = server.asked.length;
    await app.jumpToLatestReplies('c1', 'root');
    expect(server.asked.length, asked + 1);
    expect(server.asked.last.containsKey('around'), isFalse);
    expect(server.asked.last.containsKey('before'), isFalse);
    expect(app.threadTailMissing, isEmpty);
    final seqs = app.threads['root']!.map((m) => m.seq).toList();
    expect(seqs.first, 152);
    expect(seqs.last, 251);
    expect(app.threadHasMore['root'], isTrue);
  });

  test('처음 여는 스레드: 옛 답글 창이 꽉 차면 빠짐, 끝 가까운 창(모자람)은 최신까지 들어 있어 빠짐 아님', () async {
    final server = _Server(replies: 250);
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
    addTearDown(app.dispose);
    await app.boot();
    await app.openThread('c1', 'root', aroundSeq: 40);
    expect(app.threadTailMissing, contains('root'));

    final server2 = _Server(replies: 250);
    final app2 = AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me-1',
          'communities': [
            {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
          ],
        }),
      ),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server2.client),
      connector: (_) async => throw StateError('소켓 없음'),
    );
    addTearDown(app2.dispose);
    await app2.boot();
    await app2.openThread('c1', 'root', aroundSeq: 240);
    expect(app2.threads['root']!.map((m) => m.seq), contains(251));
    expect(app2.threadTailMissing, isEmpty);
  });

  test('띠가 선 스레드에 소켓으로 새 답글이 오면 옛 창에 붙이지 않고 세며, 최신으로 가면 그 안에 들어 있고 수는 지워진다', () async {
    final server = _Server(replies: 250);
    final app = await _open(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root', aroundSeq: 40);
    // 띠가 선 상태: 손에는 최신 페이지(152..251)와 창(1..90)이 있고 사이가 비어 있다.
    expect(app.threadTailMissing, contains('root'));
    final before = app.threads['root']!.length;

    Map<String, Object?> reply(int seq, {String kind = 'user'}) => {
          'type': 'message.created',
          'message': {
            'id': 'r$seq',
            'seq': seq,
            'channelId': 'c1',
            'threadRootId': 'root',
            'authorId': 'a2',
            'body': '새 답글 $seq',
            'kind': kind,
          },
        };
    app.applyEvent(reply(252));
    app.applyEvent(reply(253));
    app.applyEvent(reply(254, kind: 'progress'));
    // 창·최신 묶음 어디에도 안 붙고, 진행 줄은 안 센다.
    expect(app.threads['root']!.length, before);
    expect(app.threads['root']!.map((m) => m.seq), isNot(contains(252)));
    expect(app.threadTailNew['root'], 2);

    // 이미 손에 든 답글의 수정(같은 seq)은 그대로 반영된다.
    app.applyEvent({
      'type': 'message.updated',
      'message': {'id': 'r40', 'seq': 40, 'channelId': 'c1', 'threadRootId': 'root', 'authorId': 'a1', 'body': '고침', 'kind': 'user'},
    });
    expect(app.threads['root']!.firstWhere((m) => m.seq == 40).body, '고침');
    expect(app.threadTailNew['root'], 2);

    // 최신으로 가면 수가 지워진다(서버 최신 페이지에 그 답글이 들어 있다).
    server.replies = 253;
    expect(await app.jumpToLatestReplies('c1', 'root'), isTrue);
    expect(app.threadTailMissing, isEmpty);
    expect(app.threadTailNew, isEmpty);
    expect(app.threads['root']!.last.seq, 254);
  });

  test('띠가 없는 스레드에서는 소켓 답글이 전처럼 바로 붙는다(회귀)', () async {
    final server = _Server(replies: 50);
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(app.threadTailMissing, isEmpty);
    app.applyEvent({
      'type': 'message.created',
      'message': {'id': 'r99', 'seq': 99, 'channelId': 'c1', 'threadRootId': 'root', 'authorId': 'a2', 'body': '새', 'kind': 'user'},
    });
    expect(app.threads['root']!.last.seq, 99);
    expect(app.threadTailNew, isEmpty);
  });
}

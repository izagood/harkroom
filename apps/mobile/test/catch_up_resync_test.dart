import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 다시 붙은 뒤 따라잡기는 채널의 **최신 페이지를 다시 읽는다**(2026-11-24).
///
/// 전에는 손에 든 마지막 줄 뒤(`since`)만 물어, 이미 실린 루트에 끊긴 사이 붙은 반응·스레드 상태가 오지
/// 않았고, 따라잡기보다 먼저 더 새 줄이 실리면 사이의 답글까지 빠져 「답글 n개」 줄도 서지 않았다.

http.Response _json(Object body, [int status = 200]) => http.Response.bytes(
  utf8.encode(jsonEncode(body)),
  status,
  headers: {'content-type': 'application/json'},
);

Map<String, Object?> _row(
  int seq, {
  String? root,
  int? replyCount,
  List<Object?> reactions = const [],
  Object? status,
}) => {
  'id': 'm$seq',
  'seq': seq,
  'channelId': 'c1',
  'threadRootId': root,
  'authorId': 'a1',
  'body': 'b$seq',
  'kind': 'user',
  'createdAt': DateTime.utc(
    2026,
    11,
    24,
  ).add(Duration(minutes: seq)).toIso8601String(),
  'replyCount': replyCount,
  'reactions': reactions,
  'statusReaction': status,
};

class _Server {
  /// 채널을 처음 열 때의 사실 — 루트 m1 만 있다(답글·반응 전).
  List<Map<String, Object?>> rows = [_row(1)];
  bool hasMore = false;
  int failNext = 0;
  final asked = <Map<String, String>>[];

  /// 끊긴 사이: m1 에 답글 m2 가 달리고 ✅ 가 붙었다. 그 뒤 다른 글 m3.
  void whileDown() => rows = [
    _row(
      1,
      replyCount: 1,
      reactions: [
        {
          'emoji': '✅',
          'accountIds': ['a2'],
        },
      ],
    ),
    _row(2, root: 'm1'),
    _row(3),
  ];

  MockClient get client => MockClient((req) async {
    final path = req.url.path;
    final q = req.url.queryParameters;
    if (path == '/auth/me') {
      return _json({'id': 'me-1', 'handle': 'me', 'displayName': 'me', 'isAdmin': false});
    }
    if (path == '/channels') {
      return _json({
        'channels': [
          {'id': 'c1', 'name': 'c1', 'kind': 'standard'},
        ],
      });
    }
    if (path == '/accounts') return _json({'accounts': <Object?>[]});
    if (path == '/reads') return _json({'reads': <Object?>[]});
    if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
    if (path.contains('/auto-mentions')) {
      return _json({'autoMentions': <Object?>[]});
    }
    if (path == '/channels/c1/messages') {
      asked.add(q);
      if (failNext > 0) {
        failNext--;
        return _json({
          'error': {'code': 'internal', 'message': 'boom'},
        }, 500);
      }
      return _json({'messages': rows, 'hasMore': hasMore});
    }
    if (path == '/ws-ticket') return _json({'ticket': 'tk'});
    return _json({
      'error': {'code': 'not_found', 'message': path},
    }, 404);
  });
}

Future<AppState> _open(_Server server) async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {
            'accountId': 'me-1',
            'baseUrl': 'https://h.example.com',
            'token': 'tok',
            'handle': 'me',
          },
        ],
      }),
    ),
    apiFactory: (b, t) =>
        ApiClient(baseUrl: b, token: t, httpClient: server.client),
    connector: (_) async => throw StateError('no socket'),
  );
  await app.boot();
  await app.openChannel('c1');
  server.asked.clear();
  return app;
}

MessageRow _root(AppState app) =>
    app.messages['c1']!.firstWhere((m) => m.id == 'm1');

void main() {
  test('이미 실린 루트에 끊긴 사이 붙은 답글 수·반응을 받는다', () async {
    final server = _Server();
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(_root(app).replyCount, isNull);

    server.whileDown();
    await app.catchUp();

    expect(_root(app).replyCount, 1);
    expect(_root(app).reactions.map((r) => r.emoji), ['✅']);
    expect(app.messages['c1']!.map((m) => m.seq), [1, 2, 3]);
    // 마지막 seq 뒤가 아니라 최신 페이지를 물었다.
    expect(server.asked.single.containsKey('since'), isFalse);
  });

  test('따라잡기보다 먼저 더 새 줄이 실려도 사이의 답글이 빠지지 않는다', () async {
    final server = _Server();
    final app = await _open(server);
    addTearDown(app.dispose);

    server.whileDown();
    // 내 글의 응답이나 다시 붙은 소켓의 첫 이벤트가 따라잡기보다 먼저 온 경우.
    app.applyEvent({'type': 'message.created', 'message': _row(3)});
    await app.catchUp();

    expect(_root(app).replyCount, 1);
    expect(_root(app).reactions.map((r) => r.emoji), ['✅']);
    expect(app.messages['c1']!.map((m) => m.seq), [1, 2, 3]);
  });

  test('끊긴 사이 지워진 줄은 남지 않는다', () async {
    final server = _Server()..rows = [_row(1), _row(2)];
    final app = await _open(server);
    addTearDown(app.dispose);

    server.rows = [_row(1)];
    await app.catchUp();

    expect(app.messages['c1']!.map((m) => m.seq), [1]);
  });

  test('페이지와 맞닿은 옛 줄은 남기고, 사이가 떴으면 버리고 hasMore 를 세운다', () async {
    final server = _Server()..rows = [_row(1), _row(2), _row(3)];
    final app = await _open(server);
    addTearDown(app.dispose);

    // 맞닿음: 페이지가 3 부터 — 손에 든 1·2 는 남는다.
    server
      ..rows = [_row(3), _row(4)]
      ..hasMore = true;
    await app.catchUp();
    expect(app.messages['c1']!.map((m) => m.seq), [1, 2, 3, 4]);

    // 사이가 뜸: 페이지가 9 부터 — 5~8 을 모르므로 옛 줄을 버린다.
    server.rows = [_row(9), _row(10)];
    await app.catchUp();
    expect(app.messages['c1']!.map((m) => m.seq), [9, 10]);
    expect(app.channelHasMore['c1'], isTrue);
  });

  test('따라잡는 사이 실시간으로 바뀐 줄은 늦은 페이지가 덮지 않는다', () async {
    final server = _Server();
    final app = await _open(server);
    addTearDown(app.dispose);

    final pending = app.catchUp();
    // 페이지를 보낸 뒤 실시간으로 답글이 왔다 — 페이지(옛 스냅숏)에는 없다.
    app.applyEvent({'type': 'message.created', 'message': _row(2, root: 'm1')});
    await pending;

    expect(app.messages['c1']!.map((m) => m.seq), [1, 2]);
    expect(_root(app).replyCount, 1);
  });

  test('못 읽은 채널은 한 번 더 묻는다', () async {
    final server = _Server();
    final app = await _open(server);
    addTearDown(app.dispose);

    server
      ..whileDown()
      ..failNext = 1;
    await app.catchUp();

    expect(server.asked.length, 2);
    expect(_root(app).replyCount, 1);
  });
}

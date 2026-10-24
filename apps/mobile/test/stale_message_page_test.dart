import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/api_error.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 늦게 도착한 페이지가 그 사이 실시간으로 바뀐 줄을 덮지 않는다(2026-10-24). 그날 5.3초 걸린 스레드 페이지가
/// 답 1초 뒤에 도착해 답한 선택 카드를 다시 열었고, 다시 누르면 409 만 돌아왔다. 데스크톱 `staleMessagePage.test.ts`
/// 의 짝이다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

Map<String, Object?> _row(String id, int seq, {String? root, String? answered}) => {
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': root,
      'authorId': 'a1',
      'body': id,
      'kind': id == 'ask' ? 'ask' : 'user',
      'replyCount': root == null ? 1 : null,
      'meta': id == 'ask'
          ? {
              'kind': 'ask',
              'ask': {
                'options': [
                  {'id': 'a', 'label': '이걸로'},
                  {'id': 'b', 'label': '저걸로'},
                ],
                'to': {'kind': 'human'},
                'answeredWith': ?answered,
              },
            }
          : null,
      'createdAt': DateTime.utc(2026, 10, 24).add(Duration(minutes: seq)).toIso8601String(),
    };

class _Server {
  /// 열리면 페이지 조회가 답한다. 그 전까지 붙잡아 둔다 — 느린 페이지.
  Completer<void>? holdPages;

  /// 서버가 지금 아는 카드의 답. 페이지·단건 조회가 이것을 싣는다.
  String? answered;

  /// 붙잡힌 페이지가 싣는 답 — 보낸 순간의 스냅숏.
  String? pageAnswered;

  int answerStatus = 200;
  bool failRefetch = false;
  final extraReplies = <Map<String, Object?>>[];

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        final q = req.url.queryParameters;
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
        if (path.contains('/auto-mentions')) return _json({'autoMentions': <Object?>[]});
        if (path == '/channels/c1/messages') {
          final snapshot = pageAnswered;
          if (holdPages != null) await holdPages!.future;
          final rows = [
            _row('root', 1),
            _row('ask', 2, root: 'root', answered: snapshot),
            ...extraReplies,
          ];
          return _json({'messages': q['thread'] == 'root' || q['thread'] == null ? rows : <Object?>[], 'hasMore': false});
        }
        if (path == '/channels/c1/messages/ask/ask-answer') {
          if (answerStatus != 200) return _json({'error': {'code': 'ask_closed', 'message': 'closed'}}, answerStatus);
          answered = jsonDecode(req.body)['optionId'] as String;
          return _json(_row('ask', 2, root: 'root', answered: answered));
        }
        if (path == '/messages/ask') {
          if (failRefetch) return _json({'error': {'code': 'internal', 'message': 'boom'}}, 500);
          return _json(_row('ask', 2, root: 'root', answered: answered));
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
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
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client),
    connector: (_) async => throw StateError('소켓 없음'),
  );
  await app.boot();
  return app;
}

String? _answerIn(List<dynamic>? rows) {
  final row = rows?.where((m) => m.id == 'ask').firstOrNull;
  final ask = (row?.meta as Map?)?['ask'] as Map?;
  return ask?['answeredWith'] as String?;
}

void main() {
  test('스레드 페이지가 답 뒤에 도착해도 답한 카드를 다시 열지 않는다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');
    expect(_answerIn(app.threads['root']), isNull);

    // 다시 받는 페이지가 느리다 — 답하기 전 스냅숏을 들고 간다.
    server.holdPages = Completer<void>();
    final slow = app.jumpToLatestReplies('c1', 'root');
    await pumpEventQueue();
    await app.answerAsk('c1', 'ask', 'a');
    expect(_answerIn(app.threads['root']), 'a');

    server.holdPages!.complete();
    await slow;
    expect(_answerIn(app.threads['root']), 'a');
  });

  test('소켓으로 온 답도 늦은 페이지가 덮지 않는다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');

    server.holdPages = Completer<void>();
    final slow = app.jumpToLatestReplies('c1', 'root');
    await pumpEventQueue();
    app.applyEvent({'type': 'message.updated', 'message': _row('ask', 2, root: 'root', answered: 'b')});

    server.holdPages!.complete();
    await slow;
    expect(_answerIn(app.threads['root']), 'b');
  });

  test('페이지를 보낸 뒤에 바뀐 것이 없으면 페이지가 이긴다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');
    app.applyEvent({'type': 'message.updated', 'message': _row('ask', 2, root: 'root', answered: 'b')});

    // 실시간 갱신 **뒤에** 보낸 페이지 — 서버가 참이다(그 사이 다른 기기에서 a 로 바뀌었다고 치자).
    server.pageAnswered = 'a';
    await app.jumpToLatestReplies('c1', 'root');
    expect(_answerIn(app.threads['root']), 'a');
  });

  test('받는 사이 지운 답글을 늦은 페이지가 되살리지 않는다', () async {
    final server = _Server()..extraReplies.add(_row('r3', 3, root: 'root'));
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');
    expect(app.threads['root']!.map((m) => m.id), ['ask', 'r3']);

    server.holdPages = Completer<void>();
    final slow = app.jumpToLatestReplies('c1', 'root');
    await pumpEventQueue();
    app.applyEvent({'type': 'message.deleted', 'channelId': 'c1', 'messageId': 'r3'});

    server.holdPages!.complete();
    await slow;
    expect(app.threads['root']!.map((m) => m.id), ['ask']);
  });

  test('받는 사이 온 새 답글은 페이지로 갈아 끼워도 남는다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');

    server.holdPages = Completer<void>();
    final slow = app.jumpToLatestReplies('c1', 'root');
    await pumpEventQueue();
    app.applyEvent({'type': 'message.created', 'message': _row('r9', 9, root: 'root')});

    server.holdPages!.complete();
    await slow;
    expect(app.threads['root']!.map((m) => m.id), ['ask', 'r9']);
  });

  test('채널을 읽는 사이 스레드에서 답해도 채널 페이지가 카드를 다시 열지 않는다', () async {
    final server = _Server();
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');

    server.holdPages = Completer<void>();
    final opening = app.openChannel('c1');
    await pumpEventQueue();
    await app.answerAsk('c1', 'ask', 'a');

    server.holdPages!.complete();
    await opening;
    expect(_answerIn(app.messages['c1']), 'a');
  });

  test('409(이미 정해짐)면 그 카드를 다시 받아 맞추고 실패로 알리지 않는다', () async {
    final server = _Server()
      ..answered = 'b'
      ..answerStatus = 409;
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');
    expect(_answerIn(app.threads['root']), isNull);

    await app.answerAsk('c1', 'ask', 'a');
    expect(_answerIn(app.threads['root']), 'b');
  });

  test('409 뒤 다시 받기도 실패하면 전처럼 던진다(카드가 실패 토스트를 띄운다)', () async {
    final server = _Server()
      ..answerStatus = 409
      ..failRefetch = true;
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');

    await expectLater(app.answerAsk('c1', 'ask', 'a'), throwsA(isA<ApiError>()));
  });

  test('409 가 아닌 오류는 다시 받지 않고 던진다', () async {
    final server = _Server()..answerStatus = 403;
    final app = await _boot(server);
    addTearDown(app.dispose);
    await app.openThread('c1', 'root');

    await expectLater(app.answerAsk('c1', 'ask', 'a'), throwsA(isA<ApiError>()));
  });
}

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// `charset` 을 **일부러 붙이지 않는다.** `http` 는 그때 latin-1 로 떨어지므로, 한국어
/// 본문이 깨지지 않는지가 여기서 함께 시험된다(`ApiClient._utf8Body`).
http.Response _json(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

/// 서버 대역. 경로별로 답을 정해 두고, 안 정한 경로는 404 로 떨군다 —
/// 시험이 모르는 왕복을 하면 조용히 통과하는 대신 눈에 보이게.
MockClient _server({
  int meStatus = 200,
  List<Map<String, Object?>> channels = const [],
  List<Map<String, Object?>> accounts = const [],
  List<Map<String, Object?>> messages = const [],
  List<Map<String, Object?>> reads = const [],
}) {
  return MockClient((req) async {
    final path = req.url.path;
    if (path == '/auth/login') return _json({'token': 'tok'}, 200);
    if (path == '/auth/me') {
      if (meStatus != 200) {
        return _json({'error': {'code': 'expired', 'message': '폐기됨'}}, meStatus);
      }
      return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false}, 200);
    }
    if (path == '/channels') return _json(channels, 200);
    if (path == '/accounts') return _json(accounts, 200);
    if (path == '/reads') return _json({'reads': reads}, 200);
    if (path.endsWith('/read') && req.method == 'PUT') return http.Response('', 204);
    if (path.endsWith('/messages') && req.method == 'GET') {
      return _json({'messages': messages, 'hasMore': false}, 200);
    }
    if (path.endsWith('/messages') && req.method == 'POST') {
      final body = jsonDecode(req.body) as Map<String, Object?>;
      return _json({
        'id': 'posted',
        'seq': 99,
        'channelId': 'c1',
        'authorId': 'me-1',
        'body': body['body'],
        'kind': 'user',
      }, 200);
    }
    if (path == '/ws-ticket') return _json({'ticket': 'tk'}, 200);
    return _json({'error': {'code': 'not_found', 'message': path}}, 404);
  });
}

/// 열리지 않는 소켓. P0 의 상태 기계 자체는 `ws_test.dart` 가 본다 —
/// 여기서는 소켓이 상태를 어지럽히지 않는 것만 보장하면 된다.
Future<WsConnection> _noSocket(Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다');

AppState _app({SessionStore? store, MockClient? client}) => AppState(
      sessions: store ?? SessionStore.inMemory(),
      apiFactory: (base, token) =>
          ApiClient(baseUrl: base, token: token, httpClient: client ?? _server()),
      connector: _noSocket,
    );

String _seed({String token = 'tok'}) => jsonEncode({
      'active': 'me-1',
      'communities': [
        {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': token, 'handle': 'me'},
      ],
    });

void main() {
  group('부팅', () {
    test('보관된 세션이 없으면 서버 주소부터 묻는다', () async {
      final app = _app();
      await app.boot();
      expect(app.phase, AppPhase.needsServer);
    });

    test('보관된 세션이 있으면 바로 들어간다', () async {
      final app = _app(
        store: SessionStore.inMemory(seed: _seed()),
        client: _server(channels: [
          {'id': 'c1', 'name': 'general', 'kind': 'standard'},
        ], accounts: [
          {'id': 'a1', 'handle': 'forge', 'displayName': 'forge', 'kind': 'agent'},
        ]),
      );
      await app.boot();

      expect(app.phase, AppPhase.ready);
      expect(app.channels.single.name, 'general');
      expect(app.accounts['a1']!.isAgent, isTrue);
    });

    test('토큰이 죽었으면 보관본을 지우고 로그인으로 돌린다', () async {
      // 안 지우면 다음 기동에 같은 실패를 반복한다.
      final store = SessionStore.inMemory(seed: _seed(token: '폐기된토큰'));
      final app = _app(store: store, client: _server(meStatus: 401));
      await app.boot();

      expect(app.phase, AppPhase.needsLogin);
      expect(await store.load(), isNull);
    });
  });

  group('로그인', () {
    test('키체인 저장이 실패해도 로그인을 막지 않고, 대신 말한다', () async {
      final app = _app(store: SessionStore.inMemory(failWrites: true));
      app.setServer('https://h.example.com');
      await app.login('me', 'pw');

      expect(app.phase, AppPhase.ready);
      // 두 가지를 다 말하는 문구의 키다 — 지금은 쓸 수 있고, 다시 켜면 다시 로그인해야 한다.
      expect(app.noticeKey, 'noticeSessionNotSaved');
    });
  });

  group('소켓 이벤트', () {
    late AppState app;

    setUp(() async {
      app = _app(
        store: SessionStore.inMemory(seed: _seed()),
        client: _server(channels: [
          {'id': 'c1', 'name': 'general', 'kind': 'standard'},
        ]),
      );
      await app.boot();
      await app.openChannel('c1');
    });

    Map<String, Object?> created(int seq, String body, {String id = 'm'}) => {
          'type': 'message.created',
          'message': {
            'id': '$id$seq',
            'seq': seq,
            'channelId': 'c1',
            'authorId': 'a1',
            'body': body,
            'kind': 'user',
          },
        };

    test('같은 seq 가 두 번 와도 한 줄만 남는다', () {
      // 두 번 오는 것은 **정상 경로**다: POST 응답으로 한 번, 소켓으로 또 한 번.
      app.applyEvent(created(1, '처음'));
      app.applyEvent(created(1, '처음'));
      expect(app.messages['c1']!.length, 1);
    });

    test('같은 seq 로 다시 오면 덮어쓴다 — 수정이 그 경로다', () {
      app.applyEvent(created(1, '처음'));
      app.applyEvent({
        'type': 'message.updated',
        'message': {
          'id': 'm1',
          'seq': 1,
          'channelId': 'c1',
          'authorId': 'a1',
          'body': '고친 것',
          'kind': 'user',
        },
      });
      expect(app.messages['c1']!.single.body, '고친 것');
    });

    test('순서가 섞여 와도 seq 로 정렬된다', () {
      app.applyEvent(created(3, '셋'));
      app.applyEvent(created(1, '하나'));
      app.applyEvent(created(2, '둘'));
      expect(app.messages['c1']!.map((m) => m.seq), [1, 2, 3]);
    });

    test('열지 않은 채널의 메시지는 쌓지 않는다', () {
      app.applyEvent({
        'type': 'message.created',
        'message': {'id': 'x', 'seq': 1, 'channelId': '안연채널', 'authorId': 'a1', 'body': 'x', 'kind': 'user'},
      });
      expect(app.messages.containsKey('안연채널'), isFalse);
    });

    test('삭제는 그 줄만 지운다', () {
      app.applyEvent(created(1, '하나'));
      app.applyEvent(created(2, '둘'));
      app.applyEvent({'type': 'message.deleted', 'channelId': 'c1', 'messageId': 'm1'});
      expect(app.messages['c1']!.map((m) => m.seq), [2]);
    });

    test('모르는 이벤트는 조용히 지나간다', () {
      // 서버가 이벤트를 하나 더하는 날 옛 앱이 죽지 않게.
      expect(() => app.applyEvent({'type': '아직없는이벤트', 'x': 1}), returnsNormally);
      expect(() => app.applyEvent(const {}), returnsNormally);
    });

    test('모르는 계정의 핸들 변경은 계정을 **지어내지 않는다**', () {
      app.applyEvent({'type': 'account.handle_changed', 'accountId': '없는계정', 'newHandle': 'x'});
      expect(app.accounts.containsKey('없는계정'), isFalse);
    });
  });

  group('리액션은 델타로 온다', () {
    late AppState app;

    setUp(() async {
      app = _app(
        store: SessionStore.inMemory(seed: _seed()),
        client: _server(channels: [
          {'id': 'c1', 'name': 'general', 'kind': 'standard'},
        ]),
      );
      await app.boot();
      await app.openChannel('c1');
      app.applyEvent({
        'type': 'message.created',
        'message': {
          'id': 'm1',
          'seq': 1,
          'channelId': 'c1',
          'authorId': 'a1',
          'body': '하나',
          'kind': 'user',
        },
      });
    });

    Map<String, Object?> delta(String type, String who, [String emoji = '👍']) => {
          'type': type,
          'channelId': 'c1',
          'messageId': 'm1',
          'emoji': emoji,
          'accountId': who,
        };

    test('누르면 칸이 생기고 누가 눌렀는지가 남는다', () {
      app.applyEvent(delta('reaction.added', 'a1'));
      final r = app.messages['c1']!.single.reactions.single;
      expect(r.emoji, '👍');
      expect(r.accountIds, ['a1']);
    });

    test('같은 사람이 두 번 눌러도 한 번이다', () {
      app.applyEvent(delta('reaction.added', 'a1'));
      app.applyEvent(delta('reaction.added', 'a1'));
      expect(app.messages['c1']!.single.reactions.single.accountIds, ['a1']);
    });

    test('마지막 사람이 떼면 칸이 사라진다', () {
      // 아무도 안 누른 이모지가 남아 있으면 그것은 누군가 눌렀다는 거짓 신호다.
      app.applyEvent(delta('reaction.added', 'a1'));
      app.applyEvent(delta('reaction.added', 'b1'));
      app.applyEvent(delta('reaction.removed', 'a1'));
      expect(app.messages['c1']!.single.reactions.single.accountIds, ['b1']);
      app.applyEvent(delta('reaction.removed', 'b1'));
      expect(app.messages['c1']!.single.reactions, isEmpty);
    });

    test('모르는 메시지의 델타는 버린다', () {
      expect(
        () => app.applyEvent({
          'type': 'reaction.added',
          'channelId': 'c1',
          'messageId': '없는메시지',
          'emoji': '👍',
          'accountId': 'a1',
        }),
        returnsNormally,
      );
      expect(app.messages['c1']!.single.reactions, isEmpty);
    });

    test('모양이 깨진 델타는 무시한다', () {
      expect(() => app.applyEvent({'type': 'reaction.added'}), returnsNormally);
    });
  });

  group('읽음', () {
    test('채널을 열면 그 자리에서 안 읽은 수가 0 이 된다', () async {
      // 서버 왕복을 기다리면 채널을 열었는데 배지가 남고, 그건 "또 있나" 로 읽힌다.
      final app = _app(
        store: SessionStore.inMemory(seed: _seed()),
        client: _server(
          channels: [
            {'id': 'c1', 'name': 'general', 'kind': 'standard'},
          ],
          messages: [
            {'id': 'm1', 'seq': 7, 'channelId': 'c1', 'authorId': 'a1', 'body': 'x', 'kind': 'user'},
          ],
          reads: [
            {'channelId': 'c1', 'lastReadSeq': 3, 'unread': 4},
          ],
        ),
      );
      await app.boot();
      expect(app.reads['c1']!.unread, 4);

      await app.openChannel('c1');
      expect(app.reads['c1']!.unread, 0);
      expect(app.reads['c1']!.lastReadSeq, 7);
    });
  });

  group('보내기', () {
    test('POST 응답이 바로 목록에 선다', () async {
      final app = _app(
        store: SessionStore.inMemory(seed: _seed()),
        client: _server(channels: [
          {'id': 'c1', 'name': 'general', 'kind': 'standard'},
        ]),
      );
      await app.boot();
      await app.openChannel('c1');
      await app.send('c1', '@forge 이거 해 줘');

      expect(app.messages['c1']!.single.body, '@forge 이거 해 줘');
    });
  });
}

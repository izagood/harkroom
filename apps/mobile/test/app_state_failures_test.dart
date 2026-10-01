import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// S2: 상태 셋과 실패. **조용히 지나가던 것들**을 하나씩 묶는다 — 부팅 회전자가 영원히 돌던 것,
/// 한 번 못 읽은 채널이 빈 채로 굳던 것, 보내기 실패에 글이 사라지던 것, 다시 붙어도 끊긴
/// 사이의 말이 없던 것.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

String _seed() => jsonEncode({
      'active': 'me-1',
      'communities': [
        {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
      ],
    });

Map<String, Object?> _msg(String id, int seq, {String body = '말'}) =>
    {'id': id, 'seq': seq, 'channelId': 'c1', 'authorId': 'a1', 'body': body, 'kind': 'user'};

/// 경로마다 답을 바꿔 끼울 수 있는 서버. 시험이 도중에 "이제 살아났다"를 만든다.
class _Server {
  bool down = false;
  bool messagesFail = false;
  bool postFails = false;
  final posted = <String>[];
  final sinceAsked = <String?>[];
  List<Map<String, Object?>> channelMessages = [_msg('m1', 1)];

  MockClient get client => MockClient((req) async {
        if (down) throw http.ClientException('네트워크 없음');
        final path = req.url.path;
        if (path == '/auth/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
        }
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'general', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.endsWith('/read')) return _json(<String, Object?>{});
        if (path == '/uploads') {
          return _json({'id': 'att', 'filename': 'a.png', 'contentType': 'image/png', 'sizeBytes': 1});
        }
        if (path.endsWith('/messages') && req.method == 'GET') {
          if (messagesFail) return _json({'error': {'code': 'boom', 'message': 'x'}}, 500);
          sinceAsked.add(req.url.queryParameters['since']);
          return _json({'messages': channelMessages, 'hasMore': false});
        }
        if (path.endsWith('/messages') && req.method == 'POST') {
          if (postFails) return _json({'error': {'code': 'boom', 'message': 'x'}}, 500);
          final body = (jsonDecode(req.body) as Map)['body'] as String;
          posted.add(body);
          return _json({..._msg('p${posted.length}', 100 + posted.length, body: body), 'authorId': 'me-1'});
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

/// 시험이 여닫는 소켓. 닫으면 `WsClient` 가 "네트워크로 끊겼다"로 본다.
class _Socket implements WsConnection {
  final _ctrl = StreamController<String>();

  @override
  int? get closeCode => null;

  @override
  Stream<String> get messages => _ctrl.stream;

  @override
  void send(String payload) {}

  @override
  Future<void> close() async {
    if (!_ctrl.isClosed) await _ctrl.close();
  }
}

AppState _app(_Server server, {List<_Socket>? sockets}) => AppState(
      sessions: SessionStore.inMemory(seed: _seed()),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client),
      connector: (_) async {
        final s = _Socket();
        sockets?.add(s);
        return s;
      },
    );

Future<void> _tick() => Future<void>.delayed(Duration.zero);

void main() {
  group('부팅', () {
    test('서버에 닿지 못하면 회전자에 머물지 않고 "닿지 못했다"로 선다', () async {
      final server = _Server()..down = true;
      final app = _app(server);
      addTearDown(app.dispose);
      await app.boot();
      expect(app.phase, AppPhase.unreachable);
    });

    test('다시 시도하면 들어간다 — 자격증명은 멀쩡하니 로그인으로 보내지 않는다', () async {
      final server = _Server()..down = true;
      final app = _app(server);
      addTearDown(app.dispose);
      await app.boot();
      server.down = false;
      await app.retryBoot();
      expect(app.phase, AppPhase.ready);
    });
  });

  group('채널 읽기', () {
    test('못 읽으면 "못 읽음"이고, 다시 열면 다시 읽는다', () async {
      final server = _Server();
      final app = _app(server);
      addTearDown(app.dispose);
      await app.boot();

      server.messagesFail = true;
      await app.openChannel('c1');
      expect(app.channelLoad['c1'], LoadState.failed);
      // 빈 목록으로 굳지 않는다 — 전에는 그 자리에서 "메시지가 없다"가 됐다.
      expect(app.messages.containsKey('c1'), isFalse);

      server.messagesFail = false;
      await app.openChannel('c1');
      expect(app.channelLoad['c1'], LoadState.loaded);
      expect(app.messages['c1']!.single.id, 'm1');
    });

    test('비어 있는 채널은 "읽음 + 0개"다 — 못 읽은 것과 다르다', () async {
      final server = _Server()..channelMessages = [];
      final app = _app(server);
      addTearDown(app.dispose);
      await app.boot();
      await app.openChannel('c1');
      expect(app.channelLoad['c1'], LoadState.loaded);
      expect(app.messages['c1'], isEmpty);
    });
  });

  group('보내기', () {
    test('실패하면 던지지 않고 목록에 남는다 — 다시 보내면 사라지고 줄이 선다', () async {
      final server = _Server()..postFails = true;
      final app = _app(server);
      addTearDown(app.dispose);
      await app.boot();
      await app.openChannel('c1');

      expect(await app.send('c1', '@forge 이거 해 줘'), isTrue);
      final failed = app.failedSends['c1']!.single;
      expect(failed.body, '@forge 이거 해 줘');

      server.postFails = false;
      await app.resend(failed);
      expect(app.failedSends['c1'], isNull);
      expect(app.messages['c1']!.last.body, '@forge 이거 해 줘');
    });

    test('버리면 그 줄만 사라진다', () async {
      final server = _Server()..postFails = true;
      final app = _app(server);
      addTearDown(app.dispose);
      await app.boot();
      await app.send('c1', '하나');
      await app.send('c1', '둘');
      app.discardFailed(app.failedSends['c1']!.first);
      expect(app.failedSends['c1']!.single.body, '둘');
    });

    test('첨부가 올라가는 중이면 보내지 않고 false — 화면이 작성칸을 비우지 않게', () async {
      final server = _Server();
      final app = _app(server);
      addTearDown(app.dispose);
      await app.boot();
      // 올리기를 시작만 하고 끝나기 전에 보낸다.
      final upload = app.attach('c1', PendingAttachment(filename: 'a.png'), Uint8List(4));
      expect(app.isUploading('c1'), isTrue);
      expect(await app.send('c1', '사진 봐'), isFalse);
      expect(server.posted, isEmpty);
      await upload;
      expect(app.isUploading('c1'), isFalse);
      expect(await app.send('c1', '사진 봐'), isTrue);
      expect(server.posted, ['사진 봐']);
    });
  });

  group('다시 붙으면', () {
    test('읽어 둔 채널을 마지막 seq 뒤부터 다시 읽는다', () async {
      final server = _Server();
      final sockets = <_Socket>[];
      final app = _app(server, sockets: sockets);
      addTearDown(app.dispose);
      await app.boot();
      await app.openChannel('c1');
      await _tick();
      expect(app.connection, SocketState.online);

      // 끊긴 사이에 말이 하나 더 왔다.
      server.channelMessages = [_msg('m2', 2, body: '끊긴 사이의 말')];
      server.sinceAsked.clear();
      await sockets.last.close();
      // 백오프(1초)를 지나 다시 붙는다.
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      await _tick();

      expect(app.connection, SocketState.online);
      expect(server.sinceAsked, contains('1'));
      expect(app.messages['c1']!.map((m) => m.id), ['m1', 'm2']);
    });
  });
}

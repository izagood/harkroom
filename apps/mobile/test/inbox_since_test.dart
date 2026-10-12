import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// `inbox.updated` 는 inbox **전체**가 아니라 마지막 줄 뒤에 생긴 것만 받는다(2026-10-12 inbox 호출 설계 A).
/// 옛 서버는 `since` 를 몰라 전체를 주는데, id 로 합치므로 결과는 전체 읽기와 같아야 한다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

Map<String, Object?> _entry(int id, {String? readAt}) => {
      'id': id,
      'messageId': 'm$id',
      'reason': 'mention',
      'channelId': 'c1',
      'authorId': 'a1',
      'body': '부름 $id',
      'createdAt': DateTime.utc(2026, 10, 12).add(Duration(minutes: id)).toIso8601String(),
      'threadRootId': null,
      'readAt': readAt,
    };

class _Server {
  _Server({this.knowsSince = true});
  final bool knowsSince;
  final rows = <Map<String, Object?>>[_entry(1), _entry(2)];
  final inboxQueries = <String>[];

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
        }
        if (path == '/channels') return _json({'channels': <Object?>[]});
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path == '/inbox') {
          inboxQueries.add(req.url.query);
          final since = knowsSince ? int.tryParse(req.url.queryParameters['since'] ?? '') : null;
          return _json({
            'entries': [for (final r in rows) if (since == null || (r['id'] as int) > since) r],
          });
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        return _json(<String, Object?>{});
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
  await app.loadInbox();
  return app;
}

void main() {
  test('inbox.updated 는 마지막 id 뒤의 것만 묻고 합친다', () async {
    final server = _Server();
    final app = await _open(server);
    addTearDown(app.dispose);
    expect(app.inbox.map((e) => e.id), [1, 2]);

    server.rows.add(_entry(3));
    server.inboxQueries.clear();
    app.applyEvent({'type': 'inbox.updated', 'accountId': 'me-1'});
    await pumpEventQueue();
    expect(server.inboxQueries, ['since=2']);
    expect(app.inbox.map((e) => e.id), [1, 2, 3]);
  });

  test('옛 서버(since 를 모름)가 전체를 줘도 id 로 합쳐 전체 읽기와 같다 — 읽음도 맞춰진다', () async {
    final server = _Server(knowsSince: false);
    final app = await _open(server);
    addTearDown(app.dispose);
    server.rows[0] = _entry(1, readAt: '2026-10-12T10:00:00Z');
    server.rows.add(_entry(3));
    app.applyEvent({'type': 'inbox.updated', 'accountId': 'me-1'});
    await pumpEventQueue();
    expect(app.inbox.map((e) => e.id), [1, 2, 3]);
    expect(app.inbox.first.isUnread, isFalse);
  });
}

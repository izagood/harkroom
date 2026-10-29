import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 채널 만들기·고치기의 바탕(화면 없음) — 능력 읽기, `visibility`·`archivedAt` 읽기, `channel.*` 이벤트, 만들고 멤버 넣기.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

/// 서버가 실제로 싣는 `ChannelRow` 모양(shared `ChannelRow`) — `isPrivate` 키는 없다.
Map<String, Object?> _channel(String id, String name,
        {String visibility = 'public', String? archivedAt, String topic = '', String? repo}) =>
    {
      'id': id,
      'name': name,
      'topic': topic,
      'kind': 'standard',
      'repo': repo,
      'archivedAt': archivedAt,
      'visibility': visibility,
      'createdAt': '2026-10-30T00:00:00.000Z',
    };

class _Server {
  final requests = <http.Request>[];
  final failMemberIds = <String>{};

  MockClient client() => MockClient((req) async {
        requests.add(req);
        final path = req.url.path;
        if (path == '/auth/me') {
          return _json({
            'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false,
            'capabilities': ['channel.create'],
          });
        }
        if (path == '/channels' && req.method == 'GET') {
          return _json({'channels': [_channel('c-1', 'general'), _channel('c-2', 'secret', visibility: 'private')]});
        }
        if (path == '/channels' && req.method == 'POST') {
          final b = jsonDecode(req.body) as Map<String, Object?>;
          return _json(_channel('c-new', b['name'] as String,
              visibility: b['visibility'] as String, topic: (b['topic'] as String?) ?? ''), 201);
        }
        final m = RegExp(r'^/channels/([^/]+)/members$').firstMatch(path);
        if (m != null && req.method == 'POST') {
          final id = (jsonDecode(req.body) as Map<String, Object?>)['accountId'] as String;
          if (failMemberIds.contains(id)) return _json({'error': {'code': 'not_found', 'message': 'x'}}, 404);
          return _json({'members': [{'accountId': 'me-1', 'handle': 'me'}, {'accountId': id, 'handle': id}]});
        }
        if (path == '/channels/c-1' && req.method == 'PATCH') {
          final b = jsonDecode(req.body) as Map<String, Object?>;
          return _json(_channel('c-1', (b['name'] as String?) ?? 'general',
              archivedAt: b['archived'] == true ? '2026-10-30T00:00:00.000Z' : null));
        }
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
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
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client()),
    connector: (_) async => throw StateError('소켓 없음'),
  );
  await app.boot();
  return app;
}

void main() {
  test('ChannelRow 는 visibility·archivedAt·repo 를 읽는다', () {
    final priv = ChannelRow.fromJson(_channel('a', 'x', visibility: 'private', archivedAt: '2026-10-30', repo: 'o/r'));
    expect(priv.isPrivate, isTrue);
    expect(priv.isArchived, isTrue);
    expect(priv.repo, 'o/r');
    final pub = ChannelRow.fromJson(_channel('b', 'y'));
    expect(pub.isPrivate, isFalse);
    expect(pub.isArchived, isFalse);
    // withName 이 새 칸을 잃지 않는다.
    expect(priv.withName('n').isArchived, isTrue);
    expect(priv.withName('n').repo, 'o/r');
  });

  test('MeView 는 capabilities 를 읽고, 없으면 아무 능력도 없다', () {
    final me = MeView.fromJson({'id': 'm', 'capabilities': ['channel.create']});
    expect(me.can('channel.create'), isTrue);
    expect(me.can('channel.manage'), isFalse);
    expect(MeView.fromJson({'id': 'm'}).can('channel.create'), isFalse);
  });

  test('부팅하면 내 능력과 비공개 채널 표시가 상태에 실린다', () async {
    final app = await _boot(_Server());
    expect(app.me!.can('channel.create'), isTrue);
    expect(app.channels.firstWhere((c) => c.id == 'c-2').isPrivate, isTrue);
  });

  test('channel.created/updated/deleted 이벤트가 목록을 고친다', () async {
    final app = await _boot(_Server());
    app.applyEvent({'type': 'channel.created', 'channel': _channel('c-9', 'new')});
    expect(app.channels.map((c) => c.id), contains('c-9'));
    app.applyEvent({'type': 'channel.updated', 'channel': _channel('c-9', 'renamed', archivedAt: '2026-10-30')});
    final row = app.channels.firstWhere((c) => c.id == 'c-9');
    expect(row.name, 'renamed');
    expect(row.isArchived, isTrue);
    expect(app.channels.where((c) => c.id == 'c-9'), hasLength(1));
    app.applyEvent({'type': 'channel.deleted', 'channelId': 'c-9'});
    expect(app.channels.map((c) => c.id), isNot(contains('c-9')));
  });

  test('멤버 이벤트는 들고 있던 명단을 버린다', () async {
    final app = await _boot(_Server());
    app.channelMembers['c-1'] = const [ChannelMember(accountId: 'me-1', handle: 'me')];
    app.applyEvent({'type': 'channel.member_added', 'channelId': 'c-1', 'accountId': 'a-2'});
    expect(app.channelMembers.containsKey('c-1'), isFalse);
  });

  test('만들기: 주제·비공개를 싣고, 처음 멤버를 차례로 넣고, 실패한 멤버만 돌려준다', () async {
    final server = _Server()..failMemberIds.add('a-bad');
    final app = await _boot(server);
    final r = await app.createChannel(name: 'ops', topic: '운영', isPrivate: true, memberIds: ['me-1', 'a-2', 'a-bad']);
    expect(r!.channel.id, 'c-new');
    expect(r.channel.isPrivate, isTrue);
    expect(r.failedMemberIds, ['a-bad']);
    final post = server.requests.firstWhere((q) => q.method == 'POST' && q.url.path == '/channels');
    expect(jsonDecode(post.body), {'name': 'ops', 'topic': '운영', 'visibility': 'private'});
    // 나 자신은 서버가 이미 넣었다 — 다시 넣지 않는다.
    final adds = server.requests.where((q) => q.method == 'POST' && q.url.path == '/channels/c-new/members');
    expect(adds.map((q) => (jsonDecode(q.body) as Map)['accountId']), ['a-2', 'a-bad']);
    expect(app.channels.map((c) => c.id), contains('c-new'));
  });

  test('고치기: 준 키만 싣고 응답 행으로 목록을 바로 고친다', () async {
    final server = _Server();
    final app = await _boot(server);
    await app.updateChannel('c-1', archived: true);
    final patch = server.requests.lastWhere((q) => q.method == 'PATCH');
    expect(jsonDecode(patch.body), {'archived': true});
    expect(app.channels.firstWhere((c) => c.id == 'c-1').isArchived, isTrue);
  });
}

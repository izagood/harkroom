import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Inbox = **안 읽은 멘션·DM** 목록(`GET /inbox`). 「내 작업」 보드(`GET /inbox/board`)는 부르지 않는다 · 읽은 줄은
/// 안 보인다 · 누르면 `POST /inbox/read` 로 읽음 · 머리 숫자와 탭 배지 = 안 읽은 멘션·DM 수(답글은 빠진다).
http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

final _paths = <String>[];
final _reads = <String>[];
String _now(Duration ago) => DateTime.now().toUtc().subtract(ago).toIso8601String();

Map<String, Object?> _entry(int id, {String? root, String? readAt, String reason = 'mention'}) => {
      'id': id, 'messageId': 'm$id', 'reason': reason, 'channelId': 'c1', 'authorId': 'a1',
      'body': '말 $id', 'createdAt': _now(Duration(minutes: id)), 'threadRootId': root, 'readAt': readAt,
    };

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      _paths.add(path);
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') return _json({'channels': [{'id': 'c1', 'name': 'harkroom', 'kind': 'standard'}]});
      if (path == '/accounts') {
        return _json({'accounts': [
          {'id': 'a1', 'handle': 'forge', 'displayName': 'forge', 'kind': 'agent'},
          {'id': 'me-1', 'handle': 'me', 'displayName': '나', 'kind': 'human'},
        ]});
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path == '/inbox/read' && req.method == 'POST') {
        _reads.add(req.body);
        return _json({'ok': true});
      }
      if (path == '/inbox' && req.method == 'GET') {
        return _json({'entries': [
          _entry(1, root: 't1'),
          _entry(2, readAt: _now(Duration.zero)),
          _entry(3, reason: 'dm'),
          _entry(4, root: 't4', reason: 'thread_reply'),
          _entry(5, reason: 'team_mention'),
        ]});
      }
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      if (path.startsWith('/saved')) return _json({'open': 0, 'entries': <Object?>[]});
      return _json({'error': {'code': 'not_found', 'message': path}}, 404);
    });

class _IdleConnection implements WsConnection {
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

AppState _state() => AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me-1',
          'communities': [
            {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
          ],
        }),
      ),
      apiFactory: (base, token) => ApiClient(baseUrl: base, token: token, httpClient: _server()),
      connector: (Uri _) async => _IdleConnection(),
    );

Future<AppState> _openInbox(WidgetTester tester) async {
  final state = _state();
  await tester.pumpWidget(HarkroomApp(state: state));
  await tester.pumpAndSettle();
  addTearDown(state.dispose);
  await tester.tap(find.byKey(const Key('tab-inbox')));
  await tester.pumpAndSettle();
  return state;
}

void main() {
  setUp(() {
    _paths.clear();
    _reads.clear();
  });

  testWidgets('안 읽은 줄만 보이고, 보드는 부르지 않는다', (tester) async {
    final state = await _openInbox(tester);
    expect(find.byKey(const Key('inbox-entry-1')), findsOneWidget);
    expect(find.byKey(const Key('inbox-entry-3')), findsOneWidget);
    expect(find.byKey(const Key('inbox-entry-5')), findsOneWidget);
    expect(find.byKey(const Key('inbox-entry-2')), findsNothing);
    expect(state.inboxMentionCount, 3);
    expect(find.byKey(const Key('inbox-unread-count')), findsOneWidget);
    expect(_paths.where((p) => p.startsWith('/inbox/board')), isEmpty);
  });

  testWidgets('누르면 읽음으로 만들고 숫자가 준다', (tester) async {
    final state = await _openInbox(tester);
    await tester.tap(find.byKey(const Key('inbox-entry-1')));
    await tester.pump();
    expect(state.inboxMentionCount, 2);
    await tester.pump(const Duration(milliseconds: 100));
    expect(_reads, ['{"ids":[1]}']);
  });

  testWidgets('안 읽은 답글(thread_reply)은 목록에도 숫자에도 없다 — 앱 아이콘 배지(inboxUnread)만 센다', (tester) async {
    final state = await _openInbox(tester);
    expect(find.byKey(const Key('inbox-entry-4')), findsNothing);
    expect(state.inboxMentions.map((e) => e.id), isNot(contains(4)));
    expect(state.inboxMentionCount, 3);
    expect(state.inboxUnread, 4);
    expect(find.text('3 unread'), findsOneWidget);
  });
}

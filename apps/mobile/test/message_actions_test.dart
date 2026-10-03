import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_feed.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/message_tile.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 메시지 기능 바 2단계: 수정 · 삭제 · 여기부터 안 읽음 · 채널에도 올리기/거두기.
/// 누구 글에 무엇이 서는지는 데스크톱 `MessageItem` 과 같아야 한다 — 서버가 같은 조건으로 거절한다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, Object?> _row(String id, int seq, String author,
        {String? root, bool also = false, String kind = 'user', String body = '말'}) =>
    {
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': root,
      'authorId': author,
      'body': body,
      'kind': kind,
      'alsoInChannel': also,
      'createdAt': DateTime.utc(2026, 10, 3).add(Duration(minutes: seq)).toIso8601String(),
    };

class _Server {
  _Server({this.admin = false});

  final bool admin;
  final calls = <String>[];
  final bodies = <Object?>[];

  final rows = [
    _row('m1', 1, 'me-1', body: '처음'),
    _row('m2', 2, 'o1'),
    _row('r3', 3, 'me-1', root: 'm1'),
    _row('r4', 4, 'me-1', root: 'm1', also: true),
    _row('s5', 5, 'o1', kind: 'system'),
    _row('m6', 6, 'o1'),
  ];

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (req.method != 'GET') {
          calls.add('${req.method} $path');
          bodies.add(req.body.isEmpty ? null : jsonDecode(req.body));
        }
        if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': admin});
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'task', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') {
          return _json({
            'reads': [
              {'channelId': 'c1', 'lastReadSeq': 6, 'unread': 0},
            ],
          });
        }
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path == '/channels/c1/messages' && req.method == 'GET') {
          final thread = req.url.queryParameters['thread'];
          final list = thread == null ? rows : rows.where((r) => r['id'] == thread || r['threadRootId'] == thread);
          return _json({'messages': list.toList(), 'hasMore': false});
        }
        if (path == '/channels/c1/messages/m1' && req.method == 'PATCH') {
          return _json({...rows[0], 'body': (jsonDecode(req.body) as Map)['body'], 'editedAt': '2026-10-03T01:00:00Z'});
        }
        if (path == '/channels/c1/messages/r3/also-in-channel') return _json({...rows[2], 'alsoInChannel': true});
        if (path == '/channels/c1/messages/r4/also-in-channel') return _json({...rows[3], 'alsoInChannel': false});
        // 답글이 남은 머리를 지우면 서버는 본문을 뗀 자리표시자를 200 으로 돌려준다.
        if (req.method == 'DELETE' && path == '/channels/c1/messages/m1') return _json({...rows[0], 'body': ''});
        if (req.method == 'DELETE' || path.endsWith('/unread') || path.endsWith('/read')) {
          return http.Response('', 204);
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
  await app.openThread('c1', 'm1');
  return app;
}

MessageRow _find(AppState app, String id) =>
    [...app.messages['c1']!, ...app.threads['m1']!].firstWhere((m) => m.id == id);

void main() {
  group('누구 글에 무엇이 서는가', () {
    test('내 글: 수정·삭제, 안 읽음 없음 / 남의 글: 안 읽음만 / 시스템 글: 없음', () async {
      final app = await _open(_Server());
      addTearDown(app.dispose);
      final mine = MessageActionsFor.of(app, _find(app, 'm1'));
      expect([mine.edit, mine.delete, mine.markUnread, mine.postToChannel, mine.recall], [true, true, false, false, false]);
      final other = MessageActionsFor.of(app, _find(app, 'm2'));
      expect([other.edit, other.delete, other.markUnread], [false, false, true]);
      final system = MessageActionsFor.of(app, _find(app, 's5'));
      expect([system.edit, system.delete, system.markUnread, system.postToChannel, system.recall],
          [false, false, false, false, false]);
    });

    test('내 스레드 답글: alsoInChannel 에 따라 올리기·거두기 중 하나만', () async {
      final app = await _open(_Server());
      addTearDown(app.dispose);
      final r3 = MessageActionsFor.of(app, _find(app, 'r3'));
      expect([r3.postToChannel, r3.recall], [true, false]);
      final r4 = MessageActionsFor.of(app, _find(app, 'r4'));
      expect([r4.postToChannel, r4.recall], [false, true]);
    });

    test('admin 은 남의 글도 지운다(수정은 못 한다)', () async {
      final app = await _open(_Server(admin: true));
      addTearDown(app.dispose);
      final other = MessageActionsFor.of(app, _find(app, 'm2'));
      expect([other.delete, other.edit], [true, false]);
      expect(MessageActionsFor.of(app, _find(app, 's5')).delete, isFalse);
    });
  });

  group('서버로 가는 것', () {
    test('수정 → PATCH 본문, 응답으로 덮는다', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      await app.editMessage('c1', 'm1', '고친 말');
      expect(server.calls.last, 'PATCH /channels/c1/messages/m1');
      expect(server.bodies.last, {'body': '고친 말'});
      expect(_find(app, 'm1').body, '고친 말');
    });

    test('삭제 → DELETE, 채널과 스레드 양쪽에서 뺀다', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      await app.deleteMessage('c1', 'r4');
      expect(server.calls.last, 'DELETE /channels/c1/messages/r4');
      expect(app.messages['c1']!.any((m) => m.id == 'r4'), isFalse);
      expect(app.threads['m1']!.any((m) => m.id == 'r4'), isFalse);
    });

    test('답글이 남은 머리를 지우면 자리표시자로 덮는다 — 소켓이 먼저 와도 빼지 않는다(security F1)', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      // 서버는 응답보다 먼저 message.updated 를 낸다.
      app.applyEvent({'type': 'message.updated', 'message': {...server.rows[0], 'body': ''}});
      await app.deleteMessage('c1', 'm1');
      expect(server.calls.last, 'DELETE /channels/c1/messages/m1');
      expect(app.messages['c1']!.where((m) => m.id == 'm1').single.body, '');
    });

    test('채널에도 올리기 PUT · 거두기 DELETE', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      await app.setAlsoInChannel('c1', 'r3', true);
      expect(server.calls.last, 'PUT /channels/c1/messages/r3/also-in-channel');
      expect(_find(app, 'r3').alsoInChannel, isTrue);
      await app.setAlsoInChannel('c1', 'r4', false);
      expect(server.calls.last, 'DELETE /channels/c1/messages/r4/also-in-channel');
      expect(app.threads['m1']!.firstWhere((m) => m.id == 'r4').alsoInChannel, isFalse);
    });

    test('여기부터 안 읽음 → 그 메시지의 seq, 경계는 그 앞, 내 글은 세지 않는다', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      await app.markUnreadFrom(_find(app, 'm2'));
      expect(server.calls.last, 'PUT /channels/c1/unread');
      expect(server.bodies.last, {'seq': 2});
      expect(app.reads['c1']!.lastReadSeq, 1);
      // seq 2..6 중 남의 글은 m2·s5·m6 셋.
      expect(app.reads['c1']!.unread, 3);
    });
  });

  group('시트', () {
    Future<(_Server, AppState)> pump(WidgetTester tester, String id, {VoidCallback? onOpenThread}) async {
      final server = _Server();
      late AppState app;
      await tester.runAsync(() async => app = await _open(server));
      addTearDown(app.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        home: I18n(
          strings: stringsFor('ko'),
          child: AppScope(
            state: app,
            child: Scaffold(
                body: Builder(
                    builder: (c) => buildFeedItem(c, FeedMessage(_find(app, id)), onOpenThread: (_) => onOpenThread?.call()))),
          ),
        ),
      ));
      return (server, app);
    }

    testWidgets('내 글: 손잡이(n1), 수정, 구분선 아래 삭제, 안 읽음 없음', (tester) async {
      await pump(tester, 'm1');
      await tester.longPress(find.byKey(const Key('message-press-m1')));
      await tester.pumpAndSettle();
      expect(tester.widget<BottomSheet>(find.byType(BottomSheet)).showDragHandle, isTrue);
      expect(find.byKey(const Key('message-action-edit')), findsOneWidget);
      expect(find.byKey(const Key('message-action-delete')), findsOneWidget);
      expect(find.byKey(const Key('message-action-markUnread')), findsNothing);
      // 삭제가 맨 끝이다.
      final deleteY = tester.getTopLeft(find.byKey(const Key('message-action-delete'))).dy;
      final editY = tester.getTopLeft(find.byKey(const Key('message-action-edit'))).dy;
      expect(deleteY, greaterThan(editY));
    });

    testWidgets('남의 글: 안 읽음만, 수정·삭제 없음', (tester) async {
      await pump(tester, 'm2');
      await tester.longPress(find.byKey(const Key('message-press-m2')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-action-markUnread')), findsOneWidget);
      expect(find.byKey(const Key('message-action-edit')), findsNothing);
      expect(find.byKey(const Key('message-action-delete')), findsNothing);
    });

    testWidgets('삭제는 확인창을 거친다 — 취소하면 아무것도 안 간다', (tester) async {
      final (server, _) = await pump(tester, 'm1');
      await tester.longPress(find.byKey(const Key('message-press-m1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('message-action-delete')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-delete-dialog')), findsOneWidget);
      await tester.tap(find.byKey(const Key('message-delete-cancel')));
      await tester.pumpAndSettle();
      expect(server.calls.where((c) => c.startsWith('DELETE')), isEmpty);

      await tester.longPress(find.byKey(const Key('message-press-m1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('message-action-delete')));
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('message-delete-confirm')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      expect(server.calls, contains('DELETE /channels/c1/messages/m1'));
    });

    testWidgets('수정창은 원문으로 채우고, 비우면 저장이 꺼진다', (tester) async {
      await pump(tester, 'm1');
      await tester.longPress(find.byKey(const Key('message-press-m1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('message-action-edit')));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.byKey(const Key('message-edit-field'))).controller!.text, '처음');
      await tester.enterText(find.byKey(const Key('message-edit-field')), '  ');
      await tester.pump();
      expect(tester.widget<TextButton>(find.byKey(const Key('message-edit-save'))).onPressed, isNull);
      await tester.tap(find.byKey(const Key('message-edit-cancel')));
      await tester.pumpAndSettle();
    });

    testWidgets('채널에도 올리기는 짧게 알린다(designer D1)', (tester) async {
      final (server, _) = await pump(tester, 'r3');
      await tester.longPress(find.byKey(const Key('message-press-r3')));
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('message-action-postToChannel')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(server.calls, contains('PUT /channels/c1/messages/r3/also-in-channel'));
      expect(find.text('채널에도 올렸다'), findsOneWidget);
    });

    testWidgets('시스템 글은 탭해도 스레드가 열리지 않는다(n2)', (tester) async {
      var opened = 0;
      await pump(tester, 's5', onOpenThread: () => opened++);
      await tester.tap(find.byKey(const Key('message-press-s5')));
      await tester.pump();
      expect(opened, 0);
    });
  });
}

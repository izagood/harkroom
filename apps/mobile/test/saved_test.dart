import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/channel_list_screen.dart';
import 'package:harkroom/screens/message_feed.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/saved_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 모바일 저장(나중에 보기, #219) PR①: 시트의 담기·빼기 · 표식 · 홈 카드 「저장 N」 · 저장 화면.
/// 서버 `/saved` API 를 그대로 쓴다 — 가짜 서버는 그 라우트의 모양(messageRoutes.ts)대로 답한다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, Object?> _row(String id, int seq, String author, {String kind = 'user', String body = '말'}) => {
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': null,
      'authorId': author,
      'body': body,
      'kind': kind,
      'createdAt': DateTime.utc(2026, 10, 3).add(Duration(minutes: seq)).toIso8601String(),
    };

class _Server {
  _Server({this.failList = false, this.failSummary = false});

  bool failList;
  final bool failSummary;
  final calls = <String>[];
  final bodies = <Object?>[];

  final rows = [
    _row('m1', 1, 'o1', body: '첫 말'),
    _row('m2', 2, 'o1', body: '담을 말'),
    _row('s3', 3, 'o1', kind: 'system'),
  ];

  /// 담긴 것: id → (state, 담은 순번). gone 은 지운 글, hidden 은 볼 수 없는 채널의 글.
  final saved = <String, (String, int)>{'m1': ('open', 1), 'gone': ('open', 0), 'hidden': ('done', -1)};
  var _clock = 10;

  Map<String, Object?> _entry(String id) {
    final (state, at) = saved[id]!;
    final message = rows.where((r) => r['id'] == id).firstOrNull;
    return {
      'messageId': id,
      'channelId': 'c1',
      'state': state,
      'createdAt': DateTime.utc(2026, 10, 4).add(Duration(minutes: at)).toIso8601String(),
      'doneAt': null,
      'deleted': id == 'gone',
      'message': message,
    };
  }

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (req.method != 'GET') {
          calls.add('${req.method} $path');
          bodies.add(req.body.isEmpty ? null : jsonDecode(req.body));
        }
        if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나'});
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'task', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/accounts') {
          return _json({
            'accounts': [
              {'id': 'o1', 'handle': 'jaebin', 'displayName': '재빈'},
            ],
          });
        }
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path == '/channels/c1/messages' && req.method == 'GET') {
          return _json({'messages': rows, 'hasMore': false});
        }
        if (path == '/saved/summary') {
          if (failSummary) return _json({'error': {'code': 'boom', 'message': 'x'}}, 500);
          return _json({
            'openCount': saved.values.where((v) => v.$1 == 'open').length,
            'messageIds': saved.keys.toList(),
          });
        }
        if (path == '/saved' && req.method == 'GET') {
          if (failList) return _json({'error': {'code': 'boom', 'message': 'x'}}, 500);
          final state = req.url.queryParameters['state'] ?? 'open';
          final ids = saved.keys.where((k) => saved[k]!.$1 == state).toList()
            ..sort((a, b) => saved[b]!.$2.compareTo(saved[a]!.$2));
          return _json({'entries': ids.map(_entry).toList()});
        }
        if (path.startsWith('/saved/')) {
          final id = path.substring('/saved/'.length);
          switch (req.method) {
            case 'PUT':
              if (id == 's9') return _json({'error': {'code': 'not_found', 'message': 'x'}}, 404);
              saved[id] = ('open', _clock++);
              return _json(_entry(id));
            case 'PATCH':
              final state = (jsonDecode(req.body) as Map)['state'] as String;
              saved[id] = (state, saved[id]!.$2);
              return _json(_entry(id));
            case 'DELETE':
              saved.remove(id);
              return http.Response('', 204);
          }
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
  // 요약은 들어간 뒤 기다리지 않고 따라온다 — 시험에서는 끝날 때까지 한 번 더 받는다.
  await app.loadSavedSummary();
  await app.openChannel('c1');
  return app;
}

MessageRow _find(AppState app, String id) => app.messages['c1']!.firstWhere((m) => m.id == id);

// 밀어 넣은 화면(저장 화면)도 AppScope 를 보도록 길잡이 **위**에 둔다 — 앱 루트와 같은 자리다.
Widget _host(AppState app, Widget child) => MaterialApp(
      theme: harkroomTheme(Brightness.light),
      builder: (_, nav) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: nav!)),
      home: child,
    );

/// 실제 HTTP(MockClient) 왕복이 끝나도록 진짜 시간을 조금 흘린다.
Future<void> _settle(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  group('상태', () {
    test('들어가면 요약을 받는다 — 담긴 id(할 것·완료 둘 다)와 할 것 개수', () async {
      final app = await _open(_Server());
      addTearDown(app.dispose);
      expect(app.savedIds, {'m1', 'gone', 'hidden'});
      expect(app.savedOpenCount, 2);
      expect(app.isSaved('m1'), isTrue);
      expect(app.isSaved('m2'), isFalse);
    });

    test('담기 → PUT /saved/:id, 표식과 숫자가 선다', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      await app.saveMessage('m2');
      expect(server.calls, contains('PUT /saved/m2'));
      expect(app.isSaved('m2'), isTrue);
      await app.loadSavedSummary();
      expect(app.savedOpenCount, 3);
    });

    test('빼기 → DELETE, 두 칸 어디서든 줄이 빠진다', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      await app.loadSaved(SavedState.done);
      expect(app.saved[SavedState.done]!.map((e) => e.messageId), ['hidden']);
      await app.unsaveMessage('hidden');
      expect(server.calls, contains('DELETE /saved/hidden'));
      expect(app.saved[SavedState.done], isEmpty);
      expect(app.isSaved('hidden'), isFalse);
    });

    test('완료로 표시 → PATCH {state}, 읽어 둔 칸 사이에서 줄이 옮겨 가고 숫자가 준다', () async {
      final server = _Server();
      final app = await _open(server);
      addTearDown(app.dispose);
      await app.loadSaved(SavedState.open);
      await app.loadSaved(SavedState.done);
      await app.setSavedState('m1', SavedState.done);
      expect(server.calls, contains('PATCH /saved/m1'));
      expect(server.bodies[server.calls.indexOf('PATCH /saved/m1')], {'state': 'done'});
      expect(app.saved[SavedState.open]!.map((e) => e.messageId), ['gone']);
      // 담은 때 새것 먼저(m1 이 hidden 보다 나중에 담겼다).
      expect(app.saved[SavedState.done]!.map((e) => e.messageId), ['m1', 'hidden']);
      expect(app.saved[SavedState.done]!.first.state, SavedState.done);
      expect(app.savedOpenCount, 1);
    });

    test('지운 글·볼 수 없는 채널의 글은 message 가 null 로 온다(줄은 남는다)', () async {
      final app = await _open(_Server());
      addTearDown(app.dispose);
      await app.loadSaved(SavedState.open);
      final gone = app.saved[SavedState.open]!.firstWhere((e) => e.messageId == 'gone');
      expect([gone.message, gone.deleted], [null, true]);
      await app.loadSaved(SavedState.done);
      final hidden = app.saved[SavedState.done]!.single;
      expect([hidden.message, hidden.deleted], [null, false]);
    });

    test('못 읽으면 failed — 빈 목록(loaded)으로 삼키지 않는다', () async {
      final app = await _open(_Server(failList: true));
      addTearDown(app.dispose);
      await app.loadSaved(SavedState.open);
      expect(app.savedLoad[SavedState.open], LoadState.failed);
      expect(app.failures['saved-open'], LoadFailure.server);
    });

    test('요약을 못 받아도(5xx) 들어가는 것은 막히지 않고 표식·숫자만 비어 있다', () async {
      final app = await _open(_Server(failSummary: true));
      addTearDown(app.dispose);
      expect(app.phase, AppPhase.ready);
      expect(app.savedIds, isEmpty);
      expect(app.savedOpenCount, 0);
    });
  });

  group('메시지 시트', () {
    Future<(_Server, AppState)> pump(WidgetTester tester, String id) async {
      final server = _Server();
      late AppState app;
      await tester.runAsync(() async => app = await _open(server));
      addTearDown(app.dispose);
      await tester.pumpWidget(_host(
        app,
        Scaffold(body: Builder(builder: (c) => buildFeedItem(c, FeedMessage(_find(app, id)), onOpenThread: (_) {}))),
      ));
      return (server, app);
    }

    testWidgets('안 담은 글: 「나중에 보기로 담기」가 본문 복사 아래·안 읽음 위에 선다', (tester) async {
      await pump(tester, 'm2');
      expect(find.byKey(const Key('saved-mark-m2')), findsNothing);
      await tester.longPress(find.byKey(const Key('message-press-m2')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-action-save')), findsOneWidget);
      expect(find.byKey(const Key('message-action-unsave')), findsNothing);
      expect(find.text('나중에 보기로 담기'), findsOneWidget);
      final y = tester.getTopLeft(find.byKey(const Key('message-action-save'))).dy;
      expect(y, greaterThan(tester.getTopLeft(find.byKey(const Key('message-action-copy-body'))).dy));
      expect(y, lessThan(tester.getTopLeft(find.byKey(const Key('message-action-markUnread'))).dy));
    });

    testWidgets('담으면 PUT, 표식 「나중을 위해 저장됨」과 「담았다 · 목록 보기」 토스트', (tester) async {
      final (server, _) = await pump(tester, 'm2');
      await tester.longPress(find.byKey(const Key('message-press-m2')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('message-action-save')));
      await _settle(tester);
      expect(server.calls, contains('PUT /saved/m2'));
      expect(find.byKey(const Key('saved-mark-m2')), findsOneWidget);
      expect(find.text('나중을 위해 저장됨'), findsOneWidget);
      expect(find.byKey(const Key('saved-added')), findsOneWidget);
      expect(find.text('목록 보기'), findsOneWidget);
    });

    testWidgets('담은 글: 같은 자리가 「담은 것 빼기」 — 빼면 DELETE 와 「뺐다 · 되돌리기」, 되돌리면 다시 PUT', (tester) async {
      final (server, _) = await pump(tester, 'm1');
      expect(find.byKey(const Key('saved-mark-m1')), findsOneWidget);
      await tester.longPress(find.byKey(const Key('message-press-m1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-action-save')), findsNothing);
      await tester.tap(find.byKey(const Key('message-action-unsave')));
      await _settle(tester);
      expect(server.calls, contains('DELETE /saved/m1'));
      expect(find.byKey(const Key('saved-mark-m1')), findsNothing);
      expect(find.byKey(const Key('saved-removed')), findsOneWidget);
      await tester.tap(find.text('되돌리기'));
      await _settle(tester);
      expect(server.calls.last, 'PUT /saved/m1');
      expect(find.byKey(const Key('saved-mark-m1')), findsOneWidget);
    });

    testWidgets('시스템 글에는 담기·빼기 줄이 없다', (tester) async {
      await pump(tester, 's3');
      await tester.longPress(find.byKey(const Key('message-press-s3')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-action-save')), findsNothing);
      expect(find.byKey(const Key('message-action-unsave')), findsNothing);
    });
  });

  group('홈 카드', () {
    testWidgets('셋째 칸 「저장」에 할 것 개수, 누르면 저장 화면', (tester) async {
      final server = _Server();
      late AppState app;
      await tester.runAsync(() async => app = await _open(server));
      addTearDown(app.dispose);
      // 가장 좁은 폰(375pt)에서도 카드 이름이 잘리지 않는다.
      tester.view.physicalSize = const Size(375, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(_host(app, const Scaffold(body: ShortcutCards(newCount: 5))));
      final card = find.byKey(const Key('card-saved'));
      expect(card, findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('저장')), findsOneWidget);
      expect(find.descendant(of: card, matching: find.text('2')), findsOneWidget);
      for (final label in ['내 차례', '새로 온 것', '저장']) {
        final text = tester.renderObject<RenderParagraph>(find.text(label));
        expect(text.didExceedMaxLines, isFalse, reason: '$label 가 잘렸다');
      }
      await tester.tap(card);
      await tester.pump();
      await _settle(tester);
      expect(find.byType(SavedScreen), findsOneWidget);
    });
  });

  group('저장 화면', () {
    Future<(_Server, AppState)> pump(WidgetTester tester, {bool failList = false}) async {
      final server = _Server(failList: failList);
      late AppState app;
      await tester.runAsync(() async => app = await _open(server));
      addTearDown(app.dispose);
      await tester.pumpWidget(_host(app, const SavedScreen()));
      await _settle(tester);
      return (server, app);
    }

    testWidgets('할 것 칸: 채널 칩·@작성자·본문, 지운 글은 흐린 줄로 남고 누를 수 없다', (tester) async {
      await pump(tester);
      expect(find.text('할 것 2'), findsOneWidget);
      expect(find.byKey(const Key('saved-row-m1')), findsOneWidget);
      expect(find.text('#task'), findsWidgets);
      expect(find.textContaining('@jaebin'), findsOneWidget);
      expect(find.text('첫 말'), findsOneWidget);
      expect(find.text('삭제된 메시지'), findsOneWidget);
      expect(tester.widget<InkWell>(find.byKey(const Key('saved-row-gone'))).onTap, isNull);
      expect(tester.widget<InkWell>(find.byKey(const Key('saved-row-m1'))).onTap, isNotNull);
      // 지운 글도 ✓ 는 된다 — 안 그러면 그 줄을 치울 길이 없다.
      expect(find.byKey(const Key('saved-toggle-gone')), findsOneWidget);
    });

    testWidgets('✓ → PATCH done, 줄이 완료 칸으로 가고 「완료로 옮겼다 · 되돌리기」, 되돌리면 PATCH open', (tester) async {
      final (server, _) = await pump(tester);
      await tester.tap(find.byKey(const Key('saved-toggle-m1')));
      await _settle(tester);
      expect(server.calls, contains('PATCH /saved/m1'));
      expect(find.byKey(const Key('saved-row-m1')), findsNothing);
      expect(find.byKey(const Key('saved-moved-done')), findsOneWidget);
      await tester.tap(find.text('되돌리기'));
      await _settle(tester);
      expect(server.bodies.last, {'state': 'open'});
      expect(find.byKey(const Key('saved-row-m1')), findsOneWidget);
    });

    testWidgets('완료 칸: 볼 수 없는 채널의 글 문구, 버튼은 ↺(할 것으로 되돌리기)', (tester) async {
      await pump(tester);
      await tester.tap(find.byKey(const Key('saved-tab-done')));
      await tester.pump();
      expect(find.text('이 채널을 볼 수 없어 내용을 보여 줄 수 없다'), findsOneWidget);
      expect(tester.widget<IconButton>(find.byKey(const Key('saved-toggle-hidden'))).tooltip, '할 것으로 되돌리기');
    });

    testWidgets('길게 누르면 「담은 것 빼기」 → DELETE, 줄이 빠진다', (tester) async {
      final (server, _) = await pump(tester);
      await tester.longPress(find.byKey(const Key('saved-row-gone')));
      await tester.pumpAndSettle();
      // 지운 글은 링크 복사가 없다 — 갈 곳이 없다.
      expect(find.byKey(const Key('saved-action-copy-link')), findsNothing);
      await tester.tap(find.byKey(const Key('saved-action-unsave')));
      await _settle(tester);
      expect(server.calls, contains('DELETE /saved/gone'));
      expect(find.byKey(const Key('saved-row-gone')), findsNothing);
    });

    testWidgets('빈 할 것 칸은 담는 법을, 빈 완료 칸은 한 줄만 말한다', (tester) async {
      final (server, app) = await pump(tester);
      server.saved.clear();
      await tester.runAsync(() async {
        await app.loadSaved(SavedState.open);
        await app.loadSaved(SavedState.done);
      });
      await tester.pump();
      expect(find.text('저장된 메시지가 없다'), findsOneWidget);
      expect(find.textContaining('길게 눌러'), findsOneWidget);
      await tester.tap(find.byKey(const Key('saved-tab-done')));
      await tester.pump();
      expect(find.text('완료된 메시지가 없다'), findsOneWidget);
      expect(find.textContaining('길게 눌러'), findsNothing);
    });

    testWidgets('못 읽으면 실패 상태와 다시 시도 — 빈 상태가 같이 서지 않는다', (tester) async {
      final (server, _) = await pump(tester, failList: true);
      expect(find.byKey(const Key('state-failed')), findsOneWidget);
      expect(find.byKey(const Key('state-empty')), findsNothing);
      server.failList = false;
      await tester.tap(find.byKey(const Key('state-retry')));
      await _settle(tester);
      expect(find.byKey(const Key('saved-row-m1')), findsOneWidget);
    });
  });
}

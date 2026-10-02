import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/api_error.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_feed.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 본문의 `harkroom://message/<id>` 를 누르면 앱 안에서 그 메시지로 간다. 실패는 데스크톱
/// `openMessage` 와 같은 세 갈래(없다·못 본다·연결)로 보인다.

const _reply = '11111111-1111-4111-8111-111111111111';
const _root = '22222222-2222-4222-8222-222222222222';
const _gone = '33333333-3333-4333-8333-333333333333';
const _dm = '44444444-4444-4444-8444-444444444444';
const _down = '55555555-5555-4555-8555-555555555555';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

Map<String, Object?> _row(String id, int seq, {String? root, String body = '말'}) => {
      'id': id,
      'seq': seq,
      'channelId': 'c2',
      'threadRootId': root,
      'authorId': 'a1',
      'body': body,
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
    };

/// 서버 라우트(`messageRoutes.ts` 의 `GET /messages/:id`)와 같은 뜻: 있으면 행, 없으면 404,
/// 남의 DM 이면 403.
class _Server {
  final lookups = <String>[];

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
        }
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'harkroom', 'kind': 'standard'},
              {'id': 'c2', 'name': 'task', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.contains('/agent-models') || path.contains('/auto-mentions')) {
          return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
        }
        if (path.startsWith('/messages/')) {
          final id = path.substring('/messages/'.length);
          lookups.add(id);
          if (id == _reply) return _json(_row(_reply, 9, root: _root, body: '답글'));
          if (id == _root) return _json(_row(_root, 3, body: '옛 원글'));
          if (id == _dm) return _json({'error': {'code': 'forbidden', 'message': 'dm'}}, 403);
          if (id == _down) return _json({'error': {'code': 'internal', 'message': 'boom'}}, 500);
          return _json({'error': {'code': 'not_found', 'message': 'no such message'}}, 404);
        }
        if (path == '/channels/c2/messages') {
          final q = req.url.queryParameters;
          if (q['thread'] == _root) {
            return _json({'messages': [_row(_root, 3, body: '옛 원글'), _row(_reply, 9, root: _root, body: '답글')], 'hasMore': false});
          }
          return _json({'messages': <Object?>[], 'hasMore': false});
        }
        if (path.startsWith('/channels/') && path.endsWith('/messages')) {
          return _json({'messages': <Object?>[], 'hasMore': false});
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

MessageRow _linking(String target) => MessageRow.fromJson({
      ..._row('src', 1, body: '[#task 스레드](harkroom://message/$target) 봐'),
      'channelId': 'c1',
    });

/// 첫 번째 누를 수 있는 링크를 누른다.
Future<void> _tapLink(WidgetTester tester) async {
  TapGestureRecognizer? r;
  for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
    rich.text.visitChildren((span) {
      if (span is TextSpan && span.recognizer is TapGestureRecognizer) {
        r ??= span.recognizer! as TapGestureRecognizer;
      }
      return true;
    });
  }
  expect(r, isNotNull, reason: '메시지 링크가 누를 수 있게 그려져야 한다');
  r!.onTap!();
  // 가짜 HTTP 는 진짜 비동기다 — runAsync 안에서 답을 받게 한 뒤 그린다.
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _pump(WidgetTester tester, AppState app, MessageRow m) => tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child!)),
      home: Scaffold(body: Builder(builder: (c) => buildFeedItem(c, FeedMessage(m)))),
    ));

void main() {
  group('locateMessage', () {
    test('답글이면 그 스레드 루트를, 이미 읽어 둔 것이면 왕복하지 않는다', () async {
      final server = _Server();
      final app = await _boot(server);
      addTearDown(app.dispose);
      final row = await app.locateMessage(_reply);
      expect(row!.channelId, 'c2');
      expect(row.threadRootId, _root);
      // 최상위 글은 스레드 루트 자리에 넣어 둔다 — 채널에 안 실린 옛 글도 스레드 화면이 바로 그린다.
      await app.locateMessage(_root);
      expect(app.threadRoots[_root]?.body, '옛 원글');
      final n = server.lookups.length;
      await app.locateMessage(_root);
      expect(server.lookups.length, n);
    });

    test('없으면 404, 못 보는 대화면 403 을 그대로 던진다 — 할 말은 화면이 정한다', () async {
      final app = await _boot(_Server());
      addTearDown(app.dispose);
      await expectLater(app.locateMessage(_gone), throwsA(isA<ApiError>().having((e) => e.status, 'status', 404)));
      await expectLater(app.locateMessage(_dm), throwsA(isA<ApiError>().having((e) => e.status, 'status', 403)));
      // 403 이어도 로그아웃으로 오해하지 않는다(부팅의 자격증명 판정과 무관).
      expect(app.phase, isNot(AppPhase.needsLogin));
    });
  });

  group('누르기', () {
    testWidgets('답글 링크 → 그 스레드 화면', (tester) async {
      final server = _Server();
      final app = (await tester.runAsync(() => _boot(server)))!;
      addTearDown(app.dispose);
      await _pump(tester, app, _linking(_reply));
      await _tapLink(tester);
      final screen = tester.widget<ThreadScreen>(find.byType(ThreadScreen));
      expect(screen.channelId, 'c2');
      expect(screen.rootId, _root);
    });

    testWidgets('최상위 글 링크 → 그 글을 루트로 한 스레드 화면', (tester) async {
      final app = (await tester.runAsync(() => _boot(_Server())))!;
      addTearDown(app.dispose);
      await _pump(tester, app, _linking(_root));
      await _tapLink(tester);
      expect(tester.widget<ThreadScreen>(find.byType(ThreadScreen)).rootId, _root);
    });

    for (final (id, text, retry) in [
      (_gone, stringsFor('ko').messageLinkGone, false),
      (_dm, stringsFor('ko').messageLinkForbidden, false),
      (_down, stringsFor('ko').messageLinkFailed, true),
    ]) {
      testWidgets('실패는 토스트로 보인다 — $text', (tester) async {
        final app = (await tester.runAsync(() => _boot(_Server())))!;
        addTearDown(app.dispose);
        await _pump(tester, app, _linking(id));
        await _tapLink(tester);
        expect(find.byType(ThreadScreen), findsNothing);
        expect(find.text(text), findsOneWidget);
        // 기다려도 안 낫는 것(없다·못 본다)엔 [다시 시도] 를 달지 않는다.
        expect(find.text(stringsFor('ko').commonRetry), retry ? findsOneWidget : findsNothing);
      });
    }
  });
}

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 스레드를 위로 굴리면 작성칸 위 오른쪽에 「↓ 최신 답글」 알약이 뜨고, 누르면 맨 아래로 간다. 위로 굴린 동안 남의
/// 답글이 오면 「새 답글 n」으로 센다. 서버 흉내는 `thread_latest_band_test.dart` 와 같다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

class _Server {
  _Server({required this.replies});
  final int replies;
  final asked = <Map<String, String>>[];
  /// 최신 페이지(thread, around·before 없음) 응답을 붙들어 둔다 / 실패시킨다.
  Future<void>? holdLatest;
  bool failLatest = false;
  final posted = <Map<String, Object?>>[];

  Map<String, Object?> _row(int seq) => {
        'id': seq == 1 ? 'root' : 'r$seq',
        'seq': seq,
        'channelId': 'c1',
        'threadRootId': seq == 1 ? null : 'root',
        'authorId': 'a1',
        'body': seq == 1 ? '원글' : '답글 $seq',
        'kind': 'user',
        'replyCount': seq == 1 ? replies : null,
        'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
      };

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
        if (path == '/channels') return _json({'channels': [{'id': 'c1', 'name': 'task', 'kind': 'standard'}]});
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.contains('/agent-models') || path.contains('/auto-mentions')) {
          return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
        }
        if (path == '/channels/c1/messages' && req.method == 'POST') {
          final body = jsonDecode(req.body) as Map<String, Object?>;
          posted.add(body);
          return _json({
            ..._row(replies + 2),
            'id': 'mine',
            'body': body['body'],
            'authorId': 'me-1',
          });
        }
        if (path == '/channels/c1/messages') {
          final q = req.url.queryParameters;
          if (q['thread'] != 'root') return _json({'messages': <Object?>[], 'hasMore': false});
          asked.add(q);
          if (q['around'] == null && q['before'] == null) {
            if (holdLatest != null) await holdLatest;
            if (failLatest) return _json({'error': {'code': 'internal', 'message': 'boom'}}, 500);
          }
          final limit = int.parse(q['limit'] ?? '200');
          if (q['around'] != null) {
            final around = int.parse(q['around']!);
            final half = (limit / 2).ceil();
            final up = [for (var s = 1; s <= replies + 1; s++) if (s <= around) s];
            final dn = [for (var s = 1; s <= replies + 1; s++) if (s > around) s];
            final rows = [...(up.length > half ? up.sublist(up.length - half) : up), ...dn.take(half)];
            return _json({'messages': rows.map(_row).toList(), 'hasMore': false});
          }
          final before = q['before'] == null ? null : int.parse(q['before']!);
          final pool = [for (var s = 2; s <= replies + 1; s++) if (before == null || s < before) s];
          final page = pool.length > limit ? pool.sublist(pool.length - limit) : pool;
          final rows = [if (before == null) _row(1), ...page.map(_row)];
          return _json({'messages': rows, 'hasMore': page.isNotEmpty && page.first > 2});
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

Future<void> _pump(WidgetTester tester, AppState app, {String? highlightId, int? highlightSeq}) => tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child!)),
      home: ThreadScreen(channelId: 'c1', rootId: 'root', highlightId: highlightId, highlightSeq: highlightSeq),
    ));

Future<void> _settle(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  final ko = stringsFor('ko');
  final pill = find.byKey(const Key('thread-jump-pill'));
  ScrollController feed(WidgetTester tester) =>
      tester.widget<ListView>(find.byKey(const Key('thread-feed'))).controller!;

  Future<AppState> open(WidgetTester tester, _Server server) async {
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await _pump(tester, app);
    await _settle(tester);
    expect(app.threadLoad['root'], LoadState.loaded);
    expect(app.threadTailMissing, isEmpty);
    return app;
  }

  void reply(AppState app, int seq, {String author = 'a2'}) => app.applyEvent({
        'type': 'message.created',
        'message': {'id': 'n$seq', 'seq': seq, 'channelId': 'c1', 'threadRootId': 'root', 'authorId': author, 'body': '새 $seq', 'kind': 'user'},
      });

  testWidgets('맨 아래에서는 알약이 없다 — 새 답글이 와도 그대로 따라 붙는다', (tester) async {
    final app = await open(tester, _Server(replies: 60));
    expect(pill, findsNothing);
    reply(app, 62);
    await tester.pump();
    expect(pill, findsNothing);
  });

  testWidgets('한 화면보다 위로 굴리면 「최신 답글」 알약이 뜬다 — 한 화면 안이면 뜨지 않는다', (tester) async {
    await open(tester, _Server(replies: 60));
    final c = feed(tester);
    final viewport = c.position.viewportDimension;
    c.jumpTo(viewport * 0.5);
    await tester.pump();
    expect(pill, findsNothing);
    c.jumpTo(viewport * 1.5);
    await tester.pump();
    expect(pill, findsOneWidget);
    expect(find.text(ko.threadJumpLatest), findsOneWidget);
    expect(tester.getSemantics(pill).label, ko.threadJumpA11y);
    // 누르는 자리는 44, 알약 면은 36.
    expect(tester.getSize(pill).height, 44);
  });

  testWidgets('위로 굴린 동안 남의 답글이 오면 「새 답글 n」 — 내 답글은 세지 않는다', (tester) async {
    final app = await open(tester, _Server(replies: 60));
    final c = feed(tester);
    c.jumpTo(c.position.viewportDimension * 0.5);
    await tester.pump();
    expect(pill, findsNothing);
    // 한 화면 안이어도 새 답글이 오면 뜬다(맨 아래는 안 보인다).
    reply(app, 62);
    await tester.pump();
    expect(pill, findsOneWidget);
    expect(find.text(ko.threadJumpNew.replaceFirst('{n}', '1')), findsOneWidget);
    reply(app, 63, author: 'me-1');
    reply(app, 64);
    await tester.pump();
    expect(find.text(ko.threadJumpNew.replaceFirst('{n}', '2')), findsOneWidget);
    expect(tester.getSemantics(pill).label, ko.threadJumpA11yNew.replaceFirst('{n}', '2'));
  });

  testWidgets('알약을 누르면 맨 아래로 굴러가 걷히고, 수는 0 으로 돌아간다', (tester) async {
    final app = await open(tester, _Server(replies: 60));
    final c = feed(tester);
    c.jumpTo(c.position.viewportDimension * 1.5);
    await tester.pump();
    reply(app, 62);
    await tester.pump();
    expect(find.text(ko.threadJumpNew.replaceFirst('{n}', '1')), findsOneWidget);
    await tester.tap(pill);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(c.position.pixels, 0);
    expect(pill, findsNothing);
    // 다시 올라가도 본 답글은 새 것이 아니다.
    c.jumpTo(c.position.viewportDimension * 1.5);
    await tester.pump();
    expect(find.text(ko.threadJumpLatest), findsOneWidget);
  });

  testWidgets('멀리(세 화면 넘게) 올라갔어도 누르면 맨 아래에 닿는다', (tester) async {
    await open(tester, _Server(replies: 60));
    final c = feed(tester);
    c.jumpTo((c.position.viewportDimension * 4).clamp(0, c.position.maxScrollExtent));
    await tester.pump();
    expect(pill, findsOneWidget);
    await tester.tap(pill);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(c.position.pixels, 0);
    expect(pill, findsNothing);
  });

  testWidgets('띠가 선 창: 띠가 보일 자리에서는 알약이 없고, 멀리서 누르면 띠와 같이 최신 페이지로 간다', (tester) async {
    final server = _Server(replies: 250);
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await _pump(tester, app, highlightId: 'r40', highlightSeq: 40);
    await _settle(tester);
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(app.threadTailMissing, contains('root'));
    final c = feed(tester);
    c.jumpTo(0);
    await tester.pump();
    expect(find.byKey(const Key('thread-latest-band')), findsOneWidget);
    expect(pill, findsNothing);
    c.jumpTo(c.position.viewportDimension * 0.5);
    await tester.pump();
    expect(pill, findsNothing);
    c.jumpTo((c.position.viewportDimension * 1.5).clamp(0, c.position.maxScrollExtent));
    await tester.pump();
    expect(pill, findsOneWidget);
    // 띠가 선 동안 온 새 답글은 상태층의 수를 쓴다.
    reply(app, 252);
    await tester.pump();
    expect(find.text(ko.threadJumpNew.replaceFirst('{n}', '1')), findsOneWidget);
    await tester.tap(pill);
    await _settle(tester);
    expect(server.asked.last.containsKey('around'), isFalse);
    expect(app.threadTailMissing, isEmpty);
    expect(c.position.pixels, 0);
    expect(pill, findsNothing);
  });

  test('알약 문구: 0 이면 대기 문구, n 이면 「새 답글 n」, 99 넘으면 99+', () {
    expect(jumpPillLabel(ko, 0), '최신 답글');
    expect(jumpPillLabel(ko, 3), '새 답글 3');
    expect(jumpPillLabel(ko, 100), '새 답글 99+');
    expect(jumpPillLabel(stringsFor('en'), 0), 'Latest replies');
    expect(jumpPillLabel(stringsFor('en'), 2), '2 new replies');
  });
}

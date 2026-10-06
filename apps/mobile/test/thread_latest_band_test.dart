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

/// 링크·찾기로 긴 스레드의 **옛 답글** 창을 받아 들어오면 창 아래가 비어 있다(최신 답글이 안 실렸다). 그 자리에
/// 「최신 답글로 ↓」 띠가 서고, 누르면 최신 페이지로 간다 (2026-10-06, #1191 후속 d1, designer n1).

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

class _Server {
  _Server({required this.replies});
  final int replies;
  final asked = <Map<String, String>>[];

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
        if (path == '/channels/c1/messages') {
          final q = req.url.queryParameters;
          if (q['thread'] != 'root') return _json({'messages': <Object?>[], 'hasMore': false});
          asked.add(q);
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
  testWidgets('옛 답글 창으로 들어오면 창 아래에 「최신 답글로 ↓」 띠가 서고, 누르면 최신 페이지로 가며 띠가 걷힌다', (tester) async {
    final server = _Server(replies: 250);
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await _pump(tester, app, highlightId: 'r40', highlightSeq: 40);
    await _settle(tester);
    expect(app.threadTailMissing, contains('root'));
    // 강조 줄(r40)로 굴러가 있어 창 끝(맨 아래)은 화면 밖이다 — 목록은 화면 밖 줄을 짓지 않으므로 아래로 되돌린다.
    tester.widget<ListView>(find.byKey(const Key('thread-feed'))).controller!.jumpTo(0);
    await tester.pump();
    expect(find.byKey(const Key('thread-latest-band')), findsOneWidget);
    expect(find.text(stringsFor('ko').threadLatestReplies), findsOneWidget);

    await tester.tap(find.byKey(const Key('thread-latest-band')));
    await _settle(tester);
    expect(server.asked.last.containsKey('around'), isFalse);
    expect(app.threadTailMissing, isEmpty);
    expect(find.byKey(const Key('thread-latest-band')), findsNothing);
    expect(app.threads['root']!.last.seq, 251);
  });

  testWidgets('최신 페이지로 연 스레드에는 띠가 없다 — 창 없는 길은 전과 같다', (tester) async {
    final server = _Server(replies: 250);
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await _pump(tester, app);
    await _settle(tester);
    expect(app.threadLoad['root'], LoadState.loaded);
    expect(find.byKey(const Key('thread-latest-band')), findsNothing);
  });
}

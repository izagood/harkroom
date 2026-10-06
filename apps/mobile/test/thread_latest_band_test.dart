import 'dart:async';
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
import 'package:harkroom/ui/tokens.dart';
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

  Future<void> enterOld(WidgetTester tester, AppState app) async {
    await _pump(tester, app, highlightId: 'r40', highlightSeq: 40);
    await _settle(tester);
    expect(app.threadTailMissing, contains('root'));
    // 강조 줄 찾기(`_scrollToHit`)는 프레임마다 한 화면씩 위로 민다 — 다 끝나게 프레임을 준다. 안 주면 뒤의
    // 재빌드마다 한 번 더 밀려 띠가 화면 밖으로 나간다(실기기에서는 사람이 누르기 전에 끝난다).
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    tester.widget<ListView>(find.byKey(const Key('thread-feed'))).controller!.jumpTo(0);
    await tester.pump();
    expect(find.byKey(const Key('thread-latest-go')), findsOneWidget);
  }

  testWidgets('m1: 누르면 받는 동안 같은 44 상자에 스피너가 서고 다시 눌리지 않는다', (tester) async {
    final server = _Server(replies: 250);
    final gate = Completer<void>();
    server.holdLatest = gate.future;
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await enterOld(tester, app);
    final before = server.asked.length;
    await tester.tap(find.byKey(const Key('thread-latest-go')));
    await tester.pump();
    expect(app.jumpingToLatest, contains('root'));
    expect(find.byKey(const Key('thread-latest-loading')), findsOneWidget);
    expect(find.byKey(const Key('thread-latest-go')), findsNothing);
    expect(tester.getSize(find.byKey(const Key('thread-latest-band'))).height, 44);
    // 받는 중에 한 번 더 — 눌릴 버튼이 없고, 상태로 불러도 한 번만 간다.
    await app.jumpToLatestReplies('c1', 'root');
    expect(server.asked.length, before + 1);
    gate.complete();
    await _settle(tester);
    expect(app.jumpingToLatest, isEmpty);
    expect(app.threadTailMissing, isEmpty);
    expect(find.byKey(const Key('thread-latest-band')), findsNothing);
  });

  testWidgets('m2: 못 받으면 띠가 「못 불러왔다 · 다시 시도」로 바뀌고, 다시 시도가 되면 걷힌다', (tester) async {
    final server = _Server(replies: 250)..failLatest = true;
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await enterOld(tester, app);
    await tester.tap(find.byKey(const Key('thread-latest-go')));
    await _settle(tester);
    expect(app.latestJumpFailed, contains('root'));
    expect(app.threadTailMissing, contains('root'));
    expect(find.byKey(const Key('thread-latest-failed')), findsOneWidget);
    expect(find.text(stringsFor('ko').threadLatestLoadFailed), findsOneWidget);
    expect(tester.getSize(find.byKey(const Key('thread-latest-band'))).height, 44);
    server.failLatest = false;
    await tester.tap(find.byKey(const Key('thread-latest-retry')));
    await _settle(tester);
    expect(app.latestJumpFailed, isEmpty);
    expect(app.threadTailMissing, isEmpty);
    expect(find.byKey(const Key('thread-latest-band')), findsNothing);
  });

  testWidgets('m3: 옛 창에서 답을 보내면 먼저 최신 페이지를 받고 그 뒤에 보낸다 — 내 글이 최신 묶음 끝에 선다', (tester) async {
    final server = _Server(replies: 250);
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await enterOld(tester, app);
    await tester.enterText(find.byKey(const Key('thread-composer')), '답');
    await tester.tap(find.byKey(const Key('thread-send')));
    await _settle(tester);
    // 순서: 최신 페이지 조회(around·before 없음) → POST.
    expect(server.asked.where((q) => q['around'] == null && q['before'] == null), isNotEmpty);
    expect(server.posted, hasLength(1));
    expect(app.threadTailMissing, isEmpty);
    // 최신 묶음(152..251) 위에 내 글(252)이 마지막으로 선다. (시험 목록이 짧아 위로 `before` 한 쪽이 더 붙을 수 있다.)
    final seqs = app.threads['root']!.map((m) => m.seq).toList();
    expect(seqs, contains(152));
    expect(seqs.last, 252);
    expect(app.threads['root']!.last.id, 'mine');
    expect(find.byKey(const Key('thread-latest-band')), findsNothing);
  });

  test('security F1: 최신 페이지를 기다리는 사이 커뮤니티를 바꾸면 보내지 않는다 — 다른 서버로 본문이 가지 않는다', () async {
    final server = _Server(replies: 250);
    final gate = Completer<void>();
    final app = AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me-1',
          'communities': [
            {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
            {'accountId': 'me-2', 'baseUrl': 'https://b.example.com', 'token': 'tok2', 'handle': 'me'},
          ],
        }),
      ),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client),
      connector: (_) async => throw StateError('소켓 없음'),
    );
    addTearDown(app.dispose);
    await app.boot();
    await app.openThread('c1', 'root', aroundSeq: 40);
    expect(app.threadTailMissing, contains('root'));
    final other = app.communities.firstWhere((c) => c.key != app.activeKey).key;

    server.holdLatest = gate.future;
    final sending = app.send('c1', '비밀스러운 답', threadRootId: 'root');
    await Future<void>.delayed(Duration.zero);
    expect(app.jumpingToLatest, contains('root'));
    // 기다리는 동안 B 로 옮긴다.
    final switched = app.switchTo(other);
    gate.complete();
    expect(await sending, isFalse);
    await switched;
    // 어느 서버로도 POST 가 가지 않았다(두 커뮤니티가 같은 가짜 클라이언트를 쓰므로 한 목록이면 충분하다).
    expect(server.posted, isEmpty);
    expect(app.failedSends, isEmpty);
  });

  testWidgets('띠가 선 동안 소켓 새 답글이 오면 띠에 「· 새 답글 n개」가 붙고, 옛 창에는 붙지 않는다', (tester) async {
    final server = _Server(replies: 250);
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await enterOld(tester, app);
    app.applyEvent({
      'type': 'message.created',
      'message': {'id': 'r252', 'seq': 252, 'channelId': 'c1', 'threadRootId': 'root', 'authorId': 'a2', 'body': '새', 'kind': 'user'},
    });
    await tester.pump();
    expect(find.byKey(const Key('message-r252')), findsNothing);
    final expected = stringsFor('ko').threadLatestNewReplies.replaceFirst('{n}', '1');
    expect(find.text(expected), findsOneWidget);
    // 새 답글이 있으면 사건 — 대기 글자가 accentText 로(designer). 모양·높이는 그대로.
    final go = tester.widget<TextButton>(find.byKey(const Key('thread-latest-go')));
    final k = harkroomTheme(Brightness.light).extension<HarkroomTokens>()!;
    expect(go.style!.foregroundColor!.resolve({}), k.accentText);
    expect(tester.getSize(find.byKey(const Key('thread-latest-band'))).height, 44);
    await tester.tap(find.byKey(const Key('thread-latest-go')));
    await _settle(tester);
    expect(app.threadTailNew, isEmpty);
    expect(find.byKey(const Key('thread-latest-band')), findsNothing);
  });

  test('띠 문구: 0 이면 대기 문구, n 이면 수를 앞세운 한 문구, 99 넘으면 99+', () {
    final t = stringsFor('ko');
    expect(latestBandLabel(t, 0), t.threadLatestReplies);
    expect(latestBandLabel(t, 3), '새 답글 3개 · 최신으로 ↓');
    expect(latestBandLabel(t, 100), '새 답글 99+개 · 최신으로 ↓');
    expect(latestBandLabel(stringsFor('en'), 2), '2 new · Jump to latest ↓');
  });

  testWidgets('띠가 선 채 내가 보낸 답글은 세지 않는다 — 소켓으로 다시 와도', (tester) async {
    // 최신으로 옮기기가 실패해 띠가 남은 경우(m3 실패)에만 생기는 자리다.
    final server = _Server(replies: 250)..failLatest = true;
    final app = (await tester.runAsync(() => _boot(server)))!;
    addTearDown(app.dispose);
    await enterOld(tester, app);
    await tester.enterText(find.byKey(const Key('thread-composer')), '내 답');
    await tester.tap(find.byKey(const Key('thread-send')));
    await _settle(tester);
    expect(server.posted, hasLength(1));
    expect(app.threadTailMissing, contains('root'));
    expect(app.threadTailNew['root'] ?? const <String>{}, isEmpty);
    // 소켓 에코
    app.applyEvent({
      'type': 'message.created',
      'message': {'id': 'mine', 'seq': 252, 'channelId': 'c1', 'threadRootId': 'root', 'authorId': 'me-1', 'body': '내 답', 'kind': 'user'},
    });
    expect(app.threadTailNew['root'] ?? const <String>{}, isEmpty);
    // 남의 답글은 센다.
    app.applyEvent({
      'type': 'message.created',
      'message': {'id': 'r253', 'seq': 253, 'channelId': 'c1', 'threadRootId': 'root', 'authorId': 'a2', 'body': '남', 'kind': 'user'},
    });
    expect(app.threadTailNew['root'], {'r253'});
  });
}

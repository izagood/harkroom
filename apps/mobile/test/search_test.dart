import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/search_screen.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/recent_search_store.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/ui/tokens.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 찾기 F1(designer 찾기 안): 진입점 셋이 범위를 미리 고르고, 두 글자부터 디바운스로 보내고,
/// 결과를 누르면 그 스레드로 가며, 0건·실패가 각각 다른 말을 한다.

// 시험 기기의 언어는 영어다(HarkroomApp 이 기기 언어를 따른다).
final _t = stringsFor('en');

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

class _Idle implements WsConnection {
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

const _root = '22222222-2222-4222-8222-222222222222';
const _reply = '11111111-1111-4111-8111-111111111111';

Map<String, Object?> _row(String id, int seq, {String? root, String body = '말', String channelId = 'c1'}) => {
      'id': id,
      'seq': seq,
      'channelId': channelId,
      'threadRootId': root,
      'authorId': 'a1',
      'body': body,
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 9, 1).add(Duration(minutes: seq)).toIso8601String(),
    };

class _Server {
  /// 받은 `/search` 질의들(쿼리 인자 그대로).
  final searches = <Map<String, String>>[];

  /// 값이 있으면 그 상태로 실패한다.
  int? failWith;

  /// 「배포」 를 찾으면 답글 하나가 온다. 그 밖은 0건.
  Map<String, Object?> Function(Map<String, String> q) answer = (q) => {
        'messages': switch (q['q']) {
          '배포' => [_row(_reply, 9, root: _root, body: '0.3.130 배포했다. 서버 헬스 OK')],
          '시안' => [_row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 4, body: '시안 올렸다', channelId: 'd1')],
          _ => <Object?>[],
        },
        'hasMore': false,
      };

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': 'me', 'isAdmin': false});
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'task', 'kind': 'standard'},
              {'id': 'd1', 'name': 'designer', 'kind': 'dm'},
              {'id': 'c2', 'name': 'testbed', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/accounts') {
          return _json({
            'accounts': [
              {'id': 'a1', 'handle': 'task_manager', 'displayName': 'task_manager', 'kind': 'agent'},
            ],
          });
        }
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        if (path.contains('/agent-models') || path.contains('/auto-mentions')) {
          return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
        }
        if (path == '/search') {
          searches.add(req.url.queryParameters);
          if (failWith != null) return _json({'error': {'code': 'internal', 'message': 'boom'}}, failWith!);
          return _json(answer(req.url.queryParameters));
        }
        if (path == '/channels/c1/messages') {
          if (req.url.queryParameters['thread'] == _root) {
            return _json({
              'messages': [_row(_root, 3, body: '서버 최신버전 배포해'), _row(_reply, 9, root: _root, body: '0.3.130 배포했다.')],
              'hasMore': false,
            });
          }
          return _json({'messages': [_row(_root, 3, body: '서버 최신버전 배포해')], 'hasMore': false});
        }
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

Future<AppState> _boot(WidgetTester tester, _Server server, {RecentSearchStore? recent}) async {
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
    connector: (_) async => _Idle(),
    recentSearchStore: recent,
  );
  addTearDown(app.dispose);
  await tester.runAsync(app.boot);
  await tester.pumpWidget(HarkroomApp(state: app));
  await _settle(tester);
  return app;
}

/// 가짜 HTTP 는 진짜 비동기다 — runAsync 안에서 답을 받게 한 뒤 그린다. pumpAndSettle 은 쓰지 않는다
/// (입력칸 커서 깜빡임이 끝나지 않는다).
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await tester.pump(const Duration(milliseconds: 350));
  }
}

Future<void> _type(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const Key('search-input')), text);
  // 디바운스(300ms)를 넘긴 뒤 답을 받는다.
  await tester.pump(searchDebounce + const Duration(milliseconds: 10));
  await _settle(tester);
}

Future<void> _openChannel(WidgetTester tester, AppState app) async {
  await tester.tap(find.text('task'));
  await _settle(tester);
  expect(find.byType(MessageListScreen), findsOneWidget);
}

void main() {
  testWidgets('탭 막대 찾기 버튼 → 전체 범위, 범위 칩 없음, 두 글자부터 보낸다', (tester) async {
    final server = _Server();
    await _boot(tester, server);
    expect(find.byKey(const Key('tab-search')), findsOneWidget);
    await tester.tap(find.byKey(const Key('tab-search')));
    await _settle(tester);
    expect(find.byType(SearchScreen), findsOneWidget);
    // 맥락 없이 열었으니 고를 범위가 없다.
    expect(find.byKey(const Key('search-scope-all')), findsNothing);
    expect(find.text(_t.searchStart), findsOneWidget);

    await _type(tester, '배');
    expect(server.searches, isEmpty, reason: '한 글자는 보내지 않는다');

    await _type(tester, '배포');
    expect(server.searches, hasLength(1));
    expect(server.searches.single, {'q': '배포'});
  });

  testWidgets('디바운스: 연달아 친 것은 마지막 하나만 보낸다', (tester) async {
    final server = _Server();
    await _boot(tester, server);
    await tester.tap(find.byKey(const Key('tab-search')));
    await _settle(tester);
    for (final s in ['배포', '배포 순', '배포 순서']) {
      await tester.enterText(find.byKey(const Key('search-input')), s);
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.pump(searchDebounce);
    await _settle(tester);
    expect(server.searches.map((q) => q['q']), ['배포 순서']);
  });

  testWidgets('채널 머리 돋보기 → 이 채널 범위, 0건이면 [전체에서 찾기] 로 넓힌다', (tester) async {
    final server = _Server();
    final app = await _boot(tester, server);
    await _openChannel(tester, app);
    await tester.tap(find.byKey(const Key('channel-search')));
    await _settle(tester);
    final chip = tester.widget<ChoiceChip>(find.descendant(of: find.byKey(const Key('search-scope-channel')), matching: find.byType(ChoiceChip)));
    expect(chip.selected, isTrue);

    await _type(tester, '없는말');
    expect(server.searches.last, {'q': '없는말', 'channelId': 'c1'});
    expect(find.text(_t.searchNoResults.replaceFirst('{q}', '없는말')), findsOneWidget);
    // 세 글자라 「한 글자 더」 안내는 없다.
    expect(find.text(_t.searchTwoLetterHint), findsNothing);

    await tester.tap(find.byKey(const Key('search-everywhere')));
    await _settle(tester);
    expect(server.searches.last, {'q': '없는말'});
    // 이미 전체라 넓힐 곳이 없다.
    expect(find.byKey(const Key('search-everywhere')), findsNothing);
  });

  testWidgets('두 글자 0건엔 「한 글자 더」 를 말한다', (tester) async {
    await _boot(tester, _Server());
    await tester.tap(find.byKey(const Key('tab-search')));
    await _settle(tester);
    await _type(tester, '재검');
    expect(find.text(_t.searchTwoLetterHint), findsOneWidget);
  });

  testWidgets('결과 줄: 어디·누가·언제 + 본문, 누르면 그 스레드 화면, 뒤로 오면 결과가 남는다', (tester) async {
    final server = _Server();
    await _boot(tester, server);
    await tester.tap(find.byKey(const Key('tab-search')));
    await _settle(tester);
    await _type(tester, '배포');

    final tile = find.byKey(const Key('search-result-$_reply'));
    expect(tile, findsOneWidget);
    expect(
      tester.getSemantics(find.byType(SearchResultTile)).label,
      allOf(contains('# task'), contains(_t.searchInThread), contains('task_manager'), contains('배포했다')),
    );

    await tester.tap(tile);
    await _settle(tester);
    final thread = tester.widget<ThreadScreen>(find.byType(ThreadScreen));
    expect(thread.channelId, 'c1');
    expect(thread.rootId, _root);

    await tester.pageBack();
    await _settle(tester);
    expect(find.byKey(const Key('search-result-$_reply')), findsOneWidget);
    expect(server.searches, hasLength(1), reason: '돌아와도 다시 찾지 않는다');
  });

  testWidgets('스레드 머리 돋보기 → 이 스레드 범위(채널 id 를 같이 보낸다)', (tester) async {
    final server = _Server();
    final app = await _boot(tester, server);
    await tester.runAsync(() => app.openChannel('c1'));
    await tester.pump();
    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    unawaited(nav.push(MaterialPageRoute<void>(builder: (_) => const ThreadScreen(channelId: 'c1', rootId: _root))));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('thread-search')));
    await _settle(tester);
    expect(find.byKey(const Key('search-scope-thread')), findsOneWidget);
    await _type(tester, '배포');
    expect(server.searches.last, {'q': '배포', 'channelId': 'c1', 'threadRootId': _root});
  });

  testWidgets('실패는 실패 화면 + [다시 시도], 0건과 다른 말이다', (tester) async {
    final server = _Server()..failWith = 500;
    await _boot(tester, server);
    await tester.tap(find.byKey(const Key('tab-search')));
    await _settle(tester);
    await _type(tester, '배포');
    expect(find.text(_t.searchFailed), findsOneWidget);
    expect(find.text(_t.searchNoResults.replaceFirst('{q}', '배포')), findsNothing);

    server.failWith = null;
    await tester.tap(find.text(_t.commonRetry));
    await _settle(tester);
    expect(find.byKey(const Key('search-result-$_reply')), findsOneWidget);
  });

  testWidgets('끝에 닿으면 offset 으로 이어 받고, 겹친 행은 한 번만 그린다', (tester) async {
    final server = _Server()
      ..answer = (q) {
        final offset = int.tryParse(q['offset'] ?? '') ?? 0;
        // 50개씩. 두 번째 묶음 첫 행은 첫 묶음 끝과 같다(그 사이 새 글로 한 칸 밀린 경우).
        final start = offset == 0 ? 0 : offset - 1;
        return {
          'messages': [
            for (var i = start; i < offset + 50 && i < 60; i++)
              _row('00000000-0000-4000-8000-${i.toString().padLeft(12, '0')}', 100 - i, body: '배포 $i'),
          ],
          'hasMore': offset == 0,
        };
      };
    await _boot(tester, server);
    await tester.tap(find.byKey(const Key('tab-search')));
    await _settle(tester);
    await _type(tester, '배포');
    expect(server.searches, hasLength(1));
    await tester.drag(find.byKey(const Key('search-results')), const Offset(0, -6000));
    await _settle(tester);
    expect(server.searches.last['offset'], '50');
    await tester.drag(find.byKey(const Key('search-results')), const Offset(0, -6000));
    await _settle(tester);
    expect(server.searches, hasLength(2), reason: 'hasMore 가 false 면 더 묻지 않는다');
    expect(find.byKey(const Key('search-result-00000000-0000-4000-8000-000000000059')), findsOneWidget);
    // 겹친 49 번은 한 줄만 — 목록은 화면 밖을 안 그리므로 그 자리로 조금 되올려 본다.
    await tester.drag(find.byKey(const Key('search-results')), const Offset(0, 500));
    await tester.pump();
    expect(find.byKey(const Key('search-result-00000000-0000-4000-8000-000000000049')), findsOneWidget);
  });

  group('highlightSpans', () {
    const mark = TextStyle(fontWeight: FontWeight.w700);
    String marked(List<InlineSpan> spans) =>
        spans.map((s) => s is TextSpan && s.style == mark ? '[${s.text}]' : (s as TextSpan).text).join();

    test('낱말마다, 대소문자 없이, 긴 낱말이 이긴다', () {
      expect(marked(highlightSpans('서버 최신버전 배포해', '배포', mark)), '서버 최신버전 [배포]해');
      expect(marked(highlightSpans('SearchPalette.tsx 를 고침', 'search tsx', mark)), '[Search]Palette.[tsx] 를 고침');
      expect(marked(highlightSpans('배포해 배포', '배포 배포해', mark)), '[배포해] [배포]');
    });

    test('검색 문법 기호는 떼고, 없는 낱말은 안 칠한다', () {
      expect(marked(highlightSpans('배포 순서 정리', '"배포 순서"', mark)), '[배포] [순서] 정리');
      expect(marked(highlightSpans('배포', '-배포', mark)), '[배포]');
      expect(marked(highlightSpans('아무 말', '없음', mark)), '아무 말');
    });
  });

  group('F2', () {
    testWidgets('결과를 누르면 그 스레드에서 찾은 답글을 강조한다', (tester) async {
      await _boot(tester, _Server());
      await tester.tap(find.byKey(const Key('tab-search')));
      await _settle(tester);
      await _type(tester, '배포');
      await tester.tap(find.byKey(const Key('search-result-$_reply')));
      await _settle(tester);
      expect(tester.widget<ThreadScreen>(find.byType(ThreadScreen)).highlightId, _reply);
      expect(find.byType(HitFlash), findsOneWidget);
      await tester.pump(HitFlash.hold + const Duration(milliseconds: 10));
      expect(tester.state<HitFlashState>(find.byType(HitFlash)).on, isFalse, reason: '2초 뒤 걷힌다');
    });

    testWidgets('DM 결과는 「DM · 이름」 으로 읽힌다', (tester) async {
      await _boot(tester, _Server());
      await tester.tap(find.byKey(const Key('tab-search')));
      await _settle(tester);
      await _type(tester, '시안');
      expect(tester.getSemantics(find.byType(SearchResultTile)).label, startsWith('${_t.tabDms} · designer, '));
    });

    testWidgets('고른 범위 칩은 먹색 바탕(fg), 안 고른 칩은 바탕색', (tester) async {
      final app = await _boot(tester, _Server());
      await _openChannel(tester, app);
      await tester.tap(find.byKey(const Key('channel-search')));
      await _settle(tester);
      ChoiceChip chip(String k) =>
          tester.widget<ChoiceChip>(find.descendant(of: find.byKey(Key(k)), matching: find.byType(ChoiceChip)));
      final k = tester.element(find.byType(SearchScreen)).tokens;
      expect(chip('search-scope-channel').selected, isTrue);
      expect(chip('search-scope-channel').selectedColor, k.fg);
      expect(chip('search-scope-channel').labelStyle?.color, k.bg);
      expect(chip('search-scope-all').labelStyle?.color, k.mute);
    });

    testWidgets('최근 찾은 말: 결과를 열면 남고, 누르면 그 말로 찾고, 지울 수 있다', (tester) async {
      final store = MemoryRecentSearchStore();
      final server = _Server();
      await _boot(tester, server, recent: store);
      await tester.tap(find.byKey(const Key('tab-search')));
      await _settle(tester);
      await _type(tester, '배포');
      await tester.tap(find.byKey(const Key('search-result-$_reply')));
      await _settle(tester);
      expect(store.values.values.single, ['배포']);
      await tester.pageBack();
      await _settle(tester);
      await tester.tap(find.byKey(const Key('search-cancel')));
      await _settle(tester);

      await tester.tap(find.byKey(const Key('tab-search')));
      await _settle(tester);
      expect(find.byKey(const Key('search-recent-배포')), findsOneWidget);
      final before = server.searches.length;
      await tester.tap(find.byKey(const Key('search-recent-배포')));
      await _settle(tester);
      expect(server.searches.length, before + 1);
      expect(server.searches.last['q'], '배포');

      // 입력을 비우면 다시 최근 목록 — 모두 지우기.
      await _type(tester, '');
      await tester.tap(find.byKey(const Key('search-recent-clear')));
      await _settle(tester);
      expect(find.byKey(const Key('search-recent-배포')), findsNothing);
      expect(store.values.values.single, isEmpty);
    });

    testWidgets('바로 가기: 이름이 맞는 채널·DM 을 세우고, 누르면 그 대화', (tester) async {
      await _boot(tester, _Server());
      await tester.tap(find.byKey(const Key('tab-search')));
      await _settle(tester);
      await _type(tester, 't');
      // 앞부분이 맞는 task·testbed. 한 글자라 서버에는 안 보낸다.
      expect(find.byKey(const Key('search-shortcut-c1')), findsOneWidget);
      expect(find.byKey(const Key('search-shortcut-c2')), findsOneWidget);
      expect(find.byKey(const Key('search-shortcut-d1')), findsNothing);
      await _type(tester, '#des');
      expect(find.byKey(const Key('search-shortcut-d1')), findsOneWidget);
      await tester.tap(find.byKey(const Key('search-shortcut-d1')));
      await _settle(tester);
      expect(tester.widget<MessageListScreen>(find.byType(MessageListScreen)).channelId, 'd1');
    });

    test('발췌: 첫 일치가 두 줄 밖이면 그 앞에서 「…」 로 시작한다', () {
      expect(searchExcerpt('짧은 배포 글', '배포'), '짧은 배포 글');
      final long = '${'가나다라 ' * 20}여기서 배포했다';
      final ex = searchExcerpt(long, '배포');
      expect(ex, startsWith('…'));
      expect(ex, endsWith('여기서 배포했다'));
      expect(ex.indexOf('배포'), lessThanOrEqualTo(31), reason: '찾은 말이 앞 스무 글자쯤 안에 온다');
      // 낱말 가운데를 자르지 않는다.
      expect(ex.substring(1, 5), '가나다라');
      expect(searchExcerpt(long, '없는말'), long);
    });
  });
}

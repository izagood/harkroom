import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/ui/parts.dart';
import 'package:harkroom/screens/channel_list_screen.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/search_screen.dart';
import 'package:harkroom/screens/tab_nav.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// S5a 탭바(개정판 3.1): 홈 · DM · 인박스 · 에이전트. 「나」 는 머리의 프로필 사진으로 연다.

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

MockClient _server({bool noDms = false}) => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': 'me', 'isAdmin': false});
      if (path == '/channels') {
        return _json({
          'channels': [
            {'id': 'c1', 'name': 'task', 'kind': 'standard'},
            {'id': 'c2', 'name': 'ops', 'kind': 'standard'},
            {'id': 'c3', 'name': 'old', 'kind': 'standard'},
          ],
        });
      }
      // 실제 서버처럼 DM 은 `GET /channels` 가 아니라 `GET /dms` 로만 온다(이름 없이 명단만).
      if (path == '/dms' && req.method == 'POST') {
        final ids = (jsonDecode(req.body) as Map)['accountIds'] as List;
        if (ids.length == 1 && ids.first == 'a-qa') return _json({'id': 'd2', 'kind': 'dm', 'name': ''}, 201);
        return _json({'error': {'code': 'bad_request', 'message': 'x'}}, 400);
      }
      if (path == '/dms') {
        if (noDms) return _json({'dms': <Object?>[]});
        return _json({
          'dms': [
            {'id': 'd1', 'memberIds': ['me-1', 'a-designer'], 'lastMessageAt': '2026-10-01T00:00:00Z'},
          ],
        });
      }
      // S7: 서버 0.3.154 의 `?scope=visible` 모양(AgentActivityView — sessionId 없음). scope 없이 오면
      // 소유자 표면을 부른 것이므로 400 으로 시험을 빨갛게 한다.
      if (path == '/agent-sessions' || path == '/agent-wakes') {
        if (req.url.queryParameters['scope'] != 'visible') return _json({'error': {'code': 'bad', 'message': 'scope'}}, 400);
        if (path == '/agent-sessions') {
          return _json({
            'sessions': [
              {'agentAccountId': 'a-designer', 'channelId': 'c1', 'threadRootId': null, 'harness': 'claude-code',
               'startedAt': DateTime.now().subtract(const Duration(minutes: 4)).toUtc().toIso8601String(), 'owned': false},
            ],
          });
        }
        return _json({
          'wakes': [
            {'id': 'w1', 'agentAccountId': 'a-qa', 'channelId': 'c1', 'threadRootId': 'r1', 'messageId': 'm1',
             'wakeAt': DateTime.now().add(const Duration(minutes: 10)).toUtc().toIso8601String(), 'reason': 'CI 확인'},
          ],
        });
      }
      if (path == '/accounts') {
        return _json({
          'accounts': [
            {'id': 'a-designer', 'handle': 'designer', 'displayName': 'designer', 'kind': 'agent'},
            {'id': 'a-qa', 'handle': 'qa', 'displayName': 'qa', 'kind': 'agent'},
          ],
        });
      }
      if (path == '/reads') {
        return _json({
          'reads': [
            {'channelId': 'd1', 'lastReadSeq': 0, 'unread': 3},
            {'channelId': 'c1', 'lastReadSeq': 0, 'unread': 2},
          ],
        });
      }
      if (path == '/channels/prefs') {
        return _json({
          'prefs': [
            {'channelId': 'c2', 'starredAt': '2026-10-01T00:00:00Z'},
            {'channelId': 'c3', 'hiddenAt': '2026-10-01T00:00:00Z'},
          ],
        });
      }
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      return _json({'error': {'code': 'not_found', 'message': path}}, 404);
    });

Future<AppState> _pump(WidgetTester tester, {bool noDms = false}) async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: _server(noDms: noDms)),
    connector: (_) async => _Idle(),
  );
  addTearDown(app.dispose);
  await tester.pumpWidget(HarkroomApp(state: app));
  await tester.pumpAndSettle();
  return app;
}

void main() {
  testWidgets('탭 넷이 서고 「나」 탭은 없다', (tester) async {
    await _pump(tester);
    for (final k in ['tab-home', 'tab-dms', 'tab-inbox', 'tab-agents']) {
      expect(find.byKey(Key(k)), findsOneWidget, reason: k);
    }
    expect(find.byKey(const Key('tab-me')), findsNothing);
  });

  testWidgets('홈은 DM 을 빼고, DM 탭은 DM 만 — DM 탭 배지는 안 읽은 수', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('channel-c1')), findsOneWidget);
    expect(find.byKey(const Key('channel-d1')), findsNothing);
    expect(find.descendant(of: find.byKey(const Key('tab-dms')), matching: find.text('3')), findsOneWidget);
    await tester.tap(find.byKey(const Key('tab-dms')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('channel-d1')), findsOneWidget);
    expect(find.byKey(const Key('channel-c1')), findsNothing);
    // 이름은 서버가 주지 않는다 — 나를 뺀 상대의 이름으로 짓는다.
    expect(find.descendant(of: find.byKey(const Key('channel-d1')), matching: find.text('designer')), findsOneWidget);
  });

  testWidgets('S7 에이전트 탭: 도는 턴·예약·전체를 scope=visible 로 읽고, 붙기·멈춤 버튼은 없다', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('tab-agents')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('agents-running')), findsOneWidget);
    final run = find.byKey(const Key('agent-run-a-designer-c1-'));
    expect(run, findsOneWidget);
    expect(find.descendant(of: run, matching: find.textContaining('#task')), findsOneWidget);
    expect(find.descendant(of: run, matching: find.textContaining('4')), findsOneWidget, reason: '4분째');
    expect(find.byKey(const Key('agents-waiting')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('agent-wake-a-qa-r1')), matching: find.textContaining('CI 확인')),
        findsOneWidget);
    expect(find.byKey(const Key('agent-a-designer')), findsOneWidget);
    expect(find.byKey(const Key('agent-a-qa')), findsOneWidget);
    // ④ 반투명 머리: 목록은 화면 맨 위부터 그리고, 위 여백이 머리를 비운다. 당기기 회전자도 머리 밑.
    final head = tester.getRect(find.byKey(const Key('glass-app-bar'))).bottom;
    expect(tester.getRect(find.byKey(const Key('agents-list'))).top, 0);
    final pad = tester.widget<ListView>(find.byKey(const Key('agents-list'))).padding! as EdgeInsets;
    expect(pad.top, head);
    expect(tester.widget<RefreshIndicator>(find.byType(RefreshIndicator)).edgeOffset, head);
    // 읽기 전용 — 터미널·멈춤 아이콘이 없다.
    expect(find.byIcon(Icons.terminal), findsNothing);
    expect(find.byIcon(Icons.stop_circle_outlined), findsNothing);
    // 「에이전트 전체」 줄을 누르면 그 에이전트와의 DM 이 열린다(designer ①).
    await tester.tap(find.byKey(const Key('agent-a-qa')));
    await tester.pumpAndSettle();
    expect(find.byType(BackButton), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    // 도는 줄을 누르면 그 채널(스레드 루트가 없으면 채널)이 열린다.
    await tester.tap(run);
    await tester.pumpAndSettle();
    expect(find.byType(BackButton), findsOneWidget);
  });

  testWidgets('S6 나 시트: 프로필 사진(「나 · 설정」)을 누르면 바닥 시트가 0.6 높이로 서고, 머리에 나', (tester) async {
    await _pump(tester);
    final button = tester.widget<IconButton>(find.byKey(const Key('open-me')));
    expect(button.tooltip, anyOf('나 · 설정', 'Me · Settings'));
    await tester.tap(find.byKey(const Key('open-me')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('me-sheet')), findsOneWidget);
    expect(find.byType(BackButton), findsNothing, reason: '밀어 넣는 화면이 아니라 시트다');
    final sheet = tester.widget<DraggableScrollableSheet>(find.byType(DraggableScrollableSheet));
    expect(sheet.initialChildSize, 0.6);
    expect(sheet.maxChildSize, 0.92);
    expect(find.descendant(of: find.byKey(const Key('me-header')), matching: find.textContaining('@me')), findsOneWidget);
    // 보던 탭이 뒤에 그대로 있다.
    expect(find.byKey(const Key('tab-home')), findsOneWidget);
  });

  testWidgets('S6 나 시트: 끌어 내리면 닫히고, 뒤로 가기로도 닫힌다', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('open-me')));
    await tester.pumpAndSettle();
    await tester.fling(find.byKey(const Key('me-sheet')), const Offset(0, 800), 2000);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('me-sheet')), findsNothing);
    await tester.tap(find.byKey(const Key('open-me')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('me-sheet')), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('me-sheet')), findsNothing);
  });

  testWidgets('S6 나 시트: [모두 로그아웃] 은 시트를 먼저 닫고 확인을 연다 — [취소] 는 아무것도 바꾸지 않는다', (tester) async {
    final app = await _pump(tester);
    await tester.tap(find.byKey(const Key('open-me')));
    await tester.pumpAndSettle();
    await tester.drag(find.byKey(const Key('me-sheet')), const Offset(0, -500));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const Key('me-sign-out-all')), 200,
        scrollable: find.descendant(of: find.byKey(const Key('me-sheet')), matching: find.byType(Scrollable)).first);
    await tester.tap(find.byKey(const Key('me-sign-out-all')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('me-sheet')), findsNothing, reason: '시트 둘이 겹치지 않는다');
    expect(find.byKey(const Key('me-sign-out-all-sheet')), findsOneWidget);
    await tester.tap(find.byKey(const Key('me-sign-out-all-cancel')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('me-sign-out-all-sheet')), findsNothing);
    expect(find.byKey(const Key('me-sheet')), findsNothing, reason: '나 시트를 다시 열지 않는다');
    expect(app.communities, isNotEmpty);
    expect(app.phase, AppPhase.ready);
  });

  testWidgets('프로필 사진은 탭 넷 모두의 머리에 있다 — 인박스도', (tester) async {
    await _pump(tester);
    for (final tab in ['tab-home', 'tab-dms', 'tab-inbox', 'tab-agents']) {
      await tester.tap(find.byKey(Key(tab)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('open-me')), findsOneWidget, reason: tab);
    }
    await tester.tap(find.byKey(const Key('open-me')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('me-sheet')), findsOneWidget);
  });

  testWidgets('S5b 홈: 즐겨찾기 묶음이 위에, 치운 채널은 없고, 묶음 머리를 누르면 접힌다', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('section-starred')), findsOneWidget);
    expect(find.byKey(const Key('section-channels')), findsOneWidget);
    expect(find.byKey(const Key('channel-c2')), findsOneWidget);
    expect(find.byKey(const Key('channel-c3')), findsNothing, reason: '치운 채널');
    expect(tester.getTopLeft(find.byKey(const Key('channel-c2'))).dy,
        lessThan(tester.getTopLeft(find.byKey(const Key('channel-c1'))).dy));
    await tester.tap(find.byKey(const Key('section-starred')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('channel-c2')), findsNothing);
    expect(find.byKey(const Key('channel-c1')), findsOneWidget);
  });

  testWidgets('S5c 카드: 「내 차례」 는 인박스 탭, 「새로 온 것」 은 안 읽은 채널만', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('card-my-turn')), findsOneWidget);
    // 안 읽은 채널은 c1 하나다(DM 은 DM 탭이 센다).
    expect(find.descendant(of: find.byKey(const Key('card-new')), matching: find.text('1')), findsOneWidget);
    await tester.tap(find.byKey(const Key('card-new')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('channel-c1')), findsOneWidget);
    expect(find.byKey(const Key('channel-c2')), findsNothing);
    expect(find.byKey(const Key('section-starred')), findsNothing);
    await tester.tap(find.byKey(const Key('card-new')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('channel-c2')), findsOneWidget);
    await tester.tap(find.byKey(const Key('card-my-turn')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-mark-all')).evaluate().isEmpty, isTrue);
    expect(find.byKey(const Key('card-my-turn')), findsNothing, reason: '인박스 탭으로 옮겼다');
  });

  testWidgets('D8 DM 탭 ＋: 사람을 고르면 POST /dms 로 DM 을 열고, 뒤로 가면 DM 목록이다 — ✎ 버튼은 없다', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('new-message')), findsNothing, reason: '떠 있는 ✎ 는 뺐다');
    expect(find.byKey(const Key('new-dm')), findsNothing, reason: '＋ 는 DM 탭 머리에만');
    await tester.tap(find.byKey(const Key('tab-dms')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('new-dm')));
    await tester.pumpAndSettle();
    expect(find.byType(NewDmScreen), findsOneWidget);
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget, reason: '사람 고르기도 탭에 속한 화면');
    expect(find.byKey(const Key('new-dm-person-me-1')), findsNothing, reason: '나는 없다');
    await tester.enterText(find.byKey(const Key('new-dm-filter')), 'des');
    await tester.pump();
    expect(find.byKey(const Key('new-dm-person-a-qa')), findsNothing);
    expect(find.byKey(const Key('new-dm-person-a-designer')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('new-dm-filter')), '');
    await tester.pump();
    await tester.tap(find.byKey(const Key('new-dm-person-a-qa')));
    await tester.pumpAndSettle();
    expect(find.byType(NewDmScreen), findsNothing, reason: '고르면 DM 으로 바꿔 끼운다');
    expect(tester.widget<MessageListScreen>(find.byType(MessageListScreen)).channelId, 'd2');
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byKey(const Key('channel-d2')), matching: find.text('qa')), findsOneWidget);
  });

  testWidgets('D8 DM 이 없으면 빈 화면에 「사람 골라 DM 시작」', (tester) async {
    await _pump(tester, noDms: true);
    await tester.tap(find.byKey(const Key('tab-dms')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('new-dm-empty')));
    await tester.pumpAndSettle();
    expect(find.byType(NewDmScreen), findsOneWidget);
  });

  testWidgets('D2 채널·스레드 안에서도 탭 바가 남고, 다른 탭에 갔다 와도 보던 화면이 남는다', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();
    expect(find.byType(MessageListScreen), findsOneWidget);
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget);
    unawaited(TabNavigators.active!.navigator(0)!
        .push(MaterialPageRoute<void>(builder: (_) => const ThreadScreen(channelId: 'c1', rootId: 'r1'))));
    await tester.pumpAndSettle();
    expect(find.byType(ThreadScreen), findsOneWidget);
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget, reason: '스레드에서도 보인다(D2 B)');
    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();
    expect(find.byType(ThreadScreen), findsNothing);
    await tester.tap(find.byKey(const Key('tab-home')));
    await tester.pumpAndSettle();
    expect(find.byType(ThreadScreen), findsOneWidget, reason: '홈 탭 쌓기가 그대로 남았다');
  });

  testWidgets('D4 지금 탭을 다시 누르면 뿌리로, 뿌리에서 한 번 더 누르면 맨 위로', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-home')));
    await tester.pumpAndSettle();
    expect(find.byType(MessageListScreen), findsNothing);
    expect(find.byKey(const Key('channel-c1')), findsOneWidget);
    // 뿌리 목록이 그 탭의 손잡이를 집는다 — 그래야 한 번 더 누를 때 굴릴 수 있다.
    final scroll = TabNavigators.active!.scrolls[0];
    expect(scroll.hasClients, isTrue);
    scroll.jumpTo(scroll.position.maxScrollExtent);
    await tester.tap(find.byKey(const Key('tab-home')));
    await tester.pumpAndSettle();
    expect(scroll.offset, 0);
  });

  testWidgets('키보드가 올라오면 탭 바는 숨고, 내리면 돌아온다', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget);
    tester.view.viewInsets = const FakeViewPadding(bottom: 900);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump();
    expect(find.byKey(const Key('home-tab-bar')), findsNothing);
    tester.view.resetViewInsets();
    await tester.pump();
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget);
  });

  testWidgets('n1 키보드가 오르는 동안 입력창은 떨어지지 않고, 다 오르면 키보드 위 6 에 선다', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();
    final pill = find.byKey(const Key('composer-pill'));
    final rest = tester.getRect(pill).bottom;
    final screen = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    final bar = tester.getRect(find.byKey(const Key('home-tab-bar')));
    expect(rest, bar.top, reason: '알약(아래 여백 6 포함)이 탭 바 바로 위에 선다');
    addTearDown(tester.view.resetViewInsets);
    // 첫 프레임: 키보드가 20 만 올라왔다. 탭 바는 아직 있고 입력창은 그대로다.
    tester.view.viewInsets = FakeViewPadding(bottom: 20 * tester.view.devicePixelRatio);
    await tester.pump();
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget);
    expect(tester.getRect(pill).bottom, rest, reason: '탭 바 높이만큼 툭 떨어지지 않는다');
    // 다 올라왔다: 탭 바는 빠지고 알약은 키보드 바로 위(아래 여백 6 은 알약 안).
    tester.view.viewInsets = FakeViewPadding(bottom: 300 * tester.view.devicePixelRatio);
    await tester.pump();
    expect(find.byKey(const Key('home-tab-bar')), findsNothing);
    expect(tester.getRect(pill).bottom, screen - 300);
  });

  testWidgets('찾기는 탭 바를 숨기고, 결과로 연 화면에서는 돌아오며, 뒤로 오면 찾기가 남는다', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('tab-search')));
    await tester.pumpAndSettle();
    expect(find.byType(SearchScreen), findsOneWidget);
    expect(find.byKey(const Key('home-tab-bar')), findsNothing);
    // 찾기 위에 채널을 쌓는다(결과·바로 가기가 하는 일).
    final ctx = tester.element(find.byType(SearchScreen));
    unawaited(openChannelScreen(ctx, 'c1', (_) => const MessageListScreen(channelId: 'c1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(find.byType(SearchScreen), findsOneWidget);
    expect(find.byKey(const Key('home-tab-bar')), findsNothing);
  });

  testWidgets('탭 밖(푸시·부팅)에서 DM 을 열면 DM 탭을 골라 그 쌓기에 민다', (tester) async {
    final app = await _pump(tester);
    final root = tester.state<NavigatorState>(find.byType(Navigator).first);
    unawaited(openChannelScreen(root.context, 'd1', navigator: root, (_) => const MessageListScreen(channelId: 'd1')));
    await tester.pumpAndSettle();
    expect(app.homeTab, 1);
    expect(find.byType(MessageListScreen), findsOneWidget);
    expect(find.byKey(const Key('home-tab-bar')), findsOneWidget);
    expect(root.canPop(), isFalse, reason: '루트가 아니라 DM 탭 쌓기에 들어갔다');
  });

  testWidgets('g1 반투명 머리 — 기본은 흐림, 「대비 증가」·「투명도 줄이기」면 불투명으로', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('glass-app-bar')), findsOneWidget);
    expect(find.byKey(const Key('glass-app-bar-blur')), findsOneWidget, reason: '기본은 반투명');

    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(highContrast: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await tester.pump();
    expect(find.byKey(const Key('glass-app-bar')), findsOneWidget, reason: '자리는 그대로');
    expect(find.byKey(const Key('glass-app-bar-blur')), findsNothing, reason: '대비 증가면 흐림을 걷는다');
    tester.platformDispatcher.clearAccessibilityFeaturesTestValue();
    await tester.pump();
    expect(find.byKey(const Key('glass-app-bar-blur')), findsOneWidget);

    // 투명도 줄이기는 Flutter 가 안 넘겨줘서 네이티브 채널로 묻는다.
    const device = MethodChannel('harkroom/device');
    tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(device, (call) async => call.method == 'reduceTransparency' ? true : null);
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(device, null);
      ReduceTransparency.enabled.value = false;
    });
    await ReduceTransparency.refresh();
    await tester.pump();
    expect(find.byKey(const Key('glass-app-bar-blur')), findsNothing, reason: '투명도 줄이기면 흐림을 걷는다');
  });
}

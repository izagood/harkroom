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

MockClient _server() => MockClient((req) async {
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

Future<AppState> _pump(WidgetTester tester) async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: _server()),
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

  testWidgets('머리의 프로필 사진을 누르면 「나」 화면이 선다', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('open-me')));
    await tester.pumpAndSettle();
    expect(find.byType(BackButton), findsOneWidget);
    expect(find.text('나').evaluate().isNotEmpty || find.text('You').evaluate().isNotEmpty, isTrue);
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
    expect(find.byType(BackButton), findsOneWidget);
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

  testWidgets('S5c 새 메시지: 사람을 고르면 POST /dms 로 DM 을 열고 DM 탭에 선다', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('new-message')), findsOneWidget);
    await tester.tap(find.byKey(const Key('new-message')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('new-message-channel-c1')), findsOneWidget);
    expect(find.byKey(const Key('new-message-channel-c3')), findsNothing, reason: '치운 채널');
    expect(find.byKey(const Key('new-message-person-me-1')), findsNothing, reason: '나는 없다');
    await tester.tap(find.byKey(const Key('new-message-person-a-qa')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('new-message-sheet')), findsNothing);
    expect(find.byType(BackButton), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-dms')));
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byKey(const Key('channel-d2')), matching: find.text('qa')), findsOneWidget);
    // 인박스·에이전트 탭에는 새 메시지 버튼이 없다.
    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('new-message')), findsNothing);
  });
}

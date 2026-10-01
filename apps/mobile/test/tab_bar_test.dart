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
            {'id': 'd1', 'name': 'designer', 'kind': 'dm'},
          ],
        });
      }
      if (path == '/accounts') return _json({'accounts': <Object?>[]});
      if (path == '/reads') {
        return _json({
          'reads': [
            {'channelId': 'd1', 'lastReadSeq': 0, 'unread': 3},
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
  });

  testWidgets('에이전트 탭은 S7 전까지 「곧」 한 줄', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('tab-agents')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('agents-soon')), findsOneWidget);
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
}

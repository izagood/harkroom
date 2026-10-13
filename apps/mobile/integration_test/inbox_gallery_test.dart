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
import 'package:integration_test/integration_test.dart';

/// **Inbox 갤러리**(A안 모바일 M2). 정해진 가짜 데이터로 받은 일 화면 다섯 장을 찍는다 — `gallery_test.dart` 와 같은
/// 까닭(같은 데이터여야 바뀐 것이 화면뿐이다). 채널·사람 이름은 지어낸 것이다.
/// ```
/// flutter drive --driver=test_driver/integration_test.dart --target=integration_test/inbox_gallery_test.dart -d <시뮬레이터>
/// ```
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> shot(WidgetTester tester, String name) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    await binding.takeScreenshot(name);
  }

  testWidgets('받은 일', (tester) async {
    final app = AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me',
          'communities': [
            {'accountId': 'me', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
          ],
        }),
      ),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: _server()),
      connector: (_) async => _IdleConnection(),
    );
    await tester.pumpWidget(HarkroomApp(state: app));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();
    await shot(tester, '41-inbox-todo');

    await tester.tap(find.byKey(const Key('inbox-card-d1')));
    await tester.pumpAndSettle();
    await shot(tester, '42-inbox-decision-detail');
    Navigator.of(tester.element(find.byKey(const Key('inbox-detail')))).pop();
    await tester.pumpAndSettle();

    await tester.drag(find.byKey(const ValueKey('inbox-swipe-b4')), const Offset(-500, 0));
    await tester.pumpAndSettle();
    await shot(tester, '43-inbox-swiped-snackbar');
    ScaffoldMessenger.of(tester.element(find.byKey(const Key('inbox-title')))).removeCurrentSnackBar();
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.byKey(const Key('inbox-stale-toggle')),
      200,
      scrollable: find.descendant(of: find.byKey(const Key('inbox-list-todo')), matching: find.byType(Scrollable)).first,
    );
    await tester.tap(find.byKey(const Key('inbox-stale-toggle')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.byKey(const Key('inbox-card-old1')),
      200,
      scrollable: find.descendant(of: find.byKey(const Key('inbox-list-todo')), matching: find.byType(Scrollable)).first,
    );
    await shot(tester, '44-inbox-stale-open');

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    await tester.drag(find.byKey(const Key('inbox-list-todo')), const Offset(0, 2000));
    await tester.pumpAndSettle();
    await shot(tester, '45-inbox-dark');
  });
}

String _ago(Duration d) => DateTime.now().toUtc().subtract(d).toIso8601String();

var _n = 0;
Map<String, Object?> _entry(String root, String author, {Map<String, Object?> meta = const {}, Duration ago = const Duration(minutes: 20), String? body, bool read = false}) {
  _n += 1;
  return {
    'id': _n, 'messageId': 'e$_n', 'reason': 'mention', 'channelId': 'c1', 'authorId': author,
    'body': body ?? '말 $_n', 'meta': meta, 'createdAt': _ago(ago), 'threadRootId': root, 'readAt': read ? _ago(Duration.zero) : null,
  };
}

Map<String, Object?> _head(String id, String channel, {Map<String, Object?> extra = const {}, Duration ago = const Duration(hours: 1), int replies = 4}) => {
      'id': id, 'channelId': channel, 'authorId': 'me', 'body': '머리 $id', 'createdAt': _ago(ago), 'replyCount': replies,
      'openAskHumanCount': 0, 'openAskAccountIds': <String>[], 'openAskLinks': <Object?>[], 'unresolvedFailureCount': 0,
      'lastKind': 'user', 'lastAuthorId': 'me', ...extra,
    };

Map<String, Object?> _ask(String prompt, List<String> options) => {
      'kind': 'ask',
      'ask': {
        'prompt': prompt,
        'options': [for (var i = 0; i < options.length; i++) {'id': 'o$i', 'label': options[i]}],
        'to': {'kind': 'account', 'accountId': 'me'},
      },
    };
Map<String, Object?> _fail(String reason) => {'kind': 'failure', 'failure': {'retryable': true, 'what': '하네스가 멈췄다', 'reason': reason}};

Map<String, Object?> _board() {
  _n = 0;
  final entries = [
    _entry('d1', 'tm', meta: _ask('서버를 올린 뒤 #1288(묶음 카드 화면)을 머지할까?', ['올리고 머지 (추천)', '서버만 먼저', '나중에 — 다른 답 쓰기']),
        ago: const Duration(minutes: 13), body: '서버를 올린 뒤 #1288(묶음 카드 화면)을 머지할까?'),
    _entry('d1', 'des', ago: const Duration(minutes: 8), body: '새 head 디자인 OK. 서버가 먼저 나가야 빈 카드를 그리지 않는다.'),
    _entry('d2', 'hk', meta: _ask('권한을 줄까? — gh pr view -R example/app', ['7일 허락하고 다시 시도', '거절']), ago: const Duration(minutes: 16)),
    _entry('b1', 'forge', meta: _fail('하네스가 관문 화면에 섰다'), ago: const Duration(minutes: 50)),
    _entry('b2', 'forge', meta: _fail('하네스가 관문 화면에 섰다'), ago: const Duration(minutes: 90)),
    _entry('b3', 'forge', meta: _fail('하네스가 관문 화면에 섰다'), ago: const Duration(minutes: 140)),
    _entry('b4', 'runner', meta: _fail('에이전트가 MCP 인증을 기다린다'), ago: const Duration(hours: 2), read: true),
    _entry('old1', 'tm', meta: _ask('지난 배포 순서를 정해 달라', ['A 먼저', 'B 먼저']), ago: const Duration(days: 12)),
    _entry('old2', 'hk', meta: _fail('원격 operator 머지 승인 부탁'), ago: const Duration(days: 20), read: true),
    _entry('n1', 'tm', ago: const Duration(hours: 3), body: '#1286 머지됨 — 스크롤 버벅임 ①'),
  ];
  final threads = [
    _head('d1', 'c2', extra: {'openAskAccountIds': ['me']}, replies: 36),
    _head('d2', 'c1', extra: {'openAskAccountIds': ['me']}),
    for (final r in ['b1', 'b2', 'b3']) _head(r, 'c3', extra: {'unresolvedFailureCount': 1}),
    _head('b4', 'c4', extra: {'unresolvedFailureCount': 1}),
    _head('old1', 'c2', extra: {'openAskAccountIds': ['me']}, ago: const Duration(days: 12)),
    _head('old2', 'c1', extra: {'unresolvedFailureCount': 1}, ago: const Duration(days: 20)),
    _head('n1', 'c1', extra: {'lastAuthorId': 'tm'}),
  ];
  // 채널을 줄의 채널에 맞춘다(머리 채널과 같게).
  final channelOf = {for (final h in threads) h['id']: h['channelId']};
  for (final e in entries) {
    e['channelId'] = channelOf[e['threadRootId']];
  }
  return {'entries': entries, 'threads': threads, 'threadStates': <Object?>[]};
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me', 'handle': 'alex', 'displayName': 'alex', 'isAdmin': false});
      if (path == '/channels') {
        return _json({'channels': [
          {'id': 'c1', 'name': 'dev', 'kind': 'standard'},
          {'id': 'c2', 'name': 'task', 'kind': 'standard'},
          {'id': 'c3', 'name': 'lab-integration-long-name', 'kind': 'standard'},
          {'id': 'c4', 'name': 'ops', 'kind': 'standard'},
        ]});
      }
      if (path == '/accounts') {
        return _json({'accounts': [
          for (final (id, h) in [('tm', 'task_manager'), ('des', 'designer'), ('hk', 'harkroom'), ('forge', 'forge'), ('runner', 'runner')])
            {'id': id, 'handle': h, 'displayName': h, 'kind': 'agent'},
          {'id': 'me', 'handle': 'alex', 'displayName': 'alex', 'kind': 'human'},
        ]});
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path == '/inbox/board') return _json(_board());
      if (path.startsWith('/inbox') && req.method == 'GET') return _json({'entries': <Object?>[]});
      if (path.startsWith('/inbox/threads/')) return _json({'state': null});
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      if (path.startsWith('/saved')) return _json({'open': 0, 'entries': <Object?>[]});
      return _json({'error': {'code': 'not_found', 'message': path}}, 404);
    });

class _IdleConnection implements WsConnection {
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

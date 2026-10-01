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

/// **화면 갤러리.** 정해진 가짜 데이터로 주요 화면을 돌며 한 장씩 찍는다.
///
/// ## 왜 있나
///
/// UI 를 고치는 PR 마다 "전후" 그림을 붙여 designer 가 본다. 실서버로 찍으면 그날의 대화가
/// 그림에 실리고(공개 저장소의 PR 본문에 남는다), 찍을 때마다 내용이 달라 전후를 견줄 수 없다.
/// 같은 데이터로 찍어야 **바뀐 것이 화면뿐**이다.
///
/// ## 찍는 법
///
/// 그림 파일은 `flutter drive` 의 드라이버가 받아 쓴다(`test_driver/integration_test.dart`):
/// ```
/// flutter drive --driver=test_driver/integration_test.dart \
///   --target=integration_test/gallery_test.dart -d <시뮬레이터>
/// ```
/// 결과는 `build/gallery/<이름>.png`. `flutter test` 로 돌리면 그림 없이 화면만 돈다.
///
/// 시각이 들어간 화면이 있어 **기준 시각을 고정하지 않는다** — 데이터의 시각을 지금에서
/// 거꾸로 센다(몇 분 전).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> shot(WidgetTester tester, String name) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    await binding.takeScreenshot(name);
  }

  testWidgets('갤러리', (tester) async {
    final app = AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': '00000000-0000-4000-8000-000000000001',
          'communities': [
            {'accountId': '00000000-0000-4000-8000-000000000001', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'jaebin'},
          ],
        }),
      ),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: _server()),
      connector: (_) async => _IdleConnection(),
    );
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await shot(tester, '01-channels');

    await tester.tap(find.byKey(const Key('channel-c1')));
    await shot(tester, '02-channel');

    final open = find.byKey(const Key('thread-open-m1'));
    await tester.scrollUntilVisible(open, 300,
        scrollable: find
            .descendant(of: find.byKey(const Key('channel-feed')), matching: find.byType(Scrollable))
            .first);
    await shot(tester, '02a-channel-top');
    await tester.tap(open);
    await shot(tester, '03-thread');
    await tester.tap(find.byType(BackButton));
    await shot(tester, '02b-channel-back');
    await tester.tap(find.byType(BackButton));
    // 뒤로 가는 전환이 끝나야 탭 막대가 눌린다.
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }

    await tester.tap(find.byKey(const Key('tab-inbox')));
    await shot(tester, '04-inbox');

    await tester.tap(find.byKey(const Key('tab-me')));
    await shot(tester, '05-me');

    // ── 다크 판. 기기 밝기를 바꾸면 `MaterialApp.darkTheme` 이 선다.
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    // 밝기가 바뀌면 테마가 200ms 동안 넘어간다 — 그 사이에 찍으면 반쯤 바뀐 화면이 찍힌다.
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.tap(find.byKey(const Key('tab-channels')));
    await shot(tester, '06-dark-channels');
    await tester.tap(find.byKey(const Key('channel-c1')));
    await shot(tester, '07-dark-channel');
  });

  // ── S2: 상태 셋과 실패 ────────────────────────────────────────────────
  testWidgets('상태', (tester) async {
    final app = _galleryApp(_server(states: true));
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await shot(tester, '10-boot');

    // 못 읽은 채널 — "다시 시도".
    await tester.tap(find.byKey(const Key('channel-c3')));
    await shot(tester, '11-channel-failed');
    await tester.tap(find.byType(BackButton));
    await shot(tester, '11b-back');

    // 비어 있는 채널 — 할 일 한 줄.
    await tester.tap(find.byKey(const Key('channel-c4')));
    await shot(tester, '12-channel-empty');
    await tester.tap(find.byType(BackButton));
    await shot(tester, '12b-back');

    // 보내지 못한 말 + 끊김 띠.
    await tester.tap(find.byKey(const Key('channel-c1')));
    await shot(tester, '13a-open');
    await tester.enterText(find.byKey(const Key('composer')), '@forge 이거 해 줘');
    await tester.tap(find.byKey(const Key('composer-send')));
    await shot(tester, '13-send-failed');
    app.connection = SocketState.reconnecting;
    app.notifyListeners();
    await shot(tester, '14-band');
    // 자격증명이 죽었다 — 빨간 띠 + 다시 로그인.
    app.connection = SocketState.dead;
    app.notifyListeners();
    await shot(tester, '16-band-dead');
    app.connection = SocketState.online;
    app.notifyListeners();

    // ask 답이 실패하면 토스트 + 다시 시도.
    final option = find.byKey(const Key('ask-option-m4-a'));
    await tester.scrollUntilVisible(option, 250,
        scrollable: find
            .descendant(of: find.byKey(const Key('channel-feed')), matching: find.byType(Scrollable))
            .first);
    await tester.tap(option);
    await shot(tester, '17-toast');
    await tester.tap(find.byType(BackButton));
    await shot(tester, '17b-back');

    // 읽는 중 — 답이 오지 않는 채널.
    await tester.tap(find.byKey(const Key('channel-c2')));
    await shot(tester, '18-loading');
  });

  testWidgets('부팅 실패', (tester) async {
    final app = _galleryApp(MockClient((_) async => throw http.ClientException('네트워크 없음')));
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await shot(tester, '15-boot-unreachable');
  });
}

AppState _galleryApp(http.Client client) => AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': '00000000-0000-4000-8000-000000000001',
          'communities': [
            {
              'accountId': '00000000-0000-4000-8000-000000000001',
              'baseUrl': 'https://h.example.com',
              'token': 'tok',
              'handle': 'jaebin',
            },
          ],
        }),
      ),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: client),
      connector: (_) async => _IdleConnection(),
    );

String _ago(int minutes) =>
    DateTime.now().toUtc().subtract(Duration(minutes: minutes)).toIso8601String();

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

const _accounts = [
  {'id': '00000000-0000-4000-8000-000000000001', 'handle': 'jaebin', 'displayName': 'jaebin', 'kind': 'human'},
  {'id': '00000000-0000-4000-8000-000000000002', 'handle': 'task_manager', 'displayName': 'task_manager', 'kind': 'agent'},
  {'id': '00000000-0000-4000-8000-000000000003', 'handle': 'harkroom', 'displayName': 'harkroom', 'kind': 'agent'},
  {'id': '00000000-0000-4000-8000-000000000004', 'handle': 'designer', 'displayName': 'designer', 'kind': 'agent'},
];

Map<String, Object?> _m(String id, int seq, String author, String body,
        {String kind = 'user', Map<String, Object?>? meta, int? replyCount, String? root, int ago = 5}) =>
    {
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': ?root,
      'authorId': author,
      'body': body,
      'kind': kind,
      'meta': ?meta,
      'replyCount': ?replyCount,
      'createdAt': _ago(ago),
      'reactions': <Object?>[],
      'attachments': <Object?>[],
    };

/// [states] 가 참이면 **실패를 일부러 섞는다**(S2 상태 화면을 찍으려고): `#testbed` 는 못 읽고,
/// `#homelab` 은 비어 있고, 보내기는 실패한다.
MockClient _server({bool states = false}) => MockClient((req) async {
      final path = req.url.path;
      if (states) {
        // 읽는 중 자리표시를 찍으려고 `#harkroom` 은 **답하지 않는다**(타이머 없이 매달린다).
        if (path == '/channels/c2/messages') return Completer<http.Response>().future;
        if (path.contains('/ask-answer')) {
          return _json({'error': {'code': 'unavailable', 'message': 'down'}}, 503);
        }
        if (path == '/channels/c3/messages') {
          return _json({'error': {'code': 'unavailable', 'message': 'down'}}, 503);
        }
        if (path == '/channels/c4/messages') return _json({'messages': <Object?>[], 'hasMore': false});
        if (path.endsWith('/messages') && req.method == 'POST') {
          return _json({'error': {'code': 'unavailable', 'message': 'down'}}, 503);
        }
      }
      if (path == '/auth/me') {
        return _json({'id': '00000000-0000-4000-8000-000000000001', 'handle': 'jaebin', 'displayName': 'jaebin', 'isAdmin': true});
      }
      if (path == '/channels') {
        return _json({
          'channels': [
            {'id': 'c1', 'name': 'task', 'kind': 'standard', 'visibility': 'public'},
            {'id': 'c2', 'name': 'harkroom', 'kind': 'standard', 'visibility': 'public'},
            {'id': 'c3', 'name': 'testbed', 'kind': 'standard', 'visibility': 'private'},
            {'id': 'c4', 'name': 'homelab', 'kind': 'standard', 'visibility': 'public'},
          ],
        });
      }
      if (path == '/accounts') return _json({'accounts': _accounts});
      if (path == '/reads') {
        return _json({
          'reads': [
            {'channelId': 'c1', 'lastReadSeq': 0, 'unread': 6},
            {'channelId': 'c2', 'lastReadSeq': 0, 'unread': 2},
          ],
        });
      }
      if (path.startsWith('/inbox') && req.method == 'GET') {
        return _json({
          'entries': [
            {
              'id': 1,
              'messageId': 'm4',
              'reason': 'mention',
              'channelId': 'c1',
              'authorId': '00000000-0000-4000-8000-000000000002',
              'body': '<@00000000-0000-4000-8000-000000000001> 모바일 다음 작업 순서를 골라 달라.',
              'createdAt': _ago(20),
              'readAt': null,
            },
            {
              'id': 2,
              'messageId': 'r1',
              'reason': 'thread_reply',
              'channelId': 'c1',
              'threadRootId': 'm1',
              'authorId': '00000000-0000-4000-8000-000000000004',
              'body': '끝나면 이 스레드에 링크를 남긴다.',
              'createdAt': _ago(10),
              'readAt': null,
            },
          ],
        });
      }
      if (path.endsWith('/read')) return _json(<String, Object?>{});
      if (path.endsWith('/messages') && req.url.queryParameters['thread'] != null) {
        return _json({
          'messages': [
            _m('m1', 1, '00000000-0000-4000-8000-000000000001', '<@00000000-0000-4000-8000-000000000002> 모바일 앱 UI 검토를 designer 에게 맡겨 줘', replyCount: 2, ago: 90),
            _m('r1', 7, '00000000-0000-4000-8000-000000000002', '맡겼다. 범위는 apps/mobile 전체다.', root: 'm1', ago: 60),
            _m('r2', 8, '00000000-0000-4000-8000-000000000004', '끝나면 이 스레드에 링크를 남긴다.', root: 'm1', ago: 10),
          ],
          'hasMore': false,
        });
      }
      if (path.endsWith('/messages') && req.method == 'GET') {
        return _json({
          'messages': [
            _m('m1', 1, '00000000-0000-4000-8000-000000000001', '<@00000000-0000-4000-8000-000000000002> 모바일 앱 UI 검토를 designer 에게 맡겨 줘', replyCount: 2, ago: 90),
            _m('m2', 2, '00000000-0000-4000-8000-000000000002', '<@00000000-0000-4000-8000-000000000003> 에게 넘겼다. 범위는 apps/mobile 전체다.',
                meta: {
                  'mentionDenied': ['harkroom'],
                },
                ago: 60),
            _m('m3', 3, '00000000-0000-4000-8000-000000000002', '자세한 건 스레드 참고.', ago: 59),
            _m('m5', 5, '00000000-0000-4000-8000-000000000003', '모바일 S1 을 끝냈다.',
                meta: {
                  'kind': 'report',
                  'report': {
                    'checks': ['flutter test 168개 통과'],
                    'files': ['apps/mobile/lib/theme.dart'],
                    'remaining': ['S2 상태 셋'],
                  },
                },
                ago: 30),
            _m('m6', 6, '00000000-0000-4000-8000-000000000003', 'TestFlight 업로드',
                meta: {
                  'kind': 'failure',
                  'failure': {'what': 'TestFlight 업로드', 'reason': '서명 키가 없다', 'retryable': false},
                },
                ago: 25),
            _m('m4', 4, '00000000-0000-4000-8000-000000000002', '모바일 다음 작업 순서를 골라 달라.',
                meta: {
                  'kind': 'ask',
                  'ask': {
                    'options': [
                      {'id': 'a', 'label': '멘션 거절 먼저'},
                      {'id': 'b', 'label': 'TestFlight 먼저'},
                    ],
                    'to': {'kind': 'account', 'accountId': '00000000-0000-4000-8000-000000000001'},
                  },
                },
                ago: 20),
            _m('m9', 9, '00000000-0000-4000-8000-000000000004', '화면을 찍는 중이다', kind: 'progress', ago: 2),
          ],
          'hasMore': false,
        });
      }
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
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

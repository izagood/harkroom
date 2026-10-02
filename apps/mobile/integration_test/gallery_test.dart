import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/markdown/markdown_view.dart';
import 'package:harkroom/push/push_coordinator.dart';
import 'package:harkroom/push/push_platform.dart';
import 'package:harkroom/screens/thread_screen.dart';
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
            {'accountId': '00000000-0000-4000-8000-000000000001', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
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

    // 첨부 시트. 시뮬레이터라 [사진 찍기] 줄이 비활성으로 선다 — 실기기와 배치가 같다.
    await tester.tap(find.byKey(const Key('attach')));
    await shot(tester, '02c-attach-sheet');
    await tester.tapAt(const Offset(20, 120));
    await shot(tester, '02d-attach-closed');

    final open = find.byKey(const Key('thread-open-m1'));
    await tester.scrollUntilVisible(open, 300,
        scrollable: find
            .descendant(of: find.byKey(const Key('channel-feed')), matching: find.byType(Scrollable))
            .first);
    await shot(tester, '02a-channel-top');
    // S4e: 리액션 줄 끝 「이모지 달기」 시트.
    await tester.tap(find.byKey(const Key('reaction-add-m1')));
    await shot(tester, '02e-emoji-sheet');
    await tester.tapAt(const Offset(20, 120));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    // S4e: 링크 시트 — 사용자 정보와 영문 아닌 글자가 둘 다 있는 주소면 경고가 두 줄.
    showLinkConfirm(tester.element(find.byKey(const Key('channel-feed'))),
        Uri.parse('https://user@ex\u0430mple.com/login'));
    await shot(tester, '02f-link-warnings');
    await tester.tap(find.byKey(const Key('link-cancel')));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    await tester.tap(open);
    await shot(tester, '03-thread');
    // @ 버튼(S4c): 누르면 칸에 @ 가 들어가 후보 줄이 선다. 키보드는 내려서 찍는다.
    await tester.tap(find.byKey(const Key('mention-add')).last);
    await tester.pump(const Duration(milliseconds: 300));
    FocusManager.instance.primaryFocus?.unfocus();
    await shot(tester, '03a-thread-mention');
    await tester.enterText(find.byKey(const Key('thread-composer')), '');
    await tester.pump();
    await tester.tap(find.byType(BackButton));
    await shot(tester, '02b-channel-back');
    await tester.tap(find.byType(BackButton));
    // 뒤로 가는 전환이 끝나야 탭 막대가 눌린다.
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }

    await tester.tap(find.byKey(const Key('tab-inbox')));
    await shot(tester, '04-inbox');
    // S5a: DM 탭 · 에이전트 탭(S7 전 빈 자리).
    await tester.tap(find.byKey(const Key('tab-dms')));
    await shot(tester, '04b-dms');
    await tester.tap(find.byKey(const Key('tab-agents')));
    await shot(tester, '04c-agents');

    // S5a: 「나」 는 머리의 프로필 사진으로 연다.
    await tester.tap(find.byKey(const Key('tab-home')));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.byKey(const Key('open-me')).first);
    await shot(tester, '05-me');
    await tester.tap(find.byType(BackButton));
    await tester.pump(const Duration(milliseconds: 400));

    // ── 다크 판. 기기 밝기를 바꾸면 `MaterialApp.darkTheme` 이 선다.
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    // 밝기가 바뀌면 테마가 200ms 동안 넘어간다 — 그 사이에 찍으면 반쯤 바뀐 화면이 찍힌다.
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.tap(find.byKey(const Key('tab-home')));
    await shot(tester, '06-dark-channels');
    await tester.tap(find.byKey(const Key('channel-c1')));
    await shot(tester, '07-dark-channel');
    // 다크에서 멘션 거절 노란 줄과 멘션 칩(designer #980).
    final denied = find.byKey(const Key('mention-denied'));
    await tester.scrollUntilVisible(denied, 250,
        scrollable: find
            .descendant(of: find.byKey(const Key('channel-feed')), matching: find.byType(Scrollable))
            .first);
    await shot(tester, '08-dark-denied');
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

    // ask 답이 실패하면 토스트 + 다시 시도. 작성칸의 키보드를 먼저 내린다 — 토스트가 키보드
    // 자리에 가려진다.
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump(const Duration(milliseconds: 400));
    final option = find.byKey(const Key('ask-option-m4-a'));
    await tester.scrollUntilVisible(option, 250,
        scrollable: find
            .descendant(of: find.byKey(const Key('channel-feed')), matching: find.byType(Scrollable))
            .first);
    await tester.tap(option);
    await tester.pump(const Duration(milliseconds: 300));
    await shot(tester, '17-toast');
    await tester.tap(find.byType(BackButton));
    await shot(tester, '17b-back');

    // 읽는 중 — 답이 오지 않는 채널.
    await tester.tap(find.byKey(const Key('channel-c2')));
    await shot(tester, '18-loading');
  });

  // ── 답글이 많은 채널(실기기 #task 의 모양). 최근 500 줄 대부분이 스레드 답글이다.
  testWidgets('답글 많은 채널', (tester) async {
    final app = _galleryApp(_busyServer());
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await shot(tester, '20a-busy-list');
    await tester.tap(find.byKey(const Key('channel-c1')));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    await shot(tester, '20-busy-channel');
  });

  // ── 채널 맨 위(S4a): 위로 밀어 이전 페이지를 받는 순간 · 못 받았을 때 · 끝까지 받은 뒤.
  testWidgets('채널 맨 위', (tester) async {
    final edge = _EdgeServer();
    final app = _galleryApp(edge.client);
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await shot(tester, '21a-edge-list');
    await tester.tap(find.byKey(const Key('channel-c1')));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    ScrollPosition pos() => tester
        .state<ScrollableState>(find
            .descendant(of: find.byKey(const Key('channel-feed')), matching: find.byType(Scrollable))
            .first)
        .position;
    Future<void> toTop() async {
      pos().jumpTo(pos().maxScrollExtent);
      await tester.pump(const Duration(milliseconds: 60));
      pos().jumpTo(pos().maxScrollExtent);
    }

    // 1) 받는 동안: 서버가 답을 미룬다 → 맨 위에 회전자.
    edge.hold = Completer<void>();
    await toTop();
    await shot(tester, '21-older-loading');
    // 2) 못 받았다: 같은 요청을 500 으로 끝낸다 → "다시 시도" 줄.
    edge.fail = true;
    edge.hold!.complete();
    edge.hold = null;
    await toTop();
    await shot(tester, '22-older-failed');
    // 3) 다시 시도 → 끝까지 받았다 → 시작 줄과 그 아래 첫 날짜 줄.
    edge.fail = false;
    await tester.tap(find.byKey(const Key('older-retry')));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    await toTop();
    await shot(tester, '23-channel-start');
  });

  // ── 긴 스레드(서버 #1048): 원글이 어제라 구분 줄이 「답글 n개 · 오늘」, 위로 밀면 옛 답글 회전자·실패 줄.
  testWidgets('긴 스레드', (tester) async {
    final srv = _LongThreadServer();
    final app = _galleryApp(srv.client);
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    Navigator.of(tester.element(find.byKey(const Key('channel-c1')))).push(
      MaterialPageRoute<void>(builder: (_) => const ThreadScreen(channelId: 'c1', rootId: 'lt-root')),
    );
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    ScrollPosition pos() =>
        tester.state<ScrollableState>(find.descendant(of: find.byKey(const Key('thread-feed')), matching: find.byType(Scrollable)).first).position;
    // 옛 답글을 받는 중(서버가 답을 미룬다) — 「답글 n개」 아래 회전자. 미루기를 먼저 걸고 민다.
    srv.hold = Completer<void>();
    pos().jumpTo(pos().maxScrollExtent);
    await tester.pump(const Duration(milliseconds: 60));
    pos().jumpTo(pos().maxScrollExtent);
    await shot(tester, '31-thread-older-loading');
    // 못 받았다 — 다시 시도 줄.
    srv.fail = true;
    srv.hold!.complete();
    srv.hold = null;
    await tester.pump(const Duration(milliseconds: 200));
    pos().jumpTo(pos().maxScrollExtent);
    await shot(tester, '32-thread-older-failed');
    await tester.tap(find.byType(BackButton));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
    // 원글을 끝내 못 찾은 스레드 — 「원글을 불러오지 못했다」 + 구분 줄.
    Navigator.of(tester.element(find.byKey(const Key('channel-c1')))).push(
      MaterialPageRoute<void>(builder: (_) => const ThreadScreen(channelId: 'c1', rootId: 'gone-root')),
    );
    await shot(tester, '33-thread-root-missing');
  });

  testWidgets('푸시 안내 시트', (tester) async {
    final app = _galleryApp(_server());
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app, push: PushCoordinator(app, _GalleryPush())));
    await shot(tester, '17-push-prompt');
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
              'handle': 'me',
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
  {'id': '00000000-0000-4000-8000-000000000001', 'handle': 'me', 'displayName': 'me', 'kind': 'human'},
  {'id': '00000000-0000-4000-8000-000000000002', 'handle': 'task_manager', 'displayName': 'task_manager', 'kind': 'agent'},
  {'id': '00000000-0000-4000-8000-000000000003', 'handle': 'harkroom', 'displayName': 'harkroom', 'kind': 'agent'},
  {'id': '00000000-0000-4000-8000-000000000004', 'handle': 'designer', 'displayName': 'designer', 'kind': 'agent'},
];

Map<String, Object?> _m(String id, int seq, String author, String body,
        {String kind = 'user', Map<String, Object?>? meta, int? replyCount, String? root, int ago = 5,
        List<String>? participants, int? lastReplyAgo, List<Map<String, Object?>> reactions = const []}) =>
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
      'participantIds': ?participants,
      'lastReplyAt': lastReplyAgo == null ? null : _ago(lastReplyAgo),
      'createdAt': _ago(ago),
      'reactions': reactions,
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
        return _json({'id': '00000000-0000-4000-8000-000000000001', 'handle': 'me', 'displayName': 'me', 'isAdmin': true});
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
            _m('m1', 1, '00000000-0000-4000-8000-000000000001', '<@00000000-0000-4000-8000-000000000002> 모바일 앱 UI 검토를 designer 에게 맡겨 줘', replyCount: 2, ago: 90,
                // S4e: 요약 줄 아바타·마지막 답글 시각, 리액션(+ 이모지 달기 칩).
                participants: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000004'],
                lastReplyAgo: 10,
                reactions: [
                  {'emoji': '👀', 'accountIds': ['00000000-0000-4000-8000-000000000002']},
                  {'emoji': '✅', 'accountIds': ['00000000-0000-4000-8000-000000000001']},
                ]),
            _m('r1', 7, '00000000-0000-4000-8000-000000000002', '맡겼다. 범위는 apps/mobile 전체다.', root: 'm1', ago: 60),
            _m('r2', 8, '00000000-0000-4000-8000-000000000004', '끝나면 이 스레드에 링크를 남긴다.', root: 'm1', ago: 10),
          ],
          'hasMore': false,
        });
      }
      if (path.endsWith('/messages') && req.method == 'GET') {
        return _json({
          'messages': [
            _m('m1', 1, '00000000-0000-4000-8000-000000000001', '<@00000000-0000-4000-8000-000000000002> 모바일 앱 UI 검토를 designer 에게 맡겨 줘', replyCount: 2, ago: 90,
                // S4e: 요약 줄 아바타·마지막 답글 시각, 리액션(+ 이모지 달기 칩).
                participants: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000004'],
                lastReplyAgo: 10,
                reactions: [
                  {'emoji': '👀', 'accountIds': ['00000000-0000-4000-8000-000000000002']},
                  {'emoji': '✅', 'accountIds': ['00000000-0000-4000-8000-000000000001']},
                ]),
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
                ago: 35),
            _m('m8', 8, '00000000-0000-4000-8000-000000000003',
                '## 고칠 것\n**둘**이다. @me 확인해 줘:\n1. 다크 `ink` 값을 올린다\n2. 배지 글자는 `onAccent`\n\n```\nflutter test\n```\n> 사양은 재설계 §2 에 있다.\n자세한 건 [PR](https://example.com/pr/1).',
                ago: 3),
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

/// 1500 줄 중 50 줄마다 최상위, 나머지는 답글. `before`·`limit` 을 서버와 같은 뜻으로 받는다.
MockClient _busyServer() {
  const me = '00000000-0000-4000-8000-000000000001';
  const tm = '00000000-0000-4000-8000-000000000002';
  final all = <Map<String, Object?>>[];
  String? root;
  for (var seq = 1; seq <= 1500; seq++) {
    final isRoot = seq % 50 == 1;
    final id = 'b$seq';
    if (isRoot) root = id;
    all.add({
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': isRoot ? null : root,
      'authorId': isRoot ? me : tm,
      'body': isRoot ? '최상위 글 ${seq ~/ 50 + 1} — 답글이 49개 달렸다' : '답글 $seq',
      'kind': 'user',
      'replyCount': isRoot ? 49 : null,
      'createdAt': _ago((1500 - seq) ~/ 5),
    });
  }
  return MockClient((req) async {
    final path = req.url.path;
    if (path == '/auth/me') return _json({'id': me, 'handle': 'me', 'displayName': 'me', 'isAdmin': true});
    if (path == '/channels') {
      return _json({
        'channels': [
          {'id': 'c1', 'name': 'task', 'kind': 'standard', 'visibility': 'public'},
        ],
      });
    }
    if (path == '/accounts') {
      return _json({
        'accounts': [
          {'id': me, 'handle': 'me', 'displayName': 'me', 'kind': 'human'},
          {'id': tm, 'handle': 'task_manager', 'displayName': 'task_manager', 'kind': 'agent'},
        ],
      });
    }
    if (path == '/reads') return _json({'reads': <Object?>[]});
    if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
    if (path.endsWith('/read')) return _json(<String, Object?>{});
    if (path == '/channels/c1/messages') {
      final q = req.url.queryParameters;
      final limit = int.parse(q['limit'] ?? '200');
      final before = q['before'] == null ? null : int.parse(q['before']!);
      final pool = all.where((m) => before == null || (m['seq']! as int) < before).toList();
      final page = pool.length > limit ? pool.sublist(pool.length - limit) : pool;
      return _json({'messages': page, 'hasMore': page.isNotEmpty && (page.first['seq']! as int) > 1});
    }
    if (path == '/ws-ticket') return _json({'ticket': 'tk'});
    return _json({'error': {'code': 'not_found', 'message': path}}, 404);
  });
}

/// 900 줄 · 5 줄마다 최상위. 첫 페이지(500)로 최상위가 충분해 더 받지 않고, 위로 한 번 밀면
/// 끝(seq 1)에 닿는다. [hold]·[fail] 로 **이전 페이지 요청만** 미루거나 실패시킨다.
class _EdgeServer {
  _EdgeServer() {
    const me = '00000000-0000-4000-8000-000000000001';
    const tm = '00000000-0000-4000-8000-000000000002';
    String? root;
    for (var seq = 1; seq <= 900; seq++) {
      final isRoot = seq % 5 == 1;
      final id = 'e$seq';
      if (isRoot) root = id;
      all.add({
        'id': id,
        'seq': seq,
        'channelId': 'c1',
        'threadRootId': isRoot ? null : root,
        'authorId': (seq ~/ 5).isEven ? me : tm,
        'body': isRoot ? '최상위 글 ${seq ~/ 5 + 1}' : '답글 $seq',
        'kind': 'user',
        'replyCount': isRoot ? 4 : null,
        // 앞 절반은 사흘 전 — 끝까지 밀면 첫 날짜 줄이 "오늘" 이 아니다.
        'createdAt': _ago(seq < 450 ? 3 * 24 * 60 + (900 - seq) : (900 - seq) ~/ 2),
      });
    }
  }

  final all = <Map<String, Object?>>[];
  Completer<void>? hold;
  bool fail = false;

  MockClient get client => MockClient((req) async {
        const me = '00000000-0000-4000-8000-000000000001';
        final path = req.url.path;
        if (path == '/auth/me') return _json({'id': me, 'handle': 'me', 'displayName': 'me', 'isAdmin': true});
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'task', 'kind': 'standard', 'visibility': 'public'},
            ],
          });
        }
        if (path == '/accounts') return _json({'accounts': _accounts});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.endsWith('/read')) return _json(<String, Object?>{});
        if (path == '/channels/c1/messages') {
          final q = req.url.queryParameters;
          final limit = int.parse(q['limit'] ?? '200');
          final before = q['before'] == null ? null : int.parse(q['before']!);
          if (before != null) {
            final h = hold;
            if (h != null) await h.future;
            if (fail) return _json({'error': {'code': 'unavailable', 'message': 'down'}}, 503);
          }
          final pool = all.where((m) => before == null || (m['seq']! as int) < before).toList();
          final page = pool.length > limit ? pool.sublist(pool.length - limit) : pool;
          return _json({'messages': page, 'hasMore': page.isNotEmpty && (page.first['seq']! as int) > 1});
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

/// 긴 스레드 하나(답글 150, 원글은 어제)와 원글이 사라진 스레드 하나. 서버 #1048 과 같은 뜻으로 준다.
class _LongThreadServer {
  Completer<void>? hold;
  bool fail = false;

  static const me = '00000000-0000-4000-8000-000000000001';
  static const tm = '00000000-0000-4000-8000-000000000002';

  Map<String, Object?> _reply(int seq, String root, int minutesAgo) => {
        'id': '$root-r$seq',
        'seq': seq,
        'channelId': 'c1',
        'threadRootId': root,
        'authorId': seq.isEven ? me : tm,
        'body': '답글 ${seq - 1}',
        'kind': 'user',
        'createdAt': _ago(minutesAgo),
      };

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') return _json({'id': me, 'handle': 'me', 'displayName': 'me', 'isAdmin': true});
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'task', 'kind': 'standard', 'visibility': 'public'},
            ],
          });
        }
        if (path == '/accounts') return _json({'accounts': _accounts});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path.endsWith('/read')) return _json(<String, Object?>{});
        if (path.contains('/agent-models')) return _json({'agentModels': <Object?>[]});
        if (path == '/channels/c1/messages') {
          final q = req.url.queryParameters;
          final thread = q['thread'];
          if (thread == 'gone-root') {
            // 원글은 지워져 응답에 없고 채널 목록에도 없다.
            return _json({'messages': [_reply(900, 'gone-root', 30), _reply(901, 'gone-root', 20)], 'hasMore': false});
          }
          if (thread == 'lt-root') {
            final before = q['before'] == null ? null : int.parse(q['before']!);
            if (before != null) {
              final h = hold;
              if (h != null) await h.future;
              if (fail) return _json({'error': {'code': 'unavailable', 'message': 'down'}}, 503);
            }
            final limit = int.parse(q['limit'] ?? '100');
            final pool = [for (var s = 2; s <= 151; s++) if (before == null || s < before) s];
            final page = pool.length > limit ? pool.sublist(pool.length - limit) : pool;
            return _json({
              'messages': [
                if (before == null)
                  {
                    'id': 'lt-root', 'seq': 1, 'channelId': 'c1', 'threadRootId': null, 'authorId': me,
                    'body': '어제 연 긴 스레드', 'kind': 'user', 'replyCount': 150, 'createdAt': _ago(24 * 60),
                  },
                // 답글은 모두 오늘(최근 15분 안) — 원글(어제)과 날이 달라 구분 줄이 「답글 150개 · 오늘」.
                ...page.map((s) => _reply(s, 'lt-root', (151 - s) ~/ 10)),
              ],
              'hasMore': page.isNotEmpty && page.first > 2,
            });
          }
          return _json({'messages': <Object?>[], 'hasMore': false});
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

/// 갤러리용 푸시 표면 — 아직 묻지 않은 기기. OS 창은 띄우지 않는다.
class _GalleryPush implements PushPlatform {
  @override
  Future<PushPermission> status() async => PushPermission.notDetermined;
  @override
  Future<bool> request() async => false;
  @override
  Future<PushDeviceToken?> token() async => null;
  @override
  Future<Map<String, Object?>?> takeInitialOpen() async => null;
  @override
  Future<void> setBadge(int count) async {}
  @override
  Future<bool> wasPrompted() async => false;
  @override
  Future<void> markPrompted() async {}
  @override
  Future<void> openSettings() async {}
  @override
  void listen({required void Function(Map<String, Object?>) onOpen, required bool Function(Map<String, Object?>) shouldPresent}) {}
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/screens/search_screen.dart';
import 'package:harkroom/screens/tab_nav.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// iOS 상태 표시줄 탭 — 엔진이 보내는 `flutter/status_bar` 메시지를 그대로 흘려 넣는다.
/// 채널·스레드는 `reverse` 라 위쪽 끝이 큰 offset 이다(가장 오래된 말).

http.Response _json(Object body) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});

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

/// 오래된 줄이 훨씬 길어야 지연 목록의 끝 추정이 실제보다 짧아진다 — 그래야 첫 굴림이 끝에 못 미친다.
Map<String, Object?> _row(int seq, {String? root}) => {
      'id': root != null && seq == 1 ? root : 'm$seq',
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': root != null && seq > 1 ? root : null,
      'authorId': 'a1',
      'body': '말 $seq\n${'내용\n' * (seq < 30 ? 40 : 0)}',
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
    };

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      final q = req.url.queryParameters;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': 'me', 'isAdmin': false});
      if (path == '/channels') {
        return _json({
          'channels': [
            for (var i = 1; i <= 40; i++) {'id': 'c$i', 'name': 'ch$i', 'kind': 'standard'},
          ],
        });
      }
      if (path == '/channels/c1/messages') {
        return _json({
          'messages': [for (var s = 1; s <= 60; s++) _row(s, root: q['thread'])],
          'hasMore': false,
        });
      }
      if (path == '/search') {
        return _json({'messages': [for (var s = 1; s <= 40; s++) _row(s)], 'hasMore': false});
      }
      if (path == '/accounts') return _json({'accounts': <Object?>[]});
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      if (path.contains('/agent-models') || path.contains('/auto-mentions')) {
        return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
      }
      return _json({});
    });

Future<void> _pump(WidgetTester tester) async {
  tester.view.physicalSize = const Size(400, 700);
  tester.view.devicePixelRatio = 1;
  tester.view.padding = const FakeViewPadding(top: 40);
  addTearDown(tester.view.reset);
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
}

Future<void> _tapStatusBar(WidgetTester tester) async {
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    SystemChannels.statusBar.name,
    SystemChannels.statusBar.codec.encodeMethodCall(const MethodCall('handleScrollToTop')),
    (_) {},
  );
}

Future<void> _openFeed(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('channel-c1')));
  await tester.pumpAndSettle();
}

Future<void> _openThread(WidgetTester tester) async {
  unawaited(TabNavigators.active!
      .navigator(0)!
      .push(MaterialPageRoute<void>(builder: (_) => const ThreadScreen(channelId: 'c1', rootId: 'root'))));
  await tester.pumpAndSettle();
}

ScrollController _controller(WidgetTester tester, String key) =>
    tester.widget<ScrollView>(find.byKey(Key(key))).controller!;

void main() {
  final ios = TargetPlatformVariant.only(TargetPlatform.iOS);

  testWidgets('채널 피드: 맨 아래(최신)에서 탭하면 화면 위쪽 끝 = 가장 오래된 말로 간다', (tester) async {
    await _pump(tester);
    await _openFeed(tester);
    final c = _controller(tester, 'channel-feed');
    expect(c.offset, 0);
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(c.offset, greaterThan(0));
    expect(c.offset, c.position.maxScrollExtent, reason: '추정 끝이 늘어나도 닿을 때까지 굴린다');
    expect(find.textContaining('말 1\n', findRichText: true), findsWidgets, reason: '가장 오래된 말이 보인다');
  }, variant: ios);

  testWidgets('스레드: 맨 아래(최신)에서 탭하면 화면 위쪽 끝 = 원글 쪽으로 간다', (tester) async {
    await _pump(tester);
    await _openThread(tester);
    final c = _controller(tester, 'thread-feed');
    expect(c.offset, 0);
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(c.offset, greaterThan(0));
    expect(c.offset, c.position.maxScrollExtent);
  }, variant: ios);

  testWidgets('채널 목록: 내려 둔 데서 탭하면 맨 위로 — Scaffold 기본 처리와 겹치지 않는다', (tester) async {
    await _pump(tester);
    final c = TabNavigators.active!.scrolls[0];
    c.jumpTo(c.position.maxScrollExtent);
    await tester.pump();
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(c.offset, 0);
  }, variant: ios);

  testWidgets('DM·인박스·에이전트 뿌리 목록도 Scaffold 가 굴리는 손잡이를 집는다', (tester) async {
    await _pump(tester);
    for (final (i, key) in [(1, 'tab-dms'), (2, 'tab-inbox'), (3, 'tab-agents')]) {
      await tester.tap(find.byKey(Key(key)));
      await tester.pumpAndSettle();
      expect(TabNavigators.active!.scrolls[i].hasClients, isTrue, reason: key);
    }
  }, variant: ios);

  testWidgets('찾기 결과: 내려 둔 데서 탭하면 맨 위로', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('tab-search')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('search-input')), '말 찾기');
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.byType(SearchScreen), findsOneWidget);
    final c = _controller(tester, 'search-results');
    c.jumpTo(600);
    await tester.pump();
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(c.offset, 0);
  }, variant: ios);

  testWidgets('앞에 보이는 화면만 굴린다: 덮인 경로·숨은 탭의 피드는 그대로', (tester) async {
    await _pump(tester);
    await _openFeed(tester);
    final feed = _controller(tester, 'channel-feed');

    await _openThread(tester);
    final thread = _controller(tester, 'thread-feed');
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(thread.offset, greaterThan(0));
    expect(feed.offset, 0, reason: '스레드에 덮인 채널 피드');

    final before = thread.offset;
    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();
    thread.jumpTo(0);
    await tester.pump();
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(before, greaterThan(0));
    expect(thread.offset, 0, reason: '인박스 탭에 가려진 스레드');
  }, variant: ios);

  testWidgets('시트가 떠 있으면 뒤의 피드는 굴리지 않는다', (tester) async {
    await _pump(tester);
    await _openFeed(tester);
    final c = _controller(tester, 'channel-feed');
    unawaited(showModalBottomSheet<void>(
      context: tester.element(find.byKey(const Key('channel-feed'))),
      useRootNavigator: true,
      builder: (_) => const SizedBox(height: 200),
    ));
    await tester.pumpAndSettle();
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(c.offset, 0);
  }, variant: ios);

  testWidgets('끝 추정이 짧으면 첫 굴림 뒤로는 굴리지 않고 바로 옮긴다', (tester) async {
    await _pump(tester);
    await _openFeed(tester);
    final c = _controller(tester, 'channel-feed');
    final estimated = c.position.maxScrollExtent;
    await _tapStatusBar(tester);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1001));
    // 시간을 거의 안 흘린다 — 다시 굴리면 여기서 끝에 못 닿는다.
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 1));
    }
    expect(c.position.maxScrollExtent, isNot(estimated), reason: '첫 굴림이 끝에 못 미치는 데이터여야 한다');
    expect(c.offset, c.position.maxScrollExtent);
    expect(tester.binding.transientCallbackCount, 0, reason: '도는 굴림이 없다');
  }, variant: ios);

  for (final (name, features) in [
    ('reduceMotion(iOS 「동작 줄이기」)', const FakeAccessibilityFeatures(reduceMotion: true)),
    ('disableAnimations', const FakeAccessibilityFeatures(disableAnimations: true)),
  ]) {
    testWidgets('$name 이 켜져 있으면 처음부터 바로 옮긴다', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue = features;
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await _pump(tester);
      await _openFeed(tester);
      final c = _controller(tester, 'channel-feed');
      await _tapStatusBar(tester);
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 1));
      }
      expect(c.offset, greaterThan(0));
      expect(c.offset, c.position.maxScrollExtent);
    }, variant: ios);
  }

  testWidgets('탭 뿌리 목록: 「동작 줄이기」면 바로 맨 위로, 평소에는 Scaffold 의 굴림 그대로', (tester) async {
    await _pump(tester);
    final c = TabNavigators.active!.scrolls[0];
    final bottom = c.position.maxScrollExtent;
    c.jumpTo(bottom);
    await tester.pump();
    await _tapStatusBar(tester);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 16));
    expect(c.offset, allOf(greaterThan(0), lessThan(bottom)), reason: '꺼져 있으면 굴러가는 중이다');
    await tester.pumpAndSettle();
    expect(c.offset, 0);

    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    c.jumpTo(bottom);
    await tester.pump();
    await _tapStatusBar(tester);
    await tester.pump(const Duration(milliseconds: 1));
    expect(c.offset, 0);
    expect(tester.binding.transientCallbackCount, 0, reason: '도는 굴림이 없다');
  }, variant: ios);

  testWidgets('탭 뿌리 목록: 「동작 줄이기」여도 숨은 탭은 그대로', (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await _pump(tester);
    final c = TabNavigators.active!.scrolls[0];
    c.jumpTo(c.position.maxScrollExtent);
    await tester.pump();
    final held = c.offset;
    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();
    await _tapStatusBar(tester);
    await tester.pumpAndSettle();
    expect(c.offset, held);
  }, variant: ios);

  testWidgets('굴러가는 중에 손가락이 끼어들면 거기서 멈추고 되돌아 굴리지 않는다', (tester) async {
    await _pump(tester);
    await _openFeed(tester);
    final c = _controller(tester, 'channel-feed');
    await _tapStatusBar(tester);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    final g = await tester.startGesture(tester.getCenter(find.byKey(const Key('channel-feed'))));
    await tester.pump(const Duration(milliseconds: 50));
    final held = c.offset;
    await tester.pump(const Duration(seconds: 2));
    expect(c.offset, moreOrLessEquals(held, epsilon: 1));
    expect(c.offset, lessThan(c.position.maxScrollExtent));
    await g.up();
    await tester.pumpAndSettle();
  }, variant: ios);
}

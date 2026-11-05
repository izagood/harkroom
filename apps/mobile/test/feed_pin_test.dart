import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/feed_pin.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 맨 아래가 아닐 때 새 줄이 와도 보던 줄이 움직이지 않는다 — 채널·스레드.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, Object?> _row(int seq, {String? root, String author = 'a1'}) => {
      'id': root != null && seq == 1 ? root : 'm$seq',
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': root != null && seq > 1 ? root : null,
      'authorId': author,
      'body': '말 $seq',
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
    };

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      final q = req.url.queryParameters;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') {
        return _json({
          'channels': [
            {'id': 'c1', 'name': 'task', 'kind': 'standard'},
          ],
        });
      }
      if (path == '/channels/c1/messages' && req.method == 'POST') {
        final body = jsonDecode(req.body) as Map<String, Object?>;
        return _json({..._row(500, root: body['threadRootId'] as String?, author: 'me-1'), 'id': 'mine', 'body': body['body']});
      }
      if (path == '/channels/c1/messages') {
        return _json({
          'messages': [for (var s = 1; s <= 80; s++) _row(s, root: q['thread'])],
          'hasMore': false,
        });
      }
      if (path == '/accounts') return _json({'accounts': <Object?>[]});
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      if (path.contains('/agent-models') || path.contains('/auto-mentions')) {
        return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
      }
      return _json({});
    });

class _Case {
  const _Case(this.name, this.feedKey, this.pillKey, this.root);
  final String name;
  final String feedKey;
  final String pillKey;
  final String? root;
}

void main() {
  final ko = stringsFor('ko');
  final platforms = TargetPlatformVariant({TargetPlatform.android, TargetPlatform.iOS});

  for (final c in const [
    _Case('채널', 'channel-feed', 'channel-jump-pill', null),
    _Case('스레드', 'thread-feed', 'thread-jump-pill', 'root'),
  ]) {
    final pill = find.byKey(Key(c.pillKey));
    ScrollController feed(WidgetTester t) => t.widget<ScrollView>(find.byKey(Key(c.feedKey))).controller!;

    Future<AppState> open(WidgetTester tester) async {
      final app = (await tester.runAsync(() async {
        final a = AppState(
          sessions: SessionStore.inMemory(
            seed: jsonEncode({
              'active': 'me-1',
              'communities': [
                {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
              ],
            }),
          ),
          apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: _server()),
          connector: (_) async => throw StateError('소켓 없음'),
        );
        await a.boot();
        await a.openChannel('c1');
        return a;
      }))!;
      addTearDown(app.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        builder: (context, child) => I18n(strings: ko, child: AppScope(state: app, child: child!)),
        home: c.root == null ? const MessageListScreen(channelId: 'c1') : const ThreadScreen(channelId: 'c1', rootId: 'root'),
      ));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      return app;
    }

    void arrive(AppState app, int seq, {String author = 'a2'}) => app.applyEvent({
          'type': 'message.created',
          'message': {
            ..._row(seq, root: c.root, author: author),
            'id': 'n$seq',
            'body': '새 $seq',
            if (c.root != null) 'threadRootId': c.root,
          },
        });

    double yOf(WidgetTester t, String text) => t.getTopLeft(find.textContaining(text, findRichText: true).first).dy;

    testWidgets('${c.name}: 위로 올라가 있으면 새 줄이 와도 보던 줄이 그대로이고, 알약 숫자만 는다', (tester) async {
      final app = await open(tester);
      final s = feed(tester);
      s.jumpTo(s.position.viewportDimension * 1.5);
      await tester.pump();
      // 화면 가운데쯤 보이는 줄을 하나 잡는다.
      final height = tester.getSize(find.byKey(Key(c.feedKey))).height;
      final label = [
        for (var seq = 10; seq <= 80; seq++)
          if (find.textContaining('말 $seq', findRichText: true).evaluate().isNotEmpty) '말 $seq',
      ].firstWhere((l) => (yOf(tester, l) - height / 2).abs() < height / 4);
      final before = yOf(tester, label);
      final offsetBefore = s.offset;

      for (var i = 0; i < 30; i++) {
        arrive(app, 81 + i);
      }
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(yOf(tester, label), before, reason: '보던 줄');
      expect(s.offset, offsetBefore);
      expect(find.text((c.root == null ? ko.channelJumpNew : ko.threadJumpNew).replaceFirst('{n}', '30')), findsOneWidget);
      expect(s.position.minScrollExtent, lessThan(0), reason: '새 줄은 기준 아래에 있다');
    }, variant: platforms);

    testWidgets('${c.name}: 맨 아래에서는 새 줄을 그대로 따라간다', (tester) async {
      final app = await open(tester);
      arrive(app, 81);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      final s = feed(tester);
      expect(s.position.minScrollExtent, 0);
      expect(s.offset, 0);
      expect(find.textContaining('새 81', findRichText: true), findsOneWidget);
      expect(pill, findsNothing);
    }, variant: platforms);

    testWidgets('${c.name}: 알약을 누르면 새 줄까지 내려가고, 한 조각으로 합쳐져 offset 0 으로 돌아온다', (tester) async {
      final app = await open(tester);
      final s = feed(tester);
      s.jumpTo(s.position.viewportDimension * 1.5);
      await tester.pump();
      for (var i = 0; i < 30; i++) {
        arrive(app, 81 + i);
      }
      await tester.pump();
      await tester.tap(pill);
      await tester.pumpAndSettle();
      await tester.pump();
      expect(find.textContaining('새 110', findRichText: true), findsOneWidget);
      expect(s.position.minScrollExtent, 0);
      expect(s.offset, 0);
      expect(pill, findsNothing);
      // 합친 뒤에 오는 줄은 다시 따라간다.
      arrive(app, 111);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(s.offset, 0);
      expect(find.textContaining('새 111', findRichText: true), findsOneWidget);
    }, variant: platforms);

    testWidgets('${c.name}: 손으로 내리면 새 줄을 차례로 지나가고, 맨 아래에서 멎어야 합친다', (tester) async {
      final app = await open(tester);
      final s = feed(tester);
      s.jumpTo(s.position.viewportDimension * 1.5);
      await tester.pump();
      for (var i = 0; i < 5; i++) {
        arrive(app, 81 + i);
      }
      await tester.pump();
      s.jumpTo(s.position.minScrollExtent + s.position.viewportDimension * 0.5);
      await tester.pump();
      expect(s.position.minScrollExtent, lessThan(0));
      final g = await tester.startGesture(tester.getCenter(find.byKey(Key(c.feedKey))));
      await g.moveBy(const Offset(0, -40)); // 끌기로 인정받는 몫
      await tester.pump();
      await g.moveBy(Offset(0, -s.position.viewportDimension));
      await tester.pump();
      expect(s.offset, lessThanOrEqualTo(s.position.minScrollExtent + 1), reason: '기준 아래 끝까지 내려왔다(iOS 는 더 튕긴다)');
      expect(s.position.minScrollExtent, lessThan(0), reason: '손을 떼기 전에는 합치지 않는다');
      await g.up();
      await tester.pumpAndSettle();
      expect(s.offset, moreOrLessEquals(s.position.minScrollExtent, epsilon: 1));
      expect(find.textContaining('새 85', findRichText: true), findsOneWidget);
    }, variant: platforms);

    testWidgets('${c.name}: 틈이 보이면 맨 아래에서도 합치지 않아 틈 위아래 줄이 움직이지 않고, 새 줄을 따라간다', (tester) async {
      final app = await open(tester);
      final s = feed(tester);
      s.jumpTo(s.position.viewportDimension * 1.5);
      await tester.pump();
      for (var i = 0; i < 3; i++) {
        arrive(app, 81 + i);
      }
      await tester.pump();
      s.jumpTo(s.position.minScrollExtent);
      await tester.pump();
      s.jumpTo(s.position.minScrollExtent);
      await tester.pump();
      expect(find.byKey(const Key('feed-new-divider-line')), findsWidgets, reason: '갈라진 동안 구분선');
      final aboveGap = yOf(tester, '말 80');
      final belowGap = yOf(tester, '새 83');
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 1));
      expect(yOf(tester, '말 80'), aboveGap, reason: '틈 위쪽 줄');
      expect(yOf(tester, '새 83'), belowGap, reason: '틈 아래쪽 줄');
      expect(s.position.minScrollExtent, lessThan(0), reason: '틈이 보이는 동안은 갈라져 있다');
      expect(pill, findsNothing);

      arrive(app, 84);
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(s.offset, s.position.minScrollExtent, reason: '갈라진 채로도 새 줄을 따라간다');
      expect(find.textContaining('새 84', findRichText: true), findsOneWidget);
      expect(pill, findsNothing);
      // 맨 아래에서 본 줄은 새 것이 아니다.
      s.jumpTo(s.position.minScrollExtent + s.position.viewportDimension * 1.5);
      await tester.pump();
      expect(find.text(c.root == null ? ko.channelJumpLatest : ko.threadJumpLatest), findsOneWidget);
    }, variant: platforms);

    testWidgets('${c.name}: 새 줄이 쌓여 틈이 화면 위로 사라지면 합쳐 offset 0 으로 돌아오고, 보이는 줄은 그대로다', (tester) async {
      final app = await open(tester);
      final s = feed(tester);
      s.jumpTo(s.position.viewportDimension * 1.5);
      await tester.pump();
      for (var i = 0; i < 3; i++) {
        arrive(app, 81 + i);
      }
      await tester.pump();
      s.jumpTo(s.position.minScrollExtent);
      await tester.pumpAndSettle();
      expect(s.position.minScrollExtent, lessThan(0));
      for (var i = 0; i < 40; i++) {
        arrive(app, 84 + i);
        await tester.pump();
        await tester.pump();
        await tester.pump();
      }
      expect(s.position.minScrollExtent, 0, reason: '합쳐졌다');
      expect(s.offset, moreOrLessEquals(0, epsilon: 1));
      expect(find.textContaining('새 123', findRichText: true), findsOneWidget);
      expect(find.byKey(const Key('feed-new-divider-line')), findsNothing);
      // 합친 뒤에는 한 조각으로 따라간다.
      arrive(app, 124);
      await tester.pump();
      await tester.pump();
      expect(s.offset, 0);
      expect(s.position.minScrollExtent, 0);
    }, variant: platforms);

    testWidgets('${c.name}: 합치는 순간 보이는 줄이 움직이지 않는다', (tester) async {
      final app = await open(tester);
      final s = feed(tester);
      s.jumpTo(s.position.viewportDimension * 1.5);
      await tester.pump();
      for (var i = 0; i < 40; i++) {
        arrive(app, 81 + i);
      }
      await tester.pump();
      // 합치지 않을 거리(맨 아래 근처 밖)에서 끝 추정을 먼저 고친다.
      for (var i = 0; i < 6; i++) {
        s.jumpTo(s.position.minScrollExtent + 100);
        await tester.pump();
      }
      s.jumpTo(s.position.minScrollExtent + 30);
      await tester.pump();
      final before = yOf(tester, '새 120');
      expect(s.position.minScrollExtent, lessThan(0), reason: '아직 합친 배치가 아니다');
      await tester.pumpAndSettle();
      expect(s.position.minScrollExtent, 0, reason: '합쳐졌다');
      expect(s.offset, moreOrLessEquals(30));
      expect(yOf(tester, '새 120'), moreOrLessEquals(before));
    }, variant: platforms);

    testWidgets('${c.name}: 올라간 채 내 글을 보내면 맨 아래로 가서 보인다', (tester) async {
      await open(tester);
      final s = feed(tester);
      s.jumpTo(s.position.viewportDimension * 1.5);
      await tester.pump();
      await tester.enterText(find.byKey(Key(c.root == null ? 'composer' : 'thread-composer')), '내 글');
      await tester.pump();
      await tester.tap(find.byKey(Key(c.root == null ? 'composer-send' : 'thread-send')));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pumpAndSettle();
      expect(s.offset, moreOrLessEquals(s.position.minScrollExtent, epsilon: 1));
      expect(find.textContaining('내 글', findRichText: true), findsWidgets);
      expect(pill, findsNothing);
    }, variant: platforms);
  }

  group('구분선', () {
    Future<void> pumpView(WidgetTester tester, {required double gap, required bool split}) async {
      final c = ScrollController();
      addTearDown(c.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        home: Scaffold(
          body: feedScrollView(
            key: const Key('feed'),
            controller: c,
            padding: EdgeInsets.only(top: 8, bottom: gap),
            dividerLabel: '새 답글',
            older: SliverList.list(children: const [SizedBox(height: 40, child: Text('옛 줄'))]),
            below: split ? SliverList.list(children: const [SizedBox(height: 40, child: Text('새 줄'))]) : null,
          ),
        ),
      ));
    }

    testWidgets('틈이 넓으면(계획판 버튼 스레드) 글자를 넣고, 틈 높이는 그대로다', (tester) async {
      await pumpView(tester, gap: 64, split: true);
      expect(find.text('새 답글'), findsOneWidget);
      expect(find.byKey(const Key('feed-new-divider-line')), findsNWidgets(2));
      final handle = tester.ensureSemantics();
      expect(find.bySemanticsLabel('새 답글'), findsOneWidget, reason: '글자와 이름이 두 번 읽히지 않는다');
      handle.dispose();
      expect(tester.getSize(find.byKey(feedGapKey)).height, 64);
      expect(tester.takeException(), isNull);
    });

    testWidgets('틈이 좁으면(채널 8px) 선만 긋는다', (tester) async {
      await pumpView(tester, gap: 8, split: true);
      expect(find.text('새 답글'), findsNothing);
      expect(find.byKey(const Key('feed-new-divider-line')), findsOneWidget);
      final handle = tester.ensureSemantics();
      expect(find.bySemanticsLabel('새 답글'), findsOneWidget, reason: '선만 있어도 읽기 도구에는 이름이 있다');
      handle.dispose();
      expect(tester.getSize(find.byKey(feedGapKey)).height, 8);
    });

    testWidgets('갈라지지 않았으면 선이 없고 틈은 그대로 빈 여백이다', (tester) async {
      await pumpView(tester, gap: 64, split: false);
      expect(find.byKey(const Key('feed-new-divider-line')), findsNothing);
      expect(tester.getSize(find.byKey(feedGapKey)).height, 64);
    });
  });
}

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 채널 「↓ 최신 메시지」 알약 — 스레드 알약(`thread_jump_pill_test.dart`)과 같은 규칙이다.

http.Response _json(Object body) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});

Map<String, Object?> _row(int seq) => {
      'id': 'm$seq',
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': null,
      'authorId': 'a1',
      'body': '말 $seq',
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
    };

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') {
        return _json({
          'channels': [
            {'id': 'c1', 'name': 'task', 'kind': 'standard'},
          ],
        });
      }
      if (path == '/channels/c1/messages') {
        return _json({
          'messages': [for (var s = 1; s <= 80; s++) _row(s)],
          'hasMore': false,
        });
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

void main() {
  final ko = stringsFor('ko');
  final pill = find.byKey(const Key('channel-jump-pill'));
  ScrollController feed(WidgetTester tester) =>
      tester.widget<ListView>(find.byKey(const Key('channel-feed'))).controller!;

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
      home: const MessageListScreen(channelId: 'c1'),
    ));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.channelLoad['c1'], LoadState.loaded);
    return app;
  }

  void message(AppState app, int seq, {String author = 'a2', String? root, String kind = 'user'}) => app.applyEvent({
        'type': 'message.created',
        'message': {'id': 'n$seq', 'seq': seq, 'channelId': 'c1', 'threadRootId': root, 'authorId': author, 'body': '새 $seq', 'kind': kind},
      });

  testWidgets('맨 아래에서는 알약이 없다 — 새 말이 와도 그대로', (tester) async {
    final app = await open(tester);
    expect(pill, findsNothing);
    message(app, 81);
    await tester.pump();
    expect(pill, findsNothing);
  });

  testWidgets('한 화면보다 위로 굴리면 「최신 메시지」 알약이 뜬다 — 모양은 스레드 알약과 같다', (tester) async {
    await open(tester);
    final c = feed(tester);
    final viewport = c.position.viewportDimension;
    c.jumpTo(viewport * 0.5);
    await tester.pump();
    expect(pill, findsNothing);
    c.jumpTo(viewport * 1.5);
    await tester.pump();
    expect(pill, findsOneWidget);
    expect(find.text(ko.channelJumpLatest), findsOneWidget);
    expect(tester.getSemantics(pill).label, ko.channelJumpA11y);
    expect(tester.getSize(pill).height, 44);
    // 작성칸 위 오른쪽.
    expect(tester.getBottomRight(pill).dx, tester.getSize(find.byType(MessageListScreen)).width - 16);
    expect(tester.getBottomRight(pill).dy, lessThan(tester.getTopLeft(find.byKey(const Key('composer'))).dy));
  });

  testWidgets('위로 굴린 동안 남의 말이 오면 「새 메시지 n」 — 내 말·진행 줄·채널에 안 오른 답글은 세지 않는다', (tester) async {
    final app = await open(tester);
    final c = feed(tester);
    c.jumpTo(c.position.viewportDimension * 0.5);
    await tester.pump();
    expect(pill, findsNothing);
    message(app, 81);
    await tester.pump();
    expect(find.text(ko.channelJumpNew.replaceFirst('{n}', '1')), findsOneWidget);
    message(app, 82, author: 'me-1');
    message(app, 83, kind: 'progress');
    message(app, 84, root: 'm1');
    message(app, 85);
    await tester.pump();
    expect(find.text(ko.channelJumpNew.replaceFirst('{n}', '2')), findsOneWidget);
    expect(tester.getSemantics(pill).label, ko.channelJumpA11yNew.replaceFirst('{n}', '2'));
  });

  testWidgets('알약을 누르면 맨 아래로 굴러가 걷히고, 수는 0 으로 돌아간다', (tester) async {
    final app = await open(tester);
    final c = feed(tester);
    c.jumpTo(c.position.viewportDimension * 1.5);
    await tester.pump();
    message(app, 81);
    await tester.pump();
    await tester.tap(pill);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(c.position.pixels, 0);
    expect(pill, findsNothing);
    c.jumpTo(c.position.viewportDimension * 1.5);
    await tester.pump();
    expect(find.text(ko.channelJumpLatest), findsOneWidget, reason: '본 말은 새 것이 아니다');
  });

  testWidgets('멀리(세 화면 넘게) 올라갔어도 누르면 맨 아래에 닿는다', (tester) async {
    await open(tester);
    final c = feed(tester);
    c.jumpTo((c.position.viewportDimension * 4).clamp(0, c.position.maxScrollExtent));
    await tester.pump();
    await tester.tap(pill);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(c.position.pixels, 0);
    expect(pill, findsNothing);
  });

  test('문구: 영어도 있고 99 를 넘으면 99+', () {
    expect(jumpPillLabel(ko, 0, channel: true), '최신 메시지');
    expect(jumpPillLabel(ko, 3, channel: true), '새 메시지 3');
    expect(jumpPillLabel(ko, 100, channel: true), '새 메시지 99+');
    expect(jumpPillLabel(stringsFor('en'), 0, channel: true), 'Latest messages');
    expect(jumpPillLabel(stringsFor('en'), 2, channel: true), 'New messages · 2');
  });
}

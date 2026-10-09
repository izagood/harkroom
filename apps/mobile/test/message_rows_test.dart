import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_feed.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';

/// S3: 메시지 줄. 아바타·이름·시각 → 본문 → 카드, 5분 안 이어 말하기 묶기, 날짜 줄, 멘션 거절 줄.

final _t0 = DateTime.utc(2026, 9, 28, 3);

MessageRow _m(String id, int seq, {String author = 'a1', Duration at = Duration.zero,
        String body = '말', Map<String, Object?> meta = const {}, String kind = 'user', String? threadRoot}) =>
    MessageRow.fromJson({
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': threadRoot,
      'authorId': author,
      'body': body,
      'kind': kind,
      'meta': meta,
      'createdAt': _t0.add(at).toIso8601String(),
    });

void main() {
  group('묶기', () {
    test('같은 사람이 5분 안에 이어 말하면 묶는다', () {
      final feed = buildFeed([
        _m('1', 1),
        _m('2', 2, at: const Duration(minutes: 2)),
      ]).cast<FeedMessage>();
      expect(feed.map((f) => f.continued), [false, true]);
    });

    test('5분이 지나거나 사람이 바뀌면 끊는다', () {
      final feed = buildFeed([
        _m('1', 1),
        _m('2', 2, at: const Duration(minutes: 6)),
        _m('3', 3, author: 'a2', at: const Duration(minutes: 7)),
      ]).cast<FeedMessage>();
      expect(feed.map((f) => f.continued), [false, false, false]);
    });

    test('카드 메시지(ask 등)는 묶지 않는다 — 누가 묻는지가 그 줄에 있어야 한다', () {
      final feed = buildFeed([
        _m('1', 1),
        _m('2', 2, at: const Duration(minutes: 1), meta: {
          'kind': 'ask',
          'ask': {
            'options': [
              {'id': 'a', 'label': 'A'},
              {'id': 'b', 'label': 'B'},
            ],
          },
        }),
      ]).cast<FeedMessage>();
      expect(feed[1].continued, isFalse);
    });

    test('사이에 진행 줄이 끼면 끊는다', () {
      final feed = buildFeed([
        _m('1', 1),
        _m('p', 2, kind: 'progress', at: const Duration(minutes: 1)),
        _m('2', 3, at: const Duration(minutes: 2)),
      ]);
      expect((feed.last as FeedMessage).continued, isFalse);
    });

    test('날짜가 바뀌면 날짜 줄을 넣고 묶지 않는다', () {
      final late = DateTime(2026, 9, 28, 23, 58).toUtc();
      MessageRow at(String id, int seq, DateTime when) => MessageRow.fromJson({
            'id': id,
            'seq': seq,
            'channelId': 'c1',
            'authorId': 'a1',
            'body': '말',
            'kind': 'user',
            'createdAt': when.toIso8601String(),
          });
      final feed = buildFeed([
        at('1', 1, late),
        at('2', 2, late.add(const Duration(minutes: 3))),
      ]).cast<FeedMessage>();
      expect(feed[1].dayBreak, isTrue);
      expect(feed[1].continued, isFalse);
      // 불러온 첫 줄 위에도 날짜가 선다(designer #980).
      expect(feed[0].dayBreak, isTrue);
    });
  });

  group('줄', () {
    late AppState app;
    setUp(() {
      app = AppState(sessions: SessionStore.inMemory());
      app.accounts['a1'] = const AccountView(
        id: 'a1',
        handle: 'task_manager',
        displayName: 'task_manager',
        isAgent: true,
        isDisabled: false,
        avatarAttachmentId: null,
      );
    });

    Future<void> pump(WidgetTester tester, MessageRow m) => tester.pumpWidget(MaterialApp(
          theme: harkroomTheme(Brightness.light),
          home: I18n(
            strings: stringsFor('ko'),
            child: AppScope(
              state: app,
              child: Scaffold(body: Builder(builder: (c) => buildFeedItem(c, FeedMessage(m)))),
            ),
          ),
        ));

    testWidgets('이름·시각 → 본문 순서로 그린다', (tester) async {
      await pump(tester, _m('1', 1, body: '모바일 다음 작업 순서를 골라 달라.'));
      expect(find.text('task_manager'), findsOneWidget);
      expect(find.byKey(const Key('time-1')), findsOneWidget);
      expect(find.text('모바일 다음 작업 순서를 골라 달라.'), findsOneWidget);
    });

    testWidgets('ask 카드는 본문을 지우지 않고 그 아래 덧붙는다', (tester) async {
      await pump(
          tester,
          _m('1', 1, body: '모바일 다음 작업 순서를 골라 달라.', meta: {
            'kind': 'ask',
            'ask': {
              'options': [
                {'id': 'a', 'label': '멘션 거절 먼저'},
                {'id': 'b', 'label': 'TestFlight 먼저'},
              ],
            },
          }));
      // 전에는 카드가 줄을 대신해서 무엇을 묻는지와 누가 묻는지가 화면에 없었다.
      expect(find.text('모바일 다음 작업 순서를 골라 달라.'), findsOneWidget);
      expect(find.text('task_manager'), findsOneWidget);
      expect(find.byKey(const Key('ask-option-1-a')), findsOneWidget);
    });

    testWidgets('멘션이 거절되면 노란 줄이 선다', (tester) async {
      await pump(
          tester,
          _m('1', 1, body: '@harkroom 에게 넘겼다', meta: {
            'mentionDenied': ['harkroom'],
          }));
      expect(find.byKey(const Key('mention-denied')), findsOneWidget);
      expect(find.textContaining('@harkroom 를 부르지 않았다'), findsOneWidget);
    });

    testWidgets('거절이 없으면 줄도 없다', (tester) async {
      await pump(tester, _m('1', 1));
      expect(find.byKey(const Key('mention-denied')), findsNothing);
    });

    testWidgets('스레드 요약 줄: 참여자 아바타(최대 3) · 답글 n개 · 마지막 답글 시각 (S4e)', (tester) async {
      final root = MessageRow.fromJson({
        'id': 'r', 'seq': 1, 'channelId': 'c1', 'authorId': 'a1', 'body': '원글', 'kind': 'user',
        'createdAt': _t0.toIso8601String(), 'replyCount': 14,
        'participantIds': ['a1', 'a2', 'a3', 'a4'],
        'lastReplyAt': DateTime.now().toUtc().subtract(const Duration(minutes: 2)).toIso8601String(),
      });
      var opened = 0;
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        home: I18n(
          strings: stringsFor('ko'),
          child: AppScope(
            state: app,
            child: Scaffold(
              body: Builder(builder: (c) => buildFeedItem(c, FeedMessage(root), onOpenThread: (_) => opened++)),
            ),
          ),
        ),
      ));
      for (final id in ['a1', 'a2', 'a3']) {
        expect(find.byKey(Key('thread-participant-r-$id')), findsOneWidget);
      }
      expect(find.byKey(const Key('thread-participant-r-a4')), findsNothing);
      expect(find.textContaining('답글 14개'), findsOneWidget);
      expect(find.textContaining('2분 전'), findsOneWidget);
      await tester.tap(find.byKey(const Key('thread-open-r')));
      expect(opened, 1);
    });

    testWidgets('옛 서버(participantIds 없음)는 아바타 없이 「답글 n개」만', (tester) async {
      final root = MessageRow.fromJson({
        'id': 'r', 'seq': 1, 'channelId': 'c1', 'authorId': 'a1', 'body': '원글', 'kind': 'user',
        'createdAt': _t0.toIso8601String(), 'replyCount': 2,
      });
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        home: I18n(
          strings: stringsFor('ko'),
          child: AppScope(
            state: app,
            child: Scaffold(body: Builder(builder: (c) => buildFeedItem(c, FeedMessage(root), onOpenThread: (_) {}))),
          ),
        ),
      ));
      expect(find.byWidgetPredicate((w) => w.key is ValueKey && '${(w.key! as ValueKey).value}'.startsWith('thread-participant-')), findsNothing);
      expect(find.text('답글 2개'), findsOneWidget);
    });

    testWidgets('리액션 줄 끝의 「이모지 달기」가 고르는 시트를 연다 (S4e)', (tester) async {
      final m = MessageRow.fromJson({
        'id': 'x', 'seq': 1, 'channelId': 'c1', 'authorId': 'a1', 'body': '말', 'kind': 'user',
        'createdAt': _t0.toIso8601String(),
        'reactions': [
          {'emoji': '👀', 'accountIds': ['a1']},
        ],
      });
      await pump(tester, m);
      expect(find.byKey(const Key('reaction-add-x')), findsOneWidget);
      await tester.tap(find.byKey(const Key('reaction-add-x')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('reaction-pick-👍')), findsOneWidget);
      expect(find.byKey(const Key('reaction-pick-✅')), findsOneWidget);
    });

    // A′(2026-10-09): 글로 답한 카드는 「글로 답했다 · 이름」 + 인용 한 줄 + 「그래도 고르기」로 접힌다.
    testWidgets('글로 답해 닫힌 카드는 인용 한 줄과 그래도 고르기를 그린다', (tester) async {
      app.accounts['h1'] = const AccountView(
        id: 'h1', handle: 'jaebin', displayName: 'jaebin', isAgent: false, isDisabled: false, avatarAttachmentId: null,
      );
      // 다른 스레드의 같은 id 글은 인용하지 않는다 — 같은 스레드 글만(#1259 security).
      app.messages['c1'] = [_m('r1', 2, author: 'h1', body: '이건 다르게 해 줘\n둘째 줄', threadRoot: '1')];
      await pump(
          tester,
          _m('1', 1, body: '골라 달라.', meta: {
            'kind': 'ask',
            'ask': {
              'options': [
                {'id': 'a', 'label': '이걸로'},
                {'id': 'b', 'label': '저걸로'},
              ],
              'to': {'kind': 'human'},
              'closedAt': '2026-10-09T11:00:00Z',
              'closedBy': 'h1',
              'closedReason': 'replied',
              'replyMessageId': 'r1',
            },
          }));
      expect(find.text('글로 답했다 · jaebin'), findsOneWidget);
      expect(find.text('이건 다르게 해 줘'), findsOneWidget);
      expect(find.text('—'), findsNothing);
      expect(find.byKey(const Key('ask-option-1-a')), findsNothing);
      await tester.tap(find.byKey(const Key('ask-pick-anyway-1')));
      await tester.pump();
      expect(find.byKey(const Key('ask-option-1-a')), findsOneWidget);
    });

    testWidgets('다른 스레드의 글은 인용하지 않는다', (tester) async {
      app.messages['c1'] = [_m('r1', 2, author: 'h1', body: '남의 스레드 글', threadRoot: 'other')];
      await pump(
          tester,
          _m('1', 1, body: '골라 달라.', meta: {
            'kind': 'ask',
            'ask': {
              'options': [
                {'id': 'a', 'label': '이걸로'},
                {'id': 'b', 'label': '저걸로'},
              ],
              'to': {'kind': 'human'},
              'closedAt': '2026-10-09T11:00:00Z',
              'closedBy': 'h1',
              'closedReason': 'replied',
              'replyMessageId': 'r1',
            },
          }));
      expect(find.text('남의 스레드 글'), findsNothing);
      expect(find.byKey(const Key('ask-reply-quote-1')), findsNothing);
    });

    testWidgets('새 카드로 대신된 카드는 한 줄로 접힌다', (tester) async {
      await pump(
          tester,
          _m('1', 1, body: '골라 달라.', meta: {
            'kind': 'ask',
            'ask': {
              'prompt': '어느 쪽?',
              'options': [
                {'id': 'a', 'label': '이걸로'},
                {'id': 'b', 'label': '저걸로'},
              ],
              'to': {'kind': 'human'},
              'closedAt': '2026-10-09T11:00:00Z',
              'closedReason': 'superseded',
              'supersededBy': 'm9',
            },
          }));
      expect(find.text('새 질문으로 바뀜'), findsOneWidget);
      expect(find.text('어느 쪽?'), findsNothing);
      expect(find.text('—'), findsNothing);
      expect(find.byKey(const Key('ask-pick-anyway-1')), findsNothing);
      expect(find.byKey(const Key('ask-option-1-a')), findsNothing);
    });
  });
}

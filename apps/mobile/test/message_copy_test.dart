import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/mention/render.dart';
import 'package:harkroom/screens/message_feed.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/message_tile.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:harkroom/ui/parts.dart';

/// 메시지 길게 누르기 → 링크 복사 · 본문 복사.

const _a1 = '11111111-1111-1111-1111-111111111111';
const _gone = '99999999-9999-9999-9999-999999999999';
const _team = 'team:22222222-2222-2222-2222-222222222222';

MessageRow _m(String id,
        {String body = '말',
        String? threadRootId,
        List<Map<String, Object?>> attachments = const [],
        List<Map<String, Object?>> reactions = const []}) =>
    MessageRow.fromJson({
      'id': id,
      'seq': 1,
      'channelId': 'c1',
      'threadRootId': threadRootId,
      'authorId': _a1,
      'body': body,
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 2).toIso8601String(),
      'attachments': attachments,
      'reactions': reactions,
    });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('bodyAsHandles', () {
    final accounts = {
      _a1: const AccountView(
          id: _a1, handle: 'jaebin', displayName: 'jaebin', isAgent: false, isDisabled: false, avatarAttachmentId: null),
    };
    test('아는 계정은 @handle, 모르는 계정·팀 토큰은 그대로 둔다', () {
      expect(bodyAsHandles('<@$_a1> 봐 <@$_gone> <@$_team>', accounts), '@jaebin 봐 <@$_gone> <@$_team>');
    });
    test('마크다운 원문은 건드리지 않는다', () {
      const md = '**굵게** [링크](harkroom://message/x)\n```\ncode\n```';
      expect(bodyAsHandles(md, accounts), md);
    });
  });

  group('길게 누르기', () {
    late AppState app;
    late List<String> copied;
    setUp(() {
      app = AppState(sessions: SessionStore.inMemory());
      app.accounts[_a1] = const AccountView(
          id: _a1, handle: 'jaebin', displayName: 'jaebin', isAgent: false, isDisabled: false, avatarAttachmentId: null);
      copied = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
    });
    tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));

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

    Future<void> open(WidgetTester tester, String id) async {
      await tester.longPress(find.byKey(Key('message-press-$id')));
      await tester.pumpAndSettle();
    }

    testWidgets('링크 복사 → harkroom://message/<id> 와 짧은 확인', (tester) async {
      await pump(tester, _m('m1'));
      await open(tester, 'm1');
      await tester.tap(find.byKey(const Key('message-action-copy-link')));
      await tester.pump();
      await tester.pump();
      expect(copied, ['harkroom://message/m1']);
      expect(find.text('링크를 복사했다'), findsOneWidget);
    });

    testWidgets('스레드 답글도 그 답글 자신의 id 로 복사한다', (tester) async {
      await pump(tester, _m('r1', threadRootId: 'root'));
      await open(tester, 'r1');
      await tester.tap(find.byKey(const Key('message-action-copy-link')));
      await tester.pump();
      expect(copied, ['harkroom://message/r1']);
    });

    testWidgets('본문 복사 → 마크다운 원문, 멘션은 @handle', (tester) async {
      await pump(tester, _m('m2', body: '<@$_a1> **확인** `x`'));
      await open(tester, 'm2');
      await tester.tap(find.byKey(const Key('message-action-copy-body')));
      await tester.pump();
      await tester.pump();
      expect(copied, ['@jaebin **확인** `x`']);
      expect(find.text('본문을 복사했다'), findsOneWidget);
    });

    testWidgets('본문이 비면 본문 복사 줄이 없다', (tester) async {
      await pump(tester, _m('m3', body: '  '));
      await open(tester, 'm3');
      expect(find.byKey(const Key('message-action-copy-link')), findsOneWidget);
      expect(find.byKey(const Key('message-action-copy-body')), findsNothing);
    });

    testWidgets('클립보드가 실패하면 실패 토스트', (tester) async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') throw PlatformException(code: 'x');
        return null;
      });
      await pump(tester, _m('m4'));
      await open(tester, 'm4');
      await tester.tap(find.byKey(const Key('message-action-copy-link')));
      await tester.pump();
      await tester.pump();
      expect(find.text('복사하지 못했다'), findsOneWidget);
      expect(find.text('링크를 복사했다'), findsNothing);
    });
  });

  group('기능 바 1단계', () {
    late AppState app;
    setUp(() {
      app = AppState(sessions: SessionStore.inMemory());
      app.accounts[_a1] = const AccountView(
          id: _a1, handle: 'jaebin', displayName: 'jaebin', isAgent: false, isDisabled: false, avatarAttachmentId: null);
    });

    Future<void> pump(WidgetTester tester, MessageRow m,
            {void Function(MessageRow)? open, void Function(MessageRow)? reply}) =>
        tester.pumpWidget(MaterialApp(
          theme: harkroomTheme(Brightness.light),
          home: I18n(
            strings: stringsFor('ko'),
            child: AppScope(
              state: app,
              child: Scaffold(
                body: Builder(
                    builder: (c) => buildFeedItem(c, FeedMessage(m), onOpenThread: open, onReplyInThread: reply)),
              ),
            ),
          ),
        ));

    testWidgets('채널에서 줄을 탭하면 스레드가 열린다(답글 없는 글도)', (tester) async {
      final opened = <String>[];
      await pump(tester, _m('t1'), open: (m) => opened.add(m.id));
      await tester.tap(find.byKey(const Key('message-press-t1')));
      expect(opened, ['t1']);
    });

    testWidgets('스레드 화면 안(onOpenThread 없음)에서는 탭해도 아무 일 없고 시트에 답글 줄이 없다', (tester) async {
      await pump(tester, _m('t2'));
      await tester.tap(find.byKey(const Key('message-press-t2')));
      await tester.longPress(find.byKey(const Key('message-press-t2')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-action-reply')), findsNothing);
      expect(find.byKey(const Key('message-action-copy-link')), findsOneWidget);
    });

    testWidgets('시트: 리액션 줄이 맨 위, 「스레드에서 답글」은 최상위 글에만', (tester) async {
      final replied = <String>[];
      await pump(tester, _m('t3'), open: (_) {}, reply: (m) => replied.add(m.id));
      await tester.longPress(find.byKey(const Key('message-press-t3')));
      await tester.pumpAndSettle();
      for (final e in quickReactions) {
        expect(find.byKey(Key('message-action-react-$e')), findsOneWidget);
      }
      final reactY = tester.getTopLeft(find.byKey(const Key('message-action-react-👍'))).dy;
      final replyY = tester.getTopLeft(find.byKey(const Key('message-action-reply'))).dy;
      final linkY = tester.getTopLeft(find.byKey(const Key('message-action-copy-link'))).dy;
      expect(reactY < replyY && replyY < linkY, isTrue);
      await tester.tap(find.byKey(const Key('message-action-reply')));
      await tester.pumpAndSettle();
      expect(replied, ['t3']);
    });

    testWidgets('답글(threadRootId 있음)에는 「스레드에서 답글」이 없다', (tester) async {
      await pump(tester, _m('t4', threadRootId: 'root'), open: (_) {}, reply: (_) {});
      await tester.longPress(find.byKey(const Key('message-press-t4')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-action-reply')), findsNothing);
    });

    testWidgets('시트가 떠 있는 동안 누른 말 부분만 칠하고, 닫으면 지운다', (tester) async {
      await pump(tester, _m('t5', reactions: const [{'emoji': '👀', 'accountIds': [_a1]}]), open: (_) {});
      bool lit() => tester.widget<PressGlow>(find.byKey(const Key('message-glow-t5'))).lit;
      expect(lit(), isFalse);
      await tester.longPress(find.byKey(const Key('message-press-t5')));
      await tester.pumpAndSettle();
      expect(lit(), isTrue);
      // 줄 전체 사각 음영이 없다 — 줄을 감싼 머티리얼은 투명이다(IMG_4971 의 회귀).
      final row = tester.widget<Material>(
          find.ancestor(of: find.byKey(const Key('message-press-t5')), matching: find.byType(Material)).first);
      expect(row.type, MaterialType.transparency);
      // 강조는 아바타·리액션 줄 밖이다 — 말 부분만.
      // 실제로 칠하는 면(넘침 포함)으로 잰다 — 자식 영역만 재면 넘친 면이 아바타를 덮어도 못 잡는다.
      final glow = PressGlow.bleed.inflateRect(tester.getRect(find.byKey(const Key('message-glow-t5'))));
      final avatar = tester.getRect(find.byType(HarkroomAvatar).first);
      final react = tester.getRect(find.byKey(const Key('reaction-add-t5')));
      expect(glow.left, greaterThan(avatar.right));
      expect(glow.bottom, lessThanOrEqualTo(react.top));
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      expect(lit(), isFalse);
    });

    testWidgets('VoiceOver 사용자 지정 동작: 답글·링크·본문', (tester) async {
      final handle = tester.ensureSemantics();
      await pump(tester, _m('t6'), open: (_) {}, reply: (_) {});
      final data = tester.getSemantics(find.byKey(const Key('message-press-t6'))).getSemanticsData();
      final labels = (data.customSemanticsActionIds ?? const <int>[])
          .map((id) => CustomSemanticsAction.getAction(id)!.label)
          .toList();
      expect(labels, containsAll(['스레드에서 답글', '링크 복사', '본문 복사']));
      handle.dispose();
    });
  });

  test('링크 모양은 데스크톱 messagePermalink 와 같다', () {
    expect(messagePermalink('abc'), 'harkroom://message/abc');
  });
}

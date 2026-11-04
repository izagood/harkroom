// 카드에 직접 쓴 답 — 그 카드 하나의 답으로 보내고, 서버가 세운 카드에는 입력칸이 없다.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/ask.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/ask_card.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';

const _opts = [
  {'id': 'a', 'label': '줄인다'},
  {'id': 'b', 'label': '그대로'},
];

MessageRow _row(Map<String, Object?> meta) => MessageRow.fromJson({
      'id': 'm1', 'seq': 1, 'channelId': 'c1', 'threadRootId': null, 'authorId': 'agent', 'body': '골라 줘',
      'kind': 'user', 'meta': meta, 'createdAt': DateTime.utc(2026, 11, 4).toIso8601String(),
    });

Map<String, Object?> _ask([Map<String, Object?> extra = const {}, Map<String, Object?> top = const {}]) => {
      'kind': 'ask',
      'ask': {'options': _opts, 'to': {'kind': 'human'}, ...extra},
      ...top,
    };

class _FakeApp extends AppState {
  _FakeApp() : super(sessions: SessionStore.inMemory());
  final sent = <List<String>>[];
  @override
  Future<void> answerAskText(String channelId, String messageId, String text) async {
    sent.add([channelId, messageId, text]);
  }
}

void main() {
  late _FakeApp app;

  Future<void> pump(WidgetTester tester, Map<String, Object?> meta) async {
    final message = _row(meta);
    await tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor('ko'),
        child: AppScope(
          state: app,
          child: Scaffold(body: SingleChildScrollView(child: AskCard(message: message, ask: AskMeta.read(message.meta)!))),
        ),
      ),
    ));
    await tester.pump();
  }

  setUp(() => app = _FakeApp());

  testWidgets('쓰고 보내면 앞뒤 공백을 뺀 글이 그 카드의 답으로 간다 · 비면 못 보낸다', (tester) async {
    await pump(tester, _ask());
    final send = find.byKey(const Key('ask-write-send-m1'));
    expect(tester.widget<FilledButton>(send).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('ask-write-m1')), '  다른 길로 가자 ');
    await tester.pump();
    await tester.tap(send);
    await tester.pump();
    expect(app.sent, [['c1', 'm1', '다른 길로 가자']]);
  });

  testWidgets('상한을 넘으면 못 보낸다', (tester) async {
    await pump(tester, _ask());
    await tester.enterText(find.byKey(const Key('ask-write-m1')), 'x' * (askTextMaxChars + 1));
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byKey(const Key('ask-write-send-m1'))).onPressed, isNull);
  });

  testWidgets('서버가 세운 백스톱 카드·남에게 간 카드에는 입력칸이 없다', (tester) async {
    await pump(tester, _ask(const {}, const {'chainBackstop': <String, Object?>{}}));
    expect(find.byKey(const Key('ask-write-m1')), findsNothing);
    await pump(tester, _ask(const {'to': {'kind': 'account', 'accountId': 'someone'}}));
    expect(find.byKey(const Key('ask-write-m1')), findsNothing);
  });

  testWidgets('직접 쓴 답은 글 그대로 남고 입력칸은 접힌다', (tester) async {
    await pump(tester, _ask(const {'answeredWith': askTextOptionId, 'answeredBy': 'me', 'answeredText': '다른 길\n이유'}));
    expect(find.byKey(const Key('ask-written-m1')), findsOneWidget);
    expect(find.text('다른 길\n이유'), findsOneWidget);
    expect(find.byKey(const Key('ask-write-m1')), findsNothing);
    expect(find.byKey(const Key('ask-chosen-m1')), findsNothing);
  });

  test('이상한 값은 직접 쓴 답으로 읽지 않는다', () {
    expect(AskMeta.read(_ask(const {'answeredWith': 'a', 'answeredText': '끼어든 글'}))!.answeredText, isNull);
    expect(AskMeta.read(_ask(const {'answeredWith': askTextOptionId, 'answeredText': 3}))!.answeredText, isNull);
  });
}

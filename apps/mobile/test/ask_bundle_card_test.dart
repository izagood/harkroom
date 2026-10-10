// 묶음 카드 화면(선택 카드 P1, #1288 designer s1·s2·n1) — 「추천대로」는 5초 뒤에 보내고 그 안에 취소할 수 있다.
// 서버가 언제나 빼는 줄(되돌릴 수 없음·링크)은 n 에서 빠지고, 다 빠지면 버튼이 숨는다.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/ask.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/ask_bundle_card.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';

final _t0 = DateTime.utc(2026, 10, 10, 12);
const _opts = [
  {'id': 'a', 'label': '줄인다', 'recommended': true},
  {'id': 'b', 'label': '그대로'},
];
MessageRow _row(String id, String channel, String author, Map<String, Object?> meta) => MessageRow.fromJson({
      'id': id, 'seq': 1, 'channelId': channel, 'threadRootId': null, 'authorId': author, 'body': '골라 줘',
      'kind': 'user', 'meta': meta, 'createdAt': _t0.toIso8601String(),
    });
MessageRow _root(String id, [Map<String, Object?> ask = const {}]) =>
    _row(id, 'cw', 'sec', {'kind': 'ask', 'ask': {'options': _opts, 'to': {'kind': 'human'}, ...ask}});

class _FakeApp extends AppState {
  _FakeApp(this.roots, this.results) : super(sessions: SessionStore.inMemory());
  final Map<String, MessageRow> roots;
  final List<BundleAcceptResult> results;
  int acceptCalls = 0;
  @override
  Future<MessageRow> fetchMessage(String messageId) async => roots[messageId]!;
  @override
  Future<List<BundleAcceptResult>> acceptRecommendedBundle(String channelId, String bundleId) async {
    acceptCalls += 1;
    return results;
  }
}

void main() {
  late _FakeApp app;

  Future<void> pump(WidgetTester tester, List<String> ids) async {
    final bundle = _row('m-bundle', 'ct', 'pm', {
      'kind': 'askBundle',
      'askBundle': {
        'items': [
          for (final id in ids)
            {'rootId': id, 'askerId': 'sec', 'channelId': 'cw', 'threadRootId': null, 'prompt': '$id 물음', 'options': _opts},
        ],
      },
    });
    app.accounts['me'] = const AccountView(
        id: 'me', handle: 'jaebin', displayName: 'jaebin', isAgent: false, isDisabled: false, avatarAttachmentId: null);
    await tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor('ko'),
        child: AppScope(
          state: app,
          child: Scaffold(body: SingleChildScrollView(child: AskBundleCard(message: bundle, bundle: AskBundleMeta.read(bundle.meta)!))),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump();
  }

  testWidgets('「추천대로」는 5초 뒤에 한 번 보내고, 그 안에 취소하면 보내지 않는다(s2)', (tester) async {
    app = _FakeApp({'r1': _root('r1'), 'r2': _root('r2')}, const []);
    await pump(tester, ['r1', 'r2']);
    expect(find.text('남은 2개 추천대로'), findsOneWidget);

    await tester.tap(find.byKey(const Key('ask-bundle-accept-m-bundle')));
    await tester.pump();
    expect(find.text('2개를 추천대로 고른다 · 5'), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('2개를 추천대로 고른다 · 3'), findsOneWidget);
    await tester.tap(find.byKey(const Key('ask-bundle-cancel-m-bundle')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 6));
    expect(app.acceptCalls, 0);
    expect(find.text('남은 2개 추천대로'), findsOneWidget);

    await tester.tap(find.byKey(const Key('ask-bundle-accept-m-bundle')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    expect(app.acceptCalls, 1);
  });

  testWidgets('언제나 빠지는 줄은 n 에서 빠진다(s1)', (tester) async {
    app = _FakeApp({'r1': _root('r1'), 'r2': _root('r2')}, const [
      BundleAcceptResult(rootId: 'r1', outcome: 'skipped_irreversible'),
      BundleAcceptResult(rootId: 'r2', outcome: 'skipped_no_recommendation'),
    ]);
    await pump(tester, ['r1', 'r2']);
    await tester.tap(find.byKey(const Key('ask-bundle-accept-m-bundle')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    expect(find.byKey(const Key('ask-bundle-skip-r1')), findsOneWidget);
    expect(find.text('남은 1개 추천대로'), findsOneWidget);
  });

  testWidgets('다시 눌러도 같은 줄만 남으면 버튼이 숨는다(s1)', (tester) async {
    app = _FakeApp({'r1': _root('r1')}, const [BundleAcceptResult(rootId: 'r1', outcome: 'skipped_link')]);
    await pump(tester, ['r1']);
    await tester.tap(find.byKey(const Key('ask-bundle-accept-m-bundle')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    expect(find.byKey(const Key('ask-bundle-accept-m-bundle')), findsNothing);
  });

  testWidgets('고른 줄은 조사 없이 「라벨 · 이름」(n1)', (tester) async {
    app = _FakeApp({'r1': _root('r1', {'answeredWith': 'b', 'answeredBy': 'me'})}, const []);
    await pump(tester, ['r1']);
    expect(find.text('그대로 · jaebin'), findsOneWidget);
  });
}

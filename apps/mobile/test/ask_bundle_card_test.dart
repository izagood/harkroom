// 묶음 카드 화면(선택 카드 P1, #1288 designer s1·s2·n1) — 「추천대로」는 5초 뒤에 보내고 그 안에 취소할 수 있다.
// 서버가 언제나 빼는 줄(되돌릴 수 없음·링크)은 n 에서 빠지고, 다 빠지면 버튼이 숨는다.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_error.dart';
import 'package:harkroom/api/ask.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/api/permission_card.dart';
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

const _line = {'cap': 'tool', 'scope': 'Bash(kubectl logs:*)', 'limits': {'approve_new_mandate': {'untilMs': 604800000}}};
MessageRow _perm(String id, {String owner = 'me', Map<String, Object?> ask = const {}, Map<String, Object?> pr = const {}}) => MessageRow.fromJson({
      'id': id, 'seq': 1, 'channelId': 'cw', 'threadRootId': null, 'authorId': 'sec', 'kind': 'user', 'createdAt': _t0.toIso8601String(),
      'body': '권한 요청 · @sec\n명령 허용 `Bash(kubectl logs:*)`\n이유: 로그를 봐야 한다',
      'meta': {
        'kind': 'ask',
        'ask': {'options': [{'id': 'approve_new_mandate', 'label': 'x'}, {'id': 'deny', 'label': 'y'}], 'to': {'kind': 'human'}, ...ask},
        'permissionRequest': {'kind': 'tool', 'agentId': 'sec', 'channelId': 'cw', 'ownerAccountId': owner, 'status': 'pending', 'line': _line, 'bodyTargetLine': '명령 허용 `Bash(kubectl logs:*)`', ...pr},
      },
    });

const _canDecide = DecideCheck(viewerCanDecide: true, asOwner: true, decideScope: 'owner', ownerAccountId: 'me');

class _FakeApp extends AppState {
  _FakeApp(this.roots, this.results, {this.decide = false, this.check}) : super(sessions: SessionStore.inMemory());
  final Map<String, MessageRow> roots;
  final List<BundleAcceptResult> results;
  final bool decide;
  final DecideCheck? check;
  int acceptCalls = 0;
  final List<String> answered = [];
  final List<String> closed = [];
  final List<String> checkedChannels = [];
  Object? answerError;
  @override
  Future<bool> bundleDecideSupported() async => decide;
  @override
  DecideCheck? decideCheckFor(String agentId, String channelId) {
    checkedChannels.add(channelId);
    return check;
  }
  @override
  Future<void> answerBundleItem(String channelId, String bundleId, String rootId, String optionId) async {
    if (answerError != null) throw answerError!;
    answered.add('$channelId/$bundleId/$rootId/$optionId');
  }
  @override
  Future<void> closeBundleRoot(String rootChannelId, String rootId) async => closed.add('$rootChannelId/$rootId');
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
            {'rootId': id, 'askerId': 'sec', 'channelId': 'cw', 'threadRootId': null, 'prompt': '$id 물음', 'options': _opts, 'link': app.roots[id]?.meta['permissionRequest'] != null},
        ],
      },
    });
    app.accounts['me'] = const AccountView(
        id: 'me', handle: 'alice', displayName: 'alice', isAgent: false, isDisabled: false, avatarAttachmentId: null);
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

  testWidgets('권한 줄: 대상·이유·버튼을 펼쳐 그 자리에서 묶음 길로 정한다. 결정권은 요청 채널로 묻고 일괄에는 안 든다', (tester) async {
    app = _FakeApp({'r1': _perm('r1')}, const [], decide: true, check: _canDecide);
    await pump(tester, ['r1']);
    await tester.pump();
    expect(find.text('Bash(kubectl logs:*)', findRichText: true), findsWidgets);
    expect(find.text('이유: 로그를 봐야 한다'), findsOneWidget);
    expect(find.text('원 스레드로 위임장 만들고 더하기'), findsOneWidget);
    expect(find.byKey(const Key('ask-bundle-accept-m-bundle')), findsNothing);
    expect(app.checkedChannels.toSet(), {'cw'});
    await tester.tap(find.byKey(const Key('ask-option-r1-approve_new_mandate')));
    await tester.pump();
    expect(app.answered, ['ct/m-bundle/r1/approve_new_mandate']);
    expect(find.byKey(const Key('ask-bundle-original-r1')), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('권한 줄: 결정권이 없으면 버튼 없이 기다리는 줄만 선다', (tester) async {
    app = _FakeApp({'r1': _perm('r1', owner: 'other')}, const [], decide: true,
        check: const DecideCheck(viewerCanDecide: false, asOwner: false, decideScope: 'owner', ownerAccountId: 'other'));
    await pump(tester, ['r1']);
    await tester.pump();
    expect(find.byKey(const Key('perm-readonly-r1')), findsOneWidget);
    expect(find.byKey(const Key('ask-option-r1-approve_new_mandate')), findsNothing);
    expect(find.byKey(const Key('ask-bundle-original-r1')), findsNothing);
  });

  testWidgets('권한 줄: 실패하면 그 줄 안에 이유가 선다', (tester) async {
    app = _FakeApp({'r1': _perm('r1')}, const [], decide: true, check: _canDecide)..answerError = ApiError(403, 'forbidden', 'no');
    await pump(tester, ['r1']);
    await tester.pump();
    await tester.tap(find.byKey(const Key('ask-option-r1-approve_new_mandate')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('ask-inline-error-r1')), findsOneWidget);
  });

  testWidgets('옛 서버면 권한 줄은 링크다', (tester) async {
    app = _FakeApp({'r1': _perm('r1')}, const []);
    await pump(tester, ['r1']);
    await tester.pump();
    expect(find.byKey(const Key('ask-bundle-link-r1')), findsOneWidget);
    expect(find.byKey(const Key('ask-option-r1-approve_new_mandate')), findsNothing);
  });

  testWidgets('끝난 권한 줄은 한 줄로 접히고 어느 스레드의 위임장인지와 대상을 남긴다', (tester) async {
    app = _FakeApp({'r1': _perm('r1', ask: {'answeredWith': 'approve_new_mandate', 'answeredBy': 'me'}, pr: {'status': 'granted', 'lineId': 'l1'})}, const [], decide: true);
    await pump(tester, ['r1']);
    await tester.pump();
    expect(find.textContaining('✓ 원 스레드에 위임장을 만들고 더함 · alice'), findsOneWidget);
    expect(find.textContaining('tool Bash(kubectl logs:*)'), findsOneWidget);
    expect(find.byKey(const Key('ask-option-r1-approve_new_mandate')), findsNothing);
  });

  testWidgets('보통 줄의 「답하지 않기」는 원본 채널의 그 카드를 닫는다', (tester) async {
    app = _FakeApp({'r1': _root('r1')}, const []);
    await pump(tester, ['r1']);
    await tester.pump();
    await tester.tap(find.byKey(const Key('ask-bundle-decline-r1')));
    await tester.pump();
    expect(app.closed, ['cw/r1']);
  });

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
    expect(find.text('그대로 · alice'), findsOneWidget);
  });
}

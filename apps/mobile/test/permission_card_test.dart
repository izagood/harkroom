import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ask.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/api/permission_card.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/ask_card.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// 권한 카드(W4 위임장) — 칩 · 줄 상자 · 세로 44pt 선택지 · 끝난 상태 · 거울.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

final calls = <String>[];

MockClient _client() => MockClient((req) async {
      final path = req.url.path;
      if (req.method != 'GET') calls.add('${req.method} $path ${req.body}');
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') return _json({'channels': <Object?>[]});
      if (path == '/accounts') {
        return _json({
          'accounts': [
            {'id': 'me-1', 'handle': 'alice', 'displayName': '', 'isAgent': false, 'isDisabled': false},
          ],
        });
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      return _json({'error': {'code': 'not_found', 'message': path}}, 404);
    });

Future<AppState> _open() async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: _client()),
    connector: (_) async => throw StateError('소켓 없음'),
  );
  await app.boot();
  return app;
}

const _mandate = {'id': 'md1', 'name': 'M2.7 전환', 'ownerId': 'me-1', 'startedAt': '2026-10-21T05:00:00Z'};
const _line = {
  'cap': 'merge',
  'scope': 'repo:acme/rebelro',
  'limits': {
    'approve_mandate': {'untilMs': 604800000},
    'approve_once': {'uses': 1, 'pr': 404, 'head': '7b7dd25aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
  },
};

Map<String, Object?> permMeta({
  Map<String, Object?> pr = const {},
  Map<String, Object?> ask = const {},
  List<Map<String, Object?>>? options,
  Map<String, Object?>? mirror,
}) =>
    {
      'kind': 'ask',
      'ask': {
        'to': {'kind': 'human'},
        'options': options ??
            [
              {'id': 'approve_mandate', 'label': '이 위임장 동안'},
              {'id': 'deny', 'label': '거절'},
            ],
        ...ask,
      },
      if (mirror == null)
        'permissionRequest': {
          'requestId': 'r1',
          'agentId': 'ag1',
          'ownerAccountId': 'me-1',
          'kind': 'merge',
          'target': 'acme/rebelro',
          'status': 'pending',
          'mandate': _mandate,
          'line': _line,
          'once': {'number': 404, 'headSha': '7b7dd25aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reason': 'not_granted'},
          ...pr,
        },
      'permissionMirror': ?mirror,
    };

MessageRow msg(Map<String, Object?> meta, {String id = 'm1'}) => MessageRow.fromJson({
      'id': id,
      'seq': 1,
      'channelId': 'c1',
      'threadRootId': null,
      'authorId': 'ag1',
      'body': '',
      'kind': 'user',
      'meta': meta,
      'createdAt': '2026-10-21T05:41:00Z',
    });

Widget wrap(AppState app, Widget child, {Brightness b = Brightness.light, String lang = 'ko'}) => MaterialApp(
      theme: harkroomTheme(b),
      builder: (context, nav) => I18n(strings: stringsFor(lang), child: AppScope(state: app, child: nav!)),
      home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child)),
    );

Widget card(Map<String, Object?> meta, {String id = 'm1'}) {
  final m = msg(meta, id: id);
  return AskCard(message: m, ask: AskMeta.read(m.meta)!);
}

void main() {
  late AppState app;
  setUp(() async {
    calls.clear();
    app = await _open();
  });
  tearDown(() => app.dispose());

  test('원본·진짜 거울·중립 거울을 읽는다', () {
    final o = PermissionCardInfo.read(permMeta())!;
    expect(o.mandate!.name, 'M2.7 전환');
    expect(o.line!.cap, 'merge');
    expect(o.line!.limits['approve_once']!.pr, 404);
    expect(o.once!.number, 404);
    final g = PermissionCardInfo.read(permMeta(mirror: {'rootId': 'root1', 'neutral': false, 'kind': 'merge', 'line': _line, 'mandate': _mandate}))!;
    expect(g.isMirror && !g.neutral, isTrue);
    expect(g.ownerId, 'me-1');
    final n = PermissionCardInfo.read(permMeta(mirror: {'rootId': 'root1', 'neutral': true}))!;
    expect(n.neutral, isTrue);
    expect(PermissionCardInfo.read(const {'kind': 'ask'}), isNull);
  });

  testWidgets('열린 카드: 칩 · 줄 · 세로 44pt 선택지 · 거절은 글자 버튼', (tester) async {
    await tester.pumpWidget(wrap(app, card(permMeta())));
    expect(find.text('🔑 M2.7 전환 · 10-21'), findsOneWidget);
    expect(find.byKey(const Key('perm-cap')), findsOneWidget);
    expect(find.text('repo:acme/rebelro'), findsOneWidget);
    expect(find.text('7일'), findsOneWidget);
    // 줄 상자는 주 버튼 [이 위임장 동안]의 한도만 — [이번 한 번]의 PR·head 는 싣지 않는다.
    expect(find.text('PR #404'), findsNothing);
    expect(find.text('head 7b7dd25'), findsNothing);
    final primary = find.byKey(const Key('ask-option-m1-approve_mandate'));
    final once = find.byKey(const Key('ask-option-m1-approve_once'));
    final deny = find.byKey(const Key('ask-option-m1-deny'));
    expect(tester.widget(primary), isA<FilledButton>());
    expect(tester.widget(once), isA<OutlinedButton>());
    expect(tester.widget(deny), isA<TextButton>());
    expect(find.text('이번 한 번 (PR #404)'), findsOneWidget);
    for (final f in [primary, once, deny]) {
      expect(tester.getSize(f).height, greaterThanOrEqualTo(44));
    }
    expect(tester.getTopLeft(once).dy, greaterThan(tester.getTopLeft(primary).dy));
    expect(tester.getTopLeft(deny).dy, greaterThan(tester.getTopLeft(once).dy));
  });

  testWidgets('이번 한 번은 gh 계정 없이 approve_once 를 보낸다', (tester) async {
    await tester.pumpWidget(wrap(app, card(permMeta())));
    await tester.tap(find.byKey(const Key('ask-option-m1-approve_once')));
    await tester.pumpAndSettle();
    expect(calls.where((c) => c.contains('approve_once')), isNotEmpty);
    expect(calls.where((c) => c.contains('ghUser')), isEmpty);
  });

  testWidgets('위임 없는 턴: [이 스레드로 위임장 만들고 더하기]', (tester) async {
    await tester.pumpWidget(wrap(
        app,
        card(permMeta(pr: {'mandate': null, 'once': null}, options: [
          {'id': 'approve_new_mandate', 'label': 'x'},
          {'id': 'deny', 'label': '거절'},
        ]))));
    expect(tester.widget(find.byKey(const Key('ask-option-m1-approve_new_mandate'))), isA<FilledButton>());
    expect(find.text('이 스레드로 위임장 만들고 더하기'), findsOneWidget);
    expect(find.byKey(const Key('ask-option-m1-approve_once')), findsNothing);
  });

  testWidgets('이름 없는 칩: 🔑 위임장 · @소유자 · MM-DD 시작', (tester) async {
    await tester.pumpWidget(wrap(app, card(permMeta(pr: {'mandate': {..._mandate, 'name': ''}}))));
    expect(find.text('🔑 위임장 · @alice · 10-21 시작'), findsOneWidget);
  });

  test('ghUserUsed: 카드와 원본을 보는 거울에서 읽는다', () {
    expect(PermissionCardInfo.read({'permissionRequest': {'status': 'approved_once', 'ghUserUsed': 'picked'}})!.ghUserUsed, 'picked');
    expect(PermissionCardInfo.read({'permissionMirror': {'rootId': 'r', 'neutral': false, 'ghUserUsed': 'picked'}})!.ghUserUsed, 'picked');
    expect(PermissionCardInfo.read({'permissionMirror': {'rootId': 'r', 'neutral': true, 'ghUserUsed': 'picked'}})!.ghUserUsed, isNull);
  });

  testWidgets('끝난 상태들', (tester) async {
    Future<void> expectState(Map<String, Object?> pr, String text, {Map<String, Object?> ask = const {}}) async {
      await tester.pumpWidget(wrap(app, card(permMeta(pr: pr, ask: ask))));
      expect(find.textContaining(text), findsWidgets, reason: text);
      expect(find.byKey(const Key('ask-option-m1-approve_mandate')), findsNothing);
    }

    await expectState({'status': 'granted'}, '위임장에 더함', ask: {'answeredWith': 'approve_mandate'});
    await expectState({'status': 'approved_once', 'approvedOnce': {'ghUser': 'octo'}}, '이번 한 번 승인함 · gh octo', ask: {'answeredWith': 'approve_once'});
    // 끝난 카드는 고른 선택지의 한도 — [이번 한 번]이면 PR·head 가 남는다.
    expect(find.text('PR #404'), findsOneWidget);
    expect(find.text('head 7b7dd25'), findsOneWidget);
    expect(find.text('7일'), findsNothing);
    await expectState({'status': 'approved_once'}, '이번 한 번 승인함', ask: {'answeredWith': 'approve_once'});
    await expectState({'status': 'denied'}, '거절함', ask: {'answeredWith': 'deny'});
    await expectState({'status': 'expired'}, '만료됨 · 에이전트가 다시 청해야 한다', ask: {'closedAt': '2026-10-21T06:00:00Z', 'closedReason': 'expired'});
    await expectState({'status': 'superseded', 'supersededByMessageId': 'm9'}, '새 카드로 바뀜',
        ask: {'closedAt': '2026-10-21T06:00:00Z', 'closedReason': 'superseded'});
    expect(find.byKey(const Key('perm-open-new-m1')), findsOneWidget);
    await expectState({'mandate': {..._mandate, 'endedAt': '2026-10-22T00:00:00Z'}}, '위임장이 끝남');
    await expectState({'status': 'granted', 'decidedVia': {'kind': 'chat', 'messageId': 'x'}}, '위임장에 더함 · 글로 답함',
        ask: {'answeredWith': 'approve_mandate'});
    await expectState({'ownerAccountId': 'someone-else'}, '소유자만 정할 수 있다');
    expect(find.byKey(const Key('ask-option-m1-deny')), findsNothing);
  });

  testWidgets('r5: 답한 카드 머리는 결과 — 누가 무엇을 했나(ko·en), 글로 답함·gh 덧말은 남는다', (tester) async {
    Future<void> head(Map<String, Object?> pr, String chose, String text, {String lang = 'ko'}) async {
      await tester.pumpWidget(wrap(app, card(permMeta(pr: pr, ask: {'answeredWith': chose, 'answeredBy': 'me-1'})), lang: lang));
      final shown = tester.widget<Text>(find.byKey(const Key('ask-head-m1'))).data;
      expect(shown, text);
    }

    await head({'status': 'denied'}, 'deny', '거절함 · alice');
    await head({'status': 'granted'}, 'approve_mandate', '이 위임장에 더함 · alice');
    await head({'status': 'granted'}, 'approve_new_mandate', '위임장을 만들고 더함 · alice');
    await head({'status': 'approved_once', 'approvedOnce': {'ghUser': 'octo'}}, 'approve_once', '이번 한 번 허락함 · alice · gh octo');
    await head({'status': 'denied', 'decidedVia': {'kind': 'chat', 'messageId': 'x'}}, 'deny', '거절함 · alice · 글로 답함');
    await head({'status': 'denied'}, 'deny', 'alice denied', lang: 'en');
    await head({'status': 'granted'}, 'approve_mandate', 'alice added this to the mandate', lang: 'en');
    await head({'status': 'approved_once'}, 'approve_once', 'alice allowed it once', lang: 'en');
    await head({'status': 'granted'}, 'approve_new_mandate', 'alice started a mandate and added this', lang: 'en');
    expect(stringsFor('ko').permResultDenied('재빈'), '거절함 · 재빈');
    expect(stringsFor('ko').permResultDenied('나비'), '거절함 · 나비');
  });

  testWidgets('진짜 거울은 같은 카드, 중립 거울은 중립 한 줄 + 원본 링크', (tester) async {
    await tester.pumpWidget(wrap(
        app,
        card(permMeta(mirror: {
          'rootId': 'root1',
          'neutral': false,
          'kind': 'merge',
          'line': _line,
          'mandate': _mandate,
          'once': {'number': 404, 'headSha': '7b7dd25aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reason': 'not_granted'},
        }))));
    expect(find.text('🔑 M2.7 전환 · 10-21'), findsOneWidget);
    expect(find.byKey(const Key('ask-option-m1-approve_mandate')), findsOneWidget);
    expect(find.byKey(const Key('ask-option-m1-approve_once')), findsOneWidget);
    expect(find.byKey(const Key('perm-open-original-m1')), findsOneWidget);

    await tester.pumpWidget(wrap(app, card(permMeta(mirror: {'rootId': 'root1', 'neutral': true}))));
    expect(find.byKey(const Key('perm-neutral-m1')), findsOneWidget);
    expect(find.byKey(const Key('perm-open-original-m1')), findsOneWidget);
    expect(find.byKey(const Key('perm-mandate-chip')), findsNothing);
    expect(find.byKey(const Key('ask-option-m1-approve_mandate')), findsNothing);
  });

  testWidgets('영어', (tester) async {
    await tester.pumpWidget(wrap(app, card(permMeta()), lang: 'en'));
    expect(find.text('For this mandate'), findsOneWidget);
    expect(find.text('Just this once (PR #404)'), findsOneWidget);
    expect(find.text('Deny'), findsOneWidget);
  });

  testWidgets('소유자를 모르면 버튼 없이 읽기 전용', (tester) async {
    await tester.pumpWidget(wrap(app, card(permMeta(pr: {'ownerAccountId': null, 'mandate': null}))));
    expect(find.byKey(const Key('perm-readonly-m1')), findsOneWidget);
    expect(find.byKey(const Key('ask-option-m1-approve_mandate')), findsNothing);
    expect(find.byKey(const Key('ask-option-m1-deny')), findsNothing);
  });

  testWidgets('r3: 줄 카드 머리는 i18n 키 — 서버의 ask.prompt 는 다시 그리지 않는다(ko·en·위임 없음)', (tester) async {
    final meta = permMeta(ask: {'prompt': '권한을 줄까?'});
    await tester.pumpWidget(wrap(app, card(meta)));
    expect(find.text('위임장에 줄을 더할까? · alice 차례'), findsOneWidget);
    expect(find.text('권한을 줄까?'), findsNothing);
    await tester.pumpWidget(wrap(app, card(meta), lang: 'en'));
    await tester.pump();
    expect(find.text("Add a line to the mandate? · alice's turn"), findsOneWidget);
    expect(find.text('권한을 줄까?'), findsNothing);
    await tester.pumpWidget(wrap(
        app,
        card(permMeta(pr: {'mandate': null, 'once': null}, ask: {'prompt': '권한을 줄까?'}, options: [
          {'id': 'approve_new_mandate', 'label': 'x'},
          {'id': 'deny', 'label': '거절'},
        ])),
        lang: 'en'));
    await tester.pump();
    // r5(designer nit): 새 위임장 머리도 소유자를 알면 「· {owner} 차례」.
    expect(find.text("Start a mandate and add this line? · alice's turn"), findsOneWidget);
    expect(find.text('권한을 줄까?'), findsNothing);
  });

  test('r5(designer F1): 줄 상자를 그리면 본문에서 서버가 쓴 대상 줄(bodyTargetLine) 하나만 뺀다', () {
    const tl = '머지 `acme/rebelro`';
    const body = '권한 요청 · @ag\n$tl\n이유: 확인';
    expect(permissionCardBody(body, permMeta(pr: {'bodyTargetLine': tl})), '권한 요청 · @ag\n이유: 확인');
    // 옛 카드(칸 없음)·줄 없음·중립 거울·밀려난 카드(줄 상자 안 그림)·ask 없음은 그대로.
    expect(permissionCardBody(body, permMeta()), body);
    expect(permissionCardBody(body, permMeta(pr: {'bodyTargetLine': tl, 'line': null})), body);
    expect(permissionCardBody(body, permMeta(mirror: {'rootId': 'root1', 'neutral': true, 'bodyTargetLine': tl})), body);
    expect(permissionCardBody(body, permMeta(pr: {'bodyTargetLine': tl, 'status': 'superseded'})), body);
    final noAsk = Map<String, Object?>.of(permMeta(pr: {'bodyTargetLine': tl}))..remove('ask');
    expect(permissionCardBody(body, noAsk), body);
    // 진짜 거울도 같은 칸을 읽는다.
    expect(
        permissionCardBody(body, permMeta(mirror: {'rootId': 'root1', 'neutral': false, 'kind': 'merge', 'line': _line, 'bodyTargetLine': tl})),
        '권한 요청 · @ag\n이유: 확인');
  });
}

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
            {'id': 'me-1', 'handle': 'jaebin', 'displayName': '', 'isAgent': false, 'isDisabled': false},
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
    expect(find.text('🔑 위임장 · @jaebin · 10-21 시작'), findsOneWidget);
  });

  testWidgets('끝난 상태들', (tester) async {
    Future<void> expectState(Map<String, Object?> pr, String text, {Map<String, Object?> ask = const {}}) async {
      await tester.pumpWidget(wrap(app, card(permMeta(pr: pr, ask: ask))));
      expect(find.textContaining(text), findsWidgets, reason: text);
      expect(find.byKey(const Key('ask-option-m1-approve_mandate')), findsNothing);
    }

    await expectState({'status': 'granted'}, '위임장에 더함', ask: {'answeredWith': 'approve_mandate'});
    await expectState({'status': 'approved_once', 'approvedOnce': {'ghUser': 'octo'}}, '이번 한 번 승인함 · gh octo', ask: {'answeredWith': 'approve_once'});
    await expectState({'status': 'approved_once'}, '이번 한 번 승인함', ask: {'answeredWith': 'approve_once'});
    await expectState({'status': 'denied'}, '거절함', ask: {'answeredWith': 'deny'});
    await expectState({'status': 'expired'}, '시한 지남', ask: {'closedAt': '2026-10-21T06:00:00Z', 'closedReason': 'expired'});
    await expectState({'status': 'superseded', 'supersededByMessageId': 'm9'}, '새 카드로 바뀜',
        ask: {'closedAt': '2026-10-21T06:00:00Z', 'closedReason': 'superseded'});
    expect(find.byKey(const Key('perm-open-new-m1')), findsOneWidget);
    await expectState({'mandate': {..._mandate, 'endedAt': '2026-10-22T00:00:00Z'}}, '위임장이 끝남');
    await expectState({'status': 'granted', 'decidedVia': {'kind': 'chat', 'messageId': 'x'}}, '위임장에 더함 · 글로 답함',
        ask: {'answeredWith': 'approve_mandate'});
    await expectState({'ownerAccountId': 'someone-else'}, '소유자만 정할 수 있어요');
    expect(find.byKey(const Key('ask-option-m1-deny')), findsNothing);
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
}

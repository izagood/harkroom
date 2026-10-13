import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Inbox **A안 받은 일**(모바일 M2) — 판정은 `inbox_board_contract_test.dart` 가 데스크톱과 같은 표로 잰다. 여기서는
/// 화면 약속만 잰다: 결정 카드는 밀어서 치울 수 없다 · 밀면 치우고 되돌리기 알림 · 상세 흐름 · 탭 배지 = 나를 기다리는
/// 일 수(G1 (b)) · 7일 줄은 펼친 뒤에만 [전부 치우기] · 스크린리더 동작.
http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

final _puts = <String>[];

/// 가짜 서버가 기억하는 내 상태 — PUT 이 바꾸고 판이 돌려준다(실서버처럼).
final _states = <String, String>{};

/// 걸어 두면 PUT 이 이것이 풀릴 때까지 답하지 않는다 — 「호출 전에 줄이 빠지나」를 잰다.
Completer<void>? _putGate;

/// 참이면 PUT 이 500 으로 실패한다.
bool _putFails = false;
String _now(Duration ago) => DateTime.now().toUtc().subtract(ago).toIso8601String();

Map<String, Object?> _entry(int id, String root, {Map<String, Object?> meta = const {}, Duration ago = const Duration(hours: 1)}) => {
      'id': id, 'messageId': 'm$id', 'reason': 'mention', 'channelId': 'c1', 'authorId': 'a1',
      'body': '말 $id', 'meta': meta, 'createdAt': _now(ago), 'threadRootId': root, 'readAt': null,
    };
Map<String, Object?> _head(String id, {Map<String, Object?> extra = const {}, Duration ago = const Duration(hours: 1)}) => {
      'id': id, 'channelId': 'c1', 'authorId': 'me-1', 'body': '머리 $id', 'createdAt': _now(ago), 'replyCount': 2,
      'openAskHumanCount': 0, 'openAskAccountIds': <String>[], 'openAskLinks': <Object?>[], 'unresolvedFailureCount': 0,
      'lastKind': 'user', 'lastAuthorId': 'me-1', ...extra,
    };
final _ask = {
  'kind': 'ask',
  'ask': {'prompt': '머지할까?', 'options': [{'id': 'a', 'label': '머지'}, {'id': 'b', 'label': '다시'}], 'to': {'kind': 'account', 'accountId': 'me-1'}},
};
final _fail = {'kind': 'failure', 'failure': {'retryable': true, 'what': '하네스가 멈췄다', 'reason': 'MCP 인증이 필요하다'}};

/// 결정 d1 · 막힘 b1(내 스레드 실패) · 7일 넘은 결정 old1.
Map<String, Object?> _board() => {
      'entries': [
        _entry(1, 'd1', meta: _ask),
        _entry(2, 'b1', meta: _fail),
        _entry(3, 'old1', meta: _ask, ago: const Duration(days: 10)),
      ],
      'threads': [
        _head('d1', extra: {'openAskAccountIds': ['me-1']}),
        _head('b1', extra: {'unresolvedFailureCount': 1}),
        _head('old1', extra: {'openAskAccountIds': ['me-1']}, ago: const Duration(days: 10)),
      ],
      'threadStates': [
        for (final MapEntry(key: root, value: st) in _states.entries)
          {'rootId': root, 'state': st, 'until': null, 'updatedAt': _now(Duration.zero)},
      ],
    };

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') return _json({'channels': [{'id': 'c1', 'name': 'harkroom', 'kind': 'standard'}]});
      if (path == '/accounts') {
        return _json({'accounts': [
          {'id': 'a1', 'handle': 'forge', 'displayName': 'forge', 'kind': 'agent'},
          {'id': 'me-1', 'handle': 'me', 'displayName': '나', 'kind': 'human'},
        ]});
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path == '/inbox/board') return _json(_board());
      if (path.startsWith('/inbox') && req.method == 'GET') return _json({'entries': <Object?>[]});
      if (path.startsWith('/inbox/threads/') && req.method == 'PUT') {
        _puts.add('${path.split('/').last} ${req.body}');
        if (_putGate != null) await _putGate!.future;
        if (_putFails) return _json({'error': {'code': 'internal', 'message': 'boom'}}, 500);
        final root = path.split('/').last;
        final st = (jsonDecode(req.body) as Map)['state'] as String?;
        if (st == null) {
          _states.remove(root);
        } else {
          _states[root] = st;
        }
        return _json({'state': st});
      }
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      if (path.startsWith('/saved')) return _json({'open': 0, 'entries': <Object?>[]});
      return _json({'error': {'code': 'not_found', 'message': path}}, 404);
    });

class _IdleConnection implements WsConnection {
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

AppState _state() => AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me-1',
          'communities': [
            {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
          ],
        }),
      ),
      apiFactory: (base, token) => ApiClient(baseUrl: base, token: token, httpClient: _server()),
      connector: (Uri _) async => _IdleConnection(),
    );

Future<AppState> _openInbox(WidgetTester tester) async {
  final state = _state();
  await tester.pumpWidget(HarkroomApp(state: state));
  await tester.pumpAndSettle();
  addTearDown(state.dispose);
  await tester.tap(find.byKey(const Key('tab-inbox')));
  await tester.pumpAndSettle();
  return state;
}

void main() {
  setUp(() {
    _puts.clear();
    _states.clear();
    _putGate = null;
    _putFails = false;
  });

  testWidgets('탭 배지·머리 숫자는 나를 기다리는 일 수다 — 7일 넘은 것은 빠진다 (G1 (b))', (tester) async {
    final state = await _openInbox(tester);
    expect(state.inboxMine, 2);
    expect(find.byKey(const Key('inbox-mine-count')), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('inbox-mine-count'))).data, contains('2'));
    // [모두 읽음]은 없다 — 숫자를 줄이는 길은 치우기 하나다.
    expect(find.byKey(const Key('inbox-mark-all')), findsNothing);
  });

  testWidgets('결정 카드는 밀어서 치울 수 없고, 막힘 카드는 밀면 치우고 되돌리기 알림이 선다', (tester) async {
    await _openInbox(tester);
    expect(find.byKey(const Key('inbox-section-decision')), findsOneWidget);
    expect(find.byKey(const Key('inbox-section-blocker')), findsOneWidget);
    expect(find.byKey(const ValueKey('inbox-swipe-d1')), findsNothing, reason: '결정은 상세에서만 치운다');
    expect(find.byKey(const ValueKey('inbox-swipe-b1')), findsOneWidget);

    await tester.drag(find.byKey(const ValueKey('inbox-swipe-b1')), const Offset(-500, 0));
    await tester.pumpAndSettle();
    expect(_puts, ['b1 {"state":"done"}']);
    expect(find.byKey(const Key('inbox-toast')), findsOneWidget);
    final bar = tester.widget<SnackBar>(find.byKey(const Key('inbox-toast')));
    expect(bar.duration, const Duration(seconds: 6));

    await tester.tap(find.byKey(const Key('inbox-toast-undo')));
    await tester.pumpAndSettle();
    expect(_puts.last, 'b1 {"state":null}');
  });

  testWidgets('밀면 호출이 끝나기 전에 줄이 빠지고 숫자가 준다 (designer s2)', (tester) async {
    final state = await _openInbox(tester);
    expect(state.inboxMine, 2);
    _putGate = Completer<void>();
    await tester.drag(find.byKey(const ValueKey('inbox-swipe-b1')), const Offset(-500, 0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(_puts, ['b1 {"state":"done"}'], reason: 'PUT 은 나갔고 아직 답이 없다');
    expect(find.byKey(const Key('inbox-card-b1')), findsNothing, reason: '답을 기다리지 않고 바로 빠진다');
    expect(find.byKey(const Key('inbox-section-blocker')), findsNothing);
    expect(state.inboxMine, 1);
    expect(tester.widget<Text>(find.byKey(const Key('inbox-mine-count'))).data, contains('1'));

    _putGate!.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-card-b1')), findsNothing, reason: '다시 받은 판도 치운 것으로 말한다');
    expect(state.inboxMine, 1);
    expect(find.byKey(const Key('inbox-toast')), findsOneWidget);

    await tester.tap(find.byKey(const Key('inbox-toast-undo')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-card-b1')), findsOneWidget, reason: '되돌리면 돌아온다');
    expect(state.inboxMine, 2);
  });

  testWidgets('밀기 호출이 실패하면 줄이 되살아나고 실패 알림이 선다 (designer s2)', (tester) async {
    final state = await _openInbox(tester);
    _putFails = true;
    await tester.drag(find.byKey(const ValueKey('inbox-swipe-b1')), const Offset(-500, 0));
    await tester.pumpAndSettle();
    expect(_puts, ['b1 {"state":"done"}']);
    expect(find.byKey(const Key('inbox-card-b1')), findsOneWidget);
    expect(state.inboxMine, 2);
    expect(find.byKey(const Key('inbox-toast-failed')), findsOneWidget);
    expect(find.byKey(const Key('inbox-toast')), findsNothing);
  });

  testWidgets('결정은 상세에서 치운다 — 알림은 12초, 목록으로 돌아온다', (tester) async {
    await _openInbox(tester);
    await tester.tap(find.byKey(const Key('inbox-card-d1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-detail')), findsOneWidget);
    // 선택지와 행동 줄은 따로 선다 — [치우기]가 선택지처럼 읽히지 않게.
    expect(find.byKey(const Key('inbox-detail-answer-a')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('inbox-detail-actions')), matching: find.byKey(const Key('inbox-detail-answer-a'))), findsNothing);
    // 물음 카드의 [스레드 열기]는 테두리 버튼이다.
    expect(find.descendant(of: find.byKey(const Key('inbox-detail-open')), matching: find.byType(OutlinedButton)).evaluate().isNotEmpty ||
        tester.widget(find.byKey(const Key('inbox-detail-open'))) is OutlinedButton, isTrue);

    await tester.tap(find.byKey(const Key('inbox-detail-dismiss')));
    await tester.pumpAndSettle();
    expect(_puts, ['d1 {"state":"done"}']);
    expect(find.byKey(const Key('inbox-detail')), findsNothing, reason: '목록으로 돌아온다');
    expect(tester.widget<SnackBar>(find.byKey(const Key('inbox-toast'))).duration, const Duration(seconds: 12));
  });

  testWidgets('7일 줄은 결정 수를 말하고, [전부 치우기]는 펼친 뒤에만 선다', (tester) async {
    await _openInbox(tester);
    await tester.scrollUntilVisible(
      find.byKey(const Key('inbox-stale-label')),
      100,
      scrollable: find.descendant(of: find.byKey(const Key('inbox-list-todo')), matching: find.byType(Scrollable)).first,
    );
    final label = tester.widget<Text>(find.byKey(const Key('inbox-stale-label')));
    expect(label.textSpan!.toPlainText(), allOf(contains('1'), contains(' · ')));
    expect(find.byKey(const Key('inbox-stale-clear-all')), findsNothing);
    await tester.tap(find.byKey(const Key('inbox-stale-toggle')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('inbox-stale-clear-all')), findsOneWidget);
    expect(find.byKey(const Key('inbox-card-old1')), findsOneWidget);
  });

  testWidgets('묶음 머리는 목록 바탕색이다 — 다크로 바뀌어도 밝은 띠가 남지 않는다 (designer s1)', (tester) async {
    await _openInbox(tester);
    Color headerColor() => tester
        .widget<Container>(find.descendant(of: find.byKey(const Key('inbox-section-decision')), matching: find.byType(Container)).first)
        .color!;
    Color listColor() => Theme.of(tester.element(find.byKey(const Key('inbox-card-d1')))).scaffoldBackgroundColor;
    expect(headerColor(), listColor());
    final light = headerColor();

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    await tester.pumpAndSettle();
    expect(listColor(), isNot(light), reason: '앱이 다크로 바뀌었다');
    expect(headerColor(), listColor());
  });

  testWidgets('스크린리더 — 막힘 줄에는 치우기·나중에, 결정 줄에는 나중에만', (tester) async {
    final handle = tester.ensureSemantics();
    await _openInbox(tester);
    final blocker = tester.getSemantics(find.byKey(const Key('inbox-card-b1')));
    final decision = tester.getSemantics(find.byKey(const Key('inbox-card-d1')));
    final bLabels = blocker.getSemanticsData().customSemanticsActionIds?.length ?? 0;
    final dLabels = decision.getSemanticsData().customSemanticsActionIds?.length ?? 0;
    expect(bLabels, 2);
    expect(dLabels, 1);
    handle.dispose();
  });
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/api/thread_plan.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/markdown/markdown_view.dart';
import 'package:harkroom/screens/feed_pin.dart';
import 'package:harkroom/screens/message_tile.dart';
import 'package:harkroom/screens/thread_plan_sheet.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _root = '00000000-0000-4000-8000-000000000001';
const _child = '00000000-0000-4000-8000-000000000002';
const _hiddenChild = '00000000-0000-4000-8000-000000000003';
const _agent = '00000000-0000-4000-8000-00000000000a';

Map<String, Object?> _rootRow({Object? plan = const {'done': 1, 'total': 5, 'active': 1, 'blocked': 1, 'waiting': 2, 'rev': 3}, bool withPlan = true}) => {
      'id': _root,
      'seq': 10,
      'channelId': 'c1',
      'threadRootId': null,
      'authorId': 'me-1',
      'body': 'root',
      'kind': 'user',
      'meta': <String, Object?>{},
      'createdAt': '2026-11-04T00:00:00.000Z',
      'reactions': <Object?>[],
      'attachments': <Object?>[],
      'replyCount': 2,
      'lastReplyAt': '2026-11-04T00:10:00.000Z',
      if (withPlan) 'planProgress': plan,
    };

Map<String, Object?> _planJson({int rev = 3, String? updatedAt, String goal = '파일 미리보기 출시'}) => {
      'rootId': _root,
      'channelId': 'c1',
      'rev': rev,
      'updatedAt': updatedAt ?? DateTime.now().toUtc().toIso8601String(),
      'updatedBy': _agent,
      'flagged': null,
      'doc': {
        'goal': goal,
        'next': '썸네일 크기 정하기',
        'blocked': '**사람** 결정 필요',
        'groups': [
          {'id': 'g1', 'title': '화면', 'dependsOn': <Object?>[]},
          {'id': 'g2', 'title': '서버', 'dependsOn': <Object?>[]},
          {'id': 'g3', 'title': '출시', 'dependsOn': ['g1', 'g2']},
          {'id': 'g4', 'title': '문서', 'linkedRootId': _child, 'dependsOn': <Object?>[]},
          {'id': 'g5', 'title': '배포', 'linkedRootId': _hiddenChild, 'dependsOn': <Object?>[]},
        ],
        'steps': [
          {'id': 's1', 'groupId': 'g1', 'title': '카드 구현', 'state': 'blocked', 'assigneeId': _agent, 'blockedReason': '[썸네일](https://evil.example) 결정', 'links': <Object?>[], 'dependsOn': <Object?>[]},
          {'id': 's2', 'groupId': 'g1', 'title': '접근성 점검', 'state': 'pending', 'assigneeId': 'nobody', 'links': <Object?>[], 'dependsOn': ['s1']},
          {'id': 's3', 'groupId': 'g2', 'title': '생성 워커', 'state': 'active', 'assigneeId': 'me-1', 'links': <Object?>[], 'dependsOn': <Object?>[]},
          {'id': 's4', 'groupId': 'g2', 'title': '보안 검토', 'state': 'pending', 'links': <Object?>[], 'dependsOn': ['s3']},
          {'id': 's5', 'groupId': 'g3', 'title': '릴리스', 'state': 'pending', 'links': <Object?>[], 'dependsOn': ['s1']},
          {'id': 's6', 'title': '그룹 밖 단계', 'state': 'done', 'links': <Object?>[], 'dependsOn': <Object?>[]},
        ],
      },
      'derived': {
        'g1': {'derived': 'blocked', 'waitingOn': <Object?>[]},
        'g2': {'derived': 'active', 'waitingOn': <Object?>[]},
        'g3': {'derived': 'waiting', 'waitingOn': ['g1', 'g2']},
        'g4': {'derived': 'active', 'waitingOn': <Object?>[]},
        'g5': {'derived': 'hidden', 'waitingOn': <Object?>[]},
        's1': {'derived': 'blocked', 'waitingOn': <Object?>[]},
        's2': {'derived': 'waiting', 'waitingOn': ['s1']},
        's3': {'derived': 'active', 'waitingOn': <Object?>[]},
        's4': {'derived': 'ready', 'waitingOn': <Object?>[]},
        's5': {'derived': 'waiting', 'waitingOn': ['s1']},
        's6': {'derived': 'done', 'waitingOn': <Object?>[]},
      },
      'progress': {'done': 2, 'total': 7, 'active': 2, 'blocked': 1, 'waiting': 2},
      'linked': [
        {'groupId': 'g4', 'rootId': _child, 'hidden': false, 'channelId': 'c2', 'progress': {'done': 1, 'total': 4, 'active': 1, 'blocked': 0, 'waiting': 2}},
        {'groupId': 'g5', 'rootId': _hiddenChild, 'hidden': true},
      ],
    };

http.Response _json(Object? body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

class _Sock implements WsConnection {
  final c = StreamController<String>();
  @override
  int? get closeCode => null;
  @override
  Stream<String> get messages => c.stream;
  @override
  void send(String payload) {}
  @override
  Future<void> close() async => c.close();
}

class _Server {
  int planGets = 0;

  /// 차례대로 답한다. Completer 를 넣으면 그것이 끝날 때 답한다.
  final answers = <Future<http.Response> Function()>[];
  http.Response Function() fallback = () => _json({'plan': _planJson()});
  Map<String, Object?> Function() root = _rootRow;

  /// 「시작」 요청 기록과 답.
  final startCalls = <Map<String, dynamic>>[];
  http.Response Function(Map<String, dynamic> body) startAnswer = (b) => b['dryRun'] == true
      ? _json({'rev': 3, 'posts': [{'to': _agent, 'via': 'assignee', 'stepIds': ['s4'], 'body': '@builder 단계 「보안 검토」를 시작해 달라'}], 'selfStepIds': <Object?>[], 'skipped': <Object?>[], 'managerSkipped': null})
      : _json({'rev': 4, 'started': [{'id': 's4', 'via': 'assignee', 'to': _agent, 'messageId': 'm-9'}], 'skipped': <Object?>[], 'failed': <Object?>[], 'notNotified': <Object?>[], 'managerSkipped': null, 'plan': _planJson(rev: 4)});
  Future<http.Response> Function(Map<String, dynamic> body)? startAnswerAsync;
  final managerCalls = <Object?>[];
  String? lastPostBody;

  MockClient client() => MockClient((req) async {
        final path = req.url.path;
        if (path.endsWith('/plan/start')) {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          startCalls.add(body);
          return startAnswerAsync != null ? await startAnswerAsync!(body) : startAnswer(body);
        }
        if (path.endsWith('/plan/manager')) {
          managerCalls.add((jsonDecode(req.body) as Map<String, dynamic>)['managerId']);
          return _json({'plan': _planJson(rev: 5)});
        }
        if (path.endsWith('/plan')) {
          planGets++;
          if (answers.isNotEmpty) return answers.removeAt(0)();
          return fallback();
        }
        if (path == '/auth/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': 'Me', 'isAgent': false, 'isAdmin': false, 'mustChangePassword': false, 'avatarAttachmentId': null});
        }
        if (path == '/channels') {
          return _json({'channels': [{'id': 'c1', 'name': 'general', 'type': 'public'}]});
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        if (path.endsWith('/messages') && req.method == 'POST') {
          lastPostBody = (jsonDecode(req.body) as Map<String, dynamic>)['body'] as String?;
          return _json({'message': {...root(), 'id': 'm-new', 'seq': 99, 'body': lastPostBody, 'threadRootId': _root}});
        }
        if (path.endsWith('/messages')) {
          final thread = req.url.queryParameters['thread'];
          if (thread != null || req.url.queryParameters.containsKey('limit')) return _json({'messages': [root()], 'hasMore': false});
          return _json({'messages': [root()], 'hasMore': false});
        }
        if (path == '/accounts') {
          return _json({'accounts': [
            {'id': _agent, 'handle': 'builder', 'displayName': 'builder', 'kind': 'agent', 'isDisabled': false},
            {'id': 'pat', 'handle': 'pat', 'displayName': 'pat', 'kind': 'human', 'isDisabled': false},
          ]});
        }
        if (path.contains('/agent-models') || path.contains('/auto-mentions')) return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        return _json({'messages': <Object?>[], 'hasMore': false});
      });
}

Future<(AppState, _Sock)> _boot(_Server s) async {
  final sock = _Sock();
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: s.client()),
    connector: (_) async => sock,
  );
  await app.boot();
  await app.openChannel('c1');
  return (app, sock);
}

void _emit(_Sock s, Map<String, Object?> e) => s.c.add(jsonEncode(e));

ThreadPlanView _view([Map<String, Object?>? j]) => ThreadPlanView.fromJson(j ?? _planJson())!;

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump();
  }
}

/// 버튼만 세운 화면 — 탭하면 시트가 열린다.
Widget _host(AppState app, Widget child) => MaterialApp(
      theme: harkroomTheme(Brightness.light),
      builder: (context, c) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: c!)),
      home: child,
    );

Future<void> _button(WidgetTester tester, AppState app, {double width = 375, bool keyboard = false}) async {
  tester.view.physicalSize = Size(width * 3, 812 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: harkroomTheme(Brightness.light),
    builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child!)),
    home: Scaffold(
      body: SafeArea(
        child: Builder(builder: (context) {
          final row = context.app.messages['c1']!.firstWhere((m) => m.id == _root);
          return Align(alignment: Alignment.bottomRight, child: ThreadPlanButton(rootId: _root, progress: row.planProgress, keyboardOpen: keyboard));
        }),
      ),
    ),
  ));
  await _settle(tester);
}

void main() {
  group('루트 행 planProgress', () {
    test('키가 없으면 「모른다」, null 이면 「없다」', () {
      final absent = MessageRow.fromJson(_rootRow(withPlan: false));
      expect(absent.planProgressKnown, isFalse);
      final none = MessageRow.fromJson(_rootRow(plan: null));
      expect(none.planProgressKnown, isTrue);
      expect(none.planProgress, isNull);
      final some = MessageRow.fromJson(_rootRow());
      expect(some.planProgress!.rev, 3);
      expect(some.planProgress!.blocked, 1);
    });

    test('다른 사본(답글 수·상태·리액션)이 진행률을 잃지 않는다', () {
      final m = MessageRow.fromJson(_rootRow());
      expect(m.withReplyCount(9).planProgress?.rev, 3);
      expect(m.withStatus(null).planProgress?.rev, 3);
      expect(m.withReaction(emoji: '👍', accountId: 'a', added: true).planProgress?.rev, 3);
    });

    test('실시간 행(키 없음)은 앞 값을 지키고, 키가 null 이면 지운다', () async {
      final s = _Server();
      final (app, sock) = await _boot(s);
      MessageRow row() => app.messages['c1']!.firstWhere((m) => m.id == _root);
      expect(row().planProgress?.rev, 3);

      _emit(sock, {'type': 'message.updated', 'message': _rootRow(withPlan: false)});
      _emit(sock, {'type': 'message.new', 'message': _rootRow(withPlan: false)});
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(row().planProgress?.rev, 3, reason: '키 없는 갱신이 칩을 지우면 안 된다');

      _emit(sock, {'type': 'thread.plan.changed', 'channelId': 'c1', 'rootId': _root, 'rev': null, 'progress': null, 'audience': 'all'});
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(row().planProgress, isNull);

      _emit(sock, {'type': 'message.updated', 'message': _rootRow(withPlan: false)});
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(row().planProgress, isNull, reason: '지운 뒤의 키 없는 갱신이 옛 값을 되살리면 안 된다');
    });

    test('thread.plan.changed 는 칩 값을 이벤트 그대로, 판은 받지 않는다', () async {
      final s = _Server();
      final (app, sock) = await _boot(s);
      _emit(sock, {
        'type': 'thread.plan.changed', 'channelId': 'c1', 'rootId': _root, 'rev': 4,
        'progress': {'done': 3, 'total': 5, 'active': 0, 'blocked': 0, 'waiting': 2}, 'audience': 'all',
      });
      await Future<void>.delayed(const Duration(milliseconds: 5));
      final p = app.messages['c1']!.firstWhere((m) => m.id == _root).planProgress!;
      expect((p.rev, p.done, p.updatedAt), (4, 3, null));
      expect(s.planGets, 0);
    });
  });

  group('판 받기', () {
    final at = DateTime.utc(2026, 11, 4, 1);
    PlanProgressMark mark(int rev, [DateTime? u]) => PlanProgressMark(done: 0, total: 1, rev: rev, updatedAt: u);
    ThreadPlanView held(int rev, DateTime u) => _view(_planJson(rev: rev, updatedAt: u.toIso8601String()));

    test('rev 가 다르면 작아져도 받는다(지웠다 다시 세운 판)', () {
      expect(planNeedsFetch(null, mark(1)), isTrue);
      expect(planNeedsFetch(held(5, at), mark(1)), isTrue);
      expect(planNeedsFetch(held(5, at), mark(5)), isFalse);
    });

    test('rev 가 같아도 행 시각이 더 늦으면 받는다', () {
      expect(planNeedsFetch(held(1, at), mark(1, at.add(const Duration(minutes: 1)))), isTrue);
      expect(planNeedsFetch(held(1, at), mark(1, at)), isFalse);
    });

    test('옛 시각의 응답은 들고 있는 판을 덮지 않는다', () async {
      final s = _Server();
      final (app, _) = await _boot(s);
      final newer = at.add(const Duration(hours: 1)).toIso8601String();
      s.answers.add(() async => _json({'plan': _planJson(rev: 2, updatedAt: newer)}));
      await app.loadThreadPlan(_root);
      s.answers.add(() async => _json({'plan': _planJson(rev: 9, updatedAt: at.toIso8601String())}));
      await app.loadThreadPlan(_root);
      expect(app.threadPlans[_root]!.rev, 2);
    });

    test('먼저 시작한 요청이 늦게 와도 나중 요청의 판을 덮지 않는다', () async {
      final s = _Server();
      final (app, _) = await _boot(s);
      final slow = Completer<http.Response>();
      s.answers.add(() => slow.future);
      final first = app.loadThreadPlan(_root);
      await Future<void>.delayed(Duration.zero);
      s.answers.add(() async => _json({'plan': _planJson(rev: 7)}));
      await app.loadThreadPlan(_root);
      slow.complete(_json({'plan': null}));
      await first;
      expect(app.threadPlans[_root]!.rev, 7);
    });

    test('계획이 지워지면 오던 응답이 옛 판을 되살리지 못한다', () async {
      final s = _Server();
      final (app, sock) = await _boot(s);
      final slow = Completer<http.Response>();
      s.answers.add(() => slow.future);
      final pending = app.loadThreadPlan(_root);
      await Future<void>.delayed(Duration.zero);
      _emit(sock, {'type': 'thread.plan.changed', 'channelId': 'c1', 'rootId': _root, 'rev': null, 'progress': null, 'audience': 'all'});
      await Future<void>.delayed(const Duration(milliseconds: 5));
      slow.complete(_json({'plan': _planJson(rev: 3)}));
      await pending;
      expect(app.threadPlans[_root], isNull);
    });

    test('실패는 표시만 하고 던지지 않는다, 다음 성공이 지운다', () async {
      final s = _Server();
      final (app, _) = await _boot(s);
      s.answers.add(() async => _json({'error': 'x'}, 500));
      await app.loadThreadPlan(_root);
      expect(app.threadPlanFailed, contains(_root));
      await app.loadThreadPlan(_root);
      expect(app.threadPlanFailed, isNot(contains(_root)));
      expect(app.threadPlans[_root], isNotNull);
    });
  });

  group('낡음·모양', () {
    test('낡음은 24시간 넘게, 시각을 모르면 낡지 않다', () {
      final now = DateTime.utc(2026, 11, 4);
      expect(isPlanStale(now.subtract(const Duration(hours: 25)), now), isTrue);
      expect(isPlanStale(now.subtract(const Duration(hours: 23)), now), isFalse);
      expect(isPlanStale(null, now), isFalse);
    });

    test('모양이 틀려도 죽지 않는다', () {
      expect(ThreadPlanView.fromJson(null), isNull);
      expect(ThreadPlanView.fromJson({'rev': 'x'}), isNull);
      final p = ThreadPlanView.fromJson({'rev': 1, 'doc': 'nope', 'derived': 3, 'linked': 'y'})!;
      expect(p.goal, '');
      expect(p.groups, isEmpty);
      expect(p.linked, isEmpty);
      expect(PlanProgressMark.fromJson({'done': 1}), isNull);
    });
  });

  group('칩', () {
    Future<void> tile(WidgetTester tester, MessageRow m, {double width = 375}) async {
      tester.view.physicalSize = Size(width * 3, 700 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final (app, _) = await tester.runAsync(() => _boot(_Server())) as (AppState, _Sock);
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child!)),
        home: Scaffold(body: ListView(children: [MessageTile(message: m, onOpenThread: () {})])),
      ));
      await tester.pump();
    }

    testWidgets('「답글 n개」 뒤, 시각 앞. 막힘은 글자로도 말한다', (tester) async {
      final at = DateTime.now().toUtc().subtract(const Duration(minutes: 3)).toIso8601String();
      await tile(tester, MessageRow.fromJson({..._rootRow(), 'lastReplyAt': at}));
      final chip = find.byKey(const Key('plan-chip-$_root'));
      expect(chip, findsOneWidget);
      expect(find.text('계획 1/5 · 막힘 1'), findsOneWidget);
      final reply = tester.getTopLeft(find.text('답글 2개'));
      final ago = tester.getTopLeft(find.textContaining(' · 3'));
      expect(reply.dx, lessThan(tester.getTopLeft(chip).dx));
      expect(tester.getTopLeft(chip).dx, lessThan(ago.dx));
    });

    testWidgets('계획이 없거나 단계가 0개면 칩이 없다', (tester) async {
      await tile(tester, MessageRow.fromJson(_rootRow(plan: null)));
      expect(find.byKey(const Key('plan-chip-$_root')), findsNothing);
      await tile(tester, MessageRow.fromJson(_rootRow(plan: const {'done': 0, 'total': 0, 'rev': 1})));
      expect(find.byKey(const Key('plan-chip-$_root')), findsNothing);
    });

    testWidgets('320pt 에서도 넘치지 않고 칩이 남는다', (tester) async {
      await tile(tester, MessageRow.fromJson({..._rootRow(), 'participantIds': ['a', 'b', 'c'], 'replyCount': 128}), width: 320);
      expect(tester.takeException(), isNull);
      expect(find.text('계획 1/5 · 막힘 1'), findsOneWidget);
    });
  });

  group('요약 줄 자리 나누기', () {
    test('넉넉하면 아바타를 그대로 둔다', () {
      final l = PlanSummaryLayout.resolve(width: 300, reply: 50, chip: 100, participants: 3);
      expect(l.avatars, 3);
    });

    test('모자라면 아바타부터 뺀다 — 답글과 칩은 안 줄인다', () {
      final l = PlanSummaryLayout.resolve(width: 200, reply: 50, chip: 130, participants: 3);
      expect(l.avatars, 0);
      expect(l.replyMax, 50);
      expect(l.chipMax, greaterThanOrEqualTo(130));
    });

    test('어떤 폭에서도 줄 전체가 넘치지 않는다', () {
      for (final width in [120.0, 200.0, 242.0, 320.0]) {
        final l = PlanSummaryLayout.resolve(width: width, reply: 400, chip: 500, participants: 3);
        expect(l.avatars * PlanSummaryLayout.avatarWidth + l.replyMax + PlanSummaryLayout.chipGap + l.chipMax, lessThanOrEqualTo(width));
      }
    });
  });

  group('버튼', () {
    testWidgets('planProgress 가 없으면 버튼도 GET 도 없다', (tester) async {
      final s = _Server()..root = () => _rootRow(plan: null);
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app);
      expect(find.byKey(const Key('plan-button')), findsNothing);
      expect(s.planGets, 0);
    });

    testWidgets('한 번만 받고, 판을 받으면 개인 진행률을 쓰고 닫힌 채로 막힘을 말한다', (tester) async {
      final s = _Server();
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app);
      expect(s.planGets, 1);
      expect(find.text('계획 2/7'), findsOneWidget, reason: '판을 받은 뒤의 칩은 개인 진행률이다');
      expect(find.byKey(const Key('plan-button-blocked')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('320pt 에서도 넘치지 않는다', (tester) async {
      final (app, _) = await tester.runAsync(() => _boot(_Server())) as (AppState, _Sock);
      await _button(tester, app, width: 320);
      expect(tester.takeException(), isNull);
    });

    testWidgets('키보드가 올라오면 숨고, 판은 그대로 받는다', (tester) async {
      final s = _Server();
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app, keyboard: true);
      expect(find.byKey(const Key('plan-button')), findsNothing);
      expect(s.planGets, 1);
    });

    testWidgets('스레드 화면: 머리에 띠가 없고 작성칸 위에 뜨며, 키보드가 올라오면 숨는다', (tester) async {
      final (app, _) = await tester.runAsync(() => _boot(_Server())) as (AppState, _Sock);
      tester.view.physicalSize = const Size(375 * 3, 812 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        theme: harkroomTheme(Brightness.light),
        builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child!)),
        home: const ThreadScreen(channelId: 'c1', rootId: _root),
      ));
      await _settle(tester);
      final button = find.byKey(const Key('plan-button'));
      expect(button, findsOneWidget);
      expect(tester.getBottomRight(button).dx, 375 - 16);
      expect(tester.getTopLeft(button).dy, greaterThan(400));
      // 맨 아래 글이 버튼 밑에 깔리지 않게 피드가 비켜 있다.
      expect(tester.widget<SliverPadding>(find.byKey(feedCenterKey)).padding.resolve(TextDirection.ltr).bottom, 12 + planButtonHeight + 8);
      tester.view.viewInsets = const FakeViewPadding(bottom: 900);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump();
      expect(button, findsNothing);
      expect(tester.widget<SliverPadding>(find.byKey(feedCenterKey)).padding.resolve(TextDirection.ltr).bottom, 8);
    });

    testWidgets('rev 가 바뀌면 다시 받고, 실패해도 버튼은 행 값으로 서 있다', (tester) async {
      final s = _Server();
      final (app, sock) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      s.fallback = () => _json({'error': 'x'}, 500);
      await _button(tester, app);
      expect(find.text('계획 1/5'), findsOneWidget);
      expect(s.planGets, 1);
      await tester.pump();
      expect(s.planGets, 1, reason: '실패했다고 매 프레임 다시 두드리지 않는다');
      s.fallback = () => _json({'plan': _planJson(rev: 4)});
      await tester.runAsync(() async {
        _emit(sock, {
          'type': 'thread.plan.changed', 'channelId': 'c1', 'rootId': _root, 'rev': 4,
          'progress': {'done': 2, 'total': 5, 'active': 0, 'blocked': 0, 'waiting': 2}, 'audience': 'all',
        });
        await Future<void>.delayed(const Duration(milliseconds: 5));
      });
      await _settle(tester);
      expect(s.planGets, 2);
      expect(app.threadPlans[_root]!.rev, 4);
    });

    testWidgets('지워지면 버튼이 사라지고 판도 버린다', (tester) async {
      final s = _Server();
      final (app, sock) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app);
      await tester.runAsync(() async {
        _emit(sock, {'type': 'thread.plan.changed', 'channelId': 'c1', 'rootId': _root, 'rev': null, 'progress': null, 'audience': 'all'});
        await Future<void>.delayed(const Duration(milliseconds: 5));
      });
      await _settle(tester);
      expect(find.byKey(const Key('plan-button')), findsNothing);
      expect(app.threadPlans[_root], isNull);
    });
  });

  group('시트', () {
    Future<AppState> open(WidgetTester tester, _Server s) async {
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app);
      await tester.tap(find.byKey(const Key('plan-button-open')));
      await tester.pumpAndSettle();
      return app;
    }

    testWidgets('78% 로 열고, 끌어 올리면 약 93%, 끌어 내리면 닫힌다', (tester) async {
      await open(tester, _Server());
      double frac() => tester.getSize(find.byKey(const Key('plan-sheet'))).height / tester.view.physicalSize.height * 3;
      expect(frac(), closeTo(0.78, 0.08));
      final before = frac();
      await tester.drag(find.byKey(const Key('plan-sheet-goal')), const Offset(0, -500));
      await tester.pumpAndSettle();
      expect(frac(), greaterThan(before));
      expect(frac(), closeTo(0.93, 0.08));
      await tester.drag(find.byKey(const Key('plan-sheet-goal')), const Offset(0, 800));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-sheet')), findsNothing);
    });

    testWidgets('끝난 일까지 모든 그룹을 펼쳐 문서 순서로 둔다', (tester) async {
      await open(tester, _Server());
      for (final id in ['s1', 's3', 's5', 's6']) {
        expect(find.byKey(Key('plan-step-$id')), findsOneWidget);
      }
      final y1 = tester.getTopLeft(find.byKey(const Key('plan-step-s1'))).dy;
      final y3 = tester.getTopLeft(find.byKey(const Key('plan-step-s3'))).dy;
      expect(y1, lessThan(y3));
    });

    testWidgets('머리는 고정이고 목록만 구른다', (tester) async {
      await open(tester, _Server());
      final chip = find.byKey(const Key('plan-chips'));
      final before = tester.getTopLeft(chip).dy;
      await tester.drag(find.byKey(const Key('plan-sheet-scroll')), const Offset(0, -2000));
      await tester.pumpAndSettle();
      await tester.drag(find.byKey(const Key('plan-sheet-scroll')), const Offset(0, -2000));
      await tester.pumpAndSettle();
      expect(chip, findsOneWidget);
      expect(tester.getTopLeft(chip).dy, lessThanOrEqualTo(before));
      expect(find.descendant(of: find.byKey(const Key('plan-sheet-scroll')), matching: chip), findsNothing);
    });

    testWidgets('펼침·접힘은 기억하지 않는다', (tester) async {
      await open(tester, _Server());
      await tester.tap(find.byKey(const Key('plan-group-g1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-step-s1')), findsNothing);
      await tester.tap(find.byKey(const Key('plan-sheet-close')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-button-open')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-step-s1')), findsOneWidget);
    });

    testWidgets('막힘 칩은 접힌 그룹을 펴서 가고 까닭을 펴며, 거듭 누르면 차례가 붙는다. 0 이면 누를 수 없다', (tester) async {
      await open(tester, _Server());
      await tester.tap(find.byKey(const Key('plan-group-g1')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('plan-chip-blocked')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('plan-chip-blocked')));
      await tester.pump();
      expect(find.byKey(const Key('plan-why-s1')), findsOneWidget);
      expect(find.byKey(const ValueKey('plan-flash-s1-1')), findsOneWidget);
      expect(find.text('막힘 1 · 1/1'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      // 연결 그룹 g4 도 한 칸이라 진행 칩에 든다 — 진행 수가 0 이 아니다.
      expect(tester.widget<InkWell>(find.byKey(const Key('plan-chip-active'))).onTap, isNotNull);
    });

    testWidgets('「⏳ 앞:」 을 누르면 그 자리로 가서 깜빡인다', (tester) async {
      await open(tester, _Server());
      await tester.ensureVisible(find.byKey(const Key('plan-waiting-g1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-waiting-g1')));
      await tester.pump();
      expect(find.byKey(const ValueKey('plan-flash-g1-1')), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
    });

    testWidgets('막힌 까닭: 앞 단계로 가고, 연결이 없으면 그렇게 말한다', (tester) async {
      final s = _Server();
      await open(tester, s);
      await tester.ensureVisible(find.byKey(const Key('plan-why-toggle-s1')));
      await tester.tap(find.byKey(const Key('plan-why-toggle-s1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-why-none-s1')), findsOneWidget);
      expect(find.byKey(const Key('plan-why-reason-s1')), findsOneWidget);
    });

    testWidgets('연결은 「그 스레드 열기 →」, 볼 수 없으면 점선 줄이고 누를 수 없다', (tester) async {
      await open(tester, _Server());
      expect(find.text('그 스레드 열기 →'), findsOneWidget);
      expect(find.byKey(const Key('plan-open-linked-g4')), findsOneWidget);
      expect(find.byKey(const Key('plan-linked-hidden-g5')), findsOneWidget);
      expect(find.byKey(const Key('plan-open-linked-g5')), findsNothing);
      expect(find.descendant(of: find.byKey(const Key('plan-linked-hidden-g5')), matching: find.byType(InkWell)), findsNothing);
    });

    testWidgets('담당은 아는 계정만, 모르는 id 는 그리지 않는다. 시작 가능 둘째 줄', (tester) async {
      await open(tester, _Server());
      expect(find.textContaining('@builder'), findsOneWidget);
      expect(find.textContaining('nobody'), findsNothing);
      expect(find.textContaining('앞 단계 끝남 · 시작 가능'), findsOneWidget);
      expect(find.textContaining('내 차례'), findsWidgets, reason: '담당이 나인 진행 단계는 내 차례다');
      expect(find.text('내 차례 1'), findsOneWidget);
    });

    testWidgets('남이 쓴 글은 그대로 글자다 — 링크·마크다운으로 해석하지 않는다', (tester) async {
      await open(tester, _Server());
      expect(find.textContaining('[썸네일](https://evil.example) 결정'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('plan-foot')));
      expect(find.textContaining('**사람** 결정 필요'), findsOneWidget);
    });

    testWidgets('GET 실패면 시트에 오류와 다시 시도', (tester) async {
      final s = _Server()..fallback = () => _json({'error': 'x'}, 500);
      await open(tester, s);
      expect(find.byKey(const Key('plan-load-failed')), findsOneWidget);
      s.fallback = () => _json({'plan': _planJson()});
      await tester.tap(find.byKey(const Key('plan-retry')));
      await _settle(tester);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-flow-toggle')), findsOneWidget);
    });

    testWidgets('연결 그룹이 막히면 막힘 칩이 켜지고 그 그룹으로 간다', (tester) async {
      final s = _Server()..fallback = () {
        final j = _planJson();
        final derived = j['derived']! as Map<String, Object?>;
        derived['g4'] = {'derived': 'blocked', 'waitingOn': <Object?>[]};
        derived['s1'] = {'derived': 'done', 'waitingOn': <Object?>[]};
        return _json({'plan': j});
      };
      await open(tester, s);
      await tester.ensureVisible(find.byKey(const Key('plan-chip-blocked')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('plan-chip-blocked')));
      await tester.pump();
      expect(find.byKey(const ValueKey('plan-flash-g4-1')), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
    });

    testWidgets('수가 0 인 칩은 누를 수 없다', (tester) async {
      final s = _Server()..fallback = () {
        final j = _planJson();
        (j['derived']! as Map<String, Object?>)['g4'] = {'derived': 'done', 'waitingOn': <Object?>[]};
        return _json({'plan': j});
      };
      await open(tester, s);
      expect(tester.widget<InkWell>(find.byKey(const Key('plan-chip-active'))).onTap, isNull);
    });

    testWidgets('머리: 상태 칩은 한 줄로 가로 스크롤하고, 흐름은 접혀 있다가 눌러야 편다', (tester) async {
      await open(tester, _Server());
      final top = tester.getTopLeft(find.byKey(const Key('plan-chip-done'))).dy;
      expect(tester.getTopLeft(find.byKey(const Key('plan-chip-waiting'))).dy, top, reason: '칩이 두 줄로 내려가면 안 된다');
      final scroll = tester.widget<SingleChildScrollView>(find.byKey(const Key('plan-chips')));
      expect(scroll.scrollDirection, Axis.horizontal);
      expect(find.byKey(const Key('plan-flow')), findsNothing);
      await tester.tap(find.byKey(const Key('plan-flow-toggle')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-flow')), findsOneWidget);
      expect(find.text('흐름 접기 ⌃'), findsOneWidget);
    });

    testWidgets('막힌 줄: 「막힘 · 사유」 는 한 줄이고 그 아래 담당·까닭 토글, 펴면 글자가 바뀐다', (tester) async {
      await open(tester, _Server());
      final reason = tester.widget<Text>(find.byKey(const Key('plan-step-reason-s1')));
      expect(reason.maxLines, 1);
      expect(reason.overflow, TextOverflow.ellipsis);
      expect(find.descendant(of: find.byKey(const Key('plan-step-sub-s1')), matching: find.byKey(const Key('plan-why-toggle-s1'))), findsOneWidget);
      expect(find.descendant(of: find.byKey(const Key('plan-step-sub-s1')), matching: find.textContaining('@builder')), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('plan-why-toggle-s1')));
      await tester.tap(find.byKey(const Key('plan-why-toggle-s1')));
      await tester.pumpAndSettle();
      expect(find.text('까닭 접기 ⌃'), findsOneWidget);
    });

    testWidgets('구분점은 조각 사이에만 — 첫 조각 앞과 링크 글자에 없다', (tester) async {
      final s = _Server()..fallback = () {
        final j = _planJson();
        final doc = j['doc']! as Map<String, Object?>;
        final steps = (doc['steps']! as List).cast<Map<String, Object?>>();
        steps.firstWhere((x) => x['id'] == 's6')['links'] = [{'kind': 'pr', 'repo': 'acme/app', 'number': 7}];
        steps.firstWhere((x) => x['id'] == 's6')['assigneeId'] = _agent;
        return _json({'plan': j});
      };
      await open(tester, s);
      final sub = find.byKey(const Key('plan-step-sub-s6'));
      await tester.ensureVisible(sub);
      final texts = tester.widgetList<Text>(find.descendant(of: sub, matching: find.byType(Text))).map((t) => t.data).toList();
      expect(texts, ['끝', ' · ', '@builder', ' · ', 'PR #7 ↗']);
    });

    testWidgets('열려 있는 동안 판이 바뀌면 그 자리에서 고친다', (tester) async {
      final s = _Server();
      final app = await open(tester, s);
      s.fallback = () => _json({'plan': _planJson(rev: 4, goal: '바뀐 목표')});
      await tester.runAsync(() => app.loadThreadPlan(_root));
      await tester.pump();
      expect(tester.widget<Text>(find.byKey(const Key('plan-sheet-goal'))).data, '바뀐 목표');
    });
  });

  group('▷ 시작', () {
    Future<AppState> openSheet(WidgetTester tester, _Server s) async {
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app);
      await tester.tap(find.byKey(const Key('plan-button-open')));
      await tester.pumpAndSettle();
      return app;
    }

    Future<void> press(WidgetTester tester, Key key) async {
      await tester.ensureVisible(find.byKey(key));
      await tester.pump();
      await tester.tap(find.byKey(key));
      await _settle(tester);
      await tester.pumpAndSettle();
    }

    testWidgets('시작 가능 줄에만 버튼이 있고, 미리보기에 부를 상대와 글을 보인다. 아직 시작하지 않는다', (tester) async {
      final s = _Server();
      await openSheet(tester, s);
      expect(find.byKey(const Key('plan-start-s2')), findsNothing, reason: '대기 줄에는 없다');
      await press(tester, const Key('plan-start-s4'));
      expect(s.startCalls.single['dryRun'], true);
      expect(tester.widget<Text>(find.byKey(const Key('plan-start-title'))).data, '@builder에게 맡긴다');
      expect(find.byKey(const Key('plan-start-body-$_agent')), findsOneWidget);
    });

    testWidgets('시작하면 미리보기 rev 를 싣고, 확인 시트만 닫히며 줄에 시작 글이 남는다', (tester) async {
      final s = _Server();
      final app = await openSheet(tester, s);
      await press(tester, const Key('plan-start-s4'));
      await press(tester, const Key('plan-start-go'));
      expect(s.startCalls.last['ifRev'], 3);
      expect(s.startCalls.last.containsKey('dryRun'), isFalse);
      expect(s.startCalls.last['locale'], 'ko');
      expect(find.byKey(const Key('plan-start-sheet')), findsNothing);
      expect(find.byKey(const Key('plan-sheet')), findsOneWidget);
      expect(app.threadPlans[_root]!.rev, 4);
      expect(find.byKey(const Key('plan-started-link-s4')), findsOneWidget);
    });

    for (final code in ['plan_changed', 'if_rev_required']) {
      testWidgets('$code 면 시작하지 않고 미리보기를 다시 받아 새 판으로만 시작한다', (tester) async {
        final s = _Server();
        var rev = 3;
        var refuse = true;
        s.startAnswer = (b) {
          if (b['dryRun'] == true) {
            return _json({'rev': rev, 'posts': [{'to': _agent, 'via': 'manager', 'stepIds': ['s4'], 'body': '판 $rev 글'}], 'selfStepIds': <Object?>[], 'skipped': <Object?>[], 'managerSkipped': null});
          }
          if (refuse) {
            refuse = false;
            rev = 7;
            return _json({'error': {'code': code, 'message': 'x'}}, code == 'plan_changed' ? 409 : 400);
          }
          return _json({'rev': 8, 'started': <Object?>[], 'skipped': <Object?>[], 'failed': <Object?>[], 'notNotified': <Object?>[], 'managerSkipped': null, 'plan': _planJson(rev: 8)});
        };
        await openSheet(tester, s);
        await press(tester, const Key('plan-start-s4'));
        await press(tester, const Key('plan-start-go'));
        expect(find.byKey(const Key('plan-start-sheet')), findsOneWidget, reason: '시트가 그대로 있어 새 내용을 보여 준다');
        expect(find.byKey(const Key('plan-start-changed')), findsOneWidget);
        expect(tester.widget<Text>(find.byKey(const Key('plan-start-body-$_agent'))).data, '판 7 글');
        expect(tester.widget<Text>(find.byKey(const Key('plan-start-title'))).data, '관리 에이전트 @builder에게 맡긴다');
        await press(tester, const Key('plan-start-go'));
        expect(s.startCalls.last['ifRev'], 7);
      });
    }

    testWidgets('관리 에이전트를 못 거치면 사유를 한 줄로 보이고, 담당이 없으면 고를 때까지 시작이 꺼진다', (tester) async {
      final s = _Server();
      s.startAnswer = (b) {
        final picked = ((b['steps'] as List).first as Map)['assigneeId'];
        return _json({
          'rev': 3,
          'posts': picked == null ? <Object?>[] : [{'to': _agent, 'via': 'assignee', 'stepIds': ['s4'], 'body': '글'}],
          'selfStepIds': <Object?>[],
          'skipped': picked == null ? [{'id': 's4', 'code': 'no_assignee'}] : <Object?>[],
          'managerSkipped': 'manager_not_invokable',
        });
      };
      await openSheet(tester, s);
      await press(tester, const Key('plan-start-s4'));
      expect(find.byKey(const Key('plan-start-manager-skipped')), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('plan-start-go'))).onPressed, isNull);
      await tester.tap(find.byKey(const Key('plan-start-pick')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('@builder').last);
      await _settle(tester);
      await tester.pumpAndSettle();
      expect(((s.startCalls.last['steps'] as List).first as Map)['assigneeId'], _agent);
      expect(tester.widget<FilledButton>(find.byKey(const Key('plan-start-go'))).onPressed, isNotNull);
    });

    testWidgets('고른 것을 바꾸면 새 미리보기가 올 때까지 시작하지 못한다', (tester) async {
      final s = _Server();
      final gate = Completer<void>();
      var waited = false;
      s.startAnswerAsync = (b) async {
        final picked = ((b['steps'] as List).first as Map)['assigneeId'];
        if (picked != null && !waited) {
          waited = true;
          await gate.future;
        }
        return _json({'rev': 3, 'posts': [{'to': _agent, 'via': 'assignee', 'stepIds': ['s4'], 'body': '글'}], 'selfStepIds': <Object?>[], 'skipped': [{'id': 's4', 'code': 'no_assignee'}], 'managerSkipped': null});
      };
      await openSheet(tester, s);
      await press(tester, const Key('plan-start-s4'));
      expect(tester.widget<FilledButton>(find.byKey(const Key('plan-start-go'))).onPressed, isNotNull);
      await tester.tap(find.byKey(const Key('plan-start-pick')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('@builder').last);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byKey(const Key('plan-start-refreshing')), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('plan-start-go'))).onPressed, isNull);
      gate.complete();
      await _settle(tester);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-start-refreshing')), findsNothing);
      expect(tester.widget<FilledButton>(find.byKey(const Key('plan-start-go'))).onPressed, isNotNull);
    });

    testWidgets('글 올리기가 실패하면 시트를 닫지 않고 사유를 보이며, 새 판으로 다시 시작한다', (tester) async {
      final s = _Server();
      var rev = 3;
      var first = true;
      s.startAnswer = (b) {
        if (b['dryRun'] == true) return _json({'rev': rev, 'posts': [{'to': _agent, 'via': 'assignee', 'stepIds': ['s4'], 'body': '글'}], 'selfStepIds': <Object?>[], 'skipped': <Object?>[], 'managerSkipped': null});
        if (first) {
          first = false;
          rev = 5;
          return _json({'rev': 5, 'started': <Object?>[], 'skipped': <Object?>[], 'failed': [{'id': 's4', 'code': 'post_failed'}], 'notNotified': <Object?>[], 'managerSkipped': null, 'plan': _planJson(rev: 5)});
        }
        return _json({'rev': 6, 'started': <Object?>[], 'skipped': <Object?>[], 'failed': <Object?>[], 'notNotified': <Object?>[], 'managerSkipped': null, 'plan': _planJson(rev: 6)});
      };
      await openSheet(tester, s);
      await press(tester, const Key('plan-start-s4'));
      await press(tester, const Key('plan-start-go'));
      expect(find.byKey(const Key('plan-start-sheet')), findsOneWidget);
      expect(find.byKey(const Key('plan-start-result')), findsOneWidget);
      expect(find.text('닫기'), findsOneWidget);
      await press(tester, const Key('plan-start-go'));
      expect(s.startCalls.last['ifRev'], 5);
      expect(find.byKey(const Key('plan-start-sheet')), findsNothing);
    });

    testWidgets('일부만 되면 몇 개인지 보이고, 못 알린 상대를 한 줄로 적는다', (tester) async {
      final s = _Server();
      s.startAnswer = (b) => b['dryRun'] == true
          ? _json({'rev': 3, 'posts': [{'to': _agent, 'via': 'assignee', 'stepIds': ['s4'], 'body': '글'}], 'selfStepIds': <Object?>[], 'skipped': <Object?>[], 'managerSkipped': null})
          : _json({'rev': 4, 'started': [{'id': 's4', 'via': 'assignee', 'to': _agent, 'messageId': 'm-9'}], 'skipped': [{'id': 's5', 'code': 'already_started'}], 'failed': <Object?>[], 'notNotified': [_agent], 'managerSkipped': null, 'plan': _planJson(rev: 4)});
      await openSheet(tester, s);
      await press(tester, const Key('plan-start-s4'));
      await press(tester, const Key('plan-start-go'));
      expect(find.text('1개 시작 · 1개 못 함'), findsOneWidget);
      expect(find.byKey(const Key('plan-start-not-notified')), findsOneWidget);
      expect(find.textContaining('@builder', findRichText: true), findsWidgets);
    });

    testWidgets('담당이 다른 사람이면 버튼이 꺼지고 까닭을 쓴다', (tester) async {
      final s = _Server()..fallback = () {
        final j = _planJson();
        final steps = ((j['doc']! as Map)['steps']! as List).cast<Map<String, Object?>>();
        steps.firstWhere((x) => x['id'] == 's4')['assigneeId'] = 'pat';
        return _json({'plan': j});
      };
      await openSheet(tester, s);
      await tester.ensureVisible(find.byKey(const Key('plan-start-s4')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('plan-start-s4')));
      await tester.pump();
      expect(s.startCalls, isEmpty);
      expect(find.byKey(const Key('plan-other-human-s4')), findsOneWidget);
    });

    testWidgets('모두 시작은 둘 이상일 때만 있고, 고를 수 없는 줄은 꺼진다', (tester) async {
      final one = _Server();
      await openSheet(tester, one);
      expect(find.byKey(const Key('plan-start-all')), findsNothing);
    });

    testWidgets('모두 시작: 체크 목록과 도는 턴 수를 보이고, 빼면 다시 미리 본다', (tester) async {
      final s = _Server()..fallback = () {
        final j = _planJson();
        (j['derived']! as Map<String, Object?>)['s5'] = {'derived': 'ready', 'waitingOn': <Object?>[]};
        return _json({'plan': j});
      };
      s.startAnswer = (b) {
        final ids = (b['steps'] as List).map((x) => (x as Map)['id']).toList();
        return _json({
          'rev': 3,
          'posts': ids.contains('s4') ? [{'to': _agent, 'via': 'assignee', 'stepIds': ['s4'], 'body': '글'}] : <Object?>[],
          'selfStepIds': <Object?>[],
          'skipped': [{'id': 's5', 'code': 'no_assignee'}],
          'managerSkipped': null,
        });
      };
      await openSheet(tester, s);
      await press(tester, const Key('plan-start-all'));
      expect(find.text('에이전트 턴 1개가 동시에 돈다'), findsOneWidget);
      expect(find.text('시작 가능 2개를 한꺼번에 시작'), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('plan-start-to-s4'))).data, '→ @builder');
      expect(tester.widget<CheckboxListTile>(find.byKey(const Key('plan-start-check-s5'))).onChanged, isNull);
      await tester.tap(find.byKey(const Key('plan-start-check-s4')));
      await _settle(tester);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byKey(const Key('plan-start-go'))).onPressed, isNull);
    });
  });

  group('💬 묻기', () {
    Future<AppState> openSheet(WidgetTester tester, _Server s) async {
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      tester.view.physicalSize = const Size(375 * 3, 812 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(_host(app, const ThreadScreen(channelId: 'c1', rootId: _root)));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('plan-button-open')));
      await tester.pumpAndSettle();
      return app;
    }

    Future<void> ask(WidgetTester tester, String id) async {
      await tester.ensureVisible(find.byKey(Key('plan-ask-$id')));
      await tester.pump();
      await tester.tap(find.byKey(Key('plan-ask-$id')));
      await tester.pumpAndSettle();
    }

    String field(WidgetTester tester) => tester.widget<TextField>(find.byKey(const Key('thread-composer'))).controller!.text;

    testWidgets('💬 는 단계 줄마다 늘 있고 누르는 자리는 44다. 누르면 시트가 닫히고 띠와 담당 멘션이 작성칸에 선다', (tester) async {
      await openSheet(tester, _Server());
      await tester.ensureVisible(find.byKey(const Key('plan-ask-s1')));
      await tester.pump();
      expect(tester.getSize(find.byKey(const Key('plan-ask-s1'))).height, greaterThanOrEqualTo(44));
      await ask(tester, 's1');
      expect(find.byKey(const Key('plan-sheet')), findsNothing);
      expect(find.byKey(const Key('plan-ask-bar')), findsOneWidget);
      expect(field(tester), '@builder ');
      expect(tester.widget<Text>(find.byKey(const Key('plan-ask-reason'))).data, '이 단계의 담당이라서');
    });

    testWidgets('보내면 맨 앞 멘션 뒤에 단계 링크가 실리고 띠가 사라진다', (tester) async {
      final s = _Server();
      await openSheet(tester, s);
      await ask(tester, 's4');
      await tester.enterText(find.byKey(const Key('thread-composer')), '@builder 왜 안 되나');
      await tester.pump();
      await tester.tap(find.byKey(const Key('thread-send')));
      await _settle(tester);
      await tester.pumpAndSettle();
      expect(s.lastPostBody, '@builder harkroom://plan/$_root/s4 「보안 검토」 왜 안 되나');
      expect(find.byKey(const Key('plan-ask-bar')), findsNothing);
    });

    testWidgets('✕ 는 띠와 채운 멘션을 함께 걷는다. 쓴 글은 남긴다', (tester) async {
      await openSheet(tester, _Server());
      await ask(tester, 's1');
      await tester.enterText(find.byKey(const Key('thread-composer')), '@builder 질문');
      await tester.pump();
      await tester.tap(find.byKey(const Key('plan-ask-close')));
      await tester.pump();
      expect(find.byKey(const Key('plan-ask-bar')), findsNothing);
      expect(field(tester), '질문');
    });

    testWidgets('받는 이를 바꾸면 맨 앞 멘션이 바뀌고, 없음이면 비운다', (tester) async {
      await openSheet(tester, _Server());
      await ask(tester, 's1');
      await tester.tap(find.byKey(const Key('plan-ask-to')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-ask-to-none')));
      await tester.pumpAndSettle();
      expect(field(tester), '');
      expect(find.byKey(const Key('plan-ask-reason')), findsNothing);
    });

    testWidgets('담당이 없으면 멘션을 채우지 않고 까닭을 쓴다', (tester) async {
      await openSheet(tester, _Server());
      await ask(tester, 's4');
      expect(field(tester), '');
      expect(tester.widget<Text>(find.byKey(const Key('plan-ask-reason'))).data, contains('담당이 없어'));
    });

    testWidgets('글 안 칩: 지금 상태, 제목이 다르면 표시, 지워짐, 볼 수 없음', (tester) async {
      final s = _Server();
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app);
      Future<void> chip(PlanRef r) async {
        await tester.pumpWidget(_host(app, Material(child: PlanRefChip(planRef: r))));
        await tester.pump();
      }
      await chip(const PlanRef(rootId: _root, stepId: 's4', title: '보안 검토'));
      expect(find.textContaining('s4 보안 검토', findRichText: true), findsOneWidget);
      expect(find.byKey(const Key('plan-ref-changed-s4')), findsNothing);
      await chip(const PlanRef(rootId: _root, stepId: 's4', title: '옛 제목'));
      expect(find.byKey(const Key('plan-ref-changed-s4')), findsOneWidget);
      await chip(const PlanRef(rootId: _root, stepId: 's99', title: '사라진 일'));
      expect(find.byKey(const Key('plan-ref-gone-s99')), findsOneWidget);
      app.threadPlanDenied.add('hidden-root');
      await chip(const PlanRef(rootId: 'hidden-root', stepId: 's1', title: '비밀 제목'));
      expect(find.byKey(const Key('plan-ref-hidden-s1')), findsOneWidget);
      expect(find.textContaining('비밀 제목', findRichText: true), findsNothing);
    });

    testWidgets('글 안의 단계 링크는 칩으로 그린다. 그릴 길이 없으면 글자로 남는다', (tester) async {
      final (app, _) = await tester.runAsync(() => _boot(_Server())) as (AppState, _Sock);
      await _button(tester, app);
      const body = '@x harkroom://plan/$_root/s4 「보안 검토」 왜?';
      await tester.pumpWidget(_host(app, Material(child: MarkdownBody(body, planRefChip: (ref) => PlanRefChip(planRef: ref)))));
      await tester.pump();
      expect(find.byKey(const Key('plan-ref-chip-s4')), findsOneWidget);
      await tester.pumpWidget(_host(app, const Material(child: MarkdownBody(body))));
      await tester.pump();
      expect(find.byKey(const Key('plan-ref-chip-s4')), findsNothing);
      expect(find.textContaining('harkroom://plan/', findRichText: true), findsOneWidget);
    });

    testWidgets('칩을 누르면 시트가 열리고 그 단계로 간다', (tester) async {
      final (app, _) = await tester.runAsync(() => _boot(_Server())) as (AppState, _Sock);
      await _button(tester, app);
      await tester.pumpWidget(_host(app, Material(child: PlanRefChip(planRef: const PlanRef(rootId: _root, stepId: 's4')))));
      await tester.pump();
      await tester.tap(find.byKey(const Key('plan-ref-chip-s4')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-sheet')), findsOneWidget);
    });
  });

  group('줄 누르기·관리 에이전트', () {
    Future<_Server> openWith(WidgetTester tester, Map<String, List<Map<String, Object?>>> links) async {
      final s = _Server()..fallback = () {
        final j = _planJson();
        final steps = ((j['doc']! as Map)['steps']! as List).cast<Map<String, Object?>>();
        links.forEach((id, l) => steps.firstWhere((x) => x['id'] == id)['links'] = l);
        return _json({'plan': j});
      };
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _button(tester, app);
      await tester.tap(find.byKey(const Key('plan-button-open')));
      await tester.pumpAndSettle();
      return s;
    }

    testWidgets('연결이 있는 줄만 줄 전체가 눌린다. 카드가 먼저고, 나머지는 작은 링크로 남는다', (tester) async {
      await openWith(tester, {'s6': [{'kind': 'pr', 'repo': 'acme/app', 'number': 7}, {'kind': 'message', 'id': 'm-1'}, {'kind': 'card', 'messageId': 'c-1'}]});
      await tester.ensureVisible(find.byKey(const Key('plan-step-s6')));
      expect(find.byKey(const Key('plan-row-s6')), findsOneWidget);
      expect(find.byKey(const Key('plan-row-s2')), findsNothing, reason: '연결이 없는 줄은 누르는 모양이 없다');
      expect(find.byKey(const Key('plan-row-go-card-s6')), findsOneWidget);
      expect(find.text('글 +1'), findsOneWidget);
    });

    testWidgets('막힌 줄은 누르면 까닭을 편다', (tester) async {
      await openWith(tester, const {});
      await tester.tap(find.byKey(const Key('plan-row-s1')), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-why-s1')), findsOneWidget);
    });

    testWidgets('내 차례인데 연결이 없으면 「연결 없음」을 쓴다', (tester) async {
      await openWith(tester, const {});
      await tester.ensureVisible(find.byKey(const Key('plan-step-s3')));
      expect(find.byKey(const Key('plan-row-nolink-s3')), findsOneWidget);
    });

    testWidgets('관리 조각은 메타 줄 끝에 붙고 누르는 자리는 44다. 320폭에서 넘치지 않는다', (tester) async {
      tester.view.physicalSize = const Size(320 * 3, 812 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await openWith(tester, const {});
      final meta = tester.getRect(find.byKey(const Key('plan-sheet-meta')));
      final edit = tester.getRect(find.byKey(const Key('plan-manager-edit')));
      expect(edit.left, greaterThanOrEqualTo(meta.right));
      expect((edit.center.dy - meta.center.dy).abs(), lessThan(1), reason: '같은 줄이다');
      expect(edit.height, greaterThanOrEqualTo(44));
      expect(tester.takeException(), isNull);
    });

    testWidgets('관리 에이전트를 바꾸거나 비운다', (tester) async {
      final s = await openWith(tester, const {});
      await tester.tap(find.byKey(const Key('plan-manager-edit')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-manager-pick-$_agent')));
      await _settle(tester);
      await tester.pumpAndSettle();
      expect(s.managerCalls.last, _agent);
      await tester.tap(find.byKey(const Key('plan-manager-edit')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-manager-none')));
      await _settle(tester);
      await tester.pumpAndSettle();
      expect(s.managerCalls.last, isNull);
    });
  });

  test('문구 — 데스크톱 plan.* 와 같은 말', () {
    final ko = stringsFor('ko');
    expect(ko.planPillBlocked('화면', 1, 3), '화면 막힘 1/3');
    expect(ko.planPillDone('서버'), '서버✓');
    expect(ko.planPillWaiting('출시'), '출시 대기');
    expect(ko.planPillWaitingCount('문서', 1, 3), '문서 대기 1/3');
    expect(ko.planPillActive('이관', 2, 0, 3), '이관 진행 2 · 0/3');
    expect(ko.planPillMine('사람', 3), '사람 내 차례 3');
    expect(ko.planReadyAfter, '앞 단계 끝남 · 시작 가능');
    expect(ko.planOpenLinked, '그 스레드 열기 →');
    expect(stringsFor('en').planPillBlocked('UI', 1, 3), 'UI blocked 1/3');
  });
}

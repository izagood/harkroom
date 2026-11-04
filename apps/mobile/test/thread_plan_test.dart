import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/api/thread_plan.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_tile.dart';
import 'package:harkroom/screens/thread_plan_sheet.dart';
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
          {'id': 's3', 'groupId': 'g2', 'title': '생성 워커', 'state': 'active', 'links': <Object?>[], 'dependsOn': <Object?>[]},
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

  MockClient client() => MockClient((req) async {
        final path = req.url.path;
        if (path.endsWith('/plan')) {
          planGets++;
          if (answers.isNotEmpty) return answers.removeAt(0)();
          return fallback();
        }
        if (path == '/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': 'Me', 'isAgent': false, 'isAdmin': false, 'mustChangePassword': false, 'avatarAttachmentId': null});
        }
        if (path == '/channels') {
          return _json({'channels': [{'id': 'c1', 'name': 'general', 'type': 'public'}]});
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        if (path.endsWith('/messages')) {
          final thread = req.url.queryParameters['thread'];
          if (thread != null || req.url.queryParameters.containsKey('limit')) return _json({'messages': [root()], 'hasMore': false});
          return _json({'messages': [root()], 'hasMore': false});
        }
        if (path == '/accounts') {
          return _json({'accounts': [
            {'id': _agent, 'handle': 'builder', 'displayName': 'builder', 'isAgent': true, 'isDisabled': false},
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

/// 띠만 세운 화면 — 탭하면 시트가 열린다.
Future<void> _band(WidgetTester tester, AppState app, {double width = 375}) async {
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
          return ThreadPlanBand(rootId: _root, progress: row.planProgress);
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

  group('판정(데스크톱과 같은 규칙)', () {
    test('알약 정렬 — 막힘·진행·대기·볼 수 없음·끝남, 같은 순위는 문서 순서', () {
      final ids = planPills(_view()).map((p) => p.id).toList();
      expect(ids, ['g1', 'g2', 'g4', 'g3', 'g5']);
    });

    test('넷 이상이면 요약', () {
      final s = planSummary(planPills(_view()))!;
      expect((s.groups, s.active, s.blocked, s.firstBlocked), (5, 2, 1, '화면'));
      expect(planSummary(planPills(_view()).take(3).toList()), isNull);
    });

    test('흐름 — 앞 그룹이 끝나야 하는 그룹은 다음 층', () {
      final layers = planFlow(_view());
      expect(layers.first, ['g1', 'g2', 'g4', 'g5']);
      expect(layers.last, ['g3']);
    });

    test('「앞: 그룹 · X」 는 그룹을 넘을 때만', () {
      final p = _view();
      expect(crossGroupTitle(p, 's1', 'g3'), '화면');
      expect(crossGroupTitle(p, 's1', 'g1'), isNull);
      expect(crossGroupTitle(p, 'g1', 'g3'), isNull);
    });

    test('연결 그룹의 수는 자식 진행률, 볼 수 없으면 null', () {
      final p = _view();
      expect(groupCount(p, p.groups[3]), (done: 1, total: 4));
      expect(groupCount(p, p.groups[4]), isNull);
    });

    test('막힘·진행 그룹만 펼쳐 시작한다', () {
      expect(PlanState.values.where(planGroupStartsOpen).toSet(), {PlanState.blocked, PlanState.active});
    });

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

  group('띠', () {
    testWidgets('planProgress 가 없으면 띠도 GET 도 없다', (tester) async {
      final s = _Server()..root = () => _rootRow(plan: null);
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _band(tester, app);
      expect(find.byKey(const Key('plan-band')), findsNothing);
      expect(s.planGets, 0);
    });

    testWidgets('한 번만 받고, 판을 받으면 개인 진행률·목표·막힌 알약·+n·요약을 그린다', (tester) async {
      final s = _Server();
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _band(tester, app);
      expect(s.planGets, 1);
      expect(find.text('계획 2/7 · 막힘 1'), findsOneWidget, reason: '판을 받은 뒤의 띠 칩은 개인 진행률이다');
      expect(find.text('파일 미리보기 출시'), findsOneWidget);
      // 그룹 다섯 → 요약.
      expect(find.byKey(const Key('plan-summary')), findsOneWidget);
    });

    for (final width in [320.0, 375.0]) {
      testWidgets('그룹이 넷 이상이어도 $width pt 에서 목표 자리가 요약의 두 배 이상이다', (tester) async {
        final (app, _) = await tester.runAsync(() => _boot(_Server())) as (AppState, _Sock);
        await _band(tester, app, width: width);
        final goal = tester.getSize(find.byKey(const Key('plan-band-goal'))).width;
        final summary = tester.getSize(find.byKey(const Key('plan-summary'))).width;
        expect(goal, greaterThanOrEqualTo(summary * 2 - 12), reason: '요약 $summary · 목표 $goal');
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('폰 폭의 요약은 진행 수를 빼고 막힌 이름을 남긴다', (tester) async {
      final (app, _) = await tester.runAsync(() => _boot(_Server())) as (AppState, _Sock);
      await _band(tester, app);
      final text = tester.widget<Text>(find.byKey(const Key('plan-summary'))).textSpan!.toPlainText();
      expect(text, '그룹 5 · 막힘 1 (화면)');
    });

    test('요약 폭은 칩을 뺀 자리의 1/3, 자리가 없으면 0', () {
      expect(PlanBandLayout.summaryMax(screen: 375, chip: 140), closeTo(61.67, 0.01));
      expect(PlanBandLayout.summaryMax(screen: 100, chip: 200), 0);
      expect(PlanBandLayout.shortSummary(375), isTrue);
      expect(PlanBandLayout.shortSummary(768), isFalse);
    });

    testWidgets('rev 가 바뀌면 다시 받고, 실패해도 띠는 행 값으로 서 있다', (tester) async {
      final s = _Server();
      final (app, sock) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      s.fallback = () => _json({'error': 'x'}, 500);
      await _band(tester, app);
      expect(find.text('계획 1/5 · 막힘 1'), findsOneWidget);
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

    testWidgets('지워지면 띠가 사라지고 판도 버린다', (tester) async {
      final s = _Server();
      final (app, sock) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _band(tester, app);
      await tester.runAsync(() async {
        _emit(sock, {'type': 'thread.plan.changed', 'channelId': 'c1', 'rootId': _root, 'rev': null, 'progress': null, 'audience': 'all'});
        await Future<void>.delayed(const Duration(milliseconds: 5));
      });
      await _settle(tester);
      expect(find.byKey(const Key('plan-band')), findsNothing);
      expect(app.threadPlans[_root], isNull);
    });
  });

  group('시트', () {
    Future<AppState> open(WidgetTester tester, _Server s) async {
      final (app, _) = await tester.runAsync(() => _boot(s)) as (AppState, _Sock);
      await _band(tester, app);
      await tester.tap(find.byKey(const Key('plan-band-open')));
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

    testWidgets('막힘·진행 그룹만 펼치고 대기는 접되 ⏳ 는 보인다', (tester) async {
      await open(tester, _Server());
      expect(find.byKey(const Key('plan-step-s1')), findsOneWidget);
      expect(find.byKey(const Key('plan-step-s3')), findsOneWidget);
      expect(find.byKey(const Key('plan-step-s5')), findsNothing);
      expect(find.byKey(const Key('plan-waiting-g1')), findsOneWidget);
    });

    testWidgets('펼침은 기억하지 않는다', (tester) async {
      await open(tester, _Server());
      await tester.tap(find.byKey(const Key('plan-group-g3')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-step-s5')), findsOneWidget);
      await tester.tap(find.byKey(const Key('plan-sheet-close')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-band-open')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-step-s5')), findsNothing);
    });

    testWidgets('「⏳ 앞:」 을 누르면 접힌 그룹을 펴지 않아도 그 자리로 가 깜빡인다', (tester) async {
      await open(tester, _Server());
      await tester.tap(find.byKey(const Key('plan-group-g1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-step-s1')), findsNothing);
      await tester.ensureVisible(find.byKey(const Key('plan-waiting-g1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('plan-waiting-g1')));
      await tester.pump();
      expect(find.byKey(const ValueKey('plan-flash-g1-1')), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
    });

    testWidgets('단계로 가면 접힌 그룹을 편다', (tester) async {
      await open(tester, _Server());
      // s5 의 앞(s1)은 다른 그룹이라 「화면 · 카드 구현」 으로 쓴다.
      await tester.ensureVisible(find.byKey(const Key('plan-group-g3')));
      await tester.tap(find.byKey(const Key('plan-group-g3')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('plan-step-s5')));
      expect(find.textContaining('화면 · 카드 구현'), findsOneWidget);
      // 앞 단계의 그룹을 접어 둔 뒤 ⏳ 로 간다.
      await tester.ensureVisible(find.byKey(const Key('plan-group-g1')));
      await tester.tap(find.byKey(const Key('plan-group-g1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plan-step-s1')), findsNothing);
      await tester.ensureVisible(find.byKey(const Key('plan-waiting-s1')).last);
      await tester.tap(find.byKey(const Key('plan-waiting-s1')).last);
      await tester.pump();
      expect(find.byKey(const Key('plan-step-s1')), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
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
      expect(find.text('앞 단계 끝남 · 시작 가능'), findsOneWidget);
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
      expect(find.byKey(const Key('plan-flow')), findsOneWidget);
    });

    testWidgets('열려 있는 동안 판이 바뀌면 그 자리에서 고친다', (tester) async {
      final s = _Server();
      final app = await open(tester, s);
      s.fallback = () => _json({'plan': _planJson(rev: 4, goal: '바뀐 목표')});
      await tester.runAsync(() => app.loadThreadPlan(_root));
      await tester.pump();
      expect(find.byKey(const Key('plan-sheet-goal')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('plan-sheet-goal'))).data, '바뀐 목표');
    });
  });

  test('문구 — 데스크톱 plan.* 와 같은 말', () {
    final ko = stringsFor('ko');
    expect(ko.planPillBlocked('화면', 1, 3), '화면 막힘 1/3');
    expect(ko.planPillDone('서버'), '서버✓');
    expect(ko.planPillWaiting('출시'), '출시 대기');
    expect(ko.planPillWaitingCount('문서', 1, 3), '문서 대기 1/3');
    expect(ko.planReadyAfter, '앞 단계 끝남 · 시작 가능');
    expect(ko.planOpenLinked, '그 스레드 열기 →');
    expect(stringsFor('en').planPillBlocked('UI', 1, 3), 'UI blocked 1/3');
  });
}

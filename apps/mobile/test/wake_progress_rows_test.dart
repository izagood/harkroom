import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/agent_meta.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_feed.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/screens/message_tile.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:harkroom/time.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final _now = DateTime.now().toUtc();
DateTime _ago(int minutes) => _now.subtract(Duration(minutes: minutes));
DateTime _in(int minutes) => _now.add(Duration(minutes: minutes));

MessageRow _row(
  int seq,
  String kind, {
  String author = 'a1',
  String body = 'x',
  DateTime? at,
  Map<String, Object?> meta = const {},
  List<Map<String, Object?>> reactions = const [],
}) =>
    MessageRow.fromJson({
      'id': 'm$seq',
      'seq': seq,
      'channelId': 'c1',
      'authorId': author,
      'body': body,
      'kind': kind,
      'meta': meta,
      'reactions': reactions,
      'createdAt': (at ?? _ago(100 - seq)).toIso8601String(),
    });

MessageRow _wake(
  int seq, {
  required DateTime wakeAt,
  String author = 'a1',
  String reason = '사유',
  DateTime? at,
  DateTime? firedAt,
  DateTime? canceledAt,
  DateTime? checkedAt,
  List<Map<String, Object?>> reactions = const [],
}) =>
    _row(seq, 'wake', author: author, body: reason, at: at, reactions: reactions, meta: {
      'kind': 'wake',
      'wake': {
        'wakeAt': wakeAt.toIso8601String(),
        'reason': reason,
        if (firedAt != null) 'firedAt': firedAt.toIso8601String(),
        if (canceledAt != null) 'canceledAt': canceledAt.toIso8601String(),
        if (checkedAt != null) 'checkedAt': checkedAt.toIso8601String(),
      },
    });

Future<void> _pump(WidgetTester tester, Widget Function(BuildContext) builder, {String locale = 'ko'}) async {
  final state = AppState(
    sessions: SessionStore.inMemory(),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: MockClient((_) async => http.Response('{}', 404))),
    connector: (Uri _) async => throw StateError('소켓을 열지 않는다'),
  );
  addTearDown(state.dispose);
  await tester.pumpWidget(MaterialApp(
    theme: harkroomTheme(Brightness.light),
    home: I18n(
      strings: stringsFor(locale),
      child: AppScope(state: state, child: Scaffold(body: Builder(builder: builder))),
    ),
  ));
}

/// 줄의 글자. 아이콘도 RichText 라 사적 영역 글자는 뺀다.
String _text(WidgetTester tester, Finder within) => tester
    .widgetList<RichText>(find.descendant(of: within, matching: find.byType(RichText)))
    .map((r) => r.text.toPlainText())
    .where((s) => !s.runes.any((c) => c >= 0xE000 && c <= 0xF8FF))
    .join(' ');

void main() {
  group('예약 줄 상태', () {
    WakeState stateOf(MessageRow m) => wakeStateOfRow(m, _now)!;

    test('위의 사실이 이긴다 — 확인 > 접힘 > 깨어남', () {
      expect(stateOf(_wake(1, wakeAt: _ago(5), firedAt: _ago(5), canceledAt: _ago(4), checkedAt: _ago(3))), WakeState.checked);
      expect(stateOf(_wake(1, wakeAt: _ago(5), firedAt: _ago(5), canceledAt: _ago(4))), WakeState.canceled);
      expect(stateOf(_wake(1, wakeAt: _in(30), firedAt: _ago(1))), WakeState.fired);
    });

    test('줄 주인의 ✅만 확인이다 — 남이 단 ✅는 아니다', () {
      expect(
        stateOf(_wake(1, wakeAt: _ago(5), reactions: [
          {'emoji': '✅', 'accountIds': ['a1']}
        ])),
        WakeState.checked,
      );
      expect(
        stateOf(_wake(1, wakeAt: _in(30), reactions: [
          {'emoji': '✅', 'accountIds': ['human']}
        ])),
        WakeState.waiting,
      );
    });

    test('「곧」은 남은 1분 미만 ~ 지난 지 2분 안이다', () {
      final at = DateTime.utc(2026, 11, 6, 12);
      WakeState s(Duration d) => WakeMeta(wakeAt: at).stateAt(at.subtract(d));
      expect(s(const Duration(minutes: 1)), WakeState.waiting);
      expect(s(const Duration(seconds: 59)), WakeState.soon);
      expect(s(Duration.zero), WakeState.soon);
      expect(s(const Duration(minutes: -1, seconds: -59)), WakeState.soon);
      expect(s(const Duration(minutes: -2)), WakeState.passed);
    });

    test('모르는 시각은 없는 것으로 읽는다', () {
      final w = WakeMeta.read({
        'kind': 'wake',
        'wake': {'wakeAt': _in(30).toIso8601String(), 'firedAt': '잘못된 값', 'canceledAt': 3},
      })!;
      expect(w.firedAt, isNull);
      expect(w.canceledAt, isNull);
      expect(w.stateAt(_now), WakeState.waiting);
    });
  });

  group('절대 시각', () {
    test('오늘이면 시각만, 다른 날이면 날짜까지', () {
      final now = DateTime(2026, 11, 6, 22);
      expect(stampLabel(DateTime(2026, 11, 6, 9, 5), now), '09:05');
      expect(stampLabel(DateTime(2026, 11, 5, 21, 55), now), '11/05 21:55');
    });
  });

  group('진행의 끝', () {
    FeedProgressRun first(List<FeedItem> f) => f.whereType<FeedProgressRun>().first;

    test('뒤에 내 글이 없으면 아직 돈다', () {
      final run = first(buildFeed([_row(1, 'progress')]));
      expect(run.ended, isFalse);
      expect(run.endedAt, isNull);
    });

    test('같은 작성자의 다음 글이 끝이다 — 사이에 남의 글이 끼어도 찾아간다', () {
      final mine = _row(3, 'user', at: _ago(2));
      final run = first(buildFeed([_row(1, 'progress', at: _ago(9)), _row(2, 'user', author: 'other'), mine]));
      expect(run.endedAt, mine.createdAt);
    });

    test('남의 글로는 끝나지 않는다', () {
      expect(first(buildFeed([_row(1, 'progress'), _row(2, 'user', author: 'other')])).ended, isFalse);
    });

    test('대기 줄도 내 글이다', () {
      expect(first(buildFeed([_row(1, 'progress'), _wake(2, wakeAt: _in(30))])).ended, isTrue);
    });

    test('러너의 침묵 종료 알림은 뒤에 글이 없어도 끝났고, 길이는 모른다', () {
      final run = first(buildFeed([_row(1, 'progress', body: '(예약된 확인 턴이 발화 없이 끝났습니다 — 하네스의 마지막 말: "x")')]));
      expect(run.ended, isTrue);
      expect(run.endedAt, isNull);
    });
  });

  group('지난 줄 묶기', () {
    List<FeedItem> fold(List<MessageRow> rows) => foldPastRuns(buildFeed(rows), _now);

    test('21:53 그 화면 — 끝난 3줄이 한 묶음, 살아 있는 대기는 그 뒤에 따로 선다', () {
      final out = fold([
        _wake(1, wakeAt: _ago(4), firedAt: _ago(4)),
        _row(2, 'progress', body: '(예약된 확인 턴이 발화 없이 끝났습니다)'),
        _wake(3, wakeAt: _in(2)),
        _row(4, 'progress', body: '(예약된 확인 턴이 발화 없이 끝났습니다)'),
      ]);
      expect(out, hasLength(2));
      expect((out[0] as FeedPastRun).rows.map((m) => m.seq), [1, 2, 4]);
      expect((out[1] as FeedMessage).message.seq, 3);
    });

    test('끝난 줄이 하나뿐이면 묶지 않는다', () {
      final out = fold([_wake(1, wakeAt: _ago(10), firedAt: _ago(10))]);
      expect(out.single, isA<FeedMessage>());
    });

    test('보통 글이 끊는다', () {
      final out = fold([
        _wake(1, wakeAt: _ago(10), firedAt: _ago(10)),
        _row(2, 'user', author: 'human'),
        _wake(3, wakeAt: _ago(9), firedAt: _ago(9)),
      ]);
      expect(out.whereType<FeedPastRun>(), isEmpty);
      expect(out, hasLength(3));
    });

    test('다른 작성자가 끊는다', () {
      final out = fold([
        _wake(1, wakeAt: _ago(10), firedAt: _ago(10)),
        _wake(2, wakeAt: _ago(9), firedAt: _ago(9)),
        _wake(3, wakeAt: _ago(8), firedAt: _ago(8), author: 'a2'),
        _wake(4, wakeAt: _ago(7), firedAt: _ago(7), author: 'a2'),
      ]);
      expect(out.map((i) => (i as FeedPastRun).rows.first.authorId), ['a1', 'a2']);
    });

    test('아직 도는 진행이 끊는다', () {
      final out = fold([
        _wake(1, wakeAt: _ago(10), firedAt: _ago(10), author: 'a2'),
        _row(2, 'progress'),
        _wake(3, wakeAt: _ago(9), firedAt: _ago(9), author: 'a2'),
      ]);
      expect(out.whereType<FeedPastRun>(), isEmpty);
      expect(out, hasLength(3));
    });

    test('날짜 줄이 끊는다', () {
      final out = foldPastRuns([
        FeedMessage(_wake(1, wakeAt: _ago(10), firedAt: _ago(10))),
        FeedMessage(_wake(2, wakeAt: _ago(9), firedAt: _ago(9)), dayBreak: true),
      ], _now);
      expect(out.whereType<FeedPastRun>(), isEmpty);
    });

    test('줄을 잃지도 순서를 넘기지도 않는다 — 살아 있는 줄만 묶음 뒤로 간다', () {
      final out = fold([
        _row(1, 'user', author: 'human'),
        _wake(2, wakeAt: _ago(10), firedAt: _ago(10)),
        _wake(3, wakeAt: _ago(9), canceledAt: _ago(9)),
        _row(4, 'user', author: 'human'),
      ]);
      final seqs = [
        for (final i in out)
          ...switch (i) {
            FeedPastRun(:final rows) => rows.map((m) => m.seq),
            FeedMessage(:final message) => [message.seq],
            _ => <int>[],
          },
      ];
      expect(seqs, [1, 2, 3, 4]);
    });
  });

  group('그림', () {
    Future<String> wakeText(WidgetTester tester, MessageRow m, {String locale = 'ko'}) async {
      await _pump(tester, (c) => buildFeedItem(c, FeedMessage(m)), locale: locale);
      return _text(tester, find.byKey(Key('wake-${m.id}')));
    }

    testWidgets('기다리는 줄은 절대 시각 + 남은 시간, 두 줄까지', (tester) async {
      final at = _in(12);
      final text = await wakeText(tester, _wake(1, wakeAt: at));
      expect(text, startsWith('${stampLabel(at, _now)} 에 다시 본다 · '));
      expect(text, contains('분 뒤 — 사유'));
      expect(text, isNot(contains('대기 중')));
      expect(tester.widget<Text>(find.descendant(of: find.byKey(const Key('wake-m1')), matching: find.byType(Text))).maxLines, 2);
    });

    testWidgets('곧', (tester) async {
      expect(await wakeText(tester, _wake(1, wakeAt: _ago(1))), contains('에 다시 본다 · 곧'));
    });

    testWidgets('깨어남은 깨어난 시각으로, 한 줄', (tester) async {
      final fired = _ago(3);
      final text = await wakeText(tester, _wake(1, wakeAt: _ago(5), firedAt: fired));
      expect(text, startsWith('${stampLabel(fired, _now)} 에 다시 봄'));
      expect(tester.widget<Text>(find.descendant(of: find.byKey(const Key('wake-m1')), matching: find.byType(Text))).maxLines, 1);
    });

    testWidgets('접힘·지남은 예약 시각으로, 확인은 확인 시각으로', (tester) async {
      final wakeAt = _ago(30);
      final checked = _ago(5);
      expect(await wakeText(tester, _wake(1, wakeAt: wakeAt, canceledAt: _ago(40))), startsWith('${stampLabel(wakeAt, _now)} 예약 · 접힘'));
      expect(find.byKey(const Key('wake-icon-canceled')), findsOneWidget);
      expect(await wakeText(tester, _wake(2, wakeAt: wakeAt)), startsWith('${stampLabel(wakeAt, _now)} 예약 · 지남'));
      expect(await wakeText(tester, _wake(3, wakeAt: wakeAt, checkedAt: checked)), startsWith('${stampLabel(checked, _now)} 확인 · 새로 없음'));
      expect(find.byKey(const Key('wake-icon-checked')), findsOneWidget);
    });

    testWidgets('✅만 있고 시각이 없으면 시각 없이 말한다', (tester) async {
      final text = await wakeText(tester, _wake(1, wakeAt: _ago(30), reactions: [
        {'emoji': '✅', 'accountIds': ['a1']}
      ]));
      expect(text, startsWith('확인함 · 새로 없음'));
    });

    testWidgets('사유가 비면 「—」도 뺀다', (tester) async {
      expect(await wakeText(tester, _wake(1, wakeAt: _ago(30), reason: ' ')), isNot(contains('—')));
    });

    testWidgets('영어 문구', (tester) async {
      expect(await wakeText(tester, _wake(1, wakeAt: _ago(30), canceledAt: _ago(40)), locale: 'en'), contains('· canceled'));
    });

    testWidgets('끝난 진행은 회전 표시 없이 회색 점과 걸린 시간', (tester) async {
      final run = FeedProgressRun([_row(1, 'progress', body: '일', at: _ago(9))], endedAt: _ago(4));
      await _pump(tester, (c) => buildFeedItem(c, run));
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byKey(const Key('progress-dot-m1')), findsOneWidget);
      final text = _text(tester, find.byKey(const Key('progress-m1')));
      expect(text, contains('작업 · 5분 걸림 — 일'));
      expect(text, isNot(contains('작업 중')));
    });

    testWidgets('길이를 모르면 「작업 · 끝남」', (tester) async {
      final run = FeedProgressRun([_row(1, 'progress', body: '일')], silentEnd: true);
      await _pump(tester, (c) => buildFeedItem(c, run));
      expect(_text(tester, find.byKey(const Key('progress-m1'))), contains('작업 · 끝남 — 일'));
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('알림 줄은 뒤에 글이 있어도 길이를 말하지 않는다 — 그 시간은 턴 길이가 아니다', (tester) async {
      final items = buildFeed([
        _row(1, 'progress', body: '(예약된 확인 턴이 발화 없이 끝났습니다)', at: _ago(9)),
        _wake(2, wakeAt: _in(30), at: _ago(3)),
      ]);
      expect((items.first as FeedProgressRun).endedAt, isNotNull);
      await _pump(tester, (c) => buildFeedItem(c, items.first));
      final text = _text(tester, find.byKey(const Key('progress-m1')));
      expect(text, contains('작업 · 끝남'));
      expect(text, isNot(contains('걸림')));
    });

    testWidgets('도는 진행은 그대로 회전 표시', (tester) async {
      final run = FeedProgressRun([_row(1, 'progress', body: '일', at: _ago(2))]);
      await _pump(tester, (c) => buildFeedItem(c, run));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(_text(tester, find.byKey(const Key('progress-m1'))), contains('작업 중 · 2분째 — 일'));
    });

    testWidgets('묶음은 접혀서 서고 누르면 원래 순서로 펼친다 — 작성자는 머리에만', (tester) async {
      final run = foldPastRuns(
        buildFeed([
          _wake(1, wakeAt: _ago(10), firedAt: _ago(10), reason: '첫 예약', at: _ago(20)),
          _row(2, 'progress', body: '(예약된 확인 턴이 발화 없이 끝났습니다)', at: _ago(15)),
        ]),
        _now,
      ).single as FeedPastRun;
      var open = false;
      await _pump(
        tester,
        (c) => StatefulBuilder(
          builder: (c, set) => buildPastRun(c, run, open: open, onToggle: () => set(() => open = !open)),
        ),
      );
      final header = find.byKey(const Key('past-run-m1'));
      expect(_text(tester, header), contains('지난 예약·확인 2줄 · ${clockLabel(_ago(20))}–${clockLabel(_ago(15))}'));
      expect(find.byKey(const Key('wake-m1')), findsNothing);

      await tester.tap(header);
      await tester.pump();
      expect(find.byKey(const Key('wake-m1')), findsOneWidget);
      expect(_text(tester, find.byKey(const Key('progress-m2'))), startsWith('작업'));
      expect(find.byIcon(Icons.expand_more), findsOneWidget);
      // 펼치면 지난 줄도 두 줄까지 읽힌다.
      expect(tester.widget<Text>(find.descendant(of: find.byKey(const Key('wake-m1')), matching: find.byType(Text))).maxLines, 2);

      await tester.tap(header);
      await tester.pump();
      expect(find.byKey(const Key('wake-m1')), findsNothing);
    });

    testWidgets('묶음 머리는 스크린 리더에 「펼치기」로 읽힌다', (tester) async {
      final handle = tester.ensureSemantics();
      final run = FeedPastRun([FeedMessage(_wake(1, wakeAt: _ago(10), firedAt: _ago(10))), FeedMessage(_wake(2, wakeAt: _ago(9), firedAt: _ago(9)))]);
      await _pump(tester, (c) => buildPastRun(c, run, open: false, onToggle: () {}));
      expect(find.bySemanticsLabel(RegExp(r'지난 예약·확인 2줄, 펼치기$')), findsOneWidget);
      handle.dispose();
    });

    testWidgets('묶음이 날짜 줄을 먹지 않는다', (tester) async {
      final run = FeedPastRun([
        FeedMessage(_wake(1, wakeAt: _ago(10), firedAt: _ago(10)), dayBreak: true),
        FeedMessage(_wake(2, wakeAt: _ago(9), firedAt: _ago(9))),
      ]);
      await _pump(tester, (c) => buildPastRun(c, run, open: false, onToggle: () {}));
      expect(find.byType(DayDivider), findsOneWidget);
    });

    testWidgets('펼친 대기 줄에도 화면의 표식이 씌워진다', (tester) async {
      final run = FeedPastRun([FeedMessage(_wake(1, wakeAt: _ago(10), firedAt: _ago(10))), FeedMessage(_wake(2, wakeAt: _ago(9), firedAt: _ago(9)))]);
      await _pump(tester, (c) => buildPastRun(c, run, open: true, onToggle: () {}, mark: (id, row) => id == 'm2' ? KeyedSubtree(key: const Key('hit'), child: row) : row));
      expect(find.descendant(of: find.byKey(const Key('hit')), matching: find.byKey(const Key('wake-m2'))), findsOneWidget);
    });
  });
}

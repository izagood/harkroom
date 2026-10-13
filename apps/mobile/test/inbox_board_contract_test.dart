import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/inbox_board.dart';
import 'package:harkroom/api/models.dart';

/// Inbox 보드 판정의 **계약** — 데스크톱(TS, 원본)과 같은 표를 읽어 같은 답을 내는지 잰다.
///
/// 표는 `packages/desktop/test/inboxBoardCases.test.ts` 가 **지금 TS 구현으로** 뽑은
/// `packages/desktop/test/fixtures/inboxBoardCases.json` 하나다(사본을 두면 계약이 아니다). 입력은 서버가 보내는
/// 그대로의 JSON 이라 `InboxEntry.fromJson`·`BoardHead.fromJson` 읽기도 함께 잰다.
///
/// 이 경로는 저장소의 두 최상위를 건너뛴다(`apps/mobile/test` → `packages/desktop/test`) — 멘션 계약
/// (`mention_test.dart`)과 같은 이유로 **의도한 것**이다.
File _fixtureFile() {
  const path = '../../packages/desktop/test/fixtures/inboxBoardCases.json';
  final file = File(path);
  if (!file.existsSync()) {
    fail('Inbox 보드 계약 표를 못 찾았다: $path\n'
        'TS 쪽에서 옮겼거나 지웠다면 이 시험도 함께 고쳐라 — 표가 사라지면 Dart 포팅을 지키는 것이 아무것도 없다.');
  }
  return file;
}

Map<String, Object?> _cardOut(BoardCard c) => {
      'rootId': c.rootId,
      'channelId': c.channelId,
      'column': c.column.name,
      'fold': c.fold?.name,
      'entryIds': [for (final e in c.entries) e.messageId],
      'summary': c.summary,
      'whoId': c.whoId,
      'sinceAt': c.sinceAt.millisecondsSinceEpoch,
      'lastActivityAt': c.lastActivityAt.millisecondsSinceEpoch,
      'unread': c.unread,
      'ask': c.ask == null
          ? null
          : {
              'messageId': c.ask!.messageId,
              'options': [for (final o in c.ask!.options) {'id': o.id, 'label': o.label}],
            },
      'laterUntil': c.laterUntil?.millisecondsSinceEpoch,
      'kind': c.kind.name,
      'similarKey': c.similarKey,
      'replyCount': c.replyCount,
    };

void main() {
  final fixture = jsonDecode(_fixtureFile().readAsStringSync()) as Map<String, Object?>;
  final nowMs = fixture['nowMs']! as int;
  final agentIds = (fixture['agentIds']! as List).cast<String>().toSet();
  final cases = (fixture['cases']! as List).cast<Map<String, Object?>>();

  test('표가 비어 있지 않다 — 비면 이 계약은 아무것도 지키지 않는다', () {
    expect(cases.length, greaterThan(20));
  });

  group('buildBoard · groupSimilar · mineCount', () {
    for (final c in cases) {
      test(c['name']! as String, () {
        final input = c['input']! as Map<String, Object?>;
        final expected = c['expected']! as Map<String, Object?>;
        final rawMe = input['me'] as Map<String, Object?>?;
        final rawThreads = input['threads'] as List?;
        final cards = buildBoard(
          entries: [
            for (final e in input['entries']! as List) InboxEntry.fromJson(Map<String, Object?>.from(e as Map)),
          ],
          threads: rawThreads == null
              ? null
              : [for (final m in rawThreads) BoardHead.fromJson(Map<String, Object?>.from(m as Map))],
          me: rawMe == null ? null : BoardMe(id: rawMe['id']! as String, isHuman: rawMe['kind'] == 'human'),
          threadStates: [
            for (final s in input['threadStates']! as List) InboxThreadState.fromJson(s)!,
          ],
          isAgent: agentIds.contains,
          nowMs: nowMs,
        );
        // 카드 한 장씩 견준다 — 통째로 견주면 어느 카드의 어느 칸이 갈렸는지 안 보인다.
        final want = (expected['cards']! as List).cast<Map<String, Object?>>();
        expect(cards.map((x) => x.rootId).toList(), want.map((x) => x['rootId']).toList(), reason: '카드 순서');
        for (var i = 0; i < want.length; i++) {
          expect(_cardOut(cards[i]), want[i], reason: '카드 ${want[i]['rootId']}');
        }
        expect(
          [for (final g in groupSimilar(cards)) [g.card.rootId, ...g.similar.map((x) => x.rootId)]],
          expected['groups'],
          reason: '묶음',
        );
        expect(mineCount(cards), expected['mineCount'], reason: '내 차례 수');
      });
    }
  });

  test('oneSentence', () {
    for (final row in (fixture['oneSentence']! as List).cast<Map<String, Object?>>()) {
      expect(oneSentence(row['body']! as String), row['sentence'], reason: jsonEncode(row['body']));
    }
  });

  test('daysWaiting', () {
    for (final row in (fixture['daysWaiting']! as List).cast<Map<String, Object?>>()) {
      expect(daysWaiting(DateTime.parse(row['sinceAt']! as String), nowMs), row['days'], reason: '${row['sinceAt']}');
    }
  });

  group('InboxBoardData.fromJson (간추린 판)', () {
    test('잘린 본문 끝의 반쪽 멘션을 뗀다 — 항목은 bodyTruncated 일 때만, 머리는 늘', () {
      final data = InboxBoardData.fromJson({
        'entries': [
          {'id': 1, 'messageId': 'm1', 'reason': 'mention', 'channelId': 'c1', 'authorId': 'a', 'body': '앞 <@abc',
            'createdAt': '2026-10-01T00:00:00.000Z', 'threadRootId': null, 'readAt': null, 'bodyTruncated': true},
          {'id': 2, 'messageId': 'm2', 'reason': 'mention', 'channelId': 'c1', 'authorId': 'a', 'body': '그대로 <@abc',
            'createdAt': '2026-10-01T00:00:00.000Z', 'threadRootId': null, 'readAt': null},
        ],
        'threads': [
          {'id': 'r1', 'channelId': 'c1', 'authorId': 'a', 'body': '머리 <@x', 'createdAt': '2026-10-01T00:00:00.000Z'},
        ],
        'threadStates': [
          {'rootId': 'r1', 'state': 'later', 'until': '2026-10-02T00:00:00.000Z', 'updatedAt': '2026-10-01T00:00:00.000Z'},
          {'rootId': 'r2', 'state': 'weird', 'updatedAt': '2026-10-01T00:00:00.000Z'},
        ],
        'truncated': true,
      });
      expect(data.entries.map((e) => e.body), ['앞 ', '그대로 <@abc']);
      expect(data.threads!.single.body, '머리 ');
      expect(data.threadStates.map((s) => s.rootId), ['r1'], reason: '모르는 상태는 버린다');
      expect(data.truncated, isTrue);
    });

    test('옛 서버 — threads 가 없으면 null(항목 meta 로 판정한다)', () {
      final data = InboxBoardData.fromJson({'entries': <Object?>[]});
      expect(data.threads, isNull);
      expect(data.threadStates, isEmpty);
    });
  });
}

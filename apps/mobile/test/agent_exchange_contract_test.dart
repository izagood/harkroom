import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/screens/agent_exchange.dart';

/// **주고받기 접힘 계약.** 데스크톱 시험(`packages/desktop/test/exchangeFoldContract.test.ts`)이 지금
/// 구현으로 뽑은 표를 그대로 읽어, 모바일 포팅이 **같은 글을 접는지** 본다.
///
/// 표가 `apps/mobile/test/` 안에 있지 않은 이유는 멘션 계약(`mention_test.dart`)과 같다 —
/// 사본이 둘이 되는 순간 이 계약은 아무것도 지키지 못한다. 이 시험이 빨개지면 데스크톱 판정이
/// 바뀐 것이다: `lib/screens/agent_exchange.dart` 를 같이 고쳐라.
File _fixtureFile() {
  // `flutter test` 의 작업 디렉터리는 패키지 루트(`apps/mobile`)다.
  const path = '../../packages/desktop/test/fixtures/exchangeFoldCases.json';
  final file = File(path);
  if (!file.existsSync()) {
    fail('주고받기 접힘 표를 못 찾았다: $path\n'
        '데스크톱 쪽에서 옮겼거나 지웠다면 이 시험도 함께 고쳐라.');
  }
  return file;
}

Object? _encodeSlot(FoldSlot s) => switch (s) {
      FoldMessage(:final message) => {'message': message.id},
      FoldProgress(:final messages, :final endedAt) => {
          'progress': [for (final m in messages) m.id],
          'endedAt': endedAt?.toUtc().toIso8601String(),
        },
      FoldExchange(:final messages, :final items) => {
          'exchange': [for (final it in items) _encodeSlot(it)],
          'participants': exchangeParticipants(messages),
          'conclusion': switch (exchangeConclusion(messages)) {
            null => null,
            final c => {'source': c.source.name, 'text': c.text},
          },
          'lastLine': switch (exchangeLastLine(messages, (m) => m.body)) {
            null => null,
            ExchangeLastLine(:final authorId, :final text?) => {'authorId': authorId, 'text': text},
            ExchangeLastLine(:final authorId, :final attachments) => {'authorId': authorId, 'attachments': attachments},
          },
        },
    };

void main() {
  final fixture = jsonDecode(_fixtureFile().readAsStringSync()) as Map<String, Object?>;
  final agents = (fixture['agents']! as List).cast<String>().toSet();
  final cases = (fixture['cases']! as List).cast<Map<String, Object?>>();
  final firstLines = (fixture['firstLines']! as List).cast<Map<String, Object?>>();

  test('표가 비어 있지 않다', () {
    expect(cases.length, greaterThan(30));
    expect(firstLines.length, greaterThan(20));
  });

  group('접히는 글이 데스크톱과 같다', () {
    for (final c in cases) {
      test(c['name']! as String, () {
        final rows = [
          for (final j in (c['messages']! as List).cast<Map<String, Object?>>())
            MessageRow.fromJson({...j, 'channelId': 'c1'}),
        ];
        final out = groupAgentExchanges(groupProgress(rows), agents.contains, rootId: c['rootId'] as String?);
        expect(jsonDecode(jsonEncode(out.map(_encodeSlot).toList())), c['slots']);
      });
    }
  });

  test('첫 줄이 데스크톱과 같다', () {
    for (final f in firstLines) {
      expect(firstLine(f['body']! as String), f['line'], reason: jsonEncode(f['body']));
    }
  });
}

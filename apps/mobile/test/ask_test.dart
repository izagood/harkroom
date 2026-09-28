import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/ask.dart';

Map<String, Object?> _meta(Map<String, Object?> ask) => {'kind': 'ask', 'ask': ask};

const _twoOptions = [
  {'id': 'a', 'label': '이걸로'},
  {'id': 'b', 'label': '저걸로', 'hint': '되돌리기 쉽다'},
];

void main() {
  group('모르는 모양은 평문으로 흘린다', () {
    test('kind 가 ask 가 아니면 null', () {
      expect(AskMeta.read({'kind': 'report'}), isNull);
      expect(AskMeta.read(const {}), isNull);
    });

    test('선택지가 없거나 하나면 null — 그건 선택이 아니다', () {
      expect(AskMeta.read(_meta({'options': <Object?>[], 'to': {'kind': 'human'}})), isNull);
      expect(
        AskMeta.read(_meta({
          'options': [
            {'id': 'a', 'label': '하나뿐'}
          ],
          'to': {'kind': 'human'}
        })),
        isNull,
      );
    });

    test('형식 안 갖춘 선택지는 버리고 나머지로 센다', () {
      final m = AskMeta.read(_meta({
        'options': [
          {'id': 'a', 'label': '좋다'},
          {'id': '', 'label': '빈 id'},
          {'label': 'id 가 없다'},
          {'id': 'b', 'label': '이것도'},
        ],
        'to': {'kind': 'human'},
      }));
      expect(m!.options.map((o) => o.id), ['a', 'b']);
    });
  });

  group('누구에게 물었나', () {
    test('사람 아무나', () {
      final m = AskMeta.read(_meta({'options': _twoOptions, 'to': {'kind': 'human'}}));
      expect(m!.to, isA<AskAnyHuman>());
    });

    test('특정 계정', () {
      final m = AskMeta.read(
          _meta({'options': _twoOptions, 'to': {'kind': 'account', 'accountId': 'me-1'}}));
      expect((m!.to as AskAccount).accountId, 'me-1');
    });

    test('모르는 모양은 사람 아무나로 떨어진다 — 물음을 통째로 버리지 않는다', () {
      // 버리면 그 턴은 영영 멈춘다. 누구든 답할 수 있게 두는 편이 덜 나쁘다.
      final m = AskMeta.read(_meta({'options': _twoOptions, 'to': {'kind': '아직없는것'}}));
      expect(m!.to, isA<AskAnyHuman>());
    });
  });

  group('열려 있는가', () {
    test('답도 닫힘도 없으면 열려 있다', () {
      final m = AskMeta.read(_meta({'options': _twoOptions, 'to': {'kind': 'human'}}));
      expect(m!.isOpen, isTrue);
    });

    test('고른 것이 있으면 닫혔다', () {
      final m = AskMeta.read(_meta(
          {'options': _twoOptions, 'to': {'kind': 'human'}, 'answeredWith': 'a'}));
      expect(m!.isOpen, isFalse);
      expect(m.answeredWith, 'a');
    });

    test('답하지 않기로 한 것도 닫혔다 — 고른 것과는 다른 사실이다', () {
      final m = AskMeta.read(_meta({
        'options': _twoOptions,
        'to': {'kind': 'human'},
        'closedAt': '2026-09-28T00:00:00.000Z',
      }));
      expect(m!.isOpen, isFalse);
      expect(m.answeredWith, isNull);
    });
  });

  test('본문에 물음이 있으면 prompt 가 없다 — 같은 말을 두 번 그리지 않는다', () {
    final m = AskMeta.read(_meta({'options': _twoOptions, 'to': {'kind': 'human'}}));
    expect(m!.prompt, isNull);
  });

  test('선택지 경계는 값으로 둔다', () {
    expect(askMinOptions, 2);
    expect(askMaxOptions, 5);
  });
}

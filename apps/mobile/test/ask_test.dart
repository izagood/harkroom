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

  group('묶음 카드(선택 카드 P1)', () {
    Map<String, Object?> bundle(List<Map<String, Object?>> items) => {'kind': 'askBundle', 'askBundle': {'items': items}};
    final item = {'rootId': 'r1', 'askerId': 'ag', 'channelId': 'c', 'threadRootId': null, 'prompt': '어느 쪽?', 'options': _twoOptions};

    test('모르는 모양은 null', () {
      expect(AskBundleMeta.read({'kind': 'ask'}), isNull);
      expect(AskBundleMeta.read({'kind': 'askBundle'}), isNull);
      expect(AskBundleMeta.read(bundle([{'prompt': 'rootId 가 없다', 'options': <Object?>[]}])), isNull);
    });

    test('줄을 읽는다 — link 와 추천', () {
      final b = AskBundleMeta.read(bundle([
        item,
        {...item, 'rootId': 'r2', 'link': true, 'options': [{'id': 'a', 'label': 'A', 'recommended': true}, {'id': 'b', 'label': 'B'}]},
      ]))!;
      expect(b.items.map((i) => i.rootId), ['r1', 'r2']);
      expect(b.items[1].link, isTrue);
      expect(bundleRecommended(b.items[1].options), 'a');
      expect(bundleRecommended(b.items[0].options), isNull);
    });

    test('추천이 둘이면 고르지 않는다', () {
      final opts = AskOption.readList([
        {'id': 'a', 'label': 'A', 'recommended': true},
        {'id': 'b', 'label': 'B', 'recommended': true},
      ]);
      expect(bundleRecommended(opts), isNull);
    });

    final b = AskBundleMeta.read(bundle([item]))!.items.single;
    final link = AskBundleMeta.read(bundle([{...item, 'link': true}]))!.items.single;
    Map<String, Object?> root(Map<String, Object?> extra) => _meta({'options': _twoOptions, 'to': {'kind': 'human'}, ...extra});

    test('줄 상태는 원본에서 — 읽는 중·못 봄·열림·고름', () {
      expect(bundleRowState(b, null), isA<BundleRowLoading>());
      expect(bundleRowState(b, null, unavailable: true), isA<BundleRowUnavailable>());
      expect(bundleRowState(b, root({})), isA<BundleRowOpen>());
      final a = bundleRowState(b, root({'answeredWith': 'b', 'answeredBy': 'h'})) as BundleRowAnswered;
      expect(a.label, '저걸로');
      expect(a.by, 'h');
    });

    test('글로 답한 줄은 요지와 요약한 계정을 함께 싣는다(security n1)', () {
      final r = bundleRowState(b, root({
        'closedAt': 't', 'closedBy': 'h', 'closedReason': 'replied', 'replyNote': '저걸로 가자', 'replyNoteBy': 'pm',
      })) as BundleRowReplied;
      expect(r.by, 'h');
      expect(r.note, '저걸로 가자');
      expect(r.noteBy, 'pm');
    });

    test('새 질문·답 없이 닫힘', () {
      expect(bundleRowState(b, root({'closedAt': 't', 'closedReason': 'superseded'})), isA<BundleRowSuperseded>());
      expect(bundleRowState(b, root({'closedAt': 't'})), isA<BundleRowDeclined>());
    });

    test('링크 줄은 열린 동안·못 볼 때 링크, 정해지면 결과', () {
      expect(bundleRowState(link, null, unavailable: true), isA<BundleRowLink>());
      expect(bundleRowState(link, root({})), isA<BundleRowLink>());
      expect(bundleRowState(link, root({'answeredWith': 'a'})), isA<BundleRowAnswered>());
    });

    test('일괄 결과 — 빠진 줄', () {
      expect(BundleAcceptResult.fromJson({'rootId': 'r', 'outcome': 'skipped_irreversible'})!.skipped, isTrue);
      expect(BundleAcceptResult.fromJson({'rootId': 'r', 'outcome': 'answered'})!.skipped, isFalse);
      expect(BundleAcceptResult.fromJson({'outcome': 'answered'}), isNull);
    });
  });
}

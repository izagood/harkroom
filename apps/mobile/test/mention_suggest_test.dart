import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/mention/mention.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/mention/mention_suggest.dart';
import 'package:harkroom/mention/usage.dart';

/// 커서 표식 `|` 를 쓴 짧은 표기. 시험이 읽히게.
(String, int) _at(String marked) {
  final i = marked.indexOf('|');
  return (marked.replaceFirst('|', ''), i);
}

MentionQuery? _q(String marked) {
  final (text, cursor) = _at(marked);
  return mentionQueryAt(text, cursor);
}

class _Acct {
  const _Acct(this.handle, this.name);
  final String handle;
  final String name;
}

void main() {
  group('커서 앞이 이름을 치는 중인가', () {
    test('@ 만 쳐도 자리가 잡힌다', () {
      final q = _q('@|');
      expect(q, isNotNull);
      expect(q!.start, 0);
      expect(q.prefix, '');
    });

    test('친 글자가 접두가 된다', () {
      expect(_q('@fo|')!.prefix, 'fo');
      expect(_q('말 앞에 @fo|')!.prefix, 'fo');
    });

    test('@ 앞이 handle 글자면 아니다 — 주소의 일부다', () {
      expect(_q('x@fo|'), isNull);
      expect(_q('a-b@fo|'), isNull);
    });

    test('공백이 끼면 이름은 끝났다', () {
      expect(_q('@forge 다음|'), isNull);
    });

    test('커서가 이름 가운데여도 그 자리까지만 접두다', () {
      // `@forge` 를 치다가 되돌아와 고치는 중.
      final (text, cursor) = _at('@fo|rge 뒤');
      final q = mentionQueryAt(text, cursor);
      expect(q!.prefix, 'fo');
    });
  });

  group('보내도 아무도 안 깨울 자리에서는 후보를 띄우지 않는다', () {
    // 띄우면 사람은 고르고 보냈는데 상대가 오지 않는다 — 화면이 거짓말을 한 것이다.
    test('인용 줄', () {
      expect(_q('> @fo|'), isNull);
      expect(_q('   > 인용 중 @fo|'), isNull);
    });

    test('닫힌 인라인 코드 안', () {
      expect(_q('`@fo|`'), isNull);
    });

    test('닫힌 펜스 안', () {
      expect(_q('```\n@fo|\n```'), isNull);
    });

    test('주소 안', () {
      expect(_q('https://x.io/@fo|'), isNull);
    });

    test('**아직 안 닫힌** 백틱은 코드가 아니다 — 치는 중에 후보가 사라지면 안 된다', () {
      // 다 쓴 글의 판정도 짝 없는 백틱을 코드로 보지 않는다. 두 판정이 같아야 한다.
      expect(_q('` @fo|'), isNotNull);
      expect(mentionedHandles('` @forge'), ['forge']);
    });
  });

  group('두 판정이 같은 경계를 쓴다', () {
    // 자동완성이 뜬 자리에서 이름을 다 치면, 실제 판정도 그 이름을 불러야 한다.
    const cases = ['@fo', '말 앞에 @fo', '(@fo', '줄 끝\n@fo'];
    for (final c in cases) {
      test('후보가 뜨는 자리는 실제로도 불린다: ${c.replaceAll('\n', '\\n')}', () {
        expect(mentionQueryAt(c, c.length), isNotNull);
        expect(mentionedHandles('${c}rge'), contains('forge'));
      });
    }

    const suppressed = ['> @fo', '`@fo`', 'https://x.io/@fo'];
    for (final c in suppressed) {
      test('후보가 안 뜨는 자리는 실제로도 안 불린다: $c', () {
        final cursor = c.indexOf('@fo') + 3;
        expect(mentionQueryAt(c, cursor), isNull);
        expect(mentionedHandles(c.replaceAll('@fo', '@forge')), isNot(contains('forge')));
      });
    }
  });

  group('고른 이름을 끼워 넣는다', () {
    test('접두를 갈아 끼우고 뒤에 공백을 붙인다', () {
      final (text, cursor) = _at('@fo|');
      final r = applyMention(text, mentionQueryAt(text, cursor)!, 'forge');
      expect(r.text, '@forge ');
      expect(r.cursor, '@forge '.length);
    });

    test('이미 공백이 있으면 더 넣지 않는다', () {
      final (text, cursor) = _at('@fo| 뒤');
      final r = applyMention(text, mentionQueryAt(text, cursor)!, 'forge');
      expect(r.text, '@forge 뒤');
    });

    test('이름 가운데서 고르면 나머지 글자까지 갈린다', () {
      final (text, cursor) = _at('@fo|rge2 뒤');
      final r = applyMention(text, mentionQueryAt(text, cursor)!, 'forge');
      expect(r.text, '@forge 뒤');
    });

    test('앞뒤 글은 그대로 남는다', () {
      final (text, cursor) = _at('안녕 @fo| 그리고');
      final r = applyMention(text, mentionQueryAt(text, cursor)!, 'forge');
      expect(r.text, '안녕 @forge 그리고');
    });
  });

  group('후보 고르기', () {
    const all = [
      _Acct('forge', '포지'),
      _Acct('formula', '수식'),
      _Acct('codex', '코덱스'),
      _Acct('murmur', 'forge 를 닮은 이름'),
    ];

    List<String> rank(String prefix) => rankMentionCandidates(
          all,
          prefix,
          handleOf: (a) => a.handle,
          displayNameOf: (a) => a.name,
        ).map((a) => a.handle).toList();

    test('handle 접두가 먼저다', () {
      expect(rank('fo'), ['forge', 'formula', 'murmur']);
    });

    test('빈 접두는 전부(표시 이름 일치는 안 센다)', () {
      expect(rank(''), ['codex', 'forge', 'formula', 'murmur']);
    });

    test('대소문자를 가리지 않는다', () {
      expect(rank('FO'), ['forge', 'formula', 'murmur']);
    });

    // 자주 부른 상대가 같은 무리 안에서 앞에 선다(횟수 → 최근 → 이름순).
    final t0 = DateTime.utc(2026, 10, 1);
    final usage = {
      'formula': MentionUse(count: 3, last: t0),
      'murmur': MentionUse(count: 5, last: t0),
      'codex': MentionUse(count: 1, last: t0.add(const Duration(hours: 1))),
      'forge': MentionUse(count: 1, last: t0),
    };
    List<String> rankUsed(String prefix) => rankMentionCandidates(
          all,
          prefix,
          handleOf: (a) => a.handle,
          displayNameOf: (a) => a.name,
          usageOf: (a) => usage[a.handle],
        ).map((a) => a.handle).toList();

    test('자주 부른 순 — 같으면 최근에 부른 쪽, 그다음 이름순', () {
      expect(rankUsed(''), ['murmur', 'formula', 'codex', 'forge']);
    });

    test('쓰임은 무리 안에서만 가른다 — 접두 일치가 표시 이름 일치보다 늘 앞', () {
      // murmur 는 가장 자주 불렀지만 fo 를 이름(표시 이름)으로만 맞춘다.
      expect(rankUsed('fo'), ['formula', 'forge', 'murmur']);
    });

    test('자주 부른 상대가 limit 에 잘리지 않는다', () {
      final out = rankMentionCandidates(
        all,
        '',
        handleOf: (a) => a.handle,
        displayNameOf: (a) => a.name,
        usageOf: (a) => usage[a.handle],
        limit: 1,
      ).map((a) => a.handle);
      expect(out, ['murmur']);
    });
  });

  group('부른 기록 세기', () {
    const me = '00000000-0000-0000-0000-00000000000a';
    const forge = '00000000-0000-0000-0000-0000000000f0';
    const codex = '00000000-0000-0000-0000-0000000000c0';
    const team = '00000000-0000-0000-0000-0000000000e0';
    var seq = 0;
    MessageRow msg(String author, String body, {String? id, int day = 1}) => MessageRow(
          id: id ?? 'm${seq++}',
          seq: seq,
          channelId: 'c',
          threadRootId: null,
          authorId: author,
          body: body,
          kind: MessageKind.user,
          meta: const {},
          createdAt: DateTime.utc(2026, 10, day),
          editedAt: null,
          reactions: const [],
          attachments: const [],
          replyCount: null,
        );

    test('내 글만, 한 글에 한 번, id 로 센다', () {
      final dup = msg(me, '<@$forge> 다시', id: 'dup', day: 3);
      final out = countMentionUse([
        msg(me, '<@$forge> 와 <@$forge> 둘 다', day: 1),
        msg(me, '<@$codex> 봐 줘', day: 2),
        dup,
        dup, // 채널 목록과 스레드 목록에 같은 답글이 함께 있다
        msg(codex, '<@$forge> 남이 부른 것', day: 5),
        msg(me, '<@team:$team> 팀은 안 센다 <@$me> 나도 안 센다'),
      ], me);
      expect(out.keys.toSet(), {forge, codex});
      expect(out[forge]!.count, 2);
      expect(out[forge]!.last, DateTime.utc(2026, 10, 3));
      expect(out[codex]!.count, 1);
    });
  });
}

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/mention/mention.dart';
import 'package:harkroom/mention/mention_suggest.dart';

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
  });
}

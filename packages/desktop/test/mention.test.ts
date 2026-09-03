import { describe, it, expect } from 'vitest';
import { mentionedHandles } from '@murmur/shared';
import { mentionQueryAt, applyMention, splitMentions } from '../src/lib/mention';

describe('mentionQueryAt', () => {
  // 커서 바로 앞의 @토큰만 후보다. 뒤쪽 텍스트나 앞선 멘션에 반응하면 엉뚱한 데서 창이 뜬다.
  it('finds the partial handle immediately before the caret', () => {
    const text = '이거 @fi';

    expect(mentionQueryAt(text, text.length)).toEqual({ query: 'fi', start: 3 });
  });

  it('matches an empty query right after the @', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ query: '', start: 0 });
  });

  it('ignores an @ that is not adjacent to the caret', () => {
    const text = '@fizz 안녕';

    expect(mentionQueryAt(text, text.length)).toBeNull();
  });

  // 이메일이나 단어 중간의 @ 는 멘션이 아니다.
  it('ignores an @ glued to the previous word', () => {
    const text = 'me@example';

    expect(mentionQueryAt(text, text.length)).toBeNull();
  });

  it('accepts an @ at the start of a line inside a longer draft', () => {
    const text = '첫 줄\n@ru';

    expect(mentionQueryAt(text, text.length)).toEqual({ query: 'ru', start: 4 });
  });

  it('stops matching once the handle contains a space', () => {
    const text = '@fizz 안녕 ';

    expect(mentionQueryAt(text, text.length)).toBeNull();
  });
});

describe('applyMention', () => {
  it('replaces the partial handle and leaves a trailing space', () => {
    const text = '이거 @fi';

    expect(applyMention(text, { query: 'fi', start: 3 }, 'fizz'))
      .toEqual({ text: '이거 @fizz ', caret: 9 });
  });

  // 커서 뒤의 글자는 보존해야 한다 — 중간에 멘션을 끼워 넣는 경우다.
  it('keeps whatever followed the caret', () => {
    const text = '@fi 를 불러줘';
    const q = mentionQueryAt(text, 3)!;

    expect(applyMention(text, q, 'fizz').text).toBe('@fizz  를 불러줘');
  });
});

describe('splitMentions', () => {
  // Slack 처럼 강조하려면 어느 조각이 멘션인지 알아야 한다. 존재하는 handle 만 강조한다 —
  // 아무 @단어나 칠하면 오타가 멘션처럼 보인다.
  it('marks a known handle as a mention and leaves the rest as text', () => {
    const parts = splitMentions('@fizz 이거 봐줘', ['fizz', 'rusalka']);

    // #230 이후 조각에 `isGroup` 이 붙는다. **명시적으로 false 를 적는다** — 사람 멘션이
    // 집합이 아니라는 것이 이 단언의 일부다. 생략하면 `toEqual` 이 통과하지 않을 뿐
    // 아니라(엄격 비교다), 나중에 사람 멘션에 집합 표시가 붙어도 알 수 없게 된다.
    expect(parts).toEqual([
      { kind: 'mention', text: '@fizz', handle: 'fizz', isGroup: false },
      { kind: 'text', text: ' 이거 봐줘' },
    ]);
  });

  // `@channel`(#225)은 계정이 아니지만 서버가 채널 전체에 알림을 보낸다. 강조하지 않으면
  // 강조되지 않은 것이 몰래 알림을 보내는 쪽으로 갈라진다.
  it('marks @channel even though no such account exists', () => {
    const parts = splitMentions('@channel 공지', ['fizz']);

    // `@channel` 은 예약어이지 집합이 아니다 — 집합처럼 칠하면 사람은 저장된 명단이
    // 있다고 믿고 그 명단을 찾으려 한다.
    expect(parts).toEqual([
      { kind: 'mention', text: '@channel', handle: 'channel', isGroup: false },
      { kind: 'text', text: ' 공지' },
    ]);
  });

  it('leaves an unknown handle as plain text', () => {
    const parts = splitMentions('@nobody 안녕', ['fizz']);

    expect(parts).toEqual([{ kind: 'text', text: '@nobody 안녕' }]);
  });

  it('marks several mentions in one message', () => {
    const parts = splitMentions('@fizz 랑 @rusalka 둘 다', ['fizz', 'rusalka']);

    expect(parts.filter((p) => p.kind === 'mention').map((p) => p.text)).toEqual(['@fizz', '@rusalka']);
  });

  it('returns the message unchanged when nothing is mentioned', () => {
    expect(splitMentions('멘션 없는 문장', ['fizz'])).toEqual([{ kind: 'text', text: '멘션 없는 문장' }]);
  });

  // 서버의 멘션 규칙과 같아야 한다 — UI 가 강조한 것이 알림으로 가야 한다.
  it('follows the same handle grammar the server uses', () => {
    expect(splitMentions('me@example.com 으로', ['example']).every((p) => p.kind === 'text')).toBe(true);
  });
});

/**
 * 강조(여기)와 알림 발송(서버)이 갈라지지 않는다는 것을 규칙 자체로 확인한다. 두 곳에 각자
 * 정규식을 적으면 반드시 갈라지고, 그때 사용자는 두 방향으로 속는다.
 */
describe('the same rule the server notifies by', () => {
  const cases = [
    '@fizz 이거 봐줘',
    '연락은 me@fizz.com 으로',
    '경로는 users@fizz 입니다',
    '@Fizz 대문자',
    '첫 줄\n@fizz 둘째 줄',
    '(@fizz) 괄호',
    '@fizz @fizz 반복',
    '@fizz 랑 @rusalka 둘 다',
    '멘션 없는 문장',
  ];

  it.each(cases)('highlights exactly what the server would notify: %s', (body) => {
    const known = ['fizz', 'rusalka'];

    const highlighted = splitMentions(body, known)
      .filter((p) => p.kind === 'mention')
      .map((p) => (p as { handle: string }).handle);
    const notified = mentionedHandles(body).filter((h) => known.includes(h));

    expect([...new Set(highlighted)].sort()).toEqual(notified.sort());
  });
});

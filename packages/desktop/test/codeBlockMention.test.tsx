import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { mentionedHandles } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { bodyRecipients } from '../src/lib/mention';
import { acc, grp, msg } from './helpers/fakeApi';

/**
 * #298 회귀선 4·6: **화면의 강조와 서버의 알림 판정이 같은 함수를 쓴다.**
 *
 * 이 파일의 요점은 케이스마다 정답을 손으로 적지 **않는** 것이다. 정답을 적으면 그것은
 * 판정의 사본이 되고, 서버가 자기 정규식을 다시 적어도(#298 이 없앤 두 벌) 이 표는 계속
 * 초록이다 — 오늘 실측된 바로 그 결함이다. 그래서 여기서는 `MessageBody` 를 **실제로
 * 렌더해** 화면에 칠해진 handle 을 읽고, 같은 본문에 대한 `mentionedHandles`(서버가 알림을
 * 보낼 때 부르는 그 함수)와 **대조한다.** 둘 중 하나만 바뀌면 표가 빨개진다.
 *
 * 알림이 실제로 안 가는지는 서버를 통과해야 알 수 있으므로 그쪽에 있다:
 * `packages/server/test/codeBlockMention.test.ts`.
 */

const KNOWN = ['fizz', 'someone', 'me'];
const GROUPS = ['oncall'];

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

/** 화면이 멘션으로 칠한 handle 들. `data-testid="mention-<handle>"` 이 그 신호다. */
function highlighted(): string[] {
  const body = screen.getByTestId('message-body');
  return [...body.querySelectorAll('[data-testid^="mention-"]')]
    .map((el) => el.getAttribute('data-testid')!.slice('mention-'.length))
    .filter((h, i, all) => all.indexOf(h) === i)
    .sort();
}

/** 서버가 알림을 보낼 대상. 존재하지 않는 이름은 화면이 칠하지 않으므로 여기서도 걸러 낸다. */
function notified(body: string): string[] {
  const existing = new Set([...KNOWN, ...GROUPS]);
  return mentionedHandles(body).filter((h) => existing.has(h)).sort();
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      u2: acc('u2', 'someone'),
      a1: acc('a1', 'fizz', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call')],
  });
});
afterEach(() => cleanup());

/**
 * 케이스 표. 각 항목은 **입력 하나**다 — 기대값은 적지 않는다(위 주석의 이유).
 * `also` 는 그 케이스에서 화면·서버가 공통으로 어떤 결과여야 하는지를 사람이 읽기 위한
 * 메모이고, 단언은 대조 쪽이 한다.
 */
const CASES: Array<{ name: string; body: string }> = [
  { name: '펜스 블록 안', body: '이렇게\n```\n@fizz 를 부른다\n```\n끝' },
  { name: '인라인 코드 안', body: '`@fizz` 라고 적어' },
  { name: '코드 안과 밖에 서로 다른 handle', body: '@someone 봐줘\n```\n@fizz\n```' },
  { name: '중첩 — 펜스 안의 인라인', body: '```\n`@fizz`\n```' },
  { name: '닫히지 않은 펜스', body: '```\n@fizz 닫는 펜스가 없다' },
  { name: '닫히지 않은 펜스 뒤 인라인', body: '```\n`@fizz` 그리고 @someone' },
  { name: '코드 안 집합 handle', body: '```\n@oncall 을 부르면 팀이 온다\n```' },
  { name: '코드 밖 집합 handle', body: '@oncall 서버가 죽었다' },
  { name: '한 줄에 백틱 셋 — 애매한 입력', body: '이건 ```@fizz``` 다' },
  { name: '언어 표시가 붙은 펜스', body: '```ts\nsend("@fizz");\n```' },
  { name: '코드 없음', body: '@fizz 랑 @oncall 둘 다' },
  // #592 — 인용도 같은 대조를 받는다. 여기 넣는 이유: 강조와 알림이 갈라지는 자리가
  // 코드였다면 인용에서도 같은 방식으로 갈라진다.
  { name: '인용 줄 안', body: '> @fizz 라고 했다' },
  { name: '인용 안과 밖', body: '> 앞 사람 말: @fizz\n@someone 봐줘' },
  { name: '인용 안의 인라인 코드 뒤', body: '> 목록 `x` 옆에 @fizz' },
  { name: '인용 안 집합 handle', body: '> @oncall 이라고 적혀 있었다' },
  { name: '인용 뒤 빈 줄 뒤 평문', body: '> @fizz\n\n@someone 이건 진짜 부른다' },
  { name: '들여쓴 인용', body: '   > @fizz 인용이다' },
  { name: '인용 기호만 있고 공백 없음', body: '>@fizz' },
];

describe('화면 강조와 서버 알림 판정이 일치한다 (#298)', () => {
  for (const c of CASES) {
    it(`같은 결과를 낸다: ${c.name}`, () => {
      show(c.body);
      expect(highlighted()).toEqual(notified(c.body));
    });
  }

  /**
   * 표가 전부 빈 배열끼리 비교해 우연히 초록인 것을 막는다. 하나라도 칠하는 케이스가
   * 있어야 위 대조가 뜻을 갖는다 — `splitMentions` 를 `return []` 로 만들면 이 단언이 빨개진다.
   */
  it('표 안에 실제로 칠하는 케이스가 있다', () => {
    show('@fizz 랑 @oncall 둘 다');
    expect(highlighted()).toEqual(['fizz', 'oncall']);
  });

  it('코드 안 handle 은 아예 칠하지 않는다 — 대조가 둘 다 빈 것으로 통과하는 방향', () => {
    show('```\n@fizz\n```');
    expect(highlighted()).toEqual([]);
    expect(screen.queryByTestId('mention-fizz')).toBeNull();
    // 본문은 그대로 남는다 — 코드로 그려질 뿐 사라지지 않는다.
    expect(screen.getByTestId('code-block').textContent).toBe('@fizz');
  });
});

/**
 * #592 — 인용(`> `) 줄의 `@handle` 은 부르는 것이 아니다.
 *
 * 위 대조 표만으로는 부족하다: 강조와 알림이 **둘 다** 인용 안을 부르게 되어도 표는 초록이다.
 * 그래서 여기서 방향을 못 박는다 — 인용 안은 아무도 부르지 않고, 인용 밖은 그대로 부른다.
 */
describe('인용 안의 handle 은 멘션이 아니다 (#592)', () => {
  it('인용 줄의 handle 은 알림 대상이 아니다', () => {
    expect(mentionedHandles('> 목록(@fizz·@someone 옆에 @oncall)')).toEqual([]);
  });

  it('인용 안의 인라인 코드 뒤도 새지 않는다 — 조각별로 다시 판정하면 여기가 샌다', () => {
    expect(mentionedHandles('> 목록 `code` 옆에 @fizz')).toEqual([]);
  });

  it('인용 밖은 그대로 부른다 — 위 단언이 멘션 자체가 죽은 것을 통과시키지 않는다', () => {
    expect(mentionedHandles('> 앞 사람: @fizz\n@someone 확인해')).toEqual(['someone']);
  });

  it('인용 안의 handle 은 칠하지도 않는다 — 화면이 "불렀다" 고 말하면 거짓이다', () => {
    show('> @fizz 라고 했다');
    expect(highlighted()).toEqual([]);
    // 글자는 그대로 남는다. 인용으로 그려질 뿐 사라지지 않는다.
    expect(screen.getByTestId('md-quote').textContent).toBe('@fizz 라고 했다');
  });

  it('인용 안에서도 링크는 링크다 — 인용이 멘션만 끈다', () => {
    show('> https://example.com 이라고 했다');
    expect(screen.getByTestId('md-quote').querySelector('a')).not.toBeNull();
  });

  it('"부를 상대" 줄에도 인용 안은 나오지 않는다', () => {
    expect(bodyRecipients('> @fizz 랑 @oncall 이라고 적혀 있었다', KNOWN, GROUPS, 'me')).toEqual([]);
  });
});

describe('"부를 상대" 줄도 같은 판정을 쓴다 (#298 요구 5)', () => {
  it('코드 블록 안의 handle 은 목록에 나오지 않는다', () => {
    expect(bodyRecipients('```\n@fizz\n```', KNOWN, GROUPS, 'me')).toEqual([]);
  });

  it('인라인 코드 안의 handle 도 나오지 않는다', () => {
    expect(bodyRecipients('`@fizz` 참고', KNOWN, GROUPS, 'me')).toEqual([]);
  });

  it('코드 밖의 handle 은 그대로 나온다 — 위 두 단언이 목록 자체가 죽은 것을 통과시키지 않는다', () => {
    expect(bodyRecipients('@fizz 이거 봐\n```\n@oncall\n```', KNOWN, GROUPS, 'me'))
      .toEqual([{ handle: 'fizz', kind: 'account' }]);
  });

  it('코드를 걷어낸 뒤에도 서버가 알릴 대상과 같은 집합이다', () => {
    const body = '@someone 봐줘\n```\n@fizz\n```\n@oncall 도';
    const shown = bodyRecipients(body, KNOWN, GROUPS, 'me').map((r) => r.handle).sort();
    expect(shown).toEqual(notified(body));
  });
});

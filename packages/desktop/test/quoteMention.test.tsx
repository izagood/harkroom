import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { mentionedHandles, normalizeMentions } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { bodyRecipients } from '../src/lib/mention';
import { acc, grp, msg } from './helpers/fakeApi';

/**
 * #593: **인용(`>`) 안의 `@handle` 은 부르는 것이 아니다.**
 *
 * 이 파일은 `codeBlockMention.test.tsx`(#298)와 **같은 방법**을 쓴다 — 케이스마다 정답을
 * 손으로 적지 않고, `MessageBody` 를 실제로 렌더해 화면이 칠한 handle 과 서버가 알림을
 * 보낼 때 부르는 `mentionedHandles` 를 **대조한다.** 정답을 적으면 그것이 판정의 사본이
 * 되고, 한쪽만 바뀌어도 표는 계속 초록이다.
 *
 * 화면 쪽을 함께 재는 이유가 이 이슈의 절반이다. 서버만 고치면 #298 이 경계한 거짓말이
 * 그대로 생긴다: **강조된 것이 알림을 보내지 않는다.**
 *
 * 알림이 실제로 안 가는지는 서버를 통과해야 알 수 있으므로 그쪽에 있다:
 * `packages/server/test/quoteMention.test.ts`.
 */

const KNOWN = ['fizz', 'someone', 'someone2', 'me'];
const UUID_SOMEONE = '11111111-1111-4111-8111-111111111111';
const GROUPS = ['oncall'];

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

/** 화면이 멘션으로 칠한 handle 들. */
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
      // <@id> 토큰은 36자 uuid 만 잡힌다(`MENTION_TOKEN_PATTERN`) — 짧은 가짜 id 로는
      // 토큰 경로를 잴 수 없다.
      [UUID_SOMEONE]: acc(UUID_SOMEONE, 'someone2'),
      a1: acc('a1', 'fizz', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call')],
  });
});
afterEach(() => cleanup());

/** 입력만 적는다 — 기대값은 위 두 함수의 대조가 만든다. */
const CASES: Array<{ name: string; body: string }> = [
  { name: '인용 한 줄', body: '> @fizz 를 부른다' },
  { name: '들여쓴 인용(3칸까지)', body: '   > @fizz 를 부른다' },
  { name: '인용 안팎에 서로 다른 handle', body: '> @fizz 라고 적혀 있었다\n@someone 이거 봐' },
  { name: '여러 줄 인용', body: '> 첫 줄 @fizz\n> 둘째 줄 @oncall\n밖에서 @someone' },
  { name: '인용 안의 집합 handle', body: '> @oncall 을 부르면 팀이 온다' },
  { name: '인용 사이에 낀 평문', body: '> @fizz\n중간 @someone\n> @oncall' },
  { name: '인용 안의 코드', body: '> `@fizz` 라고' },
  { name: '인용이 아닌 부등호', body: 'a > b 이면 @fizz 를 부른다' },
  { name: '문장 중간의 >', body: '조건 x > 1 에서 @someone' },
  { name: '4칸 이상 들여쓴 >', body: '    > @fizz' },
  { name: '인용 없음', body: '@fizz 랑 @oncall 둘 다' },
];

describe('화면 강조와 서버 알림 판정이 인용에서도 일치한다 (#593)', () => {
  for (const c of CASES) {
    it(`같은 결과를 낸다: ${c.name}`, () => {
      show(c.body);
      expect(highlighted()).toEqual(notified(c.body));
    });
  }

  /** 표가 전부 빈 배열끼리 비교해 우연히 초록인 것을 막는다. */
  it('표 안에 실제로 칠하는 케이스가 있다', () => {
    show('@fizz 랑 @oncall 둘 다');
    expect(highlighted()).toEqual(['fizz', 'oncall']);
  });

  it('인용 안의 handle 은 칠하지 않지만 글자는 그대로 보인다 — 옮겨 적은 말이 사라지면 안 된다', () => {
    show('> @fizz 를 부른다');
    expect(highlighted()).toEqual([]);
    expect(screen.queryByTestId('mention-fizz')).toBeNull();
    expect(screen.getByTestId('md-quote').textContent).toBe('@fizz 를 부른다');
  });

  it('인용 밖은 같은 본문 안에서도 그대로 칠한다 — 위 단언이 강조 자체가 죽은 것을 통과시키지 않는다', () => {
    show('> @fizz 라고 적혀 있었다\n\n@someone 이거 봐');
    expect(highlighted()).toEqual(['someone']);
  });

  /**
   * 이 규칙 **이전에** 저장된 본문을 인용으로 옮겨 적으면 `<@id>` 토큰이 인용 안에 들어온다.
   * 칠하지는 않되 **읽히기는 해야 한다** — 날 uuid 가 드러나면 옮겨 적은 말이 깨져 보인다.
   */
  it('인용 안의 <@id> 토큰은 handle 로 읽히고, 칠하지는 않는다', () => {
    show(`> <@${UUID_SOMEONE}> 님이 그렇게 말했다`);
    expect(highlighted()).toEqual([]);
    expect(screen.getByTestId('md-quote').textContent).toBe('@someone2 님이 그렇게 말했다');
  });
});

describe('저장 전 정규화도 인용을 비껴간다 (#593)', () => {
  const accountsMap = new Map([['fizz', 'a1'], ['someone', 'u2']]);

  it('인용 줄의 @handle 은 <@id> 로 바뀌지 않는다 — 원문 그대로 남는다', () => {
    expect(normalizeMentions('> @fizz 라고 적혀 있었다', accountsMap))
      .toBe('> @fizz 라고 적혀 있었다');
  });

  it('같은 본문의 인용 밖은 정규화된다 — 오프셋이 밀리지 않는다', () => {
    expect(normalizeMentions('> @fizz 라고\n@someone 확인해', accountsMap))
      .toBe('> @fizz 라고\n<@u2> 확인해');
  });

  it('인용이 여러 조각으로 끊어도 뒤쪽 오프셋이 맞는다', () => {
    expect(normalizeMentions('@someone 하나\n> @fizz\n@someone 둘', accountsMap))
      .toBe('<@u2> 하나\n> @fizz\n<@u2> 둘');
  });
});

describe('"부를 상대" 줄도 인용을 뺀다 (#593)', () => {
  it('인용 안의 handle 은 목록에 나오지 않는다', () => {
    expect(bodyRecipients('> @fizz 라고 적혀 있었다', KNOWN, GROUPS, 'me')).toEqual([]);
  });

  it('인용 밖의 handle 은 그대로 나온다', () => {
    expect(bodyRecipients('> @oncall\n@fizz 이거 봐', KNOWN, GROUPS, 'me'))
      .toEqual([{ handle: 'fizz', kind: 'account' }]);
  });

  it('인용을 걷어낸 뒤에도 서버가 알릴 대상과 같은 집합이다', () => {
    const body = '> @fizz 라고\n@someone 봐줘\n> @oncall';
    const shown = bodyRecipients(body, KNOWN, GROUPS, 'me').map((r) => r.handle).sort();
    expect(shown).toEqual(notified(body));
  });
});

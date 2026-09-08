import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { mentionedHandles } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { bodyRecipients } from '../src/lib/mention';
import { acc, grp, msg } from './helpers/fakeApi';

/**
 * 인용(`>`) 안의 `@handle` 은 부르는 것이 아니다(#597).
 *
 * 방식은 `codeBlockMention.test.tsx`(#298) 와 같다 — 케이스마다 정답을 손으로 적지 **않는다.**
 * 정답을 적으면 그것이 판정의 사본이 되고, 한쪽이 규칙을 다시 적어도 표가 계속 초록이다.
 * 그래서 `MessageBody` 를 **실제로 렌더해** 칠해진 handle 을 읽고, 같은 본문에 대한
 * `mentionedHandles`(서버가 알림을 보낼 때 부르는 그 함수)와 **대조한다.**
 *
 * 이 대조가 이 이슈의 핵심이다: 인용을 멘션에서 빼면서 화면을 그대로 두면 "칠해졌는데
 * 알림은 안 간다" 가 되고, 그것은 #298 이 없앤 거짓말의 다른 방향일 뿐이다.
 *
 * 알림이 실제로 안 가는지는 서버를 통과해야 알 수 있으므로 그쪽에 있다:
 * `packages/server/test/quoteMention.test.ts`.
 */

/** `<@id>` 토큰은 36자 UUID 만 인정한다(`MENTION_TOKEN_PATTERN`) — 저장된 인용을 재려면 진짜 모양이 필요하다. */
const QUOTED_ID = '11111111-1111-4111-8111-111111111111';
const KNOWN = ['fizz', 'someone', 'me', 'quoted'];
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
      a1: acc('a1', 'fizz', 'agent'),
      [QUOTED_ID]: acc(QUOTED_ID, 'quoted'),
    },
    groups: [grp('g1', 'oncall', 'On-call')],
  });
});
afterEach(() => cleanup());

/** 각 항목은 **입력 하나**다 — 기대값은 적지 않는다(위 주석의 이유). */
const CASES: Array<{ name: string; body: string }> = [
  { name: '인용 한 줄', body: '> @fizz 라고 적혀 있었다' },
  { name: '인용 여러 줄', body: '> 목록:\n> @fizz 와 @someone' },
  { name: '인용 안팎이 같이', body: '> @fizz 라고 적혀 있었다\n\n@someone 이거 봐' },
  { name: '인용 다음 줄은 인용이 아니다', body: '> 옮김\n@fizz 이제 내 말이다' },
  { name: '인용 안 집합 handle', body: '> @oncall 을 부르면 팀이 온다' },
  { name: '인용 밖 집합 handle', body: '@oncall 서버가 죽었다' },
  { name: '인용 안 인라인 코드 뒤', body: '> `code` 그리고 @fizz' },
  { name: '들여쓰기 세 칸까지는 인용', body: '   > @fizz 를 옮겨 적는다' },
  { name: '들여쓰기 네 칸은 인용이 아니다', body: '    > @fizz 는 그냥 글자다' },
  { name: '문장 중간의 > 는 인용이 아니다', body: '이건 a > b 이고 @fizz 를 부른다' },
  { name: '펜스 안의 인용 줄', body: '```\n> @fizz\n```' },
  { name: '줄 첫머리가 인라인 코드면 인용이 아니다', body: '`a` > @fizz' },
  { name: '인용 없음', body: '@fizz 랑 @oncall 둘 다' },
];

describe('화면 강조와 서버 알림 판정이 일치한다 (#597)', () => {
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

  it('인용 안 handle 은 칠하지 않지만 글자는 그대로 남는다', () => {
    show('> @fizz 라고 적혀 있었다');
    expect(highlighted()).toEqual([]);
    expect(screen.queryByTestId('mention-fizz')).toBeNull();
    expect(screen.getByTestId('md-quote').textContent).toBe('@fizz 라고 적혀 있었다');
  });

  it('인용 안의 저장된 <@id> 는 지금 이름으로 보이되 칠하지 않는다', () => {
    // 이 변경 이전에 저장된 인용에는 토큰이 들어 있다. 칩을 지운다고 `<@uuid>` 를 날것으로
    // 보이게 두면 사람은 본문이 깨진 것으로 읽는다.
    show(`> <@${QUOTED_ID}> 가 그렇게 말했다`);
    expect(screen.getByTestId('md-quote').textContent).toBe('@quoted 가 그렇게 말했다');
    expect(screen.queryByTestId('mention-quoted')).toBeNull();
  });

  it('인용 밖의 <@id> 는 그대로 칠한다 — 위 단언이 렌더 자체가 죽은 것을 통과시키지 않는다', () => {
    show(`<@${QUOTED_ID}> 가 그렇게 말했다`);
    expect(screen.getByTestId('mention-quoted')).toBeTruthy();
  });
});

describe('"부를 상대" 줄도 같은 판정을 쓴다 (#597)', () => {
  it('인용 안의 handle 은 목록에 나오지 않는다', () => {
    expect(bodyRecipients('> @fizz 라고 적혀 있었다', KNOWN, GROUPS, 'me')).toEqual([]);
  });

  it('인용 밖의 handle 은 그대로 나온다', () => {
    expect(bodyRecipients('> @oncall 옮김\n@fizz 이거 봐', KNOWN, GROUPS, 'me'))
      .toEqual([{ handle: 'fizz', kind: 'account' }]);
  });

  it('인용을 걷어낸 뒤에도 서버가 알릴 대상과 같은 집합이다', () => {
    const body = '> @fizz 옮김\n@someone 봐줘\n> @oncall 도 옮김';
    const shown = bodyRecipients(body, KNOWN, GROUPS, 'me').map((r) => r.handle).sort();
    expect(shown).toEqual(notified(body));
  });
});

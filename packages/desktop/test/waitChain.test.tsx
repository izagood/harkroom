// Task 7 — 대기 사슬과 교착(규칙 04).
//
// 사람이 **"왜 아무것도 안 움직이지"**를 묻지 않게 하는 것이 이 계산의 목적이다.
// 가장 위험한 부분은 순환이다 — 방문 집합이 없으면 렌더에서 무한 루프가 터진다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AskMeta, MessageRow } from '@murmur/shared';
import { waitChain } from '../src/lib/waitChain';
import type { Liveness } from '../src/lib/threadState';
import { msg, acc } from './helpers/fakeApi';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { WaitChainLine } from '../src/components/WaitChain';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';
const LINT = 'a-lint';
const ALIVE = new Set([FORGE, CODEX, LINT]);

/** `author` 가 낸 물음. `to` 가 null 이면 '사람 아무나'. */
const ask = (id: string, seq: number, author: string, to: string | null, answered = false): MessageRow => msg(
  id, 'c1', seq, '고를까?', author,
  {
    meta: {
      kind: 'ask',
      ask: {
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        to: to === null ? { kind: 'human' } : { kind: 'account', accountId: to },
        ...(answered ? { answeredWith: 'a', answeredBy: ME } : {}),
      },
    } as unknown as Record<string, unknown>,
  },
);

const chain = (messages: MessageRow[], live: Liveness = ALIVE) =>
  waitChain({ messages, myAccountId: ME, live });

describe('waitChain — 사슬을 잇는다', () => {
  it('기다리는 것이 없으면 사슬도 없다', () => {
    const c = chain([msg('m1', 'c1', 1, '안녕', ME)]);
    expect(c.end).toBe('none');
    expect(c.links).toHaveLength(0);
  });

  it('이미 답한 물음은 사슬에 들지 않는다', () => {
    expect(chain([ask('a1', 1, FORGE, ME, true)]).end).toBe('none');
  });

  it('나에게 온 물음 하나 → 내 차례, 하나가 풀린다', () => {
    const c = chain([ask('a1', 1, FORGE, ME)]);
    expect(c.end).toBe('me');
    expect(c.unblocks).toBe(1);
  });

  it("'사람 아무나'도 내 차례다", () => {
    expect(chain([ask('a1', 1, FORGE, null)]).end).toBe('me');
  });

  /**
   * **이 테스트가 이 계산의 값어치다** — 내가 한 번 답하면 몇 개가 풀리는지.
   * "골라 줘"보다 "답하면 codex 도 풀린다"가 사람을 움직인다.
   */
  it('3단 사슬 — codex → forge → 나. 한 번 답하면 둘이 풀린다', () => {
    const c = chain([
      ask('a1', 1, CODEX, FORGE),   // codex 가 forge 를 기다린다
      ask('a2', 2, FORGE, ME),      // forge 가 나를 기다린다
    ]);
    expect(c.end).toBe('me');
    // 사슬은 답할 지점까지 앞으로 탄 것이고(forge → 나), 풀리는 개수는 그 지점을 **거꾸로**
    // 훑어 센다 — codex 도 forge 를 기다리고 있었으므로 내 답 하나로 둘이 풀린다.
    expect(c.links.map((l) => l.waiter)).toEqual([FORGE]);
    expect(c.unblocks).toBe(2);
  });

  it('남을 기다리는 사슬은 나를 막지 않는다', () => {
    const c = chain([ask('a1', 1, FORGE, CODEX)]);
    expect(c.end).toBe('other');
    expect(c.unblocks).toBe(0);
  });
});

describe('waitChain — 교착', () => {
  /**
   * **없으면 렌더에서 무한 루프가 터진다.** 이 파일에서 가장 중요한 한 줄을 지킨다.
   */
  it('순환(A→B→A)은 즉시 교착으로 끊는다', () => {
    const c = chain([
      ask('a1', 1, FORGE, CODEX),
      ask('a2', 2, CODEX, FORGE),
    ]);
    expect(c.end).toBe('deadlock');
    expect(c.deadlockReason).toBe('cycle');
    expect(c.unblocks).toBe(0);
  });

  it('3자 순환도 끊는다', () => {
    const c = chain([
      ask('a1', 1, FORGE, CODEX),
      ask('a2', 2, CODEX, LINT),
      ask('a3', 3, LINT, FORGE),
    ]);
    expect(c.end).toBe('deadlock');
    expect(c.deadlockReason).toBe('cycle');
  });

  it('죽은 러너를 기다리면 교착이다 — 사슬이 아무 데도 안 닿는다', () => {
    // lint 가 응답 없는 상태에서 forge 가 그것을 기다린다.
    const c = chain([ask('a1', 1, FORGE, LINT)], new Set([FORGE, CODEX]));
    expect(c.end).toBe('deadlock');
    expect(c.deadlockReason).toBe('dead-runner');
  });

  it('생존을 모르면 교착으로 부르지 않는다 — 모른다는 이유로 붉게 칠하지 않는다', () => {
    // `threadState` 와 같은 규약: null 은 '아무도 없다'가 아니라 '모른다'.
    const c = chain([ask('a1', 1, FORGE, LINT)], null);
    expect(c.end).toBe('other');
    expect(c.deadlockReason).toBeUndefined();
  });

  it('교착이면 풀리는 개수가 0이다 — 답할 데가 없다', () => {
    expect(chain([ask('a1', 1, FORGE, CODEX), ask('a2', 2, CODEX, FORGE)]).unblocks).toBe(0);
  });
});

describe('WaitChainLine — 화면', () => {
  beforeEach(() => {
    useAppStore.getState().reset();
    useAppStore.getState().set({
      accounts: {
        [ME]: acc(ME, 'jaebin'),
        [FORGE]: acc(FORGE, 'forge', 'agent'),
        [CODEX]: acc(CODEX, 'codex', 'agent'),
        [LINT]: acc(LINT, 'lint', 'agent'),
      },
    });
  });
  afterEach(() => cleanup());

  it('기다리는 것이 없으면 아무것도 그리지 않는다 — 0 을 그리지 않는다', () => {
    render(<WaitChainLine chain={chain([msg('m1', 'c1', 1, '안녕', ME)])} />);
    expect(screen.queryByTestId('wait-chain')).toBeNull();
  });

  it('내 차례면 몇 개가 풀리는지 말한다 — 그것이 답할 이유다', () => {
    render(<WaitChainLine chain={chain([ask('a1', 1, CODEX, FORGE), ask('a2', 2, FORGE, ME)])} />);
    const el = screen.getByTestId('wait-chain');
    expect(el.dataset.end).toBe('me');
    expect(screen.getByText(/답하면 2개가 풀린다/)).toBeTruthy();
  });

  it('하나뿐이면 개수를 말하지 않는다 — 잡음이다', () => {
    render(<WaitChainLine chain={chain([ask('a1', 1, FORGE, ME)])} />);
    expect(screen.queryByText(/개가 풀린다/)).toBeNull();
  });

  it('교착은 강조와 함께 이유를 말한다', () => {
    render(<WaitChainLine chain={chain([ask('a1', 1, FORGE, CODEX), ask('a2', 2, CODEX, FORGE)])} />);
    const el = screen.getByTestId('wait-chain');
    expect(el.dataset.end).toBe('deadlock');
    expect(el.dataset.reason).toBe('cycle');
    expect(screen.getByText('교착')).toBeTruthy();
  });

  it('응답 없는 러너를 기다리는 교착은 다른 문장이다 — 사람이 할 일이 다르다', () => {
    render(<WaitChainLine chain={chain([ask('a1', 1, FORGE, LINT)], new Set([FORGE, CODEX]))} />);
    expect(screen.getByTestId('wait-chain').dataset.reason).toBe('dead-runner');
    expect(screen.getByText(/응답이 없다/)).toBeTruthy();
  });
});

/**
 * 조사 — 화면에 `forge 가 사람 의 답을 기다린다` 처럼 나오던 것을 고친 회귀선(실측).
 * 이름 자리에 보통명사('사람')를 끼워 넣으면 조사가 어긋난다.
 */
describe('WaitChainLine — 한국어 조사', () => {
  beforeEach(() => {
    useAppStore.getState().reset();
    useAppStore.getState().set({
      accounts: {
        [ME]: acc(ME, 'jaebin'),
        [FORGE]: acc(FORGE, 'forge', 'agent'),
        [CODEX]: acc(CODEX, 'codex', 'agent'),
        'a-han': acc('a-han', '민수', 'agent'),
      },
    });
  });

  it("'사람 아무나'를 기다릴 때 조사가 어긋나지 않는다", () => {
    render(<WaitChainLine chain={chain([ask('a1', 1, FORGE, null)])} />);
    expect(screen.getByTestId('wait-chain').textContent).toContain('forge 가 사람의 답을 기다린다');
  });

  it('받침 있는 이름은 이, 없는 이름은 가', () => {
    cleanup();
    render(<WaitChainLine chain={chain([ask('a1', 1, 'a-han', CODEX)])} />);
    // '민수' 는 받침이 없다 → 가.
    expect(screen.getByTestId('wait-chain').textContent).toContain('민수가 codex의 답을');
  });
});

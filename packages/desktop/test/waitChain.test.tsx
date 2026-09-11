// Task 7 — 대기 사슬과 교착(규칙 04).
//
// 사람이 **"왜 아무것도 안 움직이지"**를 묻지 않게 하는 것이 이 계산의 목적이다.
// 가장 위험한 부분은 순환이다 — 방문 집합이 없으면 렌더에서 무한 루프가 터진다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AskMeta, MessageRow, OpenAskLink } from '@murmur/shared';
import { waitChain, waitChainFromLinks } from '../src/lib/waitChain';
import type { Liveness } from '../src/lib/threadState';
import { msg, acc } from './helpers/fakeApi';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
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

/** 위임 하나(050 · 3-3). `open` 이 아직 답하지 않은 팀원들이다. */
const delegate = (id: string, seq: number, lead: string, open: string[]): MessageRow => msg(
  id, 'c1', seq, '이렇게 나눴다', lead,
  {
    meta: {
      kind: 'delegation',
      delegation: {
        to: open, open, unreachable: [], deadlineAt: '2026-09-11T09:00:00.000Z',
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
    // **한국어라고 말한다.** 기본값은 이제 영어(원본)다 — 아래 축들이 재는 것은
    // 언어가 아니라 그 문장이 지키는 규율(교착의 두 이유가 다른 문장인 것 등)이고,
    // 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
    usePrefsStore.getState().setLocale('ko');
    useAppStore.getState().set({
      accounts: {
        [ME]: acc(ME, 'jaebin'),
        [FORGE]: acc(FORGE, 'forge', 'agent'),
        [CODEX]: acc(CODEX, 'codex', 'agent'),
        [LINT]: acc(LINT, 'lint', 'agent'),
      },
    });
  });
  afterEach(() => {
    cleanup();
    usePrefsStore.getState().setLocale('system');
  });

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
    // 이 묶음은 **한국어 문법 그 자체**를 잰다 — 언어를 고정하지 않으면 잴 대상이 없다.
    usePrefsStore.getState().setLocale('ko');
    useAppStore.getState().set({
      accounts: {
        [ME]: acc(ME, 'jaebin'),
        [FORGE]: acc(FORGE, 'forge', 'agent'),
        [CODEX]: acc(CODEX, 'codex', 'agent'),
        'a-han': acc('a-han', '민수', 'agent'),
      },
    });
  });
  afterEach(() => {
    cleanup();
    usePrefsStore.getState().setLocale('system');
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

/**
 * **집계로 만든 사슬**(#488 A3-b).
 *
 * 채널 목록에는 답글이 없으므로(`controller.openThread` 로 열 때만 로드된다) 서버가
 * 마디를 미리 만들어 실어 준다. 이 묶음이 지키는 것은 **두 진입점이 같은 말을 하는
 * 것**이다 — 사슬이 스레드 안과 사이드바에서 다르면 어느 쪽을 믿어야 할지 알 수 없다.
 */
describe('waitChainFromLinks — 스레드를 열지 않고 낸다', () => {
  const link = (waiter: string, blockedBy: string | null): OpenAskLink =>
    ({ waiter, blockedBy, askedAt: '2024-01-01T00:00:00.000Z' });

  const from = (links: OpenAskLink[] | null, live: Liveness = ALIVE) =>
    waitChainFromLinks({ links, myAccountId: ME, live });

  /**
   * **모르는 것을 안다고 말하지 않는다.** 재료가 없는 것(옛 서버·답글 행)과 기다리는
   * 것이 없는 것은 다른 사실이다 — 슬라이스 1 의 `threadStateFromFacts` 와 같은 규약.
   */
  it('재료가 없으면 null 이다 — 기다리는 것이 없다가 아니다', () => {
    expect(from(null)).toBeNull();
    // 빈 배열은 정말로 없는 것이다.
    expect(from([])!.end).toBe('none');
  });

  it('내 차례를 가려낸다', () => {
    const c = from([link(FORGE, ME)])!;
    expect(c.end).toBe('me');
  });

  /**
   * **사슬은 가장 최근 물음에서 출발한다.** "지금 무엇이 멈춰 있는가"를 묻는 것이므로
   * 마지막에 난 물음이 시작점이고, 나에게 닿으면 거기서 멈춘다. 그래서 마디는 하나다 —
   * codex 는 사슬에 없지만 `unblocks` 가 그를 센다(내가 답하면 함께 풀린다).
   * 메시지 경로도 똑같이 낸다(실측으로 확인했고, 아래 동치 검사가 그것을 고정한다).
   */
  it('나에게 닿으면 거기서 멈춘다 — 뒤엣것은 unblocks 가 센다', () => {
    const c = from([link(CODEX, FORGE), link(FORGE, ME)])!;
    expect(c.end).toBe('me');
    expect(c.links.map((l) => l.waiter)).toEqual([FORGE]);
    expect(c.unblocks).toBe(2);
  });

  it('순환을 끊는다 — 없으면 렌더에서 무한 루프가 터진다', () => {
    const c = from([link(FORGE, CODEX), link(CODEX, FORGE)])!;
    expect(c.end).toBe('deadlock');
    expect(c.deadlockReason).toBe('cycle');
  });

  it('죽은 러너를 기다리는 것도 교착이다', () => {
    const c = from([link(FORGE, LINT)], new Set([FORGE]))!;
    expect(c.end).toBe('deadlock');
    expect(c.deadlockReason).toBe('dead-runner');
  });

  it('생존을 모르면 교착이라 부르지 않는다', () => {
    expect(from([link(FORGE, LINT)], null)!.end).not.toBe('deadlock');
  });

  it('경과를 말할 시각이 마디에 있다 — 메시지가 없어도', () => {
    const c = from([link(FORGE, ME)])!;
    expect(c.links[0]!.askedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(c.links[0]!.message).toBeUndefined();
  });

  /**
   * **이 파일에서 가장 중요한 검사.** 두 진입점이 같은 `walk()` 를 지나는지를 결과로
   * 묻는다 — 구현이 갈라지면 여기서 먼저 터진다.
   */
  it('메시지로 낸 사슬과 집계로 낸 사슬이 같다', () => {
    const messages = [ask('m1', 1, CODEX, FORGE), ask('m2', 2, FORGE, ME)];
    const fromMessages = chain(messages);
    const fromFacts = from([link(CODEX, FORGE), link(FORGE, ME)])!;

    expect(fromFacts.end).toBe(fromMessages.end);
    expect(fromFacts.unblocks).toBe(fromMessages.unblocks);
    expect(fromFacts.links.map((l) => [l.waiter, l.blockedBy]))
      .toEqual(fromMessages.links.map((l) => [l.waiter, l.blockedBy]));
    // 사슬이 하나로 멈추는 것까지 같다 — 길이가 갈리면 여기서 잡힌다.
    expect(fromFacts.links).toHaveLength(fromMessages.links.length);
  });

  it('내가 답하면 몇 개가 풀리는지도 같은 방식으로 센다', () => {
    // codex 와 lint 가 둘 다 forge 를 기다리고, forge 는 나를 기다린다.
    const c = from([link(CODEX, FORGE), link(LINT, FORGE), link(FORGE, ME)])!;
    expect(c.end).toBe('me');
    expect(c.unblocks).toBe(3);
  });
});

/**
 * **위임도 마디다**(050 · 3-3).
 *
 * 이것이 없으면 사람은 *"왜 조용한지"* 를 볼 수 없다: 팀원이 죽어 기한(기본 10분)을
 * 기다리는 동안 스레드에는 팀장의 "이렇게 나눴다" 한 줄뿐이고, 그 침묵이 정상인지 막힌
 * 것인지 구별되지 않는다.
 *
 * 되돌려 RED: `waitChain` 의 위임 분기를 지우면 1번이 `none` 이 된다.
 */
describe('waitChain — 위임 마디 (3-3)', () => {
  it('1. 팀장이 팀원을 기다리면 사슬이 선다 — 나를 막지는 않는다', () => {
    const c = chain([delegate('d1', 1, FORGE, [CODEX])]);
    expect(c.links).toHaveLength(1);
    expect(c.links[0]).toMatchObject({ waiter: FORGE, blockedBy: CODEX });
    // 남을 기다리는 것은 내 차례가 아니다(규칙 04) — 그래도 진행은 막혀 있다.
    expect(c.end).toBe('other');
  });

  /**
   * **사슬은 경로이고 부채꼴이 아니다.** 팀원 둘을 기다려도 화면에 서는 것은 그중 하나다 —
   * `walk()` 의 `pendingByWaiter` 가 계정마다 **가장 최근 하나**만 남기기 때문이다.
   *
   * 이것은 위임이 만든 한계가 아니라 이 계산이 원래 갖고 있던 모양이다: 한 에이전트가
   * 미답 물음을 둘 내도 사슬은 하나만 보여 준다. 그 모양을 바꾸는 것(예: "codex 외 1명")은
   * 화면의 어휘를 늘리는 일이라 이 PR 의 범위가 아니고, **틀린 말을 하지는 않는다** —
   * 팀장은 그 팀원도 정말로 기다리고 있다.
   */
  it('2. 팀원 둘을 기다리면 사슬은 그중 하나를 보여 준다 — 경로이기 때문이다', () => {
    const c = chain([delegate('d1', 1, FORGE, [CODEX, LINT])]);
    expect(c.links).toHaveLength(1);
    expect([CODEX, LINT]).toContain(c.links[0]!.blockedBy);
    expect(c.links[0]!.waiter).toBe(FORGE);
  });

  it('3. 다 답한 위임은 사슬에 들지 않는다', () => {
    // 서버가 닫을 때마다 `open` 을 줄인다 — 전부 닫히면 빈 배열이다.
    expect(chain([delegate('d1', 1, FORGE, [])]).end).toBe('none');
  });

  it('4. 죽은 팀원을 기다리면 교착이다 — 이 판정이 공짜로 따라온다', () => {
    const c = chain([delegate('d1', 1, FORGE, [CODEX])], new Set([FORGE]));
    expect(c.end).toBe('deadlock');
    expect(c.deadlockReason).toBe('dead-runner');
  });

  it('5. 모르는 생존에는 교착이라 말하지 않는다', () => {
    // `live === null` 은 "모른다"다 — 모른다는 이유로 붉게 칠하는 것도 거짓말이다.
    expect(chain([delegate('d1', 1, FORGE, [CODEX])], null).end).toBe('other');
  });

  it('6. 위임과 물음이 이어진다 — 팀원이 나에게 묻고 있으면 내 차례다', () => {
    // 팀장 → 팀원 → 나. 한 번 답하면 둘이 풀린다: 사람을 움직이는 것은 그 수다(규칙 05).
    const c = chain([delegate('d1', 1, FORGE, [CODEX]), ask('a1', 2, CODEX, ME)]);
    expect(c.end).toBe('me');
    expect(c.unblocks).toBe(2);
  });

  it('7. `open` 이 없는 옛 위임 메시지는 마디를 만들지 않는다', () => {
    // 3-3 이전에 만들어진 위임에는 그 배열이 없다. "전부 미결"로 읽으면 이미 끝난 옛
    // 위임이 영원히 사슬에 선다(`readDelegationMeta` 가 빈 배열로 읽는 이유).
    const old = msg('d1', 'c1', 1, '옛 위임', FORGE, {
      meta: {
        kind: 'delegation',
        delegation: { to: ['codex'], unreachable: [], deadlineAt: '2026-09-11T09:00:00.000Z' },
      } as unknown as Record<string, unknown>,
    });
    expect(chain([old]).end).toBe('none');
  });
});

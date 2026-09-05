// Task 6 — 스레드 상태 5단. **계획서가 "상태가 거짓말하면 전부 무너진다"고 적은 자리다.**
//
// 이 파일이 지키는 유일한 치명적 실패 모드: **죽었는데 "도는 중"이면 사람은 영원히 기다린다.**
// 그리고 그 반대편의 거짓말 — 소켓이 끊겼다고 도는 스레드를 전부 붉게 칠하는 것 — 도 함께 막는다.
import { describe, it, expect } from 'vitest';
import type { AskMeta, FailureMeta, MessageRow } from '@murmur/shared';
import { threadState, isBlocking, THREAD_STATE_LABEL, type Liveness, type ThreadState } from '../src/lib/threadState';
import { msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';
const AGENTS = new Set([FORGE, CODEX]);
const isAgent = (id: string): boolean => AGENTS.has(id);

const ask = (id: string, to: AskMeta['ask']['to'], answered = false): MessageRow => msg(
  id, 'c1', 1, '고를까?', FORGE,
  {
    meta: {
      kind: 'ask',
      ask: {
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        to,
        ...(answered ? { answeredWith: 'a', answeredBy: ME } : {}),
      },
    } as unknown as Record<string, unknown>,
  },
);

const fail = (id: string): MessageRow => msg(id, 'c1', 1, '못 끝냈다', FORGE, {
  meta: { kind: 'failure', failure: { retryable: true } } as unknown as FailureMeta as unknown as Record<string, unknown>,
});

const progress = (id: string, authorId = FORGE): MessageRow =>
  msg(id, 'c1', 1, '돌고 있다', authorId, { kind: 'progress' });

const state = (messages: MessageRow[], live: Liveness = new Set([FORGE, CODEX])): ThreadState =>
  threadState({ messages, myAccountId: ME, isAgent, live });

describe('threadState — 5단 판정표', () => {
  it('빈 스레드는 끝남이다', () => {
    expect(state([])).toBe('done');
  });

  it('나에게 온 미답 선택 → 내 차례', () => {
    expect(state([ask('a1', { kind: 'human' })])).toBe('my-turn');
    expect(state([ask('a1', { kind: 'account', accountId: ME })])).toBe('my-turn');
  });

  it('남에게 간 미답 선택 → 남을 기다림', () => {
    expect(state([ask('a1', { kind: 'account', accountId: CODEX })])).toBe('waiting');
  });

  it('이미 답한 선택은 아무도 막지 않는다 → 끝남', () => {
    expect(state([ask('a1', { kind: 'human' }, true)])).toBe('done');
  });

  it('실패가 있으면 막힘', () => {
    expect(state([fail('f1')])).toBe('stuck');
  });

  it('마지막이 진행이고 러너가 살아 있으면 도는 중', () => {
    expect(state([progress('p1')])).toBe('running');
  });

  it('사람의 발화로 끝나면 끝남 — 진행이 아니면 도는 중이 아니다', () => {
    expect(state([progress('p1'), msg('u1', 'c1', 2, '고마워', ME)])).toBe('done');
  });
});

/**
 * **우선순위** — 하나의 스레드는 한 상태만 받는다. 겹칠 때 무엇이 이기는지가 실질이다.
 */
describe('threadState — 겹칠 때 무엇이 이기는가', () => {
  it('내 차례가 막힘을 이긴다 — 답 한 번으로 풀리는 것을 먼저 보여 준다', () => {
    expect(state([fail('f1'), ask('a1', { kind: 'human' })])).toBe('my-turn');
  });

  it('내 차례가 남을 기다림을 이긴다', () => {
    expect(state([ask('a1', { kind: 'account', accountId: CODEX }), ask('a2', { kind: 'human' })]))
      .toBe('my-turn');
  });

  it('막힘이 남을 기다림을 이긴다 — 사슬이 끊긴 것이 더 급하다', () => {
    expect(state([ask('a1', { kind: 'account', accountId: CODEX }), fail('f1')])).toBe('stuck');
  });

  it('막는 말이 있으면 진행보다 이긴다', () => {
    expect(state([progress('p1'), ask('a1', { kind: 'human' })])).toBe('my-turn');
  });
});

/**
 * **이 안의 유일한 치명적 실패 모드**와 그 반대편의 거짓말.
 */
describe('threadState — 러너 생존', () => {
  it('죽은 러너를 "도는 중"으로 그리지 않는다 → 막힘', () => {
    // 살아 있는 목록에 forge 가 없다 = 죽었다고 **안다**.
    expect(state([progress('p1', FORGE)], new Set([CODEX]))).toBe('stuck');
  });

  it('살아 있으면 도는 중을 유지한다', () => {
    expect(state([progress('p1', FORGE)], new Set([FORGE]))).toBe('running');
  });

  it('모를 때(소켓 끊김)는 붉게 칠하지 않는다 — 마지막으로 알던 사실을 유지한다', () => {
    // `null` 은 '아무도 없다'가 아니라 '모른다'다. 여기서 stuck 을 주면 재연결하는 동안
    // 도는 스레드가 전부 붉어지고, 그것도 같은 종류의 거짓말이다.
    expect(state([progress('p1', FORGE)], null)).toBe('running');
  });

  it('사람이 쓴 진행은 러너 생존과 무관하다 → 끝남', () => {
    expect(state([progress('p1', ME)], new Set())).toBe('done');
  });
});

/**
 * 화면에 붙은 자리 — **스레드 패널의 헤더**. 채널 요약 줄에는 아직 달지 않는다:
 * 답글은 스레드를 열 때만 로드되므로(`controller.openThread`), 지금 데이터로 채널에
 * 그리면 열어 보지 않은 스레드가 전부 '끝남'으로 보인다.
 */
describe('상태 어휘가 한 표에서 나온다', () => {
  it('다섯 상태가 모두 이름을 갖는다', () => {
    const all: ThreadState[] = ['my-turn', 'stuck', 'waiting', 'running', 'done'];
    for (const s of all) expect(THREAD_STATE_LABEL[s]).toBeTruthy();
  });
});

describe('isBlocking — 강조를 받는 상태', () => {
  it('내 차례와 막힘만 강조를 받는다', () => {
    // 강조가 여러 상태에 뿌려지는 순간 "내 차례"라는 신호가 죽는다.
    expect(isBlocking('my-turn')).toBe(true);
    expect(isBlocking('stuck')).toBe(true);
    expect(isBlocking('waiting')).toBe(false);
    expect(isBlocking('running')).toBe(false);
    expect(isBlocking('done')).toBe(false);
  });
});

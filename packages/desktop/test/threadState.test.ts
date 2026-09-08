// Task 6 — 스레드 상태 5단. **계획서가 "상태가 거짓말하면 전부 무너진다"고 적은 자리다.**
//
// 이 파일이 지키는 유일한 치명적 실패 모드: **죽었는데 "도는 중"이면 사람은 영원히 기다린다.**
// 그리고 그 반대편의 거짓말 — 소켓이 끊겼다고 도는 스레드를 전부 붉게 칠하는 것 — 도 함께 막는다.
import { describe, it, expect } from 'vitest';
import type { AskMeta, FailureMeta, MessageRow } from '@murmur/shared';
import { threadState, threadStateFromFacts, isBlocking, threadStateLabel, type Liveness, type ThreadState } from '../src/lib/threadState';
import { LOCALES, translator } from '../src/i18n';
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

const report = (id: string, authorId = FORGE): MessageRow => msg(id, 'c1', 1, '다 했다', authorId, {
  meta: { kind: 'report', report: { checks: ['테스트 통과'] } } as unknown as Record<string, unknown>,
});

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
 * **한 번 실패한 스레드가 영원히 붉게 남지 않는다.**
 *
 * 실패를 누적으로 세면 `failed` 가 `running` 보다 위에 있으므로, 예전에 한 번 `message.fail`
 * 이 난 스레드는 그 뒤에 에이전트가 다시 붙어 진행 설명을 올리고 있어도 계속 '막힘'이다 —
 * 사람이 보는 화면에서 "작업 중"이 "막힘"으로 뒤집히던 것이 이것이다.
 *
 * 그래서 실패는 **에이전트가 다시 움직이면 풀린다**. 사람이 되묻는 것은 풀지 않는다.
 */
describe('threadState — 실패는 다시 움직이면 풀린다', () => {
  it('실패 뒤에 그 에이전트의 진행이 오면 도는 중으로 돌아온다', () => {
    expect(state([fail('f1'), progress('p1', FORGE)])).toBe('running');
  });

  it('다른 에이전트가 대신 붙어도 풀린다 — 진행은 에이전트만 낼 수 있다', () => {
    expect(state([fail('f1'), progress('p1', CODEX)])).toBe('running');
  });

  it('완료 보고도 푼다', () => {
    expect(state([fail('f1'), report('r1')])).toBe('done');
  });

  it('실패를 낸 계정의 평범한 글도 푼다 — 마지막 답을 글로 내는 러너가 있다', () => {
    expect(state([fail('f1'), msg('m1', 'c1', 2, '됐다', FORGE)])).toBe('done');
  });

  it('사람이 되묻는 것은 풀지 않는다 — 그때는 정말 막혀 있다', () => {
    expect(state([fail('f1'), msg('u1', 'c1', 2, '왜 안 돼?', ME)])).toBe('stuck');
  });

  it('다시 실패하면 다시 막힘이다', () => {
    expect(state([fail('f1'), progress('p1', FORGE), fail('f2')])).toBe('stuck');
  });

  it('풀린 뒤 러너가 죽으면 막힘이다 — 해소가 생존까지 덮지는 않는다', () => {
    expect(state([fail('f1'), progress('p1', FORGE)], new Set([CODEX]))).toBe('stuck');
  });
});

/**
 * 화면에 붙은 자리 — **스레드 패널의 헤더**. 채널 요약 줄에는 아직 달지 않는다:
 * 답글은 스레드를 열 때만 로드되므로(`controller.openThread`), 지금 데이터로 채널에
 * 그리면 열어 보지 않은 스레드가 전부 '끝남'으로 보인다.
 */
describe('상태 어휘가 한 표에서 나온다', () => {
  const all: ThreadState[] = ['my-turn', 'stuck', 'waiting', 'running', 'done'];

  /**
   * **붙어 있는 언어 전부에서 잰다.** 원래 이 축은 모듈 상수(`THREAD_STATE_LABEL`)를
   * 읽어 한 언어만 봤는데, 그 상수가 로드 시점 언어로 굳어 있던 것이 이 PR 이 고친
   * 결함이다. 언어를 하나만 재면 세 번째 언어가 다섯 중 하나를 빠뜨려도 초록이다.
   */
  it.each(LOCALES)('%s 에서 다섯 상태가 모두 이름을 갖는다', (locale) => {
    const t = translator(locale);
    for (const s of all) expect(threadStateLabel(s, t)).toBeTruthy();
  });

  /**
   * **다섯이 서로 다른 글자를 받는다.** 5단이 한 사다리인 것이 이 표의 요점이라
   * (규칙 03) 둘이 같은 글자를 받으면 그 두 상태는 화면에서 구별되지 않는다.
   */
  it.each(LOCALES)('%s 에서 다섯이 서로 다른 글자다', (locale) => {
    const t = translator(locale);
    expect(new Set(all.map((s) => threadStateLabel(s, t))).size).toBe(all.length);
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

/**
 * **서버 집계로 내는 같은 판정**(#484 · Task 6 Step 2).
 *
 * 채널 목록에는 루트만 있다 — 답글은 스레드를 열 때만 로드된다. 그 배열로 판정하면
 * **열어 보지 않은 스레드가 전부 '끝남'** 이 되고, 그것이 이 Task 가 고치려던 거짓말이다.
 */
describe('threadStateFromFacts — 채널 요약의 판정', () => {
  const facts = (over: Partial<Parameters<typeof threadStateFromFacts>[0]['row']> = {}) => ({
    openAskHumanCount: 0, openAskAccountIds: [], failureCount: 0,
    lastKind: 'user' as const, lastAuthorId: ME, ...over,
  });
  const from = (row: ReturnType<typeof facts>, live: Liveness = new Set([FORGE, CODEX])) =>
    threadStateFromFacts({ row, myAccountId: ME, isAgent, live });

  it('재료가 없으면 null 이다 — 모르는 것을 끝남이라 하지 않는다', () => {
    // 답글 행이거나 옛 서버다. '끝남'으로 떨어뜨리는 것이 바로 그 거짓말이다.
    expect(threadStateFromFacts({
      row: { openAskHumanCount: null, openAskAccountIds: null, failureCount: null, lastKind: null, lastAuthorId: null },
      myAccountId: ME, isAgent, live: null,
    })).toBeNull();
  });

  it('사람에게 온 미답 물음 → 내 차례', () => {
    expect(from(facts({ openAskHumanCount: 1 }))).toBe('my-turn');
  });

  it('나를 지목한 물음 → 내 차례', () => {
    expect(from(facts({ openAskAccountIds: [ME] }))).toBe('my-turn');
  });

  it('남을 지목한 물음 → 남을 기다림', () => {
    expect(from(facts({ openAskAccountIds: [CODEX] }))).toBe('waiting');
  });

  it('안 풀린 실패가 있으면 막힘', () => {
    expect(from(facts({ failureCount: 1, unresolvedFailureCount: 1 }))).toBe('stuck');
  });

  it('풀린 실패는 막지 않는다 — 누적은 남아 있어도 상태는 진행을 따른다', () => {
    expect(from(facts({
      failureCount: 1, unresolvedFailureCount: 0, lastKind: 'progress', lastAuthorId: FORGE,
    }))).toBe('running');
  });

  it('해소를 모르는 옛 서버면 누적으로 물러난다 — 숨기는 것보다 남기는 쪽이 안전하다', () => {
    // `unresolvedFailureCount` 를 안 싣는 서버다. 실패를 못 본 척하면 사람이 영영 모른다.
    expect(from(facts({ failureCount: 1, lastKind: 'progress', lastAuthorId: FORGE }))).toBe('stuck');
  });

  it('마지막이 진행이고 러너가 살아 있으면 도는 중', () => {
    expect(from(facts({ lastKind: 'progress', lastAuthorId: FORGE }))).toBe('running');
  });

  it('죽은 러너를 도는 중으로 그리지 않는다', () => {
    expect(from(facts({ lastKind: 'progress', lastAuthorId: FORGE }), new Set([CODEX]))).toBe('stuck');
  });

  it('생존을 모르면 붉게 칠하지 않는다', () => {
    expect(from(facts({ lastKind: 'progress', lastAuthorId: FORGE }), null)).toBe('running');
  });

  /**
   * **두 입구가 같은 답을 내야 한다.** 채널에서 본 상태와 스레드를 열어 본 상태가 갈라지면
   * 사람은 어느 쪽을 믿어야 하는지 알 수 없다 — 그래서 둘이 같은 `decide()` 를 지난다.
   */
  it('메시지 배열로 낸 판정과 집계로 낸 판정이 같다', () => {
    const cases: [MessageRow[], ReturnType<typeof facts>][] = [
      [[ask('a1', { kind: 'human' })], facts({ openAskHumanCount: 1 })],
      [[ask('a1', { kind: 'account', accountId: CODEX })], facts({ openAskAccountIds: [CODEX] })],
      [[fail('f1')], facts({ failureCount: 1, unresolvedFailureCount: 1 })],
      [[fail('f1'), progress('p1', FORGE)],
        facts({ failureCount: 1, unresolvedFailureCount: 0, lastKind: 'progress', lastAuthorId: FORGE })],
      [[progress('p1', FORGE)], facts({ lastKind: 'progress', lastAuthorId: FORGE })],
      [[msg('u1', 'c1', 1, '끝', ME)], facts()],
    ];
    for (const [messages, row] of cases) {
      expect(from(row)).toBe(state(messages));
    }
  });
});

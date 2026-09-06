// **말 슬롯** — 채널 요약 줄이 "누가 누구를 기다린다"를 말한다(identity 문서 Task 13).
//
// 문서가 이 줄을 **"아직 만들 수 없다"** 고 적어 두었다: *"meta 에 되물음·선택의 수신자가
// 들어 있어야 한다 — 계획 문서의 `AskMeta.to` 다. 그전까지 말 슬롯은 3단계만 그린다."*
// 그 전제는 `AskMeta.to` 로 충족됐고, **채널 목록에서 사슬을 만드는 것**은
// `openAskLinks`(#490)가 열었다.
//
// ## 이 파일이 지키는 것
//
// **명단이 되지 않는 것.** 문서가 명단을 세 가지 이유로 물렀다: 자를 기준이 없다 ·
// 내가 목록에 들어가면 문장이 어긋난다 · 정작 물어본 것("열어야 하나")에 답하지 않는다.
// 그래서 이름은 **대기 사슬의 양 끝일 때만** 쓴다 — 최대 둘, 참여자 수와 무관하다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { OpenAskLink } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const MINSU = 'u-minsu';
const SORA = 'u-sora';
const ALPHA = 'a-alpha';
const BETA = 'a-beta';
const FORGE = 'a-forge';

const link = (waiter: string, blockedBy: string | null): OpenAskLink =>
  ({ waiter, blockedBy, askedAt: new Date(Date.now() - 3 * 60_000).toISOString() });

/** 요약 줄 하나. 사람 셋 · 에이전트 셋이 섞인 스레드다(문서의 데모와 같은 구성). */
function summary(links: OpenAskLink[] | null, over: Record<string, unknown> = {}) {
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      [MINSU]: acc(MINSU, 'minsu'),
      [SORA]: acc(SORA, 'sora'),
      [ALPHA]: acc(ALPHA, 'alpha', 'agent'),
      [BETA]: acc(BETA, 'beta', 'agent'),
      [FORGE]: acc(FORGE, 'forge', 'agent'),
    },
    messages: { c1: [] },
    online: [ALPHA, BETA, FORGE],
    connected: true,
  });
  return render(<MessageItem message={msg('m1', 'c1', 1, '루트', ALPHA, {
    replyCount: 4,
    participantIds: [ALPHA, BETA, MINSU, SORA],
    openAskHumanCount: 0,
    openAskAccountIds: [],
    failureCount: 0,
    lastKind: 'user',
    lastAuthorId: ALPHA,
    openAskLinks: links,
    ...over,
  })} />);
}

beforeEach(() => {
  setController({ openThread: vi.fn(async () => undefined) } as unknown as Controller);
  useAppStore.getState().reset();
});
afterEach(() => cleanup());

describe('말 슬롯 — 무엇을 기다리는가', () => {
  it('누가 누구를 기다리는지 한 문장으로 말한다', () => {
    summary([link(BETA, ALPHA)]);
    expect(screen.getByTestId('speech-slot').textContent).toBe('beta 가 alpha의 답을 기다린다');
  });

  /**
   * **사람 대 사람도 같은 줄을 받는다**(문서): *"`minsu 가 sora의 답을 기다린다` 는
   * `beta 가 alpha의 답을 기다린다` 와 같은 문장이다 — 이것이 '사람끼리 일하듯'의
   * 실제 모양이다."* 스레드가 사람 회의인지 에이전트 작업인지는 요약 줄이 답할 질문이
   * 아니다.
   */
  it('사람끼리도 같은 문장이다 — 사람과 에이전트를 가르지 않는다', () => {
    summary([link(MINSU, SORA)]);
    expect(screen.getByTestId('speech-slot').textContent).toBe('minsu 가 sora의 답을 기다린다');
  });

  /** '사람 아무나'는 이름 자리에 보통명사를 끼우면 조사가 어긋난다. */
  it("'사람 아무나'를 기다리는 것은 다른 문장이다", () => {
    summary([link(ALPHA, null)]);
    expect(screen.getByTestId('speech-slot').textContent).toBe('alpha 가 사람의 답을 기다린다');
  });

  it('받침에 따라 이/가 가 갈린다', () => {
    summary([link(MINSU, SORA)]);
    // `minsu` 는 받침이 없다 → `가`.
    expect(screen.getByTestId('speech-slot').textContent).toContain('minsu 가');
  });
});

describe('명단이 되지 않는다', () => {
  /**
   * **문서가 명단을 물린 핵심 이유.** 일곱이 답한 스레드에서도 이름은 **둘**이다 —
   * 가운데 마디는 이름을 받지 않는다. 그것이 명단이 되는 지점이다.
   */
  /**
   * **사슬이 정말로 여러 마디인 경우.** 사슬은 가장 최근 물음에서 출발해 나에게 닿으면
   * 멈추므로(슬라이스 1 에서 실측), `... → 나` 로 끝나는 사슬은 마디가 **하나**다.
   * 가운데가 생기려면 끝이 '사람 아무나'여야 한다:
   *
   *     forge → beta → alpha → (사람 아무나)
   *
   * 이때 이름을 받는 것은 **양 끝뿐**이고 `beta`·`alpha` 는 받지 않는다 — 가운데를
   * 나열하는 순간 그것이 문서가 물린 명단이다.
   */
  it('마디가 셋이어도 가운데는 이름을 받지 않는다', () => {
    summary([link(ALPHA, null), link(BETA, ALPHA), link(FORGE, BETA)]);
    const text = screen.getByTestId('speech-slot').textContent ?? '';

    // 시작한 쪽 = forge. 끝 = 사람 아무나(이름이 아니라 '사람').
    expect(text).toBe('forge 가 사람의 답을 기다린다');
    // 가운데 둘은 한 글자도 나오지 않는다.
    expect(text).not.toContain('beta');
    expect(text).not.toContain('alpha');
  });

  /**
   * **참여자가 늘어도 줄이 길어지지 않는다.** 명단은 참여자 수에 따라 길어지지만
   * 이 줄은 그렇지 않다 — 그것이 문서가 요구한 성질이다.
   */
  it('참여자가 넷이어도 줄 길이가 참여자 수와 무관하다', () => {
    summary([link(BETA, ALPHA)], { participantIds: [ALPHA, BETA, MINSU, SORA, FORGE, ME] });
    expect(screen.getByTestId('speech-slot').textContent).toBe('beta 가 alpha의 답을 기다린다');
  });
});

describe('아무도 기다리지 않으면', () => {
  /**
   * 문서: *"아무도 기다리지 않으면 이름은 아예 안 나오고 숫자와 시각만 남는다."*
   * 그 자리는 3단계(배지 + 답장 수)로 돌아간다.
   */
  it('이름이 아예 안 나오고 배지와 답장 수만 남는다', () => {
    summary([]);
    expect(screen.queryByTestId('speech-slot')).toBeNull();
    expect(screen.getByText(/4 replies/)).toBeTruthy();
  });

  /** 재료가 없는 것(옛 서버·답글 행)도 마찬가지다 — 모르는 것을 문장으로 지어내지 않는다. */
  it('재료가 없으면 문장을 지어내지 않는다', () => {
    summary(null);
    expect(screen.queryByTestId('speech-slot')).toBeNull();
  });
});

describe('강조는 나를 막을 때만', () => {
  /**
   * **규칙 04.** 문서: *"내가 기다려지면 막는 말이 되어 강조를 받고, 내가 참여자면
   * 읽히는 말, 아니면 배경이 된다."*
   */
  it('내가 기다려지면 강조를 받는다', () => {
    summary([link(ALPHA, ME)]);
    const slot = screen.getByTestId('speech-slot');
    expect(slot.dataset.mine).toBe('true');
    expect(slot.className).toContain('state-turn');
  });

  it('남끼리 기다리는 것은 강조를 받지 않는다', () => {
    summary([link(BETA, ALPHA)]);
    const slot = screen.getByTestId('speech-slot');
    expect(slot.dataset.mine).not.toBe('true');
    expect(slot.className).not.toContain('state-turn');
  });

  /**
   * **하나의 스레드는 한 줄만 받는다**(문서: "위에서부터 이긴다"). 사슬이 있으면
   * 배지는 서지 않는다 — 배지는 "내 차례"까지만 말하고 이 줄은 누구를 기다리는지까지
   * 말하므로, 둘이 함께 서면 같은 사실을 두 번 말한다.
   */
  it('사슬이 있으면 배지는 서지 않는다', () => {
    summary([link(ALPHA, ME)]);
    expect(screen.getByTestId('speech-slot')).toBeTruthy();
    expect(screen.queryByTestId('thread-state')).toBeNull();
  });
});

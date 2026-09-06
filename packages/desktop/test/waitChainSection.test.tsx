// **지금 누가 누구를 기다리는가** — 인박스의 한 구획(#488 A3-b → C2).
//
// **사이드바에서 옮겼다.** 문서는 이것을 사이드바의 `ACTIVE WORK` 자리에 두라고 했지만,
// 그 `nav` 는 `overflow-y-auto` 이고 이 구획은 채널·DM·에이전트 다음이라 채널이 몇 개만
// 늘어도 스크롤 밖으로 밀린다 — "지금 무엇이 막혀 있는가"를 말하는 자리가 정작 그것을
// 알아야 할 때 안 보였다. 아래 회귀선들이 지키는 것(빈 상태·강조·정렬)은 자리가 바뀌어도
// 그대로 유효하다.
//
// 오류가 비운 자리에 들어가는 것. 문서: *"컨셉의 대기 사슬이 처음으로 화면에 보이는
// 곳이다."* 지금까지 사슬은 스레드를 열어야만 보였는데, "무엇이 멈춰 있는가"는 열기
// **전에** 묻는 질문이다.
//
// 이 파일이 지키는 것은 **판정이 아니라 화면**이다 — 사슬 판정(`walk()`)의 회귀선은
// `waitChain.test.tsx` 에 있고, 여기서 그것을 또 재면 같은 판정이 두 벌이 된다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { OpenAskLink } from '@murmur/shared';
import { useActiveStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { WaitChainSection } from '../src/components/WaitChainSection';
import { acc, chan, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';

const link = (waiter: string, blockedBy: string | null): OpenAskLink =>
  ({ waiter, blockedBy, askedAt: new Date(Date.now() - 3 * 60_000).toISOString() });

/** 루트 하나에 마디를 실어 채널에 앉힌다 — **화면이 실제로 보는 모양**이다. */
function seed(links: OpenAskLink[] | null, opts: { id?: string; connected?: boolean } = {}) {
  const id = opts.id ?? 'root-1';
  useActiveStore.getState().set({
    me: acc(ME, 'me'),
    accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge'), [CODEX]: acc(CODEX, 'codex') },
    channels: [chan('c1', 'general')],
    messages: { c1: [msg(id, 'c1', 1, '루트', FORGE, { openAskLinks: links })] },
    online: [FORGE, CODEX],
    connected: opts.connected ?? true,
  });
  return id;
}

let controller: { openThread: ReturnType<typeof vi.fn> };
beforeEach(() => {
  controller = { openThread: vi.fn(async () => undefined) };
  setController(controller as unknown as Controller);
  useActiveStore.getState().reset();
});
afterEach(() => cleanup());

describe('기다리는 것이 없을 때', () => {
  /**
   * **한 줄로 조용히 비어 있는다**(문서). 여기서 "없다"를 크게 말하면 아무 일도 없는
   * 것이 화면에서 가장 큰 목소리가 된다.
   */
  it('마디가 없으면 한 줄만 남는다', () => {
    seed([]);
    render(<WaitChainSection />);
    expect(screen.getByText('기다리는 것이 없다')).toBeTruthy();
    expect(screen.queryByTestId(/^wait-chain-r/)).toBeNull();
  });

  /**
   * 재료가 아예 없는 것(옛 서버)도 **조용하다** — 모르는 것을 사슬로 지어내지 않는다.
   */
  it('재료가 없어도 사슬을 지어내지 않는다', () => {
    seed(null);
    render(<WaitChainSection />);
    expect(screen.queryByTestId(/^wait-chain-r/)).toBeNull();
  });
});

describe('사슬이 있을 때', () => {
  it('누가 누구를 기다리는지 이름으로 말한다', () => {
    const id = seed([link(FORGE, ME)]);
    render(<WaitChainSection />);
    const row = screen.getByTestId(`wait-chain-${id}`);
    expect(row.textContent).toContain('forge');
    expect(row.textContent).toContain('me');
  });

  it('경과를 함께 말한다 — 얼마나 멈춰 있었는지가 급한 정도다', () => {
    const id = seed([link(FORGE, ME)]);
    render(<WaitChainSection />);
    expect(screen.getByTestId(`wait-chain-${id}`).textContent).toMatch(/3분/);
  });

  it('어느 채널인지 말한다 — 사이드바에서는 문맥이 없으면 못 찾아간다', () => {
    const id = seed([link(FORGE, ME)]);
    render(<WaitChainSection />);
    expect(screen.getByTestId(`wait-chain-${id}`).textContent).toContain('#general');
  });

  it('누르면 그 스레드가 열린다', () => {
    const id = seed([link(FORGE, ME)]);
    render(<WaitChainSection />);
    fireEvent.click(screen.getByTestId(`wait-chain-${id}`));
    expect(controller.openThread).toHaveBeenCalledWith(id);
  });

  it('내가 답하면 몇 개가 풀리는지 말한다', () => {
    const id = seed([link(CODEX, FORGE), link(FORGE, ME)]);
    render(<WaitChainSection />);
    expect(screen.getByTestId(`wait-chain-${id}`).textContent).toContain('2개가 풀린다');
  });
});

describe('강조는 나를 막는 것에만', () => {
  /**
   * **규칙 04.** 남을 기다리는 사슬까지 강조를 받으면 "내 차례"라는 신호가 죽는다 —
   * 사이드바는 그 신호가 가장 진해야 하는 자리다.
   */
  it('내 차례는 강조색을 받는다', () => {
    const id = seed([link(FORGE, ME)]);
    render(<WaitChainSection />);
    const row = screen.getByTestId(`wait-chain-${id}`);
    expect(row.dataset.end).toBe('me');
    expect(row.innerHTML).toContain('text-accent');
  });

  it('남을 기다리는 것은 강조색을 받지 않는다', () => {
    const id = seed([link(ME, FORGE)]);
    render(<WaitChainSection />);
    const row = screen.getByTestId(`wait-chain-${id}`);
    expect(row.dataset.end).not.toBe('me');
    expect(row.innerHTML).not.toContain('text-accent');
  });

  it('내 차례가 남을 기다리는 것보다 위에 온다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge'), [CODEX]: acc(CODEX, 'codex') },
      channels: [chan('c1', 'general')],
      messages: {
        c1: [
          msg('r-others', 'c1', 1, '남 차례', ME, { openAskLinks: [link(ME, FORGE)] }),
          msg('r-mine', 'c1', 2, '내 차례', FORGE, { openAskLinks: [link(FORGE, ME)] }),
        ],
      },
      online: [FORGE, CODEX],
      connected: true,
    });
    render(<WaitChainSection />);
    const order = screen.getAllByTestId(/^wait-chain-r/).map((el) => el.dataset.testid);
    expect(order[0]).toBe('wait-chain-r-mine');
  });
});

describe('생존을 모를 때', () => {
  /**
   * 소켓이 끊긴 것은 '아무도 없다'가 아니라 **'모른다'** 다(`threadState`·`waitChain` 과
   * 같은 규약). 모른다는 이유로 교착이라 부르면 그것도 거짓말이다.
   */
  it('소켓이 끊겨도 교착이라 부르지 않는다', () => {
    // forge 가 online 목록에 없지만 connected 가 false 라 '모른다'다.
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge') },
      channels: [chan('c1', 'general')],
      messages: { c1: [msg('r1', 'c1', 1, '루트', ME, { openAskLinks: [link(ME, FORGE)] }) ] },
      online: [],
      connected: false,
    });
    render(<WaitChainSection />);
    expect(screen.getByTestId('wait-chain-r1').dataset.end).not.toBe('deadlock');
  });
});

describe('"없다"와 "아직 안 봤다"는 다른 사실이다', () => {
  /**
   * **실측으로 찾은 결함**(2026-09-06). `store.messages` 는 **연 채널만** 채워지므로
   * 앱을 막 켰을 때는 거의 비어 있다. 그 상태에서 "기다리는 것이 없다"를 띄우면,
   * 서버가 마디를 네 개 실어 보내는데도 화면이 없다고 말한다 — 이 작업이 없애려던
   * 바로 그 거짓말(열어 보지 않은 것을 없다고 단정하는 것)과 같은 모양이다.
   */
  /**
   * **제목과 본문이 반대되는 말을 하지 않는다**(실측 2026-09-07, 사용자가 발견).
   * 제목이 `(0)` 이고 본문이 "아직 다 보지 못했다"이면 한 구획이 두 가지를 주장한다 —
   * 본문은 정직한데 제목이 **안 본 것을 0으로 단정**한다.
   */
  it('모를 때는 제목이 수를 말하지 않는다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general'), chan('c2', 'design')],
      messages: { c1: [] },   // c2 는 아직 안 열었다.
      online: [],
      connected: true,
    });
    render(<WaitChainSection />);
    const heading = screen.getByTestId('wait-chain-section').querySelector('h3');
    expect(heading?.textContent).not.toContain('0');
    expect(screen.getByText('아직 다 보지 못했다')).toBeTruthy();
  });

  it('다 봤으면 제목이 수를 말한다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general')],
      messages: { c1: [] },
      online: [],
      connected: true,
    });
    render(<WaitChainSection />);
    expect(screen.getByTestId('wait-chain-section').querySelector('h3')?.textContent).toContain('0');
  });

  it('아직 안 본 채널이 있으면 없다고 단정하지 않는다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general'), chan('c2', 'design')],
      messages: { c1: [] },   // c2 는 아직 안 열었다 — undefined 다.
      online: [],
      connected: true,
    });
    render(<WaitChainSection />);
    expect(screen.getByText('아직 다 보지 못했다')).toBeTruthy();
  });

  it('다 봤고 정말 없으면 없다고 말한다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general')],
      messages: { c1: [] },
      online: [],
      connected: true,
    });
    render(<WaitChainSection />);
    expect(screen.getByText('기다리는 것이 없다')).toBeTruthy();
  });
});

// **스레드는 자기 채널에서 열린다** (jaebin 보고, 2026-09-09).
//
// 인박스의 `WAITING ON` 줄을 누르면 **아무것도 없는 빈 스레드**가 떴다. 원인은 화면이
// 아니라 계약이었다: `openThread` 가 채널을 인자로 받지 않고 **그때의 활성 채널**을
// 스토어에서 읽었다. 그 구획은 채널 전체를 훑어 만들어지므로 줄이 가리키는 뿌리는 대개
// 다른 채널에 있고, 그러면 `?thread=<다른 채널의 뿌리>` 를 활성 채널에 물어 **200 에 0줄**
// 을 받는다(서버는 오류가 아니다 — 그 채널에 없는 뿌리일 뿐이다). 패널은 뿌리만 세운 채
// 영원히 비어 있고, 배지는 `threadState` 가 빈 목록을 `done` 으로 읽어 **`끝남`** 이라고
// 적었다 — 못 불러온 것을 끝난 것으로 그리는 것이 `design.md` §4 가 금지한 거짓말이다.
//
// 그래서 이 파일이 재는 것은 셋이다: (1) 채널을 주면 그 채널로 **옮긴다**, (2) 뿌리가
// 응답에 없으면 **열지 않고 말한다**, (3) 조회가 터져도 같다. `send()` 가 #223 에서
// 자리를 인자로 받게 된 것과 같은 규율이고, 같은 결함이 여기서 실제로 났다.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { acc, chan, msg, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/** c1 에는 뿌리 m1, c2 에는 뿌리 n1. **채널마다 다른 스레드**가 있는 것이 이 파일의 전제다. */
const PAGES: Record<string, ReturnType<typeof msg>[]> = {
  c1: [msg('m1', 'c1', 1, 'c1 의 뿌리', 'u1')],
  c2: [msg('n1', 'c2', 1, 'c2 의 뿌리', 'u1'), msg('n2', 'c2', 2, 'c2 의 답글', 'u2', { threadRootId: 'n1' })],
};

function mount(overrides: Parameters<typeof fakeApi>[0] = {}) {
  const messages = vi.fn(async (channelId: string, opts?: { thread?: string }) => {
    const rows = PAGES[channelId] ?? [];
    // 서버와 같은 규약: 스레드를 물으면 **그 채널 안에서** 뿌리와 답글만 준다. 다른
    // 채널의 뿌리를 물으면 걸리는 것이 없어 빈 목록이다(오류가 아니다).
    const hit = opts?.thread ? rows.filter((m) => m.id === opts.thread || m.threadRootId === opts.thread) : rows;
    return { messages: hit, hasMore: false };
  });
  const api = fakeApi({
    channels: vi.fn(async () => [chan('c1', 'general'), chan('c2', 'forge')]),
    messages: messages as unknown as ReturnType<typeof fakeApi>['messages'],
    ...overrides,
  });
  const c = new Controller(api, fakeWsFactory().makeWs);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'), channels: [chan('c1', 'general'), chan('c2', 'forge')], activeChannelId: 'c1',
  });
  return { c, messages };
}

beforeEach(() => { useAppStore.getState().reset(); });

describe('다른 채널의 스레드', () => {
  it('채널을 주면 그 채널로 옮기고 뿌리를 세운다', async () => {
    const { c } = mount();
    await c.openThread('n1', { channelId: 'c2' });
    expect(useAppStore.getState().activeChannelId).toBe('c2');
    expect(useAppStore.getState().threadRootId).toBe('n1');
    // 답글이 **활성 채널의** 목록에 들어와 있어야 패널이 그린다(`ThreadPanel` 의 필터).
    expect(useAppStore.getState().messages.c2?.map((m) => m.id)).toContain('n2');
  });

  it('채널을 주지 않으면 활성 채널이다 — 같은 채널 안의 호출이 짧게 남는다', async () => {
    const { c, messages } = mount();
    await c.openThread('m1');
    expect(messages.mock.calls.at(-1)?.[0]).toBe('c1');
    expect(useAppStore.getState().threadRootId).toBe('m1');
  });

  /**
   * **이것이 보고된 결함 그 자체다.** 옛 계약에서는 이 호출이 `?thread=n1` 을 `c1` 에 물어
   * 0줄을 받고도 패널을 열어 두었다. 지금은 채널을 주지 않은 것이 곧 "활성 채널의 뿌리"라는
   * 뜻이므로, 없는 뿌리는 **열리지 않고** 사람에게 사유가 간다.
   */
  it('그 채널에 없는 뿌리는 열지 않고 사유를 말한다', async () => {
    const { c } = mount();
    await c.openThread('n1');
    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notice).toMatch(/gone/);
  });

  it('조회가 터지면 빈 패널을 남기지 않는다', async () => {
    const { c } = mount({ messages: vi.fn(async () => { throw new Error('offline'); }) as never });
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notice).toMatch(/connection/);
  });
});

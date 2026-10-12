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
import { ApiError } from '../src/lib/api';
import { acc, chan, msg, fakeApi, fakeWsFactory } from './helpers/fakeApi';
import type { MessageRow } from '@harkroom/shared';

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
    expect(useAppStore.getState().notices.at(-1)?.text ?? null).toMatch(/gone/);
  });

  it('조회가 터지면 빈 패널을 남기지 않는다', async () => {
    const { c } = mount({ messages: vi.fn(async () => { throw new Error('offline'); }) as never });
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notices.at(-1)?.text ?? null).toMatch(/connection/);
  });
});

/**
 * **끊긴 동안 이미 본 스레드** (jaebin 보고, 2026-10-12). 스토어에 답글이 있는데도 조회가
 * 실패했다는 이유로 패널을 닫고 「연결을 확인하라」만 띄웠다. 가진 것은 보여야 한다.
 */
describe('끊긴 동안 받아 둔 스레드', () => {
  const offline = vi.fn(async () => { throw new Error('offline'); });

  it('같은 채널 — 받아 둔 답글이 있으면 조회가 터져도 패널을 닫지 않는다', async () => {
    const { c } = mount({ messages: offline as never });
    useAppStore.getState().upsertMessages('c1', [
      msg('m1', 'c1', 1, 'c1 의 뿌리', 'u1'),
      msg('m2', 'c1', 2, '받아 둔 답글', 'u2', { threadRootId: 'm1' }),
    ]);
    await c.openThread('m1', { focusMessageId: 'm2' });
    expect(useAppStore.getState().threadRootId).toBe('m1');
    expect(useAppStore.getState().highlightedMessageId).toBe('m2');
    expect(useAppStore.getState().notices).toHaveLength(0);
  });

  it('다른 채널 — 채널 열기가 터져도 받아 둔 스레드는 열린다', async () => {
    const { c } = mount({ messages: offline as never });
    useAppStore.getState().upsertMessages('c2', PAGES.c2!);
    await c.openThread('n1', { channelId: 'c2' });
    expect(useAppStore.getState().activeChannelId).toBe('c2');
    expect(useAppStore.getState().threadRootId).toBe('n1');
    expect(useAppStore.getState().notices).toHaveLength(0);
  });

  it('다른 채널 — 받아 둔 것이 있으면 답 없는 채널 조회를 기다리지 않는다', async () => {
    // 서버가 소켓만 받고 답을 안 하는 장애(2026-10-12). 채널 조회는 끝나지 않고 스레드 조회는 터진다.
    const hang = vi.fn((_c: string, opts?: { thread?: string }) => (opts?.thread
      ? Promise.reject(new Error('offline'))
      : new Promise(() => {})));
    const { c } = mount({ messages: hang as never });
    useAppStore.getState().upsertMessages('c2', PAGES.c2!);
    await c.openThread('n1', { channelId: 'c2' });
    expect(useAppStore.getState().activeChannelId).toBe('c2');
    expect(useAppStore.getState().threadRootId).toBe('n1');
  });

  it('다른 채널 — 받아 둔 것이 없으면 조용히 끝나지 않고 사유를 말한다', async () => {
    const { c } = mount({ messages: offline as never });
    await expect(c.openThread('n1', { channelId: 'c2' })).resolves.toBeUndefined();
    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notices.at(-1)?.text ?? null).toMatch(/connection/);
  });

  /** designer s1 — 뿌리 한 줄로 패널을 세우면 「답 0개 · 끝남」이 된다. */
  it('같은 채널 — 뿌리만 있고 답글이 없으면 닫고 사유를 말한다', async () => {
    const { c } = mount({ messages: offline as never });
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, 'c1 의 뿌리', 'u1')]);
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notices.at(-1)?.text ?? null).toMatch(/connection/);
  });

  /** security F1 — 서버가 답한 거절은 받아 둔 줄이 있어도 닫는다(지워진·빠진 대화). */
  const held = () => useAppStore.getState().upsertMessages('c1', [
    msg('m1', 'c1', 1, 'c1 의 뿌리', 'u1'),
    msg('m2', 'c1', 2, '받아 둔 답글', 'u2', { threadRootId: 'm1' }),
  ]);
  it('403 이면 받아 둔 답글이 있어도 닫고 「들어가 있지 않은 대화」라 말한다', async () => {
    const { c } = mount({ messages: vi.fn(async () => { throw new ApiError(403, 'forbidden', 'nope'); }) as never });
    held();
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notices.at(-1)?.text ?? null).toMatch(/not part of/);
  });
  it('404 면 받아 둔 답글이 있어도 닫고 「없다」고 말한다', async () => {
    const { c } = mount({ messages: vi.fn(async () => { throw new ApiError(404, 'not_found', 'gone'); }) as never });
    held();
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBeNull();
    expect(useAppStore.getState().notices.at(-1)?.text ?? null).toMatch(/gone/);
  });
  it('5xx 는 전송 실패로 친다 — 받아 둔 답글로 연다', async () => {
    const { c } = mount({ messages: vi.fn(async () => { throw new ApiError(503, 'unavailable', 'db down'); }) as never });
    held();
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBe('m1');
    expect(useAppStore.getState().notices).toHaveLength(0);
  });

  /** security n1 — 늦게 온 실패가 그 사이 연 다른 스레드를 닫지 않는다. */
  it('늦게 온 실패는 그 사이 연 다른 스레드를 건드리지 않는다', async () => {
    let failX!: (e: Error) => void;
    const messages = vi.fn((_c: string, o?: { thread?: string }) => (o?.thread === 'x1'
      ? new Promise((_r, rej) => { failX = rej; })
      : Promise.reject(new Error('offline'))));
    const { c } = mount({ messages: messages as never });
    held();
    useAppStore.getState().upsertMessages('c1', [msg('x1', 'c1', 5, '안 받아 둔 스레드', 'u1')]);
    const opening = c.openThread('x1');
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBe('m1');
    failX(new Error('timeout'));
    await opening;
    expect(useAppStore.getState().threadRootId).toBe('m1');
  });

  it('다른 스레드의 줄은 손에 든 것으로 치지 않는다', async () => {
    const { c } = mount({ messages: offline as never });
    useAppStore.getState().upsertMessages('c1', [msg('x1', 'c1', 5, '남의 뿌리', 'u1')]);
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBeNull();
  });
});

/**
 * 「다시 연결되면 저절로 불러온다」(designer 시안 ③·④)가 성립하는 근거. 재접속의 증분(`since`)은
 * 끊긴 사이의 **새** 줄만 주므로, 끊긴 동안 연 스레드에서 못 받은 옛 답글은 따로 물어야 온다.
 */
describe('재접속 때 열린 스레드', () => {
  it('일부 답글만 손에 있던 스레드의 옛 답글을 다시 붙으면 받아 온다', async () => {
    const server: MessageRow[] = [
      msg('m1', 'c1', 1, '뿌리', 'u1'),
      msg('m2', 'c1', 2, '옛 답글', 'u2', { threadRootId: 'm1' }),
      msg('m3', 'c1', 3, '다른 글', 'u1'),
    ];
    let up = false;
    const messages = vi.fn(async (_c: string, o?: { thread?: string; since?: number }) => {
      if (!up) throw new Error('offline');
      if (o?.thread) return { messages: server.filter((m) => m.id === o.thread || m.threadRootId === o.thread), hasMore: false };
      if (o?.since) return { messages: server.filter((m) => m.seq > o.since!), hasMore: false };
      return { messages: server, hasMore: false };
    });
    const api = fakeApi({ messages: messages as never });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    useAppStore.getState().set({ activeChannelId: 'c1' });
    // 끊기기 전에 받은 것: 뿌리(m1)·m3·채널에도 올라온 새 답글 m4. 옛 답글 m2 는 없다.
    server.push(msg('m4', 'c1', 4, '채널에도 올라온 답글', 'u2', { threadRootId: 'm1' }));
    useAppStore.getState().upsertMessages('c1', [server[0]!, server[2]!, server[3]!]);
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBe('m1');
    expect(useAppStore.getState().messages.c1!.some((m) => m.id === 'm2')).toBe(false);
    up = true;
    callbacks.current!.onOpen();
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1!.some((m) => m.id === 'm2')).toBe(true));
  });
});

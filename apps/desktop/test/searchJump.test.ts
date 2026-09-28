import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

/**
 * 검색 결과를 눌렀을 때 **그 말이 실제로 화면에 서는가**(⌘F·⌘K 가 같은 경로를 쓴다).
 *
 * 강조(`highlightedMessageId`)는 그 메시지가 목록에 **실려 있어야** 뜻이 있다 — DOM 이
 * 없으면 스크롤도 강조도 일어나지 않고, 누른 사람에게는 아무 일도 안 한 것으로 보인다.
 * 옛 메시지는 채널을 열 때 오는 최신 페이지에 없으므로 그 자리를 가운데 둔 창을 따로 받는다.
 */
describe('검색 결과로 점프 — 창을 받아 강조가 걸린다', () => {
  it('최신 페이지에 없는 옛 메시지는 around 창을 받아 목록에 채운다', async () => {
    const old = msg('m-old', 'c1', 3, '옛날 이야기');
    const messages = vi.fn(async (_id: string, opts?: { around?: number; thread?: string }) => (
      opts?.around !== undefined
        ? { messages: [msg('m-2', 'c1', 2, '앞'), old, msg('m-4', 'c1', 4, '뒤')], hasMore: true }
        : { messages: [msg('m-99', 'c1', 99, '최신')], hasMore: true }
    ));
    const api = fakeApi({ messages, message: vi.fn(async () => old) });
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();

    await c.openMessage('m-old');

    // 창을 그 seq 로 물었는가.
    expect(messages.mock.calls.some(([, o]) => o?.around === 3)).toBe(true);
    // 그리고 실제로 목록에 실렸는가 — 강조가 걸릴 자리다.
    expect(useAppStore.getState().messages.c1!.map((m) => m.id)).toContain('m-old');
    expect(useAppStore.getState().highlightedMessageId).toBe('m-old');
  });

  // 이미 실려 있으면 왕복을 만들지 않는다.
  it('이미 목록에 있는 메시지에는 창을 다시 받지 않는다', async () => {
    const here = msg('m-here', 'c1', 5, '여기 있다');
    const messages = vi.fn(async (_id: string, _opts?: { around?: number; thread?: string }) =>
      ({ messages: [here], hasMore: false }));
    const api = fakeApi({ messages, message: vi.fn(async () => here) });
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();

    await c.openMessage('m-here');

    expect(messages.mock.calls.every(([, o]) => o?.around === undefined)).toBe(true);
  });

  /**
   * 답글이면 강조가 걸릴 DOM 은 **스레드 패널** 쪽이다. 스레드도 최신 페이지만 뜨므로
   * seq 를 함께 주지 않으면, 채널 쪽 창을 받아 놓고도 옛 답글은 패널에 없다 —
   * 스레드 패널에는 위로 더 읽는 길도 없어 그 말에 닿을 방법이 사라진다.
   */
  it('답글이면 스레드 조회에도 그 seq 를 함께 준다', async () => {
    const reply = msg('m-reply', 'c1', 7, '옛 답글');
    reply.threadRootId = 'root-1';
    const messages = vi.fn(async (_id: string, _opts?: { around?: number; thread?: string }) =>
      ({ messages: [], hasMore: false }));
    const api = fakeApi({ messages, message: vi.fn(async () => reply) });
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();

    await c.openMessage('m-reply');

    const threadCall = messages.mock.calls.find(([, o]) => o?.thread === 'root-1');
    expect(threadCall).toBeDefined();
    expect(threadCall![1]).toMatchObject({ thread: 'root-1', around: 7 });
  });
});

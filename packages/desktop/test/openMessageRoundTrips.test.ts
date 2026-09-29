/**
 * **메시지로 점프하는 왕복은 겹쳐 간다** (saved·검색·링크, 2026-09-29).
 *
 * 왕복 하나가 약 390ms 인 서버에서 `openMessage` 는 메시지 조회 → 채널 열기 → around 창 →
 * 스레드 조회를 하나씩 기다렸다. 서로를 기다릴 이유가 있는 것은 "대상이 어디 사는가"
 * 하나뿐이므로, 이 파일은 그 밖의 조회가 **채널 열기가 끝나기 전에 이미 나가 있는지**를
 * 시간이 아니라 상태(풀지 않은 promise)로 잰다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

type Page = { messages: MessageRow[]; hasMore: boolean };
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => useAppStore.getState().reset());

/** 채널 c2 를 한 번 열어 둔 컨트롤러. 그 뒤의 채널 조회(증분)는 `gate` 가 풀릴 때까지 선다. */
async function loadedController(target: MessageRow, opts: { cacheTarget: boolean }) {
  const gate = deferred<Page>();
  let gated = false;
  const messages = vi.fn(async (_c: string, o?: { since?: number; around?: number; thread?: string }) => {
    if (o?.thread) return { messages: [target], hasMore: false };
    if (o?.around !== undefined) return { messages: [target], hasMore: true };
    if (gated) return gate.promise;
    return { messages: [msg('latest', 'c2', 900, '최신')], hasMore: true };
  });
  const message = vi.fn(async () => target);
  const c = new Controller(fakeApi({ messages, message }), fakeWsFactory().makeWs);
  await c.start();
  await c.openChannel('c2');
  if (opts.cacheTarget) useAppStore.getState().upsertMessages('c2', [target]);
  await c.openChannel('c1');
  gated = true;
  messages.mockClear();
  return { c, messages, message, gate };
}

describe('openMessage 의 왕복', () => {
  it('스토어에 있는 답글이면 메시지를 다시 묻지 않고, 스레드를 채널 열기와 함께 묻는다', async () => {
    const reply = { ...msg('rep', 'c2', 6, '옛 답글'), threadRootId: 'root-x' };
    const { c, messages, message, gate } = await loadedController(reply, { cacheTarget: true });

    const done = c.openMessage('rep');
    await vi.waitFor(() => expect(messages.mock.calls.some(([, o]) => o?.thread === 'root-x')).toBe(true));
    // 채널 조회는 아직 서 있다 — 스레드 조회가 그것을 기다리지 않았다는 뜻이다.
    expect(message).not.toHaveBeenCalled();

    gate.resolve({ messages: [], hasMore: false });
    await done;
    expect(useAppStore.getState().threadRootId).toBe('root-x');
    expect(useAppStore.getState().highlightedMessageId).toBe('rep');
  });

  it('이미 연 채널의 옛 메시지면 around 창을 채널 열기와 함께 묻는다', async () => {
    const old = msg('old', 'c2', 5, '옛 이야기');
    const { c, messages, gate } = await loadedController(old, { cacheTarget: false });

    const done = c.openMessage('old');
    await vi.waitFor(() => expect(messages.mock.calls.some(([, o]) => o?.around === 5)).toBe(true));

    gate.resolve({ messages: [], hasMore: false });
    await done;
    expect(useAppStore.getState().messages.c2!.map((m) => m.id)).toContain('old');
    expect(useAppStore.getState().highlightedMessageId).toBe('old');
  });
});

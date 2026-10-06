/**
 * 콜드 스타트 A안 — 마지막 채널 복원 + 첫 페이지 미리 받기(2026-10-06).
 *
 * 재시작 뒤 첫 채널 진입이 느렸던 까닭은, 메시지 요청이 기동 묶음(`start()`)이 끝나고 사람이
 * 채널을 누른 **뒤에야** 나갔기 때문이다. 이 파일이 붙잡는 규율:
 *  - 기억한 채널의 첫 페이지는 기동 묶음과 **같이** 나간다(묶음이 끝나기 전에 이미 불렸다).
 *  - 그 채널을 여는 길은 새로 묻지 않고 미리 받은 것에 합류한다 — 요청은 하나다.
 *  - 기억은 커뮤니티·계정별이다. 목록에 없는 채널이면 열지 않고 기억을 지운다.
 *  - 응답을 기다리는 사이 다른 채널로 갔으면 그 채널을 읽음 처리하지 않는다.
 *  - 로그아웃하면 그 계정의 기억을 지운다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, INITIAL_HISTORY_LIMIT } from '../src/state/controller';
import { lastChannelScope, lastChannelStorage } from '../src/lib/prefs';
import { chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

const SCOPE = lastChannelScope('https://a.example.com', 'acct-1')!;

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('콜드 스타트: 마지막 채널 복원', () => {
  it('열쇠는 서버 주소 + 계정 id 이고, 계정 id 가 비면 기억하지 않는다', () => {
    expect(lastChannelScope('https://a.example.com', '')).toBeNull();
    lastChannelStorage.save(SCOPE, 'c1');
    lastChannelStorage.save(lastChannelScope('https://b.example.com', 'acct-1')!, 'c9');
    expect(lastChannelStorage.load(SCOPE)).toBe('c1');
    expect(lastChannelStorage.load(lastChannelScope('https://b.example.com', 'acct-1')!)).toBe('c9');
    lastChannelStorage.remove(SCOPE);
    expect(lastChannelStorage.load(SCOPE)).toBeNull();
    expect(lastChannelStorage.load(lastChannelScope('https://b.example.com', 'acct-1')!)).toBe('c9');
  });

  it('기억한 채널의 첫 페이지는 기동 묶음과 같이 나가고, 열 때 다시 묻지 않는다', async () => {
    lastChannelStorage.save(SCOPE, 'c1');
    const channelsGate = deferred<ReturnType<typeof chan>[]>();
    const messages = vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, '안녕', 'u2')], hasMore: false }));
    const { makeWs } = fakeWsFactory();
    const c = new Controller(fakeApi({ messages, channels: vi.fn(() => channelsGate.promise) }), makeWs);
    c.lastChannelScope = SCOPE;

    const started = c.start();
    // 기동 묶음(channels)이 아직 답하지 않았는데 메시지 요청은 이미 나갔다 — 병렬이다.
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith('c1', { since: 0, limit: INITIAL_HISTORY_LIMIT });

    channelsGate.resolve([chan('c1', 'general')]);
    await started;
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1?.length).toBe(1));
    expect(useAppStore.getState().activeChannelId).toBe('c1');
    expect(messages).toHaveBeenCalledTimes(1);

    // 사람이 그 채널을 다시 누르면 두 번째 진입(증분) 길이다.
    messages.mockClear();
    await c.openChannel('c1');
    expect(messages).toHaveBeenCalledWith('c1', { since: 1, limit: 200 });
  });

  it('응답 전에 사람이 그 채널을 눌러도 요청은 하나다', async () => {
    lastChannelStorage.save(SCOPE, 'c1');
    const page = deferred<{ messages: ReturnType<typeof msg>[]; hasMore: boolean }>();
    const messages = vi.fn(() => page.promise);
    const { makeWs } = fakeWsFactory();
    const c = new Controller(fakeApi({ messages: messages as never }), makeWs);
    c.lastChannelScope = SCOPE;
    await c.start();
    const clicked = c.openChannel('c1');
    page.resolve({ messages: [msg('m1', 'c1', 1, '안녕', 'u2')], hasMore: false });
    await clicked;
    expect(messages).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().messages.c1?.length).toBe(1);
  });

  it('미리 받기가 실패하면 열 때 다시 묻는다', async () => {
    lastChannelStorage.save(SCOPE, 'c1');
    let n = 0;
    const messages = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('network');
      return { messages: [msg('m1', 'c1', 1, '안녕', 'u2')], hasMore: false };
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(fakeApi({ messages }), makeWs);
    c.lastChannelScope = SCOPE;
    await c.start();
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1?.length).toBe(1));
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it('목록에 없는 채널이면 열지 않고 기억을 지운다', async () => {
    lastChannelStorage.save(SCOPE, 'gone');
    const messages = vi.fn(async () => ({ messages: [], hasMore: false }));
    const { makeWs } = fakeWsFactory();
    const c = new Controller(fakeApi({ messages }), makeWs);
    c.lastChannelScope = SCOPE;
    await c.start();
    expect(useAppStore.getState().activeChannelId).toBeNull();
    expect(lastChannelStorage.load(SCOPE)).toBeNull();
  });

  it('채널을 열면 기억하고, 로그아웃하면 지운다', async () => {
    const { makeWs } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    c.lastChannelScope = SCOPE;
    await c.start();
    await c.openChannel('c1');
    expect(lastChannelStorage.load(SCOPE)).toBe('c1');
    c.logout();
    expect(lastChannelStorage.load(SCOPE)).toBeNull();
  });

  it('기다리는 사이 다른 채널로 갔으면 복원한 채널을 읽음 처리하지 않는다', async () => {
    lastChannelStorage.save(SCOPE, 'c1');
    const page = deferred<{ messages: ReturnType<typeof msg>[]; hasMore: boolean }>();
    const messages = vi.fn((channelId: string) => (
      channelId === 'c1' ? page.promise : Promise.resolve({ messages: [], hasMore: false })
    ));
    const markChannelRead = vi.fn(async () => {});
    const { makeWs } = fakeWsFactory();
    const c = new Controller(fakeApi({
      messages: messages as never,
      markChannelRead,
      channels: vi.fn(async () => [chan('c1', 'general'), chan('c2', 'random')]),
    }), makeWs);
    c.lastChannelScope = SCOPE;
    await c.start();
    await c.openChannel('c2');
    page.resolve({ messages: [msg('m1', 'c1', 5, '안녕', 'u2')], hasMore: false });
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1?.length).toBe(1));
    expect(markChannelRead).not.toHaveBeenCalledWith('c1', expect.anything());
    expect(useAppStore.getState().activeChannelId).toBe('c2');
  });
});

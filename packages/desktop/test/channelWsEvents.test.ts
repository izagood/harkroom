import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../src/state/appStore';
import { Controller } from '../src/state/controller';
import { chan, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/**
 * 채널 목록 변경 WS 이벤트의 데스크탑 쪽(#284).
 *
 * 서버가 수신자를 옳게 골라도 클라이언트가 목록을 고치지 않으면 지워진 채널이 남는다.
 * 여기서 확인하는 것은 **같은 이벤트를 서로 다른 상태의 두 클라이언트가 받았을 때**
 * 각자 옳게 반응하는가다: 그 채널을 보고 있던 사람은 화면이 비워지고 안내를 받아야 하고,
 * 다른 채널을 보고 있던 사람은 목록에서만 사라지고 보던 화면은 그대로여야 한다.
 *
 * 스토어는 모듈 하나짜리 싱글턴이라 두 클라이언트를 한 프로세스에 동시에 둘 수 없다.
 * 그래서 `reset()` 으로 갈라 두 대를 차례로 흉내 낸다.
 */
beforeEach(() => useAppStore.getState().reset());

const twoChannels = () => [chan('c1', 'general'), chan('c2', 'random')];

async function startWith(overrides = {}) {
  const api = fakeApi({ channels: vi.fn(async () => twoChannels()), ...overrides });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs);
  await c.start();
  return { api, controller: c, callbacks };
}

describe('채널 목록 변경 이벤트를 받는 데스크탑 (#284)', () => {
  it('6. 보고 있던 채널이 삭제되면 목록에서 사라지고 활성이 비워지며 안내가 보인다', async () => {
    const { callbacks } = await startWith();
    useAppStore.getState().set({ activeChannelId: 'c2', threadRootId: 'm9' });

    callbacks.current!.onEvent({ type: 'channel.deleted', channelId: 'c2', audience: 'all' });

    const s = useAppStore.getState();
    expect(s.channels.map((c) => c.id)).toEqual(['c1']);
    expect(s.activeChannelId).toBeNull();
    // 조용히 비우면 사람은 자기가 뭘 잘못 눌렀다고 생각한다 — 사라진 이유를 한 줄로 말한다.
    expect(s.notice).toMatch(/deleted/i);
    // 스레드 패널도 함께 닫혀야 한다. 남겨 두면 없는 채널의 스레드가 열린 채로 남는다.
    expect(s.threadRootId).toBeNull();
  });

  it('6b. 다른 채널을 보던 클라이언트는 목록에서만 잃고 보던 화면과 안내는 그대로다', async () => {
    const { callbacks } = await startWith();
    useAppStore.getState().set({ activeChannelId: 'c1' });

    callbacks.current!.onEvent({ type: 'channel.deleted', channelId: 'c2', audience: 'all' });

    const s = useAppStore.getState();
    expect(s.channels.map((c) => c.id)).toEqual(['c1']);
    expect(s.activeChannelId).toBe('c1');
    // 내가 보고 있지 않던 채널이 지워진 것은 알릴 사건이 아니다 — 안내가 뜨면 소음이 된다.
    expect(s.notice).toBeNull();
  });

  it('channel.created 는 목록에 채널을 넣고, 같은 채널이 두 번 와도 늘지 않는다', async () => {
    const { callbacks } = await startWith();
    const fresh = chan('c3', 'new-room');

    callbacks.current!.onEvent({ type: 'channel.created', channel: fresh, audience: 'all' });
    callbacks.current!.onEvent({ type: 'channel.created', channel: fresh, audience: 'all' });

    expect(useAppStore.getState().channels.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('channel.updated 는 이미 있는 채널을 갈아치운다', async () => {
    const { callbacks } = await startWith();

    callbacks.current!.onEvent({
      type: 'channel.updated', channel: { ...chan('c2', 'renamed'), topic: 'new topic' }, audience: 'all',
    });

    const c2 = useAppStore.getState().channels.find((c) => c.id === 'c2');
    expect(c2!.name).toBe('renamed');
    expect(c2!.topic).toBe('new topic');
    expect(useAppStore.getState().channels).toHaveLength(2);
  });

  // private→public 전환은 그때까지 목록에 없던 사람에게도 `channel.updated` 로 온다
  // (#284 가 이벤트 이름을 셋으로 고정했다). 교체만 하면 아무 일도 일어나지 않아,
  // 새로 열린 채널이 새로고침 전까지 보이지 않는다.
  it('channel.updated 가 목록에 없는 채널이면 넣는다 — private→public 전환', async () => {
    const { callbacks } = await startWith();
    const opened = chan('c9', 'was-private', null, 'public');

    callbacks.current!.onEvent({ type: 'channel.updated', channel: opened, audience: 'all' });

    expect(useAppStore.getState().channels.map((c) => c.id)).toEqual(['c1', 'c2', 'c9']);
  });

  it('saved.changed 는 본인 것이면 담기 요약을 다시 읽고, 남의 것이면 읽지 않는다', async () => {
    const savedSummary = vi.fn(async () => ({ openCount: 3, messageIds: ['m1', 'm2', 'm3'] }));
    const { callbacks } = await startWith({ savedSummary });
    const callsAfterStart = savedSummary.mock.calls.length;
    const meId = useAppStore.getState().me!.id;

    callbacks.current!.onEvent({ type: 'saved.changed', messageId: 'm1', state: 'open', accountId: meId });
    await vi.waitFor(() => expect(savedSummary.mock.calls.length).toBe(callsAfterStart + 1));
    expect(useAppStore.getState().savedCount).toBe(3);

    // 서버가 이미 본인 소켓만 골라 보내지만, 클라이언트도 계정을 확인한다 — 한쪽이
    // 넓어지면 남의 담기가 내 "Saved N" 을 흔든다.
    callbacks.current!.onEvent({ type: 'saved.changed', messageId: 'm1', state: 'open', accountId: 'someone-else' });
    await new Promise((r) => setTimeout(r, 20));
    expect(savedSummary.mock.calls.length).toBe(callsAfterStart + 1);
  });
});

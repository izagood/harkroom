import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../src/state/appStore';
import { Controller } from '../src/state/controller';
import { acc, accountsResult, chan, fakeApi, fakeWsFactory, grp } from './helpers/fakeApi';

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

/**
 * 멤버십·집합 변경 이벤트를 받는 데스크탑(#300).
 *
 * 서버가 옳은 수신자에게 보내도 **아무도 듣지 않으면** 화면은 그대로다 — 실측으로 그런
 * 이벤트가 있었다(#140). 여기서 확인하는 것은 이벤트마다 정말로 조회가 한 번 더 도는가다.
 */
describe('멤버십·집합 변경 이벤트를 받는 데스크탑 (#300)', () => {
  it('channel.member_added 는 들고 있는 채널의 멤버 목록을 다시 받는다', async () => {
    const channelMembers = vi.fn(async () => [{ accountId: 'u2', handle: 'bot' }]);
    const { callbacks, controller } = await startWith({ channelMembers });
    // 멤버 패널이 열려 있는 상태 — 그래야 다시 받을 이유가 있다.
    await controller.loadChannelMembers('c1');
    const before = channelMembers.mock.calls.length;

    callbacks.current!.onEvent({
      type: 'channel.member_added', channelId: 'c1', accountId: 'u3', audience: 'all',
    });
    await vi.waitFor(() => expect(channelMembers.mock.calls.length).toBe(before + 1));
  });

  it('channel.member_removed 도 같은 경로로 다시 받는다', async () => {
    const channelMembers = vi.fn(async () => [{ accountId: 'u2', handle: 'bot' }]);
    const { callbacks, controller } = await startWith({ channelMembers });
    await controller.loadChannelMembers('c1');
    const before = channelMembers.mock.calls.length;

    callbacks.current!.onEvent({
      type: 'channel.member_removed', channelId: 'c1', accountId: 'u2', audience: 'all',
    });
    await vi.waitFor(() => expect(channelMembers.mock.calls.length).toBe(before + 1));
  });

  it('안 들고 있는 채널의 멤버십 변경은 조회하지 않는다', async () => {
    const channelMembers = vi.fn(async () => []);
    const { callbacks } = await startWith({ channelMembers });
    const before = channelMembers.mock.calls.length;

    callbacks.current!.onEvent({
      type: 'channel.member_added', channelId: 'c2', accountId: 'u3', audience: 'all',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(channelMembers.mock.calls.length).toBe(before);
  });

  it('handle_group.changed 는 집합 목록을 다시 받아 구성원 수를 갱신한다', async () => {
    // 첫 조회는 구성원 0, 두 번째는 2 — 갱신이 실제로 화면 값까지 바꾸는지 본다.
    // 개수만 세면 조회를 하고 스토어에 안 넣어도 통과한다.
    let call = 0;
    const accounts = vi.fn(async () => {
      call += 1;
      return accountsResult([acc('u1', 'admin')], [grp('g1', 'team', 'Team', call === 1 ? 0 : 2)]);
    });
    const { callbacks } = await startWith({ accounts });
    await vi.waitFor(() => expect(useAppStore.getState().groups).toHaveLength(1));
    expect(useAppStore.getState().groups[0]!.memberCount).toBe(0);

    callbacks.current!.onEvent({ type: 'handle_group.changed', groupId: 'g1', audience: 'all' });

    await vi.waitFor(() => expect(useAppStore.getState().groups[0]!.memberCount).toBe(2));
  });

  /**
   * 이 경로는 `refreshAccounts` 의 5초 최소 간격 가드를 **넘어야** 한다. `force` 없이
   * 부르면 시작 직후의 조회로부터 5초가 지나지 않아 그냥 돌아오고, 집합을 방금 고친
   * 사람의 화면만 맞고 다른 사람 화면은 5초 동안 낡은 채 남는다.
   */
  it('handle_group.changed 는 최소 간격 가드에 막히지 않는다(force)', async () => {
    const accounts = vi.fn(async () => accountsResult([acc('u1', 'admin')], [grp('g1', 'team', 'Team')]));
    const { callbacks, controller } = await startWith({ accounts });
    // 가드를 **먼저 물린다**. 이 줄이 없으면 `lastAccountsRefresh` 가 0 이라 `force` 없이도
    // 조회가 돌아, `force` 를 지워도 테스트가 우연히 초록으로 남는다. 실제 화면에서는
    // 작성기가 `@` 를 칠 때마다 이 가드를 물려 둔다.
    await controller.refreshAccounts();
    const before = accounts.mock.calls.length;

    callbacks.current!.onEvent({ type: 'handle_group.changed', groupId: 'g1', audience: 'all' });
    await vi.waitFor(() => expect(accounts.mock.calls.length).toBe(before + 1));
  });
});

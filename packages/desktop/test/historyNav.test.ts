import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../src/state/appStore';
import { Controller } from '../src/state/controller';
import { fakeApi, acc } from './helpers/fakeApi';

const chan = (id: string) => ({ id, name: id, topic: null, kind: 'standard' as const, repo: null, archivedAt: null });

const seed = (channelIds: string[], history: string[], index: number) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    channels: channelIds.map(chan) as never,
    dms: [],
    history: history.map((channelId) => ({ channelId, threadRootId: null })),
    historyIndex: index,
  });
};

beforeEach(() => vi.useRealTimers());

describe('이력 탐색 (#187)', () => {
  it('뒤로 가면 historyIndex 가 하나 줄고 그 채널이 열린다', async () => {
    seed(['c1', 'c2', 'c3'], ['c1', 'c2', 'c3'], 2);
    const c = new Controller(fakeApi());

    expect(await c.goBack()).toBe(true);

    expect(useAppStore.getState().historyIndex).toBe(1);
    expect(useAppStore.getState().activeChannelId).toBe('c2');
  });

  // 뒤로 이동이 이력을 밀어 넣으면 스택이 자라 영원히 빠져나오지 못한다.
  it('뒤로 두 번 가면 처음 자리로 간다 — 뒤로가 이력을 밀어 넣지 않는다', async () => {
    seed(['c1', 'c2', 'c3'], ['c1', 'c2', 'c3'], 2);
    const c = new Controller(fakeApi());

    await c.goBack();
    await c.goBack();

    expect(useAppStore.getState().historyIndex).toBe(0);
    expect(useAppStore.getState().activeChannelId).toBe('c1');
    expect(useAppStore.getState().history).toHaveLength(3);
  });

  // 사라진 채널을 가리키는 항목에서 인덱스를 내리지 않고 다시 조회하면 같은 항목이
  // 영원히 돌아온다 — 채널 하나 지운 것이 앱을 멈춘다.
  it('사라진 채널을 가리키는 항목은 건너뛴다 (멈추지 않는다)', async () => {
    // c2 는 이력에 있지만 채널 목록에 없다 — 지워진 채널이다.
    seed(['c1', 'c3'], ['c1', 'c2', 'c3'], 2);
    const c = new Controller(fakeApi());

    expect(await c.goBack()).toBe(true);

    expect(useAppStore.getState().activeChannelId).toBe('c1');
    expect(useAppStore.getState().historyIndex).toBe(0);
  });

  it('갈 곳이 없으면 아무 일도 하지 않는다 — 위치도 그대로다', async () => {
    seed(['c1', 'c2'], ['c1', 'c2'], 0);
    const c = new Controller(fakeApi());

    expect(await c.goBack()).toBe(false);
    expect(useAppStore.getState().historyIndex).toBe(0);
  });

  // 전부 사라진 채널이면 실패하되, 실패한 이동이 위치를 옮겨 놓아서는 안 된다.
  it('건너뛰다 갈 곳이 다 사라졌으면 위치를 옮기지 않는다', async () => {
    seed(['c3'], ['c1', 'c2', 'c3'], 2);
    const c = new Controller(fakeApi());

    expect(await c.goBack()).toBe(false);
    expect(useAppStore.getState().historyIndex).toBe(2);
  });

  it('앞으로도 사라진 채널을 건너뛴다', async () => {
    seed(['c1', 'c3'], ['c1', 'c2', 'c3'], 0);
    const c = new Controller(fakeApi());

    expect(await c.goForward()).toBe(true);
    expect(useAppStore.getState().activeChannelId).toBe('c3');
    expect(useAppStore.getState().historyIndex).toBe(2);
  });
});

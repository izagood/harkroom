import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { ChannelPrefRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/**
 * 채널 숨기기(#376)의 화면 쪽. **가짜 컨트롤러를 쓰지 않는다** — 이 저장소의 실측으로,
 * 가짜 컨트롤러로 도는 화면 테스트는 프로덕션 배선을 통째로 지워도 초록이었다. 여기서는
 * 진짜 `Controller` 에 목 하나(`ApiClient`)만 물려, 사이드바에서 클릭한 것이 실제로
 * 컨트롤러를 지나 API 까지 가고 그 응답이 다시 화면을 바꾸는지 본다.
 */
const pref = (channelId: string, o: Partial<ChannelPrefRow> = {}): ChannelPrefRow => ({
  accountId: 'u1', channelId,
  mutedAt: null, starredAt: null, hiddenAt: null, notifyLevel: 'all',
  section: null, sortOrder: null, ...o,
});

const HIDDEN_AT = '2026-09-04T00:00:00.000Z';

const sidebar = () => render(
  <Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} onOpenDirectory={vi.fn()}
    onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()} onOpenSaved={vi.fn()}
    collapsed={false} onToggleCollapse={vi.fn()} />,
);

/** 사이드바에 지금 보이는 채널 이름들. 개수가 아니라 **목록**으로 봐야 무엇이 사라졌는지 갈린다. */
const visibleChannels = (): string[] =>
  screen.queryAllByRole('button')
    .map((el) => (el.textContent ?? '').replace('⋯', '').trim())
    .filter((t) => t.startsWith('#'));

const openMenuFor = (name: RegExp): void => {
  const row = screen.getByRole('button', { name }).closest('div')!;
  fireEvent.click(within(row).getByRole('button', { name: '⋯' }));
};

const seed = (prefs: Record<string, ChannelPrefRow> = {}): void => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    dms: [], connected: true, channelPrefs: prefs,
  });
};

afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('사이드바 숨기기(#376)', () => {
  it('1 — 숨긴 채널은 채널 목록에서 사라지고 접힌 Hidden 묶음에만 남는다', () => {
    setController(new Controller(fakeApi()));
    seed({ c1: pref('c1', { hiddenAt: HIDDEN_AT }) });
    sidebar();

    // 사라졌다. 남아 있는 것은 숨기지 않은 채널뿐이다.
    expect(visibleChannels()).toEqual(['#dev']);
    // 묶음은 접혀 있다 — 치운 것이 열린 채로 보이면 치운 뜻이 없다.
    const group = screen.getByRole('button', { name: /Hidden \(1\)/ });
    expect(visibleChannels()).not.toContain('#general');

    // 펼치면 되돌릴 자리가 있다. 목록이 아예 없으면 "치웠는데 어디로 갔나"가 된다.
    fireEvent.click(group);
    expect(visibleChannels()).toContain('#general');
  });

  it('2 — 메뉴의 숨기기가 진짜 배선(사이드바 → 컨트롤러 → API)을 지난다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed();
    sidebar();
    expect(visibleChannels()).toEqual(['#dev', '#general']);

    openMenuFor(/# general\b/);
    fireEvent.click(screen.getByRole('menuitem', { name: '숨기기' }));

    // 목은 API 한 겹뿐이다 — 여기까지 왔다는 것은 화면부터 클라이언트까지 이어져 있다는 뜻이다.
    // **명시적 boolean** 으로 간다: 키를 빼면 서버가 "안 보냈다"로 읽는다.
    expect(api.updateChannelPref).toHaveBeenCalledWith('c1', { hidden: true });
    // 응답이 스토어에 반영되어 화면이 바뀐다. 호출만 보고 끝내면 반영이 끊겨도 초록이다.
    await waitFor(() => expect(visibleChannels()).toEqual(['#dev']));
    expect(screen.getByRole('button', { name: /Hidden \(1\)/ })).toBeTruthy();
  });

  it('3 — 숨김 묶음에서 스스로 되돌린다(남에게 요청할 일이 없다)', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed({ c1: pref('c1', { hiddenAt: HIDDEN_AT }) });
    sidebar();

    fireEvent.click(screen.getByRole('button', { name: /Hidden \(1\)/ }));
    openMenuFor(/# general\b/);
    fireEvent.click(screen.getByRole('menuitem', { name: '숨김 해제' }));

    expect(api.updateChannelPref).toHaveBeenCalledWith('c1', { hidden: false });
    await waitFor(() => expect(visibleChannels()).toEqual(['#dev', '#general']));
    expect(screen.queryByRole('button', { name: /Hidden/ })).toBeNull();
  });
});

/**
 * 서버가 되돌린 숨김이 화면까지 오는가(#376 결정 B의 화면 쪽).
 *
 * 서버는 부름이 오면 `hidden_at` 을 스스로 null 로 만든다(`services/messages.ts`). 그 사실이
 * 화면에 도달하는 길은 `inbox.updated` 뒤의 선호 재조회 하나뿐이다 — 그 한 줄을 지우면
 * "서버는 풀었는데 사이드바에는 안 보이는" 채널이 생기고, 숨김이 부름을 삼킨다.
 */
describe('부름이 오면 사이드바에 다시 나타난다(#376)', () => {
  it('4 — inbox.updated 뒤 선호를 다시 읽어 숨김이 풀린 채널을 되돌린다', async () => {
    let revealed = false;
    const channelPrefs = vi.fn(async () => [pref('c1', { hiddenAt: revealed ? null : HIDDEN_AT })]);
    const api = fakeApi({ channelPrefs, channels: vi.fn(async () => [chan('c1', 'general')]) } as never);
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    setController(c);
    await c.start();
    sidebar();

    // 시작 상태: 숨겨져 있다.
    await waitFor(() => expect(visibleChannels()).toEqual([]));

    // 서버 쪽에서 부름이 왔다 — 숨김이 풀린 선호를 주게 된다.
    revealed = true;
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });

    await waitFor(() => expect(visibleChannels()).toEqual(['#general']));
    expect(screen.queryByRole('button', { name: /Hidden/ })).toBeNull();
  });

  it('5 — 남의 inbox 갱신으로는 다시 읽지 않는다', async () => {
    const channelPrefs = vi.fn(async () => [pref('c1', { hiddenAt: HIDDEN_AT })]);
    const api = fakeApi({ channelPrefs } as never);
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    setController(c);
    await c.start();
    const calls = channelPrefs.mock.calls.length;

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'someone-else' });
    // 워크스페이스의 모든 멘션마다 모든 기기가 선호를 다시 읽으면 안 된다.
    expect(channelPrefs.mock.calls.length).toBe(calls);
  });

  it('6 — 숨긴 채널이 없으면 다시 읽지 않는다(로컬 선호를 되돌리지 않는다)', async () => {
    const channelPrefs = vi.fn(async () => [pref('c1', { notifyLevel: 'none' })]);
    const api = fakeApi({ channelPrefs } as never);
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    setController(c);
    await c.start();
    await waitFor(() => expect(useAppStore.getState().channelPrefs.c1).toBeTruthy());
    const calls = channelPrefs.mock.calls.length;

    // 방금 로컬에 반영한 값(음소거 해제 같은 낙관적 갱신). 무조건 다시 읽으면 이것이
    // 한 박자 늦은 서버 응답에 되돌아간다 — `channelMute` 회귀선이 실제로 그렇게 빨개졌다.
    const store = useAppStore.getState();
    store.set({ channelPrefs: { c1: pref('c1', { notifyLevel: 'all' }) } });
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channelPrefs.mock.calls.length).toBe(calls);
    expect(useAppStore.getState().channelPrefs.c1?.notifyLevel).toBe('all');
  });
});

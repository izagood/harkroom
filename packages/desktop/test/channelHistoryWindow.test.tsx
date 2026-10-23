/**
 * **사흘치 대화가 사라져 보인 자리**(alice 보고 2026-09-10: "이전 메시지들 다 어디갔어").
 *
 * 서버에는 다 있었다. 겹친 것이 둘이다:
 *
 *  1. 채널을 처음 열 때 받는 히스토리 창이 **그려지지 않는 행까지 센다** — 스레드 답글·
 *     `progress`·`wake` 가 모두 한 행이다. 실측으로 #murmur 의 최신 200 행이 전부 그날치였고
 *     그중 채널 최상위로 그려지는 것은 25개뿐이었다.
 *  2. 그 창 밖으로 돌아갈 길은 목록 맨 위의 버튼 하나뿐인데, **채널을 다시 열면 그 버튼이
 *     사라졌다.** 서버는 `hasMore` 를 `messages.length > 0 && hasOlderMessages(첫 행)` 로
 *     계산하므로 새 메시지가 없는 증분 페이지는 `hasMore: false` 로 돌아온다 — "과거가
 *     없다"가 아니라 "새 것이 없다"는 뜻인데, 그 값을 스토어에 쓰면 길이 지워진다.
 *
 * 이 파일이 붙잡는 규율:
 *  - 첫 조회는 창을 넓게(`INITIAL_HISTORY_LIMIT`) 받는다. 증분 조회에는 붙이지 않는다.
 *  - 증분 응답은 `hasMore` 를 덮지 않는다.
 *  - 목록 맨 위에 닿으면 사람이 버튼을 찾지 않아도 다음 페이지가 온다. 그리고 그때
 *    **읽던 자리를 빼앗지 않는다**(위에 내용이 끼어든 만큼 되돌린다 — WKWebView 에는
 *    Chromium 의 `overflow-anchor` 가 없다).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import {
  setController, Controller, FIRST_PAGE_LIMIT, INITIAL_HISTORY_LIMIT, type Controller as C,
} from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, fakeApi, fakeWsFactory, msg, scheduledApiStub } from './helpers/fakeApi';

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('채널 히스토리 창', () => {
  it('첫 조회는 창을 넓게 받고, 증분 조회는 그러지 않는다', async () => {
    useAppStore.getState().reset();
    const { makeWs } = fakeWsFactory();
    const messages = vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, '옛말', 'u2')], hasMore: true }));
    const c = new Controller(fakeApi({ messages }), makeWs);
    await c.start();

    await c.openChannel('c1');
    // 첫 화면은 작게 받아 바로 그리고, 나머지는 첫 창(INITIAL_HISTORY_LIMIT)까지 뒤에서 채운다.
    expect(messages).toHaveBeenNthCalledWith(1, 'c1', { since: 0, limit: FIRST_PAGE_LIMIT });
    expect(messages).toHaveBeenNthCalledWith(2, 'c1', { before: 1, limit: INITIAL_HISTORY_LIMIT - FIRST_PAGE_LIMIT, feed: true });
    // 값도 못 박는다: `toHaveBeenCalledWith` 는 `limit: undefined` 를 "없음"과 같게 보므로,
    // 상한을 지운 판본에서도 위 줄만으로는 초록이 된다(서버 기본값은 200 이다).
    expect(INITIAL_HISTORY_LIMIT).toBeGreaterThan(200);
    expect(FIRST_PAGE_LIMIT).toBeLessThan(INITIAL_HISTORY_LIMIT);

    // 두 번째로 열면 증분이다 — 넓은 창은 "처음 열 때 며칠은 보인다"를 위한 것이고,
    // 새로 생긴 것만 받는 길에 붙이면 매번 500 행을 실어 오는 값만 든다. 증분은 서버 기본과 같은
    // 한 페이지(200)를 **명시해** 받는다 — 꽉 찬 페이지를 세어 끝까지 이어 받기 위해서다(`pullSince`).
    messages.mockClear();
    await c.openChannel('c1');
    expect(messages).toHaveBeenCalledWith('c1', { since: 1, limit: 200 });
    expect((messages.mock.calls as unknown as Array<[string, { limit?: number }]>).every(([, o]) => (o.limit ?? 0) < INITIAL_HISTORY_LIMIT)).toBe(true);
  });

  // 이것이 사람이 본 결함이다 — 조용할 때 채널을 한 번 더 누르면 과거로 갈 길이 사라졌다.
  it('새 메시지가 없는 증분 응답이 과거로 가는 길을 지우지 않는다', async () => {
    useAppStore.getState().reset();
    const { makeWs } = fakeWsFactory();
    const messages = vi.fn(async (_c: string, opts?: { since?: number }) => (
      (opts?.since ?? 0) === 0
        // 첫 창: 한 줄 주면서 "더 오래된 것이 남았다"고 말한다.
        ? { messages: [msg('m1', 'c1', 1, '창 안의 마지막 줄', 'u2')], hasMore: true }
        // 증분: 새 것이 없다. 서버는 이때 `hasMore: false` 를 준다.
        : { messages: [], hasMore: false }
    ));
    const c = new Controller(fakeApi({ messages: messages as never }), makeWs);
    await c.start();

    await c.openChannel('c1');
    expect(useAppStore.getState().hasMore.c1).toBe(true);

    await c.openChannel('c1');
    expect(useAppStore.getState().hasMore.c1).toBe(true);
  });
});

/** 스크롤 상자를 "맨 위까지 올렸다"로 세운다. jsdom 은 레이아웃을 재지 않아 우리가 세운다. */
const putAtTop = (el: HTMLElement, height = 2000) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, writable: true, value: height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, writable: true, value: 500 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 0 });
};

describe('맨 위에 닿으면 과거가 이어진다', () => {
  const seed = (hasMore: boolean) => {
    usePrefsStore.getState().setLocale('ko');
    useAppStore.getState().reset();
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
      channels: [chan('c1', 'general')],
      activeChannelId: 'c1',
      messages: { c1: [msg('m5', 'c1', 5, '창 안의 첫 줄', 'u2')] },
      hasMore: { c1: hasMore },
    });
  };

  it('위로 올리면 버튼을 누르지 않아도 다음 페이지를 받는다', async () => {
    seed(true);
    const loadOlder = vi.fn(async () => undefined);
    setController({ send: vi.fn(), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as C);
    render(<ChannelPane />);

    const box = screen.getByTestId('channel-scroll');
    putAtTop(box);
    fireEvent.scroll(box);

    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
  });

  it('남은 과거가 없으면 요청하지 않는다', () => {
    seed(false);
    const loadOlder = vi.fn(async () => undefined);
    setController({ send: vi.fn(), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as C);
    render(<ChannelPane />);

    const box = screen.getByTestId('channel-scroll');
    putAtTop(box);
    fireEvent.scroll(box);

    expect(loadOlder).not.toHaveBeenCalled();
  });

  // 스크롤 이벤트는 손짓 한 번에 수십 번 온다 — 문이 없으면 같은 페이지를 여러 번 요청한다.
  /**
   * **버튼도 스크롤과 같은 길로 받는다**(#1463 designer d2·d1). 예전 버튼은 컨트롤러를 바로 불러 받는 중 문과
   * 자리표시를 건너뛰었다 — 연달아 누르면 같은 페이지를 여러 번 묻고, 받는 동안 아무 표시가 없었다.
   * 받는 것이 길어지면 버튼은 **숨지 않고** 비활성 + 「불러오는 중」이 된다(숨기면 줄 상자 시작이 바뀌어 튄다).
   */
  it('버튼을 연달아 눌러도 한 번만 받고, 길어지면 비활성 「불러오는 중」이 된다', async () => {
    seed(true);
    let release = () => {};
    const loadOlder = vi.fn(() => new Promise<void>((resolve) => { release = () => resolve(); }));
    setController({ send: vi.fn(), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as C);
    render(<ChannelPane />);

    const button = screen.getByTestId('load-older');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(loadOlder).toHaveBeenCalledTimes(1);

    // 문턱(300ms)을 넘기면 자리표시가 서고, 버튼은 같은 자리에서 비활성으로 바뀐다.
    await waitFor(() => expect(screen.getAllByTestId('older-skeleton').length).toBeGreaterThan(0), { timeout: 2000 });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe('이전 메시지 불러오는 중');

    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryAllByTestId('older-skeleton')).toHaveLength(0), { timeout: 2000 });
    expect((screen.getByTestId('load-older') as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * **떠난 채널의 받기가 지금 채널의 받는 중 상태를 걷지 않는다**(#1463 security s1). 예전에는 c1 의 받기가
   * c2 로 옮긴 뒤에 끝나면 그 `finally` 가 c2 의 문을 열고 자리표시를 걷었다 — c2 에서 같은 페이지를 또 물었다.
   */
  it('받는 중에 채널을 옮겨도 옛 채널의 끝맺음이 새 채널을 건드리지 않는다', async () => {
    seed(true);
    useAppStore.getState().set({
      channels: [chan('c1', 'general'), chan('c2', 'random')],
      messages: { c1: [msg('m5', 'c1', 5, '창 안의 첫 줄', 'u2')], c2: [msg('n5', 'c2', 5, '둘째 채널', 'u2')] },
      hasMore: { c1: true, c2: true },
    });
    const releases: Record<string, () => void> = {};
    const loadOlder = vi.fn((channelId: string) => new Promise<void>((resolve) => { releases[channelId] = () => resolve(); }));
    setController({ send: vi.fn(), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as C);
    render(<ChannelPane />);

    putAtTop(screen.getByTestId('channel-scroll'));
    fireEvent.scroll(screen.getByTestId('channel-scroll'));
    expect(loadOlder).toHaveBeenLastCalledWith('c1');

    act(() => { useAppStore.getState().set({ activeChannelId: 'c2' }); });
    const box = screen.getByTestId('channel-scroll');
    putAtTop(box);
    fireEvent.scroll(box);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(loadOlder).toHaveBeenLastCalledWith('c2');
    await waitFor(() => expect(screen.getAllByTestId('older-skeleton').length).toBeGreaterThan(0), { timeout: 2000 });

    // c1 의 받기가 이제야 끝난다 — c2 는 아직 받는 중이어야 한다.
    await act(async () => { releases.c1!(); });
    fireEvent.scroll(box);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('older-skeleton').length).toBeGreaterThan(0);

    await act(async () => { releases.c2!(); });
  });

  it('받는 중에는 같은 페이지를 다시 요청하지 않는다', async () => {
    seed(true);
    let release = () => {};
    const loadOlder = vi.fn(() => new Promise<void>((resolve) => { release = () => resolve(); }));
    setController({ send: vi.fn(), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as C);
    render(<ChannelPane />);

    const box = screen.getByTestId('channel-scroll');
    putAtTop(box);
    fireEvent.scroll(box);
    fireEvent.scroll(box);
    fireEvent.scroll(box);

    expect(loadOlder).toHaveBeenCalledTimes(1);
    release();
  });

  /**
   * **받는 동안 굴린 자리를 도로 빼앗지 않는다**(2026-10-22, 스레드 1a06bdce). 예전에는 요청할 때 잰
   * `scrollTop`·`scrollHeight` 로 되돌려서, 응답을 기다리는 동안 맨 위까지 올린 사람이 요청 때 자리로
   * 끌려갔다(탐침 −222px). 과거가 붙을 때 보던 줄을 붙잡는 일은 이제 줄 창(`MessageRows`)이 하고, 그쪽은
   * `virtualRows.test.tsx` 의 앞붙임 시험이 지킨다. 창이 없는 이 환경에서는 화면이 스크롤을 건드리지 않아야 한다.
   */
  it('요청 때 잰 자리로 되돌리지 않는다', async () => {
    seed(true);
    const loadOlder = vi.fn(async () => undefined);
    setController({ send: vi.fn(), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as C);
    render(<ChannelPane />);

    const box = screen.getByTestId('channel-scroll');
    putAtTop(box, 2000);
    box.scrollTop = 200;
    fireEvent.scroll(box);
    await waitFor(() => expect(loadOlder).toHaveBeenCalled());

    // 기다리는 동안 사람이 맨 위까지 올렸다. 그 뒤 과거가 붙는다.
    box.scrollTop = 0;
    (box as unknown as { scrollHeight: number }).scrollHeight = 3000;
    act(() => {
      useAppStore.getState().set({
        messages: {
          c1: [msg('m1', 'c1', 1, '어제 이야기', 'u2'), msg('m5', 'c1', 5, '창 안의 첫 줄', 'u2')],
        },
      });
    });

    // 예전 식이면 200 + 1000 = 1200 으로 끌려갔다.
    expect(box.scrollTop).toBe(0);
  });
});

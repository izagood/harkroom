/**
 * **사흘치 대화가 사라져 보인 자리**(jaebin 보고 2026-09-10: "이전 메시지들 다 어디갔어").
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
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import {
  setController, Controller, INITIAL_HISTORY_LIMIT, type Controller as C,
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
    expect(messages).toHaveBeenCalledWith('c1', { since: 0, limit: INITIAL_HISTORY_LIMIT });
    // 값도 못 박는다: `toHaveBeenCalledWith` 는 `limit: undefined` 를 "없음"과 같게 보므로,
    // 상한을 지운 판본에서도 위 한 줄만으로는 초록이 된다(서버 기본값은 200 이다).
    expect(INITIAL_HISTORY_LIMIT).toBeGreaterThan(200);

    // 두 번째로 열면 증분이다 — 넓은 창은 "처음 열 때 며칠은 보인다"를 위한 것이고,
    // 새로 생긴 것만 받는 길에 붙이면 매번 500 행을 실어 오는 값만 든다.
    messages.mockClear();
    await c.openChannel('c1');
    expect(messages).toHaveBeenCalledWith('c1', { since: 1, limit: undefined });
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
   * **읽던 자리를 빼앗지 않는다.** 위쪽에 1000px 이 끼어들면 보고 있던 줄도 1000px 아래로
   * 밀려난다 — 되돌리지 않으면 화면이 옛 대화의 맨 위로 튄다(Chromium 은 `overflow-anchor`
   * 로 붙잡아 주지만 macOS 앱의 WKWebView 에는 그 기능이 없다).
   */
  it('위에 붙은 만큼 스크롤을 되돌린다', async () => {
    seed(true);
    const loadOlder = vi.fn(async () => undefined);
    setController({ send: vi.fn(), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as C);
    render(<ChannelPane />);

    const box = screen.getByTestId('channel-scroll');
    putAtTop(box, 2000);
    fireEvent.scroll(box);
    await waitFor(() => expect(loadOlder).toHaveBeenCalled());

    // 서버가 준 과거가 붙는다 — 상자는 그만큼 자란다.
    (box as unknown as { scrollHeight: number }).scrollHeight = 3000;
    useAppStore.getState().set({
      messages: {
        c1: [msg('m1', 'c1', 1, '어제 이야기', 'u2'), msg('m5', 'c1', 5, '창 안의 첫 줄', 'u2')],
      },
    });

    await waitFor(() => expect(box.scrollTop).toBe(1000));
  });
});

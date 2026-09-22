/**
 * **위쪽이 자라도 읽던 줄은 그 자리에 있다.**
 *
 * 보고(jaebin, 2026-09-22): "채널을 다시 열면 제일 밑으로 갔다가 채팅들 응답으로 들어오면서
 * 스크롤이 위로 올라가 버린다."
 *
 * 원인은 스크롤 상자가 **보고 있는 줄**이 아니라 위에서부터 잰 거리를 기억한다는 데 있다.
 * 에이전트의 답은 스레드에 달리므로 채널 목록의 줄 수는 그대로인데(`roots` 는 뿌리만 센다),
 * 뿌리 줄에 답글 요약 줄이 **새로 선다** — 시야 위쪽에서 그 일이 일어나면 보던 줄이 그만큼
 * 아래로 밀리고, 사람 눈에는 화면이 위로 올라간 것으로 보인다. Chromium 의 `overflow-anchor`
 * 가 이것을 붙잡아 주지만 macOS 앱의 WKWebView 에는 그 기능이 없다.
 *
 * jsdom 은 레이아웃을 재지 않으므로 `offsetTop` 을 직접 세운다 — 이 회귀선이 재현하려는
 * 조건이 정확히 그 수치다(`jumpToBottom.test.tsx` 가 스크롤 수치를 세우는 것과 같은 태도).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  setController({
    send: vi.fn(async () => undefined),
    openThread: vi.fn(),
    loadOlder: vi.fn(async () => undefined),
    api: scheduledApiStub(),
  } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
    messages: {
      c1: [
        msg('m1', 'c1', 1, '첫 줄', 'u2'),
        msg('m2', 'c1', 2, '읽고 있는 줄', 'u2'),
        msg('m3', 'c1', 3, '아래 줄', 'u2'),
        msg('m4', 'c1', 4, '맨 아래 줄', 'u2'),
      ],
    },
  });
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

/** 상자의 크기를 세운다(내용 2000px, 창 500px — 바닥은 `scrollTop` 1500 이다). */
const sizeBox = (el: HTMLElement) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, writable: true, value: 2000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 1500 });
};

/** 줄들의 세로 위치를 세운다. 돌려주는 함수로 **자란 뒤**의 위치를 다시 세운다. */
const placeRows = (tops: number[]): ((next: number[]) => void) => {
  const set = (next: number[]) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-anchor-id]'));
    rows.forEach((row, i) => {
      Object.defineProperty(row, 'offsetTop', { configurable: true, value: next[i] ?? 0 });
    });
  };
  set(tops);
  return set;
};

/** 지금 자리를 상자에 알린다(브라우저의 scroll 이벤트 한 번). */
const scrollTo = (el: HTMLElement, top: number) => {
  (el as unknown as { scrollTop: number }).scrollTop = top;
  fireEvent.scroll(el);
};

/** 사람이 바닥에서 위로 올린다 — `scrollTop` 이 줄어드는 것이 그 손짓의 정의다. */
const lookUp = (el: HTMLElement, to: number) => { scrollTo(el, 1500); scrollTo(el, to); };

describe('읽던 자리 붙잡기', () => {
  it('시야 위에서 내용이 자라도 보던 줄이 같은 자리에 남는다', async () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    sizeBox(list);
    const place = placeRows([0, 400, 800, 1200]);
    // 두 번째 줄의 맨 위를 보고 있다.
    lookUp(list, 400);

    // 첫 줄에 답글 요약 줄(30px)이 섰다 — 아래 줄들이 전부 그만큼 밀린다.
    place([0, 430, 830, 1230]);
    (list as unknown as { scrollHeight: number }).scrollHeight = 2030;
    act(() => { useAppStore.getState().bumpThreadCounts('c1', 'm1', 1, true); });

    // 보정이 없으면 400 에 그대로 남아 **한 줄 위**가 보인다. 그것이 보고된 증상이다.
    await waitFor(() => expect(list.scrollTop).toBe(430));
  });

  it('붙잡은 줄이 사라지면 아무것도 하지 않는다', async () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    sizeBox(list);
    placeRows([0, 400, 800, 1200]);
    lookUp(list, 400);

    // 그 메시지가 지워졌다. 떨어져 나간 요소의 `offsetTop` 은 0 이라, 그대로 쓰면 맨 위로 튄다.
    act(() => { useAppStore.getState().removeMessage('c1', 'm2'); });

    await waitFor(() => expect(screen.queryByText('읽고 있는 줄')).toBeNull());
    expect(list.scrollTop).toBe(400);
  });

  it('바닥에 붙어 있으면 붙잡지 않는다 — 최신을 따라간다', async () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    sizeBox(list);
    const place = placeRows([0, 400, 800, 1200]);
    // 바닥에 서 있다(2000 - 1500 - 500 = 0).
    scrollTo(list, 1500);

    place([0, 430, 830, 1230]);
    (list as unknown as { scrollHeight: number }).scrollHeight = 2030;
    act(() => { useAppStore.getState().bumpThreadCounts('c1', 'm1', 1, true); });

    // 되돌리지 않는다 — 바닥 추종(`stickyBottom`)이 이 자리의 주인이다.
    expect(list.scrollTop).toBe(1500);
  });

  /**
   * **버튼은 줄 수가 아니라 자리를 보고 선다.** 에이전트의 답은 스레드에 달려 뿌리 줄 수를
   * 바꾸지 않으므로, 예전 조건(`roots.length` 가 바뀔 때)으로는 한 번도 서지 않았다.
   */
  it('위를 보고 있으면 새 줄 없이도 내려갈 길이 선다', async () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    sizeBox(list);
    placeRows([0, 400, 800, 1200]);
    lookUp(list, 400);

    await waitFor(() => expect(screen.getByTestId('channel-jump-to-bottom')).toBeTruthy());
  });
});

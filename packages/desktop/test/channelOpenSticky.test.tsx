/**
 * **브라우저가 잘라낸 스크롤을 "사람이 올렸다"로 읽지 않는다.**
 *
 * 보고(jaebin, 2026-09-22, #852 를 넣은 뒤에도 남았다): "아직도 채널에 들어간 다음에 위쪽으로
 * 스크롤이 쭉 올라가는 건 마찬가지야."
 *
 * 스크롤 상자는 **채널이 바뀌어도 같은 DOM** 이라 떠난 채널의 `scrollTop` 을 그대로 들고
 * 있는다. 새 채널의 첫 페이지가 아직 없으면 브라우저는 그 값을 내용 높이에 맞춰 **잘라내고**,
 * 잘린 값은 `scrollTop` 이 줄어든 것으로 보인다. `onListScroll` 은 그것을 "사람이 위로
 * 올렸다"로 읽어 **바닥 추종(`stickyRef`)을 껐다** — 그 한 번에 뒤따라 도착하는 대화가 전부
 * 아래로 쌓이는 동안 화면은 들어오다 잡힌 자리에 남는다. 사람 눈에는 대화가 위로 쭉
 * 올라가 버린다.
 *
 * 가려내는 표식은 **내용의 높이**다: 사람이 스크롤 막대를 끌 때 높이는 변하지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

interface Watch { callback: (entries: Array<{ isIntersecting: boolean }>) => void }
let watches: Watch[] = [];

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
    messages: { c1: [msg('m1', 'c1', 1, '대화', 'u2')] },
  });

  watches = [];
  class FakeObserver {
    private watch: Watch;
    constructor(callback: Watch['callback']) { this.watch = { callback }; watches.push(this.watch); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

const spyScroll = () => {
  const fn = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = fn;
  return fn;
};

const size = (el: HTMLElement, height: number, top: number) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
  (el as unknown as { scrollTop: number }).scrollTop = top;
};

const scrollTo = (el: HTMLElement, top: number) => {
  (el as unknown as { scrollTop: number }).scrollTop = top;
  fireEvent.scroll(el);
};

/** 바닥 표식이 상자 밖으로 밀려났다 — 따라 내려갈 차례인지를 이것으로 잰다. */
const grewBelow = () => { for (const w of watches) w.callback([{ isIntersecting: false }]); };

describe('채널에 들어가는 구간', () => {
  it('내용 높이가 바뀐 스크롤 이벤트로는 바닥 추종이 꺼지지 않는다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    // 바닥에 서 있다(2000 - 1500 - 500 = 0).
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1500 });
    size(list, 2000, 1500);
    scrollTo(list, 1500);

    // 채널을 옮겼다: 상자는 같은 DOM 이라 1500 을 들고 있었는데 새 채널의 첫 페이지가 오면서
    // 높이가 바뀌었고, 브라우저가 자리를 0 으로 잘랐다. 사람은 아무것도 하지 않았다.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 20000 });
    scrollTo(list, 0);

    // 고정이 살아 있으면 자란 만큼 따라 내려간다. 죽었으면 화면은 0 에 남고 — 그것이 보고된
    // "위쪽으로 쭉 올라간다" 이다.
    const scrollIntoView = spyScroll();
    grewBelow();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(screen.queryByTestId('channel-jump-to-bottom')).toBeNull();
  });

  it('높이가 그대로인데 올라간 것은 여전히 사람이 한 일이다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 1500 });
    size(list, 2000, 1500);
    scrollTo(list, 1500);
    // 스크롤 막대를 끌어 올렸다 — 높이는 변하지 않는다.
    scrollTo(list, 0);

    const scrollIntoView = spyScroll();
    grewBelow();
    // 읽던 자리를 빼앗지 않는다(`jumpToBottom.test.tsx` 의 규율).
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByTestId('channel-jump-to-bottom')).toBeTruthy();
  });
});

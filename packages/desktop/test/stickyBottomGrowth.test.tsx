/**
 * **바닥에 붙어 있으면, 내용이 늦게 자라도 바닥에 남는다.**
 *
 * 보고(jaebin, 2026-09-09): "murmur 채널에 들어오면 가장 최신 채팅으로 포커스되어야 하는데
 * 항상 어중간한 가운데 시점으로 들어와서 매번 밑으로 내려가야 한다."
 *
 * `jumpToBottom.test.tsx` 가 세운 규율(바닥에 붙어 있을 때만 따라 내려간다)은 **목록이 몇
 * 줄인지** 바뀔 때만 돈다. 그런데 줄 수가 그대로인 채 높이가 자라는 길이 여럿 있다 —
 * 첨부 그림은 URL 을 받아온 뒤에야 `<img>` 가 생기고, 링크 미리보기 카드도 fetch 가 끝난
 * 뒤에 붙는다. 바닥으로 내려간 다음 그것들이 자라면 스크롤 이벤트는 일어나지 않으므로
 * (사람이 움직인 것이 아니다) 화면은 그 자리에 남고, 자란 높이가 그대로 "내려가야 하는
 * 거리"가 된다. 그림과 링크가 많은 채널일수록 그 거리가 길다.
 *
 * 그래서 `ChannelPane` 은 **바닥 표식이 상자에서 벗어나는 순간**을 관찰자로 잡아 다시
 * 내려간다. 이 파일이 붙잡는 것은 그 보정의 규율 둘이다:
 *  1. 바닥에 붙어 있으면 표식이 벗어나는 순간 따라 내려간다.
 *  2. 위를 보고 있으면 **건드리지 않는다** — 여기서 무조건 내려가면 위 이슈가 그대로 돌아온다.
 *
 * jsdom 에는 `IntersectionObserver` 가 없다(제품 코드가 `typeof` 로 확인하는 이유다).
 * 그래서 여기서 심어 두고 콜백을 손으로 부른다 — 관찰자의 `root` 가 창이 아니라 스크롤
 * 상자인지도 함께 잰다(창을 기준으로 하면 이 보정은 조용히 아무 일도 하지 않는다).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

interface Watch {
  callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  root: Element | null;
  targets: Element[];
}
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
    messages: { c1: [msg('m1', 'c1', 1, '그림이 붙은 메시지', 'u2')] },
  });

  watches = [];
  class FakeObserver {
    private watch: Watch;
    constructor(callback: Watch['callback'], options?: { root?: Element | Document | null }) {
      this.watch = { callback, root: (options?.root as Element | null) ?? null, targets: [] };
      watches.push(this.watch);
    }
    observe(target: Element): void { this.watch.targets.push(target); }
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

/** `scrollIntoView` 는 jsdom 에 없다 — 불렸는지 재려면 우리가 놓아 줘야 한다. */
const spyScroll = () => {
  const fn = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = fn;
  return fn;
};

/** 스크롤 상자를 "위를 보고 있다"로 세운다(바닥까지 1500px 남았다). */
const lookUp = (el: HTMLElement) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 0 });
  fireEvent.scroll(el);
};

/** 그림·미리보기가 늦게 붙어 바닥 표식이 상자 밖으로 밀려났다. */
const grewBelow = () => {
  for (const w of watches) w.callback([{ isIntersecting: false }]);
};

describe('늦게 자라는 내용', () => {
  it('바닥 표식을 스크롤 상자 기준으로 지켜본다', () => {
    render(<ChannelPane />);
    expect(watches.length).toBe(1);
    // 창을 기준으로 하면(root 가 null) 이 보정은 조용히 아무 일도 하지 않는다.
    expect(watches[0]!.root).toBe(screen.getByTestId('channel-scroll'));
    expect(watches[0]!.targets).toContain(screen.getByTestId('channel-bottom'));
  });

  it('바닥에 붙어 있으면 자란 만큼 따라 내려간다', () => {
    render(<ChannelPane />);
    // jsdom 의 기본값(수치가 전부 0)이 곧 "바닥에 붙어 있다"다.
    const scrollIntoView = spyScroll();
    grewBelow();

    // `block: 'nearest'` 여야 한다 — 인자를 빼면 앱 껍데기까지 끌려 올라간다
    // (`shellScroll.test.tsx` 가 그 사고를 적어 뒀다).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('위를 보고 있으면 자라도 화면을 옮기지 않는다', () => {
    render(<ChannelPane />);
    lookUp(screen.getByTestId('channel-scroll'));

    const scrollIntoView = spyScroll();
    grewBelow();

    // 읽던 자리를 빼앗지 않는다 — 이 규율이 깨지면 #jumpToBottom 이슈가 그대로 돌아온다.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('바닥이 이미 보이면 아무 일도 하지 않는다', () => {
    render(<ChannelPane />);
    const scrollIntoView = spyScroll();
    for (const w of watches) w.callback([{ isIntersecting: true }]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

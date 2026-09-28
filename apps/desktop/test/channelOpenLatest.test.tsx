/**
 * **채널을 열면 가장 최신 대화가 보인다 — 여는 동안에는 사건을 기다리지 않는다.**
 *
 * 보고(jaebin, 2026-09-11): "채널 열면 항상 채널의 가장 최신 채팅이 보이도록 수정해".
 *
 * 바닥으로 내려가는 길은 이미 셋이었다(채널이 바뀔 때 · 줄 수가 바뀔 때 ·
 * 바닥 표식이 상자를 벗어날 때, `jumpToBottom` · `stickyBottomGrowth` 회귀선). 셋 모두
 * **어떤 사건이 오기를 기다린다**는 것이 남은 구멍이다: 여는 순간의 1초는 첫 페이지 도착·
 * 그림·링크 카드·글꼴이 한꺼번에 몰리는 구간이라, 그 중 한 신호만 어긋나도(경계에 걸친
 * 1px 표식의 교차 판정, WKWebView 에 없는 스크롤 앵커링) 사람은 어중간한 자리에서 채널을
 * 만난다. 그래서 여는 직후 **짧은 정착 창** 동안에는 매 프레임 바닥과의 거리를 직접 보고 붙인다.
 *
 * 이 파일이 붙잡는 규율은 넷이다:
 *  1. 여는 직후 내용이 자라면(스크롤 이벤트 없이) 프레임마다 따라 붙는다.
 *  2. 사람이 손을 대면(휠, 또는 바닥이 아닌 자리를 알리는 스크롤) 창은 그 자리에서 닫힌다.
 *  3. 창이 지나면 더 이상 붙이지 않는다 — 영원히 도는 루프가 아니다.
 *  4. 채널을 옮기면 창이 다시 열린다.
 *
 * jsdom 은 레이아웃을 재지 않으므로 상자 수치는 `defineProperty` 로 세우고, 프레임은
 * 손으로 돌린다(`requestAnimationFrame` 을 큐로 바꾼다) — 시간에 기대면 흔들린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

let frames: Array<() => void> = [];
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;

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
    channels: [chan('c1', 'general'), chan('c2', 'random')],
    activeChannelId: 'c1',
    messages: {
      c1: [msg('m1', 'c1', 1, '그림이 붙은 메시지', 'u2')],
      c2: [msg('m2', 'c2', 1, '다른 채널의 대화', 'u2')],
    },
  });

  frames = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(() => cb(0));
    return frames.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  vi.restoreAllMocks();
  usePrefsStore.getState().setLocale('system');
});

/** 예약된 프레임을 한 번 돌린다. 그 안에서 다시 예약된 것은 다음 호출의 몫이다. */
const frame = () => {
  const queued = frames;
  frames = [];
  for (const f of queued) act(() => { f(); });
};

/** `scrollIntoView` 는 jsdom 에 없다 — 불렸는지 재려면 우리가 놓아 줘야 한다. */
const spyScroll = () => {
  const fn = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = fn;
  return fn;
};

/**
 * **늦게 자란 내용**을 흉내 낸다: 상자는 바닥에서 1500px 떨어졌는데 스크롤 이벤트는 없다
 * (사람이 움직인 것이 아니라 내용이 자란 것이므로 브라우저는 아무 이벤트도 주지 않는다).
 */
const grewBelow = (el: HTMLElement) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 0 });
};

describe('채널을 열면 최신 대화에 선다', () => {
  it('여는 직후 내용이 자라면 스크롤 이벤트가 없어도 따라 붙는다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    grewBelow(list);

    const scrollIntoView = spyScroll();
    frame();

    // `block: 'nearest'` 여야 한다 — 인자를 빼면 앱 껍데기까지 끌려 올라간다
    // (`shellScroll.test.tsx` 가 그 사고를 적어 뒀다).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('바닥이 이미 보이면 프레임이 돌아도 화면을 건드리지 않는다', () => {
    render(<ChannelPane />);
    // jsdom 의 기본값(수치가 전부 0)이 곧 "바닥에 붙어 있다"다.
    const scrollIntoView = spyScroll();
    frame();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  /**
   * **무엇이 사람의 손인지가 갈린다**(jaebin 보고 2026-09-22). 예전에는 "바닥이 아닌 자리를
   * 알리는 스크롤" 이면 무조건 사람으로 쳤다. 그런데 채널에 들어가는 1초는 내용 높이가 가장
   * 많이 흔들리는 구간이고, 스크롤 상자는 채널이 바뀌어도 같은 DOM 이라 떠난 채널의
   * `scrollTop` 을 들고 있다 — 브라우저가 그것을 새 높이에 맞춰 **잘라내면** 똑같이 생긴
   * 이벤트가 온다. 그것을 사람으로 읽어 창을 닫고 고정을 풀었더니, 뒤이어 도착하는 대화가
   * 아래로 쌓이는 동안 화면이 들어오다 잡힌 자리에 남았다("위쪽으로 쭉 올라간다").
   *
   * 가려내는 표식은 **내용의 높이**다: 스크롤 막대를 끄는 손은 높이를 바꾸지 않는다.
   */
  it('높이가 그대로인데 바닥이 아닌 자리를 알리면 창이 닫힌다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    grewBelow(list);
    // 먼저 바닥에서 지금 높이를 알린다 — 다음 이벤트의 "높이는 그대로"가 뜻을 가지려면 필요하다.
    (list as unknown as { scrollTop: number }).scrollTop = 1500;
    fireEvent.scroll(list);
    // 사람이 스크롤 막대를 끌어 올렸다 — 높이는 그대로고 자리만 위다.
    (list as unknown as { scrollTop: number }).scrollTop = 0;
    fireEvent.scroll(list);

    const scrollIntoView = spyScroll();
    frame();
    frame();

    // 읽던 자리를 빼앗지 않는다 — 이 규율이 정착 창보다 위에 있다.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('내용이 자라며 온 스크롤로는 창이 닫히지 않는다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    // 높이가 0 에서 2000 으로 바뀌었고, 그 성장과 함께 브라우저가 자리를 알려 왔다 —
    // 사람은 아무것도 하지 않았다.
    grewBelow(list);
    fireEvent.scroll(list);

    const scrollIntoView = spyScroll();
    frame();

    // 창은 열려 있어야 한다 — 여는 동안의 이 한 번에 바닥 추종이 죽는 것이 보고된 증상이다.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('휠을 굴리면 그 자리에서 창이 닫힌다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    grewBelow(list);
    fireEvent.wheel(list);

    const scrollIntoView = spyScroll();
    frame();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('창이 지나면 더 이상 붙이지 않는다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    grewBelow(list);
    // 정착 창(1.2초)을 넘긴 시각으로 시계를 옮긴다.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

    const scrollIntoView = spyScroll();
    frame();
    expect(scrollIntoView).not.toHaveBeenCalled();
    // 루프도 스스로 멈춘다 — 프레임을 더 예약하지 않는다.
    expect(frames.length).toBe(0);
  });

  it('채널을 옮기면 창이 다시 열린다', () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    grewBelow(list);
    fireEvent.wheel(list);
    frame();

    act(() => { useAppStore.getState().set({ activeChannelId: 'c2' }); });
    // 스크롤 상자는 채널이 바뀌어도 같은 DOM 이라 어중간한 자리가 그대로 남는다.
    const scrollIntoView = spyScroll();
    frame();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

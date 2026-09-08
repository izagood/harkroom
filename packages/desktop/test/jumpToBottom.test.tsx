/**
 * **위쪽을 읽는 중에는 화면을 끌어내리지 않는다.**
 *
 * 보고(jaebin, 2026-09-09): "Remove from channel 같은 버튼을 누르면 채팅 보는 화면이
 * 제일 밑으로 내려가 내가 보고 있던 곳에서 확 이동한다. 새로운 채팅이 생길 때도 마찬가지다."
 *
 * 원인은 `ChannelPane` 의 한 줄이었다 — `roots.length` 가 바뀌면 **조건 없이** 바닥 표식으로
 * 스크롤했다. 채널 멤버를 빼면 시스템 메시지가 한 줄 생기므로, 사람이 한 일은 "멤버 빼기"
 * 인데 결과는 "읽던 자리를 잃었다" 가 된다.
 *
 * 이 파일이 붙잡는 것은 그 규율 셋이다:
 *  1. 바닥에서 떨어져 있으면 목록이 늘어도 스크롤하지 않는다 — 대신 버튼을 세운다.
 *  2. 그 버튼을 누르면 그때 내려간다(사람이 원할 때만).
 *  3. 바닥에 붙어 있으면 예전처럼 따라 내려가고, 버튼은 서지 않는다.
 *
 * jsdom 은 레이아웃을 재지 않아 스크롤 수치가 모두 0 이다. 그래서 "위를 보고 있다"는
 * 상태는 `defineProperty` 로 직접 세운다 — 그것이 이 회귀선이 재현하려는 유일한 조건이다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

/** 문구를 한국어로 못 박는다(`channelPane.test.tsx` 와 같은 이유 — 언어는 `i18n.test.tsx` 가 잰다). */
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
    messages: { c1: [msg('m1', 'c1', 1, '옛날 이야기', 'u2')] },
  });
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
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

/** 목록에 새 줄이 하나 생긴다. `author` 가 'u1' 이면 내가 쓴 것이다. */
const arrive = (author: string) => {
  useAppStore.getState().set({
    messages: {
      c1: [
        msg('m1', 'c1', 1, '옛날 이야기', 'u2'),
        msg('m2', 'c1', 2, '방금 생긴 줄', author),
      ],
    },
  });
};

describe('아래로 내려가기', () => {
  it('위를 보는 중에 줄이 생기면 화면을 옮기지 않고 버튼만 세운다', async () => {
    render(<ChannelPane />);
    lookUp(screen.getByTestId('channel-scroll'));

    const scrollIntoView = spyScroll();
    arrive('u2');

    await waitFor(() => expect(screen.getByTestId('channel-jump-to-bottom')).toBeTruthy());
    // **이것이 이슈의 핵심이다** — 줄이 늘었다고 화면이 움직여서는 안 된다.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByText('아래로 내려가기')).toBeTruthy();
  });

  it('버튼을 누를 때 비로소 내려가고, 버튼은 사라진다', async () => {
    render(<ChannelPane />);
    lookUp(screen.getByTestId('channel-scroll'));
    arrive('u2');
    await waitFor(() => expect(screen.getByTestId('channel-jump-to-bottom')).toBeTruthy());

    const scrollIntoView = spyScroll();
    fireEvent.click(screen.getByTestId('channel-jump-to-bottom'));

    // `block: 'nearest'` 여야 한다 — 인자를 빼면 앱 껍데기까지 끌려 올라간다
    // (`shellScroll.test.tsx` 가 그 사고를 적어 뒀다).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    await waitFor(() => expect(screen.queryByTestId('channel-jump-to-bottom')).toBeNull());
  });

  it('바닥을 보고 있으면 예전처럼 따라 내려간다', async () => {
    render(<ChannelPane />);
    // jsdom 의 기본값(전부 0)이 곧 "바닥에 붙어 있다"다.
    const scrollIntoView = spyScroll();
    arrive('u2');

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(screen.queryByTestId('channel-jump-to-bottom')).toBeNull();
  });

  it('내가 쓴 것은 위를 보고 있어도 따라 내려간다', async () => {
    render(<ChannelPane />);
    lookUp(screen.getByTestId('channel-scroll'));

    const scrollIntoView = spyScroll();
    arrive('u1');

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // 방금 보낸 것을 보려고 버튼을 한 번 더 누르게 해서는 안 된다.
    expect(screen.queryByTestId('channel-jump-to-bottom')).toBeNull();
  });

  it('손으로 바닥까지 내려오면 버튼은 스스로 사라진다', async () => {
    render(<ChannelPane />);
    const list = screen.getByTestId('channel-scroll');
    lookUp(list);
    arrive('u2');
    await waitFor(() => expect(screen.getByTestId('channel-jump-to-bottom')).toBeTruthy());

    (list as unknown as { scrollTop: number }).scrollTop = 1500;
    fireEvent.scroll(list);

    await waitFor(() => expect(screen.queryByTestId('channel-jump-to-bottom')).toBeNull());
  });
});

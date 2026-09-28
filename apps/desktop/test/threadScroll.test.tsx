/**
 * **스레드를 열면 마지막 답글이 보인다.**
 *
 * 보고(jaebin, 2026-09-09): "스레드를 열면 가장 윗 부분이 보이는데 스레드가 보통 계속
 * 길어져서, 스레드를 열면 가장 마지막 채팅이 보이도록 해 달라."
 *
 * `ThreadPanel` 에는 스크롤을 건드리는 코드가 아예 없었다 — 그래서 패널은 늘 목록의
 * 맨 위에서 시작했고, 답글이 쌓인 스레드는 열 때마다 손으로 끝까지 내려야 했다.
 *
 * 이 파일이 붙잡는 규율 넷:
 *  1. 열면 바닥 표식으로 간다(`block: 'nearest'` 로 — 앱 껍데기를 끌지 않는다).
 *  2. 답글이 도착해도, 위쪽을 읽는 중이면 화면을 옮기지 않는다.
 *  3. 바닥에 붙어 있으면 따라 내려간다. 내가 쓴 답글은 위를 보고 있어도 따라간다.
 *  4. 다른 스레드로 옮기면 다시 바닥에서 시작한다 — 스크롤 상자가 같은 DOM 이라
 *     앞 스레드에서 위를 보던 상태가 남지 않아야 한다.
 *
 * jsdom 은 레이아웃을 재지 않아 스크롤 수치가 모두 0 이다(=바닥에 붙어 있다). "위를 보고
 * 있다"는 상태만 `defineProperty` 로 직접 세운다 — `jumpToBottom.test.tsx` 와 같은 방식이다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';

const root = () => msg('m1', 'c1', 1, '뿌리', 'u2');
const reply = (id: string, seq: number, author: string) =>
  msg(id, 'c1', seq, `답글 ${id}`, author, { threadRootId: 'm1' });

beforeEach(() => {
  setController({
    reply: vi.fn(async () => undefined),
    closeThread: vi.fn(),
    openThread: vi.fn(),
  } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    activeChannelId: 'c1',
    threadRootId: 'm1',
    messages: { c1: [root(), reply('m2', 2, 'u2')] },
  });
});

afterEach(() => { cleanup(); });

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

/** 답글이 한 줄 도착한다. `author` 가 'u1' 이면 내가 쓴 것이다. */
const arrive = (author: string) => {
  useAppStore.getState().set({
    messages: { c1: [root(), reply('m2', 2, 'u2'), reply('m3', 3, author)] },
  });
};

describe('스레드 스크롤', () => {
  it('열면 마지막 답글이 보이도록 바닥으로 간다', async () => {
    const scrollIntoView = spyScroll();
    render(<ThreadPanel />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // 인자를 빼면 문서까지 끌려 올라간다(`shellScroll.test.tsx` 가 그 사고를 적어 뒀다).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('위를 읽는 중에 답글이 오면 화면을 옮기지 않는다', async () => {
    render(<ThreadPanel />);
    lookUp(screen.getByTestId('thread-scroll'));

    const scrollIntoView = spyScroll();
    arrive('u2');

    await waitFor(() => expect(screen.getByText('답글 m3')).toBeTruthy());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('바닥을 보고 있으면 답글을 따라 내려간다', async () => {
    render(<ThreadPanel />);
    // jsdom 의 기본값(전부 0)이 곧 "바닥에 붙어 있다"다.
    const scrollIntoView = spyScroll();
    arrive('u2');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
  });

  it('내가 쓴 답글은 위를 보고 있어도 따라 내려간다', async () => {
    render(<ThreadPanel />);
    lookUp(screen.getByTestId('thread-scroll'));

    const scrollIntoView = spyScroll();
    arrive('u1');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
  });

  it('다른 스레드로 옮기면 다시 바닥에서 시작한다', async () => {
    render(<ThreadPanel />);
    // 앞 스레드에서 위를 보던 상태. 상자는 스레드가 바뀌어도 같은 DOM 이라 그대로 남는다.
    lookUp(screen.getByTestId('thread-scroll'));

    const scrollIntoView = spyScroll();
    useAppStore.getState().set({
      threadRootId: 'm9',
      messages: { c1: [root(), reply('m2', 2, 'u2'), msg('m9', 'c1', 9, '다른 뿌리', 'u2')] },
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
  });
});

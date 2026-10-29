/**
 * **스레드의 「↓ 최신 답글」 알약**(2026-10-29, 소유자 결정 C안 · designer 시안 v1).
 *
 * 붙잡는 규율:
 *  1. 바닥에 있으면 알약이 없다.
 *  2. 바닥에서 한 화면 넘게 올리면 뜬다. 누르면 바닥으로 가고 사라진다.
 *  3. 위를 읽는 중 남의 답글이 오면 수를 단다(「새 답글 1」).
 *  4. 받아 둔 창 아래가 비었으면(뿌리 `lastReplyAt` 이 마지막 답글보다 늦다) 바닥이어도 뜨고, 누르면 최신 페이지를 받는다.
 *
 * jsdom 은 레이아웃을 재지 않는다 — 스크롤 수치는 `threadScroll.test.tsx` 와 같이 `defineProperty` 로 세운다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';

const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const root = (lastReplyAt: string | null = null) => msg('m1', 'c1', 1, '뿌리', 'u2', { createdAt: at(0), lastReplyAt });
const reply = (id: string, seq: number, author: string) =>
  msg(id, 'c1', seq, `답글 ${id}`, author, { threadRootId: 'm1', createdAt: at(seq) });

let openThread: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
  openThread = vi.fn(async () => undefined);
  setController({ reply: vi.fn(async () => undefined), closeThread: vi.fn(), openThread } as unknown as Controller);
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

const metrics = (el: HTMLElement, scrollTop: number) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
  fireEvent.scroll(el);
};

describe('스레드 「↓ 최신 답글」 알약', () => {
  it('바닥에 있으면 없다', () => {
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-jump-to-latest')).toBeNull();
  });

  it('한 화면 안쪽만 올리면 뜨지 않고, 한 화면 넘게 올리면 뜬다', () => {
    render(<ThreadPanel />);
    const list = screen.getByTestId('thread-scroll');
    metrics(list, 1200); // 바닥까지 300 — 한 화면(500) 안
    expect(screen.queryByTestId('thread-jump-to-latest')).toBeNull();
    metrics(list, 0); // 바닥까지 1500
    expect(screen.getByTestId('thread-jump-to-latest').textContent).toContain('Latest replies');
  });

  it('누르면 바닥으로 가고 사라진다', () => {
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    render(<ThreadPanel />);
    metrics(screen.getByTestId('thread-scroll'), 0);
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByTestId('thread-jump-to-latest'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(screen.queryByTestId('thread-jump-to-latest')).toBeNull();
    expect(openThread).not.toHaveBeenCalled();
  });

  it('위를 읽는 중 남의 답글이 오면 수를 달고, 내 이름 글은 세지 않는다', async () => {
    render(<ThreadPanel />);
    metrics(screen.getByTestId('thread-scroll'), 0);
    useAppStore.getState().set({ messages: { c1: [root(), reply('m2', 2, 'u2'), reply('m3', 3, 'u2'), reply('m4', 4, 'u1')] } });
    await waitFor(() => expect(screen.getByTestId('thread-jump-to-latest').textContent).toContain('New replies · 1'));
    expect(screen.getByTestId('thread-jump-to-latest').getAttribute('aria-label')).toBe('Jump to latest replies, 1 new');
  });

  it('받아 둔 창 아래가 비었으면 바닥이어도 뜨고, 누르면 최신 페이지를 받는다(Postgres 시각 꼴도 읽는다)', async () => {
    useAppStore.getState().set({ messages: { c1: [root('2026-10-29 10:05:00.123456+00'), reply('m2', 2, 'u2')] } });
    render(<ThreadPanel />);
    const pill = screen.getByTestId('thread-jump-to-latest');
    fireEvent.click(pill);
    await waitFor(() => expect(openThread).toHaveBeenCalledWith('m1', { channelId: 'c1' }));
    // 한 번 받은 뒤 같은 시각에는 다시 「비었다」고 하지 않는다.
    await waitFor(() => expect(screen.queryByTestId('thread-jump-to-latest')).toBeNull());
  });

  it('뿌리 시각이 마지막 답글과 같으면(미세한 µs 차이만) 비었다고 보지 않는다', () => {
    useAppStore.getState().set({ messages: { c1: [root('2026-10-29 10:00:02.000400+00'), reply('m2', 2, 'u2')] } });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-jump-to-latest')).toBeNull();
  });
});

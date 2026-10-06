/**
 * #1223 n1 — 첫 페이지를 기다리는 동안 「아직 메시지가 없다」를 그리지 않는다.
 *
 * 재시작 뒤 마지막 채널을 복원하면 그 채널은 응답이 오기 **전에** 열린다. 그때 빈 상태를
 * 그리면 받지 못한 것을 없는 것으로 말하게 된다. 응답이 빈 페이지일 때만 빈 상태가 선다.
 * 400ms 를 넘기면 "불러오는 중" 한 줄만 보인다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { lastChannelScope, lastChannelStorage } from '../src/lib/prefs';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

const SCOPE = lastChannelScope('https://a.example.com', 'acct-1')!;

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  localStorage.clear();
  useAppStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePrefsStore.getState().setLocale('system');
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function bootWith(page: Promise<{ messages: ReturnType<typeof msg>[]; hasMore: boolean }>) {
  lastChannelStorage.save(SCOPE, 'c1');
  const { makeWs } = fakeWsFactory();
  const c = new Controller(fakeApi({
    messages: vi.fn(() => page) as never,
    me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
  }), makeWs);
  c.lastChannelScope = SCOPE;
  setController(c);
  await c.start();
  return c;
}

describe('복원 채널의 첫 페이지 대기', () => {
  it('응답 전에는 빈 상태를 그리지 않고, 400ms 를 넘기면 불러오는 중 한 줄을 보인다', async () => {
    const page = deferred<{ messages: ReturnType<typeof msg>[]; hasMore: boolean }>();
    await bootWith(page.promise);
    expect(useAppStore.getState().activeChannelId).toBe('c1');
    vi.useFakeTimers();
    render(<ChannelPane />);
    expect(screen.queryByTestId('channel-empty-state')).toBeNull();
    expect(screen.queryByTestId('channel-loading')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(screen.getByTestId('channel-loading').textContent).toContain('메시지를 불러오는 중');
    vi.useRealTimers();

    await act(async () => { page.resolve({ messages: [msg('m1', 'c1', 1, '안녕하세요', 'u2')], hasMore: false }); });
    await vi.waitFor(() => expect(screen.queryByTestId('channel-loading')).toBeNull());
    expect(screen.queryByTestId('channel-empty-state')).toBeNull();
  });

  it('빈 페이지가 오면 그때 빈 상태가 선다', async () => {
    const page = deferred<{ messages: ReturnType<typeof msg>[]; hasMore: boolean }>();
    await bootWith(page.promise);
    render(<ChannelPane />);
    expect(screen.queryByTestId('channel-empty-state')).toBeNull();
    await act(async () => { page.resolve({ messages: [], hasMore: false }); });
    await vi.waitFor(() => expect(screen.getByTestId('channel-empty-state')).toBeTruthy());
    expect(screen.queryByTestId('channel-loading')).toBeNull();
  });
});

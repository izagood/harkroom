/**
 * #1226 designer n1·n2 — 첫 창의 뒤채움 동안 짧은 첫 화면을 그리지 않는다.
 *
 * 목록은 바닥 정렬이 아니라서, 첫 50행의 최상위가 몇 줄뿐인 채널(답글·progress 가 많은 채널)은 그
 * 몇 줄이 창 위쪽에 섰다가 뒤채움이 오면 바닥으로 미끄러진다. 그래서 최상위가 화면을 못 채우면
 * 뒤채움 동안 첫 페이지 대기처럼 비워 두고(400ms 를 넘기면 "불러오는 중" 한 줄), 최상위가 넉넉하면
 * 바로 그린다. 뒤채움 동안 「Load older messages」는 숨긴다(n2).
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

type Row = ReturnType<typeof msg>;
type Page = { messages: Row[]; hasMore: boolean };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const root = (seq: number) => msg(`m${seq}`, 'c1', seq, `최상위 ${seq}`, 'u2');
const reply = (seq: number) => msg(`r${seq}`, 'c1', seq, `답글 ${seq}`, 'u2', { threadRootId: 'm951', alsoInChannel: false });

/** 첫 페이지(since=0)는 바로 주고, 뒤채움(before)은 미뤄 둔다. */
async function bootWith(first: Page, back: Promise<Page>) {
  lastChannelStorage.save(SCOPE, 'c1');
  const { makeWs } = fakeWsFactory();
  const c = new Controller(fakeApi({
    messages: vi.fn((_c: string, o?: { before?: number }) => (o?.before !== undefined ? back : Promise.resolve(first))) as never,
    me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
  }), makeWs);
  c.lastChannelScope = SCOPE;
  setController(c);
  await c.start();
  await vi.waitFor(() => expect(useAppStore.getState().backfilling.c1).toBe(true));
  return c;
}

describe('첫 창 뒤채움 동안의 짧은 첫 화면', () => {
  it('최상위가 몇 줄뿐이면 뒤채움 동안 줄을 그리지 않고, 450ms 뒤 불러오는 중을 보이고, 뒤채움이 오면 줄이 선다', async () => {
    // 최상위 3줄 + 답글 47행 = 50행.
    const first = { messages: [root(951), root(952), root(953), ...Array.from({ length: 47 }, (_, i) => reply(954 + i))], hasMore: true };
    const back = deferred<Page>();
    await bootWith(first, back.promise);
    vi.useFakeTimers();
    render(<ChannelPane />);
    expect(screen.queryByText('최상위 951')).toBeNull();
    expect(screen.queryByTestId('channel-empty-state')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
    await act(async () => { vi.advanceTimersByTime(450); });
    expect(screen.getByTestId('channel-loading').textContent).toContain('메시지를 불러오는 중');
    vi.useRealTimers();

    await act(async () => { back.resolve({ messages: Array.from({ length: 30 }, (_, i) => root(921 + i)), hasMore: true }); });
    await vi.waitFor(() => expect(screen.getByText('최상위 951')).toBeTruthy());
    expect(screen.queryByTestId('channel-loading')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load older messages' })).toBeTruthy();
  });

  it('최상위가 넉넉하면 뒤채움을 기다리지 않고 바로 그린다(「Load older」는 뒤채움 동안 숨긴다)', async () => {
    const first = { messages: Array.from({ length: 50 }, (_, i) => root(951 + i)), hasMore: true };
    const back = deferred<Page>();
    await bootWith(first, back.promise);
    render(<ChannelPane />);
    expect(screen.getByText('최상위 1000')).toBeTruthy();
    expect(screen.queryByTestId('channel-loading')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();

    await act(async () => { back.resolve({ messages: [root(950)], hasMore: true }); });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Load older messages' })).toBeTruthy());
  });
});

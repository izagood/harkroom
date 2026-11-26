/**
 * 최신 50 행이 **전부 답글**인 채널에서도 첫 로드에 최상위가 보인다(2026-11-26).
 *
 * 첫 페이지를 최신 행(`since=0`)으로만 받으면 한 스레드에 답글이 몰린 채널은 최상위가 0 줄이다. 그때 본문은
 * 뒤채움이 올 때까지 비고, 뒤채움이 시한에 걸리면 끝내 빈 화면이 남았다. 첫 페이지가 본문 줄 머리(`feed`)를 함께
 * 받으므로 뒤채움이 끝나지 않아도 최상위가 선다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController, FEED_HEAD_BEFORE, FIRST_PAGE_LIMIT } from '../src/state/controller';
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
  usePrefsStore.getState().setLocale('system');
});

// 채널: 최상위 m901~m950, 그 가운데 m950 의 스레드에 답글 951~1000 이 몰렸다.
const root = (seq: number) => msg(`m${seq}`, 'c1', seq, `최상위 ${seq}`, 'u2',
  seq === 950 ? { replyCount: 50, activityCount: 50 } : {});
const reply = (seq: number) => msg(`m${seq}`, 'c1', seq, `답글 ${seq}`, 'u2', { threadRootId: 'm950' });
const roots = Array.from({ length: 50 }, (_, i) => root(901 + i));
const replies = Array.from({ length: 50 }, (_, i) => reply(951 + i));

describe('첫 페이지 — 본문 줄 머리', () => {
  it('최신 50 행이 전부 답글이어도 첫 로드에 최상위가 보인다(뒤채움을 기다리지 않는다)', async () => {
    type Opts = { since?: number; before?: number; limit?: number; feed?: boolean };
    const messages = vi.fn((_c: string, o?: Opts) => {
      // 서버 모양 그대로: since=0 은 답글이 섞인 최신 행, feed 는 본문에 서는 줄만.
      if (o?.since === 0) return Promise.resolve({ messages: replies.slice(-(o.limit ?? 200)), hasMore: true });
      if (o?.feed && o.before === FEED_HEAD_BEFORE) return Promise.resolve({ messages: roots.slice(-(o.limit ?? 100)), hasMore: true });
      // 뒤채움(그 아래 본문 줄)은 끝나지 않는다 — 시한에 걸린 서버.
      return new Promise<never>(() => {});
    });
    lastChannelStorage.save(SCOPE, 'c1');
    const c = new Controller(fakeApi({
      messages: messages as never,
      me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
    }), fakeWsFactory().makeWs);
    c.lastChannelScope = SCOPE;
    setController(c);
    await c.start();
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1?.length).toBe(100));

    expect(messages).toHaveBeenCalledWith('c1', { before: FEED_HEAD_BEFORE, limit: FIRST_PAGE_LIMIT, feed: true });
    // 최신 행도 함께 받는다 — 읽음 위치·증분의 기준(가장 큰 seq)이 최신 끝에 맞는다.
    expect(Math.max(...useAppStore.getState().messages.c1!.map((m) => m.seq))).toBe(1000);
    // 뒤채움은 아직 돌고 있다(끝나지 않는다).
    expect(useAppStore.getState().backfilling.c1).toBe(true);

    render(<ChannelPane />);
    expect(screen.getByText('최상위 950')).toBeTruthy();
    expect(screen.getByText('최상위 901')).toBeTruthy();
    expect(screen.queryByText('답글 1000')).toBeNull();
  });

  it('본문 줄 머리 요청이 실패하면 예전 모양(최신 행 + 뒤채움)으로 물러난다', async () => {
    type Opts = { since?: number; before?: number; limit?: number; feed?: boolean };
    const messages = vi.fn(async (_c: string, o?: Opts) => {
      if (o?.since === 0) return { messages: replies, hasMore: true };
      if (o?.before === FEED_HEAD_BEFORE) throw new Error('timeout');
      return { messages: roots, hasMore: false };
    });
    const c = new Controller(fakeApi({ messages: messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    expect(messages).toHaveBeenCalledWith('c1', { before: 951, limit: expect.any(Number), feed: true });
    await vi.waitFor(() => expect(useAppStore.getState().messages.c1?.length).toBe(100));
    expect(useAppStore.getState().hasMore.c1).toBe(false);
  });
});

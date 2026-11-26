/**
 * 이전 메시지 받기가 실패하면 본문 맨 위에 실패 문구와 「다시 시도」가 선다(2026-11-26).
 * 예전에는 뒤채움 실패를 삼켜 최신 몇 줄만 보인 채 아무 표시가 없었다. 다시 시도가 성공하면 걷힌다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
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
  usePrefsStore.getState().setLocale('system');
});

const root = (seq: number) => msg(`m${seq}`, 'c1', seq, `최상위 ${seq}`, 'u2');

describe('이전 메시지 실패 줄', () => {
  it('뒤채움이 실패하면 실패 문구와 다시 시도가 서고, 다시 시도가 성공하면 걷힌다', async () => {
    let fail = true;
    const messages = vi.fn(async (_c: string, o?: { before?: number }) => {
      if (o?.before === undefined) return { messages: Array.from({ length: 50 }, (_, i) => root(951 + i)), hasMore: true };
      if (fail) { fail = false; throw new Error('timeout'); }
      return { messages: [root(900)], hasMore: true };
    });
    lastChannelStorage.save(SCOPE, 'c1');
    const c = new Controller(fakeApi({
      messages: messages as never,
      me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
    }), fakeWsFactory().makeWs);
    c.lastChannelScope = SCOPE;
    setController(c);
    await c.start();
    await vi.waitFor(() => expect(useAppStore.getState().olderFailed.c1).toBe(true));

    render(<ChannelPane />);
    expect(screen.getByTestId('load-older-failed').textContent).toBe('이전 메시지를 불러오지 못했어요.');
    expect(screen.getByTestId('load-older').textContent).toBe('다시 시도');

    await act(async () => { fireEvent.click(screen.getByTestId('load-older')); });
    await vi.waitFor(() => expect(screen.queryByTestId('load-older-failed')).toBeNull());
    expect(screen.getByTestId('load-older').textContent).toBe('이전 메시지 불러오기');
  });
});

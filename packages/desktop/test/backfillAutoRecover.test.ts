/**
 * 뒤채움이 실패해도 **스스로 회복한다**(2026-11-27, 규모 검토 B).
 *
 * 본문 줄이 0 개면 스크롤할 높이가 없어 「이전 메시지」를 부를 손짓이 생기지 않는다 — 일시적인 실패 한 번이 영구 빈 화면이
 * 됐다. 이제 본문이 첫 페이지 목표보다 적고 과거가 남았으면 백오프로 다시 묻고(횟수 상한), 다시 열 때도 다시 묻는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, FEED_HEAD_BEFORE } from '../src/state/controller';
import { fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

type Opts = { since?: number; before?: number; limit?: number; feed?: boolean };

// 채널: 최상위 m1~m50, 그 위 최신 50 행(51~100)은 전부 m50 의 답글이다.
const roots = Array.from({ length: 50 }, (_, i) => msg(`m${i + 1}`, 'c1', i + 1, `최상위 ${i + 1}`, 'u2'));
const replies = Array.from({ length: 50 }, (_, i) => msg(`m${i + 51}`, 'c1', i + 51, `답글 ${i + 51}`, 'u2', { threadRootId: 'm50' }));
const feedRows = () => (useAppStore.getState().messages.c1 ?? []).filter((m) => !m.threadRootId);

/** 본문 줄 머리는 늘 실패하고(시한), 그 아래 뒤채움은 `failOlder` 번 실패한 뒤 성공한다. */
function server(failOlder: number) {
  let olderCalls = 0;
  const messages = vi.fn(async (_c: string, o?: Opts) => {
    if (o?.since === 0) return { messages: replies, hasMore: true };
    if (o?.since && o.since > 0) return { messages: [], hasMore: false };
    if (o?.before === FEED_HEAD_BEFORE) throw new Error('timeout');
    olderCalls++;
    if (olderCalls <= failOlder) throw new Error('timeout');
    return { messages: roots, hasMore: false };
  });
  return { messages, olderCalls: () => olderCalls };
}

// 시험에서는 간격만 줄인다 — 횟수(배열 길이)는 실제 값 그대로다.
const REAL_BACKOFF = Controller.AUTO_OLDER_BACKOFF_MS;
const RETRIES = REAL_BACKOFF.length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  Controller.AUTO_OLDER_BACKOFF_MS = REAL_BACKOFF.map((_, i) => 5 * (i + 1));
});
afterEach(() => {
  Controller.AUTO_OLDER_BACKOFF_MS = REAL_BACKOFF;
});

describe('뒤채움 자동 회복', () => {
  it('최신 행이 전부 답글 + feed 실패 + 뒤채움 실패여도 백오프 재시도로 최상위가 선다', async () => {
    const s = server(2);
    const c = new Controller(fakeApi({ messages: s.messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await vi.waitFor(() => expect(feedRows()).toHaveLength(50));
    expect(s.olderCalls()).toBe(3);
    expect(useAppStore.getState().olderFailed.c1).toBeFalsy();
    c.stop();
  });

  it('재시도 횟수를 다 쓰면 멈춘다 — 끝없이 묻지 않고 「다시 시도」 줄이 남는다', async () => {
    const s = server(Infinity);
    const c = new Controller(fakeApi({ messages: s.messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await vi.waitFor(() => expect(s.olderCalls()).toBe(1 + RETRIES));
    await sleep(100);
    expect(s.olderCalls()).toBe(1 + RETRIES);
    expect(useAppStore.getState().olderFailed.c1).toBe(true);
    expect(feedRows()).toHaveLength(0);
    c.stop();
  });

  it('뒤채움이 실패한 채널을 다시 열면 뒤채움을 다시 돌려 회복한다', async () => {
    const s = server(1 + RETRIES);
    const c = new Controller(fakeApi({ messages: s.messages as never }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await vi.waitFor(() => expect(s.olderCalls()).toBe(1 + RETRIES));
    await sleep(100);
    expect(s.olderCalls()).toBe(1 + RETRIES);
    expect(useAppStore.getState().olderFailed.c1).toBe(true);
    expect(feedRows()).toHaveLength(0);

    await c.openChannel('c2');
    await c.openChannel('c1');
    await vi.waitFor(() => expect(feedRows()).toHaveLength(50));
    expect(useAppStore.getState().olderFailed.c1).toBeFalsy();
    c.stop();
  });
});

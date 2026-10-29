import { describe, it, expect } from 'vitest';
import { MENTION_CHAIN_BACKSTOP_LIMIT, MENTION_CHAIN_LIMIT } from '@harkroom/shared';
import { effectiveChainLimit } from '../src/services/mentionPolicy.js';

/**
 * **판정 상한은 정체 차단 스위치와 묶인다**(④, security M1). 차단이 꺼진 채 상한만 100 이 되면 루프가 12.5배 오래 돈다 —
 * 저장값은 그대로 두고, 차단이 켜졌고 저장값이 옛 기본값일 때만 백스톱 100 을 쓴다.
 */
const db = (stored: number | null) => ({
  query: async () => ({ rows: stored === null ? [] : [{ chain_limit: stored }] }),
}) as never;

describe('effectiveChainLimit', () => {
  it('차단이 꺼져 있으면 저장값 그대로다 — 옛 기본값도 8 로 막는다', async () => {
    expect(await effectiveChainLimit(db(MENTION_CHAIN_LIMIT), {})).toBe(MENTION_CHAIN_LIMIT);
    expect(await effectiveChainLimit(db(null), {})).toBe(MENTION_CHAIN_LIMIT);
    expect(await effectiveChainLimit(db(50), { HARKROOM_STALL_BLOCK: 'off' })).toBe(50);
  });

  it('차단이 켜졌고 저장값이 옛 기본값이면 백스톱 100 이다', async () => {
    expect(await effectiveChainLimit(db(MENTION_CHAIN_LIMIT), { HARKROOM_STALL_BLOCK: 'on' })).toBe(MENTION_CHAIN_BACKSTOP_LIMIT);
    expect(await effectiveChainLimit(db(null), { HARKROOM_STALL_BLOCK: 'on' })).toBe(MENTION_CHAIN_BACKSTOP_LIMIT);
  });

  it('admin 이 고른 값은 켜져 있어도 그대로다', async () => {
    expect(await effectiveChainLimit(db(50), { HARKROOM_STALL_BLOCK: 'on' })).toBe(50);
    expect(await effectiveChainLimit(db(4), { HARKROOM_STALL_BLOCK: 'on' })).toBe(4);
  });
});

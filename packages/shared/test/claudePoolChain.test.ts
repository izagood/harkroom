// 풀 순서 판정(2026-10-15, alice D1~D5 전부 A). 러너와 화면이 같이 쓰는 식이다.
import { describe, expect, it } from 'vitest';

import { poolChainState, type PoolChainInput } from '../src/claudePoolChain.js';
import { parseClaudePoolsConfig } from '../src/claudePools.js';
import type { ClaudeUsageEntry } from '../src/claudeUsage.js';

const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const H = 3_600_000;

function u(pool: string, account: string, o: { session?: number; weekly?: number; sessionResetH?: number; weeklyResetH?: number; readAgoMs?: number } = {}): ClaudeUsageEntry {
  return {
    pool, account, signIn: null,
    session: { usedPercent: o.session ?? 10, resetsAtMs: NOW + (o.sessionResetH ?? 2) * H },
    weekly: { usedPercent: o.weekly ?? 10, resetsAtMs: NOW + (o.weeklyResetH ?? 100) * H },
    modelWeekly: [],
    readAtMs: NOW - (o.readAgoMs ?? 60_000),
  };
}

function input(usage: ClaudeUsageEntry[], o: Partial<PoolChainInput> = {}): PoolChainInput {
  return {
    chain: ['work', 'personal', 'team-b'],
    accountsByPool: new Map([['work', ['a', 'b']], ['personal', ['c']], ['team-b', ['d']]]),
    usage, cfg: null, now: NOW,
    ...o,
  };
}

describe('poolChainState', () => {
  it('평소 — 1번을 쓴다', () => {
    const s = poolChainState(input([u('work', 'a', { session: 50 }), u('work', 'b')]));
    expect(s.activeIndex).toBe(0);
    expect(s.entries.map((e) => e.status)).toEqual(['available', 'available', 'available']);
  });

  it('앞 풀의 계정이 하나라도 남으면 넘어가지 않는다(모두 소진돼야 다음)', () => {
    const s = poolChainState(input([u('work', 'a', { session: 90 }), u('work', 'b', { session: 84 })]));
    expect(s.activeIndex).toBe(0);
  });

  it('앞 풀이 모두 기준(85/97)에 닿으면 다음 풀 — 풀리는 시각은 가장 먼저 풀리는 계정', () => {
    const s = poolChainState(input([
      u('work', 'a', { session: 85, sessionResetH: 3 }),
      u('work', 'b', { session: 92, sessionResetH: 1 }),
    ]));
    expect(s.activeIndex).toBe(1);
    expect(s.entries[0]).toMatchObject({ status: 'exhausted', exhaustedBy: 'session', unblockAtMs: NOW + 1 * H });
    expect(s.allExhausted).toBe(false);
  });

  it('주간 기준(97)도 소진이다 — 창이 다르면 mixed', () => {
    const s = poolChainState(input([
      u('work', 'a', { weekly: 97 }),
      u('work', 'b', { session: 88 }),
    ]));
    expect(s.entries[0]).toMatchObject({ status: 'exhausted', exhaustedBy: 'mixed' });
  });

  it('리셋 시각이 지난 창은 다시 재기 전에도 풀린 것으로 본다 — 앞 풀로 돌아온다', () => {
    const s = poolChainState(input([
      u('work', 'a', { session: 95, sessionResetH: -0.1 }),
      u('work', 'b', { session: 95, sessionResetH: 2 }),
    ]));
    expect(s.activeIndex).toBe(0);
  });

  it('모르는(낡은) 계정은 소진이 아니다 — 조회 실패로 멀쩡한 풀을 건너뛰지 않는다', () => {
    const s = poolChainState(input([
      u('work', 'a', { session: 95 }),
      u('work', 'b', { session: 95, readAgoMs: 30 * 60_000 }),
    ]));
    expect(s.activeIndex).toBe(0);
    expect(s.entries[0]!.accounts[1]).toMatchObject({ known: false, hot: false });
  });

  it('풀별 기준을 쓴다(pools.json assign)', () => {
    const cfg = parseClaudePoolsConfig({ assign: { work: { newSessionPct: 50 } } });
    const s = poolChainState(input([u('work', 'a', { session: 60 }), u('work', 'b', { session: 55 })], { cfg }));
    expect(s.activeIndex).toBe(1);
  });

  it('관문에 막힌 계정은 새 스레드를 못 받는다', () => {
    const s = poolChainState(input([u('work', 'a', { session: 90 })], { blocked: (p, a) => p === 'work' && a === 'b' }));
    expect(s.entries[0]).toMatchObject({ status: 'exhausted' });
    expect(s.activeIndex).toBe(1);
  });

  it('없는 풀·빈 풀은 건너뛴다 — 목록에서 빼지 않고 칸으로 남긴다', () => {
    const s = poolChainState(input([], {
      chain: ['gone', 'empty', 'work'],
      accountsByPool: new Map([['empty', []], ['work', ['a']]]),
    }));
    expect(s.entries.map((e) => e.status)).toEqual(['missing', 'empty', 'available']);
    expect(s.activeIndex).toBe(2);
  });

  it('모두 소진이면 멈추지 않고 가장 먼저 풀리는 풀로 보낸다(D4)', () => {
    const s = poolChainState(input([
      u('work', 'a', { session: 90, sessionResetH: 3 }),
      u('work', 'b', { session: 90, sessionResetH: 4 }),
      u('personal', 'c', { session: 90, sessionResetH: 1 }),
      u('team-b', 'd', { weekly: 99, weeklyResetH: 50 }),
    ]));
    expect(s.allExhausted).toBe(true);
    expect(s.activeIndex).toBe(1);
  });

  it('쓸 수 있는 풀이 없으면(전부 없음) null', () => {
    const s = poolChainState(input([], { accountsByPool: new Map() }));
    expect(s).toMatchObject({ activeIndex: null, allExhausted: false });
  });
});

// 스레드별 계정 배정(C ②) 회귀선. 숫자는 jaebin 이 고른 값(85/97, 95/98)이다.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ClaudeUsageEntry } from '@harkroom/shared/claudeUsage';

import {
  createAccountAssigner,
  DEFAULT_ASSIGN_POLICY,
  pickAccount,
  type PickInput,
} from '../src/accountAssign.js';

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const H = 3_600_000;

function entry(
  account: string,
  o: { session?: number | null; weekly?: number; weeklyResetH?: number | null; sessionResetH?: number;
    signIn?: string | null; readAgoMs?: number; model?: { label: string; pct: number } } = {},
): ClaudeUsageEntry {
  return {
    pool: '', account, signIn: o.signIn ?? null,
    session: o.session === null ? null : { usedPercent: o.session ?? 10, resetsAtMs: NOW + (o.sessionResetH ?? 3) * H },
    weekly: {
      usedPercent: o.weekly ?? 10,
      resetsAtMs: o.weeklyResetH === null ? null : NOW + (o.weeklyResetH ?? 100) * H,
    },
    modelWeekly: o.model ? [{ label: o.model.label, window: { usedPercent: o.model.pct, resetsAtMs: NOW + 100 * H } }] : [],
    readAtMs: NOW - (o.readAgoMs ?? 60_000),
  };
}

function input(entries: ClaudeUsageEntry[], o: Partial<PickInput> = {}): PickInput {
  return {
    accounts: o.accounts ?? ['a', 'b', 'c'],
    usage: new Map(entries.map((e) => [e.account, e])),
    pinned: null,
    policy: DEFAULT_ASSIGN_POLICY,
    now: NOW,
    recentAssignments: new Map(),
    random: () => 0, // 상위 둘 중 첫째
    ...o,
  };
}

describe('pickAccount', () => {
  it('먼저 초기화될 여유부터 쓴다 — 남은 양이 커도 초기화가 멀면 뒤다', () => {
    // a: 40% 남음 · 24h 뒤 초기화(1.67/h), b: 50% 남음 · 144h 뒤(0.35/h)
    const r = pickAccount(input([
      entry('a', { weekly: 60, weeklyResetH: 24 }),
      entry('b', { weekly: 50, weeklyResetH: 144 }),
    ], { accounts: ['b', 'a'] }));
    expect(r.order).toEqual(['a', 'b']);
    expect(r.reason).toBe('new');
  });

  it('새 배정은 5h ≥ 85 · 주간 ≥ 97 을 뺀다', () => {
    const r = pickAccount(input([
      entry('a', { session: 85, weekly: 0 }),
      entry('b', { weekly: 97, weeklyResetH: 1 }),
      entry('c', { weekly: 50 }),
    ]));
    expect(r.order[0]).toBe('c');
    // 뺀 계정도 페일오버 꼬리에는 남는다
    expect(r.order).toHaveLength(3);
  });

  it('고정된 계정은 옮기기 기준(95/98) 아래면 그대로 쓴다 — 새 배정 기준을 넘었어도', () => {
    const r = pickAccount(input([
      entry('a', { session: 90, weekly: 50 }),
      entry('b', { weekly: 0 }),
    ], { accounts: ['a', 'b'], pinned: 'a' }));
    expect(r).toMatchObject({ reason: 'kept', order: ['a', 'b'] });
  });

  it('고정된 계정이 옮기기 기준을 넘으면 옮긴다', () => {
    for (const hot of [{ session: 95 }, { weekly: 98 }]) {
      const r = pickAccount(input([
        entry('a', hot),
        entry('b', { weekly: 30 }),
      ], { accounts: ['a', 'b'], pinned: 'a' }));
      expect(r.reason).toBe('moved');
      expect(r.order).toEqual(['b', 'a']);
    }
  });

  it('점수가 10% 안쪽이면 5시간 사용률이 낮은 쪽이 먼저다', () => {
    const r = pickAccount(input([
      entry('a', { weekly: 50, session: 60 }),
      entry('b', { weekly: 52, session: 10 }),
    ], { accounts: ['a', 'b'] }));
    expect(r.order).toEqual(['b', 'a']);
  });

  it('배정당 2%p 감점으로 같은 러너의 몰림을 막는다', () => {
    const es = [entry('a', { weekly: 50 }), entry('b', { weekly: 55 })];
    expect(pickAccount(input(es, { accounts: ['a', 'b'], random: () => 0 })).order[0]).toBe('a');
    const r = pickAccount(input(es, {
      accounts: ['a', 'b'], recentAssignments: new Map([['a', 5]]),
    }));
    // a: (50−10)/100 = 0.40, b: 45/100 = 0.45 → b
    expect(r.order[0]).toBe('b');
  });

  it('상위 둘 가운데 무작위로 흩는다', () => {
    const es = [entry('a', { weekly: 10 }), entry('b', { weekly: 40 }), entry('c', { weekly: 80 })];
    expect(pickAccount(input(es, { random: () => 0.1 })).order[0]).toBe('a');
    expect(pickAccount(input(es, { random: () => 0.9 })).order[0]).toBe('b');
  });

  it('같은 로그인은 한 칸이다 — 가장 최근 값을 함께 쓰고 배정 수도 합친다', () => {
    const r = pickAccount(input([
      entry('a', { weekly: 90, signIn: 'x', readAgoMs: 60_000 }),
      entry('b', { weekly: 10, signIn: 'x', readAgoMs: 5 * 60_000 }), // 더 낡은 값
      entry('c', { weekly: 50 }),
    ]));
    // a·b 는 90% 로 본다 → c 가 먼저
    expect(r.order[0]).toBe('c');
  });

  it('낡은 값·없는 값은 모르는 계정이다 — 빼지 않고 중간 점수를 준다', () => {
    const r = pickAccount(input([
      entry('a', { weekly: 99, readAgoMs: 11 * 60_000 }), // 낡았다 → 모름
      entry('b', { weekly: 20 }),
      entry('c', { weekly: 80 }),
    ]));
    // b(0.8) > 모름 a(중간 0.5) > c(0.2)
    expect(r.order).toEqual(['b', 'a', 'c']);
  });

  it('믿을 만한 값이 하나도 없으면 지금 동작(풀 순서)이다', () => {
    const r = pickAccount(input([], { accounts: ['b', 'a'] }));
    expect(r).toMatchObject({ reason: 'unknown', order: ['b', 'a'] });
    const kept = pickAccount(input([], { accounts: ['b', 'a'], pinned: 'a' }));
    expect(kept).toMatchObject({ reason: 'kept', order: ['a', 'b'] });
  });

  it('모두 뜨거우면 막지 않고 걸린 창이 가장 먼저 풀리는 계정으로 보낸다', () => {
    const r = pickAccount(input([
      entry('a', { session: 90, sessionResetH: 4 }),
      entry('b', { session: 90, sessionResetH: 1 }),
      entry('c', { weekly: 97, weeklyResetH: 50 }),
    ]));
    expect(r.reason).toBe('all-hot');
    expect(r.order[0]).toBe('b');
  });

  it('모델에 맞는 모델별 주간 창이 더 빡빡하면 그것을 쓴다', () => {
    const es = [
      entry('a', { weekly: 20, model: { label: 'Opus weekly', pct: 97 } }),
      entry('b', { weekly: 40 }),
    ];
    expect(pickAccount(input(es, { accounts: ['a', 'b'], model: 'claude-opus-5-5' })).order[0]).toBe('b');
    expect(pickAccount(input(es, { accounts: ['a', 'b'], model: 'claude-sonnet-5-5' })).order[0]).toBe('a');
  });
});

describe('pickAccount — 같은 로그인은 후보 한 자리 (09-30 qa 실측)', () => {
  // lychee·lime 은 같은 로그인, plum 은 다른 로그인. 묶지 않으면 상위 둘이 lychee·lime 이라
  // 무작위를 어떻게 굴려도 plum 이 첫째가 되지 않았다.
  const usage = [
    entry('lychee', { signIn: 's1', weekly: 64, weeklyResetH: 2.4, session: 70 }),
    entry('lime', { signIn: 's1', weekly: 64, weeklyResetH: 2.4, session: 70 }),
    entry('plum', { signIn: 's2', weekly: 0, weeklyResetH: 26, session: 0 }),
    entry('acct', { signIn: 's3', weekly: 0, weeklyResetH: 170, session: 0 }),
  ];
  const accounts = ['lime', 'lychee', 'plum', 'acct'];

  it('상위 둘은 로그인 묶음 둘이다 — 둘째를 뽑으면 다른 로그인으로 간다', () => {
    const first = pickAccount(input(usage, { accounts, random: () => 0 }));
    const second = pickAccount(input(usage, { accounts, random: () => 0.9 }));
    expect(first.order[0]).toBe('lime'); // 묶음 대표는 풀 순서상 앞선 쪽
    expect(second.order[0]).toBe('plum');
  });

  it('묶음의 나머지는 페일오버 꼬리 맨 뒤다 — 빠지지는 않는다', () => {
    const r = pickAccount(input(usage, { accounts, random: () => 0 }));
    expect(r.order).toEqual(['lime', 'plum', 'acct', 'lychee']);
  });
});

describe('pickAccount — 관문에 막힌 계정 (2026-10-01)', () => {
  it('새 배정에서 빠지고 꼬리 맨 뒤로 간다 — 점수가 1등이어도', () => {
    const r = pickAccount(input([
      entry('a', { weekly: 0, weeklyResetH: 10 }),
      entry('b', { weekly: 50 }),
      entry('c', { weekly: 60 }),
    ], { blocked: new Set(['a']) }));
    expect(r.order[0]).not.toBe('a');
    expect(r.order.at(-1)).toBe('a');
  });

  it('고정된 스레드도 옮긴다 — 그 계정으로는 프롬프트조차 못 넣는다', () => {
    const r = pickAccount(input([entry('a'), entry('b')], { accounts: ['a', 'b'], pinned: 'a', blocked: new Set(['a']) }));
    expect(r).toMatchObject({ reason: 'moved', order: ['b', 'a'] });
  });

  it('사용량을 모를 때도 막힌 계정은 맨 뒤다', () => {
    const r = pickAccount(input([], { accounts: ['a', 'b'], blocked: new Set(['a']) }));
    expect(r.order).toEqual(['b', 'a']);
  });
});

describe('createAccountAssigner', () => {
  const acct = (name: string) => ({ name, configDir: `/x/${name}` });

  async function rootWith(entries: (ClaudeUsageEntry & { pool: string })[] | null): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'assign-'));
    if (entries) {
      await writeFile(join(root, 'usage.json'), JSON.stringify({ version: 1, writtenAtMs: NOW, accounts: entries }));
    }
    return root;
  }

  it('풀의 항목만 읽고, 고정 계정을 따른다', async () => {
    const root = await rootWith([
      { ...entry('a', { weekly: 90 }), pool: 'work' },
      { ...entry('b', { weekly: 10 }), pool: 'work' },
      { ...entry('a', { weekly: 0 }), pool: 'other' },
    ]);
    const pins = new Map([['t1', 'a']]);
    const lines: string[] = [];
    const as = createAccountAssigner({
      lane: [acct('a'), acct('b')], pool: 'work', root,
      pinnedOf: (k) => pins.get(k) ?? null, now: () => NOW, random: () => 0, log: (l) => lines.push(l),
    });
    expect((await as.laneFor('t1')).map((a) => a?.name)).toEqual(['a', 'b']);
    expect((await as.laneFor('t2')).map((a) => a?.name)).toEqual(['b', 'a']);
    expect(lines.some((l) => l.includes('t2') && l.includes('새 스레드'))).toBe(true);
  });

  it('pools.json 의 풀별 기준을 턴마다 읽는다', async () => {
    const root = await rootWith([
      { ...entry('a', { session: 70, weekly: 10 }), pool: 'work' },
      { ...entry('b', { session: 10, weekly: 60 }), pool: 'work' },
    ]);
    const as = createAccountAssigner({
      lane: [acct('a'), acct('b')], pool: 'work', root,
      pinnedOf: () => null, now: () => NOW, random: () => 0, log: () => {},
    });
    // 기본(85): a 가 점수로 앞선다
    expect((await as.laneFor('t1'))[0]!.name).toBe('a');
    // 새 배정 5h 기준을 60 으로 내리면 a(70%) 는 빠진다 — 러너를 다시 띄우지 않고
    await writeFile(join(root, 'pools.json'), JSON.stringify({
      defaultPool: 'work', order: {}, agents: {}, assign: { work: { newSessionPct: 60 } },
    }));
    expect((await as.laneFor('t2'))[0]!.name).toBe('b');
  });

  it('usage.json 이 없으면 기동 때 축 그대로다', async () => {
    const root = await rootWith(null);
    const lane = [acct('a'), acct('b')];
    const as = createAccountAssigner({ lane, pool: null, root, pinnedOf: () => null, now: () => NOW });
    expect((await as.laneFor('t')).map((a) => a?.name)).toEqual(['a', 'b']);
  });

  it('계정 풀이 없으면([null]) 손대지 않는다', async () => {
    const lane = [null];
    const as = createAccountAssigner({ lane, pool: null, root: '/nonexistent', pinnedOf: () => null });
    expect(await as.laneFor('t')).toBe(lane);
  });

  it('스냅숏이 새로 읽히기 전까지 이 러너의 배정을 감점으로 센다', async () => {
    const root = await rootWith([
      { ...entry('a', { weekly: 50 }), pool: '' },
      { ...entry('b', { weekly: 53 }), pool: '' },
    ]);
    let t = NOW;
    const as = createAccountAssigner({
      lane: [acct('a'), acct('b')], pool: null, root,
      pinnedOf: () => null, now: () => t, random: () => 0, log: () => {},
    });
    const firsts: string[] = [];
    for (let i = 0; i < 4; i++) {
      t += 1000;
      firsts.push((await as.laneFor(`t${i}`))[0]!.name);
    }
    // a 가 먼저지만 감점이 쌓이면 b 로 넘어간다
    expect(firsts[0]).toBe('a');
    expect(firsts).toContain('b');
  });

  it('current() 로 받은 축을 턴마다 따른다 — 지운 계정은 후보가 아니고 새 계정은 곧바로 후보다', async () => {
    const root = await rootWith([
      { ...entry('a', { weekly: 50, weeklyResetH: 10 }), pool: 'work' },
      { ...entry('b', { weekly: 50, weeklyResetH: 10 }), pool: 'work' },
      { ...entry('c', { weekly: 0, weeklyResetH: 10 }), pool: 'work' },
    ]);
    let lane = [acct('a'), acct('b')];
    const as = createAccountAssigner({
      lane: [acct('a'), acct('b')], pool: 'work', root,
      current: async () => ({ pool: 'work', lane }),
      pinnedOf: () => null, now: () => NOW, random: () => 0, log: () => {},
    });
    expect((await as.laneFor('t1')).map((a) => a?.name)).toEqual(['a', 'b']);
    lane = [acct('b'), acct('c')]; // a 를 지우고 c 를 더했다
    expect((await as.laneFor('t2')).map((a) => a?.name)).toEqual(['c', 'b']);
  });

  it('관문 표식이 유효한 계정을 막힌 계정으로 넘긴다 — 30분 지난 표식은 무시', async () => {
    const root = await rootWith([
      { ...entry('a', { weekly: 0, weeklyResetH: 10 }), pool: 'work' },
      { ...entry('b', { weekly: 50 }), pool: 'work' },
    ]);
    let atMs = NOW - 60_000;
    const as = createAccountAssigner({
      lane: [acct('a'), acct('b')], pool: 'work', root,
      pinnedOf: () => null, now: () => NOW, random: () => 0, log: () => {},
      readAttention: async (dir) => (dir === '/x/a' ? { kind: 'gate', atMs } : null),
    });
    expect((await as.laneFor('t1'))[0]!.name).toBe('b');
    atMs = NOW - 31 * 60_000;
    expect((await as.laneFor('t2'))[0]!.name).toBe('a');
  });
});

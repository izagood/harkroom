import { mkdtemp, mkdir, symlink, writeFile, lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyLedger } from '@harkroom/shared/workspaceCleanup';
import { applyHumanAction, planSweep, removeRebuildable, runSweep, type ObservedWorktree, type SweepFacts } from '../src/workspaceCleanup.js';

const T = { channelId: 'c1', threadRootId: 'r1' };
const NOW = new Date('2026-10-06T00:00:00Z');
const S = { enabled: true, graceDays: 7 };
const wt = (o: Partial<ObservedWorktree> = {}): ObservedWorktree => ({
  path: '/tmp/wt-a', repo: '/repo', branch: 'b', headSha: 'abc', thread: T,
  pr: { number: 1, state: 'merged', headSha: 'abc' }, lastModifiedAt: null, size: 100, ...o,
});
const facts = (o: Partial<SweepFacts> = {}): SweepFacts => ({
  worktrees: [wt()], idle: [], doneThreads: new Set(['c1/r1']), lastTurnAt: new Map(), runningThreads: new Set(), ...o,
});

describe('planSweep', () => {
  it('PR 머지 + 스레드 ✅ 면 넣고 N일 기한·의존성 지우기', () => {
    const p = planSweep(emptyLedger(), facts(), S, NOW);
    expect(p.ledger.items[0]).toMatchObject({ state: 'listed', deleteAfter: '2026-10-13T00:00:00.000Z' });
    expect(p.actions).toEqual([{ op: 'removeDeps', path: '/tmp/wt-a' }]);
  });
  it('스레드가 ✅ 가 아니거나 PR 이 열려 있으면 원장에 올리지 않는다', () => {
    expect(planSweep(emptyLedger(), facts({ doneThreads: new Set() }), S, NOW).ledger.items).toEqual([]);
    expect(planSweep(emptyLedger(), facts({ worktrees: [wt({ pr: { number: 1, state: 'open', headSha: null } })] }), S, NOW).ledger.items).toEqual([]);
  });
  it('주인 모름은 unowned 로 보이기만 하고 할 일이 없다', () => {
    const p = planSweep(emptyLedger(), facts({ worktrees: [wt({ thread: null })] }), S, NOW);
    expect(p.ledger.items[0]!.state).toBe('unowned');
    expect(p.actions).toEqual([]);
    const later = planSweep(p.ledger, facts({ worktrees: [wt({ thread: null })] }), S, new Date('2026-12-01T00:00:00Z'));
    expect(later.actions).toEqual([]);
  });
  it('기한이 지나면 delete, 그 사이 새 턴이 오면 목록에서 뺀다', () => {
    const first = planSweep(emptyLedger(), facts(), S, NOW).ledger;
    const due = new Date('2026-10-14T00:00:00Z');
    expect(planSweep(first, facts(), S, due).actions).toEqual([{ op: 'delete', path: '/tmp/wt-a' }]);
    const revived = planSweep(first, facts({ lastTurnAt: new Map([['c1/r1', '2026-10-08T00:00:00.000Z']]) }), S, due);
    expect(revived.ledger.items).toEqual([]);
    expect(revived.ledger.events.at(-1)!.action).toBe('revived');
  });
  it('보존한 것은 기한이 지나도 지우지 않는다. 꺼져 있으면 넣지도 지우지도 않는다', () => {
    const first = planSweep(emptyLedger(), facts(), S, NOW).ledger;
    const kept = applyHumanAction(first, '/tmp/wt-a', 'keep', 'acct-1', S, NOW).ledger;
    expect(kept.items[0]).toMatchObject({ state: 'kept', actedBy: 'acct-1' });
    expect(planSweep(kept, facts(), S, new Date('2027-01-01T00:00:00Z')).actions).toEqual([]);
    expect(planSweep(emptyLedger(), facts(), { ...S, enabled: false }, NOW).ledger.items).toEqual([]);
  });
  it('주인 모름은 사람이 넣을 때만 listed 가 된다', () => {
    const p = planSweep(emptyLedger(), facts({ worktrees: [wt({ thread: null })] }), S, NOW).ledger;
    const r = applyHumanAction(p, '/tmp/wt-a', 'list', 'acct-1', S, NOW);
    expect(r.ledger.items[0]).toMatchObject({ state: 'listed', actedBy: 'acct-1' });
    expect(r.actions).toEqual([{ op: 'removeDeps', path: '/tmp/wt-a' }]);
    expect(() => applyHumanAction(p, '/tmp/wt-a', 'unkeep', 'a', S, NOW)).toThrow();
  });
});

describe('runSweep', () => {
  it('검사에 걸리면 지우지 않고 blocked + 이유', async () => {
    const first = planSweep(emptyLedger(), facts(), S, NOW).ledger;
    const plan = planSweep(first, facts(), S, new Date('2026-10-14T00:00:00Z'));
    let removed = 0;
    const out = await runSweep(plan, { check: async () => 'uncommitted', remove: async () => { removed++; }, size: async () => 1 }, new Set(), NOW);
    expect(removed).toBe(0);
    expect(out.items[0]).toMatchObject({ state: 'blocked', blockReason: 'uncommitted' });
    const ok = await runSweep(plan, { check: async () => null, remove: async () => { removed++; }, size: async () => 1 }, new Set(), NOW);
    expect(removed).toBe(1);
    expect(ok.items).toEqual([]);
    expect(ok.events.at(-1)!.action).toBe('deleted');
  });
});

describe('removeRebuildable', () => {
  it('심링크 node_modules 는 링크만 지우고 대상은 남긴다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'cleanup-'));
    const shared = join(d, 'shared-nm'); await mkdir(shared); await writeFile(join(shared, 'keep'), 'x');
    const root = join(d, 'wt'); await mkdir(join(root, 'dist'), { recursive: true });
    await symlink(shared, join(root, 'node_modules'));
    await writeFile(join(root, 'src.ts'), 'x');
    await removeRebuildable(root);
    await expect(lstat(join(root, 'node_modules'))).rejects.toThrow();
    await expect(lstat(join(root, 'dist'))).rejects.toThrow();
    expect((await stat(join(shared, 'keep'))).isFile()).toBe(true);
    expect((await stat(join(root, 'src.ts'))).isFile()).toBe(true);
  });
});

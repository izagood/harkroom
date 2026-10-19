import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyLedger, type CleanupItem, type CleanupLedger } from '@harkroom/shared/workspaceCleanup';
import { awaitingRunnerPaths, createWorkspaceCleanup } from '../src/workspaceCleanupService.js';
import { createCleanupOwners } from '../src/workspaceCleanupOwners.js';

const NOW = new Date('2026-10-19T00:00:00.000Z');
const thread = (n: string) => ({ channelId: 'c', threadRootId: n });
const item = (over: Partial<CleanupItem>): CleanupItem => ({
  path: '/x', kind: 'threadDir', state: 'listed', repo: null, branch: null, headSha: null, thread: thread('t1'), pr: null,
  lastModifiedAt: null, listedAt: '2026-10-10T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', blockReason: null,
  actedBy: null, actedAt: null, sizeBefore: null, sizeNow: null, ...over,
});
const ledgerOf = (items: CleanupItem[]): CleanupLedger => ({ ...emptyLedger(), items });
const owners = [
  { ...thread('t1'), agentId: 'off' }, { ...thread('t2'), agentId: 'live' }, { ...thread('t3'), agentId: 'off' },
  { ...thread('t4'), agentId: 'off' }, { ...thread('t5'), agentId: 'off' },
];

describe('러너 꺼짐 — 지우기 대기(기한 지난 스레드 폴더 + 주인 러너 없음)', () => {
  it('기한 지났고 주인 러너가 안 붙은 스레드 폴더만 고른다', () => {
    const ledger = ledgerOf([
      item({ path: '/off-due', thread: thread('t1') }),
      item({ path: '/live-due', thread: thread('t2') }),
      item({ path: '/off-later', thread: thread('t3'), deleteAfter: '2026-10-20T00:00:00.000Z' }),
      item({ path: '/off-kept', thread: thread('t4'), state: 'kept', deleteAfter: null }),
      item({ path: '/off-wt', thread: thread('t5'), kind: 'worktree' }),
      item({ path: '/no-owner', thread: thread('t9') }),
      item({ path: '/blocked', thread: thread('t1'), state: 'blocked', blockReason: 'turn-running' }),
    ]);
    expect(awaitingRunnerPaths(ledger, owners, new Set(['live']), NOW)).toEqual(['/off-due', '/blocked']);
  });

  it('기한이 바로 지금이면 지난 것으로 본다', () => {
    const ledger = ledgerOf([item({ path: '/p', deleteAfter: NOW.toISOString() })]);
    expect(awaitingRunnerPaths(ledger, owners, new Set(), NOW)).toEqual(['/p']);
  });

  it('view 는 원장 파일을 바꾸지 않고 싣고, 러너 연결을 모르면 칸을 싣지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cleanup-await-'));
    const ledgerPath = join(dir, 'ledger.json');
    const ownersPath = join(dir, 'owners.json');
    const configPath = join(dir, 'operator.json');
    await writeFile(ledgerPath, JSON.stringify(ledgerOf([item({ path: '/off-due' })])));
    await writeFile(ownersPath, JSON.stringify({ 'c/t1': { ...thread('t1'), agentId: 'off', worktrees: [], lastTurnAt: null } }));
    await writeFile(configPath, JSON.stringify({ communities: {}, cleanup: { enabled: true, graceDays: 7 } }));
    const base = {
      ledgerPath, configPath, owners: createCleanupOwners({ path: ownersPath }), agents: async () => [],
      forward: async () => ({ type: 'http.response' as const, id: '', status: 0, body: '' }),
      exec: async () => ({ code: 1, stdout: '', stderr: '' }), gitPath: 'git', ghPath: 'gh', ghEnv: {}, home: dir,
      now: () => NOW, log: () => {},
    };
    let live = new Set<string>();
    const withLink = createWorkspaceCleanup({ ...base, liveAgents: () => live });
    expect((await withLink.get()).awaitingRunner).toEqual(['/off-due']);
    live = new Set(['off']);
    expect((await withLink.get()).awaitingRunner).toEqual([]);
    const without = createWorkspaceCleanup(base);
    expect((await without.get()).awaitingRunner).toBeUndefined();
  });
});

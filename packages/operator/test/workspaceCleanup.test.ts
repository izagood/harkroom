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
    const out = await runSweep(plan, { check: async () => 'uncommitted', remove: async () => { removed++; }, size: async () => 1, removeDeps: async () => {} }, new Set(), NOW);
    expect(removed).toBe(0);
    expect(out.items[0]).toMatchObject({ state: 'blocked', blockReason: 'uncommitted' });
    const ok = await runSweep(plan, { check: async () => null, remove: async () => { removed++; }, size: async () => 1, removeDeps: async () => {} }, new Set(), NOW);
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
    await removeRebuildable(root, async () => true);
    await expect(lstat(join(root, 'node_modules'))).rejects.toThrow();
    await expect(lstat(join(root, 'dist'))).rejects.toThrow();
    expect((await stat(join(shared, 'keep'))).isFile()).toBe(true);
    expect((await stat(join(root, 'src.ts'))).isFile()).toBe(true);
  });
  it('safe 가 거짓이면 남긴다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'cleanup-'));
    await mkdir(join(d, 'build'));
    await removeRebuildable(d, async () => false);
    expect((await stat(join(d, 'build'))).isDirectory()).toBe(true);
  });
});

import { parsePrList, parseWorktreePorcelain, githubSlug, isThreadDone } from '../src/workspaceCleanupScan.js';
import { createCleanupOwners } from '../src/workspaceCleanupOwners.js';
import { worktreeAddPaths, readCleanupReport, CLEANUP_REPORT_PATH } from '@harkroom/shared/workspaceCleanup';

describe('관측 파서', () => {
  it('worktree porcelain — 첫 묶음이 main, detached 는 branch null', () => {
    const out = 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /tmp/wt-x\nHEAD bbb\ndetached\n\nworktree /tmp/wt-y\nHEAD ccc\nbranch refs/heads/feat/y\n';
    expect(parseWorktreePorcelain(out)).toEqual([
      { path: '/repo', head: 'aaa', branch: 'main', bare: false },
      { path: '/tmp/wt-x', head: 'bbb', branch: null, bare: false },
      { path: '/tmp/wt-y', head: 'ccc', branch: 'feat/y', bare: false },
    ]);
  });
  it('PR 목록 — 하나라도 열려 있으면 open', () => {
    expect(parsePrList('[{"number":3,"state":"MERGED","headRefOid":"x"},{"number":4,"state":"OPEN","headRefOid":"y"}]')).toEqual({ number: 4, state: 'open', headSha: 'y' });
    expect(parsePrList('[]')).toBeNull();
    expect(parsePrList('nope')).toBeNull();
  });
  it('github slug', () => {
    expect(githubSlug('https://github.com/izagood/harkroom.git\n')).toBe('izagood/harkroom');
    expect(githubSlug('git@github.com:izagood/harkroom.git')).toBe('izagood/harkroom');
    expect(githubSlug('https://example.com/x/y')).toBeNull();
  });
  it('세션 기록의 worktree add — 플래그를 건너뛰고, 변수 경로는 못 뽑는다', () => {
    expect(worktreeAddPaths('git -c core.hooksPath=/dev/null worktree add -q -b feat/x /tmp/wt-a origin/main', '/h')).toEqual(['/tmp/wt-a']);
    expect(worktreeAddPaths('worktree add --detach /private/tmp/wt-b abc', '/h')).toEqual(['/tmp/wt-b']);
    expect(worktreeAddPaths('worktree add ~/.harkroom-agent/wt/x', '/h')).toEqual(['/h/.harkroom-agent/wt/x']);
    expect(worktreeAddPaths('worktree add -b x "$W" origin/main', '/h')).toEqual([]);
  });
  it('스레드 ✅ — 루트의 statusReaction.status 가 done 일 때만, 못 읽으면 false', async () => {
    const ok = async () => ({ type: 'http.response' as const, id: '1', status: 200, body: JSON.stringify({ statusReaction: { status: 'done' } }) });
    const notDone = async () => ({ type: 'http.response' as const, id: '1', status: 200, body: JSON.stringify({ statusReaction: { status: 'waiting' } }) });
    const denied = async () => ({ type: 'http.response' as const, id: '1', status: 403, body: '{}' });
    expect(await isThreadDone(ok, 'a', 'r')).toBe(true);
    expect(await isThreadDone(notDone, 'a', 'r')).toBe(false);
    expect(await isThreadDone(denied, 'a', 'r')).toBe(false);
  });
});

describe('주인 장부(러너 보고)', () => {
  const C = '11111111-1111-1111-1111-111111111111';
  const R = '22222222-2222-2222-2222-222222222222';
  const req = (body: unknown) => ({ type: 'http.forward' as const, id: 'q', method: 'POST', path: CLEANUP_REPORT_PATH, body: JSON.stringify(body) });

  it('relay 로 온 보고만 받는다 — 브릿지(모델)는 403', async () => {
    const d = await mkdtemp(join(tmpdir(), 'owners-'));
    const o = createCleanupOwners({ path: join(d, 'owners.json') });
    const body = { threads: [{ channelId: C, threadRootId: R, worktrees: ['/private/tmp/wt-a'], lastTurnAt: '2026-10-06T00:00:00Z', running: true }] };
    expect((await o.maybeHandle('run1', 'agent1', req(body), 'bridge'))!).toMatchObject({ status: 403 });
    expect((await o.maybeHandle('run1', 'agent1', req(body), 'relay'))!).toMatchObject({ status: 200, body: JSON.stringify({ deleteThreads: [] }) });
    expect((await o.ownerOf()).get('/tmp/wt-a')).toMatchObject({ channelId: C, threadRootId: R, agentId: 'agent1' });
    expect(o.running().has(`${C}/${R}`)).toBe(true);
    o.releaseRunner('run1');
    expect(o.running().size).toBe(0);
    // 다시 떠도 파일에서 읽는다
    const o2 = createCleanupOwners({ path: join(d, 'owners.json') });
    expect((await o2.lastTurnAt()).get(`${C}/${R}`)).toBe('2026-10-06T00:00:00.000Z');
  });
  it('모양이 틀린 줄은 버린다', () => {
    expect(readCleanupReport({ threads: [{ channelId: 'x', threadRootId: R }, { channelId: C, threadRootId: R, worktrees: ['rel/path', '/abs'] }] }))
      .toEqual({ threads: [{ channelId: C, threadRootId: R, worktrees: ['/abs'], lastTurnAt: null, running: false, workspaceDir: null }] });
    expect(readCleanupReport(null)).toBeNull();
  });
  it('다른 경로는 건드리지 않는다', async () => {
    const o = createCleanupOwners({ path: '/nonexistent/owners.json' });
    expect(await o.maybeHandle('r', 'a', { type: 'http.forward', id: 'q', method: 'POST', path: '/agent/turn-slots', body: '{}' }, 'relay')).toBeNull();
  });
});

import { createCleanupPorts } from '../src/workspaceCleanupService.js';

describe('지우기 직전 검사', () => {
  const base = {
    path: '/tmp/wt-a', kind: 'worktree' as const, state: 'listed' as const, repo: '/repo', branch: 'b', headSha: 'h1',
    thread: { channelId: 'c', threadRootId: 'r' }, pr: { number: 1, state: 'merged' as const, headSha: 'h9' },
    lastModifiedAt: null, listedAt: null, deleteAfter: null, blockReason: null, actedBy: null, actedAt: null, sizeBefore: null, sizeNow: null,
  };
  const FRESH = { 'rev-parse HEAD': { code: 0, stdout: 'h1\n' }, 'symbolic-ref -q': { code: 0, stdout: 'b\n' } };
  const ports = (replies: Record<string, { code: number; stdout: string }>) => {
    const calls: string[][] = [];
    const all: Record<string, { code: number; stdout: string }> = { ...FRESH, ...replies };
    const exec = async (_f: string, args: string[]) => { calls.push(args); const k = args.slice(2, 4).join(' '); return { stderr: '', ...(all[k] ?? { code: 1, stdout: '' }) }; };
    return { calls, p: createCleanupPorts({ exec, gitPath: '/usr/bin/git', ghPath: '/gh', ghEnv: {}, home: '/h' }) };
  };
  it('도는 턴 → turn-running(git 을 부르지도 않는다)', async () => {
    const { p, calls } = ports({});
    expect(await p.check(base, new Set(['c/r']))).toBe('turn-running');
    expect(calls).toEqual([]);
  });
  it('변경이 있으면 uncommitted', async () => {
    expect(await ports({ 'status --porcelain': { code: 0, stdout: ' M a.ts\n' } }).p.check(base, new Set())).toBe('uncommitted');
  });
  it('원격에도 PR head 에도 없으면 unpushed, PR head 의 조상이면 통과', async () => {
    expect(await ports({ 'status --porcelain': { code: 0, stdout: '' }, 'branch -r': { code: 0, stdout: '' } }).p.check(base, new Set())).toBe('unpushed');
    expect(await ports({ 'status --porcelain': { code: 0, stdout: '' }, 'branch -r': { code: 0, stdout: '' }, 'merge-base --is-ancestor': { code: 0, stdout: '' } }).p.check(base, new Set())).toBeNull();
    expect(await ports({ 'status --porcelain': { code: 0, stdout: '' } }).p.check({ ...base, pr: { ...base.pr, headSha: 'h1' } }, new Set())).toBeNull();
  });
  it('스캔 뒤 커밋이 더 생겼으면(HEAD 가 원장과 다르면) PR head 와 같아 보여도 unpushed', async () => {
    const pushedLooking = { ...base, pr: { ...base.pr, headSha: 'h1' } };
    expect(await ports({ 'status --porcelain': { code: 0, stdout: '' }, 'rev-parse HEAD': { code: 0, stdout: 'h2\n' } }).p.check(pushedLooking, new Set())).toBe('unpushed');
    expect(await ports({ 'status --porcelain': { code: 0, stdout: '' }, 'symbolic-ref -q': { code: 0, stdout: 'other\n' } }).p.check(pushedLooking, new Set())).toBe('unpushed');
  });
  it('지우기는 --force 없이 worktree remove, 브랜치는 검사한 커밋 그대로일 때만', async () => {
    const { p, calls } = ports({ 'worktree remove': { code: 0, stdout: '' } });
    await p.remove(base);
    expect(calls[0]).toEqual(['-C', '/repo', 'worktree', 'remove', '/tmp/wt-a']);
    expect(calls[1]).toEqual(['-C', '/repo', 'update-ref', '-d', 'refs/heads/b', 'h1']);
  });
});

import { execFileSync } from 'node:child_process';
import { defaultExec } from '../src/turnMerge.js';

describe('의존성 폴더 지우기 — 무시되고 올려 둔 파일이 없는 폴더만 (실제 git)', () => {
  it('무시되는 dist·node_modules 는 지우고, 올려 둔 build·무시 안 된 target 은 남긴다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'cleanup-git-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    await writeFile(join(d, '.gitignore'), 'dist/\nnode_modules/\nbuild/\n');
    for (const n of ['dist', 'node_modules', 'build', 'target']) { await mkdir(join(d, n)); await writeFile(join(d, n, 'f'), 'x'); }
    git('add', '-f', 'build/f', '.gitignore');
    const p = createCleanupPorts({ exec: defaultExec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: process.env.HOME ?? '/' });
    await p.removeDeps(d);
    await expect(lstat(join(d, 'dist'))).rejects.toThrow();
    await expect(lstat(join(d, 'node_modules'))).rejects.toThrow();
    expect((await stat(join(d, 'build', 'f'))).isFile()).toBe(true);   // 올려 둔 파일이 있다
    expect((await stat(join(d, 'target', 'f'))).isFile()).toBe(true);  // 무시되지 않는다
  });
  it('심링크 node_modules 는 올라가 있지 않으면 링크만 지운다(`node_modules/` 규칙이 안 맞아도) — 대상은 남는다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'cleanup-git-'));
    const shared = await mkdtemp(join(tmpdir(), 'shared-nm-'));
    await writeFile(join(shared, 'keep'), 'x');
    const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    await writeFile(join(d, '.gitignore'), 'node_modules/\n');
    await symlink(shared, join(d, 'node_modules'));
    const p = createCleanupPorts({ exec: defaultExec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: process.env.HOME ?? '/' });
    await p.removeDeps(d);
    await expect(lstat(join(d, 'node_modules'))).rejects.toThrow();
    expect((await stat(join(shared, 'keep'))).isFile()).toBe(true);
  });
  it('올려 둔 심링크는 남긴다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'cleanup-git-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    await symlink('/tmp', join(d, 'dist'));
    git('add', 'dist');
    const p = createCleanupPorts({ exec: defaultExec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: process.env.HOME ?? '/' });
    await p.removeDeps(d);
    expect((await lstat(join(d, 'dist'))).isSymbolicLink()).toBe(true);
  });
});

describe('보고 — 미래 시각은 지금으로 자른다', () => {
  it('lastTurnAt', () => {
    const C = '11111111-1111-1111-1111-111111111111';
    const r = readCleanupReport({ threads: [{ channelId: C, threadRootId: C, lastTurnAt: '2999-01-01T00:00:00Z' }] }, Date.parse('2026-10-06T00:00:00Z'));
    expect(r!.threads[0]!.lastTurnAt).toBe('2026-10-06T00:00:00.000Z');
  });
});

describe('스레드 폴더 지우기는 러너에게 맡긴다(규칙 6)', () => {
  const C = '11111111-1111-1111-1111-111111111111';
  const R = '33333333-3333-3333-3333-333333333333';
  const req = (body: unknown) => ({ type: 'http.forward' as const, id: 'q', method: 'POST', path: CLEANUP_REPORT_PATH, body: JSON.stringify(body) });
  it('요청한 스레드만 그 에이전트의 답에 싣고, 요청한 것만 "지웠다"를 받는다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'owners-'));
    const o = createCleanupOwners({ path: join(d, 'owners.json') });
    const t = { channelId: C, threadRootId: R, worktrees: [], lastTurnAt: '2026-09-01T00:00:00Z', running: false, workspaceDir: '/state/workspaces/x' };
    await o.maybeHandle('run1', 'agentA', req({ threads: [t] }), 'relay');
    // 다른 에이전트가 같은 스레드의 작업 폴더를 바꾸려 해도 안 바뀐다
    await o.maybeHandle('run2', 'agentB', req({ threads: [{ ...t, workspaceDir: '/elsewhere' }] }), 'relay');
    expect((await o.threads())[0]!.workspaceDir).toBe('/state/workspaces/x');
    // 요청 전에 "지웠다"고 해도 받지 않는다
    await o.maybeHandle('run1', 'agentA', req({ threads: [], deleted: [{ channelId: C, threadRootId: R }] }), 'relay');
    expect(o.drainDeleted()).toEqual([]);
    o.requestDelete({ channelId: C, threadRootId: R });
    const other = await o.maybeHandle('run2', 'agentB', req({ threads: [] }), 'relay');
    expect(JSON.parse((other as { body: string }).body)).toEqual({ deleteThreads: [] });
    const mine = await o.maybeHandle('run1', 'agentA', req({ threads: [] }), 'relay');
    expect(JSON.parse((mine as { body: string }).body)).toEqual({ deleteThreads: [{ channelId: C, threadRootId: R }] });
    await o.maybeHandle('run1', 'agentA', req({ threads: [], deleted: [{ channelId: C, threadRootId: R }] }), 'relay');
    expect(o.drainDeleted()).toEqual([{ thread: { channelId: C, threadRootId: R }, path: '/state/workspaces/x' }]);
    expect((await o.threads())[0]!.workspaceDir).toBeNull();
  });
});

describe('F1 — 지우기 요청은 되살리기·보존으로 거둔다', () => {
  const C = '11111111-1111-1111-1111-111111111111';
  const R = '44444444-4444-4444-4444-444444444444';
  const req = (body: unknown) => ({ type: 'http.forward' as const, id: 'q', method: 'POST', path: CLEANUP_REPORT_PATH, body: JSON.stringify(body) });
  const reply = (r: unknown) => JSON.parse((r as { body: string }).body) as { deleteThreads: unknown[] };
  const T0 = { channelId: C, threadRootId: R, worktrees: [], lastTurnAt: '2026-09-01T00:00:00Z', running: false, workspaceDir: '/state/workspaces/y' };
  const fresh = async () => {
    const d = await mkdtemp(join(tmpdir(), 'owners-'));
    let now = new Date('2026-10-06T00:00:00Z');
    const o = createCleanupOwners({ path: join(d, 'owners.json'), now: () => now });
    await o.maybeHandle('run1', 'agentA', req({ threads: [T0] }), 'relay');
    o.requestDelete({ channelId: C, threadRootId: R });
    return { o, tick: (iso: string) => { now = new Date(iso); } };
  };
  it('요청 → 새 턴(도는 중) → 턴 끝 보고 — 지우기가 나가지 않는다', async () => {
    const { o } = await fresh();
    const during = await o.maybeHandle('run1', 'agentA', req({ threads: [{ ...T0, lastTurnAt: '2026-10-06T00:05:00Z', running: true }] }), 'relay');
    expect(reply(during).deleteThreads).toEqual([]);
    const after = await o.maybeHandle('run1', 'agentA', req({ threads: [{ ...T0, lastTurnAt: '2026-10-06T00:10:00Z', running: false }] }), 'relay');
    expect(reply(after).deleteThreads).toEqual([]);
    const later = await o.maybeHandle('run1', 'agentA', req({ threads: [] }), 'relay');
    expect(reply(later).deleteThreads).toEqual([]);
  });
  it('다른 러너가 그 스레드를 돌리는 중이면 답에 싣지 않는다', async () => {
    const { o } = await fresh();
    await o.maybeHandle('run2', 'agentA', req({ threads: [{ ...T0, lastTurnAt: null, running: true }] }), 'relay');
    expect(reply(await o.maybeHandle('run1', 'agentA', req({ threads: [] }), 'relay')).deleteThreads).toEqual([]);
  });
  it('보존(cancelDelete)·원장에서 빠짐(retainDeletes)이면 거둔다, 아니면 나간다', async () => {
    const a = await fresh();
    a.o.cancelDelete({ channelId: C, threadRootId: R });
    expect(reply(await a.o.maybeHandle('run1', 'agentA', req({ threads: [] }), 'relay')).deleteThreads).toEqual([]);
    const b = await fresh();
    b.o.retainDeletes(new Set());
    expect(reply(await b.o.maybeHandle('run1', 'agentA', req({ threads: [] }), 'relay')).deleteThreads).toEqual([]);
    const c = await fresh();
    c.o.retainDeletes(new Set([`${C}/${R}`]));
    expect(reply(await c.o.maybeHandle('run1', 'agentA', req({ threads: [] }), 'relay')).deleteThreads).toEqual([{ channelId: C, threadRootId: R }]);
  });
});

describe('live — 화면이 그리는 그 순간 상태(「지우는 중」·러너 꺼짐·주인 보고 전)', () => {
  const C = '11111111-1111-1111-1111-111111111111';
  const R = '55555555-5555-5555-5555-555555555555';
  const K = `${C}/${R}`;
  const req = (body: unknown) => ({ type: 'http.forward' as const, id: 'q', method: 'POST', path: CLEANUP_REPORT_PATH, body: JSON.stringify(body) });
  const T0 = { channelId: C, threadRootId: R, worktrees: [], lastTurnAt: '2026-09-01T00:00:00Z', running: false, workspaceDir: '/state/workspaces/z' };
  it('보고 전엔 ownersReported=false, 보고 뒤엔 스레드 폴더마다 연결·요청 시각이 실린다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'owners-'));
    const now = new Date('2026-10-06T00:00:00Z');
    const o = createCleanupOwners({ path: join(d, 'owners.json'), now: () => now });
    expect(await o.live()).toEqual({ threads: {}, ownersReported: false });
    await o.maybeHandle('run1', 'agentA', req({ threads: [T0] }), 'relay');
    expect((await o.live()).threads[K]).toEqual({ deleteRequestedAt: null, runnerConnected: true });
    o.requestDelete({ channelId: C, threadRootId: R });
    expect((await o.live()).threads[K]).toEqual({ deleteRequestedAt: '2026-10-06T00:00:00.000Z', runnerConnected: true });
    // 러너가 죽으면 연결은 끊기지만 요청은 남는다 — 화면은 「러너 꺼짐 미룸」으로 그린다.
    o.releaseRunner('run1');
    expect((await o.live()).threads[K]).toEqual({ deleteRequestedAt: '2026-10-06T00:00:00.000Z', runnerConnected: false });
    expect((await o.live()).ownersReported).toBe(true);
    // 「보존」은 요청을 거둔다 — 「지우는 중」이 사라진다.
    o.cancelDelete({ channelId: C, threadRootId: R });
    expect((await o.live()).threads[K]!.deleteRequestedAt).toBeNull();
  });
  it('다른 에이전트의 러너가 붙어 있어도 그 스레드 폴더 주인의 러너가 아니면 연결로 치지 않는다', async () => {
    const d = await mkdtemp(join(tmpdir(), 'owners-'));
    const o = createCleanupOwners({ path: join(d, 'owners.json') });
    await o.maybeHandle('run1', 'agentA', req({ threads: [T0] }), 'relay');
    o.releaseRunner('run1');
    await o.maybeHandle('run2', 'agentB', req({ threads: [] }), 'relay');
    expect((await o.live()).threads[K]!.runnerConnected).toBe(false);
  });
});

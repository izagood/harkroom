import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEANUP_REPORT_PATH, type CleanupLedger } from '@harkroom/shared/workspaceCleanup';
import { defaultExec, type Exec } from '../src/turnMerge.js';
import { createCleanupOwners } from '../src/workspaceCleanupOwners.js';
import { lastActivityAt, onlyRebuildableIgnored, prHeadIsOurs, repoOfWorktree } from '../src/workspaceCleanupScan.js';
import { createCleanupPorts, createWorkspaceCleanup } from '../src/workspaceCleanupService.js';

const C = '11111111-1111-1111-1111-111111111111';
const R = (n: number) => `3333333${n}-3333-3333-3333-333333333333`;
const req = (body: unknown) => ({ type: 'http.forward' as const, id: 'q', method: 'POST', path: CLEANUP_REPORT_PATH, body: JSON.stringify(body) });

/** 실제 git 저장소 하나 + worktree 셋(머지·미커밋·닫힘). gh 만 가짜다. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cleanup-repos-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  // 같은 브랜치 이름의 옛 머지 PR — 그 head 는 지금 worktree 의 조상이 아니다(security n1).
  git(repo, 'checkout', '-q', '-b', 'old-work');
  await writeFile(join(repo, 'old.txt'), 'old');
  git(repo, 'add', 'old.txt');
  git(repo, 'commit', '-q', '-m', 'old work');
  const oldHead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  const wt = { merged: join(root, 'wt-merged'), dirty: join(root, 'wt-dirty'), closed: join(root, 'wt-closed'), reused: join(root, 'wt-reused') };
  for (const [b, p] of Object.entries(wt)) git(repo, 'worktree', 'add', '-q', '-b', b, p);
  await mkdir(join(wt.merged, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(wt.merged, 'node_modules', 'x', 'i.js'), '');
  await writeFile(join(wt.dirty, 'wip.txt'), 'not committed');
  const head = git(repo, 'rev-parse', 'HEAD');
  const exec: Exec = async (file, args, env) => {
    if (file !== '/gh') return defaultExec(file, args, env);
    const branch = args[args.indexOf('--head') + 1];
    const state = branch === 'closed' ? 'CLOSED' : 'MERGED';
    return { code: 0, stdout: JSON.stringify([{ number: 7, state, headRefOid: branch === 'reused' ? oldHead : head }]), stderr: '' };
  };
  return { root, repo, wt, exec, head, oldHead };
}

describe('저장소는 러너가 보고한 worktree 에서 찾는다(workingDir 이 없어도)', () => {
  it('worktree → main worktree 경로. 사라진 경로·git 아닌 폴더는 null', async () => {
    const f = await fixture();
    const deps = { exec: f.exec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: f.root };
    expect(await repoOfWorktree(deps, f.wt.merged)).toBe(f.repo);
    expect(await repoOfWorktree(deps, f.repo)).toBe(f.repo);
    expect(await repoOfWorktree(deps, join(f.root, 'gone'))).toBeNull();
    await mkdir(join(f.root, 'plain'));
    expect(await repoOfWorktree(deps, join(f.root, 'plain'))).toBeNull();
  });

  it('PR head 는 worktree head 와 같거나 그 조상이어야 그 worktree 의 PR 이다', async () => {
    const f = await fixture();
    const deps = { exec: f.exec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: f.root };
    await writeFile(join(f.wt.merged, 'more.txt'), 'x');
    execFileSync('git', ['-C', f.wt.merged, 'add', 'more.txt']);
    execFileSync('git', ['-C', f.wt.merged, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'more']);
    const ahead = execFileSync('git', ['-C', f.wt.merged, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(await prHeadIsOurs(deps, f.wt.merged, f.head, f.head)).toBe(true);
    expect(await prHeadIsOurs(deps, f.wt.merged, f.head, ahead)).toBe(true); // PR head 가 조상
    expect(await prHeadIsOurs(deps, f.wt.merged, ahead, f.head)).toBe(false); // PR head 가 더 앞(이 worktree 의 것이 아님)
    expect(await prHeadIsOurs(deps, f.wt.reused, f.oldHead, f.head)).toBe(false); // 옆 갈래 — 옛 PR
    expect(await prHeadIsOurs(deps, f.wt.merged, 'f'.repeat(40), f.head)).toBe(false); // 로컬에 없는 커밋
    expect(await prHeadIsOurs(deps, f.wt.merged, null, f.head)).toBe(false);
  });

  it('한 바퀴: 넣기 + 의존성 지우기 → 기한 뒤 지우기, 미커밋은 ⚠ 보류', async () => {
    const f = await fixture();
    const owners = createCleanupOwners({ path: join(f.root, 'owners.json') });
    const t = (n: number, worktrees: string[]) => ({ channelId: C, threadRootId: R(n), worktrees, lastTurnAt: '2026-09-01T00:00:00Z', running: false });
    await owners.maybeHandle('run1', 'agentA', req({ threads: [
      t(1, [f.wt.merged, join(f.root, 'wt-gone')]), t(2, [f.wt.dirty]), t(3, [f.wt.closed]), t(4, [f.wt.reused]),
    ] }), 'relay');
    const configPath = join(f.root, 'operator.json');
    await writeFile(configPath, JSON.stringify({ communities: {}, cleanup: { enabled: true, graceDays: 7 } }));
    const ledgerPath = join(f.root, 'ledger.json');
    let now = new Date('2026-10-06T00:00:00Z');
    const cleanup = createWorkspaceCleanup({
      ledgerPath, configPath, owners,
      agents: async () => [{ agentId: 'agentA', workingDir: null }],
      forward: async (_a, r) => ({ type: 'http.response', id: r.id, status: 200, body: JSON.stringify({ statusReaction: { status: 'done' } }) }),
      exec: f.exec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: f.root,
      now: () => now, log: () => {},
    });
    const ledger = async () => JSON.parse(await readFile(ledgerPath, 'utf8')) as CleanupLedger;
    const byPath = (l: CleanupLedger) => Object.fromEntries(l.items.map((i) => [i.path, i]));

    await cleanup.sweep();
    const first = byPath(await ledger());
    // 브랜치 이름이 옛 머지 PR 과 같은 worktree 는 그 PR head 가 조상이 아니라 PR 모름 → 올리지 않는다(security n1).
    expect(Object.keys(first).sort()).toEqual([f.wt.closed, f.wt.dirty, f.wt.merged].sort());
    for (const i of Object.values(first)) expect(i).toMatchObject({ kind: 'worktree', state: 'listed', repo: f.repo });
    // 규칙: 넣을 때 무시되는 node_modules 는 바로 지운다
    expect(await lstat(join(f.wt.merged, 'node_modules')).catch(() => null)).toBeNull();

    now = new Date('2026-10-14T00:00:00Z');
    await cleanup.sweep();
    const second = await ledger();
    expect(await lstat(f.wt.merged).catch(() => null)).toBeNull();
    expect(await lstat(f.wt.closed).catch(() => null)).toBeNull();
    expect(second.items).toEqual([expect.objectContaining({ path: f.wt.dirty, state: 'blocked', blockReason: 'uncommitted' })]);
    expect(await lstat(join(f.wt.dirty, 'wip.txt'))).toBeTruthy();
    expect(await lstat(f.wt.reused)).toBeTruthy();
    expect(second.events.filter((e) => e.action === 'deleted').map((e) => e.path).sort()).toEqual([f.wt.closed, f.wt.merged].sort());
  });

  it('손댄 시각: reflog(checkout·reset)도 센다 · 무시된 파일은 다시 만들 수 있는 폴더 안에만 있어야 한다', async () => {
    const f = await fixture();
    const deps = { exec: f.exec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: f.root };
    const gitDir = execFileSync('git', ['-C', f.wt.closed, 'rev-parse', '--path-format=absolute', '--git-dir'], { encoding: 'utf8' }).trim();
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(join(f.wt.closed, '.git'), old, old);
    await utimes(join(gitDir, 'logs', 'HEAD'), old, old);
    const before = await lastActivityAt(deps, f.wt.closed); // 커밋 시각만 남는다(방금 만든 커밋)
    const future = new Date(Math.floor((Date.now() + 5 * 86_400_000) / 1000) * 1000); // 초 단위(파일 시각 반올림을 피한다)
    await utimes(join(gitDir, 'logs', 'HEAD'), future, future); // checkout·reset 이 reflog 를 쓴 것과 같다
    expect(await lastActivityAt(deps, f.wt.closed)).toBe(future.toISOString());
    expect(before! < future.toISOString()).toBe(true);
    // 무시된 것: node_modules(깊이 무관) 는 된다, .env 는 안 된다
    expect(await onlyRebuildableIgnored(deps, f.wt.merged)).toBe(true);
    await mkdir(join(f.wt.closed, 'pkg', 'node_modules', 'x'), { recursive: true });
    await writeFile(join(f.wt.closed, 'pkg', 'node_modules', 'x', 'i.js'), '');
    expect(await onlyRebuildableIgnored(deps, f.wt.closed)).toBe(true);
    await writeFile(join(f.wt.closed, '.gitignore-local'), '');
    execFileSync('git', ['-C', f.wt.closed, 'config', 'core.excludesFile', join(f.wt.closed, '.gitignore-local')]);
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), '.env\n.gitignore-local\n');
    await writeFile(join(f.wt.closed, '.env'), 'SECRET=1');
    expect(await onlyRebuildableIgnored(deps, f.wt.closed)).toBe(false);
    expect(await onlyRebuildableIgnored(deps, join(f.root, 'gone'))).toBe(false);
    // n6: 가운데 마디만 다시 만들 수 있는 이름인 손 파일 — `*.key` 규칙의 src/target/secret.key 는 안 된다
    await writeFile(join(f.repo, '.git', 'info', 'exclude'), '*.key\n');
    await mkdir(join(f.wt.merged, 'src', 'target'), { recursive: true });
    await writeFile(join(f.wt.merged, 'src', 'target', 'secret.key'), 'k');
    expect(await onlyRebuildableIgnored(deps, f.wt.merged)).toBe(false);
  });

  it('n3: 저장소가 status.showUntrackedFiles=no 여도 지우기 직전 검사는 untracked 를 본다', async () => {
    const f = await fixture();
    execFileSync('git', ['-C', f.repo, 'config', 'status.showUntrackedFiles', 'no']);
    await writeFile(join(f.wt.closed, 'notes.txt'), 'hand-written');
    const ports = createCleanupPorts({ exec: f.exec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: f.root });
    const item = { path: f.wt.closed, kind: 'worktree' as const, state: 'listed' as const, repo: f.repo, branch: 'closed', headSha: f.head, thread: null,
      pr: { number: 7, state: 'closed' as const, headSha: f.head }, lastModifiedAt: null, listedAt: null, deleteAfter: null, blockReason: null,
      actedBy: null, actedAt: null, sizeBefore: null, sizeNow: null };
    expect(await ports.check(item, new Set())).toBe('uncommitted');
  });

  it('F1(실제 git): 주인 모름을 넣은 뒤 새 커밋+push → 기한이 지나도 지우지 않고 되살린다', async () => {
    const f = await fixture();
    const owners = createCleanupOwners({ path: join(f.root, 'owners.json') });
    const configPath = join(f.root, 'operator.json');
    await writeFile(configPath, JSON.stringify({ communities: {}, cleanup: { enabled: true, graceDays: 7 } }));
    const ledgerPath = join(f.root, 'ledger.json');
    const DAY = 86_400_000;
    let now = new Date(Date.now() + 10 * DAY);
    const cleanup = createWorkspaceCleanup({
      ledgerPath, configPath, owners,
      agents: async () => [{ agentId: 'agentA', workingDir: f.repo }],
      forward: async () => { throw new Error('주인 모름은 스레드를 묻지 않는다'); },
      exec: f.exec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: f.root,
      now: () => now, log: () => {},
    });
    const ledger = async () => JSON.parse(await readFile(ledgerPath, 'utf8')) as CleanupLedger;
    await cleanup.sweep();
    expect((await ledger()).items.find((i) => i.path === f.wt.merged)).toMatchObject({ state: 'listed', actedBy: null });
    // 누가 그 worktree 에서 일을 다시 한다 — 새 커밋을 만들고 원격에 올렸다(원격 ref 로 흉내).
    await writeFile(join(f.wt.merged, 'again.txt'), 'work');
    execFileSync('git', ['-C', f.wt.merged, 'add', 'again.txt']);
    execFileSync('git', ['-C', f.wt.merged, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'again']);
    const newHead = execFileSync('git', ['-C', f.wt.merged, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', f.repo, 'update-ref', 'refs/remotes/origin/merged', newHead]);
    now = new Date(Date.now() + 20 * DAY); // 기한(넣은 뒤 7일)을 넘겼다
    await cleanup.sweep();
    expect(await lstat(join(f.wt.merged, 'again.txt'))).toBeTruthy();
    const l = await ledger();
    expect(l.events.some((e) => e.path === f.wt.merged && e.action === 'revived')).toBe(true);
    expect(l.events.some((e) => e.path === f.wt.merged && e.action === 'deleted')).toBe(false);
  });

  it('주인 모름 자동: 보고 없는 worktree 도 머지·닫힘 + PR head == HEAD + 깨끗 + 오래 손 안 댐이면 넣고 지운다', async () => {
    const f = await fixture();
    const owners = createCleanupOwners({ path: join(f.root, 'owners.json') }); // 러너 보고 없음 — 전부 주인 모름
    const configPath = join(f.root, 'operator.json');
    await writeFile(configPath, JSON.stringify({ communities: {}, cleanup: { enabled: true, graceDays: 7 } }));
    const ledgerPath = join(f.root, 'ledger.json');
    const DAY = 86_400_000;
    let now = new Date(Date.now() + 3 * DAY); // 방금 만든 worktree 들 — 보존 기간(7일) 안
    const cleanup = createWorkspaceCleanup({
      ledgerPath, configPath, owners,
      agents: async () => [{ agentId: 'agentA', workingDir: f.repo }], // 저장소는 workingDir 로 안다(main worktree 는 후보 아님)
      forward: async () => { throw new Error('주인 모름은 스레드를 묻지 않는다'); },
      exec: f.exec, gitPath: 'git', ghPath: '/gh', ghEnv: {}, home: f.root,
      now: () => now, log: () => {},
    });
    const ledger = async () => JSON.parse(await readFile(ledgerPath, 'utf8')) as CleanupLedger;
    const states = async () => Object.fromEntries((await ledger()).items.map((i) => [i.path, i.state]));

    await cleanup.sweep();
    expect(await states()).toEqual({ [f.wt.merged]: 'unowned', [f.wt.closed]: 'unowned', [f.wt.dirty]: 'unowned', [f.wt.reused]: 'unowned' });
    expect(await lstat(join(f.wt.merged, 'node_modules'))).toBeTruthy();

    now = new Date(Date.now() + 10 * DAY); // 이제 7일보다 오래 손대지 않았다
    await cleanup.sweep();
    // 미커밋(dirty)·옛 머지 PR(reused, PR 모름)은 그대로 주인 모름
    expect(await states()).toEqual({ [f.wt.merged]: 'listed', [f.wt.closed]: 'listed', [f.wt.dirty]: 'unowned', [f.wt.reused]: 'unowned' });
    for (const i of (await ledger()).items.filter((x) => x.state === 'listed')) expect(i).toMatchObject({ thread: null, actedBy: null });
    expect(await lstat(join(f.wt.merged, 'node_modules')).catch(() => null)).toBeNull();

    now = new Date(Date.now() + 18 * DAY);
    await cleanup.sweep();
    expect(await lstat(f.wt.merged).catch(() => null)).toBeNull();
    expect(await lstat(f.wt.closed).catch(() => null)).toBeNull();
    expect(await lstat(join(f.wt.dirty, 'wip.txt'))).toBeTruthy();
    expect(await states()).toEqual({ [f.wt.dirty]: 'unowned', [f.wt.reused]: 'unowned' });
  });
});

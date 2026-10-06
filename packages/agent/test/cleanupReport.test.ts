import { mkdtemp, mkdir, symlink, writeFile, lstat, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeProjectDirName, type CleanupReport } from '@harkroom/shared/workspaceCleanup';
import { commandTexts, createCleanupReporter, deleteThread, hasOpaqueWorktreeAdd, isInsideRoot } from '../src/cleanupReport.js';

const bash = (command: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const said = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });

const C = '11111111-1111-1111-1111-111111111111';
const R = '22222222-2222-2222-2222-222222222222';
const KEY = `${C}/${R}`;

describe('n5 — 지우기 전에 상태 루트 아래인지', () => {
  it('루트 아래 폴더만 참, 심링크·바깥·루트 자신은 거짓', async () => {
    const d = await mkdtemp(join(tmpdir(), 'n5-'));
    const root = join(d, 'workspaces'); await mkdir(join(root, 'a'), { recursive: true });
    const outside = join(d, 'outside'); await mkdir(outside);
    await symlink(outside, join(root, 'link'));
    expect(await isInsideRoot(root, join(root, 'a'))).toBe(true);
    expect(await isInsideRoot(root, join(root, 'link'))).toBe(false);
    expect(await isInsideRoot(root, outside)).toBe(false);
    expect(await isInsideRoot(root, join(root, 'a', '..', '..', 'outside'))).toBe(false);
    expect(await isInsideRoot(root, root)).toBe(false);
  });
});

describe('deleteThread', () => {
  const setup = async () => {
    const d = await mkdtemp(join(tmpdir(), 'del-'));
    const base = join(d, 'workspaces'); const ws = join(base, 'thread-1'); await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'f'), 'x');
    const projects = join(d, 'acct', 'projects'); const proj = join(projects, claudeProjectDirName(ws));
    await mkdir(join(proj, 'memory'), { recursive: true }); await writeFile(join(proj, 'memory', 'm.md'), 'keep');
    await writeFile(join(proj, 's.jsonl'), '{}'); await mkdir(join(proj, 's')); await writeFile(join(proj, 's', 't'), 'x');
    const forgot: string[] = [];
    return { d, base, ws, proj, forgot, deps: (wsDir: string) => ({
      workspaceBaseDir: base, claudeProjectRoots: async () => [projects],
      sessionOf: (k: string) => (k === KEY ? { workspaceDir: wsDir } : undefined), forget: async (k: string) => { forgot.push(k); },
    }) };
  };
  it('작업 폴더·세션 기록을 지우고 memory/ 는 남기고 레코드를 뺀다', async () => {
    const s = await setup();
    expect(await deleteThread(s.deps(s.ws), { channelId: C, threadRootId: R })).toBe('deleted');
    await expect(lstat(s.ws)).rejects.toThrow();
    expect(await readdir(s.proj)).toEqual(['memory']);
    expect((await stat(join(s.proj, 'memory', 'm.md'))).isFile()).toBe(true);
    expect(s.forgot).toEqual([KEY]);
  });
  it('작업 폴더가 상태 루트 밖이면 아무것도 지우지 않는다', async () => {
    const s = await setup();
    const out = join(s.d, 'elsewhere'); await mkdir(out); await writeFile(join(out, 'f'), 'x');
    expect(await deleteThread(s.deps(out), { channelId: C, threadRootId: R })).toBe('refused');
    expect((await stat(join(out, 'f'))).isFile()).toBe(true);
    expect(s.forgot).toEqual([]);
  });
  it('레코드가 없으면 absent — "지웠다"가 아니다(다른 러너 인스턴스)', async () => {
    const s = await setup();
    expect(await deleteThread({ ...s.deps(s.ws), sessionOf: () => undefined }, { channelId: C, threadRootId: R })).toBe('absent');
  });
});

describe('reporter — worktree 주인', () => {
  const make = (lists: string[][], transcripts: Record<string, string> = {}) => {
    const sent: CleanupReport[] = [];
    let call = 0;
    const r = createCleanupReporter({
      send: async (rep) => { sent.push(rep); return { deleteThreads: [] }; },
      listWorktrees: async () => lists[Math.min(call++, lists.length - 1)]!,
      home: '/h', now: () => new Date('2026-10-06T00:00:00Z'),
    });
    return { r, sent, transcripts };
  };
  it('기록에 그대로 적힌 경로가 지금 worktree 면 그 스레드 것', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rep-'));
    const t = join(d, 't.jsonl'); await writeFile(t, [bash('git worktree add -b x /tmp/wt-a origin/main'), said('예: git worktree add /tmp/wt-other x')].join('\n'));
    const { r, sent } = make([['/repo'], ['/repo', '/tmp/wt-a', '/tmp/wt-other']]);
    await r.turnStarted(KEY, { repo: '/repo', workspaceDir: '/ws' });
    await r.turnEnded(KEY, [t]);
    expect(sent.at(-1)!.threads[0]).toMatchObject({ worktrees: ['/tmp/wt-a'], running: false, workspaceDir: '/ws' });
  });
  it('변수 경로 + 새 worktree 하나 + 겹친 턴 없음 → 그것, 겹쳤으면 주인 모름', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rep-'));
    const t = join(d, 't.jsonl'); await writeFile(t, bash('git worktree add -b x "$W" origin/main'));
    expect(hasOpaqueWorktreeAdd('worktree add -b x "$W"', '/h')).toBe(true);
    const a = make([['/repo'], ['/repo', '/tmp/wt-v']]);
    await a.r.turnStarted(KEY, { repo: '/repo', workspaceDir: null });
    await a.r.turnEnded(KEY, [t]);
    expect(a.sent.at(-1)!.threads[0]!.worktrees).toEqual(['/tmp/wt-v']);
    const b = make([['/repo'], ['/repo'], ['/repo', '/tmp/wt-v']]);
    const K2 = `${C}/33333333-3333-3333-3333-333333333333`;
    await b.r.turnStarted(KEY, { repo: '/repo', workspaceDir: null });
    await b.r.turnStarted(K2, { repo: '/repo', workspaceDir: null });
    await b.r.turnEnded(KEY, [t]);
    const mine = b.sent.at(-1)!.threads.find((x) => x.threadRootId === R)!;
    expect(mine.worktrees).toEqual([]);
    // 아직 도는 다른 턴도 함께 실린다(running)
    expect(b.sent.at(-1)!.threads.find((x) => x.threadRootId !== R)).toMatchObject({ running: true });
  });
  it('답의 deleteThreads 를 지우고 다음 보고에 deleted 로 알린다 — 도는 스레드는 건드리지 않는다', async () => {
    const sent: CleanupReport[] = [];
    const deleted: string[] = [];
    const r = createCleanupReporter({
      send: async (rep) => { sent.push(rep); return { deleteThreads: [{ channelId: C, threadRootId: R }] }; },
      listWorktrees: async () => [], home: '/h',
      deleteThread: async (ref) => { deleted.push(ref.threadRootId); return 'deleted' as const; },
    });
    await r.turnStarted(KEY, { repo: null, workspaceDir: null });
    expect(deleted).toEqual([]);
    await r.turnEnded(KEY, []);
    expect(deleted).toEqual([R]);
    await r.tick();
    expect(sent.at(-1)!.deleted).toEqual([{ channelId: C, threadRootId: R }]);
  });
});

describe('n6 — 실행한 명령에서만', () => {
  it('tool_use 의 command, codex function_call 의 command 를 뽑고 출력·읽은 글은 버린다', () => {
    const codex = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ command: ['bash', '-lc', 'git worktree add /tmp/wt-c'] }) } });
    const text = commandTexts([bash('git worktree add /tmp/wt-a'), said('git worktree add /tmp/wt-read'), codex].join('\n'));
    expect(text).toContain('/tmp/wt-a');
    expect(text).toContain('/tmp/wt-c');
    expect(text).not.toContain('/tmp/wt-read');
  });
});

describe('F2 — 시작 중인 턴의 스레드는 지우지 않는다', () => {
  it('정의를 기다리는 사이 온 지우기 요청을 건너뛴다', async () => {
    const deleted: string[] = [];
    let release!: (v: { repo: null; workspaceDir: null }) => void;
    const info = new Promise<{ repo: null; workspaceDir: null }>((r) => { release = r; });
    const r = createCleanupReporter({
      send: async () => ({ deleteThreads: [{ channelId: C, threadRootId: R }] }),
      listWorktrees: async () => [], home: '/h',
      deleteThread: async (ref) => { deleted.push(ref.threadRootId); return 'deleted' as const; },
    });
    const started = r.turnStarted(KEY, info); // 기다리지 않는다
    await r.tick();                            // 그 사이 다른 보고의 답이 온다
    expect(deleted).toEqual([]);
    release({ repo: null, workspaceDir: null });
    await started;
    expect(deleted).toEqual([]);
  });
});

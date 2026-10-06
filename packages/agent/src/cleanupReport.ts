/**
 * 작업 폴더 정리 — 러너 쪽(스레드 9e909150 PR ②).
 *
 * 오퍼레이터는 러너 상태 트리를 읽지도 쓰지도 않는다(#431 D5). 그래서 이 트리 안의 사실과 이 트리 안의 지우기는 러너가 한다:
 * - **알리기** — 턴이 시작·끝날 때, 그리고 기동 때 한 번 relay 로 `CLEANUP_REPORT_PATH` 에 보낸다:
 *   스레드별로 그 턴이 만든 worktree 경로·마지막 턴 시각·지금 도는가·작업 폴더.
 * - **지우기** — 오퍼레이터 답의 `deleteThreads`(7일 무턴 → N일 유예 → 보존 아님 → 검사 통과)를 받아 그 스레드의 작업 폴더와
 *   Claude 세션 기록을 지우고 세션 레코드를 뺀다. 세션 레코드가 없으니 다음 턴은 새 세션으로 시작한다. `memory/` 는 남긴다.
 *
 * worktree 의 주인을 정하는 법: 그 턴의 세션 기록에 `worktree add <경로>` 가 그대로 적혀 있고, 그 경로가 지금 저장소의 worktree 목록에
 * 있을 때만이다. 턴 앞뒤 `git worktree list` 비교만으로는 정하지 않는다 — 같은 저장소를 다른 에이전트·다른 턴이 같이 쓰므로, 그 사이
 * 생긴 worktree 가 이 턴의 것이라는 보장이 없다. 비교는 "변수로 지은 경로" 를 메우는 데만 쓴다: 기록에 경로가 안 드러난
 * `worktree add` 가 있고 그 사이 새 worktree 가 **정확히 하나**이며 이 러너의 다른 턴이 겹치지 않았을 때.
 */
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';
import {
  claudeProjectDirName,
  normalizeCleanupPath,
  worktreeAddPaths,
  type CleanupReport,
  type CleanupReportReply,
  type CleanupThreadRef,
  type CleanupThreadReport,
} from '@harkroom/shared/workspaceCleanup';

export type ReportSender = (report: CleanupReport) => Promise<CleanupReportReply | null>;

/** `git worktree list --porcelain` 의 경로들(main 포함). 실패하면 빈 목록. */
export type ListWorktrees = (repo: string) => Promise<string[]>;

export const gitWorktreePaths: ListWorktrees = (repo) => new Promise((resolve) => {
  execFile('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
    if (err) { resolve([]); return; }
    resolve(String(stdout).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => normalizeCleanupPath(l.slice(9))));
  });
});

/** 기록에 `worktree add` 가 있지만 절대 경로가 안 드러났는가(`"$W"` 같은 변수). */
export function hasOpaqueWorktreeAdd(text: string, home: string): boolean {
  const all = text.match(/worktree add\b/g)?.length ?? 0;
  return all > worktreeAddPaths(text, home).length;
}

/**
 * `child` 가 `root` 아래에 있는가(실제 경로로). `child` 의 맨 위가 심링크면 거절한다 — 링크를 따라가 상태 트리 밖을 지우면 안 된다
 * (security n5).
 */
export async function isInsideRoot(root: string, child: string): Promise<boolean> {
  const st = await lstat(child).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const [r, c] = await Promise.all([realpath(root).catch(() => null), realpath(child).catch(() => null)]);
  if (!r || !c || c === r) return false;
  const rel = relative(r, c);
  return !!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export interface ThreadDeleteDeps {
  /** 러너 상태 트리의 작업 폴더 뿌리(`workspaces/`). 이 아래만 지운다. */
  workspaceBaseDir: string;
  /** Claude 계정들의 `projects/` 뿌리들. */
  claudeProjectRoots(): Promise<string[]>;
  sessionOf(key: string): { workspaceDir: string } | undefined;
  forget(key: string): Promise<void>;
}

/**
 * 한 스레드를 지운다: 작업 폴더 + 그 작업 폴더의 Claude 세션 기록(`projects/<인코딩>/` 안의 `memory/` 밖 전부) + 세션 레코드.
 * 작업 폴더가 상태 트리 밖이면(또는 심링크면) 아무것도 지우지 않고 false.
 */
export async function deleteThread(deps: ThreadDeleteDeps, ref: CleanupThreadRef): Promise<boolean> {
  const key = `${ref.channelId}/${ref.threadRootId}`;
  const rec = deps.sessionOf(key);
  if (!rec) return true; // 이미 없다
  if (!(await isInsideRoot(deps.workspaceBaseDir, rec.workspaceDir))) return false;
  // 레코드를 먼저 뺀다 — 지우다 죽어도 다음 턴이 지운 세션을 이어받으려 하지 않는다.
  await deps.forget(key);
  await rm(rec.workspaceDir, { recursive: true, force: true });
  const name = claudeProjectDirName(rec.workspaceDir);
  for (const root of await deps.claudeProjectRoots()) {
    const dir = join(root, name);
    if (!(await isInsideRoot(root, dir))) continue;
    for (const entry of await readdir(dir).catch(() => [] as string[])) {
      if (entry === 'memory') continue; // Claude 파일 메모리는 남긴다
      await rm(join(dir, entry), { recursive: true, force: true });
    }
  }
  return true;
}

export interface CleanupReporterDeps {
  send: ReportSender;
  listWorktrees: ListWorktrees;
  home: string;
  now?: () => Date;
  /** 답의 `deleteThreads` 를 지운다. 없으면 지우지 않는다. */
  deleteThread?: (ref: CleanupThreadRef) => Promise<boolean>;
  log?: (line: string) => void;
}

interface Open { repo: string | null; before: Promise<Set<string>>; workspaceDir: string | null; overlapped: boolean }

export interface CleanupReporter {
  turnStarted(key: string, info: { repo: string | null; workspaceDir: string | null }): Promise<void>;
  /** `transcripts` 는 이 턴의 하네스 기록 파일들(없으면 빈 배열). */
  turnEnded(key: string, transcripts: string[]): Promise<void>;
  /** 기동 때 한 번 — 이미 쌓인 것의 주인을 알린다. */
  backfill(threads: CleanupThreadReport[]): Promise<void>;
  /** 턴이 없어도 주기적으로 — 오퍼레이터의 지우기 요청은 보고의 답으로만 오므로, 한가한 러너도 물어야 받는다. */
  tick(): Promise<void>;
}

function refOf(key: string): CleanupThreadRef | null {
  const [channelId, threadRootId] = key.split('/');
  return channelId && threadRootId ? { channelId, threadRootId } : null;
}

export function createCleanupReporter(deps: CleanupReporterDeps): CleanupReporter {
  const now = deps.now ?? (() => new Date());
  const open = new Map<string, Open>();
  let pendingDeleted: CleanupThreadRef[] = [];

  /** 지금 도는 스레드 전부를 함께 싣는다 — 오퍼레이터는 러너마다 "도는 스레드" 집합을 보고 하나로 갈아 끼운다. */
  const send = async (threads: CleanupThreadReport[]) => {
    const keys = new Set(threads.map((t) => `${t.channelId}/${t.threadRootId}`));
    const all = [...threads];
    for (const [k, o] of open) {
      if (keys.has(k)) continue;
      const ref = refOf(k);
      if (ref) all.push({ ...ref, worktrees: [], lastTurnAt: null, running: true, workspaceDir: o.workspaceDir });
    }
    const deleted = pendingDeleted;
    pendingDeleted = [];
    let reply: CleanupReportReply | null = null;
    try { reply = await deps.send({ threads: all, ...(deleted.length ? { deleted } : {}) }); } catch { pendingDeleted.push(...deleted); return; }
    if (!reply || !deps.deleteThread) return;
    for (const ref of reply.deleteThreads ?? []) {
      if (open.has(`${ref.channelId}/${ref.threadRootId}`)) continue; // 도는 턴은 건드리지 않는다
      try {
        if (await deps.deleteThread(ref)) pendingDeleted.push(ref);
        else deps.log?.(`cleanup: ${ref.threadRootId} 작업 폴더가 상태 트리 밖이라 지우지 않았다`);
      } catch (err) { deps.log?.(`cleanup: ${ref.threadRootId} 지우기 실패: ${err instanceof Error ? err.message : String(err)}`); }
    }
  };

  return {
    async turnStarted(key, info) {
      for (const o of open.values()) o.overlapped = true;
      // 장부에는 **기다리기 전에** 올린다 — 아주 짧은 턴이 끝나는 통지가 먼저 와도 짝을 찾는다.
      const before = (info.repo ? deps.listWorktrees(info.repo) : Promise.resolve([] as string[])).then((l) => new Set(l), () => new Set<string>());
      open.set(key, { repo: info.repo, before, workspaceDir: info.workspaceDir, overlapped: open.size > 0 });
      const ref = refOf(key);
      if (ref) await send([{ ...ref, worktrees: [], lastTurnAt: now().toISOString(), running: true, workspaceDir: info.workspaceDir }]);
    },
    async turnEnded(key, transcripts) {
      const o = open.get(key);
      open.delete(key);
      const ref = refOf(key);
      if (!ref) return;
      const worktrees = new Set<string>();
      if (o?.repo) {
        const after = await deps.listWorktrees(o.repo);
        const current = new Set(after);
        let opaque = false;
        for (const t of transcripts) {
          let text = '';
          try { text = await readFile(t, 'utf8'); } catch { continue; }
          for (const p of worktreeAddPaths(text, deps.home)) if (current.has(p)) worktrees.add(p);
          if (hasOpaqueWorktreeAdd(text, deps.home)) opaque = true;
        }
        const before = await o.before;
        const fresh = after.filter((p) => !before.has(p));
        if (opaque && !o.overlapped && fresh.length === 1) worktrees.add(fresh[0]!);
      }
      await send([{ ...ref, worktrees: [...worktrees], lastTurnAt: now().toISOString(), running: false, workspaceDir: o?.workspaceDir ?? null }]);
    },
    async backfill(threads) {
      if (threads.length) await send(threads);
    },
    async tick() { await send([]); },
  };
}

/**
 * 기동 때 알릴 것 — 세션 레코드마다 그 작업 폴더의 Claude 세션 기록에서 `worktree add` 경로를 모은다. 마지막 턴 시각은 기록 파일의
 * 가장 늦은 수정 시각이다(레코드에 시각이 없다).
 */
export async function collectBackfill(deps: {
  sessions: [string, { workspaceDir: string }][];
  claudeProjectRoots: string[];
  home: string;
}): Promise<CleanupThreadReport[]> {
  const out: CleanupThreadReport[] = [];
  for (const [key, rec] of deps.sessions) {
    const ref = refOf(key);
    if (!ref) continue;
    const worktrees = new Set<string>();
    let last = 0;
    const name = claudeProjectDirName(rec.workspaceDir);
    for (const root of deps.claudeProjectRoots) {
      const dir = join(root, name);
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const p = join(dir, f);
          const st = await lstat(p);
          last = Math.max(last, st.mtimeMs);
          for (const w of worktreeAddPaths(await readFile(p, 'utf8'), deps.home)) worktrees.add(w);
        } catch { /* 하나 못 읽어도 나머지 */ }
      }
    }
    out.push({ ...ref, worktrees: [...worktrees].slice(-50), lastTurnAt: last ? new Date(last).toISOString() : null, running: false, workspaceDir: rec.workspaceDir });
  }
  return out;
}

/** `claude-accounts` 아래 `projects/` 뿌리들 — `<계정>/projects` 와 `<풀>/<계정>/projects` 두 깊이. */
export async function claudeProjectRootsUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const n of await readdir(dir).catch(() => [] as string[])) {
      if (n.startsWith('.')) continue;
      const p = join(dir, n);
      const st = await lstat(p).catch(() => null);
      if (!st?.isDirectory()) continue;
      if (n === 'projects') out.push(p);
      else if (depth < 2) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

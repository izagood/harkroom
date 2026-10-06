/**
 * 청소기 서비스 — 원장 파일·설정·회차·사람의 손을 한 줄로 세운다(daemon 소켓과 타이머가 이것을 부른다).
 *
 * 회차는 **하나씩만** 돈다(`chain`). 타이머와 사람의 손이 겹쳐도 원장을 둘이 동시에 쓰지 않는다.
 * 설정(`enabled`·`graceDays`)은 `operator.json` 의 `cleanup` 칸에 둔다 — writer 는 오퍼레이터 하나다(`config.ts`).
 * 기본은 **꺼짐**이다: 처음 켤 때 화면이 "무엇이 들어가는지"를 먼저 보여 준다(시안 「처음 켤 때」).
 */
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLEANUP_GRACE_DEFAULT,
  clampGraceDays,
  type CleanupBlockReason,
  type CleanupItem,
  type CleanupLedger,
  type CleanupSettings,
  normalizeCleanupPath,
} from '@harkroom/shared/workspaceCleanup';
import { readConfig, writeConfig } from './config.js';
import type { Exec } from './turnMerge.js';
import {
  applyHumanAction,
  planSweep,
  readLedger,
  removeRebuildable,
  runSweep,
  threadKey,
  writeLedger,
  type CleanupPorts,
  type HumanAction,
  type ObservedWorktree,
} from './workspaceCleanup.js';
import type { CleanupOwners } from './workspaceCleanupOwners.js';
import { isThreadDone, scanRepo, type Forward, type ScanDeps } from './workspaceCleanupScan.js';

export interface WorkspaceCleanupView { settings: CleanupSettings; ledger: CleanupLedger; running: boolean }

export interface WorkspaceCleanup {
  get(): Promise<WorkspaceCleanupView>;
  setSettings(next: Partial<CleanupSettings>): Promise<WorkspaceCleanupView>;
  act(path: string, action: HumanAction, by: string): Promise<WorkspaceCleanupView>;
  sweep(): Promise<void>;
}

export interface WorkspaceCleanupDeps extends ScanDeps {
  ledgerPath: string;
  configPath: string;
  /** 러너가 보고한 주인 장부. */
  owners: CleanupOwners;
  /** 이 오퍼레이터에 배정된 에이전트(id·workingDir). */
  agents(): Promise<{ agentId: string; workingDir: string | null }[]>;
  forward: Forward;
  now?: () => Date;
  log(line: string): void;
}

/** git 은 시스템 것을 쓴다(GH_PATH 와 같은 까닭 — PATH 를 상속하지 않는다). */
export const GIT_PATH = '/usr/bin/git';

export async function readCleanupSettings(configPath: string): Promise<CleanupSettings> {
  const c = (await readConfig(configPath)) as { cleanup?: { enabled?: unknown; graceDays?: unknown } };
  return { enabled: c.cleanup?.enabled === true, graceDays: clampGraceDays(c.cleanup?.graceDays ?? CLEANUP_GRACE_DEFAULT) };
}

const gitEnv = (home: string) => ({ HOME: home, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', GIT_TERMINAL_PROMPT: '0' });

/** `head` 가 원격 ref 나 PR head 에 들어 있는가. 원격 브랜치는 squash 머지 뒤 사라지므로 PR head 도 본다. */
async function isPushed(deps: ScanDeps, item: CleanupItem, head: string): Promise<boolean> {
  const env = gitEnv(deps.home);
  if (item.pr?.headSha === head) return true;
  const r = await deps.exec(deps.gitPath, ['-C', item.path, 'branch', '-r', '--contains', head], env);
  if (r.code === 0 && r.stdout.trim()) return true;
  if (item.pr?.headSha) {
    // PR head 의 조상이면 올라간 커밋이다(PR head 를 로컬이 모르면 실패 → 안 올라간 것으로 본다).
    const a = await deps.exec(deps.gitPath, ['-C', item.path, 'merge-base', '--is-ancestor', head, item.pr.headSha], env);
    if (a.code === 0) return true;
  }
  return false;
}

export function createCleanupPorts(deps: ScanDeps): CleanupPorts {
  const env = gitEnv(deps.home);
  return {
    async check(item, running): Promise<CleanupBlockReason | null> {
      if (item.thread && running.has(threadKey(item.thread))) return 'turn-running';
      if (item.kind !== 'worktree') return null;
      const st = await deps.exec(deps.gitPath, ['-C', item.path, 'status', '--porcelain'], env);
      if (st.code !== 0 || st.stdout.trim()) return 'uncommitted';
      // HEAD·브랜치는 **지금** 다시 읽는다. 원장 값은 스캔 때 것이라 그 사이 커밋이 더 생겼을 수 있다 — 낡은 값으로 "올라감"을
      // 판정하면 새 커밋이 브랜치와 함께 사라진다. 원장과 다르면 다음 회차의 스캔이 새 값을 잴 때까지 막는다.
      const head = (await deps.exec(deps.gitPath, ['-C', item.path, 'rev-parse', 'HEAD'], env)).stdout.trim();
      const b = await deps.exec(deps.gitPath, ['-C', item.path, 'symbolic-ref', '-q', '--short', 'HEAD'], env);
      const branch = b.code === 0 ? b.stdout.trim() || null : null;
      if (!head || head !== item.headSha || branch !== item.branch) return 'unpushed';
      if (!(await isPushed(deps, item, head))) return 'unpushed';
      return null;
    },
    async remove(item) {
      if (item.kind !== 'worktree') { await rm(item.path, { recursive: true, force: true }); return; }
      if (!item.repo || !item.headSha) throw new Error('worktree without repo');
      // --force 없이: 변경이 있으면 git 이 거절한다.
      const r = await deps.exec(deps.gitPath, ['-C', item.repo, 'worktree', 'remove', item.path], env);
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'git worktree remove failed');
      // 브랜치는 끝이 검사한 커밋 그대로일 때만 지운다(`update-ref -d <ref> <old>` 는 값이 다르면 거절한다).
      if (item.branch) await deps.exec(deps.gitPath, ['-C', item.repo, 'update-ref', '-d', `refs/heads/${item.branch}`, item.headSha], env);
    },
    async size(path) {
      const du = await deps.exec('/usr/bin/du', ['-sk', path], { PATH: '/usr/bin:/bin' });
      const kb = du.code === 0 ? Number.parseInt(du.stdout.split(/\s/)[0] ?? '', 10) : Number.NaN;
      return Number.isFinite(kb) ? kb * 1024 : null;
    },
    removeDeps: (root) => removeRebuildable(root, async (name) => {
      // 그 저장소가 이 폴더를 무시하고(check-ignore), 올려 둔 파일이 하나도 없을 때만.
      const ignored = await deps.exec(deps.gitPath, ['-C', root, 'check-ignore', '-q', '--', name], env);
      if (ignored.code !== 0) return false;
      const tracked = await deps.exec(deps.gitPath, ['-C', root, 'ls-files', '--', name], env);
      return tracked.code === 0 && tracked.stdout.trim() === '';
    }),
  };
}

export function createWorkspaceCleanup(deps: WorkspaceCleanupDeps, ports: CleanupPorts = createCleanupPorts(deps)): WorkspaceCleanup {
  const now = deps.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  let running = false;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const view = async (): Promise<WorkspaceCleanupView> => ({
    settings: await readCleanupSettings(deps.configPath), ledger: await readLedger(deps.ledgerPath), running,
  });

  const observe = async (prev: CleanupLedger) => {
    const agents = await deps.agents();
    const owners = await deps.owners.ownerOf();
    const repos = new Set<string>();
    for (const a of agents) if (a.workingDir) repos.add(a.workingDir);
    for (const i of prev.items) if (i.repo) repos.add(i.repo);
    const worktrees: ObservedWorktree[] = [];
    const seen = new Set<string>();
    // 에이전트의 workingDir 자체는 후보가 아니다 — 그것이 linked worktree 여도(에이전트가 일하는 자리다).
    const workingDirs = new Set(agents.flatMap((a) => (a.workingDir ? [normalizeCleanupPath(a.workingDir)] : [])));
    for (const repo of repos) {
      if (!(await lstat(join(repo, '.git')).catch(() => null))) continue;
      for (const w of await scanRepo(deps, repo, owners)) {
        if (seen.has(w.path) || workingDirs.has(normalizeCleanupPath(w.path))) continue;
        seen.add(w.path);
        worktrees.push(w);
      }
    }
    // 스레드 ✅ 는 조건이 될 만한 것(PR 머지·닫힘 + 주인 있음)만 묻는다 — 스레드마다 한 번, 그 스레드를 알린 에이전트로.
    const doneThreads = new Set<string>();
    const asked = new Set<string>();
    for (const w of worktrees) {
      if (!w.thread || !w.pr || w.pr.state === 'open') continue;
      const k = threadKey(w.thread);
      if (asked.has(k)) continue;
      asked.add(k);
      const agentId = owners.get(normalizeCleanupPath(w.path))?.agentId;
      if (agentId && await isThreadDone(deps.forward, agentId, w.thread.threadRootId)) doneThreads.add(k);
    }
    // 7일 무턴 스레드 폴더·세션 기록(규칙 6)은 러너 트리라 러너가 지운다(PR ②) — 여기선 worktree 만.
    return { worktrees, idle: [], doneThreads, lastTurnAt: await deps.owners.lastTurnAt(), runningThreads: deps.owners.running() };
  };

  const sweepOnce = async () => {
    running = true;
    try {
      const settings = await readCleanupSettings(deps.configPath);
      const prev = await readLedger(deps.ledgerPath);
      const facts = await observe(prev);
      const at = now();
      const plan = planSweep(prev, facts, settings, at);
      const next = await runSweep(plan, ports, facts.runningThreads, at);
      await writeLedger(deps.ledgerPath, next);
      const n = (s: string) => next.items.filter((i) => i.state === s).length;
      deps.log(`cleanup: 삭제 예정 ${n('listed')} · ⚠ ${n('blocked')} · 보존 ${n('kept')} · 주인 모름 ${n('unowned')}`);
    } finally { running = false; }
  };

  return {
    get: () => serial(view),
    setSettings: (next) => serial(async () => {
      const config = (await readConfig(deps.configPath)) as Awaited<ReturnType<typeof readConfig>> & { cleanup?: Partial<CleanupSettings> };
      const cur = await readCleanupSettings(deps.configPath);
      config.cleanup = {
        enabled: typeof next.enabled === 'boolean' ? next.enabled : cur.enabled,
        graceDays: next.graceDays === undefined ? cur.graceDays : clampGraceDays(next.graceDays),
      };
      await writeConfig(deps.configPath, config);
      // N 을 바꾸면 기한을 다시 계산한다(시안: "3개가 오늘 기한이 됩니다") — listedAt + N일.
      if (next.graceDays !== undefined && next.graceDays !== cur.graceDays) {
        const ledger = await readLedger(deps.ledgerPath);
        const days = config.cleanup.graceDays!;
        ledger.items = ledger.items.map((i) => (i.listedAt && (i.state === 'listed' || i.state === 'blocked')
          ? { ...i, deleteAfter: new Date(Date.parse(i.listedAt) + days * 86_400_000).toISOString() }
          : i));
        await writeLedger(deps.ledgerPath, ledger);
      }
      return view();
    }),
    act: (path, action, by) => serial(async () => {
      const settings = await readCleanupSettings(deps.configPath);
      const r = applyHumanAction(await readLedger(deps.ledgerPath), path, action, by, settings, now());
      const next = await runSweep({ ledger: r.ledger, actions: r.actions }, ports, deps.owners.running(), now());
      await writeLedger(deps.ledgerPath, next);
      return view();
    }),
    sweep: () => serial(sweepOnce),
  };
}

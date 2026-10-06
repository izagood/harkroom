/**
 * 「이 worktree 는 어느 스레드 것인가」의 장부 — 러너가 relay 로 보고하고(`CLEANUP_REPORT_PATH`), 청소기가 읽는다.
 *
 * 왜 러너의 `sessions.json` 을 직접 읽지 않나: 오퍼레이터는 러너 상태 트리를 읽지도 쓰지도 않는다(#431 D5, `adopt.test.ts`).
 * 러너가 그 트리의 유일한 주인이고, 그 안의 사실은 러너가 말로 건넨다.
 *
 * - 스레드별 사실(worktree 들·마지막 턴)은 파일(`cleanup/owners.json`)에 둔다 — 오퍼레이터가 다시 떠도 남는다.
 * - "지금 도는 턴"은 **메모리에만** 둔다. 러너가 죽으면(`releaseRunner`) 그 러너가 알린 것은 지운다 — 파일에 두면 죽은
 *   러너의 "도는 중"이 영원히 남아 아무것도 못 지운다.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import {
  CLEANUP_REPORT_PATH,
  normalizeCleanupPath,
  readCleanupReport,
  type CleanupThreadRef,
} from '@harkroom/shared/workspaceCleanup';

export interface OwnerRecord extends CleanupThreadRef {
  agentId: string;
  worktrees: string[];
  lastTurnAt: string | null;
  /** 러너 상태 트리 안의 그 스레드 작업 폴더. 러너가 지웠다고 알리면 null. */
  workspaceDir?: string | null;
}

export interface CleanupOwners {
  /** relay 로 온 보고면 받아 답한다. 아니면 null. */
  maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest, from: 'relay' | 'bridge'): Promise<RunnerLinkResponse | null>;
  releaseRunner(runnerId: string): void;
  /** worktree 경로(정규화) → 주인. 같은 경로를 여러 스레드가 알리면 마지막 턴이 늦은 쪽. */
  ownerOf(): Promise<Map<string, OwnerRecord>>;
  lastTurnAt(): Promise<Map<string, string>>;
  running(): ReadonlySet<string>;
  /** 스레드 → 주인 기록(7일 무턴 판정용). */
  threads(): Promise<OwnerRecord[]>;
  /** 이 스레드의 작업 폴더를 지워 달라고 그 러너의 다음 보고 답에 싣는다. */
  requestDelete(ref: CleanupThreadRef): void;
  /** 러너가 지웠다고 알린 스레드들(작업 폴더 경로와 함께) — 한 번 읽으면 비운다. */
  drainDeleted(): { thread: CleanupThreadRef; path: string }[];
}

export function cleanupOwnersPath(appDataDir: string): string {
  return join(appDataDir, 'cleanup', 'owners.json');
}

const key = (t: CleanupThreadRef) => `${t.channelId}/${t.threadRootId}`;

export function createCleanupOwners(opts: { path: string; log?: (line: string) => void }): CleanupOwners {
  const runningBy = new Map<string, Set<string>>();
  /** threadKey → 지워 달라고 한 스레드. 메모리에만 — 오퍼레이터가 다시 뜨면 다음 회차가 다시 고른다. */
  const pendingDelete = new Map<string, CleanupThreadRef>();
  let deletedConfirmed: { thread: CleanupThreadRef; path: string }[] = [];
  let cache: Record<string, OwnerRecord> | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<Record<string, OwnerRecord>> => {
    if (cache) return cache;
    try { cache = JSON.parse(await readFile(opts.path, 'utf8')) as Record<string, OwnerRecord>; } catch { cache = {}; }
    if (typeof cache !== 'object' || cache === null || Array.isArray(cache)) cache = {};
    return cache;
  };
  const save = async (v: Record<string, OwnerRecord>) => {
    await mkdir(dirname(opts.path), { recursive: true });
    const tmp = `${opts.path}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(v)}\n`, { mode: 0o600 });
    await rename(tmp, opts.path);
  };
  const answer = (req: RunnerLinkRequest, status: number, body: unknown): RunnerLinkResponse =>
    ({ type: 'http.response', id: req.id, status, body: status === 204 ? '' : JSON.stringify(body) });

  return {
    async maybeHandle(runnerId, agentId, req, from) {
      if (req.type !== 'http.forward' || req.method !== 'POST') return null;
      if (req.path.split('?')[0] !== CLEANUP_REPORT_PATH) return null;
      // 브릿지(=하네스가 부르는 MCP)로는 못 보낸다 — 모델이 주인을 지어내 남의 worktree 를 목록에 올리면 안 된다.
      if (from !== 'relay') return answer(req, 403, { error: { code: 'forbidden', message: '정리 보고는 러너 relay 에서만 받는다' } });
      let parsed: unknown;
      try { parsed = JSON.parse(req.body ?? ''); } catch { parsed = null; }
      const report = readCleanupReport(parsed);
      if (!report) return answer(req, 400, { error: { code: 'bad_request', message: 'threads 가 없다' } });
      const run = new Set<string>();
      for (const t of report.threads) if (t.running) run.add(key(t));
      runningBy.set(runnerId, run);
      const write = chain.then(async () => {
        const all = { ...(await load()) };
        for (const t of report.threads) {
          const k = key(t);
          const prev = all[k];
          // 같은 스레드를 다른 에이전트가 알리면 덮지 않고 합친다 — 한 스레드에 에이전트가 여럿일 수 있다.
          const worktrees = [...new Set([...(prev?.worktrees ?? []), ...t.worktrees.map(normalizeCleanupPath)])].slice(-50);
          const lastTurnAt = [prev?.lastTurnAt, t.lastTurnAt].filter((x): x is string => !!x).sort().at(-1) ?? null;
          // 작업 폴더는 **그 에이전트 것만** 받는다 — 지우기 요청은 이 값을 알린 에이전트의 러너에게만 간다.
          const owner = prev?.agentId ?? agentId;
          const workspaceDir = owner === agentId && t.workspaceDir ? t.workspaceDir : (prev?.workspaceDir ?? null);
          all[k] = { channelId: t.channelId, threadRootId: t.threadRootId, agentId: owner, worktrees, lastTurnAt, workspaceDir };
        }
        for (const d of report.deleted ?? []) {
          const k = key(d);
          const prev = all[k];
          // 지워 달라고 한 적 있는 것만 받는다 — 러너가 지어낸 "지웠다"로 남의 항목을 원장에서 빼지 못하게.
          if (!prev || prev.agentId !== agentId || !pendingDelete.has(k)) continue;
          pendingDelete.delete(k);
          if (prev.workspaceDir) deletedConfirmed.push({ thread: d, path: prev.workspaceDir });
          all[k] = { ...prev, workspaceDir: null };
        }
        cache = all;
        await save(all);
      });
      chain = write.catch((err) => opts.log?.(`cleanup 주인 장부 쓰기 실패: ${err instanceof Error ? err.message : String(err)}`));
      await chain;
      const all = await load();
      const deleteThreads = [...pendingDelete.entries()]
        .filter(([k]) => all[k]?.agentId === agentId && !run.has(k))
        .map(([, ref]) => ref);
      return answer(req, 200, { deleteThreads });
    },
    releaseRunner(runnerId) { runningBy.delete(runnerId); },
    async threads() { return Object.values(await load()); },
    requestDelete(ref) { pendingDelete.set(key(ref), { channelId: ref.channelId, threadRootId: ref.threadRootId }); },
    drainDeleted() { const out = deletedConfirmed; deletedConfirmed = []; return out; },
    async ownerOf() {
      const out = new Map<string, OwnerRecord>();
      for (const rec of Object.values(await load())) {
        for (const w of rec.worktrees) {
          const prev = out.get(w);
          if (!prev || (rec.lastTurnAt ?? '') > (prev.lastTurnAt ?? '')) out.set(w, rec);
        }
      }
      return out;
    },
    async lastTurnAt() {
      const out = new Map<string, string>();
      for (const [k, rec] of Object.entries(await load())) if (rec.lastTurnAt) out.set(k, rec.lastTurnAt);
      return out;
    },
    running() {
      const all = new Set<string>();
      for (const s of runningBy.values()) for (const k of s) all.add(k);
      return all;
    },
  };
}

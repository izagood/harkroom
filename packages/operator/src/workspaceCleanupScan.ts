/**
 * 청소기의 눈 — 이번 회차의 사실(`SweepFacts`)을 잰다. 규칙은 `workspaceCleanup.ts::planSweep` 에 있고 여기엔 없다.
 *
 * 무엇을 어디서 읽나(스레드 9e909150 설계 ①):
 * - worktree: 각 저장소의 `git worktree list --porcelain`. 저장소 = 이 오퍼레이터의 에이전트 `workingDir` + 원장에 이미 있는
 *   저장소. main worktree 는 빼고 센다(절대 지우지 않는다).
 * - 주인(스레드): 러너가 relay 로 보고한 장부(`workspaceCleanupOwners.ts`). 오퍼레이터는 러너 상태 트리를 읽지 않는다
 *   (#431 D5). 보고에 없는 worktree 는 주인 모름이다.
 * - PR: `gh pr list`(브랜치, detached 면 sha). 실패하면 PR 모름 → 목록에 넣지 않는다.
 * - 스레드 ✅: 그 에이전트로 서버 `GET /messages/<root>` 의 `statusReaction.status === 'done'`. 조건이 될 만한 스레드만 묻는다.
 *
 * **이 모듈은 아무것도 지우지 않는다.**
 */
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { normalizeCleanupPath, type CleanupPr } from '@harkroom/shared/workspaceCleanup';
import type { Exec } from './turnMerge.js';
import type { ObservedWorktree } from './workspaceCleanup.js';

export interface PorcelainWorktree { path: string; head: string | null; branch: string | null; bare: boolean }

/** `git worktree list --porcelain` — 빈 줄로 나뉜 묶음. 첫 묶음이 main worktree 다. */
export function parseWorktreePorcelain(out: string): PorcelainWorktree[] {
  const list: PorcelainWorktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    let path: string | null = null; let head: string | null = null; let branch: string | null = null; let bare = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice(9);
      else if (line.startsWith('HEAD ')) head = line.slice(5);
      else if (line.startsWith('branch ')) branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') bare = true;
    }
    if (path) list.push({ path, head, branch, bare });
  }
  return list;
}

/** origin URL → `owner/repo`(github.com 만). */
export function githubSlug(url: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function parsePrList(out: string): CleanupPr | null {
  let rows: unknown;
  try { rows = JSON.parse(out); } catch { return null; }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // 같은 브랜치로 PR 이 여럿이면 열린 것이 이긴다 — 하나라도 열려 있으면 지울 때가 아니다.
  const all = rows.flatMap((r) => {
    const x = r as { number?: unknown; state?: unknown; headRefOid?: unknown };
    if (typeof x.number !== 'number' || typeof x.state !== 'string') return [];
    const state = x.state.toLowerCase();
    if (state !== 'open' && state !== 'merged' && state !== 'closed') return [];
    return [{ number: x.number, state, headSha: typeof x.headRefOid === 'string' ? x.headRefOid : null } as CleanupPr];
  });
  return all.find((p) => p.state === 'open') ?? all.sort((a, b) => b.number - a.number)[0] ?? null;
}

/** 하위 폴더까지 크기(바이트)와 마지막 수정 시각. 의존성 폴더는 심링크면 세지 않는다(lstat). */
export async function measure(exec: Exec, path: string): Promise<{ size: number | null; lastModifiedAt: string | null }> {
  const du = await exec('/usr/bin/du', ['-sk', path], { PATH: '/usr/bin:/bin' });
  const kb = du.code === 0 ? Number.parseInt(du.stdout.split(/\s/)[0] ?? '', 10) : Number.NaN;
  let lastModifiedAt: string | null = null;
  try { lastModifiedAt = new Date((await stat(path)).mtimeMs).toISOString(); } catch { /* 없음 */ }
  return { size: Number.isFinite(kb) ? kb * 1024 : null, lastModifiedAt };
}

export interface ScanDeps {
  exec: Exec;
  gitPath: string;
  ghPath: string;
  ghEnv: Record<string, string>;
  home: string;
}

const GIT_ENV = (home: string) => ({ HOME: home, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', GIT_TERMINAL_PROMPT: '0' });

/** 한 저장소의 worktree 들(main 제외)에 브랜치·PR·크기·주인을 붙인다. */
export async function scanRepo(deps: ScanDeps, repo: string, owners: ReadonlyMap<string, { channelId: string; threadRootId: string }>): Promise<ObservedWorktree[]> {
  const env = GIT_ENV(deps.home);
  const r = await deps.exec(deps.gitPath, ['-C', repo, 'worktree', 'list', '--porcelain'], env);
  if (r.code !== 0) return [];
  const [main, ...rest] = parseWorktreePorcelain(r.stdout);
  if (!main) return [];
  const origin = await deps.exec(deps.gitPath, ['-C', main.path, 'remote', 'get-url', 'origin'], env);
  const slug = origin.code === 0 ? githubSlug(origin.stdout) : null;
  const out: ObservedWorktree[] = [];
  for (const w of rest) {
    if (w.bare) continue;
    let pr: CleanupPr | null = null;
    if (slug && (w.branch || w.head)) {
      const args = ['pr', 'list', '-R', slug, '--state', 'all', '--json', 'number,state,headRefOid', '--limit', '5'];
      args.push(...(w.branch ? ['--head', w.branch] : ['--search', w.head!]));
      const g = await deps.exec(deps.ghPath, args, deps.ghEnv);
      pr = g.code === 0 ? parsePrList(g.stdout) : null;
    }
    const o = owners.get(normalizeCleanupPath(w.path));
    const owner = o ? { thread: { channelId: o.channelId, threadRootId: o.threadRootId } } : null;
    const m = await measure(deps.exec, w.path);
    out.push({
      path: w.path, repo: main.path, branch: w.branch, headSha: w.head,
      thread: owner?.thread ?? null, pr, lastModifiedAt: m.lastModifiedAt, size: m.size,
    });
  }
  return out;
}

export type Forward = (agentId: string, req: RunnerLinkRequest) => Promise<RunnerLinkResponse>;

/** 스레드가 ✅(done)인가 — 그 에이전트로 루트 메시지를 읽는다. 못 읽으면 false(지우지 않는 쪽). */
export async function isThreadDone(forward: Forward, agentId: string, rootId: string): Promise<boolean> {
  try {
    const res = await forward(agentId, { type: 'http.forward', id: randomUUID(), method: 'GET', path: `/messages/${encodeURIComponent(rootId)}` });
    if (res.type !== 'http.response' || res.status !== 200) return false;
    // 답은 메시지 그 자체다(`routes/messageRoutes.ts` GET /messages/:id) — 루트의 statusReaction 이 스레드 상태다.
    const body = JSON.parse(res.body) as { statusReaction?: { status?: unknown } | null };
    return body.statusReaction?.status === 'done';
  } catch { return false; }
}

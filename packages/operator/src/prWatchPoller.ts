/**
 * PR 감시 폴러(위임 재설계 P5, 서버 `services/prWatch.ts`). 60초마다 이 오퍼레이터가 띄우는 에이전트마다 서버에 열린 감시를 묻고
 * (`GET /agent/pr-watches/due`), `pr.status` 와 같은 gh 길(같은 계정 고르기·같은 관문의 `gh pr view` 고정 칸)로 읽어
 * `POST /agent/pr-watches/:id/status` 로 보낸다. 바뀐 것 가르기·끝내기·깨우기는 전부 서버다.
 *
 * 서버 스위치가 꺼지면 due 가 빈 목록이라 gh 를 부르지 않는다. 감시 하나의 실패는 로그만 남기고 넘긴다 — 오퍼레이터를 죽이지 않는다.
 * 저장소는 서버가 돌려준 감시 행의 것이다(서버가 머지 grant 를 보고 만든 행, 보고 때 다시 본다).
 */
import { randomUUID } from 'node:crypto';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { pickPrStatus } from '@harkroom/shared/prStatus';
import { createGhTokens, createPrGate, defaultExec, ghEnv, REPO_RE, type Exec, type ExecResult, type TurnMergeDeps } from './turnMerge.js';

export const PR_WATCH_POLL_MS = 60_000;

export interface PrWatchPollerDeps {
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  agentIds(): string[];
  log(line: string): void;
  ghPath: string;
  home: string;
  ghUserFor: TurnMergeDeps['ghUserFor'];
  firstSeen: Map<string, number>;
  exec?: Exec;
  now?: () => number;
}

interface DueWatch { id: string; repo: string; number: number; head: string; until: string }

export function createPrWatchPoller(deps: PrWatchPollerDeps): { tick(): Promise<void>; start(): void; stop(): void } {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const tokens = createGhTokens({ exec, ghPath: deps.ghPath, home: deps.home, ghUserFor: deps.ghUserFor });
  const gh = async (args: string[], env: Record<string, string>): Promise<ExecResult> => exec(deps.ghPath, args, env);
  const gate = createPrGate({ gh, now, firstSeen: deps.firstSeen });
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const http = async (agentId: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown } | null> => {
    const res = await deps.forward(agentId, {
      type: 'http.forward', id: randomUUID(), method, path,
      ...(body !== undefined ? { body: JSON.stringify(body), contentType: 'application/json' } : {}),
    } as RunnerLinkRequest).catch(() => null);
    if (!res || res.type !== 'http.response' || res.status === 0) return null;
    let json: unknown = null;
    try { json = JSON.parse(res.body); } catch { /* 빈 본문 */ }
    return { status: res.status, json };
  };

  const pollOne = async (agentId: string, w: DueWatch): Promise<void> => {
    if (typeof w.repo !== 'string' || !REPO_RE.test(w.repo) || !Number.isInteger(w.number)) return;
    const tok = await tokens.tokenFor(w.repo);
    if (!tok.ok) { deps.log(`pr.watch: ${w.repo}#${w.number} gh 계정 없음(${tok.code})`); return; }
    const seen = await gate.inspect(w.repo, w.number, ghEnv(deps.home, tok.token));
    if (!seen.ok) { deps.log(`pr.watch: ${w.repo}#${w.number} gh pr view 실패`); return; }
    const picked = pickPrStatus(seen.pr);
    if (!picked) return;
    const r = await http(agentId, 'POST', `/agent/pr-watches/${encodeURIComponent(w.id)}/status`,
      { state: picked.state, headRefOid: picked.headRefOid, checks: picked.checks });
    if (!r || r.status >= 400) deps.log(`pr.watch: ${w.repo}#${w.number} 보고 실패(${r?.status ?? 'unreachable'})`);
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const agentId of deps.agentIds()) {
        try {
          const r = await http(agentId, 'GET', '/agent/pr-watches/due');
          const watches = (r && r.status === 200 ? (r.json as { watches?: unknown })?.watches : null);
          if (!Array.isArray(watches)) continue;
          for (const w of watches as DueWatch[]) {
            try { await pollOne(agentId, w); } catch (e) { deps.log(`pr.watch: 감시 ${String(w?.id)} 실패 — ${e instanceof Error ? e.message : String(e)}`); }
          }
        } catch (e) {
          deps.log(`pr.watch: ${agentId} 실패 — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick().catch(() => undefined); }, PR_WATCH_POLL_MS);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

/**
 * 배정 조정기 — 서버의 `assign`/`unassign` 을 "이 머신에서 무엇을 띄우고 내릴까"로 바꾼다.
 * 스펙 2026-09-20 §3(배정)·§9(drain 상한).
 *
 * 데스크탑 `runnerLauncher.ts::spawnRunner` 가 하던 env 조립(URL·PAT·PATH·AGENT_VERSION)을
 * 그대로 물려받았다 — 주입 주체만 앱에서 오퍼레이터로 옮겼다. **단계 2~3 한정으로** 러너는
 * 아직 PAT 로 서버에 직접 붙는다; 단계 4 가 PAT·URL 을 env 에서 뺀다.
 *
 * spawn·kill·시계·PAT 을 전부 주입받는다 — 결정을 프로세스 없이 재려고(`assignments.test.ts`).
 * 실제 프로세스 소유는 `runners.ts`(RunnerRegistry)가 그대로 맡는다.
 */
import type { AgentDefinition, RunnerAnnounce } from '@harkroom/shared/operatorProtocol';
import type { LocalAgentConfig } from './config.js';

export interface AssignmentDeps {
  /** 이미 살아 있으면 `spawned: false` 로 기존 것을 돌려준다(RunnerRegistry 의 멱등성). */
  spawn(agentId: string, env: Record<string, string>): Promise<{ spawned: boolean; pid: number; runnerId: string }>;
  /** 시그널을 보냈는가. 러너가 없으면 false. SIGTERM 은 러너가 drain 으로 받는다(#551). */
  signal(agentId: string, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  isAlive(agentId: string): boolean;
  listRunners(): RunnerAnnounce[];
  secrets: {
    getAgentPat(baseUrl: string, agentId: string): Promise<string | null>;
    setAgentPat(baseUrl: string, agentId: string, pat: string): Promise<void>;
  };
  /** 서버에서 이 에이전트의 PAT 을 받아 온다(오퍼레이터 토큰 + 배정). 단계 4 에서 사라진다. */
  fetchAgentPat(baseUrl: string, agentId: string): Promise<string>;
  loginPath: string | null;
  appVersion: string | null;
  /** 취소 손잡이를 돌려준다. */
  schedule(fn: () => void, ms: number): () => void;
  log(line: string): void;
  /** drain 상한(스펙 §9). 기본 10분 — 사람이 답하기 전엔 안 끝나는 턴을 영원히 기다리지 않는다. */
  drainTimeoutMs?: number;
  /** drain 이 아닐 때 SIGTERM → SIGKILL 유예. pty.ts 의 타임아웃 경로와 같은 5초. */
  killGraceMs?: number;
  /**
   * 러너가 죽었을 때 다시 띄우기까지의 첫 지연과 상한. 데스크탑 `pursueRespawn` 이 하던
   * 일이다 — 배정이 살아 있는 동안 러너가 없는 상태를 오퍼레이터가 스스로 메운다.
   * 연속으로 죽으면 두 배씩 늘고, 한동안 살아 있었으면 처음으로 돌아간다.
   */
  respawnBackoffMs?: number;
  respawnCeilingMs?: number;
  now?: () => number;
}

export type AssignOutcome = 'spawned' | 'already' | 'failed';

export interface AssignmentReconciler {
  onAssign(baseUrl: string, definition: AgentDefinition, local: LocalAgentConfig | undefined): Promise<AssignOutcome>;
  onUnassign(baseUrl: string, agentId: string, drain: boolean): Promise<void>;
  /**
   * 러너가 죽었다(레지스트리의 exit 통지). 배정이 살아 있으면 백오프 뒤 다시 띄운다 —
   * 회수 중(unassign)이거나 배정이 없으면 아무것도 안 한다.
   */
  onRunnerExit(agentId: string, code: number | null): void;
  /** 살아 있는 러너 전부 — hello 의 announce 에 실린다. */
  announce(): RunnerAnnounce[];
}

export function createAssignmentReconciler(deps: AssignmentDeps): AssignmentReconciler {
  const drainTimeoutMs = deps.drainTimeoutMs ?? 10 * 60_000;
  const killGraceMs = deps.killGraceMs ?? 5_000;
  const respawnBackoffMs = deps.respawnBackoffMs ?? 1_000;
  const respawnCeilingMs = deps.respawnCeilingMs ?? 60_000;
  const now = deps.now ?? Date.now;
  /** "한동안 살았다"의 기준 — 이보다 오래 살았으면 다음 죽음의 백오프는 처음부터다. */
  const STABLE_MS = 5 * 60_000;
  /** 진행 중인 회수. 같은 에이전트에 두 번 오면 앞의 예약을 놓는다. */
  const reclaims = new Map<string, () => void>();
  /** 살아 있는 배정 — 죽은 러너를 다시 띄울지의 근거. */
  const assigned = new Map<string, { baseUrl: string; definition: AgentDefinition; local: LocalAgentConfig | undefined }>();
  const lastSpawnAt = new Map<string, number>();
  const backoff = new Map<string, number>();
  const respawns = new Map<string, () => void>();

  const self: AssignmentReconciler = {
    async onAssign(baseUrl, definition, local) {
      const { agentId } = definition;
      assigned.set(agentId, { baseUrl, definition, local });
      respawns.get(agentId)?.(); respawns.delete(agentId);
      let pat = await deps.secrets.getAgentPat(baseUrl, agentId);
      if (!pat) {
        try {
          pat = await deps.fetchAgentPat(baseUrl, agentId);
          await deps.secrets.setAgentPat(baseUrl, agentId, pat);
        } catch (err) {
          deps.log(`배정 실패: agent=${definition.handle} — PAT 을 받지 못했다: ${err instanceof Error ? err.message : String(err)}`);
          return 'failed';
        }
      }
      // 회수 중이던 에이전트가 다시 배정됐다 — 예약된 SIGKILL 을 놓는다.
      reclaims.get(agentId)?.(); reclaims.delete(agentId);

      const env: Record<string, string> = {
        HARKROOM_URL: baseUrl,
        HARKROOM_PAT: pat,
        ...(deps.loginPath ? { PATH: deps.loginPath } : {}),
        // 없으면 넣지 않는다 — 거짓 버전을 심는 것보다 '모른다'가 낫다(design.md §4).
        ...(deps.appVersion ? { AGENT_VERSION: deps.appVersion } : {}),
        // 머신 값은 로컬 설정이 준다(스펙 §3 능력). 없으면 러너가 서버 정의의 기본값을 쓴다.
        ...(local?.workingDir ? { HARKROOM_WORKING_DIR: local.workingDir } : {}),
        ...(local?.claudePool ? { HARKROOM_CLAUDE_POOL: local.claudePool } : {}),
      };
      const result = await deps.spawn(agentId, env);
      if (result.spawned) lastSpawnAt.set(agentId, now());
      deps.log(result.spawned
        ? `러너 spawn: agent=${definition.handle} pid=${result.pid}`
        : `러너가 이미 있다 — 새로 안 띄운다: agent=${definition.handle} pid=${result.pid}`);
      return result.spawned ? 'spawned' : 'already';
    },

    async onUnassign(_baseUrl, agentId, drain) {
      assigned.delete(agentId);
      respawns.get(agentId)?.(); respawns.delete(agentId);
      if (!deps.isAlive(agentId)) return;
      reclaims.get(agentId)?.();
      // SIGTERM 이 1차다 — 러너는 진행 중인 턴을 끝내고 물러난다(drain). drain 이 아니어도
      // 정리할 기회는 준다; 차이는 유예의 길이뿐이다.
      deps.signal(agentId, 'SIGTERM');
      const grace = drain ? drainTimeoutMs : killGraceMs;
      deps.log(`배정 해제: agent=${agentId} — SIGTERM, ${Math.round(grace / 1000)}초 뒤 SIGKILL`);
      const cancel = deps.schedule(() => {
        reclaims.delete(agentId);
        // 스스로 끝났으면 아무것도 하지 않는다 — 새 프로세스를 죽이는 사고를 막는다.
        if (deps.isAlive(agentId)) deps.signal(agentId, 'SIGKILL');
      }, grace);
      reclaims.set(agentId, cancel);
    },

    onRunnerExit(agentId, code) {
      const entry = assigned.get(agentId);
      // 배정이 없거나 회수 중이면 죽는 것이 맞다 — 다시 띄우면 unassign 이 무의미해진다.
      if (!entry || reclaims.has(agentId)) return;
      const stable = now() - (lastSpawnAt.get(agentId) ?? 0) > STABLE_MS;
      const delay = stable ? respawnBackoffMs : (backoff.get(agentId) ?? respawnBackoffMs);
      backoff.set(agentId, Math.min(delay * 2, respawnCeilingMs));
      deps.log(`러너가 죽었다: agent=${entry.definition.handle} code=${code ?? 'signal'} — ${Math.round(delay / 1000)}초 뒤 다시 띄운다`);
      respawns.get(agentId)?.();
      respawns.set(agentId, deps.schedule(() => {
        respawns.delete(agentId);
        if (!assigned.has(agentId)) return;
        void self.onAssign(entry.baseUrl, entry.definition, entry.local)
          .catch((err: unknown) => deps.log(`다시 띄우기 실패: ${err instanceof Error ? err.message : String(err)}`));
      }, delay));
    },

    announce: () => deps.listRunners(),
  };
  return self;
}

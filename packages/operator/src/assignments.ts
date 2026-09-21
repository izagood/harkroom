/**
 * 배정 조정기 — 서버의 `assign`/`unassign` 을 "이 머신에서 무엇을 띄우고 내릴까"로 바꾼다.
 * 스펙 2026-09-20 §3(배정)·§9(drain 상한).
 *
 * 데스크탑 `runnerLauncher.ts::spawnRunner` 가 하던 env 조립(PATH·AGENT_VERSION)을 물려받았다 —
 * 주입 주체만 앱에서 오퍼레이터로 옮겼다. **URL·PAT 은 없다**(스펙 §5): 러너는 서버를 모른다.
 * 러너가 받는 것은 이 머신의 오퍼레이터 소켓과 자기 id·secret, 그리고 하네스에 물려줄
 * `mcp-bridge` 명령의 경로뿐이다.
 *
 * spawn·kill·시계를 전부 주입받는다 — 결정을 프로세스 없이 재려고(`assignments.test.ts`).
 * 실제 프로세스 소유는 `runners.ts`(RunnerRegistry)가 그대로 맡는다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentDefinition, RunnerAnnounce } from '@harkroom/shared/operatorProtocol';
import type { LocalAgentConfig } from './config.js';

export interface AssignmentDeps {
  /**
   * 이미 살아 있으면 `spawned: false` 로 **기존** 것을 돌려준다(RunnerRegistry 의 멱등성) —
   * 그때 돌아오는 `runnerId` 는 여기서 준 것이 아니다. 새로 띄우면 준 id 그대로다.
   */
  spawn(agentId: string, env: Record<string, string>, runnerId: string): Promise<{ spawned: boolean; pid: number; runnerId: string }>;
  /** 시그널을 보냈는가. 러너가 없으면 false. SIGTERM 은 러너가 drain 으로 받는다(#551). */
  signal(agentId: string, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  isAlive(agentId: string): boolean;
  listRunners(): RunnerAnnounce[];
  loginPath: string | null;
  appVersion: string | null;
  /** 러너 링크(스펙 §5). spawn 직전에 `expect` 로 id·secret 을 적어야 러너의 hello 가 통한다. */
  link: { expect(runnerId: string, agentId: string, secret: string): void; forget(runnerId: string): void };
  /** 오퍼레이터 소켓 경로 — 러너 env 에 실린다. */
  socketPath: string;
  /** `harkroom-operator` 실행 파일 — 러너가 하네스의 MCP 설정에 `mcp-bridge` 명령으로 굽는다. */
  operatorBin: string;
  /**
   * 이 커뮤니티에서 이 오퍼레이터의 소유자 id(`/operators/self`). 교차 불변식(스펙 §7)의 재료다 —
   * 모르면(null) personal 배정은 거절한다. 모르는 채로 여는 쪽이 더 나쁘다.
   */
  operatorOwnerId(): Promise<string | null>;
  /**
   * spawn 직전에 하네스 MCP 설정 파일을 쓴다(`mcpConfig.ts`). 이 머신에 정의가 없는 이름이
   * 있으면 `missing` — 그 배정은 띄우지 않는다.
   */
  mcpConfig(definition: AgentDefinition): Promise<{ path: string } | { missing: string[] }>;
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
  /**
   * spawn 이 `retiring`(앞 세대 러너가 아직 물러나는 중)으로 거절됐을 때 다시 띄워 보는 간격.
   * 레지스트리는 그 러너가 죽어야 자리를 내주는데, 그 러너는 우리 표에 없어 exit 통지가 없다 —
   * 그래서 묻는 쪽이 되풀이해 물어야 한다. 배정이 살아 있는 동안만이다.
   */
  retiringRetryMs?: number;
  now?: () => number;
}

/**
 * `refused` 는 띄우지 않았고 다시 띄우지도 않는다는 뜻 — 커뮤니티가 서버에 `runner.exited{reason}` 으로 알린다.
 * `retiring` 은 아직 안 띄웠지만 곧 띄운다는 뜻 — 앞 세대 러너가 물러나면 조정기가 스스로 다시 시도한다.
 */
export type AssignOutcome = 'spawned' | 'already' | 'retiring' | { refused: string };

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
  const retiringRetryMs = deps.retiringRetryMs ?? 5_000;
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
      // 교차 불변식(스펙 §7) — 서버가 거절했어야 하지만 오퍼레이터는 서버만 믿지 않는다. 개인
      // 자격증명을 쥔 에이전트를 남의 머신에서 띄우면 그 사람의 토큰이 남의 프로세스에 들어간다.
      if (definition.credentialScope === 'personal') {
        const owner = await deps.operatorOwnerId();
        if (owner === null || owner !== definition.ownerAccountId) {
          deps.log(`배정을 거절한다: agent=${definition.handle} — personal 자격증명인데 이 오퍼레이터의 소유자가 아니다`);
          return { refused: 'personal_on_foreign_operator' };
        }
      }
      // 하네스 MCP 설정은 여기서 쓴다(스펙 §6) — 정의와 토큰은 이 머신에 있고 러너는 경로만 받는다.
      const mcp = await deps.mcpConfig(definition);
      if ('missing' in mcp) {
        deps.log(`배정을 거절한다: agent=${definition.handle} — 이 머신에 MCP 정의가 없다: ${mcp.missing.join(', ')}`);
        return { refused: `mcp_server_missing:${mcp.missing.join(',')}` };
      }
      assigned.set(agentId, { baseUrl, definition, local });
      respawns.get(agentId)?.(); respawns.delete(agentId);
      // 회수 중이던 에이전트가 다시 배정됐다 — 예약된 SIGKILL 을 놓는다.
      reclaims.get(agentId)?.(); reclaims.delete(agentId);

      // 러너 id 와 secret 은 **spawn 마다** 새로 만든다 — id 는 서버가 다중화에 쓰는 키이고
      // (`RunnerAnnounce.runnerId` = 레지스트리의 incarnationId), secret 은 그 러너만 아는 값이다.
      const runnerId = randomUUID();
      const secret = randomBytes(24).toString('base64url');
      deps.link.expect(runnerId, agentId, secret);
      const env: Record<string, string> = {
        HARKROOM_OPERATOR_SOCKET: deps.socketPath,
        HARKROOM_RUNNER_ID: runnerId,
        HARKROOM_RUNNER_SECRET: secret,
        HARKROOM_OPERATOR_BIN: deps.operatorBin,
        HARKROOM_MCP_CONFIG: mcp.path,
        ...(deps.loginPath ? { PATH: deps.loginPath } : {}),
        // 없으면 넣지 않는다 — 거짓 버전을 심는 것보다 '모른다'가 낫다(design.md §4).
        ...(deps.appVersion ? { AGENT_VERSION: deps.appVersion } : {}),
        // 머신 값은 로컬 설정이 준다(스펙 §3 능력). 없으면 러너가 서버 정의의 기본값을 쓴다.
        ...(local?.workingDir ? { HARKROOM_WORKING_DIR: local.workingDir } : {}),
        ...(local?.claudePool ? { HARKROOM_CLAUDE_POOL: local.claudePool } : {}),
      };
      let result: Awaited<ReturnType<AssignmentDeps['spawn']>>;
      try {
        result = await deps.spawn(agentId, env, runnerId);
      } catch (err) {
        deps.link.forget(runnerId);
        if ((err as { code?: unknown }).code !== 'retiring') throw err;
        // 앞 세대 러너가 진행 중인 턴을 끝내길 기다린다(`runners.ts` 의 retiring). 그 러너는 우리
        // 표에 없어 죽어도 통지가 없다 — 여기서 되풀이해 물어야 자리가 비었을 때 띄울 수 있다.
        // 앱이 대신 띄워 주던 시절의 가정("앱이 새로 띄우게 둔다")은 이제 없다: 띄우는 것은 오퍼레이터다.
        deps.log(`${err instanceof Error ? err.message : String(err)} — ${Math.round(retiringRetryMs / 1000)}초 뒤 다시 띄워 본다: agent=${definition.handle}`);
        respawns.get(agentId)?.();
        respawns.set(agentId, deps.schedule(() => {
          respawns.delete(agentId);
          if (!assigned.has(agentId)) return;
          void self.onAssign(baseUrl, definition, local)
            .catch((e: unknown) => deps.log(`다시 띄우기 실패: ${e instanceof Error ? e.message : String(e)}`));
        }, retiringRetryMs));
        return 'retiring';
      }
      if (result.spawned) lastSpawnAt.set(agentId, now());
      // 안 띄웠으면 방금 적은 secret 은 아무 러너도 안 쓴다 — 남겨 두면 장부가 자라기만 한다.
      else deps.link.forget(runnerId);
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

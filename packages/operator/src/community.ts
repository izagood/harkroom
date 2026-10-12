/**
 * 커뮤니티 인스턴스 — 스펙 2026-09-20 §3 격리.
 *
 * 오퍼레이터는 머신당 하나이고 커뮤니티(=서버) 여럿에 붙는다. `design.md` §2-6 은 격리를
 * 스코핑 조건으로 코드에서 강제하는 것을 거부했다 — 답은 데스크탑 `communities.ts` 가 쓰는
 * 방법 그대로다: 커뮤니티마다 **독립된 객체**(링크·배정·로컬 설정)를 두면 잘못 읽는 것이
 * "잘못된 객체를 잡는 일"이라 격리가 구조로 강제된다.
 *
 * 이 객체가 해석하는 프레임은 `assign`·`unassign` 둘뿐이다. 나머지(러너 프레임)는 단계 3 이
 * `onFrame` 으로 릴레이 다중화기에 넘긴다 — 여기서 해석하면 스펙 §8 근거 ②(어휘)가 깨진다.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';
import type { OperatorCapabilities, OperatorStatus } from '@harkroom/shared';
import type { AgentDefinition, ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import type { Forwarder } from './forward.js';
import type { AssignmentReconciler } from './assignments.js';
import type { LocalAgentConfig } from './config.js';
import { createRelayMux } from './relayMux.js';
import { createServerLink, type LinkDialer, type ServerLink } from './serverLink.js';
import { HEARTBEAT_INTERVAL_MS } from './heartbeat.js';
import type { LocalTerminalHub } from './localTerminal.js';

export interface CommunityDeps {
  baseUrl: string;
  token: string;
  /** 이 커뮤니티에서 이 머신이 돌릴 수 있는 에이전트(로컬 설정). 키는 에이전트 id. */
  agents: Record<string, LocalAgentConfig>;
  reconciler: AssignmentReconciler;
  /**
   * 러너 링크(스펙 §5). 서버의 러너 프레임을 이리로 내려보내고, 러너의 프레임은
   * `onRunnerFrame` 으로 받아 서버에 올린다. 없으면 러너 프레임은 어디로도 가지 않는다
   * (단계 3 전환기 — 러너가 아직 서버 WS 로 직접 붙는 배선).
   */
  runnerLink?: { send(runnerId: string, frame: RelayServerFrame): boolean; isLinked(runnerId: string): boolean };
  /**
   * 같은 머신의 터미널 직결 허브(R1 PR-3b). 있으면 서버의 `local.view`·`local.writer` 를 가로채 허브에 넣고,
   * 러너 announce 에 `'local-terminal'` 을 덧붙인다. 없으면 그 프레임은 버린다(옛 동작과 같다).
   */
  localTerminal?: {
    hub: Pick<LocalTerminalHub, 'ownerOf' | 'grantView' | 'revokeView' | 'grantWriter'>;
    /** 러너가 어느 에이전트의 것인가 — 이 커뮤니티가 아는 에이전트의 세션에만 키를 받는다. */
    agentOf(runnerId: string): string | null;
  };
  /** 배정도 러너 프레임도 아닌 것(`runner.kill`)을 받는 자리. */
  onFrame?: (frame: ServerToOperatorFrame) => void;
  /** 러너의 MCP·REST 요청을 이 커뮤니티의 서버로 나른다(스펙 §5). 없으면 요청은 거절된다. */
  forwarder?: Forwarder;
  dial?: LinkDialer;
  schedule?: (fn: () => void, ms: number) => void;
  /** `/operators/self` 를 읽는 데 쓴다(교차 불변식의 재료). 없으면 전역 fetch. */
  fetchImpl?: typeof fetch;
  /** 이 머신의 하네스 능력(`harnesses.ts`). hello 마다 읽는다 — 없으면 빈 표(옛 오퍼레이터와 같다). */
  harnesses?: () => OperatorCapabilities['harnesses'];
  /**
   * `/operators/self` 가 알려 준 **이 머신의 오퍼레이터 id**. 붙을 때마다 부른다 — 앱이
   * 자기 기기를 고르려면 이 값이 로컬 설정에 있어야 하고, CLI 로 등록한 옛 설정에는 없다.
   */
  onSelf?: (operatorId: string) => void;
  /** 이 오퍼레이터의 빌드 버전(`version.ts`). hello 에 싣는다 — `null`·빈 값이면 싣지 않는다(서버는 "모른다"). */
  version?: string | null;
  /**
   * 박동(P3a). 붙을 때 한 번, 그 뒤 `heartbeatMs` 마다 `status` 프레임을 낸다. 없으면 박동이 없다(옛 동작).
   * 끊겨 있는 동안은 보내지 않는다 — 다음 붙음이 곧바로 하나를 낸다.
   */
  heartbeat?: { status: () => Promise<OperatorStatus>; machine: () => Promise<string | null> };
  heartbeatMs?: number;
  log: (line: string) => void;
}

export interface CommunityInstance {
  readonly baseUrl: string;
  readonly link: ServerLink;
  /** 서버가 내려준 배정. 로컬 설정에 있는 것만 들어온다. */
  readonly assignments: Map<string, AgentDefinition>;
  start(): void;
  stop(): void;
  /** 레지스트리의 exit 통지를 조정기에 넘긴다 — 배정이 살아 있으면 다시 띄운다. */
  onRunnerExit(agentId: string, code: number | null): void;
  /** 이 커뮤니티의 로컬 설정에 있는 에이전트인가 — 러너 프레임을 어느 커뮤니티로 보낼지의 근거. */
  knowsAgent(agentId: string): boolean;
  /**
   * 러너 링크에서 온 프레임 — runnerId 를 달아 서버로. **`local.input` 은 버린다**(security n1) — 감사 바이트는
   * 오퍼레이터의 허브만 올릴 수 있다(`reportLocalInput`). 러너가 직접 올리면 남의 감사를 부풀리거나 지울 수 있다.
   */
  onRunnerFrame(runnerId: string, frame: RelayRunnerFrame): void;
  /** 로컬 직결 허브가 센 입력 바이트 수를 서버 감사에 올린다(R1 PR-3b). 허브만 부른다. */
  reportLocalInput(runnerId: string, sessionId: string, gen: number, bytes: number): void;
  notifyRunnerStarted(agentId: string, runnerId: string): void;
  notifyRunnerExited(runnerId: string, code: number | null): void;
  /** 러너 대신 서버에 말한다 — 인증만 이 커뮤니티의 오퍼레이터 토큰 + 그 에이전트로 바꿔서. */
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  /**
   * 이 커뮤니티에서 이 오퍼레이터의 소유자 id — 붙을 때마다 `/operators/self` 로 새로 읽는다.
   * 못 읽으면 null(조정기는 그때 personal 배정을 거절한다).
   */
  ownerAccountId(): Promise<string | null>;
  /** 로컬 설정의 에이전트 표를 바꾸고 서버에 능력을 다시 낸다(`capabilities` 프레임). */
  setAgents(agents: Record<string, LocalAgentConfig>): void;
  /** 하네스 능력이 바뀌었다(모델 목록이 늦게 도착했다 등) — 서버에 능력을 다시 낸다. */
  announceCapabilities(): void;
}

export function createCommunity(deps: CommunityDeps): CommunityInstance {
  const assignments = new Map<string, AgentDefinition>();
  let agents = deps.agents;
  const capabilities = (): OperatorCapabilities => ({ agentIds: Object.keys(agents), harnesses: deps.harnesses?.() ?? {} });
  const noLink = { send: () => false, isLinked: () => false };
  // 링크가 서버 링크를 필요로 하고 서버 링크의 훅이 다중화기를 필요로 한다 — 늦게 묶는다.
  const linkRef: { current: ServerLink | null } = { current: null };
  const mux = createRelayMux({
    link: deps.runnerLink ?? noLink,
    send: (frame) => linkRef.current?.send(frame) ?? false,
    log: deps.log,
    ...(deps.localTerminal ? { extraCaps: ['local-terminal'] as const } : {}),
  });

  /**
   * 서버가 내린 로컬 직결 키를 허브에 넣는다(R1 PR-3b). **이 커뮤니티의 세션일 때만** 받는다 — 오퍼레이터는
   * 여러 서버에 붙을 수 있고, 한 서버가 다른 서버의 세션 id 로 키를 내려 남의 화면을 여는 길을 막는다:
   * 그 세션을 가진 러너가 프레임의 `runnerId` 와 같고, 그 러너의 에이전트를 이 커뮤니티가 알아야 한다.
   */
  const applyLocal = (frame: Extract<ServerToOperatorFrame, { type: 'local.view' | 'local.writer' }>): void => {
    const lt = deps.localTerminal;
    if (!lt) return;
    const agentId = lt.agentOf(frame.runnerId);
    if (lt.hub.ownerOf(frame.sessionId) !== frame.runnerId || !agentId || !(agentId in agents)) {
      deps.log(`로컬 직결 키를 버린다: ${frame.type} session=${frame.sessionId} — 이 커뮤니티의 이 러너 세션이 아니다`);
      return;
    }
    if (frame.type === 'local.view') {
      if (frame.granted) lt.hub.grantView(frame.sessionId, frame.viewKey);
      else lt.hub.revokeView(frame.sessionId, frame.viewKey);
      return;
    }
    lt.hub.grantWriter(frame.sessionId, frame.writerKey, frame.gen);
  };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const readSelf = async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(`${deps.baseUrl}/operators/self`, { headers: { authorization: `Bearer ${deps.token}` } });
      if (!res.ok) { deps.log(`/operators/self 실패(${res.status}) — personal 배정은 거절된다: ${deps.baseUrl}`); return null; }
      const body = (await res.json()) as { id?: unknown; ownerAccountId?: unknown };
      if (typeof body.id === 'string') deps.onSelf?.(body.id);
      return typeof body.ownerAccountId === 'string' ? body.ownerAccountId : null;
    } catch (err) {
      deps.log(`/operators/self 실패 — personal 배정은 거절된다: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  // 붙을 때마다 다시 읽는다 — assign 은 hello 직후에 오므로, 그 처리가 이 약속을 기다린다.
  let selfOwner: Promise<string | null> | null = null;

  const link = createServerLink({
    baseUrl: deps.baseUrl,
    token: deps.token,
    dial: deps.dial,
    schedule: deps.schedule,
    // 연결·재연결마다 새로 만든다 — 그 사이 러너가 바뀌었을 수 있다.
    hello: () => ({
      type: 'hello', protocol: 1,
      capabilities: capabilities(),
      runners: deps.reconciler.announce(),
      sessions: mux.sessions(),
      ...(deps.version ? { version: deps.version } : {}),
    }),
    onOpen: () => {
      deps.log(`서버에 붙었다: ${deps.baseUrl}`);
      selfOwner = readSelf();
      // 서버는 소켓이 끊기면 러너의 세션을 버린다 — hello 의 목록 뒤에 러너별 announce 로 능력까지 다시 낸다.
      mux.resync();
      // hello 다음에 박동 하나 — 서버는 끊길 때 박동을 버리므로 붙자마자 채워 둔다.
      beat();
    },
    onClose: (reason) => deps.log(`서버와 끊겼다: ${deps.baseUrl}${reason ? ` — ${reason}` : ''}`),
    onFrame: (frame) => {
      if (frame.type === 'assign') {
        const local = agents[frame.agentId];
        // 양쪽 동의(스펙 §3): 로컬 설정에 없으면 서버가 무엇을 내려도 띄우지 않는다. 서버가
        // 능력을 보고 거절했어야 하지만, 오퍼레이터는 서버만 믿지 않는다.
        if (!local) {
          deps.log(`배정을 거절한다: agent=${frame.agentId} — 이 머신의 로컬 설정에 없다`);
          return;
        }
        assignments.set(frame.agentId, frame.definition);
        void deps.reconciler.onAssign(deps.baseUrl, frame.definition, local)
          .then((outcome) => {
            if (typeof outcome !== 'object') return;
            // 거절은 조용히 안 뜨는 것이 아니다 — 서버(와 배정한 사람)가 사유를 본다. 러너가 없었으니
            // runnerId 는 이 통지만을 위한 새 값이다.
            assignments.delete(frame.agentId);
            link.send({ type: 'runner.exited', runnerId: randomUUID(), code: null, reason: outcome.refused, agentId: frame.agentId });
          })
          .catch((err: unknown) => deps.log(`배정 처리 실패: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (frame.type === 'unassign') {
        assignments.delete(frame.agentId);
        void deps.reconciler.onUnassign(deps.baseUrl, frame.agentId, frame.drain)
          .catch((err: unknown) => deps.log(`해제 처리 실패: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (frame.type === 'agent.restart') {
        if (!deps.reconciler.restart(frame.agentId)) deps.log(`재시작 무시: agent=${frame.agentId} — 배정·러너가 없다`);
        return;
      }
      // 로컬 직결 키는 러너까지 가지 않는다 — 이 오퍼레이터의 허브가 받는다(R1 PR-3b).
      if (frame.type === 'local.view' || frame.type === 'local.writer') { applyLocal(frame); return; }
      // 러너 프레임이면 다중화기가 runnerId 로 러너를 골라 내린다. 아니면(runner.kill) 밖으로.
      if (!mux.onServerFrame(frame)) deps.onFrame?.(frame);
    },
  });
  linkRef.current = link;

  let beatTimer: ReturnType<typeof setInterval> | null = null;
  const beat = (): void => {
    const hb = deps.heartbeat;
    if (!hb) return;
    void Promise.all([hb.status(), hb.machine()])
      .then(([status, machine]) => {
        // 이 커뮤니티의 에이전트만 싣는다(security #1203 F1) — hello 가 `reconciler.announce()` 로 거르는 것과 같은
        // 경계다. 재료는 오퍼레이터 전역이라 거르지 않으면 회사 서버에 개인 에이전트의 id·턴 수가 간다.
        // 턴 합계·메모리·디스크는 머신의 값이라 그대로 둔다(상한은 커뮤니티 사이에 공유된다).
        const own: OperatorStatus = status.runners
          ? { ...status, runners: status.runners.filter((r) => r.agentId in agents) }
          : status;
        // 머신 값에 이 서버 주소를 섞는다(security #1203 n7) — 서버마다 값이 달라 두 서버의 관리자가 서로
        // 대조해 같은 머신인지 알 수 없다. 한 서버 안(같은 소유자)의 묶음에는 지장이 없다.
        const scoped = machine ? createHash('sha256').update(`${machine}\n${deps.baseUrl}`).digest('hex') : null;
        link.send({ type: 'status', status: own, ...(scoped ? { machine: scoped } : {}) });
      })
      .catch((err: unknown) => deps.log(`박동을 만들지 못했다: ${err instanceof Error ? err.message : String(err)}`));
  };

  return {
    baseUrl: deps.baseUrl,
    link,
    assignments,
    start: () => {
      link.start();
      if (deps.heartbeat && !beatTimer) {
        beatTimer = setInterval(beat, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
        beatTimer.unref?.();
      }
    },
    stop: () => {
      if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
      link.stop();
    },
    onRunnerExit: (agentId, code) => {
      // 이 커뮤니티의 배정이 아니면 남의 exit 이다 — 조정기가 assigned 로 다시 거르지만
      // 여기서 먼저 거르면 로그가 커뮤니티마다 한 줄씩 찍히지 않는다.
      if (assignments.has(agentId)) deps.reconciler.onRunnerExit(agentId, code);
    },
    knowsAgent: (agentId) => agentId in agents,
    onRunnerFrame: (runnerId, frame) => {
      if (frame.type === 'local.input') {
        deps.log(`러너가 올린 local.input 을 버린다: runner=${runnerId} — 감사 바이트는 오퍼레이터 허브만 올린다`);
        return;
      }
      mux.onRunnerFrame(runnerId, frame);
    },
    reportLocalInput: (runnerId, sessionId, gen, bytes) => {
      mux.onRunnerFrame(runnerId, { type: 'local.input', sessionId, gen, bytes });
    },
    notifyRunnerStarted: (agentId, runnerId) => { link.send({ type: 'runner.started', agentId, runnerId }); },
    notifyRunnerExited: (runnerId, code) => {
      mux.forget(runnerId);
      link.send({ type: 'runner.exited', runnerId, code });
    },
    ownerAccountId: () => selfOwner ?? (selfOwner = readSelf()),
    setAgents: (next) => {
      agents = next;
      // 끊겨 있으면 다음 hello 가 새 표를 싣는다 — send 의 false 는 실패가 아니다.
      link.send({ type: 'capabilities', capabilities: capabilities() });
    },
    announceCapabilities: () => { link.send({ type: 'capabilities', capabilities: capabilities() }); },
    forward: async (agentId, req) => {
      if (!deps.forwarder) {
        return req.type === 'mcp.request'
          ? { type: 'mcp.error', id: req.id, status: 0, message: '이 커뮤니티에는 전달이 배선되지 않았다' }
          : { type: 'http.response', id: req.id, status: 0, body: '이 커뮤니티에는 전달이 배선되지 않았다' };
      }
      return deps.forwarder.forward({ baseUrl: deps.baseUrl, token: deps.token, agentId }, req);
    },
  };
}

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
import { randomUUID } from 'node:crypto';
import type { RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';
import type { OperatorCapabilities } from '@harkroom/shared';
import type { AgentDefinition, ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import type { Forwarder } from './forward.js';
import type { AssignmentReconciler } from './assignments.js';
import type { LocalAgentConfig } from './config.js';
import { createRelayMux } from './relayMux.js';
import { createServerLink, type LinkDialer, type ServerLink } from './serverLink.js';

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
  /** 러너 링크에서 온 프레임 — runnerId 를 달아 서버로. */
  onRunnerFrame(runnerId: string, frame: RelayRunnerFrame): void;
  notifyRunnerStarted(agentId: string, runnerId: string): void;
  notifyRunnerExited(runnerId: string, code: number | null): void;
  /** 러너 대신 서버에 말한다 — 인증만 이 커뮤니티의 오퍼레이터 토큰 + 그 에이전트로 바꿔서. */
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  /**
   * 이 커뮤니티에서 이 오퍼레이터의 소유자 id — 붙을 때마다 `/operators/self` 로 새로 읽는다.
   * 못 읽으면 null(조정기는 그때 personal 배정을 거절한다).
   */
  ownerAccountId(): Promise<string | null>;
}

export function createCommunity(deps: CommunityDeps): CommunityInstance {
  const assignments = new Map<string, AgentDefinition>();
  const noLink = { send: () => false, isLinked: () => false };
  // 링크가 서버 링크를 필요로 하고 서버 링크의 훅이 다중화기를 필요로 한다 — 늦게 묶는다.
  const linkRef: { current: ServerLink | null } = { current: null };
  const mux = createRelayMux({
    link: deps.runnerLink ?? noLink,
    send: (frame) => linkRef.current?.send(frame) ?? false,
    log: deps.log,
  });

  const fetchImpl = deps.fetchImpl ?? fetch;
  const readSelf = async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(`${deps.baseUrl}/operators/self`, { headers: { authorization: `Bearer ${deps.token}` } });
      if (!res.ok) { deps.log(`/operators/self 실패(${res.status}) — personal 배정은 거절된다: ${deps.baseUrl}`); return null; }
      const body = (await res.json()) as { ownerAccountId?: unknown };
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
      capabilities: { agentIds: Object.keys(deps.agents), harnesses: deps.harnesses?.() ?? {} },
      runners: deps.reconciler.announce(),
      sessions: mux.sessions(),
    }),
    onOpen: () => {
      deps.log(`서버에 붙었다: ${deps.baseUrl}`);
      selfOwner = readSelf();
      // 서버는 소켓이 끊기면 러너의 세션을 버린다 — hello 의 목록 뒤에 러너별 announce 로 능력까지 다시 낸다.
      mux.resync();
    },
    onClose: (reason) => deps.log(`서버와 끊겼다: ${deps.baseUrl}${reason ? ` — ${reason}` : ''}`),
    onFrame: (frame) => {
      if (frame.type === 'assign') {
        const local = deps.agents[frame.agentId];
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
            link.send({ type: 'runner.exited', runnerId: randomUUID(), code: null, reason: outcome.refused });
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
      // 러너 프레임이면 다중화기가 runnerId 로 러너를 골라 내린다. 아니면(runner.kill) 밖으로.
      if (!mux.onServerFrame(frame)) deps.onFrame?.(frame);
    },
  });
  linkRef.current = link;

  return {
    baseUrl: deps.baseUrl,
    link,
    assignments,
    start: () => link.start(),
    stop: () => link.stop(),
    onRunnerExit: (agentId, code) => {
      // 이 커뮤니티의 배정이 아니면 남의 exit 이다 — 조정기가 assigned 로 다시 거르지만
      // 여기서 먼저 거르면 로그가 커뮤니티마다 한 줄씩 찍히지 않는다.
      if (assignments.has(agentId)) deps.reconciler.onRunnerExit(agentId, code);
    },
    knowsAgent: (agentId) => agentId in deps.agents,
    onRunnerFrame: (runnerId, frame) => mux.onRunnerFrame(runnerId, frame),
    notifyRunnerStarted: (agentId, runnerId) => { link.send({ type: 'runner.started', agentId, runnerId }); },
    notifyRunnerExited: (runnerId, code) => {
      mux.forget(runnerId);
      link.send({ type: 'runner.exited', runnerId, code });
    },
    ownerAccountId: () => selfOwner ?? (selfOwner = readSelf()),
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

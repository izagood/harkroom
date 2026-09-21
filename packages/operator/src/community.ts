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
import type { AgentDefinition, ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import type { AssignmentReconciler } from './assignments.js';
import type { LocalAgentConfig } from './config.js';
import { createServerLink, type LinkDialer, type ServerLink } from './serverLink.js';

export interface CommunityDeps {
  baseUrl: string;
  token: string;
  /** 이 커뮤니티에서 이 머신이 돌릴 수 있는 에이전트(로컬 설정). 키는 에이전트 id. */
  agents: Record<string, LocalAgentConfig>;
  reconciler: AssignmentReconciler;
  /** 배정 밖의 프레임(러너 프레임)을 받는 자리. 단계 3 이 채운다. */
  onFrame?: (frame: ServerToOperatorFrame) => void;
  dial?: LinkDialer;
  schedule?: (fn: () => void, ms: number) => void;
  log: (line: string) => void;
}

export interface CommunityInstance {
  readonly baseUrl: string;
  readonly link: ServerLink;
  /** 서버가 내려준 배정. 로컬 설정에 있는 것만 들어온다. */
  readonly assignments: Map<string, AgentDefinition>;
  start(): void;
  stop(): void;
}

export function createCommunity(deps: CommunityDeps): CommunityInstance {
  const assignments = new Map<string, AgentDefinition>();

  const link = createServerLink({
    baseUrl: deps.baseUrl,
    token: deps.token,
    dial: deps.dial,
    schedule: deps.schedule,
    // 연결·재연결마다 새로 만든다 — 그 사이 러너가 바뀌었을 수 있다.
    hello: () => ({
      type: 'hello', protocol: 1,
      capabilities: { agentIds: Object.keys(deps.agents), harnesses: {} },
      runners: deps.reconciler.announce(),
      sessions: [],
    }),
    onOpen: () => deps.log(`서버에 붙었다: ${deps.baseUrl}`),
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
          .catch((err: unknown) => deps.log(`배정 처리 실패: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (frame.type === 'unassign') {
        assignments.delete(frame.agentId);
        void deps.reconciler.onUnassign(deps.baseUrl, frame.agentId, frame.drain)
          .catch((err: unknown) => deps.log(`해제 처리 실패: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      deps.onFrame?.(frame);
    },
  });

  return {
    baseUrl: deps.baseUrl,
    link,
    assignments,
    start: () => link.start(),
    stop: () => link.stop(),
  };
}

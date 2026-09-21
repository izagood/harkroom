/**
 * 서버 ↔ 오퍼레이터 채널(`GET /operator`, WS)의 **말의 정의** — 스펙 2026-09-20 §4.
 *
 * 오퍼레이터가 outbound 로 걸고(포트를 열지 않는다), 프레임은 JSON 한 개씩이며, 러너에
 * 관한 것은 전부 `runnerId` 로 다중화한다. 이 모듈은 Node 의존이 없는 순수 타입이다 —
 * `index.ts` 에 얹지 않고 서브패스로 내는 이유는 `daemonProtocol` 과 같다: 오퍼레이터·서버만
 * 쓰고 데스크탑 웹뷰는 쓰지 않는다.
 *
 * ## 파서는 얕다
 *
 * `type` 이 아는 것인지, 다중화 키가 필요한 프레임에 `runnerId` 가 있는지만 본다. 본문의
 * 깊은 검증은 받는 쪽의 일이다 — 릴레이 허브가 세션 프레임을 검증하듯. 모르는 타입은 null 로
 * 버린다: 구·신 세대가 섞여도 한쪽이 죽지 않는다(`daemonProtocol` 의 `unknown-request` 와
 * 같은 판단).
 */
import type { AgentSessionView, OperatorCapabilities, RunnerCap } from './index.js';

/** 오퍼레이터가 spawn 마다 만드는 러너 식별자. 데몬의 `incarnationId` 와 같은 것이다 — 이름만 통일한다. */
export interface RunnerAnnounce { agentId: string; runnerId: string; pid: number }

/**
 * 서버가 배정과 함께 내려주는 에이전트 정의. **머신 값은 여기 없다** — 실제 작업 디렉터리·계정
 * 풀은 오퍼레이터 로컬 설정(`operator.json`)이 준다(스펙 §3 능력). `workingDirDefault` 는
 * 로컬 설정이 비었을 때의 기본값이다.
 */
export interface AgentDefinition {
  agentId: string;
  handle: string;
  harness: string;
  instructions: string;
  model: string | null;
  effort: string | null;
  mentionPermission: string;
  workingDirDefault: string | null;
  /** 단계 5 부터 실제 값. 그 전엔 'none'. */
  credentialScope: 'personal' | 'community' | 'none';
  ownerAccountId: string | null;
  mcpServers: string[];
}

export type OperatorToServerFrame =
  | { type: 'hello'; protocol: 1; capabilities: OperatorCapabilities;
      runners: RunnerAnnounce[]; sessions: AgentSessionView[] }
  | { type: 'runner.started'; agentId: string; runnerId: string }
  /**
   * `reason` 은 러너가 아니라 오퍼레이터의 판단이다(배정 거절: personal_on_foreign_operator,
   * mcp_server_missing:<이름>). 그때는 러너가 없었으므로 `agentId` 를 함께 준다 — 서버가 그 사유를
   * 에이전트에 붙여 화면에 보이게(`OperatorHub.refusalOf`).
   */
  | { type: 'runner.exited'; runnerId: string; code: number | null; reason?: string; agentId?: string }
  /**
   * 능력이 바뀌었다 — 소켓은 그대로 두고 능력만 새로 낸다(앱이 로컬 설정에 에이전트를
   * 넣거나 뺐을 때). hello 를 다시 보내면 서버가 러너 목록까지 교체하므로 따로 둔다.
   */
  | { type: 'capabilities'; capabilities: OperatorCapabilities }
  /**
   * 러너가 링크에 붙을 때마다(재접속 포함) 자기 세션·능력을 다시 선언한다 — 옛 릴레이의
   * `announce` 그대로다(`runnerLink.ts`). 서버는 이 목록으로 그 러너의 세션을 **교체**한다.
   */
  | { type: 'runner.announce'; runnerId: string; sessions: AgentSessionView[]; caps?: RunnerCap[] }
  | { type: 'session.started'; runnerId: string; session: AgentSessionView }
  | { type: 'session.updated'; runnerId: string; session: AgentSessionView }
  | { type: 'session.ended'; runnerId: string; sessionId: string }
  | { type: 'pty.output'; runnerId: string; sessionId: string; bytes: string }
  /** attach 의 ring 재생 — `pty.replay.request` 의 답. `bytes` 는 base64 그대로다(불투명 우체국). */
  | { type: 'pty.replay'; runnerId: string; sessionId: string; bytes: string }
  | { type: 'interactive.opened'; runnerId: string; requestId: string; sessionId: string; created: boolean }
  | { type: 'interactive.error'; runnerId: string; requestId: string; message: string }
  | { type: 'attention.required'; runnerId: string; sessionId: string; accountLabel: string; screen: string };

export type ServerToOperatorFrame =
  | { type: 'assign'; agentId: string; definition: AgentDefinition }
  | { type: 'unassign'; agentId: string; drain: boolean }
  | { type: 'runner.kill'; runnerId: string }
  | { type: 'pty.replay.request'; runnerId: string; sessionId: string }
  | { type: 'pty.input'; runnerId: string; sessionId: string; bytes: string }
  | { type: 'pty.resize'; runnerId: string; sessionId: string; cols: number; rows: number }
  | { type: 'viewer.count'; runnerId: string; sessionId: string; count: number }
  | { type: 'session.cancel'; runnerId: string; sessionId: string; byHandle: string }
  | { type: 'interactive.open'; runnerId: string; requestId: string; channelId: string;
      threadRootId: string; openedByHandle: string; cols?: number; rows?: number };

const OPERATOR_TYPES = new Set<OperatorToServerFrame['type']>([
  'hello', 'capabilities', 'runner.started', 'runner.exited', 'runner.announce', 'session.started', 'session.updated', 'session.ended',
  'pty.output', 'pty.replay', 'interactive.opened', 'interactive.error', 'attention.required',
]);
const SERVER_TYPES = new Set<ServerToOperatorFrame['type']>([
  'assign', 'unassign', 'runner.kill', 'pty.replay.request', 'pty.input', 'pty.resize', 'viewer.count', 'session.cancel', 'interactive.open',
]);

/** `hello` 와 배정 둘(`assign`·`unassign`)만 러너 밖의 말이다 — 나머지는 전부 `runnerId` 가 있어야 한다. */
const NO_RUNNER_ID = new Set<string>(['hello', 'capabilities', 'assign', 'unassign']);

function parse(raw: string, known: Set<string>): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.type !== 'string' || !known.has(frame.type)) return null;
  if (!NO_RUNNER_ID.has(frame.type) && typeof frame.runnerId !== 'string') return null;
  return frame;
}

export function parseOperatorFrame(raw: string): OperatorToServerFrame | null {
  return parse(raw, OPERATOR_TYPES) as OperatorToServerFrame | null;
}

export function parseServerFrame(raw: string): ServerToOperatorFrame | null {
  return parse(raw, SERVER_TYPES) as ServerToOperatorFrame | null;
}

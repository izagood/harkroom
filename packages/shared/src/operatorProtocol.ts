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
import type { AgentSessionView, OperatorCapabilities, OperatorCredentialState, OperatorStatus, RunnerCap } from './index.js';

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
      runners: RunnerAnnounce[]; sessions: AgentSessionView[];
      /**
       * 이 오퍼레이터의 빌드 버전 — 이 오퍼레이터가 띄우는 러너에 심는 `AGENT_VERSION` 과 같은
       * 값이다(`operator/src/version.ts`). 화면의 러너 뒤처짐 판정이 이것을 기준으로 삼는다.
       * 옛 오퍼레이터는 싣지 않고, 버전을 모르는 오퍼레이터도 싣지 않는다 — 서버는 없음을
       * "모른다"로 적는다(빈 문자열 같은 거짓 값을 보내지 않는다).
       */
      version?: string }
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
   * 박동(원격 호스트 관리 P2a, 스레드 3b0f0255) — 오퍼레이터가 30초마다 낸다. 서버는 **마지막 값만**
   * 연결이 살아 있는 동안 든다(능력과 같은 판단: 꺼진 머신의 메모리·턴 수를 보이면 거짓이다).
   * `machine` 은 머신 고유값(`/etc/machine-id`·IOPlatformUUID)의 sha256 hex 다 — **원래 값은 보내지
   * 않는다.** 서버가 이것을 소유자 id 와 다시 섞어 저장하므로(`operator.machine_id`) 소유자가 다르면
   * 같은 머신이어도 값이 갈린다. 받는 쪽 검증은 `parseOperatorStatus` 하나다.
   */
  | { type: 'status'; status: unknown; machine?: unknown }
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
  /**
   * 배정은 그대로 두고 러너만 갈아 띄운다 — 사람의 [재시작](새 MCP config·지시문을 읽히려고).
   * 오퍼레이터는 SIGTERM(진행 중인 턴을 마치고 물러남) 뒤 배정을 보고 바로 다시 띄운다.
   * 모르는 옛 오퍼레이터는 이 프레임을 버린다(파서가 null) — 러너는 그대로 돈다.
   */
  | { type: 'agent.restart'; agentId: string }
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
  'pty.output', 'pty.replay', 'interactive.opened', 'interactive.error', 'attention.required', 'status',
]);
const SERVER_TYPES = new Set<ServerToOperatorFrame['type']>([
  'assign', 'unassign', 'agent.restart', 'runner.kill', 'pty.replay.request', 'pty.input', 'pty.resize', 'viewer.count', 'session.cancel', 'interactive.open',
]);

/** `hello` 와 배정 셋(`assign`·`unassign`·`agent.restart`)만 러너 밖의 말이다 — 나머지는 전부 `runnerId` 가 있어야 한다. */
const NO_RUNNER_ID = new Set<string>(['hello', 'capabilities', 'status', 'assign', 'unassign', 'agent.restart']);

function parse(raw: string, known: Set<string>): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.type !== 'string' || !known.has(frame.type)) return null;
  if (!NO_RUNNER_ID.has(frame.type) && typeof frame.runnerId !== 'string') return null;
  if (frame.type === 'agent.restart' && typeof frame.agentId !== 'string') return null;
  // 버전이 틀린 모양이면 hello 를 버리지 않고 버전만 뗀다 — 버전 하나 때문에 배정·러너가 끊기면
  // 안 되고, 틀린 값을 기준으로 삼으면 멀쩡한 러너가 뒤처졌다고 뜬다. 없음은 "모른다"다.
  if (frame.type === 'hello' && 'version' in frame && !isVersionString(frame.version)) delete frame.version;
  return frame;
}

/** 오퍼레이터 버전으로 받을 수 있는 값 — 빈 문자열이 아니고 짧은 문자열(`operator.version` 칸). */
export function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 64;
}

export function parseOperatorFrame(raw: string): OperatorToServerFrame | null {
  return parse(raw, OPERATOR_TYPES) as OperatorToServerFrame | null;
}

export function parseServerFrame(raw: string): ServerToOperatorFrame | null {
  return parse(raw, SERVER_TYPES) as ServerToOperatorFrame | null;
}

/** 박동의 머신 값 — sha256 hex 64자. 그 밖은 버린다(원래 machine-id 를 그대로 보낸 옛·틀린 구현 포함). */
export function isMachineDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

const CREDENTIAL_KINDS = new Set(['claude', 'codex', 'mcp', 'gh']);
const CREDENTIAL_STATES = new Set<OperatorCredentialState>(['present', 'expired', 'missing']);
const MAX_CREDENTIALS = 64;
const MAX_STATUS_AGENTS = 256;

const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
const shortText = (v: unknown, max = 64): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : null;

/**
 * 박동 본문을 **허용한 칸만** 골라 새 객체로 만든다. 모르는 키는 버린다 — 오퍼레이터가 실수로 토큰·경로
 * 같은 값을 실어도 서버가 들지 않고 화면에도 가지 않는다(H5: 자격 증명은 **상태만**, 값·만료 시각 없음).
 * 필수는 `turns.running` 하나다. 나머지 칸은 틀리면 그 칸만 뗀다(박동 하나 때문에 상태 전체를 잃지 않게).
 */
export function parseOperatorStatus(value: unknown): OperatorStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const turns = typeof v.turns === 'object' && v.turns !== null ? v.turns as Record<string, unknown> : null;
  const running = count(turns?.running, 10_000);
  if (running === null) return null;
  const out: OperatorStatus = { turns: { running, max: count(turns?.max, 10_000) || null } };
  const startedAt = shortText(v.startedAt, 40);
  if (startedAt && !Number.isNaN(Date.parse(startedAt))) out.startedAt = new Date(startedAt).toISOString();
  const bytes = (o: unknown): { totalBytes: number; freeBytes: number } | undefined => {
    if (typeof o !== 'object' || o === null) return undefined;
    const r = o as Record<string, unknown>;
    const total = count(r.totalBytes);
    const free = count(r.freeBytes);
    return total !== null && free !== null && free <= total ? { totalBytes: total, freeBytes: free } : undefined;
  };
  const memory = bytes(v.memory);
  if (memory) {
    out.memory = memory;
    const turnRss = count((v.memory as Record<string, unknown>).turnRssBytes);
    if (turnRss !== null) out.memory.turnRssBytes = turnRss;
  }
  const disk = bytes(v.disk);
  if (disk) out.disk = disk;
  if (Array.isArray(v.runners)) {
    const runners: { agentId: string; turns: number }[] = [];
    for (const r of v.runners.slice(0, MAX_STATUS_AGENTS)) {
      if (typeof r !== 'object' || r === null) continue;
      const agentId = shortText((r as Record<string, unknown>).agentId);
      const n = count((r as Record<string, unknown>).turns, 10_000);
      if (agentId && n !== null) runners.push({ agentId, turns: n });
    }
    out.runners = runners;
  }
  if (Array.isArray(v.credentials)) {
    const creds: NonNullable<OperatorStatus['credentials']> = [];
    for (const c of v.credentials.slice(0, MAX_CREDENTIALS)) {
      if (typeof c !== 'object' || c === null) continue;
      const r = c as Record<string, unknown>;
      const kind = typeof r.kind === 'string' && CREDENTIAL_KINDS.has(r.kind) ? r.kind as 'claude' | 'codex' | 'mcp' | 'gh' : null;
      const state = typeof r.state === 'string' && CREDENTIAL_STATES.has(r.state as OperatorCredentialState) ? r.state as OperatorCredentialState : null;
      const name = shortText(r.name);
      if (!kind || !state || !name) continue;
      const agentIds = Array.isArray(r.agentIds)
        ? r.agentIds.map((a) => shortText(a)).filter((a): a is string => a !== null).slice(0, MAX_STATUS_AGENTS)
        : [];
      creds.push({ kind, name, state, agentIds });
    }
    out.credentials = creds;
  }
  return out;
}

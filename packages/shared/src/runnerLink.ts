/**
 * 러너 ↔ 오퍼레이터 링크 — 스펙 2026-09-20 §5 PTY 행. **러너는 서버를 모른다.**
 *
 * 러너가 쓰는 말은 옛 릴레이 프레임(`RelayRunnerFrame`/`RelayServerFrame`) 그대로다 — 러너
 * 쪽에서 바뀐 것은 소켓의 상대(서버 WS → 오퍼레이터 unix 소켓)와 첫 줄(`hello`)뿐이고, 그것이
 * 이 단계의 요점이다: 러너 코어(`relay.ts` 의 세션·ring·재접속)는 손대지 않는다. 오퍼레이터가
 * 그 프레임에 `runnerId` 를 붙여 서버 채널(`operatorProtocol.ts`)에 싣고, 반대 방향에서는 뗀다.
 *
 * 이 모듈이 그 감싸기·풀기의 **유일한 정본**이다. 오퍼레이터(`relayMux.ts`)와 서버 릴레이 허브가
 * 같은 함수를 쓰므로 이름 대응(`output.data` ↔ `pty.output.bytes`)이 한 곳에만 산다 — 두 곳에
 * 적으면 한쪽만 고치는 날 PTY 바이트가 조용히 사라진다.
 *
 * ## 소켓 위의 모양
 *
 * 오퍼레이터의 unix 소켓은 앱 프로토콜(`daemonProtocol.ts`)과 **같은 파일**이다. NDJSON 이고 첫
 * 줄이 `hello` 인 것도 같다 — 다른 것은 `role: 'runner'` 와 인증 재료(`runnerId`+`secret`, 앱은
 * 토큰)뿐이다. 오퍼레이터는 첫 줄의 `role` 로 갈라 받는다. 그 뒤 줄들은 양쪽 다 릴레이 프레임
 * 한 개씩이다.
 */
import type { RelayRunnerFrame, RelayServerFrame } from './index.js';
import type { OperatorToServerFrame, ServerToOperatorFrame } from './operatorProtocol.js';

export const RUNNER_LINK_PROTOCOL_VERSION = 1;

/** 러너가 오퍼레이터 소켓에 보내는 첫 줄. secret 은 spawn 때 env 로 받은 1회성 값이다. */
export interface RunnerHello {
  type: 'hello';
  version: typeof RUNNER_LINK_PROTOCOL_VERSION;
  role: 'runner';
  runnerId: string;
  secret: string;
}

/** 모양만 본다 — secret 이 맞는지는 오퍼레이터가 자기 장부로 판정한다. */
export function checkRunnerHello(value: unknown): { runnerId: string; secret: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.type !== 'hello' || m.role !== 'runner' || m.version !== RUNNER_LINK_PROTOCOL_VERSION) return null;
  if (typeof m.runnerId !== 'string' || typeof m.secret !== 'string') return null;
  return { runnerId: m.runnerId, secret: m.secret };
}

/** 러너 → 오퍼레이터 프레임에 `runnerId` 를 붙여 서버 채널 프레임으로. 모르는 타입은 null. */
export function wrapRunnerFrame(runnerId: string, frame: RelayRunnerFrame): OperatorToServerFrame | null {
  switch (frame.type) {
    case 'announce':
      return { type: 'runner.announce', runnerId, sessions: frame.sessions, ...(frame.caps ? { caps: [...frame.caps] } : {}) };
    case 'session.started':
      return { type: 'session.started', runnerId, session: frame.session };
    case 'session.ended':
      return { type: 'session.ended', runnerId, sessionId: frame.sessionId };
    case 'output':
      return { type: 'pty.output', runnerId, sessionId: frame.sessionId, bytes: frame.data };
    case 'replay':
      return { type: 'pty.replay', runnerId, sessionId: frame.sessionId, bytes: frame.data };
    case 'interactive.opened':
      return { type: 'interactive.opened', runnerId, requestId: frame.requestId, sessionId: frame.sessionId, created: frame.created };
    case 'interactive.error':
      return { type: 'interactive.error', runnerId, requestId: frame.requestId, message: frame.message };
    case 'attention.required':
      return { type: 'attention.required', runnerId, sessionId: frame.sessionId, accountLabel: frame.accountLabel, screen: frame.screen };
    default:
      return null;
  }
}

/** 서버 채널 프레임에서 러너 프레임을 되찾는다. 오퍼레이터 자신의 말(hello·runner.*)은 null. */
export function unwrapOperatorFrame(frame: OperatorToServerFrame): { runnerId: string; frame: RelayRunnerFrame } | null {
  switch (frame.type) {
    case 'runner.announce':
      return { runnerId: frame.runnerId, frame: { type: 'announce', sessions: frame.sessions, ...(frame.caps ? { caps: frame.caps } : {}) } };
    case 'session.started':
      return { runnerId: frame.runnerId, frame: { type: 'session.started', session: frame.session } };
    case 'session.ended':
      return { runnerId: frame.runnerId, frame: { type: 'session.ended', sessionId: frame.sessionId } };
    case 'pty.output':
      return { runnerId: frame.runnerId, frame: { type: 'output', sessionId: frame.sessionId, data: frame.bytes } };
    case 'pty.replay':
      return { runnerId: frame.runnerId, frame: { type: 'replay', sessionId: frame.sessionId, data: frame.bytes } };
    case 'interactive.opened':
      return { runnerId: frame.runnerId, frame: { type: 'interactive.opened', requestId: frame.requestId, sessionId: frame.sessionId, created: frame.created } };
    case 'interactive.error':
      return { runnerId: frame.runnerId, frame: { type: 'interactive.error', requestId: frame.requestId, message: frame.message } };
    case 'attention.required':
      return { runnerId: frame.runnerId, frame: { type: 'attention.required', sessionId: frame.sessionId, accountLabel: frame.accountLabel, screen: frame.screen } };
    default:
      return null;
  }
}

/** 서버 → 러너 프레임에 `runnerId` 를 붙인다. */
export function wrapServerFrame(runnerId: string, frame: RelayServerFrame): ServerToOperatorFrame {
  switch (frame.type) {
    case 'replay.request':
      return { type: 'pty.replay.request', runnerId, sessionId: frame.sessionId };
    case 'input':
      return { type: 'pty.input', runnerId, sessionId: frame.sessionId, bytes: frame.data };
    case 'resize':
      return { type: 'pty.resize', runnerId, sessionId: frame.sessionId, cols: frame.cols, rows: frame.rows };
    case 'viewer.count':
      return { type: 'viewer.count', runnerId, sessionId: frame.sessionId, count: frame.count };
    case 'session.cancel':
      return { type: 'session.cancel', runnerId, sessionId: frame.sessionId, byHandle: frame.byHandle };
    case 'interactive.open':
      return {
        type: 'interactive.open', runnerId, requestId: frame.requestId, channelId: frame.channelId,
        threadRootId: frame.threadRootId, openedByHandle: frame.openedByHandle,
        ...(frame.cols !== undefined ? { cols: frame.cols } : {}),
        ...(frame.rows !== undefined ? { rows: frame.rows } : {}),
      };
  }
}

/** 서버 채널 프레임에서 러너에게 갈 프레임을 되찾는다. 배정·kill 같은 오퍼레이터의 말은 null. */
export function unwrapServerFrame(frame: ServerToOperatorFrame): RelayServerFrame | null {
  switch (frame.type) {
    case 'pty.replay.request':
      return { type: 'replay.request', sessionId: frame.sessionId };
    case 'pty.input':
      return { type: 'input', sessionId: frame.sessionId, data: frame.bytes };
    case 'pty.resize':
      return { type: 'resize', sessionId: frame.sessionId, cols: frame.cols, rows: frame.rows };
    case 'viewer.count':
      return { type: 'viewer.count', sessionId: frame.sessionId, count: frame.count };
    case 'session.cancel':
      return { type: 'session.cancel', sessionId: frame.sessionId, byHandle: frame.byHandle };
    case 'interactive.open':
      return {
        type: 'interactive.open', requestId: frame.requestId, channelId: frame.channelId,
        threadRootId: frame.threadRootId, openedByHandle: frame.openedByHandle,
        ...(frame.cols !== undefined ? { cols: frame.cols } : {}),
        ...(frame.rows !== undefined ? { rows: frame.rows } : {}),
      };
    default:
      return null;
  }
}

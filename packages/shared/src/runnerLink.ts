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

/**
 * 러너 링크(relay·bridge) 한 줄의 바이트 상한 — 데몬 제어 채널의 `MAX_LINE_BYTES`(1MiB)와 **따로** 둔다.
 *
 * 이 링크는 MCP 결과와 REST 본문을 그대로 나른다. 서버 `attachment.fetch` 는 3MiB 까지의 그림을
 * base64(4/3배)로 한 줄에 싣고, 텍스트는 4MiB 까지 싣는다. 1MiB 를 같이 쓰던 동안 원본 약 786KB
 * 를 넘는 그림의 답이 오퍼레이터에서 조용히 버려져 브릿지가 90초 뒤 시간 초과를 냈다(2026-10-02).
 * 16MiB 는 그 최대치의 네 배이고, 폭주하는 상대를 막는 상한이라는 원래 뜻은 그대로 남는다.
 */
export const RUNNER_LINK_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * 오퍼레이터가 러너를 spawn 할 때 심는 링크 env 셋의 **이름**(`assignments.ts`). 러너 코어
 * (`agent/src/config.ts`)와 하네스가 띄우는 `mcp-bridge`(`operator/src/main.ts`)가 같은 셋을 읽는다.
 *
 * **한 벌로 두는 이유**(2026-09-29 실측): codex 는 stdio MCP 자식에게 부모 env 를 통째로 넘기지
 * 않는다 — 자기 기본 목록(PATH·HOME 등)과 항목의 `env`·`env_vars` 에 적힌 것만 넘긴다. 그래서
 * 러너가 codex 에 거는 harkroom 항목이 이 셋을 `env_vars` 로 **이름을 대어** 달라고 해야 하고
 * (`agent/src/turn.ts` CODEX_PRESET.mcp), 그 이름이 읽는 쪽과 한 글자라도 어긋나면 브릿지는
 * "이 필요하다" 를 찍고 죽는다 — codex 는 그 죽음을 화면에 안 띄우고 도구 없이 돈다.
 */
export const RUNNER_LINK_ENV = {
  socketPath: 'HARKROOM_OPERATOR_SOCKET',
  runnerId: 'HARKROOM_RUNNER_ID',
  secret: 'HARKROOM_RUNNER_SECRET',
} as const;

/**
 * **이 턴을 띄운 메시지**(멘션 연쇄의 앞 고리, 2026-09-29). 러너가 턴마다 하네스 env 에 심고,
 * 하네스가 띄운 브릿지가 읽어 `mcp.request.cause` 로 싣고, 오퍼레이터가 `CAUSE_HEADER` 로
 * 서버에 넘긴다. 서버는 이 메시지에서 연쇄 깊이를 물려받는다 — 사람이 #task 에서 한 지시로
 * 뜬 턴이 **다른 스레드에** 쓴 부름도 "사람이 시작한 사슬"로 셀 수 있게.
 *
 * 링크 셋과 달리 **없어도 된다**(옛 러너·대화형 턴). 없으면 서버는 스레드를 훑던 옛 셈으로 간다.
 */
export const RUNNER_TURN_CAUSE_ENV = 'HARKROOM_TURN_CAUSE';
/**
 * **브릿지가 `tools/list` 에 답한 뒤 만들 표식 파일**(2026-10-10, 스레드 20914e42). 러너가 턴마다 새 경로를
 * 심고, 그 파일이 생길 때까지(시한 있음) 프롬프트를 넣지 않는다 — 하네스가 harkroom 도구를 받기 전에 첫
 * 호출을 내면 이어 받은 세션의 캐시가 깨진다(`agent/src/mentionTurn.ts` 의 `mcpReadyFile`).
 * 없으면 브릿지는 아무것도 안 쓴다. 파일은 비어 있다 — 있는가만 뜻이 있다.
 */
export const RUNNER_MCP_READY_FILE_ENV = 'HARKROOM_MCP_READY_FILE';
/** 오퍼레이터 → 서버 `/mcp` 요청에서 `RUNNER_TURN_CAUSE_ENV` 값을 싣는 헤더. */
export const CAUSE_HEADER = 'x-harkroom-cause';
/**
 * 「정확한 명령」 권한 요청(H③a)의 파일 해시 — **오퍼레이터가** 그 명령의 파일 자리(shared `validateExactCommand.files`)를 재서
 * `/mcp` 요청에 싣는 헤더(base64 JSON `CommandFileDigest[]`). MCP 본문이 아니라 헤더인 이유: 본문은 에이전트가 쓰고, 헤더는
 * 오퍼레이터만 쓴다(브릿지 프레임의 어떤 칸도 이 헤더로 옮기지 않는다). 이 헤더가 없는 요청(옛 오퍼레이터)은 파일이 있는 명령을 못 청한다.
 */
export const COMMAND_FILES_HEADER = 'x-harkroom-command-files';
export interface CommandFileDigest { path: string; sha256: string; size: number; preview?: string }

/** `RUNNER_LINK_ENV` 의 이름들 — 순서는 사람에게 보이는 오류 문구의 순서다. */
export const RUNNER_LINK_ENV_KEYS = [
  RUNNER_LINK_ENV.socketPath,
  RUNNER_LINK_ENV.runnerId,
  RUNNER_LINK_ENV.secret,
] as const;

/**
 * 러너가 오퍼레이터 소켓에 보내는 첫 줄. secret 은 spawn 때 env 로 받은 1회성 값이다.
 *
 * `kind` — 같은 자격으로 붙는 소켓이 둘이다(스펙 §5): 러너 코어의 **relay**(PTY 프레임과
 * 요청/응답 전부, 러너당 하나)와, 하네스가 띄우는 `harkroom-operator mcp-bridge` 프로세스의
 * **bridge**(요청/응답만, 러너당 여럿일 수 있다 — 하네스가 MCP 서버를 여러 번 띄운다).
 * 생략은 relay 다.
 */
export interface RunnerHello {
  type: 'hello';
  version: typeof RUNNER_LINK_PROTOCOL_VERSION;
  role: 'runner';
  runnerId: string;
  secret: string;
  kind?: 'relay' | 'bridge';
}

/** 모양만 본다 — secret 이 맞는지는 오퍼레이터가 자기 장부로 판정한다. */
export function checkRunnerHello(value: unknown): { runnerId: string; secret: string; kind: 'relay' | 'bridge' } | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.type !== 'hello' || m.role !== 'runner' || m.version !== RUNNER_LINK_PROTOCOL_VERSION) return null;
  if (typeof m.runnerId !== 'string' || typeof m.secret !== 'string') return null;
  if (m.kind !== undefined && m.kind !== 'relay' && m.kind !== 'bridge') return null;
  return { runnerId: m.runnerId, secret: m.secret, kind: m.kind === 'bridge' ? 'bridge' : 'relay' };
}

// ---------------------------------------------------------------------------
// 요청/응답 — 러너가 서버에 하던 말을 오퍼레이터가 대신 한다(스펙 §5 MCP 행).
//
// 러너 코어의 MCP 클라이언트와 하네스의 stdio 브릿지는 JSON-RPC 메시지 한 개를 `mcp.request`
// 로 싣고, 오퍼레이터가 그것을 서버 `/mcp` 에 HTTPS POST 로 넘긴다(오퍼레이터 토큰 +
// `X-Harkroom-Agent`). 러너 코어가 부르던 REST(`/agent/config` 등)는 `http.forward` 하나로
// 싣는다 — 프레임은 다르고 인증 치환 규칙은 하나다. 러너용 REST 표면을 오퍼레이터에 따로
// 만들지 않는다.
//
// `id` 는 링크 위의 상관 키다(JSON-RPC 의 id 와 별개 — 알림에는 JSON-RPC id 가 없다).
// ---------------------------------------------------------------------------

export type RunnerLinkRequest =
  /** `cause` — 이 요청을 낸 턴을 띄운 메시지 id(`RUNNER_TURN_CAUSE_ENV`). 옛 브릿지는 싣지 않는다. */
  /**
   * `cwd` — 브릿지 프로세스의 작업 디렉터리(= 하네스가 띄운 턴 워크스페이스, claude 실측 2026-10-02).
   * 오퍼레이터의 `attachment.upload` 가 경로를 이 아래로만 받는 데 쓴다. 옛 브릿지·러너 코어는 싣지 않는다.
   */
  | { type: 'mcp.request'; id: string; payload: unknown; cause?: string; cwd?: string }
  /** `bodyBase64` — 이진 본문(multipart 업로드). 있으면 `body` 대신 이것을 바이트로 풀어 보낸다. */
  | { type: 'http.forward'; id: string; method: string; path: string; body?: string; bodyBase64?: string; contentType?: string };

export type RunnerLinkResponse =
  /** 서버가 돌려준 JSON-RPC 메시지들. 알림(202)이면 빈 배열. */
  | { type: 'mcp.response'; id: string; messages: unknown[] }
  /** 서버가 HTTP 로 거절했다(401·403·5xx). 러너의 자격증명 판정이 `status` 를 읽는다. */
  | { type: 'mcp.error'; id: string; status: number; message: string }
  | { type: 'http.response'; id: string; status: number; body: string };

/**
 * 러너 → 오퍼레이터 **단방향 통지.** 답이 없고, 서버로도 안 나간다 — 오퍼레이터 안에서 끝난다.
 *
 * `runner.pollStopped`: SIGTERM 을 받은 러너가 **폴 루프를 빠져나왔다**. 그 순간부터 이 러너는
 * 인박스에서 새 항목을 집지 않으므로, 오퍼레이터는 **프로세스가 죽기를 기다리지 않고** 교체
 * 러너를 띄울 수 있다(`operator/src/runners.ts` 의 회수 게이트). 남은 턴은 이 프로세스가
 * 마저 끝낸다.
 *
 * `holding` — 아직 도는 턴의 inbox entry id 들. `markRead` 는 턴 **완료 후**라 이것들은
 * 여전히 미읽음이고, 그대로 두면 **교체 러너가 같은 멘션을 다시 집어 두 번 답한다.**
 * 오퍼레이터가 이 목록을 교체 러너에게 넘겨 그동안만 건너뛰게 한다.
 *
 * `done` — **턴은 끝났는데 읽음 처리만 못 한** entry id 들(2026-10-03, #1119 후속 L2). 서버 링크가
 * 끊긴 채 물러나는 러너가 남기는 것이다. `holding` 과 다르다: 이것들은 기다릴 턴이 없으므로 교체
 * 러너는 보류 시한과 무관하게 **읽음 처리만** 한다 — 턴을 띄우면 끝난 일에 두 번째 턴이 선다.
 * 생략은 "없다"다(이 필드를 모르는 옛 러너).
 */
export type RunnerLinkNotice =
  | { type: 'runner.pollStopped'; holding: number[]; done?: number[] }
  | McpAuthRejectedNotice
  | SecretLeaseNotice
  | SecretLeaseEndedNotice;

/**
 * 비밀 보관소(PR 3): 러너가 멘션을 집으며 받은 **턴 임대**를 오퍼레이터에 맡긴다.
 *
 * 토큰은 **러너 → 오퍼레이터 relay 소켓으로만** 간다. 하네스의 env·프롬프트·argv 어디에도 싣지
 * 않는다(security R2) — 모델 문맥에 실리면 transcript 에 남는다. 브릿지가 `secret.mount` 를 부르면
 * 오퍼레이터가 이 임대로 서버에서 값을 받아 턴 전용 파일에 쓰고, 모델에게는 경로만 준다.
 * `cause` 는 그 턴의 원인 메시지 id(`RUNNER_TURN_CAUSE_ENV`)다 — 브릿지 요청과 임대를 잇는 키다.
 * 브릿지 소켓으로 온 통지는 오퍼레이터가 버린다(`runnerLink.ts` 의 kind 분기) — relay 만 맡길 수 있다.
 */
export type SecretLeaseNotice = { type: 'secret.lease'; cause: string; leaseId: string; token: string; expiresAt: string };
/** 그 멘션의 일이 끝났다 — 오퍼레이터는 임대를 끝내고 턴 디렉터리를 지운다. */
export type SecretLeaseEndedNotice = { type: 'secret.leaseEnded'; cause: string };

/**
 * `mcp.authRejected`(2026-10-01): 하네스가 **오퍼레이터가 구워 준 `Authorization` 헤더를 MCP
 * 서버에 거절당했다**(claude 기록의 `failedMcpServers[].errorCode === 'AUTH_HEADER_REJECTED'`).
 *
 * 헤더가 있으면 claude 는 자기 OAuth 로 물러나지 않는다 — 그 턴의 MCP 는 그냥 죽는다. 토큰은
 * 오퍼레이터가 들고 있고(`operator/src/mcpOAuth.ts`), 오퍼레이터는 만료 시각만 보고 refresh
 * 하므로 **만료 전에 무효가 된 토큰**(10-01 slack, 12:08~14:51 KST 연속 401)을 스스로는 모른다.
 * 그래서 데스크톱도 "인증됨"을 띄웠다. 이 통지가 그 사실을 오퍼레이터에 돌려준다.
 *
 * `servers` — 거절당한 MCP 서버 **이름**(오퍼레이터 레지스트리의 키). 토큰도 에러 문구도
 * 싣지 않는다: 이름이면 오퍼레이터가 무엇을 할지 정하기에 충분하다.
 *
 * `turnStartedAtMs` — 거절당한 턴이 **시작된 시각**(같은 기계의 시계). 그 턴의 하네스는 그때의
 * 설정(그때의 토큰)으로 떴다. 오퍼레이터는 이것을 토큰을 받은 시각과 비교해, 이미 바꾼 옛
 * 토큰에 대한 늦은 보고(동시에 돌던 다른 턴)를 새 토큰의 실패로 읽지 않는다.
 */
export type McpAuthRejectedNotice = { type: 'mcp.authRejected'; servers: string[]; turnStartedAtMs: number };

/**
 * 오퍼레이터 → 러너 **단방향 통지.** 서버에서 오는 말이 아니라 오퍼레이터가 하는 말이다.
 *
 * `handover.released`: 앞 세대 러너가 **완전히 물러났다**. 그 러너가 들고 있던 entry 를
 * 더 건너뛸 이유가 없다 — 이관 보류를 지금 푼다.
 *
 * 보류의 **주인은 오퍼레이터**다. 러너는 spawn 때 받은 목록을 들고만 있고, 언제 놓을지는
 * 앞 러너의 생사를 보는 쪽이 정한다. 러너가 스스로 시한만으로 풀면, 앞 러너가 1초 만에
 * 끝난 경우에도 남은 시한 내내 그 항목을 건너뛴다.
 */
export type OperatorToRunnerNotice = { type: 'handover.released' };

export function isOperatorToRunnerNotice(value: unknown): value is OperatorToRunnerNotice {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'handover.released';
}

export function isRunnerLinkNotice(value: unknown): value is RunnerLinkNotice {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.type === 'mcp.authRejected') {
    return Array.isArray(m.servers) && m.servers.length > 0 && m.servers.every((v) => typeof v === 'string' && v.length > 0)
      && typeof m.turnStartedAtMs === 'number' && Number.isFinite(m.turnStartedAtMs);
  }
  const str = (v: unknown, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (m.type === 'secret.lease') return str(m.cause) && str(m.leaseId) && str(m.token) && str(m.expiresAt);
  if (m.type === 'secret.leaseEnded') return str(m.cause);
  if (m.type !== 'runner.pollStopped') return false;
  const ids = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isInteger(x));
  return ids(m.holding) && (m.done === undefined || ids(m.done));
}

const REQUEST_TYPES = new Set(['mcp.request', 'http.forward']);
const RESPONSE_TYPES = new Set(['mcp.response', 'mcp.error', 'http.response']);

export function isRunnerLinkRequest(value: unknown): value is RunnerLinkRequest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.type === 'string' && REQUEST_TYPES.has(m.type) && typeof m.id === 'string';
}

export function isRunnerLinkResponse(value: unknown): value is RunnerLinkResponse {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.type === 'string' && RESPONSE_TYPES.has(m.type) && typeof m.id === 'string';
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

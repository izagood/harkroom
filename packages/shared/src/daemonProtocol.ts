/**
 * daemon 과 앱이 unix 소켓 위에서 주고받는 **말의 정의**다 — `#431` 2단계-b, D6.
 *
 * 2단계-a 가 만든 것은 소켓 **파일**을 누가 갖느냐였다(`daemonEndpoint.ts`).
 * 이 모듈은 그 소켓 안에서 **무엇이 오가느냐**를 정한다. 서버(daemon)도 클라이언트(앱)도
 * 여기 있는 것만 쓰고, 어느 쪽도 자기 자리에서 프레이밍이나 인증을 다시 짜지 않는다 —
 * 두 곳에 같은 규칙이 유지되면 한쪽만 고쳐지는 날이 온다.
 *
 * ## 왜 `src/index.ts` 가 아니라 서브패스인가
 *
 * `index.ts` 는 **Node 의존이 없는 순수 타입**이고 데스크탑 웹뷰가 직접 import 한다.
 * 이 모듈은 `node:crypto` 를 쓴다. 기본 진입점에 얹으면 브라우저 번들이 깨진다 —
 * 2단계-a 가 `daemonEndpoint` 를 `@murmur/shared/daemonEndpoint` 로 낸 것과 같은 이유다.
 *
 * ## 왜 자체 스키마인가 (JSON-RPC 가 아니라)
 *
 * 오가는 말이 네 종류(`spawnRunner`·`killRunner`·`listRunners`·`ping`)뿐이고, 양쪽 다
 * 우리가 쓴다. JSON-RPC 의 값은 **모르는 상대와도 통한다**는 것인데 여기엔 모르는 상대가
 * 없다. 규격을 하나 더 들이면 그 규격의 에러 코드 체계와 우리 실패 갈래를 맞추는 일이
 * 새로 생긴다.
 *
 * ## `sessions.json` 은 여기 없다 (`#431` D5)
 *
 * 이 프로토콜에 세션 상태를 실어 나르는 메시지는 **없고, 만들면 안 된다.** 세션 상태의
 * 원자성은 "쓰는 주체가 하나"에서 나오고 그 writer 는 러너다. daemon 이 그 파일의 두 번째
 * writer 가 되면 lost update 가 조용히 난다. daemon 이 소유하는 것은 **프로세스**이지
 * 세션이 아니다.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { DAEMON_PROTOCOL_VERSION } from './daemonEndpoint.js';

/**
 * 이 프로토콜의 버전 — **`daemonEndpoint` 의 것을 그대로 다시 낸다.**
 *
 * 두 곳에서 따로 선언하면 소켓 파일명은 `daemon-v1.sock` 인데 `hello` 는 v2 를 말하는
 * 상태가 될 수 있고, 그러면 세대 격리가 **반쪽만** 선다 — 파일명으로는 갈렸는데 말로는
 * 안 갈렸거나 그 반대다. 값이 하나여야 그 어긋남이 원리적으로 불가능하다.
 */
export { DAEMON_PROTOCOL_VERSION };

/**
 * 한 줄의 바이트 상한. **이것이 없으면 폭주하는 러너 출력이 메모리를 터뜨린다.**
 *
 * NDJSON 디코더는 개행을 만날 때까지 버퍼에 쌓는다. 상대가 개행을 영영 안 보내면 —
 * 버그든 악의든, 러너 하나가 개행 없이 수백 MB 를 쏟든 — 그 버퍼는 무한히 자란다.
 * 프로세스가 OOM 으로 죽는 것은 daemon 이 가장 하면 안 되는 일이다: daemon 이 죽으면
 * 러너는 살아남지만 아무도 소유하지 않는 고아가 된다.
 *
 * 1MiB 는 우리가 실제로 보내는 것보다 두 자릿수 크다 — `listRunners` 응답이 러너 수십
 * 개를 실어도 수십 KB 다. 즉 이 상한에 닿는 것은 **정상 트래픽이 아니라 사고**이고,
 * 그래서 잘라내거나 조용히 넘기지 않고 **연결을 끊을 근거가 되는 에러**로 만든다.
 */
export const MAX_LINE_BYTES = 1024 * 1024;

/** 요청 종류 — **2단계-b 는 이 넷뿐이다.** */
export const REQUEST_TYPES = ['spawnRunner', 'killRunner', 'listRunners', 'ping'] as const;
export type DaemonRequestType = (typeof REQUEST_TYPES)[number];

/**
 * daemon 이 자기를 밝히는 값 — `hello` 응답에 실린다.
 *
 * pid 파일(`DaemonPidRecord`)과 **같은 내용을 소켓으로도** 준다. 파일은 접속 전에 읽는
 * 것이고 이것은 접속 후에 받는 것인데, 둘이 어긋나면 그 자체가 "내가 붙은 daemon 은
 * 파일을 쓴 그 daemon 이 아니다"라는 신호다 — 잔해를 물려받은 daemon 이나 pid 재사용을
 * 앱이 이 대조로 잡는다. `launchNonce` 가 그 비교의 축이다.
 */
export interface DaemonIdentity {
  pid: number;
  startedAtMs: number;
  launchNonce: string;
  entryPath: string;
  appVersion: string;
}

/** 붙는 쪽이 자기가 무엇인지 밝히는 값. 지금은 앱만 붙는다. */
export type ClientRole = 'app';

/** 첫 메시지. **이것 전에는 아무 요청도 받지 않는다.** */
export interface HelloMessage {
  type: 'hello';
  version: number;
  token: string;
  role: ClientRole;
}

/** `hello` 에 대한 답. 거절이면 `ok: false` 와 사유만 온다. */
export type HelloResult =
  | { ok: true; daemon: DaemonIdentity }
  | { ok: false; error: DaemonError };

export interface DaemonRequest {
  id: string;
  type: DaemonRequestType;
  payload?: unknown;
}

export interface DaemonResponse {
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: DaemonError;
}

export interface DaemonEventMessage {
  type: 'event';
  event: DaemonEventName;
  payload: unknown;
}

export const EVENT_NAMES = ['runnerExit'] as const;
export type DaemonEventName = (typeof EVENT_NAMES)[number];

/**
 * 실패의 갈래. **코드가 사유이고, 메시지는 사람이 읽는 덧말이다**(`#368`).
 *
 * `line-too-long` 이 `invalid-json` 과 **따로 있는 것이 요점**이다. 상한을 넘긴 줄은
 * 파싱을 시도조차 못 하므로, 둘을 한 갈래로 뭉치면 "상대가 깨진 JSON 을 보냈다"와
 * "상대가 우리를 터뜨리려 한다(또는 폭주하고 있다)"가 같은 로그로 남는다. 앞의 것은
 * 버그 리포트이고 뒤의 것은 연결을 끊을 사건이다.
 */
export type DaemonErrorCode =
  /** 줄이 `MAX_LINE_BYTES` 를 넘었다. 파싱 이전의 사고다. */
  | 'line-too-long'
  /** 줄이 JSON 이 아니거나 우리 스키마가 아니다. */
  | 'invalid-json'
  /** `hello` 의 프로토콜 버전이 우리 것과 다르다. */
  | 'version-mismatch'
  /** 토큰이 다르다(또는 없다). */
  | 'unauthorized'
  /** `hello` 전에 다른 것을 보냈다. */
  | 'not-authenticated'
  /** 모르는 요청 종류다. */
  | 'unknown-request'
  /** 요청은 알겠는데 payload 가 계약과 다르다. */
  | 'bad-payload'
  /** 요청 대상 러너가 daemon 에 없다. */
  | 'no-such-runner'
  /** daemon 이 그 일을 하다 실패했다. `message` 가 원문이다. */
  | 'internal';

export interface DaemonError {
  code: DaemonErrorCode;
  message: string;
}

export function daemonError(code: DaemonErrorCode, message: string): DaemonError {
  return { code, message };
}

/** 상한 초과는 예외가 아니라 **값**으로 흐른다 — 아래 `decodeLines` 주석 참조. */
export class LineTooLongError extends Error {
  readonly code = 'line-too-long' as const;
  constructor(readonly byteLength: number, readonly limit: number) {
    super(`한 줄이 상한을 넘었다: ${byteLength} > ${limit} 바이트`);
    this.name = 'LineTooLongError';
  }
}

// ---------------------------------------------------------------------------
// NDJSON 프레이밍
// ---------------------------------------------------------------------------

/**
 * 한 메시지를 한 줄로 만든다.
 *
 * **여기서도 상한을 잰다.** 보내는 쪽에서 막지 않으면 상대가 끊고, 그러면 원인이
 * "상대가 이유 없이 끊었다"로 보인다 — 실제 원인(내가 너무 큰 것을 만들었다)은 내 쪽에
 * 있는데 증거는 상대 쪽에만 남는다. 만든 자리에서 던지면 그 자리가 그대로 스택에 남는다.
 */
export function encodeLine(message: unknown, limit: number = MAX_LINE_BYTES): string {
  const json = JSON.stringify(message);
  if (json === undefined) throw new TypeError('JSON 으로 만들 수 없는 메시지다');
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > limit) throw new LineTooLongError(bytes, limit);
  return `${json}\n`;
}

/** 디코더가 한 청크에서 뽑아낸 결과. 성공한 줄과 실패한 줄이 **섞여서** 순서대로 온다. */
export type DecodedLine =
  | { ok: true; value: unknown }
  | { ok: false; error: DaemonError };

/**
 * 청크를 받아 완성된 줄만 내놓는 디코더.
 *
 * ## 왜 상태를 갖는가 — 부분 수신
 *
 * TCP 든 unix 소켓이든 **청크 경계와 줄 경계는 무관하다.** 한 JSON 이 세 청크로 쪼개져
 * 올 수도, 세 JSON 이 한 청크로 붙어 올 수도 있다. 청크마다 `JSON.parse` 를 시도하는
 * 디코더는 조용히 두 방향으로 다 틀린다 — 쪼개진 것은 파싱 실패로 버리고, 붙은 것은
 * 하나만 읽고 나머지를 잃는다. 그래서 이 디코더는 **개행이 나올 때까지 들고 있는다.**
 *
 * ## 왜 에러를 던지지 않고 값으로 주는가
 *
 * 한 청크에 여러 줄이 들어 있을 때, 세 번째 줄이 깨졌다고 앞의 두 줄을 잃으면 안 된다.
 * 던지면 그 청크 전체의 처리가 중단되고 이미 파싱한 것이 사라진다. 값으로 주면 호출부가
 * "앞의 둘은 처리하고, 셋째는 에러 응답을 보내고 연결을 끊는다"를 자기 정책대로 정한다.
 *
 * ## 상한을 넘겼을 때 — 그 줄은 **버린다**
 *
 * 상한을 넘긴 버퍼를 들고 있으면 상한을 둔 의미가 없다. 그래서 즉시 비우고,
 * **다음 개행까지도 버린다** — 남은 꼬리를 다음 줄의 머리로 읽으면 그 다음 줄까지
 * 깨진 것으로 오인하고, 상대가 개행 없이 계속 보내는 동안 에러가 무한히 나온다.
 * 호출부는 `line-too-long` 을 받으면 연결을 끊는 것이 정상 대응이다.
 */
export class NdjsonDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  /** 상한을 넘긴 뒤 "다음 개행까지 버리는 중"인가. */
  private discarding = false;

  constructor(private readonly limit: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer | string): DecodedLine[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);

    const out: DecodedLine[] = [];
    for (;;) {
      const nl = this.buffer.indexOf(0x0a);

      if (nl === -1) {
        if (this.discarding) {
          // 버리는 중이면 쌓아 둘 이유가 없다. 개행만 기다린다.
          this.buffer = Buffer.alloc(0);
          return out;
        }
        // 아직 줄이 안 끝났다. **여기서도 상한을 잰다** — 개행을 기다리는 동안 버퍼가
        // 자라는 것이 바로 이 상한이 막으려는 사고이므로, 줄이 완성될 때까지 기다렸다가
        // 재면 이미 늦다.
        if (this.buffer.length > this.limit) {
          out.push({ ok: false, error: this.tooLong(this.buffer.length) });
          this.buffer = Buffer.alloc(0);
          this.discarding = true;
        }
        return out;
      }

      const line = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);

      if (this.discarding) {
        // 넘긴 줄의 꼬리를 여기서 끝낸다. 이 줄 자체는 이미 보고했다.
        this.discarding = false;
        continue;
      }
      if (line.length > this.limit) {
        out.push({ ok: false, error: this.tooLong(line.length) });
        continue;
      }
      const text = line.toString('utf8').trim();
      if (text.length === 0) continue; // 빈 줄은 하트비트로도 쓰이는 무해한 것이다.
      try {
        out.push({ ok: true, value: JSON.parse(text) });
      } catch (err) {
        out.push({
          ok: false,
          error: daemonError('invalid-json', err instanceof Error ? err.message : String(err)),
        });
      }
    }
  }

  private tooLong(byteLength: number): DaemonError {
    return daemonError(
      'line-too-long',
      `한 줄이 상한을 넘었다: ${byteLength} > ${this.limit} 바이트`,
    );
  }

  /** 지금 들고 있는 미완성 바이트 수. 회귀선이 "쌓이지 않는다"를 재는 자리다. */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

// ---------------------------------------------------------------------------
// 인증
// ---------------------------------------------------------------------------

/**
 * 토큰을 **상수시간으로** 비교한다.
 *
 * ## 왜 상수시간인가
 *
 * 소켓은 0600 이고 로컬이다. 그래서 실질 위험은 낮다 — 이 비교를 뚫으려면 같은 uid 로
 * 이미 코드를 돌리고 있어야 하고, 그 지경이면 토큰 파일을 그냥 읽으면 된다.
 * **그런데도 상수시간으로 하는 이유는 공짜이기 때문이다.** `===` 는 첫 다른 바이트에서
 * 멈추므로 "몇 글자가 맞았나"가 시간에 샌다. 재접속에 제한이 없는 로컬 소켓에서 그
 * 누출은 원리적으로 토큰을 한 바이트씩 복원할 수 있게 한다. 방어를 나중에 넣는 것보다
 * 처음부터 이 함수를 통과시키는 편이 싸다.
 *
 * ## 길이가 다를 때
 *
 * `timingSafeEqual` 은 길이가 다르면 **던진다.** 그래서 길이를 먼저 봐야 하는데, 그러면
 * "길이가 맞나"는 시간에 새는 것 아닌가 — 맞다. 그리고 그것은 **받아들이는 누출**이다:
 * 토큰 길이는 우리가 고정한 상수(UUID)라 비밀이 아니고, 길이를 숨기려면 패딩이라는
 * 새 규칙이 필요한데 얻는 것이 없다.
 *
 * 중요한 것은 **길이가 같을 때 반드시 `timingSafeEqual` 로 간다**는 것이다. 그 자리를
 * `===` 로 바꾸면 "몇 바이트까지 맞았나"가 새고, 그때 이 함수는 이름만 남는다.
 * `daemonProtocol.test.ts` 의 "상수시간 비교" 회귀선이 그 변경을 잡으려고 있다.
 */
export function tokensMatch(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // 길이가 다르면 여기서 끝난다 — 위 주석의 "받아들이는 누출"이다.
  if (a.length !== b.length) return false;
  if (a.length === 0) return false; // 빈 토큰은 어떤 경우에도 통과시키지 않는다.
  return timingSafeEqual(a, b);
}

/** `hello` 를 검사한 결과. daemon 서버가 이 값을 보고 붙일지 끊을지 정한다. */
export type HelloCheck =
  | { ok: true; role: ClientRole }
  | { ok: false; error: DaemonError };

/**
 * `hello` 메시지를 검사한다.
 *
 * **버전을 토큰보다 먼저 본다.** 버전이 다르면 토큰이 맞아도 그 다음에 오는 말을 서로
 * 못 알아듣는다 — 인증에 성공했다고 알려 주고 나서 첫 요청에서 깨지는 것보다, 무엇이
 * 어긋났는지를 첫 답에 담는 편이 사람이 고칠 수 있다(`#368`).
 */
export function checkHello(
  message: unknown,
  expectedToken: string,
  expectedVersion: number = DAEMON_PROTOCOL_VERSION,
): HelloCheck {
  if (!isRecord(message) || message.type !== 'hello') {
    return { ok: false, error: daemonError('not-authenticated', '첫 메시지는 hello 여야 한다') };
  }
  if (typeof message.version !== 'number' || message.version !== expectedVersion) {
    return {
      ok: false,
      error: daemonError(
        'version-mismatch',
        `프로토콜 버전이 다르다: 이 daemon 은 v${expectedVersion}, 상대는 v${String(message.version)}`,
      ),
    };
  }
  if (message.role !== 'app') {
    return { ok: false, error: daemonError('bad-payload', `모르는 role 이다: ${String(message.role)}`) };
  }
  if (!tokensMatch(expectedToken, message.token)) {
    return { ok: false, error: daemonError('unauthorized', '토큰이 다르다') };
  }
  return { ok: true, role: 'app' };
}

// ---------------------------------------------------------------------------
// 요청·응답 payload
// ---------------------------------------------------------------------------

/**
 * 러너 하나의 세대 구분자.
 *
 * ## 왜 필요한가 — 늦게 온 exit 이 새 세대를 죽인다
 *
 * 같은 에이전트의 러너가 죽고 다시 뜨면, 옛 러너의 exit 통지가 **새 러너가 뜬 뒤에**
 * 도착할 수 있다. 소켓을 한 단계 더 거치는 daemon 구조에서는 그 창이 오히려 넓어진다.
 * 그때 `agentId` 만 보고 상태를 바꾸면 앱은 **살아 있는 새 러너를 죽은 것으로** 표시하고,
 * 그 표시를 믿고 또 하나를 띄운다 — 같은 에이전트에 러너가 둘이면 멘션을 나눠 집어 간다.
 *
 * `#419` 가 앱 안에서 `runTokens`(Symbol)로 같은 결함을 이미 한 번 막았다. 소켓 너머로는
 * Symbol 을 못 보내므로 **문자열 세대 구분자**로 같은 성질을 만든다: exit 이벤트에 실려
 * 오는 `incarnationId` 가 지금 아는 것과 다르면 그 통지는 **다른 세대의 사실**이므로
 * 버린다.
 */
export type IncarnationId = string;

export function newIncarnationId(): IncarnationId {
  return randomUUID();
}

export interface SpawnRunnerParams {
  agentId: string;
  /** 러너에게 넘길 환경변수. PAT 가 여기 실린다 — 로그로 흘리지 마라. */
  env: Record<string, string>;
}

export interface SpawnRunnerResult {
  agentId: string;
  pid: number;
  /** 이 spawn 이 만든 세대. 이후 이 러너의 모든 통지가 이 값을 달고 온다. */
  incarnationId: IncarnationId;
}

export interface KillRunnerParams {
  agentId: string;
  /**
   * **어느 세대를 죽이려는가.** 생략하면 "지금 것"이다.
   *
   * 실으면 daemon 이 세대가 어긋난 kill 을 거절한다 — 앱이 옛 세대를 죽이라고 보낸
   * 명령이 그 사이 새로 뜬 러너를 데려가는 것을 막는 자리다. spawn 과 kill 사이의
   * 왕복이 늦어질수록 이 창이 넓어진다.
   */
  incarnationId?: IncarnationId;
}

export interface RunnerInfo {
  agentId: string;
  pid: number;
  incarnationId: IncarnationId;
  startedAtMs: number;
}

export interface ListRunnersResult {
  runners: RunnerInfo[];
}

export interface PingResult {
  /** daemon 의 지금 시각. 앱이 시계 차이를 눈으로 볼 수 있게 그대로 준다. */
  nowMs: number;
}

/** 러너가 끝났다. **`incarnationId` 가 이 이벤트의 핵심 필드다** — 위 주석 참조. */
export interface RunnerExitEvent {
  agentId: string;
  incarnationId: IncarnationId;
  /** `null` 이면 시그널로 죽은 것이다(`RunnerProcess.onExit` 의 계약과 같다). */
  code: number | null;
  signal: string | null;
}

/**
 * 이 exit 통지를 받아들일 것인가.
 *
 * `known` 은 앱이 지금 그 에이전트에 대해 아는 세대다. `null` 이면 아는 러너가 없다는
 * 뜻이고, 그때도 **거절한다** — 이미 정리된 러너의 늦은 통지가 상태를 되살리면 안 된다.
 *
 * 이 판정이 한 줄짜리인 것은 맞다. 그래도 함수로 두는 이유는 **호출부마다 다시 쓰이면
 * 한 곳에서 `!==` 가 `==` 로 뒤집혀도 아무도 모르기 때문**이다. 회귀선을 걸 자리도
 * 여기 하나여야 한다.
 */
export function acceptRunnerExit(known: IncarnationId | null, event: RunnerExitEvent): boolean {
  if (known === null) return false;
  return known === event.incarnationId;
}

// ---------------------------------------------------------------------------
// 메시지 판별
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 디코드된 값이 요청인가. daemon 서버가 쓴다. */
export function parseRequest(value: unknown): DaemonRequest | DaemonError {
  if (!isRecord(value)) return daemonError('invalid-json', '객체가 아니다');
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return daemonError('bad-payload', 'id 가 없다');
  }
  if (typeof value.type !== 'string') return daemonError('bad-payload', 'type 이 없다');
  if (!(REQUEST_TYPES as readonly string[]).includes(value.type)) {
    // **`adoptRunner`·`shutdownIfIdle` 은 2-c·2-d 다.** 지금 오면 모르는 요청이 맞다.
    return daemonError('unknown-request', `모르는 요청이다: ${value.type}`);
  }
  return { id: value.id, type: value.type as DaemonRequestType, payload: value.payload };
}

/** 디코드된 값이 이벤트인가. 앱 클라이언트가 쓴다. */
export function parseEvent(value: unknown): DaemonEventMessage | null {
  if (!isRecord(value) || value.type !== 'event') return null;
  if (typeof value.event !== 'string') return null;
  if (!(EVENT_NAMES as readonly string[]).includes(value.event)) return null;
  return { type: 'event', event: value.event as DaemonEventName, payload: value.payload };
}

/** 디코드된 값이 응답인가. 앱 클라이언트가 쓴다. */
export function parseResponse(value: unknown): DaemonResponse | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.ok !== 'boolean') {
    return null;
  }
  return {
    id: value.id,
    ok: value.ok,
    payload: value.payload,
    error: isRecord(value.error) && typeof value.error.code === 'string'
      ? { code: value.error.code as DaemonErrorCode, message: String(value.error.message ?? '') }
      : undefined,
  };
}

export function makeResponse(id: string, payload: unknown): DaemonResponse {
  return { id, ok: true, payload };
}

export function makeErrorResponse(id: string, error: DaemonError): DaemonResponse {
  return { id, ok: false, error };
}

export function makeEvent(event: DaemonEventName, payload: unknown): DaemonEventMessage {
  return { type: 'event', event, payload };
}

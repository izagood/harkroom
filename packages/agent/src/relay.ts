// 러너 → 서버 상시 outbound WS 릴레이(스펙 §5 "릴레이"). 진행 중인 턴의 PTY 바이트를
// 서버로 밀어 넣어, 소유자가 데스크탑 xterm 에서 실시간으로 본다.
//
// **러너는 포트를 열지 않는다.** 러너는 사람의 로그인 세션 안에서 돌고, 관찰 하나 때문에
// 두 번째 보안 표면(청취 포트 + 인증 + TLS)을 만들지 않는다 — 그것이 스펙 §2 가 안 C
// (데스크탑 ↔ 러너 직결)를 기각한 이유다. 그래서 방향이 러너 → 서버이고, 인증은 PAT
// **헤더**다: 러너는 브라우저가 아니라 헤더를 실을 수 있으므로 티켓이 필요 없다.
//
// **재접속 정책은 새로 만들지 않았다.** `policy.ts` 의 `nextBackoffMs` 를 그대로 쓴다 —
// inbox.poll 루프(`main.ts`)가 쓰는 것과 같은 곡선이다. 릴레이만의 곡선을 두면 러너 한
// 프로세스가 서버 재시작에 두 가지 속도로 반응하고, 그 둘이 갈라진 뒤에는 한쪽만 고쳐진다.
//
// **스크롤백은 여기 메모리에만 산다.** 세션당 최근 256KB 를 `RingBuffer` 로 들고, attach
// 시 서버의 `replay.request` 에 그 스냅샷으로 답한다. DB 에 저장하지 않는다 — PTY 출력에는
// 하네스가 화면에 그린 모든 것(토큰, 환경변수, 사람이 붙여 넣은 비밀)이 들어간다. 프로세스가
// 죽으면 스크롤백도 같이 사라지는 것이 이 설계의 결과이고, 그것이 의도다.
import { randomUUID } from 'node:crypto';
import type { AgentHarness, AgentSessionView, RelayRunnerFrame, RelayServerFrame } from '@murmur/shared';
import { RingBuffer } from './pty.js';
import { nextBackoffMs } from './policy.js';

/** 세션당 스크롤백 용량(스펙 §5). 러너 메모리에만 산다. */
export const RING_CAP_BYTES = 256 * 1024;

/** 소켓의 최소 표면. 프로덕션은 `ws`, 테스트는 가짜다. */
export interface RelayTransport {
  send(data: string): void;
  close(): void;
}

export interface RelayHandlers {
  onOpen(transport: RelayTransport): void;
  onMessage(raw: string): void;
  /** 열렸다 끊긴 것과 애초에 못 붙은 것을 구분하지 않는다 — 둘 다 재접속 대상이다. */
  onClose(): void;
}

/**
 * 실제 소켓을 여는 함수. 주입 가능하게 뽑아 둔 이유: 재접속·백오프·announce 순서는
 * 소켓 없이 검증돼야 한다. 네트워크를 태우는 테스트는 그 순서가 깨졌을 때 "느리다"로만
 * 보이고, 무엇이 깨졌는지는 알려 주지 않는다.
 */
export type RelayDialer = (url: string, pat: string, handlers: RelayHandlers) => void;

/** 한 턴에 대응하는 살아 있는 PTY 세션. */
interface LiveSession {
  info: AgentSessionView;
  ring: RingBuffer;
}

export interface OpenSessionInput {
  agentAccountId: string;
  channelId: string;
  threadRootId: string | null;
  harness: AgentHarness;
}

/**
 * 열린 세션의 호출자 쪽 손잡이. 턴을 도는 코드(`mentionTurn.ts`)는 이것만 안다 —
 * 소켓도, 프레임도, 재접속도 모른다.
 */
export interface OpenSession {
  sessionId: string;
  /** PTY 가 뱉은 바이트. ring 에 담고 서버로도 흘린다. */
  push(chunk: Buffer): void;
  /** 턴이 끝났다. 세션을 닫고 서버에 알린다. */
  close(): void;
}

export interface RelayClientOptions {
  /** murmur 서버의 http(s) 베이스 URL. ws(s) 로 바꿔 `/agent-relay` 에 붙는다. */
  murmurUrl: string;
  pat: string;
  dial?: RelayDialer;
  /** 재접속 예약. 테스트가 시간을 직접 돌리려고 뽑아 뒀다. */
  schedule?: (fn: () => void, ms: number) => void;
  /** 첫 재접속 지연. 이후 `nextBackoffMs` 로 늘어난다. */
  initialBackoffMs?: number;
}

export interface RelayClient {
  /** 접속을 시작한다. 이 뒤로는 끊겨도 스스로 다시 붙는다. */
  start(): void;
  /** 더 붙지 않는다. 열린 소켓도 닫는다. */
  stop(): void;
  /** 턴 하나를 세션으로 연다. 릴레이가 끊겨 있어도 성공한다(ring 은 계속 쌓인다). */
  openSession(input: OpenSessionInput): OpenSession;
  /** 지금 붙어 있는가. 로그·테스트가 본다. */
  connected(): boolean;
}

/** http(s) → ws(s). 경로는 `/agent-relay` 하나뿐이다. */
export function relayUrl(murmurUrl: string): string {
  return `${murmurUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/agent-relay`;
}

export function createRelayClient(opts: RelayClientOptions): RelayClient {
  const dial = opts.dial ?? nodeWsDialer;
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const initialBackoffMs = opts.initialBackoffMs ?? 1_000;

  const sessions = new Map<string, LiveSession>();
  let transport: RelayTransport | null = null;
  let stopped = false;
  let backoffMs = initialBackoffMs;

  const send = (frame: RelayRunnerFrame): void => {
    if (!transport) return;
    // 소켓이 방금 죽었을 수 있다 — 한 프레임을 못 보낸 것으로 턴을 죽이지 않는다.
    // 바이트를 잃는 것은 관찰의 손실이고, 턴은 사람이 기다리는 답이다.
    try { transport.send(JSON.stringify(frame)); } catch { /* 재접속이 announce 로 복구한다 */ }
  };

  const onServerFrame = (raw: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as RelayServerFrame;
    if (frame.type !== 'replay.request' || typeof frame.sessionId !== 'string') return;
    const live = sessions.get(frame.sessionId);
    // 모르는 세션에는 답하지 않는다. 빈 재생으로 답하면 "끝난 세션"과 "아직 출력이 없는
    // 세션"이 뷰어에게 같아진다.
    if (!live) return;
    send({ type: 'replay', sessionId: frame.sessionId, data: live.ring.snapshot().toString('base64') });
  };

  const connect = (): void => {
    if (stopped) return;
    dial(relayUrl(opts.murmurUrl), opts.pat, {
      onOpen: (t) => {
        transport = t;
        backoffMs = initialBackoffMs;
        // 재접속마다 다시 보낸다. 서버는 소켓이 끊기면 이 러너의 세션 레지스트리를
        // 버리므로(살아 있는지 알 방법이 없다), announce 가 없으면 진행 중인 턴이
        // 서버 쪽에서 영구히 사라진다 — attach 가 재접속을 못 넘긴다.
        send({ type: 'announce', sessions: [...sessions.values()].map((s) => s.info) });
      },
      onMessage: onServerFrame,
      onClose: () => {
        transport = null;
        if (stopped) return;
        schedule(connect, backoffMs);
        backoffMs = nextBackoffMs(backoffMs);
      },
    });
  };

  return {
    start: connect,

    stop() {
      stopped = true;
      transport?.close();
      transport = null;
    },

    openSession(input) {
      const info: AgentSessionView = {
        sessionId: randomUUID(),
        agentAccountId: input.agentAccountId,
        channelId: input.channelId,
        threadRootId: input.threadRootId,
        harness: input.harness,
        // 러너 시계다. 서버가 찍지 않는 이유: 세션이 언제 열렸는지는 러너만 아는 사실이고,
        // 서버가 프레임 도착 시각으로 대신하면 재접속 뒤 announce 에서 값이 바뀐다.
        startedAt: new Date().toISOString(),
      };
      const live: LiveSession = { info, ring: new RingBuffer(RING_CAP_BYTES) };
      sessions.set(info.sessionId, live);
      send({ type: 'session.started', session: info });

      return {
        sessionId: info.sessionId,
        push(chunk) {
          // ring 은 릴레이가 끊겨 있어도 계속 채운다 — 재접속 뒤 attach 하면 그동안의
          // 화면이 재생돼야 한다. 여기서 멈추면 끊긴 구간이 영구히 사라진다.
          live.ring.push(chunk);
          send({ type: 'output', sessionId: info.sessionId, data: chunk.toString('base64') });
        },
        close() {
          sessions.delete(info.sessionId);
          send({ type: 'session.ended', sessionId: info.sessionId });
        },
      };
    },

    connected: () => transport !== null,
  };
}

/**
 * 프로덕션 dialer. `ws` 를 쓰는 이유: Node 의 전역 `WebSocket`(undici)은 **커스텀 헤더를
 * 실을 수 없다.** 이 소켓의 인증은 PAT 헤더이므로(URL 에 실으면 앞단 프록시 로그에 남는다)
 * 헤더를 실을 수 있는 클라이언트가 필요하다.
 *
 * `import` 를 함수 안에 둔 이유: 이 모듈을 import 하는 테스트가 가짜 dialer 만 쓸 때
 * `ws` 를 실제로 로드하지 않게 한다.
 */
const nodeWsDialer: RelayDialer = (url, pat, handlers) => {
  void (async () => {
    const { default: WebSocket } = await import('ws');
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${pat}` } });
    // `ws` 는 실패 시 'error' 와 'close' 를 **둘 다** 낸다. 그대로 넘기면 재접속이 두 번
    // 예약되고, 그 두 배가 매 실패마다 곱해져 몇 분 뒤에는 접속 폭풍이 된다. 이 dial 의
    // 끝을 한 번만 알린다 — 백오프가 곡선 하나로 남는다.
    let settled = false;
    const settle = () => { if (!settled) { settled = true; handlers.onClose(); } };
    socket.on('open', () => {
      handlers.onOpen({ send: (data) => socket.send(data), close: () => socket.close() });
    });
    socket.on('message', (raw: unknown) => handlers.onMessage(String(raw)));
    socket.on('close', settle);
    // 핸드셰이크 자체가 실패(401, 연결 거부)하면 여기로 온다. 삼키면 러너가 조용히
    // 릴레이 없이 도는 상태로 남는다.
    socket.on('error', settle);
  })().catch(() => handlers.onClose());
};

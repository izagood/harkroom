/**
 * 서버 링크 — `/operator` WS 클라이언트. 스펙 2026-09-20 §4.
 *
 * 러너의 `relay.ts` 가 하던 dial·backoff·settle 을 그대로 물려받았다(단계 3 에서 그쪽은
 * unix 소켓으로 바뀐다). 다른 것 하나: **서버 ping 부재로 서버 죽음을 판정한다.** 프록시가
 * 조용히 걷어간 소켓은 close 를 주지 않으므로 — 오늘(2026-09-20) 실측 — ping 이 멈춘 것이
 * 유일한 신호다. 이 채널은 신규라 heartbeat 없는 구 서버가 없고, 그래서 러너 쪽에서 막혔던
 * 호환 문제가 여기엔 없다.
 *
 * dialer·시계·타이머를 주입받는다 — 테스트가 소켓 없이 재려고.
 */
import { parseServerFrame, type OperatorToServerFrame, type ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';

export interface LinkTransport { send(data: string): void; close(): void }
export interface LinkHandlers {
  onOpen(transport: LinkTransport): void;
  onMessage(raw: string): void;
  /** 이 dial 의 끝을 **한 번만** 알린다 — 열리기 전 실패든 열린 뒤 끊김이든. */
  onClose(reason?: string): void;
  /** 서버 ping 이 왔다. Node `ws` 는 ping 을 이벤트로 준다(브라우저와 다르다). */
  onPing?(): void;
}
export type LinkDialer = (url: string, token: string, handlers: LinkHandlers) => void;

export interface ServerLinkOptions {
  baseUrl: string;
  token: string;
  /** 연결·재연결마다 새로 만든다 — 그 사이 러너·세션이 바뀌었을 수 있다. */
  hello: () => OperatorToServerFrame & { type: 'hello' };
  onFrame: (frame: ServerToOperatorFrame) => void;
  onOpen?: () => void;
  onClose?: (reason?: string) => void;
  dial?: LinkDialer;
  schedule?: (fn: () => void, ms: number) => void;
  initialBackoffMs?: number;
  /** 서버 ping 이 이만큼 없으면 죽은 것으로 본다. 기본 75초 = 30초 ping × 2 + 여유. */
  silenceMs?: number;
  now?: () => number;
}

export interface ServerLink {
  start(): void;
  stop(): void;
  /** 보냈는가까지다 — 안 붙어 있으면 false. */
  send(frame: OperatorToServerFrame): boolean;
  connected(): boolean;
  /** 침묵 감시 한 번. 프로덕션은 스스로 예약하고, 테스트가 직접 부른다. */
  tick(): void;
}

const BACKOFF_CEILING_MS = 30_000;

export function operatorUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/operator`;
}

export function createServerLink(opts: ServerLinkOptions): ServerLink {
  const dial = opts.dial ?? nodeWsDialer;
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const now = opts.now ?? Date.now;
  const silenceMs = opts.silenceMs ?? 75_000;
  const initialBackoffMs = opts.initialBackoffMs ?? 1_000;

  let transport: LinkTransport | null = null;
  let lastPingAt = 0;
  let stopped = false;
  let backoffMs = initialBackoffMs;

  const tick = (): void => {
    if (!transport) return;
    if (now() - lastPingAt > silenceMs) {
      // 끊는 것으로 끝이다 — onClose 가 재접속을 예약한다. 여기서 connect 를 부르면 두 갈래가 된다.
      transport.close();
      return;
    }
    schedule(tick, Math.min(silenceMs / 3, 10_000));
  };

  const connect = (): void => {
    if (stopped) return;
    dial(operatorUrl(opts.baseUrl), opts.token, {
      onOpen: (t) => {
        transport = t;
        lastPingAt = now();
        backoffMs = initialBackoffMs;
        t.send(JSON.stringify(opts.hello()));
        opts.onOpen?.();
        schedule(tick, Math.min(silenceMs / 3, 10_000));
      },
      onMessage: (raw) => {
        const frame = parseServerFrame(raw);
        if (frame) opts.onFrame(frame);
      },
      onPing: () => { lastPingAt = now(); },
      onClose: (reason) => {
        transport = null;
        opts.onClose?.(reason);
        if (stopped) return;
        // 다음 값을 **먼저** 정한다. 예약이 동기로 실행되는 스케줄러(테스트)에서 재접속이
        // 증가 전 값을 읽으면 곡선이 평평해진다 — 순서를 타이머의 비동기성에 맡기지 않는다.
        const delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
        schedule(connect, delay);
      },
    });
  };

  return {
    start: connect,
    stop() { stopped = true; transport?.close(); transport = null; },
    send(frame) {
      if (!transport) return false;
      try { transport.send(JSON.stringify(frame)); return true; } catch { return false; }
    },
    connected: () => transport !== null,
    tick,
  };
}

/**
 * 실제 dialer. `ws` 를 함수 안에서 import 하는 이유는 러너 relay.ts 와 같다 — 가짜 dialer 만
 * 쓰는 테스트가 `ws` 를 로드하지 않게. 'error' 와 'close' 가 둘 다 오는 것을 한 번으로 접는다.
 */
const nodeWsDialer: LinkDialer = (url, token, handlers) => {
  void (async () => {
    const { default: WebSocket } = await import('ws');
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    let settled = false;
    let lastPingAt: number | null = null;
    let lastError: string | null = null;
    const settle = (reason?: string) => { if (!settled) { settled = true; handlers.onClose(reason); } };
    socket.on('open', () => {
      handlers.onOpen({ send: (data) => socket.send(data), close: () => socket.close() });
    });
    socket.on('message', (raw: unknown) => handlers.onMessage(String(raw)));
    socket.on('ping', () => { lastPingAt = Date.now(); handlers.onPing?.(); });
    socket.on('close', (code: number, reason: Buffer) => settle(describeClose(
      code, reason?.toString('utf8') ?? '', lastPingAt === null ? null : Date.now() - lastPingAt, lastError,
    )));
    // 'error' 뒤에는 보통 'close'(1006)가 따라온다 — 그 줄에 code 와 마지막 ping 을 함께 적으려고 잠깐 기다린다.
    // 'close' 가 끝내 안 오면 1초 뒤 오류 문구만으로 닫는다(재접속이 멈추면 안 된다).
    socket.on('error', (err: Error) => {
      lastError = err.message;
      setTimeout(() => settle(err.message), 1_000).unref?.();
    });
  })().catch((err: unknown) => handlers.onClose(err instanceof Error ? err.message : String(err)));
};

/**
 * 닫힘을 로그 한 줄로 적는다 — close code·reason 과 마지막 서버 ping 뒤 지난 시간.
 *
 * 서버 하트비트가 끊었으면(pong 미수신 → terminate) 이쪽에는 1006 이 오고 마지막 ping 이 30~60초 전이다.
 * 서버가 정상 종료(배포)면 1001·1012, 자격증명이면 4401 이다. 이 셋을 로그만 보고 가를 수 있어야
 * 「pong 을 왜 못 보냈나」를 다음에 확정할 수 있다(2026-11-09 분석에서 이 로그엔 아무 단서가 없었다).
 */
export function describeClose(
  code: number, reason: string, sinceLastPingMs: number | null, error: string | null = null,
): string {
  const parts = [`close ${code}`];
  // reason 은 서버가 정한 짧은 문구다. 줄을 깨뜨리지 않게 한 줄로 접고 자른다.
  const r = reason.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (r) parts.push(r);
  if (error) parts.push(`오류 ${error.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  parts.push(sinceLastPingMs === null ? '서버 ping 받은 적 없음' : `마지막 서버 ping ${Math.round(sinceLastPingMs / 1000)}초 전`);
  return parts.join(', ');
}

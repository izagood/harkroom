import {
  WS_HEARTBEAT_STALE_FACTOR, WS_HEARTBEAT_TYPE, type WsServerEvent,
} from '@harkroom/shared';

/**
 * 연결이 끊긴 **이유**. 기다리면 낫는 것과 그렇지 않은 것을 갈라야 한다 —
 * 네트워크는 돌아오지만 폐기된 세션은 돌아오지 않는다. 구분하지 않으면 사용자는 빨간 점과
 * 영구 재연결만 보고 왜 안 되는지 알 방법이 없다(= 조용한 실패).
 */
export type WsDownReason = 'network' | 'credential' | 'origin';

export interface WsCallbacks {
  onEvent(e: WsServerEvent): void;
  onOpen(): void;
  onDown(reason: WsDownReason): void;
  /**
   * 소켓이 4401 로 닫혔을 때 **정말 자격증명이 죽었는지** 다시 묻는다. `false` 일 때만 `credential` 로 포기한다.
   *
   * 서버는 티켓이 없을 때도(30초 만료·다른 서버 프로세스가 발급·이미 씀) 같은 4401 을 보낸다 — 소켓 쪽에서는
   * "티켓이 무효"와 "세션이 죽음"이 같은 코드다. 그것을 그대로 믿으면 멀쩡한 세션이 보관본에서 지워지고 사람이
   * 로그인 화면으로 쫓겨난다. 판정은 REST(`/auth/me`)가 한다: 401 이면 죽은 것이고, 그 밖(200·네트워크 실패)은
   * 죽었다는 근거가 아니므로 네트워크 끊김처럼 다시 붙는다 — 정말 죽었으면 다음 티켓 발급이 401 로 끝낸다.
   *
   * 주지 않으면 예전처럼 4401 을 곧바로 `credential` 로 본다.
   */
  credentialStillValid?(): Promise<boolean>;
}

export interface WsHandle {
  close(): void;
  /**
   * 클라이언트 → 서버 메시지. 지금은 '입력 중'만 쓴다. 소켓이 아직 열리지 않았거나 재연결
   * 중이면 **조용히 버린다** — 큐에 쌓아 두면 재연결 뒤에 오래된 '입력 중'이 도착해서
   * 이미 멈춘 사람이 입력 중으로 보인다. 수명이 몇 초인 신호는 버리는 것이 맞다.
   */
  send(payload: unknown): void;
}

/** 연결 시도마다 새로 받아야 하는 단기 1회용 티켓. 재사용하면 서버가 거절한다. */
export type TicketProvider = () => Promise<string>;

/** 서버가 핸드셰이크를 거절하거나 소켓을 끊을 때 쓰는 코드. 4403 은 재시도로 낫지 않는다. 4401 은 다시 확인한다. */
const CLOSE_CREDENTIAL = 4401; // 티켓 무효, 또는 소켓 수명 중 자격증명이 폐기됨 — 둘을 가르는 것은 `credentialStillValid`
const CLOSE_ORIGIN = 4403;     // 서버의 허용 origin 목록에 없다
/** 수신 감시가 좀비 소켓을 버릴 때 싣는 코드(4000~4999 는 애플리케이션 몫). 서버는 이 값으로 판단하지 않는다. */
const CLOSE_STALE = 4008;

/** 서버가 준 hb 주기를 이 범위로 묶는다 — 0·음수·터무니없는 값이 와도 감시가 폭주하거나 영영 안 돌지 않게. */
const HB_MIN_MS = 1_000;
const HB_MAX_MS = 5 * 60_000;

/**
 * 프레임이 앱 수준 hb 면 주기(ms)를, 아니면 null 을 낸다.
 * hb 는 소켓 층의 신호라 상태 층(`onEvent`)으로 올리지 않는다.
 */
function heartbeatInterval(frame: unknown): number | null {
  if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== WS_HEARTBEAT_TYPE) return null;
  const raw = Number((frame as { intervalMs?: unknown }).intervalMs);
  if (!Number.isFinite(raw)) return 20_000;
  return Math.min(Math.max(raw, HB_MIN_MS), HB_MAX_MS);
}

export function connectWs(baseUrl: string, getTicket: TicketProvider, cb: WsCallbacks): WsHandle {
  const wsBase = `${baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/ws`;
  let closed = false;
  let retryMs = 1000;
  let ws: WebSocket | null = null;

  const retry = () => {
    if (closed) return;
    setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
  };

  /** 재시도로 낫지 않는 사유. 더 시도하지 않고 호출부가 처리하게 넘긴다. */
  const giveUp = (reason: WsDownReason) => {
    closed = true;
    cb.onDown(reason);
  };

  const open = async () => {
    if (closed) return;
    let ticket: string;
    try {
      ticket = await getTicket();
    } catch (err) {
      // 401/403 은 자격증명이 죽었다는 뜻이다 — 백오프를 아무리 해도 살아나지 않는다.
      // ApiError 의 status 를 덕타이핑으로 본다(이 파일이 api.ts 를 알 필요는 없다).
      const status = (err as { status?: number } | null)?.status;
      if (status === 401 || status === 403) { giveUp('credential'); return; }
      // 상태 코드가 없는 실패는 네트워크 문제다 — 이건 기다리면 낫는다.
      cb.onDown('network');
      retry();
      return;
    }
    // 발급을 기다리는 사이 명시 종료가 들어왔을 수 있다. 여기서 안 막으면 닫은 뒤에 소켓이 열린다.
    if (closed) return;

    const sock = new WebSocket(`${wsBase}?ticket=${encodeURIComponent(ticket)}`);
    ws = sock;
    // 수신 감시(좀비 연결). 서버가 끊었는데 앞단이 이쪽 다리를 열어 둔 채 두면 close 가 오지 않는다 —
    // 무언가를 보내 RST 를 받기 전까지 이벤트 없이 「붙어 있음」으로 남는다(실측 17분). 그래서 받은 프레임의
    // 시각을 재고, 서버 hb 주기의 2.5배 동안 아무것도 못 받으면 이 소켓을 버리고 다시 붙는다.
    // **첫 hb 를 받기 전에는 켜지 않는다** — hb 를 모르는 옛 서버에 붙으면 영영 받을 것이 없다.
    let lastRx = Date.now();
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let watchedMs = 0;
    const stopWatch = () => { if (watchdog) { clearInterval(watchdog); watchdog = null; } };
    const abandon = () => {
      stopWatch();
      sock.onopen = null; sock.onmessage = null; sock.onclose = null;
      // 죽은 연결이라 close 핸드셰이크가 끝나지 않을 수 있다 — onclose 를 기다리지 않고 바로 다시 붙는다.
      try { sock.close(CLOSE_STALE, 'no frames from server'); } catch { /* 이미 닫힘 */ }
      if (ws === sock) ws = null;
      if (closed) return;
      cb.onDown('network');
      retry();
    };
    const watch = (intervalMs: number) => {
      if (watchdog && watchedMs === intervalMs) return;
      stopWatch();
      watchedMs = intervalMs;
      const staleMs = intervalMs * WS_HEARTBEAT_STALE_FACTOR;
      watchdog = setInterval(() => {
        if (closed) { stopWatch(); return; }
        if (Date.now() - lastRx > staleMs) abandon();
      }, Math.max(250, Math.floor(intervalMs / 4)));
    };

    sock.onopen = () => { retryMs = 1000; lastRx = Date.now(); cb.onOpen(); };
    sock.onmessage = (ev) => {
      lastRx = Date.now();
      let frame: unknown;
      try { frame = JSON.parse(String(ev.data)); } catch { return; /* 비정형 프레임 무시 */ }
      const hb = heartbeatInterval(frame);
      if (hb !== null) { watch(hb); return; }
      try { cb.onEvent(frame as WsServerEvent); } catch { /* 상태 층 오류가 소켓을 죽이지 않게 */ }
    };
    sock.onclose = (ev) => {
      stopWatch();
      if (closed) return;
      const code = (ev as { code?: number } | undefined)?.code;
      if (code === CLOSE_CREDENTIAL) {
        if (!cb.credentialStillValid) { giveUp('credential'); return; }
        void cb.credentialStillValid().then((alive) => alive, () => true).then((alive) => {
          if (closed) return;
          if (!alive) { giveUp('credential'); return; }
          cb.onDown('network');
          retry();
        });
        return;
      }
      if (code === CLOSE_ORIGIN) { giveUp('origin'); return; }
      cb.onDown('network');
      retry();
    };
  };


  void open();

  return {
    close() { closed = true; ws?.close(); },
    send(payload) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    },
  };
}

import type { WsServerEvent } from '@murmur/shared';

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
}

export interface WsHandle { close(): void }

/** 연결 시도마다 새로 받아야 하는 단기 1회용 티켓. 재사용하면 서버가 거절한다. */
export type TicketProvider = () => Promise<string>;

/** 서버가 핸드셰이크를 거절하거나 소켓을 끊을 때 쓰는 코드. 둘 다 재시도로 낫지 않는다. */
const CLOSE_CREDENTIAL = 4401; // 티켓 무효, 또는 소켓 수명 중 자격증명이 폐기됨
const CLOSE_ORIGIN = 4403;     // 서버의 허용 origin 목록에 없다

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

    ws = new WebSocket(`${wsBase}?ticket=${encodeURIComponent(ticket)}`);
    ws.onopen = () => { retryMs = 1000; cb.onOpen(); };
    ws.onmessage = (ev) => {
      try { cb.onEvent(JSON.parse(String(ev.data)) as WsServerEvent); } catch { /* 비정형 프레임 무시 */ }
    };
    ws.onclose = (ev) => {
      if (closed) return;
      const code = (ev as { code?: number } | undefined)?.code;
      if (code === CLOSE_CREDENTIAL) { giveUp('credential'); return; }
      if (code === CLOSE_ORIGIN) { giveUp('origin'); return; }
      cb.onDown('network');
      retry();
    };
  };


  void open();

  return {
    close() { closed = true; ws?.close(); },
  };
}

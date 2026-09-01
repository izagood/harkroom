import type { WsServerEvent } from '@murmur/shared';

export interface WsCallbacks {
  onEvent(e: WsServerEvent): void;
  onOpen(): void;
  onDown(): void;
}

export interface WsHandle { close(): void }

/** 연결 시도마다 새로 받아야 하는 단기 1회용 티켓. 재사용하면 서버가 거절한다. */
export type TicketProvider = () => Promise<string>;

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

  const open = async () => {
    if (closed) return;
    let ticket: string;
    try {
      ticket = await getTicket();
    } catch {
      // 티켓을 못 받은 것과 소켓이 끊긴 것은 클라이언트에게 같은 상태다 — 같은 백오프를 탄다.
      cb.onDown();
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
    ws.onclose = () => {
      if (closed) return;
      cb.onDown();
      retry();
    };
  };






  void open();

  return {
    close() { closed = true; ws?.close(); },
  };
}

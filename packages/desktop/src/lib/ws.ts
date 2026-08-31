import type { WsServerEvent } from '@murmur/shared';

export interface WsCallbacks {
  onEvent(e: WsServerEvent): void;
  onOpen(): void;
  onDown(): void;
}

export interface WsHandle { close(): void }

export function connectWs(baseUrl: string, token: string, cb: WsCallbacks): WsHandle {
  const url = `${baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  let closed = false;
  let retryMs = 1000;
  let ws: WebSocket | null = null;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { retryMs = 1000; cb.onOpen(); };
    ws.onmessage = (ev) => {
      try { cb.onEvent(JSON.parse(String(ev.data)) as WsServerEvent); } catch { /* 비정형 프레임 무시 */ }
    };
    ws.onclose = () => {
      if (closed) return;
      cb.onDown();
      setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    };
  };
  open();

  return {
    close() { closed = true; ws?.close(); },
  };
}

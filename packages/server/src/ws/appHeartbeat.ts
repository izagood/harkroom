/**
 * 앱 수준 하트비트(`{ type: 'hb', intervalMs }`) — 클라이언트가 **받는 쪽에서** 죽은 연결을 알아채게 한다.
 *
 * `heartbeat.ts` 의 ping/pong 은 서버가 죽은 소켓을 걷어 내는 장치다. 그런데 서버가 끊어도 앞단(프록시·엣지)이
 * 클라이언트 쪽 다리를 열어 둔 채 두면, 클라이언트는 무언가를 보내 RST 를 받기 전까지 이벤트를 하나도 못 받으면서
 * 「붙어 있다」고 믿는다. 프로토콜 pong 은 브라우저 네트워크 층이 자동으로 보내므로 페이지 코드는 그 사실을
 * 볼 수 없다. 그래서 서버가 주기마다 작은 텍스트 프레임을 보내고, 클라이언트가 그 도착을 잰다.
 *
 * 판정을 타이머와 떼어 둔 이유는 `heartbeat.ts` 와 같다 — tick 을 직접 불러 검증한다.
 */
import type { WsHeartbeatFrame } from '@harkroom/shared';

export interface AppHeartbeatSocket {
  send(data: string): void;
}

export interface AppHeartbeat {
  track(socket: AppHeartbeatSocket): void;
  untrack(socket: AppHeartbeatSocket): void;
  /** 한 주기: 추적 중인 모든 소켓에 hb 프레임을 보낸다. */
  tick(): void;
  size(): number;
}

export const DEFAULT_APP_HEARTBEAT_MS = 20_000;

export function createAppHeartbeat(intervalMs: number): AppHeartbeat {
  const sockets = new Set<AppHeartbeatSocket>();
  const frame: WsHeartbeatFrame = { type: 'hb', intervalMs };
  const payload = JSON.stringify(frame);
  return {
    track(socket) { sockets.add(socket); },
    untrack(socket) { sockets.delete(socket); },
    size() { return sockets.size; },
    tick() {
      for (const socket of [...sockets]) {
        // 쓰기 실패는 닫히는 중인 소켓이다 — close 핸들러가 untrack 한다. 한 소켓 때문에 나머지를 거르지 않는다.
        try { socket.send(payload); } catch { /* 다음 주기 */ }
      }
    },
  };
}

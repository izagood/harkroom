/**
 * WS 하트비트 — 죽은 TCP 연결을 online 에서 걷어낸다.
 *
 * 소켓이 끊겼다는 사실은 close 이벤트로 오지만, **케이블이 뽑히거나 피어가 wedge 되면 close 가
 * 오지 않는다.** 그 상태로 presence 를 유지하면 사람은 "저 에이전트가 살아 있다"고 오판한다.
 * 그래서 주기마다 ping 을 보내고, 직전 ping 에 pong 이 없었던 소켓을 끊는다 — 끊으면 close
 * 핸들러가 돌아 presence 가 정리된다.
 *
 * 판정을 타이머와 분리해 둔 이유: 시간에 의존하지 않고 tick 을 직접 불러 검증할 수 있어야 한다.
 */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
}

export interface Heartbeat {
  track(socket: HeartbeatSocket): void;
  untrack(socket: HeartbeatSocket): void;
  /** 한 주기: 답 없는 소켓을 끊고, 남은 소켓에 ping 을 보낸다. */
  tick(): void;
  pong(socket: HeartbeatSocket): void;
  size(): number;
}

export function createHeartbeat(): Heartbeat {
  // socket → 직전 ping 이후 pong 을 받았는가. track 직후는 true 로 시작한다(방금 붙은
  // 연결을 첫 tick 에서 끊으면 안 된다).
  const alive = new Map<HeartbeatSocket, boolean>();

  return {
    track(socket) { alive.set(socket, true); },
    untrack(socket) { alive.delete(socket); },
    pong(socket) { if (alive.has(socket)) alive.set(socket, true); },
    size() { return alive.size; },

    tick() {
      for (const [socket, answered] of [...alive]) {
        if (!answered) {
          // 추적에서 먼저 빼고 끊는다. terminate 가 던져도(이미 파괴된 소켓 등) 다음 주기에
          // 같은 소켓을 다시 붙잡고 있으면 안 된다.
          alive.delete(socket);
          try { socket.terminate(); } catch { /* 이미 닫힌 소켓 — 목적은 달성됐다 */ }
          continue;
        }
        alive.set(socket, false); // 이번 ping 에 답해야 다음 tick 에서 산다
        try { socket.ping(); } catch { /* 쓰기 실패는 다음 tick 의 미응답으로 드러난다 */ }
      }
    },
  };
}

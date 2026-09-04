// 진행 중인 에이전트 PTY 세션에 붙는 뷰어 소켓(#141 Phase 2, 스펙 §5).
//
// `ws.ts`(워크스페이스 이벤트 소켓)와 **별개의 소켓**이다. 스펙 §5 가 이벤트 버스를 쓰지
// 않기로 한 이유가 그것이다: `events.ts` 는 단일 브로드캐스트 + audience 필터라 세션
// 바이트를 흘리면 모든 클라이언트가 PTY 출력을 받는다. 여기는 세션 하나 ↔ 이 창 하나다.
//
// `ws.ts` 처럼 **재접속하지 않는다.** 이 소켓은 사람이 패널을 열어 둔 동안만 살고, 티켓은
// 1회용이라 재접속에는 새 attach 인가가 필요하다 — 조용히 다시 붙으면 그 인가를 건너뛴다.
// 끊기면 패널이 그 사실을 그리고, 다시 보려면 사람이 다시 연다.
import type { AgentSessionState, AttachClientFrame, AttachServerFrame } from '@murmur/shared';

export interface AttachCallbacks {
  /**
   * PTY raw 바이트. **문자열이 아니라 바이트다** — 청크 경계에서 잘린 UTF-8 을 문자열로
   * 뜨면 U+FFFD 로 치환돼 되돌릴 수 없고, ANSI 이스케이프가 조각나 화면이 깨진다.
   * 이 바이트열은 러너의 ring buffer 부터 여기까지 한 번도 디코드되지 않고 온 것이고,
   * 디코드는 xterm 이 자기 상태 기계로 한다.
   */
  onOutput(bytes: Uint8Array): void;
  onStatus(state: AgentSessionState): void;
  /** 소켓이 끊겼다. 재접속하지 않는다(파일 머리 주석). */
  onClosed(): void;
}

export interface AttachHandle {
  /**
   * 사람이 친 바이트를 그 PTY 로 보낸다(#315). **쓰기 인가는 여기서 판정하지 않는다** —
   * 서버가 attach 때 이미 했고(티켓의 `canInput`), 소켓이 그 결정을 들고 있다. 화면은
   * 쓸 수 없는 사람에게 이 함수를 부를 길 자체를 만들지 않고(패널이 입력을 안 연다),
   * 그래도 누가 직접 부르면 서버가 조용히 버린다 — **진짜 게이트는 서버 쪽 하나다.**
   */
  sendInput(bytes: Uint8Array): void;
  /**
   * 이 패널의 크기를 그 PTY 에 알린다(#335). `sendInput` 과 **같은 소켓·같은 게이트**다 —
   * 서버가 attach 때 정한 `canInput` 하나가 둘을 함께 막는다. 화면은 admin 에게 이 함수를
   * 부를 길 자체를 만들지 않지만(패널이 `onResize` 를 안 넘긴다), 그래도 누가 직접 부르면
   * 서버가 조용히 버린다 — **진짜 게이트는 서버 쪽 하나다.**
   */
  sendResize(cols: number, rows: number): void;
  close(): void;
}

/** 바이트 → base64. `btoa` 는 latin1 문자열을 받으므로 바이트를 코드 포인트로 넘긴다. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 → 바이트. `atob` 는 latin1 문자열을 주므로 코드 포인트가 곧 바이트다. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function connectAgentAttach(
  baseUrl: string, ticket: string, cb: AttachCallbacks,
): AttachHandle {
  const url = `${baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/agent-attach?ticket=${encodeURIComponent(ticket)}`;
  const socket = new WebSocket(url);
  let closed = false;

  socket.onmessage = (ev) => {
    // **닫은 뒤에는 아무것도 흘리지 않는다.** `close()` 를 부른 순간부터 CLOSING 을
    // 지나 실제로 닫히기까지 창이 있고, 그 사이에 이미 버퍼에 들어와 있던 프레임이
    // 도착할 수 있다. 패널을 닫은 사람에게 PTY 바이트가 더 흘러들면, 보지 않는 화면으로
    // 비밀이 계속 오간다 — 구독을 끊는다는 것은 소켓을 닫는 것만이 아니다.
    if (closed) return;
    let frame: AttachServerFrame;
    try { frame = JSON.parse(String(ev.data)) as AttachServerFrame; } catch { return; }
    if (frame.type === 'output') {
      // base64 가 깨져 있으면 `atob` 가 던진다 — 프레임 하나로 패널을 죽이지 않는다.
      try { cb.onOutput(decodeBase64(frame.data)); } catch { /* 비정형 프레임 무시 */ }
      return;
    }
    if (frame.type === 'status') cb.onStatus(frame.state);
  };

  socket.onclose = () => {
    if (closed) return;
    closed = true;
    cb.onClosed();
  };

  return {
    sendInput(bytes) {
      // 닫힌 뒤에 쓰면 브라우저가 던진다 — 패널을 닫는 순간 도착한 키 하나로 화면을
      // 죽이지 않는다(`onmessage` 의 `closed` 가드와 같은 이유, 반대 방향).
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: 'input', data: encodeBase64(bytes) } satisfies AttachClientFrame)); }
      catch { /* 죽은 소켓은 onclose 가 정리한다 */ }
    },
    sendResize(cols, rows) {
      // 닫힌 뒤의 쓰기 가드는 `sendInput` 과 같다 — 패널을 닫는 순간 발생한 리사이즈
      // 하나로 화면을 죽이지 않는다.
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: 'resize', cols, rows } satisfies AttachClientFrame)); }
      catch { /* 죽은 소켓은 onclose 가 정리한다 */ }
    },
    close() {
      // **먼저 플래그를 세운다.** 사람이 패널을 닫은 것을 '끊겼다'로 그리면, 닫는 순간
      // 오류 문구가 스쳐 지나간다. 이 소켓은 닫힘이 정상 종료다.
      closed = true;
      socket.close();
    },
  };
}

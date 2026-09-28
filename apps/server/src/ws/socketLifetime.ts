// 열려 있는 WS 소켓의 **수명 정책**. 두 가지를 담는다: Origin 판정과 자격증명 재검증.
//
// 왜 한 파일로 뽑았는가(#141): 이 서버에는 이제 장수 소켓이 두 종류다 — 워크스페이스
// 이벤트 소켓(`/ws`)과 에이전트 터미널 뷰어 소켓(`/agent-attach`). 두 소켓의 수명 규칙이
// 갈라지면 **더 민감한 쪽이 더 느슨해진다**: 실제로 그랬다. attach 티켓은 처음부터
// `credentialHash` 를 운반했지만 아무도 읽지 않았고, 그래서 세션이 만료되거나 PAT 가
// 폐기된 뒤에도 열려 있던 터미널 패널로 PTY 바이트가 계속 흘렀다. PTY 출력에는 하네스가
// 화면에 그린 모든 것(토큰, 환경변수, 사람이 붙여 넣은 비밀)이 들어가므로, 이벤트 소켓보다
// 느슨한 것이 아니라 **적어도 같아야** 한다.
//
// 판정을 복사하지 않고 이 모듈을 양쪽이 부르는 이유는 인가 술어와 같다 — 사본은 한쪽만
// 고쳐지고, 수명에서 그것은 조용히 열려 있는 쪽으로 어긋난다.
import type { Pool } from 'pg';
import { findInvalidCredentials } from './credentials.js';

/** 닫을 수만 있으면 된다. `@fastify/websocket` 의 소켓도 테스트의 가짜도 이 모양이다. */
export interface ClosableSocket {
  close(code: number, reason: string): void;
}

/**
 * WebSocket 핸드셰이크는 **CORS 의 보호를 받지 않는다** — 브라우저는 교차 출처로도 연결을
 * 맺는다. 다만 Origin 은 브라우저만 보낸다: 에이전트·CLI 는 보내지 않으므로 부재는
 * 허용해야 한다(막으면 러너가 아예 못 붙는다).
 */
export function originAllowed(
  allowedOrigins: readonly string[] | null, origin: string | undefined,
): boolean {
  return !allowedOrigins || !origin || allowedOrigins.includes(origin);
}

export interface CredentialSweep {
  /**
   * 이 소켓을 감시 대상에 넣는다. 반환값을 부르면 감시를 그만둔다(소켓이 정상적으로
   * 닫히는 경로). 그만두지 않으면 죽은 소켓의 해시가 매 주기 질의에 계속 실린다.
   */
  track(socket: ClosableSocket, credentialHash: string): () => void;
  /** 감시를 멈춘다. 테스트는 서버를 여럿 만든다 — 안 멈추면 이벤트 루프가 살아남는다. */
  stop(): void;
}

/**
 * 자격증명이 죽은 소켓을 끊는다.
 *
 * 토큰을 연결 시점에만 검증하면, 만료 직전에 열린 소켓이 만료 후에도 계속 받는다.
 * 판정은 살아 있는 해시 **전체에 대해 한 번의 질의**로 한다. 소켓마다 왕복하면 비용이
 * N배인 것도 있지만, 더 나쁜 건 같은 자격증명의 소켓들이 서로 다른 순간에 판정돼
 * "어떤 탭은 끊기고 어떤 탭은 사는" 상태가 생기는 것이다. 해시 집합 하나로 보면 운명이 같다.
 */
export function createCredentialSweep(pool: Pool, intervalMs: number): CredentialSweep {
  const live = new Set<{ socket: ClosableSocket; credentialHash: string }>();

  const timer = setInterval(() => {
    void (async () => {
      if (!live.size) return;
      const invalid = await findInvalidCredentials(
        pool, [...new Set([...live].map((e) => e.credentialHash))],
      );
      if (!invalid.size) return;
      for (const entry of [...live]) {
        if (invalid.has(entry.credentialHash)) {
          live.delete(entry);
          entry.socket.close(4401, 'credential no longer valid');
        }
      }
    })();
  }, intervalMs);

  return {
    track(socket, credentialHash) {
      const entry = { socket, credentialHash };
      live.add(entry);
      return () => { live.delete(entry); };
    },
    stop() { clearInterval(timer); },
  };
}

/** `/ws` 티켓과 attach 티켓이 함께 쓰는 재검증 주기 기본값(ms). */
export const DEFAULT_REVALIDATE_MS = 60_000;

// WS 핸드셰이크용 단기 1회용 티켓.
//
// 브라우저의 WebSocket 생성자는 헤더를 붙일 수 없어서, 자격증명을 실을 곳이 URL 아니면
// Sec-WebSocket-Protocol 뿐이다. URL 은 앞단 프록시의 액세스 로그에 그대로 남는다.
// 그래서 URL 에는 장기 토큰 대신 이 티켓을 싣는다 — 수십 초 살고 한 번 쓰면 죽으므로,
// 로그에 남은 값은 재사용할 수 없다.
//
// 저장은 인메모리다. 스펙 §3 의 "서버 인스턴스 1개 = 워크스페이스 1개" 전제이고,
// 재시작으로 티켓이 사라져도 클라이언트가 다시 받으면 그만이라 영속성이 필요 없다.
import { newToken } from '../auth/tokens.js';

export interface TicketClaim {
  accountId: string;
  /** 티켓을 발급받은 자격증명. 소켓 수명을 이 자격증명에 묶는다. */
  credentialHash: string;
}

export interface TicketStore {
  issue(accountId: string, credentialHash: string): string;
  /** 발급 내용, 또는 없거나·이미 쓰였거나·만료됐으면 null. */
  consume(ticket: string): TicketClaim | null;
  size(): number;
}

const DEFAULT_TTL_MS = 30_000;

export function createTicketStore(opts: { ttlMs?: number } = {}): TicketStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const live = new Map<string, TicketClaim & { expiresAt: number }>();

  return {
    issue(accountId, credentialHash) {
      // 받아만 두고 연결하지 않은 티켓은 아무도 지워주지 않는다 — 발급할 때 쓸어낸다.
      const now = Date.now();
      for (const [key, entry] of live) {
        if (entry.expiresAt <= now) live.delete(key);
      }
      const { token } = newToken('murt');
      live.set(token, { accountId, credentialHash, expiresAt: now + ttlMs });
      return token;
    },

    consume(ticket) {
      const entry = live.get(ticket);
      if (!entry) return null;
      live.delete(ticket); // 1회용 — 만료 여부와 무관하게 소모한다
      if (entry.expiresAt <= Date.now()) return null;
      return { accountId: entry.accountId, credentialHash: entry.credentialHash };
    },

    size() {
      return live.size;
    },
  };
}

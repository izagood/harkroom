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

/**
 * 1회용·단기 토큰 저장소의 **기계장치만** 담은 코어. 무엇을 운반하는지는 호출자가 정한다.
 *
 * 빼낸 이유(#141): attach 티켓은 계정·자격증명 위에 **세션 id** 를 하나 더 운반해야
 * 한다 — 어느 세션에 붙을 권한을 받았는지가 티켓에 박혀 있어야, WS 핸드셰이크가
 * 쿼리 파라미터로 온 세션 id 를 믿지 않게 된다(믿으면 티켓 하나로 남의 세션에 붙는다).
 * 그 저장소를 따로 만들면 TTL·1회용·쓸어내기가 두 벌이 되고, 한쪽만 고치는 사고가
 * 인가에서 조용히 열리는 쪽으로 어긋난다. 그래서 운반물만 제네릭으로 열었다.
 */
function createOneShotStore<C>(ttlMs: number) {
  const live = new Map<string, { claim: C; expiresAt: number }>();

  return {
    issue(claim: C): string {
      // 받아만 두고 연결하지 않은 티켓은 아무도 지워주지 않는다 — 발급할 때 쓸어낸다.
      const now = Date.now();
      for (const [key, entry] of live) {
        if (entry.expiresAt <= now) live.delete(key);
      }
      const { token } = newToken('murt');
      live.set(token, { claim, expiresAt: now + ttlMs });
      return token;
    },

    consume(ticket: string): C | null {
      const entry = live.get(ticket);
      if (!entry) return null;
      live.delete(ticket); // 1회용 — 만료 여부와 무관하게 소모한다
      if (entry.expiresAt <= Date.now()) return null;
      return entry.claim;
    },

    size(): number {
      return live.size;
    },
  };
}

export function createTicketStore(opts: { ttlMs?: number } = {}): TicketStore {
  const core = createOneShotStore<TicketClaim>(opts.ttlMs ?? DEFAULT_TTL_MS);
  return {
    issue: (accountId, credentialHash) => core.issue({ accountId, credentialHash }),
    consume: (ticket) => core.consume(ticket),
    size: () => core.size(),
  };
}

/**
 * attach 티켓의 발급 내용(#141). `/ws` 티켓과 **다른 저장소**를 쓴다 — 한 저장소를
 * 공유하면 `/ws` 티켓으로 `/agent-attach` 에 붙거나 그 반대가 되고, 그러면 attach
 * 인가(소유자 판정)를 통과하지 않은 티켓이 세션 소켓을 연다.
 */
export interface AttachTicketClaim extends TicketClaim {
  /** 이 티켓이 붙을 수 있는 **유일한** 세션. 핸드셰이크는 쿼리의 세션 id 를 믿지 않는다. */
  sessionId: string;
  /**
   * 이 티켓으로 그 PTY 에 **쓸 수 있는가**(#315). 소유자면 true, 소유자가 아닌 admin 이면
   * false 다(admin 을 겸한 소유자는 true — `auth/plugin.ts::OwnerVerdict.via`).
   *
   * 세션 id 와 **같은 이유로** 티켓이 운반한다: 인가는 Bearer 로 인증된 REST 에서 한 번
   * 끝나고, 소켓은 그 결정을 소모하기만 한다. 핸드셰이크가 계정을 다시 조회해 판정하면
   * 같은 질문에 답하는 코드가 두 곳이 되고, 인가에서 그것은 조용히 열리는 쪽으로 어긋난다.
   */
  canInput: boolean;
}

export interface AttachTicketStore {
  issue(claim: AttachTicketClaim): string;
  consume(ticket: string): AttachTicketClaim | null;
  size(): number;
}

export function createAttachTicketStore(opts: { ttlMs?: number } = {}): AttachTicketStore {
  return createOneShotStore<AttachTicketClaim>(opts.ttlMs ?? DEFAULT_TTL_MS);
}

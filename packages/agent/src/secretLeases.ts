/**
 * 턴 임대(비밀 보관소 PR 3) — 러너 쪽. 멘션 하나에 임대 하나를 받아 오퍼레이터에 맡기고, 그 멘션의
 * 일이 끝나면 놓는다. 계획·보안 검토: harkroom 스레드 bc98df3a.
 *
 * - **멘션마다 한 번만 받는다**(R1). 계정 전환(`withAccountFailover`)·재시도(`attempts`)로 같은 멘션의 턴이
 *   다시 돌아도 이 프로세스가 받은 임대를 그대로 쓴다 — 오퍼레이터가 들고 있다. 서버도 멘션당 평생 하나만
 *   준다(086, S1).
 * - **재기동한 러너는 비밀 없이 돈다**(R1 fail-closed). 이 장부는 메모리에만 있고, 다시 받으려 하면 서버가
 *   409 `lease_used` 로 거절한다. 실패는 턴을 막지 않는다 — 비밀이 없을 뿐이다.
 * - **토큰은 relay 통지로만 나간다**(R2). 하네스 env·argv·프롬프트·로그 어디에도 싣지 않는다.
 */
export interface TurnLease { id: string; token: string; expiresAt: string }

export interface SecretLeaseDeps {
  /** `POST /agent/turn-leases`. 거절·실패면 null — 이유는 로그 한 줄로 충분하다(토큰은 찍지 않는다). */
  issue(causeMessageId: string): Promise<TurnLease | null>;
  notifyLease(cause: string, lease: TurnLease): void;
  notifyEnded(cause: string): void;
}

export interface SecretLeases {
  acquire(causeMessageId: string): Promise<void>;
  release(causeMessageId: string): void;
}

export function createSecretLeases(deps: SecretLeaseDeps): SecretLeases {
  /** 멘션 id → 받았나. 거절된 것도 적는다 — 재시도마다 다시 묻지 않는다(어차피 409 다). */
  const held = new Map<string, boolean>();
  return {
    async acquire(cause) {
      if (held.has(cause)) return;
      held.set(cause, false);
      const lease = await deps.issue(cause).catch(() => null);
      if (!lease) return;
      held.set(cause, true);
      deps.notifyLease(cause, lease);
    },
    release(cause) {
      const had = held.get(cause);
      held.delete(cause);
      if (had) deps.notifyEnded(cause);
    },
  };
}

// (에이전트, 스레드) 턴 임대 — 마이그레이션 095 머리 주석이 이유다. 판정은 여기 하나다.
import type { Pool } from 'pg';

/** 하트비트가 끊긴 뒤 다른 러너가 넘겨받기까지. 러너는 이보다 훨씬 짧은 주기로 민다. */
export const THREAD_CLAIM_DEFAULT_TTL_SEC = 90;
export const THREAD_CLAIM_MIN_TTL_SEC = 15;
export const THREAD_CLAIM_MAX_TTL_SEC = 600;

export interface ThreadClaimKey {
  agentId: string;
  channelId: string;
  threadRootId: string;
  holder: string;
}

export type ClaimResult =
  | { ok: true; expiresAt: string }
  | { ok: false; expiresAt: string | null };

/**
 * 임대를 잡거나(처음·만료 뒤 넘겨받기) 민다(같은 holder 의 하트비트). **한 문장이다** — 읽고 나서 쓰면
 * 두 러너가 동시에 "비어 있다"를 보고 둘 다 잡는다. 남이 쥐고 있고 아직 살아 있으면 아무것도 바꾸지 않는다.
 *
 * `claimed_at` 은 holder 가 바뀔 때만 새로 찍는다 — 하트비트가 "언제부터 쥐었나"를 지우지 않게.
 */
export async function claimThread(pool: Pool, key: ThreadClaimKey, ttlSec: number): Promise<ClaimResult> {
  const ttl = Math.min(THREAD_CLAIM_MAX_TTL_SEC, Math.max(THREAD_CLAIM_MIN_TTL_SEC, Math.round(ttlSec)));
  // 그 에이전트의 오래 전에 만료된 행을 치운다. 기본 키의 앞 열이 agent_id 라 그 에이전트 몫만 훑는다.
  await pool.query(
    `delete from agent_thread_claim where agent_id = $1 and expires_at < now() - interval '1 hour'`,
    [key.agentId],
  );
  const won = await pool.query<{ expires_at: Date }>(
    `insert into agent_thread_claim (agent_id, channel_id, thread_root_id, holder, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5))
     on conflict (agent_id, channel_id, thread_root_id) do update
       set holder = excluded.holder,
           expires_at = excluded.expires_at,
           claimed_at = case when agent_thread_claim.holder = excluded.holder
                             then agent_thread_claim.claimed_at else now() end
       where agent_thread_claim.holder = excluded.holder
          or agent_thread_claim.expires_at <= now()
     returning expires_at`,
    [key.agentId, key.channelId, key.threadRootId, key.holder, ttl],
  );
  if (won.rows[0]) return { ok: true, expiresAt: won.rows[0].expires_at.toISOString() };
  const held = await pool.query<{ expires_at: Date }>(
    `select expires_at from agent_thread_claim where agent_id = $1 and channel_id = $2 and thread_root_id = $3`,
    [key.agentId, key.channelId, key.threadRootId],
  );
  return { ok: false, expiresAt: held.rows[0]?.expires_at.toISOString() ?? null };
}

/** 쥔 임대를 놓는다. 남의 것은 지우지 않는다(만료 뒤 넘겨받힌 임대를 옛 holder 가 지우면 안 된다). */
export async function releaseThread(pool: Pool, key: ThreadClaimKey): Promise<boolean> {
  const r = await pool.query(
    `delete from agent_thread_claim
      where agent_id = $1 and channel_id = $2 and thread_root_id = $3 and holder = $4`,
    [key.agentId, key.channelId, key.threadRootId, key.holder],
  );
  return (r.rowCount ?? 0) > 0;
}

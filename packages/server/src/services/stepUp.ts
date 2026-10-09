import type { Pool } from 'pg';

/**
 * 다시 확인(step-up) — 로그인한 세션이 비밀번호를 **한 번 더** 대면 그 세션만 잠깐 민감한 일을 할 수 있다.
 * 지금 쓰는 곳은 비밀 보관소 소유자 보기(`POST /secrets/:id/reveal`) 하나다.
 *
 * 왜 세션 칸인가: 확인한 사실을 클라이언트가 들고 다니면(토큰·쿠키) 그것도 훔칠 수 있는 것이 하나 더 는다.
 * 서버가 그 세션 행에 시각만 적으면, 확인한 기기의 그 세션 말고는 아무것도 열리지 않는다.
 */
export const STEP_UP_WINDOW_MS = 5 * 60_000;

/** 이 세션이 지금 다시 확인된 창 안에 있는가. 세션이 아닌 인증(PAT·오퍼레이터)은 늘 false 다. */
export async function isSteppedUp(pool: Pool, credentialHash: string | null | undefined, now = new Date()): Promise<boolean> {
  if (!credentialHash) return false;
  const r = await pool.query(
    `select 1 from session where token_hash = $1 and expires_at > $2 and stepped_up_until > $2`,
    [credentialHash, now]);
  return (r.rowCount ?? 0) > 0;
}

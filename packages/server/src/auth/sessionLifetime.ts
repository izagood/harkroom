import type { Pool } from 'pg';

/**
 * 사람 세션의 수명. 세 값이 한 묶음이라 한 곳에 둔다 — 로그인·비밀번호 재설정이 새 세션을 만들고,
 * 인증 훅이 쓰는 동안 늘린다. 셋이 갈라지면 "늘렸는데 상한을 넘는" 세션이 생긴다.
 *
 * 왜 늘리는가(2026-10-27): 14일 고정이었을 때 앱을 계속 쓰고 있던 사람이 로그인 14일째에
 * 갑자기 로그아웃됐다. 만료는 "안 쓰는 세션을 치운다"는 뜻이어야지, 쓰는 사람을 내쫓는 시계가
 * 되면 안 된다. 그래도 끝없이 살게 두지는 않는다 — 처음 로그인에서 `SESSION_MAX_DAYS` 가 지나면
 * 쓰고 있어도 다시 로그인해야 한다(새던 토큰이 영영 사는 길을 막는다).
 */
export const SESSION_TTL_DAYS = 14;
/** 남은 기간이 이보다 짧아졌을 때만 늘린다 — 요청마다 쓰지 않게. 늘린 뒤 다음 쓰기는 7일 뒤다. */
export const SESSION_RENEW_BELOW_DAYS = 7;
/** 처음 로그인(`created_at`)에서 이만큼이 지나면 더 늘리지 않는다. */
export const SESSION_MAX_DAYS = 90;

/**
 * 쓰이고 있는 세션을 늘린다 — 인증 훅이 세션으로 선 요청마다 부른다.
 *
 * 조건이 `where` 에 다 있어서 대부분의 요청에서 행을 건드리지 않는다(남은 기간이 7일 넘게 남았거나,
 * 이미 상한에 닿았으면 0행). 기록이 실패해도 인증은 막지 않는다: 늘리지 못한 세션은 아직 살아 있고,
 * 다음 요청이 다시 시도한다.
 */
export async function renewSession(pool: Pool, tokenHash: string): Promise<void> {
  await pool.query(
    `update session
        set expires_at = least(now() + interval '${SESSION_TTL_DAYS} days', created_at + interval '${SESSION_MAX_DAYS} days')
      where token_hash = $1
        and expires_at > now()
        and expires_at < now() + interval '${SESSION_RENEW_BELOW_DAYS} days'
        and expires_at < created_at + interval '${SESSION_MAX_DAYS} days'`,
    [tokenHash],
  ).catch(() => {});
}

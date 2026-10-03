import type { Pool } from 'pg';

/**
 * 살아 있는 소켓들의 자격증명 해시 중 **더 이상 유효하지 않은 것**을 골라낸다.
 * 인증 훅과 같은 조건을 보되, 소켓 수만큼 왕복하지 않고 한 번의 질의로 판정한다.
 *
 * "같은 조건"은 auth/plugin.ts 의 세션·PAT 분기 그대로다 — 세션은 계정이 살아 있어야 하고, PAT 는
 * 살아 있는 **에이전트**의 것이어야 한다(#1138). 한쪽만 고치면 훅이 거절하는 토큰의 소켓이 다음
 * 재접속까지 산다.
 */
export async function findInvalidCredentials(pool: Pool, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  try {
    const res = await pool.query(
      `select s.token_hash from session s join account a on a.id = s.account_id
        where s.token_hash = any($1) and s.expires_at > now() and a.deleted_at is null
       union all
       select p.token_hash from pat p join account a on a.id = p.account_id
        where p.token_hash = any($1) and p.revoked_at is null and a.deleted_at is null and a.kind = 'agent'`,
      [hashes],
    );
    const valid = new Set<string>(res.rows.map((r: { token_hash: string }) => r.token_hash));
    return new Set(hashes.filter((h) => !valid.has(h)));
  } catch {
    // fail-open. 왕복 한 번 실패로 전원을 끊으면 일시적 DB 장애가 강제 로그아웃 사고가 된다.
    // 판정을 여기서 삼키는 것이 sweep 루프의 안전장치도 된다 — 루프 안에서 던지면
    // unhandled rejection 이고, Node 기본 설정에서 그건 프로세스 종료다.
    return new Set();
  }
}

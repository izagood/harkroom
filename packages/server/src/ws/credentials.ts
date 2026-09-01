import type { Pool } from 'pg';

/**
 * 살아 있는 소켓들의 토큰 해시 중 **더 이상 유효하지 않은 것**을 골라낸다.
 *
 * 토큰은 연결 시점에만 검증됐다. 그래서 세션 만료·PAT 폐기·계정 삭제가 이미 열린 소켓을
 * 끊지 못했고, 폐기된 자격증명이 워크스페이스 이벤트를 계속 받았다. 이 함수가 그 판정을 맡는다.
 */
export async function findInvalidCredentials(pool: Pool, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  try {
    const res = await pool.query(
      `select token_hash from session where token_hash = any($1) and expires_at > now()
       union all
       select token_hash from pat where token_hash = any($1) and revoked_at is null`,
      [hashes],
    );
    const valid = new Set<string>(res.rows.map((r: { token_hash: string }) => r.token_hash));
    return new Set(hashes.filter((h) => !valid.has(h)));
  } catch {
    // fail-open. DB 왕복 한 번 실패로 전원을 끊으면 일시적 장애가 강제 로그아웃 사고가 된다 —
    // 다음 sweep에서 다시 본다. 열린 소켓이 잠시 더 사는 위험보다 이쪽이 작다.
    return new Set();
  }
}

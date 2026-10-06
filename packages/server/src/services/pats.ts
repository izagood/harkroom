/**
 * PAT 발급 규칙 — 한 곳. 발급 라우트(`POST /accounts/:id/pats`)는 410 으로 닫혔고(103 무렵,
 * 결정 스레드 c4f4dab4) 오퍼레이터 경로의 발급 라우트는 그 전에 사라졌다. 지금 부르는 쪽은 테스트뿐이다 —
 * viaPat 인증이 남아 있는 동안 에이전트로 서는 요청을 재려면 토큰이 있어야 한다. 인증을 걷어낼 때
 * 이 파일도 함께 지운다.
 */
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { newToken } from '../auth/tokens.js';
import { recordAudit } from '../audit.js';

export type MintOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: 'label_in_use' };

/**
 * 라벨은 살아 있는 토큰 안에서 유일하다(마이그레이션 010) — 같은 라벨이 둘이면 라벨로
 * 폐기하는 DELETE 가 둘 다 지워 UI 가 약속하는 것과 달라진다.
 */
export async function mintPat(
  pool: Pool, accountId: string, label: string,
  actor: { actorId: string | null; actorHandle: string | null }, req?: FastifyRequest,
): Promise<MintOutcome> {
  const live = await pool.query(
    `select 1 from pat where account_id = $1 and label = $2 and revoked_at is null`, [accountId, label]);
  if (live.rowCount) return { ok: false, reason: 'label_in_use' };
  const { token, hash } = newToken('hrkp');
  await pool.query(`insert into pat (token_hash, account_id, label) values ($1, $2, $3)`, [hash, accountId, label]);
  // pat 행은 토큰을 받은 에이전트만 가리킨다 — 누가 그 권한을 줬는지는 여기 남긴다.
  // 토큰도 해시도 남기지 않는다: 라벨과 대상만으로 추적에 충분하다.
  await recordAudit(pool, { action: 'pat.issued', ...actor, target: accountId, detail: { label } }, req);
  return { ok: true, token };
}

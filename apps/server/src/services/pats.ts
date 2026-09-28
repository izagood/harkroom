/**
 * PAT 발급 — 한 곳. `POST /accounts/:id/pats`(사람이 발급)와 `POST /operator/agents/:id/pat`
 * (오퍼레이터가 배정된 에이전트 것을 받음, 단계 2~3 한정)이 같은 규칙을 쓴다. 발급 규칙이
 * 두 곳에 살면 접두·길이·감사가 갈린다.
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

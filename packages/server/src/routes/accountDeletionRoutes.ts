import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import type { RateLimiter, RateLimitRule } from '../rateLimit.js';
import type { StorageBackend } from '../storage/local.js';
import { deleteHumanAccount } from '../services/accountDeletion.js';

/**
 * `DELETE /accounts/me` — 사람이 이 워크스페이스에서 자기 계정을 지운다(서비스 주석 참고).
 *
 * **비밀번호를 다시 받는다.** 세션 토큰 하나만으로 계정이 영영 사라지면 안 된다. 시도는 계정마다
 * 상한(`ACCOUNT_DELETE_RULE`)으로 센다 — 털린 세션으로 비밀번호를 맞춰 보는 길이 되지 않게.
 * 세션으로 선 사람만 받는다: PAT·오퍼레이터는 사람 계정을 지울 자격이 아니다.
 */
export const ACCOUNT_DELETE_RULE: RateLimitRule = { windowMs: 15 * 60_000, max: 10 };

export async function registerAccountDeletionRoutes(
  app: FastifyInstance, pool: Pool, storage: StorageBackend,
  opts: { limiter: RateLimiter },
): Promise<void> {
  app.delete('/accounts/me', { preHandler: app.requireAccount }, async (req, reply) => {
    const me = req.account!;
    if (me.kind !== 'human' || req.authVia !== 'session') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only a signed-in person can delete their account' } });
    }
    const body = z.object({ password: z.string().min(1).max(1024) }).parse(req.body);

    const verdict = opts.limiter.hit(`accountDelete:${me.id}`, ACCOUNT_DELETE_RULE);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)))
        .send({ error: { code: 'rate_limited', message: 'too many attempts, try again later' } });
    }
    const row = await pool.query<{ password_hash: string | null }>(
      `select password_hash from account where id = $1`, [me.id]);
    const hash = row.rows[0]?.password_hash;
    if (!hash || !(await argon2.verify(hash, body.password))) {
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'wrong password' } });
    }

    const result = await deleteHumanAccount(pool, me.id);
    if (!result.ok) {
      const { block } = result;
      return reply.code(409).send({
        error: block.code === 'owns_agents'
          ? { code: 'owns_agents', message: 'transfer or delete the agents you own first', agents: block.agents }
          : { code: 'last_admin', message: 'make someone else an admin first' },
      });
    }
    opts.limiter.reset(`accountDelete:${me.id}`);
    if (result.avatarStorageKey) {
      await storage.remove(result.avatarStorageKey).catch((err) => req.log.warn({ err }, 'avatar file removal failed'));
    }
    // 옛 handle 은 남기지 않는다 — 감사는 id 로 가리킨다(이름을 지우는 삭제다).
    await recordAudit(pool, { action: 'account.deleted', actorId: me.id, actorHandle: null }, req);
    return reply.code(204).send();
  });
}

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import { newToken, hashToken } from '../auth/tokens.js';
import { recordAudit } from '../audit.js';
import { createChannel } from '../services/channels.js';
import { getHandleGroupByHandle } from '../services/handleGroups.js';

const SESSION_TTL_DAYS = 14;

/**
 * 부트스트랩이 시딩하는 기본 채널 이름. `POST /channels` 의 이름 규칙
 * (`CHANNEL_NAME_PATTERN`)을 만족해야 한다 — 테스트가 그걸 확인한다.
 * export 하는 이유: 테스트가 이 이름을 문자열로 다시 적으면 두 곳이 갈린다.
 */
export const DEFAULT_CHANNEL_NAME = 'general';

const credentials = z.object({
  handle: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(128),
});

export async function registerAuthRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/bootstrap', async (req, reply) => {
    const existing = await pool.query(`select 1 from account where kind = 'human' limit 1`);
    if (existing.rowCount) {
      return reply.code(409).send({ error: { code: 'already_bootstrapped', message: 'workspace already has a human account' } });
    }
    const body = credentials.parse(req.body);
    const hash = await argon2.hash(body.password);
    // 계정과 기본 채널은 한 트랜잭션이어야 한다 — 채널 생성이 실패해 계정만 남으면, 다음
    // 부트스트랩은 409(이미 부트스트랩됨)로 막히고 워크스페이스는 채널 0 개로 굳는다.
    // 그래서 `createChannel` 을 **이 트랜잭션의 커넥션으로** 부른다. pool 로 부르면 다른
    // 커넥션에서 도는 별개의 자동커밋이 되어, begin/commit 이 장식만 된다.
    const client = await pool.connect();
    let accountId: string;
    let channelId: string;
    try {
      await client.query('begin');
      const res = await client.query(
        `insert into account (handle, display_name, kind, is_admin, password_hash)
         values ($1, $2, 'human', true, $3) returning id`,
        [body.handle, body.displayName, hash],
      );
      accountId = res.rows[0].id;
      channelId = (await createChannel(client, { name: DEFAULT_CHANNEL_NAME })).id;
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    // 감사 기록은 **커밋 뒤에** 남긴다. 트랜잭션 안에서 pool 로 남기면 롤백돼도 로그는
    // 남아 감사 추적이 거짓을 말하고, 트랜잭션 안의 커넥션으로 남기면 롤백과 함께 사라져
    // "실패했다"는 사실조차 안 남는다. append-only 로그의 성격상 사실이 확정된 뒤가 맞다.
    await recordAudit(pool, {
      action: 'account.created', actorId: accountId, actorHandle: body.handle,
      target: accountId, detail: { via: 'bootstrap', isAdmin: true },
    }, req);
    await recordAudit(pool, {
      action: 'channel.created', actorId: accountId, actorHandle: body.handle,
      target: channelId, detail: { via: 'bootstrap' },
    }, req);
    return reply.code(201).send({ id: accountId });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ handle: z.string(), password: z.string() }).parse(req.body);
    const res = await pool.query(
      `select id, password_hash from account where handle = $1 and kind = 'human'`, [body.handle]);
    const row = res.rows[0];
    if (!row?.password_hash || !(await argon2.verify(row.password_hash, body.password))) {
      // 실패한 로그인이 안 남으면 브루트포스 흔적을 사후에 볼 수 없다. 레이트 리밋은 막기만 하고
      // 기록하지 않는다. 존재하지 않는 handle 도 남긴다 — 계정 열거 시도 자체가 신호다.
      await recordAudit(pool, {
        action: 'login.failed', actorId: row?.id ?? null, actorHandle: body.handle,
      }, req);
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'wrong handle or password' } });
    }
    const { token, hash } = newToken('murs');
    await pool.query(
      `insert into session (token_hash, account_id, expires_at)
       values ($1, $2, now() + interval '${SESSION_TTL_DAYS} days')`,
      [hash, row.id],
    );
    await recordAudit(pool, {
      action: 'login.succeeded', actorId: row.id, actorHandle: body.handle,
    }, req);
    return { token };
  });

  app.get('/auth/me', { preHandler: app.requireAccount }, async (req) => req.account);

  // 로그아웃은 **이 토큰만** 끊는다. 한 기기에서 나가는 것이 모든 기기에서 쫓겨나는 것과
  // 같으면 놀라움이 크다 — 전체 폐기가 필요하면 별도 표면이어야 한다. 지금까지는 클라이언트가
  // 로컬 토큰만 지웠고 서버 세션은 TTL(14일)을 그대로 살았다.
  app.post('/auth/logout', { preHandler: app.requireAccount }, async (req, reply) => {
    await pool.query(`delete from session where token_hash = $1`, [req.credentialHash]);
    await recordAudit(pool, {
      action: 'logout', actorId: req.account!.id, actorHandle: req.account!.handle,
    }, req);
    return reply.code(204).send();
  });

  app.post('/auth/register', async (req, reply) => {
    const body = credentials.extend({ inviteToken: z.string() }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const inv = await client.query(
        `select token_hash from invite where token_hash = $1 and used_by is null for update`,
        [hashToken(body.inviteToken)],
      );
      if (!inv.rowCount) {
        await client.query('rollback');
        return reply.code(400).send({ error: { code: 'invalid_invite', message: 'invite invalid or used' } });
      }

      const group = await getHandleGroupByHandle(pool, body.handle);
      if (group) {
        await client.query('rollback');
        return reply.code(400).send({
          error: { code: 'handle_taken', message: 'a group with this handle already exists' },
        });
      }

      const pw = await argon2.hash(body.password);
      const acc = await client.query(
        `insert into account (handle, display_name, kind, password_hash)
         values ($1, $2, 'human', $3) returning id`,
        [body.handle, body.displayName, pw],
      );
      await client.query(`update invite set used_by = $1 where token_hash = $2`, [acc.rows[0].id, inv.rows[0].token_hash]);
      await client.query('commit');
      await recordAudit(pool, {
        action: 'account.created', actorId: acc.rows[0].id, actorHandle: body.handle,
        target: acc.rows[0].id, detail: { via: 'invite' },
      }, req);
      return reply.code(201).send({ id: acc.rows[0].id });
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * 로그인한 사람이 자기 비밀번호를 바꾼다(#110). 이전에는 계정 생성 시 한 번 쓰고 나면
   * 바꿀 방법이 API 에도 UI 에도 없었다.
   *
   * **현재 비밀번호를 함께 받는다**: 세션 토큰만으로 바꾸게 하면 훔친 토큰이 곧 계정 탈취가
   * 된다. 검증은 `POST /auth/login` 과 같은 `argon2.verify` 다.
   *
   * 잠겨서 로그인 자체가 안 되는 경우는 이 라우트로 풀 수 없다 — 풀 수 있으면 그게
   * 취약점이다. 그 경로는 `packages/server/scripts/reset-password.ts`(운영자가 서버 호스트에서
   * 직접 돌린다)이고 `docs/operations.md` §10 에 절차가 있다.
   */
  app.post('/auth/password', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({
      currentPassword: z.string(),
      // 새 비밀번호 규칙은 계정 생성과 **같은 것**을 쓴다 — 여기서 다시 적으면 두 곳이 갈린다.
      newPassword: credentials.shape.password,
    }).parse(req.body);

    const account = req.account!;
    if (account.kind !== 'human') {
      return reply.code(400).send({ error: { code: 'invalid_account', message: 'password change is only for human accounts' } });
    }

    const res = await pool.query(
      `select password_hash from account where id = $1`, [account.id]);
    const row = res.rows[0];

    if (!row?.password_hash || !(await argon2.verify(row.password_hash, body.currentPassword))) {
      await recordAudit(pool, {
        action: 'password.changed', actorId: account.id, actorHandle: account.handle,
        detail: { success: false, reason: 'current_password_mismatch' },
      }, req);
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'wrong current password' } });
    }

    const newHash = await argon2.hash(body.newPassword);
    await pool.query(`update account set password_hash = $1 where id = $2`, [newHash, account.id]);

    // 다른 기기의 세션은 무효화하고 **현재 세션은 남긴다.** 비밀번호를 바꾸는 흔한 이유가
    // "털린 것 같다"이므로 남은 세션을 끊는 것이 맞고, 지금 쓰고 있는 세션까지 끊으면
    // 사용자가 방금 바꾼 비밀번호로 다시 로그인해야 한다(바꾸자마자 로그아웃되는 UX).
    await pool.query(`delete from session where account_id = $1 and token_hash != $2`, [account.id, req.credentialHash]);

    await recordAudit(pool, {
      action: 'password.changed', actorId: account.id, actorHandle: account.handle,
      detail: { otherSessionsInvalidated: true },
    }, req);

    return reply.code(204).send();
  });
}

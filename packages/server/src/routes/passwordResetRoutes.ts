import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import { hashToken, newToken } from '../auth/tokens.js';
import { recordAudit } from '../audit.js';
import type { RateLimiter, RateLimitRule } from '../rateLimit.js';
import { currentStepUp } from '../services/stepUp.js';
import { OncePerWindow } from '../services/secretAccess.js';
import { newResetCode, normalizeResetCode, RESET_CODE_TTL_MS } from '../services/passwordReset.js';
import { normalizeLoginKey, passwordRule, SESSION_TTL_DAYS } from './authRoutes.js';

/**
 * 비밀번호 재설정 코드(스레드 a6017542, jaebin B안 — 관리자 발급·30분·코드만·관리자만).
 *
 * account 에 이메일이 없어(#110) 메일 링크로 되찾는 길이 없다. 대신 관리자가 멤버 하나에게 1회용 코드를
 * 발급하고, 그 사람이 로그인 화면에서 로그인 ID·코드·새 비밀번호를 대면 바뀐다. 관리자는 새 비밀번호를
 * 보지 못한다. 소유자 혼자 잠긴 경우는 이 길이 아니다 — 운영 도구(`scripts/reset-password.ts`)다.
 *
 * 지키는 것(designer 시안 R1~R7):
 * - R1 실패 응답은 **하나**다 — 로그인 ID 가 없음·코드 틀림·만료·이미 씀·거둠을 가르지 않는다(열거 방지).
 * - R4 30분·1회용·사람마다 살아 있는 코드 하나(새로 발급하면 이전 것은 닫힌다).
 * - R5 쓰면 그 계정의 세션을 **전부** 지우고 새 세션 하나를 준다(곧바로 로그인).
 * - R6 발급은 세션 + step-up(비밀번호 재확인) 뒤에만, 코드는 응답에 한 번만 싣는다. 발급·사용·거둠은 감사에 남긴다.
 * - R7 대상 본인에게 「관리자가 코드를 발급했다」를 알린다 — `GET /auth/password-reset-notices`.
 *
 * 누가 누구에게: `member.reset_password` 는 owner·admin 만 갖는다(grant 로 넓히지 않는다 — `can()`).
 * owner 계정은 **대상이 될 수 없다**. admin 계정은 owner 만 대상으로 삼는다(`/accounts/:id/role` 의
 * 「admin 임명·해제는 owner 만」과 같은 선 — admin 끼리 서로의 계정을 가져가지 못하게).
 */
export interface PasswordResetRouteOpts {
  limiter: RateLimiter;
  /** 로그인 ID 단위 재설정 시도 상한. 주소 단위는 `LIMITED_ROUTES` 가 앞에서 센다. */
  accountRule: RateLimitRule;
}

const idParam = z.object({ id: z.string().uuid() });

const INVALID = { error: { code: 'invalid_reset_code', message: 'the reset code is wrong, already used, or expired' } } as const;

export async function registerPasswordResetRoutes(app: FastifyInstance, pool: Pool, opts: PasswordResetRouteOpts): Promise<void> {
  const { limiter, accountRule } = opts;
  /** 로그인 ID 목록 읽기 감사는 사람마다 하루 한 줄(값 없이 건수만). */
  const loginIdsReadAudit = new OncePerWindow();

  /** 발급·거두기 공통 관문: 대상이 사람이고 살아 있고, 이 행위자가 그 대상을 건드릴 수 있는가. */
  async function targetFor(actor: { id: string; role: string }, id: string): Promise<
    { ok: true; handle: string; loginId: string } | { ok: false; status: 400 | 403 | 404; code: string; message: string }
  > {
    if (id === actor.id) return { ok: false, status: 400, code: 'self', message: 'use POST /auth/password for your own password' };
    const r = await pool.query<{ handle: string; role: string; loginId: string }>(
      `select handle, role, login_id as "loginId" from account
        where id = $1 and kind = 'human' and deleted_at is null and disabled_at is null`, [id]);
    const row = r.rows[0];
    if (!row) return { ok: false, status: 404, code: 'not_found', message: 'no such person' };
    if (row.role === 'owner') return { ok: false, status: 403, code: 'owner_target', message: 'an owner password is reset with the server tool, not a code' };
    if (row.role === 'admin' && actor.role !== 'owner') {
      return { ok: false, status: 403, code: 'forbidden', message: 'only the owner can issue a reset code for an admin' };
    }
    return { ok: true, handle: row.handle, loginId: row.loginId };
  }

  /**
   * 사람들의 **로그인 ID** — 설정 › 멤버와 초대에서 관리자가 「이 사람 로그인 ID 가 뭐지」에 답하게(jaebin A안, 10-23).
   * handle 과 로그인 ID 가 다른 사람이 있다(10-22 jinbin). `/accounts` 에 칸을 더하지 않고 **따로** 두는 이유: 그 목록은
   * 모두가 받고 화면이 캐시·이벤트로 퍼뜨린다 — 거기 실으면 권한으로 거르는 자리가 여럿이 된다. 여기는 한 자리다.
   *
   * 보는 사람은 재설정 코드를 발급할 수 있는 사람과 같다(`member.reset_password` = owner·admin, grant 불가)·세션만.
   * **보이는 대상도 발급 대상과 같다**(security #1490 F1, `targetFor` 와 같은 선): 사람·살아 있음·꺼지지 않음, owner 제외,
   * 부른 사람이 admin 이면 admin 도 제외(owner 는 admin 까지 본다), 자기 자신 제외. 「[재설정 코드] 버튼이 서는 줄 = 로그인 ID 가
   * 보이는 줄」이다 — owner 의 login_id 는 로그인의 절반인데 코드로 재설정할 수 없는 대상이라 알 까닭이 없다.
   * 값은 감사·로그에 싣지 않는다. 읽은 사실(누가·건수)만 사람마다 하루 한 줄 남긴다(security 낮은 것).
   */
  app.get('/accounts/login-ids', { preHandler: app.requireCap('member.reset_password') }, async (req, reply) => {
    if (req.account!.kind !== 'human' || req.authVia !== 'session') {
      return reply.code(403).send({ error: { code: 'session_required', message: 'only a signed-in person can read login IDs' } });
    }
    const actor = req.account!;
    const r = await pool.query<{ id: string; loginId: string }>(
      `select id, login_id as "loginId" from account
        where kind = 'human' and deleted_at is null and disabled_at is null and login_id is not null
          and id <> $1 and role <> 'owner' and ($2::text = 'owner' or role <> 'admin')`, [actor.id, actor.role]);
    if (loginIdsReadAudit.first(actor.id, Date.now(), 24 * 60 * 60_000)) {
      await recordAudit(pool, {
        action: 'accounts.login_ids.read', actorId: actor.id, actorHandle: actor.handle, detail: { count: r.rowCount ?? 0 },
      }, req);
    }
    void reply.header('cache-control', 'no-store');
    return { loginIds: Object.fromEntries(r.rows.map((x) => [x.id, x.loginId])) };
  });

  app.post('/accounts/:id/password-reset-code', { preHandler: app.requireCap('member.reset_password') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const actor = req.account!;
    // 비밀번호에 닿는 일이라 세션 + step-up 을 요구한다(R6). PAT·오퍼레이터에는 창이 없다.
    if (actor.kind !== 'human' || req.authVia !== 'session') {
      return reply.code(403).send({ error: { code: 'session_required', message: 'only a signed-in person can issue a reset code' } });
    }
    if (!(await currentStepUp(pool, req.credentialHash))) {
      return reply.code(403).send({ error: { code: 'step_up_required', message: 'confirm your password before issuing a reset code' } });
    }
    const target = await targetFor(actor, id);
    if (!target.ok) return reply.code(target.status).send({ error: { code: target.code, message: target.message } });

    const { display, hash } = newResetCode();
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS);
    const client = await pool.connect();
    let revoked = 0;
    try {
      await client.query('begin');
      // 계정 행을 잠가 같은 사람에게 동시에 둘이 발급되지 않게 한다 — 부분 유일 색인이 마지막 방어선이다.
      await client.query(`select 1 from account where id = $1 for update`, [id]);
      revoked = (await client.query(
        `update password_reset_code set revoked_at = now()
          where account_id = $1 and used_at is null and revoked_at is null`, [id])).rowCount ?? 0;
      await client.query(
        `insert into password_reset_code (account_id, code_hash, issued_by, expires_at) values ($1, $2, $3, $4)`,
        [id, hash, actor.id, expiresAt]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    // 감사는 커밋 뒤에(authRoutes 와 같은 근거). 코드는 싣지 않는다.
    await recordAudit(pool, {
      action: 'password_reset_code.issued', actorId: actor.id, actorHandle: actor.handle,
      target: id, detail: { replacedLiveCode: revoked > 0, expiresAt: expiresAt.toISOString() },
    }, req);
    void reply.header('cache-control', 'no-store');
    // 대상의 **로그인 ID** 를 함께 싣는다(10-22 jinbin 사고: handle 은 `jin`, 로그인 ID 는 달랐다 → 사람이 handle 을
    // 쳐서 맞는 코드로도 네 번 실패). 재설정은 로그인 ID 로 찾으므로 코드만 전하면 반쪽이다. 발급 권한이 있는 관리자에게만
    // 가는 응답이고, 그 관리자는 어차피 이 계정의 비밀번호를 바꿀 수 있다.
    return reply.code(201).send({ code: display, expiresAt: expiresAt.toISOString(), loginId: target.loginId });
  });

  /** 잘못 보냈을 때 거둔다. 살아 있는 코드가 없어도 204(멱등) — 있었는지를 응답으로 가르지 않는다. */
  app.delete('/accounts/:id/password-reset-code', { preHandler: app.requireCap('member.reset_password') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const actor = req.account!;
    const target = await targetFor(actor, id);
    if (!target.ok) return reply.code(target.status).send({ error: { code: target.code, message: target.message } });
    const r = await pool.query(
      `update password_reset_code set revoked_at = now()
        where account_id = $1 and used_at is null and revoked_at is null`, [id]);
    if (r.rowCount) {
      await recordAudit(pool, {
        action: 'password_reset_code.revoked', actorId: actor.id, actorHandle: actor.handle, target: id,
      }, req);
    }
    return reply.code(204).send();
  });

  /**
   * 코드로 비밀번호를 바꾸고 곧바로 로그인한다(R5). **인증 없는 표면**이다 — 주소 단위 리밋은
   * `LIMITED_ROUTES` 가, 로그인 ID 단위 리밋은 여기서 Argon2 앞에 센다(`/auth/login` 과 같은 틀).
   */
  app.post('/auth/password-reset', async (req, reply) => {
    const body = z.object({
      loginId: z.string().max(64),
      code: z.string().max(64),
      newPassword: passwordRule,
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: { code: 'bad_request', message: body.error.message } });
    const { loginId, code, newPassword } = body.data;

    const key = `passwordReset:${normalizeLoginKey(loginId)}`;
    const verdict = limiter.hit(key, accountRule);
    if (!verdict.allowed) {
      await recordAudit(pool, {
        action: 'password_reset_code.failed', actorId: null, actorHandle: loginId, detail: { reason: 'rate_limited' },
      }, req);
      const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      return reply.code(429).header('retry-after', String(retryAfterSec))
        .send({ error: { code: 'rate_limited', message: 'too many attempts, try again later', retryAfterSec } });
    }

    const normalized = normalizeResetCode(code);
    const fail = async () => {
      // 없는 login_id 도 남긴다 — 실패한 로그인과 같은 근거(시도 자체가 신호다).
      await recordAudit(pool, { action: 'password_reset_code.failed', actorId: null, actorHandle: loginId }, req);
      return reply.code(400).send(INVALID);
    };
    if (!normalized) return fail();

    // 해시는 트랜잭션 **밖에서** 만든다 — 행 잠금을 쥔 채 Argon2 를 돌리지 않는다.
    const newHash = await argon2.hash(newPassword);
    const client = await pool.connect();
    let accountId: string | null = null;
    let handle = '';
    let codeId = '';
    let token = '';
    try {
      await client.query('begin');
      // 코드·로그인 ID·계정 상태를 한 줄로 본다 — 어느 조건에서 떨어졌는지 알 수 없게(R1).
      // `for update of c` 로 같은 코드를 든 두 요청이 동시에 통과하지 못하게 한다.
      // **발급 조건을 쓰는 순간에 다시 본다**(security F1): 30분 사이 발급자가 강등·비활성·삭제됐거나 대상이
      // admin 으로 올랐으면 그 코드는 죽는다 — 발급 때의 `targetFor` 판정만 믿으면 강등된 admin 이 받아 둔
      // 코드로 계정을 가져가고, 승격된 대상에게 「admin 대상은 owner 만」 선이 뚫린다.
      const r = await client.query<{ id: string; accountId: string; handle: string }>(
        `select c.id, c.account_id as "accountId", a.handle
           from password_reset_code c
           join account a on a.id = c.account_id
           join account i on i.id = c.issued_by
          where c.code_hash = $1 and lower(a.login_id) = lower($2)
            and c.used_at is null and c.revoked_at is null and c.expires_at > now()
            and a.kind = 'human' and a.deleted_at is null and a.disabled_at is null and a.role <> 'owner'
            and i.kind = 'human' and i.deleted_at is null and i.disabled_at is null and i.role in ('owner', 'admin')
            and (a.role <> 'admin' or i.role = 'owner')
          for update of c`,
        [hashToken(normalized), loginId]);
      const row = r.rows[0];
      if (!row) {
        await client.query('rollback');
      } else {
        accountId = row.accountId; handle = row.handle; codeId = row.id;
        await client.query(`update password_reset_code set used_at = now() where id = $1`, [row.id]);
        await client.query(`update account set password_hash = $1 where id = $2`, [newHash, row.accountId]);
        // 털린 계정을 되찾는 흔한 경우다 — 옛 세션은 전부 끊는다(R5).
        await client.query(`delete from session where account_id = $1`, [row.accountId]);
        const minted = newToken('hrks');
        token = minted.token;
        await client.query(
          `insert into session (token_hash, account_id, expires_at)
           values ($1, $2, now() + interval '${SESSION_TTL_DAYS} days')`, [minted.hash, row.accountId]);
        await client.query('commit');
      }
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    if (!accountId) return fail();

    limiter.reset(key);
    await recordAudit(pool, {
      action: 'password_reset_code.used', actorId: accountId, actorHandle: handle, target: accountId, detail: { codeId },
    }, req);
    await recordAudit(pool, {
      action: 'password.changed', actorId: accountId, actorHandle: handle,
      detail: { via: 'reset_code', allSessionsInvalidated: true },
    }, req);
    void reply.header('cache-control', 'no-store');
    return { token };
  });

  /**
   * 내 계정에 발급된 재설정 코드 중 아직 확인하지 않은 것(R7). 본인이 요청하지 않은 발급을 알아차리게 한다.
   * 발급자는 id 로만 싣는다 — 이름은 화면이 계정 목록에서 찾는다(이름은 바뀌는 이름표다).
   */
  app.get('/auth/password-reset-notices', { preHandler: app.requireAccount }, async (req) => {
    const r = await pool.query(
      `select id, issued_by as "issuedById", created_at as "issuedAt", expires_at as "expiresAt",
              used_at as "usedAt", revoked_at as "revokedAt"
         from password_reset_code
        where account_id = $1 and notice_seen_at is null
        order by created_at desc limit 20`, [req.account!.id]);
    return { notices: r.rows };
  });

  /** 알림을 확인했다. ids 를 주면 그것만, 안 주면 내 것 전부. 남의 것은 조건에서 걸러진다. */
  app.post('/auth/password-reset-notices/ack', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object({ ids: z.array(z.string().uuid()).max(50).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: { code: 'bad_request', message: body.error.message } });
    const ids = body.data.ids;
    await pool.query(
      `update password_reset_code set notice_seen_at = now()
        where account_id = $1 and notice_seen_at is null and ($2::uuid[] is null or id = any($2::uuid[]))`,
      [req.account!.id, ids ?? null]);
    return reply.code(204).send();
  });
}

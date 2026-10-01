// 비밀 보관소(085) — 사람용 REST. 저장·값 바꾸기·지우기·부여·회수·감사 조회.
//
// 규칙(보안 검토 반영, 스레드 bc98df3a):
// - **에이전트는 이 표면을 하나도 못 쓴다.** 에이전트가 비밀을 만들거나 부여할 수 있으면 "권한을
//   받은 에이전트만"이 에이전트 자신의 판단이 된다. 받는 길(reveal)은 다음 PR 에 따로 있다.
// - **부여는 소유자만**(D4·M2). admin 이 부여할 수 있으면 admin 은 자기가 움직이는 에이전트에게
//   주고 받아 가서 모든 값을 읽는다. admin 은 회수·삭제만 한다.
// - **값은 한 번 들어오면 다시 나가지 않는다.** 응답·감사·오류 어디에도 값이나 그 해시를 싣지 않는다.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { actorOf, recordAudit } from '../audit.js';
import { scanWrite } from '../services/contentScan.js';
import type { SecretKeyring } from '../services/secretKeyring.js';
import { needlesFor } from '../services/secretLeakGuard.js';
import { endTurnLease, issueTurnLease, revealSecret, RevealLimiter } from '../services/secretAccess.js';

/** 계획 D6. 파일·텍스트 공통 상한(바이트). */
export const SECRET_MAX_BYTES = 64 * 1024;

const agentRefused = { error: { code: 'forbidden', message: 'agents cannot manage secrets' } };
const disabled = {
  error: { code: 'secret_store_disabled', message: 'HARKROOM_SECRET_KEYS_DIR is not set on the server; the secret store is off' },
};
const notFound = { error: { code: 'not_found', message: 'no such secret' } };
const descriptionLeak = { error: { code: 'secret_in_description', message: 'the description looks like it contains a secret value' } };

const idParam = z.object({ id: z.string().uuid() });
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// 마운트할 때 알려 줄 이름일 뿐 경로로 쓰지 않지만, 경로 조각처럼 생긴 것은 처음부터 받지 않는다.
const FILENAME = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/;

const valueFields = {
  value: z.string().optional(),
  valueBase64: z.string().optional(),
};
const createBody = z.object({
  name: z.string().regex(NAME),
  kind: z.enum(['text', 'file']),
  filename: z.string().regex(FILENAME).nullable().optional(),
  description: z.string().max(500).default(''),
  expiresAt: z.string().datetime().nullable().optional(),
  ...valueFields,
});
const replaceBody = z.object(valueFields);
const patchBody = z.object({
  description: z.string().max(500).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
const grantBody = z.object({
  agentId: z.string().uuid(),
  channelId: z.string().uuid().nullable().default(null),
  // 'current' = 지금 배정된 오퍼레이터에 묶는다(기본, M1). 'any' = 소유자가 명시적으로 푼 것.
  operator: z.enum(['current', 'any']).default('current'),
});

interface SecretRow {
  id: string; name: string; kind: 'text' | 'file'; filename: string | null; description: string;
  ownerAccountId: string; expiresAt: string | null; createdAt: string; updatedAt: string;
  version: number | null; sizeBytes: number | null; grantCount: number;
}

const SECRET_COLS = `s.id, s.name, s.kind, s.filename, s.description, s.owner_account_id as "ownerAccountId",
  s.expires_at as "expiresAt", s.created_at as "createdAt", s.updated_at as "updatedAt",
  v.version, v.size_bytes as "sizeBytes",
  (select count(*)::int from secret_grant g where g.secret_id = s.id) as "grantCount"`;
const SECRET_FROM = `secret s left join lateral (
    select version, size_bytes from secret_version
     where secret_id = s.id and revoked_at is null order by version desc limit 1) v on true`;

async function getSecret(pool: Pool, id: string): Promise<SecretRow | null> {
  const r = await pool.query(`select ${SECRET_COLS} from ${SECRET_FROM} where s.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** 값 칸을 바이트로. kind 와 칸이 맞지 않거나 크기가 틀리면 오류 문장을 준다(값은 되비추지 않는다). */
function valueBytes(kind: 'text' | 'file', v: { value?: string; valueBase64?: string }): Buffer | string {
  if (kind === 'text') {
    if (typeof v.value !== 'string' || v.valueBase64 !== undefined) return 'text secrets take `value`';
    const b = Buffer.from(v.value, 'utf8');
    if (!b.length) return 'value is empty';
    if (b.length > SECRET_MAX_BYTES) return `value is larger than ${SECRET_MAX_BYTES} bytes`;
    return b;
  }
  if (typeof v.valueBase64 !== 'string' || v.value !== undefined) return 'file secrets take `valueBase64`';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v.valueBase64)) return 'valueBase64 is not base64';
  const b = Buffer.from(v.valueBase64, 'base64');
  if (!b.length) return 'file is empty';
  if (b.length > SECRET_MAX_BYTES) return `file is larger than ${SECRET_MAX_BYTES} bytes`;
  return b;
}

export async function registerSecretRoutes(
  app: FastifyInstance, pool: Pool, opts: { keyring: SecretKeyring | null; limiter?: RevealLimiter },
): Promise<void> {
  const { keyring } = opts;
  const limiter = opts.limiter ?? new RevealLimiter();

  /** 사람만. 아니면 답을 보내고 false. */
  const human = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.account!.kind === 'agent') { void reply.code(403).send(agentRefused); return false; }
    return true;
  };
  /**
   * 소유자 또는(허용하면) admin 이 보는 비밀. 남의 것은 **있어도 404** 다 — 이름은 권한의 지도다.
   * admin 은 목록에서 이미 보므로 숨길 것이 없다.
   */
  const load = async (
    req: FastifyRequest, reply: FastifyReply, allowAdmin: boolean,
  ): Promise<SecretRow | null> => {
    const { id } = idParam.parse(req.params);
    const s = await getSecret(pool, id);
    const me = req.account!;
    if (!s || (s.ownerAccountId !== me.id && !(allowAdmin && me.isAdmin))) {
      await reply.code(404).send(notFound);
      return null;
    }
    return s;
  };

  app.get('/secrets', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const me = req.account!;
    const r = await pool.query(
      `select ${SECRET_COLS} from ${SECRET_FROM}
        where $1::boolean or s.owner_account_id = $2 order by s.name`, [me.isAdmin, me.id]);
    return { enabled: keyring !== null, secrets: r.rows as SecretRow[] };
  });

  app.post('/secrets', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    if (!keyring) return reply.code(409).send(disabled);
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    const b = parsed.data;
    if (b.kind === 'file' && !b.filename) return reply.code(400).send({ error: { code: 'bad_request', message: 'file secrets need a filename' } });
    if (b.kind === 'text' && b.filename) return reply.code(400).send({ error: { code: 'bad_request', message: 'text secrets have no filename' } });
    // 설명은 에이전트에게 이름과 함께 보인다(secret.list). 거기에 값을 적으면 보관소가 무의미하다.
    if (scanWrite(b.description)?.rules.includes('secret')) {
      return reply.code(400).send({ error: { code: 'secret_in_description', message: 'the description looks like it contains a secret value' } });
    }
    const bytes = valueBytes(b.kind, b);
    if (typeof bytes === 'string') return reply.code(400).send({ error: { code: 'bad_value', message: bytes } });
    // 설명에 **이 비밀의 값**이 들어 있어도 거절한다 — 토큰 패턴이 아닌 값(비밀번호 등)은 위 검사가 못 본다.
    if (needlesFor(bytes).some((n) => b.description.includes(n))) return reply.code(400).send(descriptionLeak);

    const id = randomUUID();
    const sealed = keyring.seal(bytes, { secretId: id, version: 1, kind: b.kind });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into secret (id, name, kind, filename, description, owner_account_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, b.name, b.kind, b.filename ?? null, b.description, req.account!.id, b.expiresAt ?? null]);
      await client.query(
        `insert into secret_version (secret_id, version, sealed, size_bytes, created_by) values ($1, 1, $2, $3, $4)`,
        [id, sealed, bytes.length, req.account!.id]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      if ((e as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: { code: 'name_taken', message: 'a secret with that name already exists' } });
      }
      throw e;
    } finally {
      client.release();
    }
    await recordAudit(pool, { action: 'secret.created', ...actorOf(req), target: id, detail: { name: b.name, kind: b.kind } }, req);
    return reply.code(201).send({ secret: await getSecret(pool, id) });
  });

  app.get('/secrets/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const s = await load(req, reply, true);
    return s ? { secret: s } : reply;
  });

  app.patch('/secrets/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const s = await load(req, reply, false);
    if (!s) return reply;
    const parsed = patchBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const p = parsed.data;
    if (p.description !== undefined && scanWrite(p.description)?.rules.includes('secret')) {
      return reply.code(400).send({ error: { code: 'secret_in_description', message: 'the description looks like it contains a secret value' } });
    }
    if (p.description !== undefined && keyring) {
      const cur = (await pool.query(
        `select version, sealed from secret_version where secret_id = $1 and sealed is not null order by version desc limit 1`,
        [s.id])).rows[0] as { version: number; sealed: string } | undefined;
      const value = cur ? keyring.open(cur.sealed, { secretId: s.id, version: cur.version, kind: s.kind }) : null;
      if (value && needlesFor(value).some((n) => p.description!.includes(n))) return reply.code(400).send(descriptionLeak);
    }
    await pool.query(
      `update secret set description = coalesce($2, description),
         expires_at = case when $3::boolean then $4::timestamptz else expires_at end, updated_at = now()
       where id = $1`,
      [s.id, p.description ?? null, p.expiresAt !== undefined, p.expiresAt ?? null]);
    await recordAudit(pool, {
      action: 'secret.updated', ...actorOf(req), target: s.id,
      detail: { name: s.name, fields: Object.keys(p) },
    }, req);
    return { secret: await getSecret(pool, s.id) };
  });

  // 값 바꾸기 = 새 판. 옛 판의 암호문은 같은 트랜잭션에서 지운다 — 남겨 둘 이유가 없다.
  app.put('/secrets/:id/value', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    if (!keyring) return reply.code(409).send(disabled);
    const s = await load(req, reply, false);
    if (!s) return reply;
    const parsed = replaceBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const bytes = valueBytes(s.kind, parsed.data);
    if (typeof bytes === 'string') return reply.code(400).send({ error: { code: 'bad_value', message: bytes } });
    // 새 값이 이미 적힌 설명 안에 있으면 거절한다 — 설명은 에이전트에게 보인다(secret.list).
    if (needlesFor(bytes).some((n) => s.description.includes(n))) return reply.code(400).send(descriptionLeak);

    const client = await pool.connect();
    let version: number;
    try {
      await client.query('begin');
      // 같은 비밀을 동시에 바꾸면 판 번호가 겹친다 — 비밀 행을 잠가 줄을 세운다.
      await client.query(`select 1 from secret where id = $1 for update`, [s.id]);
      const cur = await client.query(`select coalesce(max(version), 0)::int as v from secret_version where secret_id = $1`, [s.id]);
      version = (cur.rows[0] as { v: number }).v + 1;
      const sealed = keyring.seal(bytes, { secretId: s.id, version, kind: s.kind });
      await client.query(
        `insert into secret_version (secret_id, version, sealed, size_bytes, created_by) values ($1, $2, $3, $4, $5)`,
        [s.id, version, sealed, bytes.length, req.account!.id]);
      await client.query(
        `update secret_version set sealed = null, revoked_at = now()
          where secret_id = $1 and version < $2 and revoked_at is null`, [s.id, version]);
      await client.query(`update secret set updated_at = now() where id = $1`, [s.id]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await recordAudit(pool, { action: 'secret.value.replaced', ...actorOf(req), target: s.id, detail: { name: s.name, version } }, req);
    return { secret: await getSecret(pool, s.id) };
  });

  // 지우기: 소유자 또는 admin. 암호문·판·부여는 cascade 로 사라지고 감사 기록(access_log)은 남는다.
  // harkroom 에서 지우는 것은 **발급처의 자격증명 폐기가 아니다** — 화면이 그렇게 안내한다.
  app.delete('/secrets/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const s = await load(req, reply, true);
    if (!s) return reply;
    await pool.query(`delete from secret where id = $1`, [s.id]);
    await recordAudit(pool, { action: 'secret.deleted', ...actorOf(req), target: s.id, detail: { name: s.name } }, req);
    return reply.code(204).send();
  });

  app.get('/secrets/:id/grants', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const s = await load(req, reply, true);
    if (!s) return reply;
    const r = await pool.query(
      `select id, agent_id as "agentId", channel_id as "channelId", operator_id as "operatorId",
              granted_by as "grantedBy", granted_at as "grantedAt",
              suspended_at as "suspendedAt", suspend_reason as "suspendReason"
         from secret_grant where secret_id = $1 order by granted_at`, [s.id]);
    return { grants: r.rows };
  });

  // 부여: **소유자만.** 같은 (에이전트, 채널) 에 다시 주면 갱신이고, 정지도 풀린다 — 소유자가
  // 바뀐 배정·지시문을 보고 다시 믿기로 한 것이다.
  app.put('/secrets/:id/grants', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const s = await load(req, reply, true);
    if (!s) return reply;
    if (s.ownerAccountId !== req.account!.id) {
      return reply.code(403).send({ error: { code: 'owner_only', message: 'only the secret owner can grant it' } });
    }
    const parsed = grantBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const g = parsed.data;
    // 만료된 비밀에는 주지 않는다(보안 검토 L2). reveal 도 만료를 따로 보지만, 여기서 받아 주면
    // 소유자는 "줬다"고 읽고 에이전트는 영영 못 받는다.
    const expired = await pool.query(`select 1 from secret where id = $1 and expires_at <= now()`, [s.id]);
    if (expired.rowCount) return reply.code(409).send({ error: { code: 'secret_expired', message: 'the secret has expired; replace its value or extend expiresAt first' } });
    const agent = await pool.query(
      `select a.id, asg.operator_id as "operatorId" from account a
         left join agent_assignment asg on asg.agent_id = a.id
        where a.id = $1 and a.kind = 'agent' and a.deleted_at is null`, [g.agentId]);
    if (!agent.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    if (g.channelId) {
      const ch = await pool.query(`select 1 from channel where id = $1`, [g.channelId]);
      if (!ch.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    const operatorId = (agent.rows[0] as { operatorId: string | null }).operatorId;
    if (g.operator === 'current' && !operatorId) {
      return reply.code(409).send({ error: { code: 'not_assigned', message: 'the agent is not assigned to an operator; assign it first or grant with operator: "any"' } });
    }
    const boundOperator = g.operator === 'current' ? operatorId : null;
    const r = await pool.query(
      `insert into secret_grant (secret_id, agent_id, channel_id, operator_id, granted_by)
       values ($1, $2, $3, $4, $5)
       on conflict (secret_id, agent_id, coalesce(channel_id, '00000000-0000-0000-0000-000000000000'::uuid))
       do update set operator_id = excluded.operator_id, granted_by = excluded.granted_by,
                     granted_at = now(), suspended_at = null, suspend_reason = null
       returning id`,
      [s.id, g.agentId, g.channelId, boundOperator, req.account!.id]);
    const grantId = (r.rows[0] as { id: string }).id;
    await recordAudit(pool, {
      action: 'secret.grant.given', ...actorOf(req), target: s.id,
      detail: { name: s.name, grantId, agentId: g.agentId, channelId: g.channelId, operatorId: boundOperator },
    }, req);
    return { grantId, operatorId: boundOperator };
  });

  // 회수: 소유자 또는 admin.
  app.delete<{ Params: { id: string; grantId: string } }>(
    '/secrets/:id/grants/:grantId', { preHandler: app.requireAccount }, async (req, reply) => {
      if (!human(req, reply)) return reply;
      const s = await load(req, reply, true);
      if (!s) return reply;
      const grantId = z.string().uuid().safeParse(req.params.grantId);
      if (!grantId.success) return reply.code(404).send({ error: { code: 'not_found', message: 'no such grant' } });
      const r = await pool.query(
        `delete from secret_grant where id = $1 and secret_id = $2 returning agent_id as "agentId", channel_id as "channelId"`,
        [grantId.data, s.id]);
      if (!r.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'no such grant' } });
      await recordAudit(pool, {
        action: 'secret.grant.revoked', ...actorOf(req), target: s.id,
        detail: { name: s.name, grantId: grantId.data, ...(r.rows[0] as object) },
      }, req);
      return reply.code(204).send();
    });

  app.get<{ Querystring: { limit?: string } }>('/secrets/:id/access', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const s = await load(req, reply, true);
    if (!s) return reply;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const r = await pool.query(
      `select id::text, version, agent_id as "agentId", operator_id as "operatorId", turn_id as "turnId",
              channel_id as "channelId", thread_root_id as "threadRootId", result, reason, at
         from secret_access_log where secret_id = $1 order by at desc, id desc limit $2`, [s.id, limit]);
    return { access: r.rows };
  });

  // ─── 에이전트 쪽(PR 2) ────────────────────────────────────────────────────────────────
  //
  // **오퍼레이터를 거친 에이전트만.** 임대와 grant 가 오퍼레이터에 묶이므로(M1·H1) 어느 오퍼레이터에서
  // 왔는지 모르는 요청(옛 PAT 경로)은 받지 않는다.
  const viaOperator = (req: FastifyRequest, reply: FastifyReply): { agentId: string; operatorId: string } | null => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      void reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
      return null;
    }
    return { agentId: req.account!.id, operatorId: req.operator.id };
  };

  app.post('/agent/turn-leases', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    const parsed = z.object({ causeMessageId: z.string().uuid() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const issued = await issueTurnLease(pool, { ...who, causeMessageId: parsed.data.causeMessageId });
    if (!issued.ok) {
      // 충돌은 사건이다 — 러너가 아닌 누군가(같은 자격을 쥔 셸)가 먼저 받아 갔거나, 끝난 멘션으로
      // 다시 받으려 했다(H2·S1).
      if (issued.code === 'lease_used') {
        await recordAudit(pool, {
          action: 'secret.lease.conflict', ...actorOf(req), target: who.agentId,
          detail: { causeMessageId: parsed.data.causeMessageId, operatorId: who.operatorId },
        }, req);
      }
      return reply.code(issued.code === 'lease_used' ? 409 : 403).send({
        error: { code: issued.code, message: issued.code === 'lease_used'
          ? 'this mention has already had a lease; a lease is issued once per mention'
          : 'this agent was not recently invoked by that message' },
      });
    }
    void reply.header('cache-control', 'no-store');
    return { lease: { id: issued.leaseId, token: issued.token, channelId: issued.channelId, threadRootId: issued.threadRootId, expiresAt: issued.expiresAt } };
  });

  app.post<{ Params: { id: string } }>('/agent/turn-leases/:id/end', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    const id = z.string().uuid().safeParse(req.params.id);
    const body = z.object({ token: z.string().min(1).max(200) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'leaseId and token are required' } });
    const ended = await endTurnLease(pool, { leaseId: id.data, token: body.data.token, agentId: who.agentId });
    return ended ? reply.code(204).send() : reply.code(404).send({ error: { code: 'not_found', message: 'no such live lease' } });
  });

  /**
   * 값을 주는 유일한 자리. 받는 쪽은 브릿지(PR 3)이고 모델이 아니다 — 브릿지는 이 값을 턴 전용
   * 파일에 쓰고 경로만 모델에게 준다. 응답은 캐시하지 않는다. 거절 사유 코드는 비밀이 아니다
   * (무엇을 고칠지 소유자·에이전트가 알아야 한다).
   */
  app.post('/agent/secrets/reveal', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    if (!keyring) return reply.code(409).send(disabled);
    const parsed = z.object({
      leaseId: z.string().uuid(), token: z.string().min(1).max(200), name: z.string().regex(NAME),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'leaseId, token and a valid name are required' } });
    const r = await revealSecret(pool, keyring, { ...who, ...parsed.data, limiter });
    void reply.header('cache-control', 'no-store');
    if (!r.ok) {
      const status = r.code === 'not_found' ? 404 : r.code === 'rate_limited' ? 429 : r.code === 'unreadable' ? 500 : 403;
      return reply.code(status).send({ error: { code: r.code, message: `secret not revealed: ${r.code}` } });
    }
    return {
      secret: { id: r.secretId, name: r.name, kind: r.kind, filename: r.filename, version: r.version },
      valueBase64: r.value.toString('base64'),
    };
  });
}

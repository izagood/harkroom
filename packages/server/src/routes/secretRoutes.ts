// 비밀 보관소(085) — 사람용 REST. 저장·값 바꾸기·지우기·부여·회수·감사 조회.
//
// 규칙(보안 검토 반영, 스레드 bc98df3a):
// - **에이전트는 이 표면을 하나도 못 쓴다.** 에이전트가 비밀을 만들거나 부여할 수 있으면 "권한을
//   받은 에이전트만"이 에이전트 자신의 판단이 된다. 받는 길(reveal)은 다음 PR 에 따로 있다.
// - **부여는 소유자만**(D4·M2). admin 이 부여할 수 있으면 admin 은 자기가 움직이는 에이전트에게
//   주고 받아 가서 모든 값을 읽는다. admin 은 회수·삭제만 한다.
// - 예외 하나: 에이전트가 **자기 소유자의 이름으로** 비밀을 만드는 길(`/agent/secrets`, 102) — 판정은 `secretCreate.ts`.
// - **값은 소유자 본인에게만 다시 나간다**(`POST /secrets/:id/reveal`, 114). 비밀번호를 다시 확인한 세션만,
//   admin·에이전트·PAT·오퍼레이터는 못 받는다 — 운영자가 값을 꺼내는 길은 없다. 그 밖의 응답·감사·오류
//   어디에도 값이나 그 해시를 싣지 않는다. 한 번 풀면(15분 연장·최대 1시간) 여러 값을 본다.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { actorOf, recordAudit } from '../audit.js';
import { scanWrite } from '../services/contentScan.js';
import type { SecretKeyring } from '../services/secretKeyring.js';
import { needlesFor } from '../services/secretLeakGuard.js';
import { endTurnLease, issueTurnLease, revealSecret, RevealLimiter } from '../services/secretAccess.js';
import { currentStepUp, extendStepUp } from '../services/stepUp.js';
import { createAgentSecret, createLimiter, GENERATE_TYPES, hasCreateGrant, rotateAgentSecret, type CreateDenial, type CreateSource } from '../services/secretCreate.js';

/** 계획 D6. 파일·텍스트 공통 상한(바이트). */
export const SECRET_MAX_BYTES = 64 * 1024;

const agentRefused = { error: { code: 'forbidden', message: 'agents cannot manage secrets' } };
const storeOff = {
  error: { code: 'secret_store_disabled', message: 'HARKROOM_SECRET_KEYS_DIR is not set on the server; the secret store is off' },
};
/** 키는 걸렸는데 DB 의 키 확인값과 맞지 않아 꺼졌다. kid 이름은 싣지 않는다(서버 로그에만). */
const keyMismatch = {
  error: { code: 'secret_key_mismatch', message: 'the secret store key on the server does not match the key these secrets were sealed with; the secret store is off' },
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
const revealBody = z.object({
  action: z.enum(['view', 'copy', 'download']),
  // 기기가 스스로 밝힌 이름(앱 판·OS). 기록에만 쓰고 판정에는 안 쓴다 — 검증된 기기 신원이 아니다.
  client: z.string().max(500).optional(),
});
/** 소유자 보기 속도 제한 — 계정마다 10분에 20회. 화면 하나가 보기·복사를 섞어 써도 넉넉하고, 긁어 가기엔 좁다. */
export const ownerRevealLimiter = (): RevealLimiter => new RevealLimiter(20, 10 * 60_000);
/** 기록할 client 문자열 — 제어문자를 지우고 120자로 자른다(감사 화면에 그대로 찍힌다). */
const clientLabel = (raw: string | undefined): string | null => {
  const s = (raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120);
  return s || null;
};
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
  /** 에이전트가 만든 비밀이면 그 에이전트와 원인 글(102). 사람이 만들었으면 null. */
  createdByAgentId: string | null; createdCauseMessageId: string | null;
  /**
   * 지금 값을 정한 것이 에이전트면 그 id(security L2 — 그 에이전트는 값을 안다: import·mount). 사람이 값을 바꾸면 null 이 된다.
   * 화면은 이것으로 "값을 @x 가 정함" 배지를 달고, 다른 에이전트에게 넓혀 줄 때 경고한다.
   */
  valueSetByAgentId: string | null;
}

const SECRET_COLS = `s.id, s.name, s.kind, s.filename, s.description, s.owner_account_id as "ownerAccountId",
  s.expires_at as "expiresAt", s.created_at as "createdAt", s.updated_at as "updatedAt",
  v.version, v.size_bytes as "sizeBytes",
  (select count(*)::int from secret_grant g where g.secret_id = s.id) as "grantCount",
  s.created_by_agent_id as "createdByAgentId", s.created_cause_message_id as "createdCauseMessageId",
  (select a.id from account a where a.id = v.created_by and a.kind = 'agent') as "valueSetByAgentId"`;
const SECRET_FROM = `secret s left join lateral (
    select version, size_bytes, created_by, split_part(sealed, '.', 2) as sealed_kid from secret_version
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
  app: FastifyInstance, pool: Pool,
  opts: {
    keyring: SecretKeyring | null; keyMismatch?: boolean; limiter?: RevealLimiter; createLimiter?: RevealLimiter;
    ownerRevealLimiter?: RevealLimiter;
  },
): Promise<void> {
  const { keyring } = opts;
  const disabled = opts.keyMismatch ? keyMismatch : storeOff;
  const limiter = opts.limiter ?? new RevealLimiter();
  const makeLimiter = opts.createLimiter ?? createLimiter();
  const ownerLimiter = opts.ownerRevealLimiter ?? ownerRevealLimiter();

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
      `select ${SECRET_COLS}, v.sealed_kid as "sealedKid" from ${SECRET_FROM}
        where $1::boolean or s.owner_account_id = $2 order by s.name`, [me.isAdmin, me.id]);
    // keyLost: 지금 값의 키(kid)가 이 서버의 키링에 없다 — 키를 잃었거나 바꿨으니 다시 넣어야 한다.
    // kid 이름은 내보내지 않는다. 보관소가 꺼져 있으면(키 없음·키 어긋남) 가를 수 없으니 false 다.
    const kids = new Set(keyring?.kids ?? []);
    const secrets = (r.rows as (SecretRow & { sealedKid: string | null })[]).map(({ sealedKid, ...row }) => ({
      ...row,
      keyLost: keyring !== null && !!sealedKid && !kids.has(sealedKid),
    }));
    return { enabled: keyring !== null, keyMismatch: opts.keyMismatch === true, secrets };
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
      `select a.id, asg.operator_id as "operatorId", c.owner_account_id as "ownerAccountId" from account a
         left join agent_assignment asg on asg.agent_id = a.id
         left join agent_config c on c.account_id = a.id
        where a.id = $1 and a.kind = 'agent' and a.deleted_at is null`, [g.agentId]);
    if (!agent.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    // 비밀은 **소유자 자신의 에이전트**에게만 준다(#1135 security M1, jaebin「추천대로」 — 위임 E1 과 같은 기준). 남의 에이전트에게 주면
    // 값이 그 사람이 고른 오퍼레이터 머신에 파일로 내려간다. 이미 준 줄은 reveal 이 같은 기준으로 막는다(`secretAccess.ts`).
    if ((agent.rows[0] as { ownerAccountId: string | null }).ownerAccountId !== req.account!.id) {
      return reply.code(403).send({ error: { code: 'not_own_agent', message: 'secrets can only be given to your own agents' } });
    }
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
              channel_id as "channelId", thread_root_id as "threadRootId", result, reason, at,
              actor_account_id as "actorAccountId", action, client, ip
         from secret_access_log where secret_id = $1 order by at desc, id desc limit $2`, [s.id, limit]);
    return { access: r.rows };
  });

  /**
   * 소유자 보기(114, 스레드 464aff1c). 판정은 전부 서버가 가진 사실로 한다:
   * 사람 · **세션**(PAT·오퍼레이터 403) · **소유자 본인**(admin 도 남의 것은 404) · 보관소 잠금이 풀린 창 안
   * (`stepUp.ts`) · 계정당 속도 제한. 통과하면 지금 판을 열어 본문으로만 돌려주고(`no-store`), 창을 15분 민다
   * (처음 푼 때 + 1시간까지). 응답의 `steppedUpUntil` 이 밀린 뒤의 끝 시각이다.
   *
   * 보기·복사·내려받기를 **각각 서버에서** 받는다 — 화면이 이미 받은 값을 복사하면 "복사함"은 클라이언트의
   * 자기 신고가 된다. 그래서 복사도 `action: 'copy'` 로 다시 받고, 그 한 번이 access log 한 줄이다.
   * 만료된 비밀도 소유자는 본다 — 만료는 에이전트에게 주지 않는다는 뜻이지 값이 사라졌다는 뜻이 아니다.
   */
  app.post('/secrets/:id/reveal', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    if (req.authVia !== 'session') {
      return reply.code(403).send({ error: { code: 'session_required', message: 'only a signed-in session can view a secret value' } });
    }
    if (!keyring) return reply.code(409).send(disabled);
    const s = await load(req, reply, false);
    if (!s) return reply;
    const parsed = revealBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'action must be view, copy or download' } });
    const me = req.account!;
    const { action } = parsed.data;
    const client = clientLabel(parsed.data.client);
    const log = (result: 'granted' | 'denied', reason: string | null, version: number | null) => pool.query(
      `insert into secret_access_log (secret_id, secret_name, version, actor_account_id, action, client, ip, result, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [s.id, s.name, version, me.id, action, client, req.ip ?? null, result, reason]);
    const deny = async (status: number, code: string, message: string) => {
      await log('denied', code, null);
      return reply.code(status).send({ error: { code, message } });
    };

    if (!(await currentStepUp(pool, req.credentialHash))) {
      return deny(403, 'step_up_required', 'unlock with your password to view secret values');
    }
    const nowMs = Date.now();
    if (!ownerLimiter.take(me.id, nowMs)) {
      void reply.header('retry-after', String(Math.max(1, Math.ceil(ownerLimiter.retryAfterMs(me.id, nowMs) / 1000))));
      return deny(429, 'rate_limited', 'too many secret views, try again later');
    }
    const v = (await pool.query(
      `select version, sealed from secret_version
        where secret_id = $1 and revoked_at is null and sealed is not null order by version desc limit 1`,
      [s.id])).rows[0] as { version: number; sealed: string } | undefined;
    if (!v) return deny(409, 'no_value', 'this secret has no value');
    const value = keyring.open(v.sealed, { secretId: s.id, version: v.version, kind: s.kind });
    // 열리지 않는다 = 이 서버 키링에 그 판의 키가 없다(keyLost). 값을 다시 넣어야 한다.
    if (!value) return deny(409, 'unreadable', 'this value cannot be opened with the key on this server');

    // 그 사이 [잠그기]가 먼저 닿았으면 연장이 실패한다 — 잠근 뒤에 값이 나가지 않게 여기서도 막는다.
    const until = await extendStepUp(pool, req.credentialHash!);
    if (!until) return deny(403, 'step_up_required', 'unlock with your password to view secret values');
    await log('granted', null, v.version);
    await recordAudit(pool, {
      action: 'secret.revealed', ...actorOf(req), target: s.id, detail: { name: s.name, version: v.version, action },
    }, req);
    void reply.header('cache-control', 'no-store');
    return {
      steppedUpUntil: until.toISOString(),
      name: s.name, kind: s.kind, filename: s.filename, version: v.version,
      ...(s.kind === 'text' ? { value: value.toString('utf8') } : { valueBase64: value.toString('base64') }),
    };
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

  // ─── 에이전트가 만든다(102) ─────────────────────────────────────────────────────────────
  //
  // 판정은 전부 `secretCreate.ts`(서버)다 — 오퍼레이터의 경로 검사는 실수 방지일 뿐이다(security F1). 오류 문장은
  // 고정이고 zod 의 문장을 싣지 않는다 — 값 칸(`valueBase64`)이 오류에 되비치지 않게(L4).
  const generateSpec = z.object({ type: z.enum(GENERATE_TYPES), length: z.number().int().optional() }).strict();
  const sourceBody = z.union([
    z.object({ generate: generateSpec }).strict(),
    z.object({ import: z.object({
      kind: z.enum(['text', 'file']), filename: z.string().regex(FILENAME).nullable().optional(),
      valueBase64: z.string().max(Math.ceil(SECRET_MAX_BYTES / 3) * 4 + 4),
    }).strict() }).strict(),
  ]);
  const leaseFields = { leaseId: z.string().uuid(), token: z.string().min(1).max(200) };
  const agentCreateBody = z.object({
    ...leaseFields, name: z.string().regex(NAME), description: z.string().max(500).default(''),
    expiresInDays: z.number().int().min(1).max(365).optional(), source: sourceBody,
  }).strict();
  const agentRotateBody = z.object({ ...leaseFields, name: z.string().regex(NAME), source: sourceBody }).strict();
  const badCreate = { error: { code: 'bad_request', message: 'leaseId, token, a valid name and one source ({generate:{type,length?}} or {import:{kind,filename?,valueBase64}}) are required' } };

  const toSource = (src: z.infer<typeof sourceBody>): CreateSource | null => {
    if ('generate' in src) return { generate: src.generate };
    const b64 = src.import.valueBase64;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
    if (src.import.kind === 'file' && !src.import.filename) return null;
    if (src.import.kind === 'text' && src.import.filename) return null;
    return { import: { kind: src.import.kind, filename: src.import.filename ?? null, value: Buffer.from(b64, 'base64') } };
  };
  const createStatus = (code: CreateDenial): number => {
    switch (code) {
      case 'lease_invalid': case 'not_granted': case 'cause_not_owner': case 'owner_inactive': case 'grant_suspended': return 403;
      case 'rate_limited': return 429;
      case 'not_found': return 404;
      case 'bad_value': case 'bad_length': case 'secret_in_description': case 'kind_mismatch': return 400;
      default: return 409; // too_many · name_taken · value_is_mounted · adopted_by_owner · secret_expired
    }
  };

  // 러너가 프롬프트에 만들기 절을 쓸지 고른다(`/agent/merge-grants` 와 같은 틀). 판정이 아니다 — 판정은 위 gate() 가 매 호출 한다.
  app.get('/agent/secret-create', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    void reply.header('cache-control', 'no-store');
    return { granted: !!keyring && (await hasCreateGrant(pool, who.agentId)) };
  });

  app.post('/agent/secrets', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    if (!keyring) return reply.code(409).send(disabled);
    const parsed = agentCreateBody.safeParse(req.body ?? {});
    const source = parsed.success ? toSource(parsed.data.source) : null;
    if (!parsed.success || !source) return reply.code(400).send(badCreate);
    const b = parsed.data;
    const r = await createAgentSecret(pool, {
      ...who, leaseId: b.leaseId, token: b.token, keyring, limiter: makeLimiter,
      name: b.name, description: b.description, expiresInDays: b.expiresInDays, source,
    });
    void reply.header('cache-control', 'no-store');
    if (!r.ok) return reply.code(createStatus(r.code)).send({ error: { code: r.code, message: `secret not created: ${r.code}` } });
    return reply.code(201).send({ secret: { name: r.name, kind: r.kind, version: r.version, expiresAt: r.expiresAt }, publicKey: r.publicKey });
  });

  app.post('/agent/secrets/rotate', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    if (!keyring) return reply.code(409).send(disabled);
    const parsed = agentRotateBody.safeParse(req.body ?? {});
    const source = parsed.success ? toSource(parsed.data.source) : null;
    if (!parsed.success || !source) return reply.code(400).send(badCreate);
    const b = parsed.data;
    const r = await rotateAgentSecret(pool, { ...who, leaseId: b.leaseId, token: b.token, keyring, limiter: makeLimiter, name: b.name, source });
    void reply.header('cache-control', 'no-store');
    if (!r.ok) return reply.code(createStatus(r.code)).send({ error: { code: r.code, message: `secret not rotated: ${r.code}` } });
    return { secret: { name: r.name, kind: r.kind, version: r.version }, publicKey: r.publicKey };
  });

}

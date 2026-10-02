// API 연결(098) — 사람용 REST. 외부 API 권한 C안 P2, 설계 스레드 07519d86(채널 a42006a1), designer v3 ②.
//
// 규칙:
// - **에이전트는 이 표면을 하나도 못 쓴다.** 에이전트가 연결을 만들거나 고칠 수 있으면 키가 어디로 붙어 나갈지를
//   에이전트가 정하게 된다(비밀 보관소의 "에이전트는 비밀을 관리하지 않는다"와 같은 이유).
// - 연결은 **주인만** 만들고 고친다. 키는 주인의 비밀만 가리킬 수 있다. admin 은 보고 지우기만 한다.
// - **주소·인증·키를 바꾸면 그 연결의 grant 를 멈춘다.** 주소가 바뀌면 키가 다른 곳으로 가기 때문이다. 사람이
//   에이전트 화면에서 다시 주면 풀린다. 키의 **값**만 바꾸는 것(`PUT /secrets/:id/value`)은 연결을 바꾸지 않으므로
//   grant 를 그대로 둔다 — 같은 곳으로 가는 같은 키의 새 판이다(security 판정 대상, 스레드 07519d86).
// - 허용 메서드를 줄이면 줄어든 메서드를 쓰던 grant 만 멈춘다.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { API_METHODS, connectorScope, type ApiConnectorView } from '@harkroom/shared';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { normalizeBaseUrl } from '../auth/apiGrants.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
// 인증 헤더로 쓰면 안 되는 이름 — 요청의 대상·길이를 바꾸는 것들이다.
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'cookie']);

const methodsSchema = z.array(z.enum(API_METHODS)).min(1).max(API_METHODS.length);
const createBody = z.object({
  name: z.string().regex(NAME),
  baseUrl: z.string().max(300),
  authKind: z.enum(['bearer', 'header', 'none']),
  authHeader: z.string().regex(HEADER).nullable().optional(),
  secretId: z.string().uuid().nullable().optional(),
  methods: methodsSchema,
});
const patchBody = z.object({
  baseUrl: z.string().max(300).optional(),
  authKind: z.enum(['bearer', 'header', 'none']).optional(),
  authHeader: z.string().regex(HEADER).nullable().optional(),
  secretId: z.string().uuid().nullable().optional(),
  methods: methodsSchema.optional(),
});
const idParam = z.object({ id: z.string().uuid() });

const COLS = `c.id, c.name, c.owner_account_id as "ownerAccountId", c.base_url as "baseUrl", c.auth_kind as "authKind",
  c.auth_header as "authHeader", c.secret_id as "secretId", c.methods, c.created_at as "createdAt", c.updated_at as "updatedAt",
  (select count(*)::int from account_grant g where g.capability = 'api.call' and g.scope = 'connector:' || c.id::text) as "grantCount"`;

async function getConnector(pool: Pool | PoolClient, id: string): Promise<ApiConnectorView | null> {
  return ((await pool.query(`select ${COLS} from api_connector c where c.id = $1`, [id])).rows[0] as ApiConnectorView | undefined) ?? null;
}

type Bad = { status: 400 | 403 | 404; code: string; message: string };

/** 인증 칸 셋의 짝을 맞춘다. 키는 **요청한 사람의 비밀**이어야 한다. */
async function checkAuth(
  pool: Pool, me: string, a: { authKind: 'bearer' | 'header' | 'none'; authHeader: string | null; secretId: string | null },
): Promise<Bad | null> {
  if (a.authKind === 'header') {
    if (!a.authHeader) return { status: 400, code: 'bad_request', message: 'authKind header 에는 authHeader 가 필요하다' };
    if (RESERVED_HEADERS.has(a.authHeader.toLowerCase())) return { status: 400, code: 'bad_header', message: '그 헤더 이름은 인증에 쓸 수 없다' };
  } else if (a.authHeader) {
    return { status: 400, code: 'bad_request', message: 'authHeader 는 authKind header 에서만 쓴다' };
  }
  if (a.authKind === 'none') {
    if (a.secretId) return { status: 400, code: 'bad_request', message: 'authKind none 에는 키를 붙이지 않는다' };
    return null;
  }
  if (!a.secretId) return { status: 400, code: 'bad_request', message: '인증에 쓸 비밀(secretId)이 필요하다' };
  const s = await pool.query(`select owner_account_id as "ownerAccountId", kind from secret where id = $1`, [a.secretId]);
  // 남의 비밀은 있어도 404 다 — 비밀 보관소와 같은 규칙(이름·id 는 권한의 지도).
  if (!s.rowCount || (s.rows[0] as { ownerAccountId: string }).ownerAccountId !== me) return { status: 404, code: 'no_secret', message: '그런 비밀이 없다' };
  if ((s.rows[0] as { kind: string }).kind !== 'text') return { status: 400, code: 'bad_secret', message: '헤더에 붙일 비밀은 텍스트 종류여야 한다' };
  return null;
}

export async function registerConnectorRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const human = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.account!.kind === 'agent') {
      void reply.code(403).send({ error: { code: 'forbidden', message: 'agents cannot manage API connectors' } });
      return false;
    }
    return true;
  };
  /** 주인(또는 allowAdmin 이면 admin)이 보는 연결. 남의 것은 있어도 404. */
  const load = async (req: FastifyRequest, reply: FastifyReply, allowAdmin: boolean): Promise<ApiConnectorView | null> => {
    const { id } = idParam.parse(req.params);
    const c = await getConnector(pool, id);
    const me = req.account!;
    if (!c || (c.ownerAccountId !== me.id && !(allowAdmin && me.isAdmin))) {
      await reply.code(404).send({ error: { code: 'not_found', message: 'no such connector' } });
      return null;
    }
    return c;
  };

  app.get('/connectors', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const me = req.account!;
    const r = await pool.query(`select ${COLS} from api_connector c where $1::boolean or c.owner_account_id = $2 order by c.name`, [me.isAdmin, me.id]);
    return { connectors: r.rows as ApiConnectorView[] };
  });

  app.post('/connectors', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    const b = parsed.data;
    const baseUrl = normalizeBaseUrl(b.baseUrl);
    if (!baseUrl) return reply.code(400).send({ error: { code: 'bad_base_url', message: 'baseUrl 은 경로·질의 없는 https 주소다' } });
    const auth = { authKind: b.authKind, authHeader: b.authHeader ?? null, secretId: b.secretId ?? null };
    const bad = await checkAuth(pool, req.account!.id, auth);
    if (bad) return reply.code(bad.status).send({ error: { code: bad.code, message: bad.message } });
    let id: string;
    try {
      id = ((await pool.query(
        `insert into api_connector (name, owner_account_id, base_url, auth_kind, auth_header, secret_id, methods)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [b.name, req.account!.id, baseUrl, auth.authKind, auth.authHeader, auth.secretId, [...new Set(b.methods)]])).rows[0] as { id: string }).id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: { code: 'name_taken', message: 'a connector with that name already exists' } });
      throw e;
    }
    await recordAudit(pool, { action: 'connector.created', ...actorOf(req), target: id, detail: { name: b.name, baseUrl, authKind: auth.authKind, secretId: auth.secretId, methods: b.methods } }, req);
    return reply.code(201).send({ connector: await getConnector(pool, id) });
  });

  app.patch('/connectors/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const cur = await load(req, reply, false);
    if (!cur) return reply;
    const parsed = patchBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const p = parsed.data;
    const baseUrl = p.baseUrl !== undefined ? normalizeBaseUrl(p.baseUrl) : cur.baseUrl;
    if (!baseUrl) return reply.code(400).send({ error: { code: 'bad_base_url', message: 'baseUrl 은 경로·질의 없는 https 주소다' } });
    const next = {
      authKind: p.authKind ?? cur.authKind,
      authHeader: p.authHeader !== undefined ? p.authHeader : (p.authKind && p.authKind !== 'header' ? null : cur.authHeader),
      secretId: p.secretId !== undefined ? p.secretId : (p.authKind === 'none' ? null : cur.secretId),
    };
    const bad = await checkAuth(pool, req.account!.id, next);
    if (bad) return reply.code(bad.status).send({ error: { code: bad.code, message: bad.message } });
    const methods = p.methods ? [...new Set(p.methods)] : cur.methods;

    const target = baseUrl !== cur.baseUrl || next.authKind !== cur.authKind || next.authHeader !== cur.authHeader || next.secretId !== cur.secretId;
    const dropped = cur.methods.filter((m) => !methods.includes(m));
    const scope = connectorScope(cur.id);
    const client = await pool.connect();
    let suspended: string[] = [];
    try {
      await client.query('begin');
      await client.query(
        `update api_connector set base_url = $2, auth_kind = $3, auth_header = $4, secret_id = $5, methods = $6, updated_at = now() where id = $1`,
        [cur.id, baseUrl, next.authKind, next.authHeader, next.secretId, methods]);
      if (target) {
        suspended = (await client.query(
          `update account_grant set suspended_at = now(), suspend_reason = 'connector_changed'
            where capability = 'api.call' and scope = $1 and suspended_at is null returning account_id`, [scope])).rows.map((r) => (r as { account_id: string }).account_id);
      } else if (dropped.length) {
        suspended = (await client.query(
          `update account_grant set suspended_at = now(), suspend_reason = 'methods_narrowed'
            where capability = 'api.call' and scope = $1 and suspended_at is null
              and exists (select 1 from jsonb_array_elements_text(limits->'methods') m where m = any($2::text[]))
            returning account_id`, [scope, dropped])).rows.map((r) => (r as { account_id: string }).account_id);
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await recordAudit(pool, {
      action: 'connector.updated', ...actorOf(req), target: cur.id,
      detail: { name: cur.name, fields: Object.keys(p), suspendedGrants: suspended.length, reason: target ? 'connector_changed' : dropped.length ? 'methods_narrowed' : null },
    }, req);
    for (const accountId of new Set(suspended)) emitEvent({ type: 'grant.changed', accountId, audience: 'all' });
    return { connector: await getConnector(pool, cur.id), suspendedGrants: suspended.length };
  });

  // 지우기: 주인 또는 admin. 그 연결의 grant 도 같은 트랜잭션에서 지운다(scope 문자열이라 FK 가 없다).
  app.delete('/connectors/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    if (!human(req, reply)) return reply;
    const cur = await load(req, reply, true);
    if (!cur) return reply;
    const client = await pool.connect();
    let removed: string[] = [];
    try {
      await client.query('begin');
      removed = (await client.query(
        `delete from account_grant where capability = 'api.call' and scope = $1 returning account_id`, [connectorScope(cur.id)])).rows.map((r) => (r as { account_id: string }).account_id);
      await client.query(`delete from api_connector where id = $1`, [cur.id]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await recordAudit(pool, { action: 'connector.deleted', ...actorOf(req), target: cur.id, detail: { name: cur.name, removedGrants: removed.length } }, req);
    for (const accountId of new Set(removed)) emitEvent({ type: 'grant.changed', accountId, audience: 'all' });
    return reply.code(204).send();
  });
}


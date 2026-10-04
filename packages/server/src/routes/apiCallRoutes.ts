// 외부 API 호출 — 오퍼레이터의 `api` 래퍼가 묻고 보고하는 자리(C안 P3, 설계 스레드 07519d86). 머지 래퍼(`mergeRoutes.ts`)와
// 같은 틀이다: 세 라우트 전부 **오퍼레이터를 거친 에이전트만** 받는다. 판정은 `services/apiCalls.ts` 하나다.
//
// `api-checks` 의 응답만 키를 싣는다. 받는 쪽은 오퍼레이터 프로세스이고(`turnApi.ts`), 그것이 헤더에 붙인 뒤 버린다 —
// 하네스·래퍼 프로세스·MCP 결과에는 실리지 않는다. 응답은 캐시하지 않는다.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { API_METHODS } from '@harkroom/shared';
import type { SecretKeyring } from '../services/secretKeyring.js';
import { callableConnectors, checkApiCall, delegatableConnectors, reportApiCall } from '../services/apiCalls.js';

const base = {
  leaseId: z.string().uuid(), token: z.string().min(1).max(200),
  connector: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  method: z.enum(API_METHODS),
  path: z.string().min(1).max(2000),
};

export async function registerApiCallRoutes(app: FastifyInstance, pool: Pool, opts: { keyring: SecretKeyring | null }): Promise<void> {
  const viaOperator = (req: FastifyRequest, reply: FastifyReply): { agentId: string; operatorId: string } | null => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      void reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
      return null;
    }
    return { agentId: req.account!.id, operatorId: req.operator.id };
  };

  /** 러너가 턴을 띄울 때 읽는다 — allow 규칙을 줄지와 프롬프트에 적을 연결 이름. 자기 것만. */
  app.get('/agent/api-grants', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    void reply.header('cache-control', 'no-store');
    return { connectors: await callableConnectors(pool, who.agentId), delegatable: await delegatableConnectors(pool, who.agentId) };
  });

  app.post('/agent/api-checks', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    const parsed = z.object(base).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'leaseId, token, connector, method and path are required' } });
    const r = await checkApiCall(pool, opts.keyring, { ...who, ...parsed.data });
    void reply.header('cache-control', 'no-store');
    if (!r.ok) return reply.code(r.code === 'bad_path' ? 400 : r.code === 'no_connector' ? 404 : 403).send({ error: { code: r.code, message: `api call not allowed: ${r.code}` } });
    return {
      allowed: true, connector: r.connectorName, baseUrl: r.baseUrl, authKind: r.authKind, authHeader: r.authHeader,
      valueBase64: r.value ? r.value.toString('base64') : null, causeByHuman: r.causeByHuman,
    };
  });

  app.post('/agent/api-results', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    const parsed = z.object({
      ...base,
      status: z.number().int().min(0).max(999),
      durationMs: z.number().int().min(0).max(3_600_000),
      bytes: z.number().int().min(0),
      error: z.string().max(1000).nullable().optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'leaseId, token, connector, method, path, status, durationMs and bytes are required' } });
    const r = await reportApiCall(pool, { ...who, ...parsed.data });
    if (!r.ok) return reply.code(r.code === 'lease_invalid' ? 403 : r.code === 'no_connector' ? 404 : 409).send({ error: { code: r.code, message: `api result not recorded: ${r.code}` } });
    return reply.code(201).send({ messageId: r.messageId });
  });
}

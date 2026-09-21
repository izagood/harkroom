// MCP 레지스트리(스펙 2026-09-20 §6) — 셋이다:
//
//   GET    /mcp-servers        누구나(로그인) — 에이전트 설정 화면이 고를 이름 목록
//   PUT    /mcp-servers/:name  agent.privileged — 이름과 자격증명 종류를 등록·갱신
//   DELETE /mcp-servers/:name  agent.privileged — 지우면 그 이름을 단 에이전트에서도 빠진다(cascade)
//
// **이름만 서버에 둔다.** 정의(명령·인자·env)와 토큰은 서버를 지나지 않는다 — 오퍼레이터가 자기
// 머신에서 그 이름의 정의를 꺼내 mcp.json 에 합친다. 서버가 아는 것은 그 이름이 개인 자격증명을
// 쓰는지(personal)뿐이고, 그것이 에이전트의 credential_scope 불변식에 걸린다.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { McpServerRow } from '@harkroom/shared';
import { actorOf, recordAudit } from '../audit.js';

const COLS = `name, credential_kind as "credentialKind", created_by as "createdBy", created_at as "createdAt"`;
const nameParam = z.object({ name: z.string().regex(/^[a-z0-9-]{1,32}$/) });
const body = z.object({ credentialKind: z.enum(['community', 'personal']) });

export async function registerMcpServerRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/mcp-servers', { preHandler: app.requireAccount }, async () => {
    const res = await pool.query<McpServerRow>(`select ${COLS} from mcp_server order by name`);
    return { servers: res.rows };
  });

  app.put<{ Params: { name: string } }>('/mcp-servers/:name', { preHandler: app.requireCap('agent.privileged') }, async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const res = await pool.query<McpServerRow>(
      `insert into mcp_server (name, credential_kind, created_by) values ($1, $2, $3)
       on conflict (name) do update set credential_kind = excluded.credential_kind
       returning ${COLS}`,
      [name, parsed.data.credentialKind, req.account!.id]);
    await recordAudit(pool, { action: 'mcp_server.set', ...actorOf(req), target: name, detail: { credentialKind: parsed.data.credentialKind } }, req);
    return res.rows[0];
  });

  app.delete<{ Params: { name: string } }>('/mcp-servers/:name', { preHandler: app.requireCap('agent.privileged') }, async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const res = await pool.query(`delete from mcp_server where name = $1`, [name]);
    if (!res.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 MCP 이름이 없다' } });
    await recordAudit(pool, { action: 'mcp_server.deleted', ...actorOf(req), target: name, detail: {} }, req);
    return reply.code(204).send();
  });
}

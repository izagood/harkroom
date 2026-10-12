import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TURN_ID_HEADER } from '@harkroom/shared/runnerLink';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, registerOperator } from './helpers/fixtures.js';

// 발화에 그 글을 쓴 턴의 id 를 남긴다(2026-10-12, 스레드 6eca9cee). 러너가 「이 턴이 무엇을 썼나」를 계정이 아니라 턴으로
// 센다 — 계정으로만 세면 같은 계정으로 동시에 도는 다른 턴의 글이 침묵 통지에 링크로 실렸다(#task 32ce2cdf).
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const TURN = '7e57c0de-0000-4000-8000-000000000001';

describe('message.meta.turnId (TURN_ID_HEADER)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let agent: string; let agentPat: string;
  let op: { token: string; operatorId: string };
  let ch: string;
  let url = '';

  const asAgent = () => ({ ...auth(op.token), 'x-harkroom-agent': agent });
  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  };
  const call = async (headers: Record<string, string>, name: string, args: Record<string, unknown>) => {
    const client = await connect(headers);
    try {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse((r.content as { text: string }[])[0]!.text) as { message: { id: string; meta: Record<string, unknown> } };
    } finally { await client.close(); }
  };
  const metaOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta as Record<string, unknown>;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    ({ accountId: agent, pat: agentPat } = await createAgent(app, admin.token, 'tm'));
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agent, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'turns' } })).json().id as string;
    await app.inject({ method: 'POST', url: `/channels/${ch}/members`, headers: auth(admin.token), payload: { accountId: agent } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('오퍼레이터를 거친 발화는 헤더의 턴 id 를 meta.turnId 로 남기고, 목록에도 그대로 실린다', async () => {
    const out = await call({ ...asAgent(), [TURN_ID_HEADER]: TURN }, 'message.post', { channelId: ch, body: 'ok' });
    expect(await metaOf(out.message.id)).toMatchObject({ turnId: TURN });
    const list = await app.inject({ method: 'GET', url: `/channels/${ch}/messages`, headers: asAgent() });
    const row = (list.json() as { id: string; meta: Record<string, unknown> }[] | { messages: { id: string; meta: Record<string, unknown> }[] });
    const rows = Array.isArray(row) ? row : row.messages;
    expect(rows.find((m) => m.id === out.message.id)?.meta).toMatchObject({ turnId: TURN });
  });

  it('progress·turn.wake 대기 줄에도 남는다 — 러너가 대기 줄도 턴으로 가른다', async () => {
    const head = await call({ ...asAgent(), [TURN_ID_HEADER]: TURN }, 'message.post', { channelId: ch, body: 'head' });
    const progress = await call({ ...asAgent(), [TURN_ID_HEADER]: TURN }, 'message.progress', { channelId: ch, threadRootId: head.message.id, body: '하는 중' });
    expect(await metaOf(progress.message.id)).toMatchObject({ turnId: TURN });
    const wake = await call({ ...asAgent(), [TURN_ID_HEADER]: TURN }, 'turn.wake', { channelId: ch, threadRootId: head.message.id, notBeforeSec: 60, reason: 'CI' });
    expect(await metaOf(wake.message.id)).toMatchObject({ turnId: TURN });
  });

  it('헤더가 없거나 모양이 틀리면 남기지 않는다', async () => {
    const bare = await call(asAgent(), 'message.post', { channelId: ch, body: 'bare' });
    expect(await metaOf(bare.message.id)).not.toHaveProperty('turnId');
    const bad = await call({ ...asAgent(), [TURN_ID_HEADER]: 'not-a-uuid' }, 'message.post', { channelId: ch, body: 'bad' });
    expect(await metaOf(bad.message.id)).not.toHaveProperty('turnId');
  });

  it('PAT 경로로 온 헤더는 남기지 않는다 — 원인(chainCause)과 같은 규칙', async () => {
    const out = await call({ ...auth(agentPat), [TURN_ID_HEADER]: TURN }, 'message.post', { channelId: ch, body: 'pat' });
    expect(await metaOf(out.message.id)).not.toHaveProperty('turnId');
  });
});

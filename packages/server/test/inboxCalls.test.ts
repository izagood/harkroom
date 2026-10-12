// inbox 호출 줄이기 A1(2026-10-12, 쿼리 검토 스레드의 설계안 A) — 서버 쪽 두 가지.
// ① `GET /inbox?since=<id>`: 그 id 뒤에 생긴 항목만. 모바일이 이벤트마다 inbox 전체를 받던 것을 새 줄만으로.
// ② 러너의 빈 `inbox.poll` 이 종료 요청(`stopRequestedAt`)을 함께 싣는다 — 러너가 빈 폴마다 `/agent/config` 를
//    한 번 더 부르던 왕복을 없앤다. 수령 기록(stop_acked_at)도 `/agent/config` 와 같은 규칙으로 남는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { InboxEntry } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let channelId: string; let mcpUrl: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'calls' } })).json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function mcp(token: string): Promise<Client> {
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth(token) } }));
  return c;
}
const text = (r: Awaited<ReturnType<Client['callTool']>>): any => JSON.parse((r.content as { text: string }[])[0]!.text);

describe('GET /inbox?since=', () => {
  it('그 id 뒤의 항목만 준다 — 읽은 것도 포함, 키가 없으면 전과 같이 전체', async () => {
    const { pat } = await createAgent(app, adminToken, 'sincebot');
    const post = async (body: string) => {
      const r = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(pat), payload: { body } });
      expect(r.statusCode).toBe(201);
    };
    await post('@admin 하나');
    await post('@admin 둘');
    const all = (await app.inject({ method: 'GET', url: '/inbox', headers: auth(adminToken) })).json().entries as InboxEntry[];
    expect(all.length).toBeGreaterThanOrEqual(2);
    const cursor = all[all.length - 1]!.id;
    expect((await app.inject({ method: 'GET', url: `/inbox?since=${cursor}`, headers: auth(adminToken) })).json().entries).toEqual([]);

    await post('@admin 셋');
    const fresh = (await app.inject({ method: 'GET', url: `/inbox?since=${cursor}`, headers: auth(adminToken) })).json().entries as InboxEntry[];
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).toBeGreaterThan(cursor);
    // 읽은 줄도 since 범위 안이면 온다(앱이 읽음 표시를 맞춘다).
    await app.inject({ method: 'POST', url: '/inbox/read', headers: auth(adminToken), payload: { ids: [fresh[0]!.id] } });
    const again = (await app.inject({ method: 'GET', url: `/inbox?since=${cursor}`, headers: auth(adminToken) })).json().entries as InboxEntry[];
    expect(again.map((e) => e.id)).toEqual([fresh[0]!.id]);
    expect(again[0]!.readAt).not.toBeNull();
    // unread 와 함께 쓰면 둘 다 건다.
    expect((await app.inject({ method: 'GET', url: `/inbox?unread=1&since=${cursor}`, headers: auth(adminToken) })).json().entries).toEqual([]);
  });

  it('since 가 숫자가 아니면 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/inbox?since=abc', headers: auth(adminToken) })).statusCode).toBe(400);
  });
});

describe('inbox.poll 의 stopRequestedAt', () => {
  it('빈 폴은 키를 늘 싣고(null), 종료 요청이 있으면 그 시각을 싣고 수령을 남긴다', async () => {
    const { pat, accountId } = await createAgent(app, adminToken, 'stopbot');
    const c = await mcp(pat);
    const idle = text(await c.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    expect(idle.entries).toEqual([]);
    expect(idle).toHaveProperty('stopRequestedAt', null);

    const req = await app.inject({ method: 'POST', url: `/accounts/agents/${accountId}/stop`, headers: auth(adminToken) });
    expect(req.statusCode).toBeLessThan(300);
    const stopped = text(await c.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    expect(typeof stopped.stopRequestedAt).toBe('string');
    const row = await pool.query('select stop_requested_at, stop_acked_at from agent_config where account_id = $1', [accountId]);
    expect(new Date(stopped.stopRequestedAt).getTime()).toBe((row.rows[0].stop_requested_at as Date).getTime());
    expect(row.rows[0].stop_acked_at).not.toBeNull();
  });

  it('항목이 있는 폴에는 싣지 않는다(그 폴은 턴을 띄운다 — 정의는 턴이 읽는다)', async () => {
    const { pat } = await createAgent(app, adminToken, 'busybot');
    await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body: '@busybot 일' } });
    const c = await mcp(pat);
    const batch = text(await c.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } }));
    expect(batch.entries.length).toBeGreaterThan(0);
    expect(batch).not.toHaveProperty('stopRequestedAt');
  });
});

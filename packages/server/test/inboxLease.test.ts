// 러너가 쥔 inbox 항목의 임대(2026-10-12 inbox 호출 설계 B). 러너가 폴마다 쥔 항목을 알리면 서버는 그 항목을
// 결과에서 빼고, 쥐지 않게 되면 풀고, 러너가 사라지면 시각이 지나 다시 낸다(at-least-once).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'lease' } })).json().id;
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
type Batch = { entries: { id: number }[] };
const text = (r: Awaited<ReturnType<Client['callTool']>>): Batch => JSON.parse((r.content as { text: string }[])[0]!.text);
const poll = async (c: Client, args: Record<string, unknown> = {}) =>
  text(await c.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0, ...args } })).entries.map((e) => e.id);
const call = (handle: string, body: string) =>
  app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body: `@${handle} ${body}` } });

describe('inbox.poll 임대', () => {
  it('쥔 항목은 빠지고 새 항목만 오며, 놓으면 다음 폴에 다시 온다', async () => {
    const { pat } = await createAgent(app, adminToken, 'leasebot');
    const c = await mcp(pat);
    await call('leasebot', '하나');
    const [first] = await poll(c, { lease: { runnerId: 'r1', holding: [] } });
    expect(first).toBeDefined();

    // 쥐었다고 알리면 그 항목은 빠진다 — 바쁜 러너가 같은 배치를 다시 받지 않는다.
    expect(await poll(c, { lease: { runnerId: 'r1', holding: [first] } })).toEqual([]);
    await call('leasebot', '둘');
    const second = await poll(c, { lease: { runnerId: 'r1', holding: [first] } });
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first);

    // 더는 쥐지 않는다(턴 실패 → 다시 시도할 것) — 같은 폴에서 풀려 곧바로 온다.
    expect(await poll(c, { lease: { runnerId: 'r1', holding: [second[0]] } })).toEqual([first]);
  });

  it('쥔 동안 빈 폴은 롱폴로 기다린다(곧바로 돌아오지 않는다)', async () => {
    const { pat } = await createAgent(app, adminToken, 'parkbot');
    const c = await mcp(pat);
    await call('parkbot', '일');
    const [id] = await poll(c, { lease: { runnerId: 'r1', holding: [] } });
    const t0 = Date.now();
    expect(await poll(c, { timeoutMs: 400, lease: { runnerId: 'r1', holding: [id] } })).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  it('러너가 사라지면 임대 시각이 지나 다시 나간다 — 다른 러너도 받는다', async () => {
    const { pat, accountId } = await createAgent(app, adminToken, 'diebot');
    const c = await mcp(pat);
    await call('diebot', '일');
    const [id] = await poll(c, { lease: { runnerId: 'old', holding: [] } });
    expect(await poll(c, { lease: { runnerId: 'old', holding: [id] } })).toEqual([]);
    // 다른 러너의 폴은 남의 임대를 풀지 않는다(판올림 때 옛·새 러너가 같이 붙는다).
    expect(await poll(c, { lease: { runnerId: 'new', holding: [] } })).toEqual([]);
    await pool.query(`update inbox set claimed_until = now() - interval '1 second' where account_id = $1`, [accountId]);
    expect(await poll(c, { lease: { runnerId: 'new', holding: [] } })).toEqual([id]);
  });

  // A1(빈 폴의 stopRequestedAt, #1332)과 B(임대)가 한 폴에서 같이 돈다(#1334 를 A1 위로 rebase 한 뒤). 쥔 항목만 남아
  // 결과가 비면 그 폴은 **빈 폴**이다 — 종료 요청 키가 실리고, 요청이 오면 그 시각이 실린다. 쥔 항목은 그대로 빠진다.
  it('쥔 항목만 남은 빈 폴에도 stopRequestedAt 이 실리고, 종료 요청이 오면 그 시각이 실린다', async () => {
    const { pat, accountId } = await createAgent(app, adminToken, 'stopleasebot');
    const c = await mcp(pat);
    await call('stopleasebot', '일');
    const [id] = await poll(c, { lease: { runnerId: 'r1', holding: [] } });
    const raw = async () => JSON.parse(((await c.callTool({
      name: 'inbox.poll', arguments: { timeoutMs: 0, lease: { runnerId: 'r1', holding: [id] } },
    })).content as { text: string }[])[0]!.text) as { entries: unknown[]; stopRequestedAt?: string | null };
    const idle = await raw();
    expect(idle.entries).toEqual([]);
    expect(idle).toHaveProperty('stopRequestedAt', null);

    const stopReq = await app.inject({ method: 'POST', url: `/accounts/agents/${accountId}/stop`, headers: auth(adminToken) });
    expect(stopReq.statusCode).toBeLessThan(300);
    const stopped = await raw();
    expect(stopped.entries).toEqual([]);
    expect(typeof stopped.stopRequestedAt).toBe('string');
    const row = await pool.query('select stop_acked_at, (select claimed_until from inbox where id = $2) as cu from agent_config where account_id = $1', [accountId, id]);
    expect(row.rows[0].stop_acked_at).not.toBeNull();
    expect(row.rows[0].cu).not.toBeNull();
  });

  it('임대를 모르는 폴(옛 러너)은 전처럼 쥔 항목도 받는다', async () => {
    const { pat } = await createAgent(app, adminToken, 'oldbot');
    const c = await mcp(pat);
    await call('oldbot', '일');
    const [id] = await poll(c, { lease: { runnerId: 'r1', holding: [] } });
    expect(await poll(c, { lease: { runnerId: 'r1', holding: [id] } })).toEqual([]);
    expect(await poll(c)).toEqual([id]);
  });

  it('남의 항목 id 를 쥐었다고 보내도 그 항목에 임대가 걸리지 않는다', async () => {
    const a = await createAgent(app, adminToken, 'ownera');
    const b = await createAgent(app, adminToken, 'ownerb');
    await call('ownera', 'A 의 일');
    const ca = await mcp(a.pat); const cb = await mcp(b.pat);
    const [aid] = await poll(ca);
    await poll(cb, { lease: { runnerId: 'r1', holding: [aid] } });
    const row = await pool.query('select claimed_until from inbox where id = $1', [aid]);
    expect(row.rows[0].claimed_until).toBeNull();
    expect(await poll(ca, { lease: { runnerId: 'r1', holding: [] } })).toEqual([aid]);
  });

  it('holding 이 안전한 정수 범위를 넘으면 그 폴은 입력 오류다(bigint 캐스트 500 아님, #1334 security n1)', async () => {
    const a = await createAgent(app, adminToken, 'bigholder');
    const c = await mcp(a.pat);
    const r = await c.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0, lease: { runnerId: 'r1', holding: [1e300] } } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/Input validation error/);
  });
});

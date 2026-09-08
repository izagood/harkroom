/**
 * 러너의 claude lane 신고(Agents 관제 5단계).
 *
 * #694 는 **도는 턴**에 어떤 계정을 쓰는지 보이게 했다. 이쪽은 조용한 러너에 대한 답이다 —
 * 기동 때 무엇을 읽고 떴나. 여기서 지키는 것은 셋을 가르는 것이다: 신고가 없으면
 * **모른다**(`null`), 풀이 비면 `accounts: []`, 그 밖에는 순서 그대로다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let base: string;

let claudeId: string;
let claudePat: string;
let codexId: string;
let codexPat: string;
let quietId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: claudeId, pat: claudePat } = await createAgent(app, adminToken, 'lane-claude'));
  ({ accountId: codexId, pat: codexPat } = await createAgent(app, adminToken, 'lane-codex'));
  ({ accountId: quietId } = await createAgent(app, adminToken, 'lane-quiet'));
  await app.inject({
    method: 'PATCH', url: `/accounts/agents/${codexId}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { harness: 'codex' },
  });
});
afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function poll(token: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await mcpClient(token);
  try {
    const result = await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0, ...args } });
    return result;
  } finally {
    await client.close();
  }
}

type LaneRow = { id: string; claudeLane?: { pool: string | null; accounts: string[] } | null };

async function laneOf(id: string): Promise<LaneRow['claudeLane']> {
  const res = await app.inject({
    method: 'GET', url: '/accounts/agents', headers: { authorization: `Bearer ${adminToken}` },
  });
  return (res.json().agents as LaneRow[]).find((a) => a.id === id)?.claudeLane;
}

describe('claude lane 신고 (5단계)', () => {
  it('폴이 나른 lane 이 그 계정에 기록된다 — 순서 그대로다', async () => {
    await poll(claudePat, { claudeLane: { pool: 'work', accounts: ['lime', 'lychee', 'plum'] } });
    expect(await laneOf(claudeId)).toEqual({ pool: 'work', accounts: ['lime', 'lychee', 'plum'] });
  });

  it('순서가 바뀌면 값도 바뀐다 — 정렬해 두면 이 차이가 사라진다', async () => {
    await poll(claudePat, { claudeLane: { pool: 'work', accounts: ['plum', 'lime', 'lychee'] } });
    expect((await laneOf(claudeId))?.accounts).toEqual(['plum', 'lime', 'lychee']);
  });

  it('풀이 비면 빈 배열로 남는다 — **모른다와 다른 사실이다**', async () => {
    await poll(claudePat, { claudeLane: { pool: null, accounts: [] } });
    expect(await laneOf(claudeId)).toEqual({ pool: null, accounts: [] });
  });

  // 값이 바뀔 때만 쓴다 — inbox.poll 은 25초마다 오는 핫 패스다(runnerVersion 과 같은 근거).
  it('같은 lane 으로 다시 폴하면 seen_at 을 다시 쓰지 않는다', async () => {
    const lane = { pool: 'work', accounts: ['lime'] };
    await poll(claudePat, { claudeLane: lane });
    const first = await pool.query('select seen_at from agent_claude_lane where account_id = $1', [claudeId]);

    await new Promise((r) => setTimeout(r, 50));
    await poll(claudePat, { claudeLane: lane });
    const second = await pool.query('select seen_at from agent_claude_lane where account_id = $1', [claudeId]);

    expect(second.rows[0].seen_at.getTime()).toBe(first.rows[0].seen_at.getTime());
  });

  // 풀 이름만 바뀌는 경우. `is distinct from` 이 아니라 `<>` 로 비교하면 null 이 낀 쪽에서
  // 조건이 unknown 이 되어 **갱신이 조용히 안 된다.**
  it('풀만 바뀌어도(null → 이름) 갱신된다', async () => {
    await poll(claudePat, { claudeLane: { pool: null, accounts: ['lime'] } });
    expect((await laneOf(claudeId))?.pool).toBeNull();
    await poll(claudePat, { claudeLane: { pool: 'work', accounts: ['lime'] } });
    expect((await laneOf(claudeId))?.pool).toBe('work');
  });

  it('claude 하네스가 아니면 기록하지 않는다 — 남의 축의 계정 목록을 그리지 않는다', async () => {
    await poll(codexPat, { claudeLane: { pool: 'work', accounts: ['lime'] } });
    expect(await laneOf(codexId)).toBeNull();
  });

  it('신고가 없는 에이전트는 null 이다 (필드가 빠지지 않는다)', async () => {
    expect(await laneOf(quietId)).toBeNull();
  });

  it('lane 없이 폴해도 정상 동작하고 기존 값을 지우지 않는다', async () => {
    await poll(claudePat, { claudeLane: { pool: 'work', accounts: ['lime', 'plum'] } });
    await poll(claudePat, {});
    expect((await laneOf(claudeId))?.accounts).toEqual(['lime', 'plum']);
  });
});

// 작업 항목(110, 협업 통합 설계 ①) — 주인 본인과 그 주인의 에이전트만 쓰고, avcs 는 state 없이 스레드에 붙는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { MAX_ITEMS_PER_OWNER } from '../src/services/workItems.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let otherToken: string;
let otherId: string;
let botId: string;
let botPat: string;
let orphanPat: string;
let channelId: string;
let mcpUrl: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const OID = 'a'.repeat(64);

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ token: otherToken, accountId: otherId } = await createMember(app, adminToken, 'wiother'));
  ({ accountId: botId, pat: botPat } = await createAgent(app, adminToken, 'wibot'));
  const orphan = await createAgent(app, adminToken, 'wiorphan');
  orphanPat = orphan.pat;
  // 주인을 명시한다 — 만든 사람이 주인이 되는지는 이 시험의 관심이 아니다.
  await pool.query(`update agent_config set owner_account_id = $1 where account_id = $2`, [adminId, botId]);
  await pool.query(`update agent_config set owner_account_id = null where account_id = $1`, [orphan.accountId]);
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'work-items' } });
  channelId = ch.json().id;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => { await app.close(); await stop(); });

async function root(body: string, ch = channelId, threadRootId: string | null = null): Promise<string> {
  const posted = await postMessage(pool, { channelId: ch, authorId: adminId, body, threadRootId, meta: {} });
  return (posted as { message: { id: string } }).message.id;
}
const put = (token: string, payload: object) =>
  app.inject({ method: 'PUT', url: '/work-items', headers: auth(token), payload });
const list = async (token: string, query = '') => {
  const res = await app.inject({ method: 'GET', url: `/work-items${query}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json().items as { id: string; source: string; externalKey: string; state: string | null; threadRootId: string | null; title: string }[];
};

async function mcp(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
async function tool(token: string, name: string, args: object) {
  const client = await mcp(token);
  try {
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  } finally {
    await client.close();
  }
}

describe('REST /work-items', () => {
  it('같은 source·바깥 키면 고쳐 쓴다(멱등) — 주인의 목록에만 실린다', async () => {
    const payload = { source: 'github', externalKey: 'izagood/harkroom#1', title: 'PR 하나', url: 'https://github.com/izagood/harkroom/pull/1', state: 'blocked' };
    const a = await put(adminToken, payload);
    expect(a.statusCode).toBe(200);
    const b = await put(adminToken, { ...payload, title: '고친 제목', state: 'done' });
    expect(b.json().item.id).toBe(a.json().item.id);
    const mine = (await list(adminToken)).filter((i) => i.externalKey === payload.externalKey);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: '고친 제목', state: 'done' });
    expect((await list(otherToken)).some((i) => i.externalKey === payload.externalKey)).toBe(false);
  });

  it('남의 항목은 지울 수 없다 — 404 이고 행은 남는다', async () => {
    const item = (await put(adminToken, { source: 'other', externalKey: 'keep-me', title: 'x', state: 'active' })).json().item;
    const del = await app.inject({ method: 'DELETE', url: `/work-items/${item.id}`, headers: auth(otherToken) });
    expect(del.statusCode).toBe(404);
    expect((await list(adminToken)).some((i) => i.id === item.id)).toBe(true);
    const mineDel = await app.inject({ method: 'DELETE', url: `/work-items/${item.id}`, headers: auth(adminToken) });
    expect(mineDel.statusCode).toBe(204);
  });

  it('url 은 https 만 받는다', async () => {
    const res = await put(adminToken, { source: 'other', externalKey: 'js', title: 'x', state: 'active', url: 'javascript:alert(1)' });
    expect(res.statusCode).toBe(400);
    const http = await put(adminToken, { source: 'other', externalKey: 'http', title: 'x', state: 'active', url: 'http://example.com' });
    expect(http.statusCode).toBe(400);
  });

  it('avcs 는 state 를 받지 않고 스레드가 필수이며 키 모양을 본다', async () => {
    const r = await root('avcs 일');
    expect((await put(adminToken, { source: 'avcs', externalKey: `repo/${OID}`, title: 'x', threadRootId: r, state: 'active' })).json().error.code).toBe('state_not_allowed');
    expect((await put(adminToken, { source: 'avcs', externalKey: `repo/${OID}`, title: 'x' })).json().error.code).toBe('thread_required');
    expect((await put(adminToken, { source: 'avcs', externalKey: 'repo/not-an-oid', title: 'x', threadRootId: r })).json().error.code).toBe('bad_key');
    const ok = await put(adminToken, { source: 'avcs', externalKey: `repo/${OID}`, title: 'intent', threadRootId: r });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().item).toMatchObject({ source: 'avcs', state: null, threadRootId: r });
  });

  it('avcs 가 아니면 state 가 필수다', async () => {
    expect((await put(adminToken, { source: 'jira', externalKey: 'HR-1', title: 'x' })).json().error.code).toBe('state_required');
  });

  it('스레드는 루트여야 하고, 주인이 볼 수 없으면 403 이다', async () => {
    const r = await root('루트');
    const reply = await root('답글', channelId, r);
    expect((await put(adminToken, { source: 'other', externalKey: 'reply', title: 'x', state: 'active', threadRootId: reply })).json().error.code).toBe('not_root');

    const priv = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'wi-private', visibility: 'private' } });
    const hidden = await root('비공개', priv.json().id);
    const res = await put(otherToken, { source: 'other', externalKey: 'peek', title: 'x', state: 'active', threadRootId: hidden });
    expect(res.statusCode).toBe(403);
    const n = await pool.query(`select count(*)::int as n from work_item where owner_account_id = $1 and external_key = 'peek'`, [otherId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('붙인 뒤 주인이 그 스레드를 못 보게 되면 목록에서 빠진다', async () => {
    const priv = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'wi-later-private', visibility: 'private' } });
    const chId = priv.json().id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [chId, otherId]);
    const r = await root('잠깐 보이는 일', chId);
    expect((await put(otherToken, { source: 'other', externalKey: 'gone', title: 'x', state: 'active', threadRootId: r })).statusCode).toBe(200);
    expect((await list(otherToken)).some((i) => i.externalKey === 'gone')).toBe(true);
    await pool.query(`delete from channel_member where channel_id = $1 and account_id = $2`, [chId, otherId]);
    expect((await list(otherToken)).some((i) => i.externalKey === 'gone')).toBe(false);
  });

  it(`한 사람당 ${MAX_ITEMS_PER_OWNER} 개가 상한이다 — 고쳐 쓰기는 상한에 걸리지 않는다`, async () => {
    const fresh = await createMember(app, adminToken, 'wifull');
    await pool.query(
      `insert into work_item (owner_account_id, source, external_key, title, state)
       select $1, 'other', 'k' || g, 't', 'active' from generate_series(1, $2::int) g`,
      [fresh.accountId, MAX_ITEMS_PER_OWNER],
    );
    const over = await put(fresh.token, { source: 'other', externalKey: 'one-more', title: 'x', state: 'active' });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('too_many');
    const rewrite = await put(fresh.token, { source: 'other', externalKey: 'k1', title: 'y', state: 'done' });
    expect(rewrite.statusCode).toBe(200);
  });
});

describe('MCP workitem.*', () => {
  it('에이전트는 주인의 보드에 쓴다 — 주인을 고를 인자가 없다', async () => {
    const r = await root('에이전트가 맡은 일');
    const out = await tool(botPat, 'workitem.upsert', { source: 'avcs', externalKey: `harkroom/${'b'.repeat(64)}`, title: 'intent 하나', threadRootId: r });
    expect(out.item).toMatchObject({ source: 'avcs', state: null, threadRootId: r, updatedBy: botId });
    const row = await pool.query(`select owner_account_id from work_item where id = $1`, [out.item.id]);
    expect(row.rows[0].owner_account_id).toBe(adminId);
    expect((await list(adminToken, `?threadRootId=${r}`)).map((i) => i.id)).toEqual([out.item.id]);

    const listed = await tool(botPat, 'workitem.list', { threadRootId: r });
    expect(listed.items.map((i: { id: string }) => i.id)).toEqual([out.item.id]);
    expect((await tool(botPat, 'workitem.remove', { source: 'avcs', externalKey: `harkroom/${'b'.repeat(64)}` })).removed).toBe(true);
    expect(await list(adminToken, `?threadRootId=${r}`)).toEqual([]);
  });

  it('에이전트가 볼 수 없는 스레드에는 붙이지 못한다(주인은 보더라도)', async () => {
    const priv = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'wi-bot-cannot', visibility: 'private' } });
    const r = await root('에이전트 밖 일', priv.json().id);
    const out = await tool(botPat, 'workitem.upsert', { source: 'other', externalKey: 'blind', title: 'x', state: 'active', threadRootId: r });
    expect(out.error.code).toBe('thread_forbidden');
  });

  it('주인 없는 에이전트는 쓸 보드가 없다', async () => {
    const out = await tool(orphanPat, 'workitem.upsert', { source: 'other', externalKey: 'nobody', title: 'x', state: 'active' });
    expect(out.error.code).toBe('no_owner');
    expect((await tool(orphanPat, 'workitem.list', {})).error.code).toBe('no_owner');
  });
});

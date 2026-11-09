import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { flushDelegationUpdates } from '../src/services/delegations.js';

/** 위임 재설계 v1 P4: 암묵 위임(에이전트→에이전트 맨 앞 멘션). 그림자 모드는 판정만 적고 아무도 더 깨우지 않는다. */
let app: FastifyInstance; let pool: Pool; let stop: () => Promise<void>;
let adminToken: string; let mcpUrl: string; let channelId: string;
let leadPat: string; let leadId: string; let onePat: string; let oneId: string; let thirdPat: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const clients: Client[] = [];
async function call(token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth(token) } }));
  clients.push(c);
  const r = await c.callTool({ name, arguments: args });
  return JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
}
const idOf = (r: Record<string, unknown>) => (r.message as { id: string }).id;
async function openThread(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body: '시작' } });
  return res.json().id as string;
}
const post = async (token: string, rootId: string, body: string) =>
  idOf(await call(token, 'message.post', { channelId, threadRootId: rootId, body }));
const logRows = async (rootId: string) => (await pool.query(
  `select delegator_account_id, delegate_account_id, verdict, mode, plan_step_id, short_question, body_chars, delegation_id
     from delegation_implicit_log where thread_root_id = $1 order by created_at`, [rootId])).rows;
const delegations = async (rootId: string) => (await pool.query(
  `select id, kind, plan_step_id, lead_account_id from team_delegation where thread_root_id = $1 order by created_at`, [rootId])).rows;
const inboxOf = async (accountId: string, messageId: string) => (await pool.query(
  `select reason from inbox where account_id = $1 and message_id = $2`, [accountId, messageId])).rows.map((r) => r.reason);
async function flush(): Promise<string[]> {
  const c = await pool.connect();
  try { return await flushDelegationUpdates(c); } finally { c.release(); }
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  adminToken = admin.token;
  ({ pat: leadPat, accountId: leadId } = await createAgent(app, adminToken, 'ilead'));
  ({ pat: onePat, accountId: oneId } = await createAgent(app, adminToken, 'ione'));
  ({ pat: thirdPat } = await createAgent(app, adminToken, 'ithird'));
  channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'ichan' } })).json().id as string;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await app.close(); await stop();
});
beforeEach(() => { vi.unstubAllEnvs(); });

describe('P4 암묵 위임 — 스위치 꺼짐', () => {
  it('HARKROOM_DELEGATION_V2 가 꺼져 있으면 지금 그대로다 — 기록도 위임 행도 없고 멘션만 간다', async () => {
    vi.stubEnv('HARKROOM_DELEGATION_V2', '');
    vi.stubEnv('HARKROOM_DELEGATION_IMPLICIT', 'on');
    const rootId = await openThread();
    const msg = await post(leadPat, rootId, '@ione 이 버그를 고쳐 달라');
    expect(await logRows(rootId)).toEqual([]);
    expect(await delegations(rootId)).toEqual([]);
    expect(await inboxOf(oneId, msg)).toEqual(['mention']);
  });
});

describe('P4 암묵 위임 — 그림자 모드(기본)', () => {
  beforeEach(() => { vi.stubEnv('HARKROOM_DELEGATION_V2', 'on'); });

  it('맨 앞 멘션은 open 으로 적고 위임 행·깨우기·update 는 만들지 않는다', async () => {
    const rootId = await openThread();
    const msg = await post(leadPat, rootId, '@ione 이 버그를 고쳐 달라');
    expect(await logRows(rootId)).toEqual([expect.objectContaining({
      delegator_account_id: leadId, delegate_account_id: oneId, verdict: 'open', mode: 'shadow',
      plan_step_id: null, short_question: false, delegation_id: null,
    })]);
    expect(await delegations(rootId)).toEqual([]);
    expect(await inboxOf(oneId, msg)).toEqual(['mention']);
    // 담당의 뒤이은 글이 위임자에게 update 로 가지 않는다.
    await post(onePat, rootId, '보는 중');
    await pool.query(`update team_delegation_item set update_pending_at = now() - interval '2 minutes' where update_pending_message_id is not null`);
    expect(await flush()).not.toContain(leadId);
    expect((await pool.query(`select 1 from inbox where account_id = $1 and reason = 'delegation_update'`, [leadId])).rowCount).toBe(0);
  });

  it('반대 방향이 열려 있으면 답장(reply), 같은 방향이 열려 있으면 이어짐(existing)', async () => {
    const rootId = await openThread();
    await post(leadPat, rootId, '@ione 이 버그를 고쳐 달라');
    await post(onePat, rootId, '@ilead 어느 브랜치에서 할까?');
    await post(leadPat, rootId, '@ione main 에서');
    expect((await logRows(rootId)).map((r) => [r.delegator_account_id, r.verdict, r.short_question]))
      .toEqual([[leadId, 'open', false], [oneId, 'reply', true], [leadId, 'existing', false]]);
  });

  it('머리 런 밖의 지칭은 부름이 아니라 적지 않는다', async () => {
    const rootId = await openThread();
    await post(leadPat, rootId, '정리: 구현은 @ione 것이다');
    expect(await logRows(rootId)).toEqual([]);
  });

  it('message.delegate 의 글은 암묵 위임으로 적지 않는다(도구가 진짜 위임을 만든다)', async () => {
    const rootId = await openThread();
    await call(leadPat, 'message.delegate', { channelId, threadRootId: rootId, body: '@ione 넘긴다', to: ['ione'] });
    expect(await logRows(rootId)).toEqual([]);
    expect((await delegations(rootId)).map((d) => d.kind)).toEqual(['delegate']);
  });

  it('계획판 단계의 담당을 부르면 그 단계 id 를 단다', async () => {
    const rootId = await openThread();
    await pool.query(
      `insert into thread_plan (root_id, channel_id, doc) values ($1, $2, $3)`,
      [rootId, channelId, JSON.stringify({ goal: 'g', groups: [], steps: [
        { id: 's1', title: '끝난 일', state: 'done', assigneeId: oneId, links: [], dependsOn: [] },
        { id: 's2', title: '할 일', state: 'active', assigneeId: oneId, links: [], dependsOn: [] },
      ] })],
    );
    await post(leadPat, rootId, '@ione s2 를 맡아 달라');
    expect((await logRows(rootId))[0]).toMatchObject({ verdict: 'open', plan_step_id: 's2' });
  });
});

describe('P4 암묵 위임 — 켬(on)', () => {
  beforeEach(() => {
    vi.stubEnv('HARKROOM_DELEGATION_V2', 'on');
    vi.stubEnv('HARKROOM_DELEGATION_IMPLICIT', 'on');
  });

  it('kind=mention 위임 행을 열고 담당의 mention inbox 는 그대로 둔다 · 답장·이어짐은 새 행을 열지 않는다', async () => {
    const rootId = await openThread();
    const msg = await post(leadPat, rootId, '@ione 이 버그를 고쳐 달라');
    const rows = await delegations(rootId);
    expect(rows).toEqual([expect.objectContaining({ kind: 'mention', lead_account_id: leadId, plan_step_id: null })]);
    expect(await inboxOf(oneId, msg)).toEqual(['mention']);
    expect((await logRows(rootId))[0]).toMatchObject({ verdict: 'open', mode: 'on', delegation_id: rows[0].id });
    await post(onePat, rootId, '@ilead 어느 브랜치?');
    await post(leadPat, rootId, '@ione main');
    expect((await logRows(rootId)).map((r) => r.verdict)).toEqual(['open', 'reply', 'existing']);
    expect(await delegations(rootId)).toHaveLength(1);
  });

  it('제3자가 담당을 맨 앞 멘션으로 불러도 다른 위임자가 넘긴 열린 위임은 닫히지 않는다(이어짐) — security P4 #1', async () => {
    const rootId = await openThread();
    await call(leadPat, 'message.delegate', { channelId, threadRootId: rootId, body: '@ione 넘긴다', to: ['ione'] });
    await post(thirdPat, rootId, '@ione 이것도 봐 달라');
    const items = (await pool.query(
      `select d.kind, i.outcome from team_delegation d join team_delegation_item i on i.delegation_id = d.id
        where d.thread_root_id = $1 order by d.created_at`, [rootId])).rows;
    expect(items).toEqual([{ kind: 'delegate', outcome: null }]);
    expect((await logRows(rootId)).map((r) => r.verdict)).toEqual(['existing']);
  });

  it('암묵 위임은 message.delegate 의 라운드 상한을 쓰지 않는다', async () => {
    const rootId = await openThread();
    await post(leadPat, rootId, '@ione 이것 좀');
    const { roundsUsed } = await import('../src/services/delegations.js');
    expect(await roundsUsed(pool, { threadRootId: rootId, leadAccountId: leadId })).toBe(0);
  });
});

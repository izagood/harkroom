import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listInbox } from '../src/services/messages.js';
import { createDelegationDeadlineSweeper, autoCloseDelegations, flushDelegationUpdates, DELEGATION_UPDATE_LIMIT } from '../src/services/delegations.js';

/** 위임 재설계 v1(P3): 스위치를 켠 서버의 수명(reported·failed·closed)과 턴 끝 update. */
let app: FastifyInstance; let pool: Pool; let stop: () => Promise<void>;
let adminToken: string; let mcpUrl: string; let channelId: string;
let leadPat: string; let leadId: string; let onePat: string; let oneId: string; let twoPat: string; let twoId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const text = (r: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
const clients: Client[] = [];
async function client(token: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: auth(token) } }));
  clients.push(c);
  return c;
}
async function call(token: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return text(await (await client(token)).callTool({ name, arguments: args }));
}
const idOf = (r: Record<string, unknown>) => (r.message as { id: string }).id;
async function openThread(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body: '시작' } });
  return res.json().id as string;
}
async function delegate(rootId: string): Promise<string> {
  await client(onePat);
  const msg = idOf(await call(leadPat, 'message.delegate', { channelId, threadRootId: rootId, body: '@vone 넘긴다', to: ['vone'] }));
  return (await pool.query(`select id from team_delegation where message_id = $1`, [msg])).rows[0].id as string;
}
const item = async (delegationId: string) => (await pool.query(
  `select outcome, closed_reason, update_pending_message_id, update_count from team_delegation_item where delegation_id = $1 and delegate_account_id = $2`,
  [delegationId, oneId])).rows[0];
const leadInbox = async () => (await pool.query(
  `select reason, message_id from inbox where account_id = $1 and read_at is null order by id`, [leadId])).rows as { reason: string; message_id: string }[];
const markRead = () => pool.query(`update inbox set read_at = now() where read_at is null`);
async function flush(): Promise<string[]> {
  const c = await pool.connect();
  try { return await flushDelegationUpdates(c); } finally { c.release(); }
}
const backdatePending = () => pool.query(
  `update team_delegation_item set update_pending_at = now() - interval '2 minutes' where update_pending_message_id is not null`);

beforeAll(async () => {
  vi.stubEnv('HARKROOM_DELEGATION_V2', 'on');
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  adminToken = admin.token;
  ({ pat: leadPat, accountId: leadId } = await createAgent(app, adminToken, 'vlead'));
  ({ pat: onePat, accountId: oneId } = await createAgent(app, adminToken, 'vone'));
  ({ pat: twoPat, accountId: twoId } = await createAgent(app, adminToken, 'vtwo'));
  channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'vchan' } })).json().id as string;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await app.close(); await stop();
});
beforeEach(async () => { await markRead(); });

describe('P3 위임 수명', () => {
  it('report 는 reported 로 두고 위임자를 결과로 깨운다 — 닫지 않는다', async () => {
    const rootId = await openThread();
    const dlg = await delegate(rootId);
    await markRead();
    await call(onePat, 'message.report', { channelId, threadRootId: rootId, body: '결과', checks: ['확인'] });
    expect(await item(dlg)).toMatchObject({ outcome: 'reported', closed_reason: null });
    expect((await leadInbox()).map((r) => r.reason)).toEqual(['delegation_done']);
  });

  it('fail 은 failed', async () => {
    const rootId = await openThread();
    const dlg = await delegate(rootId);
    await call(onePat, 'message.fail', { channelId, threadRootId: rootId, body: '못 함', retryable: false });
    expect((await item(dlg)).outcome).toBe('failed');
  });

  it('담당 글은 턴 끝(60초)에 update 하나가 되고, 읽지 않은 것은 하나뿐이며, mention 은 update 로 바뀐다', async () => {
    const rootId = await openThread();
    const dlg = await delegate(rootId);
    await markRead();
    const p1 = idOf(await call(onePat, 'message.post', { channelId, threadRootId: rootId, body: '중간' }));
    expect((await item(dlg)).update_pending_message_id).toBe(p1);
    expect(await flush()).toEqual([]); // 아직 턴이 안 끝났다
    await backdatePending();
    expect(await flush()).toEqual([leadId]);
    expect(await leadInbox()).toEqual([{ reason: 'delegation_update', message_id: p1 }]);

    const p2 = idOf(await call(onePat, 'message.post', { channelId, threadRootId: rootId, body: '@vlead 더 했다' }));
    expect((await leadInbox()).map((r) => r.reason)).toEqual(['delegation_update', 'mention']);
    await backdatePending();
    await flush();
    expect(await leadInbox()).toEqual([{ reason: 'delegation_update', message_id: p2 }]);
    expect((await item(dlg)).update_count).toBe(2);
  });

  it('보고 뒤의 글도 update 로 가고, 상한을 넘으면 만들지 않는다', async () => {
    const rootId = await openThread();
    const dlg = await delegate(rootId);
    await call(onePat, 'message.report', { channelId, threadRootId: rootId, body: '결과', checks: ['확인'] });
    await markRead();
    await pool.query(`update team_delegation_item set update_count = $2 where delegation_id = $1`, [dlg, DELEGATION_UPDATE_LIMIT]);
    const p = idOf(await call(onePat, 'message.post', { channelId, threadRootId: rootId, body: '그 뒤' }));
    await backdatePending();
    expect(await flush()).toEqual([]);
    expect(await leadInbox()).toEqual([]);
    expect((await pool.query(`select meta->>'delegationUpdateSkipped' as s from message where id = $1`, [p])).rows[0].s).toBe('limit');
  });

  it('delegation.close 는 위임자만, 깨우지 않고 닫는다', async () => {
    const rootId = await openThread();
    const dlg = await delegate(rootId);
    await markRead();
    expect(await call(onePat, 'delegation.close', { threadRootId: rootId })).toEqual({ closed: 0 });
    expect(await call(leadPat, 'delegation.close', { threadRootId: rootId, delegate: 'vone' })).toEqual({ closed: 1 });
    expect(await item(dlg)).toMatchObject({ outcome: 'closed', closed_reason: 'delegator_close' });
    expect(await leadInbox()).toEqual([]);
  });

  it('같은 담당에게 새로 넘기면 앞 것은 superseded', async () => {
    const rootId = await openThread();
    const first = await delegate(rootId);
    await call(onePat, 'message.report', { channelId, threadRootId: rootId, body: '결과', checks: ['확인'] });
    const second = await delegate(rootId);
    expect(await item(first)).toMatchObject({ outcome: 'closed', closed_reason: 'superseded' });
    expect((await item(second)).outcome).toBeNull();
  });

  it('보고 뒤 6시간 조용하면 idle, 24시간 지나면 max_age — 깨우지 않는다', async () => {
    const rootA = await openThread();
    const a = await delegate(rootA);
    await call(onePat, 'message.report', { channelId, threadRootId: rootA, body: '결과', checks: ['확인'] });
    await pool.query(`update team_delegation_item set last_activity_at = now() - interval '7 hours' where delegation_id = $1`, [a]);
    const rootB = await openThread();
    const b = await delegate(rootB);
    await pool.query(`update team_delegation set created_at = now() - interval '25 hours' where id = $1`, [b]);
    await markRead();
    const c = await pool.connect();
    try { expect(await autoCloseDelegations(c)).toBeGreaterThanOrEqual(2); } finally { c.release(); }
    expect(await item(a)).toMatchObject({ outcome: 'closed', closed_reason: 'idle' });
    expect(await item(b)).toMatchObject({ outcome: 'closed', closed_reason: 'max_age' });
    expect(await leadInbox()).toEqual([]);
  });

  it('inbox 의 위임 요약: 위임자는 담당 전원, 담당은 자기 한 줄만 받는다', async () => {
    const rootId = await openThread();
    await client(onePat); await client(twoPat);
    await call(leadPat, 'message.delegate', { channelId, threadRootId: rootId, body: '@vone @vtwo 넘긴다', to: ['vone', 'vtwo'] });
    const p = idOf(await call(onePat, 'message.post', { channelId, threadRootId: rootId, body: '하는 중' }));
    const mine = (await listInbox(pool, oneId, { unreadOnly: true })).find((e) => e.threadRootId === rootId);
    expect(mine?.delegations).toHaveLength(1);
    expect(mine!.delegations![0]).toMatchObject({ role: 'delegate', delegatorHandle: 'vlead', prWatches: [] });
    expect(mine!.delegations![0]!.items).toEqual([expect.objectContaining({ handle: 'vone', state: 'open', lastMessageId: p })]);
    await backdatePending();
    await flush();
    const lead = (await listInbox(pool, leadId, { unreadOnly: true })).find((e) => e.reason === 'delegation_update' && e.threadRootId === rootId);
    expect(lead!.delegations![0]!.role).toBe('delegator');
    expect(lead!.delegations![0]!.items.map((i) => i.handle)).toEqual(['vone', 'vtwo']);
  });

  it('담당 쪽 요약의 PR 감시는 자기가 건 것만, 위임자는 전부 본다', async () => {
    const rootId = await openThread();
    await client(onePat); await client(twoPat);
    const msg = idOf(await call(leadPat, 'message.delegate', { channelId, threadRootId: rootId, body: '@vone @vtwo 넘긴다', to: ['vone', 'vtwo'] }));
    const dlg = (await pool.query(`select id from team_delegation where message_id = $1`, [msg])).rows[0].id as string;
    const watch = async (n: number, accountId: string) => {
      const w = (await pool.query<{ id: string }>(
        `insert into pr_watch (repo, number, head, until, expires_at) values ('example-org/example-repo', $1, $2, 'checks', now() + interval '1 hour') returning id`,
        [n, 'b'.repeat(40)])).rows[0]!.id;
      await pool.query(
        `insert into pr_watch_subscriber (watch_id, account_id, channel_id, thread_root_id, delegation_id) values ($1, $2, $3, $4, $5)`,
        [w, accountId, channelId, rootId, dlg]);
    };
    await watch(101, oneId);
    await watch(102, twoId);
    await call(onePat, 'message.post', { channelId, threadRootId: rootId, body: '하는 중' });
    const mine = (await listInbox(pool, oneId, { unreadOnly: true })).find((e) => e.threadRootId === rootId);
    expect(mine!.delegations![0]!.prWatches.map((w) => w.number)).toEqual([101]);
    await backdatePending();
    await flush();
    const lead = (await listInbox(pool, leadId, { unreadOnly: true })).find((e) => e.reason === 'delegation_update' && e.threadRootId === rootId);
    expect(lead!.delegations![0]!.prWatches.map((w) => w.number).sort()).toEqual([101, 102]);
  });

  it('update 는 위임자의 그 스레드 대기 깨움을 접고, 옛 러너(사유 미표기)에게는 delegation_followup 으로 보인다', async () => {
    const rootId = await openThread();
    const dlg = await delegate(rootId);
    const woken = await call(leadPat, 'turn.wake', { channelId, threadRootId: rootId, notBeforeSec: 600, reason: '담당 기다림' });
    expect(woken.error).toBeUndefined();
    await markRead();
    const p = idOf(await call(onePat, 'message.post', { channelId, threadRootId: rootId, body: '진행' }));
    await backdatePending();
    await flush();
    const canceled = await pool.query(
      `select count(*)::int as n from agent_wake where account_id = $1 and canceled_by_message_id = $2`, [leadId, p]);
    expect(canceled.rows[0].n).toBe(1);
    const entry = (await listInbox(pool, leadId, { unreadOnly: true })).find((e) => e.messageId === p);
    expect(entry?.canceledWakes?.length).toBe(1);
    const oldPoll = await call(leadPat, 'inbox.poll', {});
    expect((oldPoll.entries as { messageId: string; reason: string }[]).find((e) => e.messageId === p)?.reason).toBe('delegation_followup');
    // 옛 러너가 담당의 글을 「너를 부른 글 = 할 일」로 싣지 않게 — mention 으로 바꾸지 않는다.
    expect((oldPoll.entries as { reason: string }[]).some((e) => e.reason === 'mention')).toBe(false);
    const newPoll = await call(leadPat, 'inbox.poll', { inboxReasons: ['delegation_update'] });
    expect((newPoll.entries as { messageId: string; reason: string }[]).find((e) => e.messageId === p)?.reason).toBe('delegation_update');
    void dlg;
  });

  it('침묵은 닫지 않고 위임자에게 한 번만 알린다(stalled)', async () => {
    const rootId = await openThread();
    const dlg = await delegate(rootId);
    await markRead();
    const msg = (await pool.query(`select message_id from team_delegation where id = $1`, [dlg])).rows[0].message_id as string;
    await pool.query(`update team_delegation set deadline_at = now() - interval '1 minute' where id = $1`, [dlg]);
    await createDelegationDeadlineSweeper(pool).sweep();
    expect((await item(dlg)).outcome).toBeNull();
    expect(await leadInbox()).toEqual([{ reason: 'delegation_update', message_id: msg }]);
    await markRead();
    await pool.query(`update team_delegation set deadline_at = now() - interval '1 minute' where id = $1`, [dlg]);
    await createDelegationDeadlineSweeper(pool).sweep();
    expect(await leadInbox()).toEqual([]);
  });
});

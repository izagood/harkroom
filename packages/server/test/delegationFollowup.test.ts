import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, registerOperator } from './helpers/fixtures.js';
import { DELEGATION_FOLLOWUP_LIMIT } from '../src/services/delegations.js';
import { postMessage, verifiedCauseLink } from '../src/services/messages.js';
import { causeChainRoot } from '../src/services/mergeGrants.js';
import { PRINCIPAL_FROM_CAUSE_SQL } from '../src/services/invokePrincipal.js';
import { issueTurnLease } from '../src/services/secretAccess.js';

/** 닫힌 위임의 후속 report 가 넘긴 쪽을 깨운다(163). 판정은 위임 행으로만, 상한 안에서, 사람 권한 없이. */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let mcpUrl: string;
let leadPat: string;
let leadId: string;
let onePat: string;
let oneId: string;
let otherPat: string;
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const text = (r: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
  JSON.parse((r.content as { type: string; text: string }[])[0]!.text);

async function mcp(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

async function openThread(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body: '시작' } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const clients: Client[] = [];
async function client(token: string): Promise<Client> {
  const c = await mcp(token);
  clients.push(c);
  return c;
}

async function report(token: string, threadRootId: string, body = '결과'): Promise<string> {
  const res = text(await (await client(token)).callTool({
    name: 'message.report', arguments: { channelId, threadRootId, body, checks: ['확인'] },
  }));
  return (res.message as { id: string }).id;
}

/** 위임을 만들고 첫 report 로 닫은 뒤, 결말 항목을 읽은 상태까지 간다. */
async function closedDelegation(): Promise<{ rootId: string; delegationId: string }> {
  const rootId = await openThread();
  const res = text(await (await client(leadPat)).callTool({
    name: 'message.delegate', arguments: { channelId, threadRootId: rootId, body: '넘긴다', to: ['fone'] },
  }));
  const messageId = (res.message as { id: string }).id;
  await report(onePat, rootId, '첫 보고');
  await markRead();
  const row = await pool.query(`select id from team_delegation where message_id = $1`, [messageId]);
  return { rootId, delegationId: row.rows[0].id as string };
}

const markRead = () => pool.query(`update inbox set read_at = now() where account_id = $1 and read_at is null`, [leadId]);
const reasons = async (messageId: string) => (await pool.query(
  `select reason from inbox where account_id = $1 and message_id = $2 order by id`, [leadId, messageId])).rows.map((r) => r.reason as string);
const metaOf = async (messageId: string) => (await pool.query(`select meta from message where id = $1`, [messageId])).rows[0].meta as Record<string, unknown>;

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  const admin = await bootstrapAdmin(app);
  adminToken = admin.token;
  adminId = admin.accountId;
  ({ pat: leadPat, accountId: leadId } = await createAgent(app, adminToken, 'flead'));
  ({ pat: onePat, accountId: oneId } = await createAgent(app, adminToken, 'fone'));
  ({ pat: otherPat } = await createAgent(app, adminToken, 'fother'));
  const team = await app.inject({ method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'fteam' } });
  const teamId = team.json().id as string;
  for (const id of [leadId, oneId]) await app.inject({ method: 'PUT', url: `/teams/${teamId}/members/${id}`, headers: auth(adminToken) });
  await app.inject({ method: 'PUT', url: `/teams/${teamId}/lead`, headers: auth(adminToken), payload: { accountId: leadId } });
  channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'fchan' } })).json().id as string;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  mcpUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await app.close();
  await stop();
});

beforeEach(async () => { await markRead(); });

describe('163 위임 후속 보고', () => {
  it('닫힌 위임의 후속 report 만 깨운다 — 위임을 닫은 첫 보고·post·progress 는 아니다', async () => {
    const { rootId } = await closedDelegation();
    const one = await client(onePat);
    const posted = text(await one.callTool({ name: 'message.post', arguments: { channelId, threadRootId: rootId, body: '중간' } }));
    expect(await reasons((posted.message as { id: string }).id)).toEqual([]);
    const progressed = text(await one.callTool({ name: 'message.progress', arguments: { channelId, threadRootId: rootId, body: '진행' } }));
    expect(await reasons((progressed.message as { id: string }).id)).toEqual([]);
    const reported = await report(onePat, rootId, '감시 끝');
    expect(await reasons(reported)).toEqual(['delegation_followup']);
  });

  it('위임이 다 안 끝났으면 깨우지 않는다 — 결말 턴이 읽는다', async () => {
    const { rootId, delegationId } = await closedDelegation();
    await pool.query(`update team_delegation set notified_at = null where id = $1`, [delegationId]);
    expect(await reasons(await report(onePat, rootId))).toEqual([]);
  });

  it('6시간 뒤·다른 스레드·위임받지 않은 계정의 report 는 깨우지 않는다', async () => {
    const { rootId, delegationId } = await closedDelegation();
    expect(await reasons(await report(otherPat, rootId))).toEqual([]);
    const elsewhere = await openThread();
    expect(await reasons(await report(onePat, elsewhere))).toEqual([]);
    await pool.query(`update team_delegation set created_at = now() - interval '6 hours 1 minute' where id = $1`, [delegationId]);
    expect(await reasons(await report(onePat, rootId))).toEqual([]);
  });

  it('안 읽은 후속이 있으면 합치고, 상한을 넘으면 깨우지 않고 이유를 남긴다', async () => {
    const { rootId } = await closedDelegation();
    const first = await report(onePat, rootId);
    expect(await reasons(first)).toEqual(['delegation_followup']);
    expect(await reasons(await report(onePat, rootId))).toEqual([]); // 안 읽음 → 합침
    await markRead();
    for (let n = 1; n < DELEGATION_FOLLOWUP_LIMIT; n += 1) {
      expect(await reasons(await report(onePat, rootId))).toEqual(['delegation_followup']);
      await markRead();
    }
    const over = await report(onePat, rootId);
    expect(await reasons(over)).toEqual([]);
    expect((await metaOf(over)).delegationFollowupSkipped).toBe('followup_limit');
  });

  it('연쇄 상한에 걸리면 넣지 않고 이유를 남긴다', async () => {
    const { rootId } = await closedDelegation();
    const res = await app.inject({ method: 'GET', url: '/settings/mention-policy', headers: auth(adminToken) });
    const limit = res.json().chainLimit as number;
    // 깊이는 앞 고리에서 온다 — 위임 글의 깊이를 상한에 올려 팀원 글이 그것을 잇게 한다.
    await pool.query(`update message set mention_depth = $2 where id = (select message_id from team_delegation where thread_root_id = $1)`, [rootId, limit]);
    const capped = await report(onePat, rootId);
    expect(await reasons(capped)).toEqual([]);
    expect((await metaOf(capped)).delegationFollowupSkipped).toBe('chain_limit');
  });

  it('후속으로 깬 위임자의 글은 그 보고의 깊이를 잇는다', async () => {
    const { rootId } = await closedDelegation();
    const reported = await report(onePat, rootId);
    const depthOf = async (id: string) => (await pool.query(`select mention_depth from message where id = $1`, [id])).rows[0].mention_depth as number;
    const posted = await postMessage(pool, {
      channelId, authorId: leadId, body: '확인했다', threadRootId: rootId, causeMessageId: reported, chainCause: reported,
    } as never);
    const id = (posted as { message: { id: string } }).message.id;
    expect(await depthOf(id)).toBe(await depthOf(reported) + 1);
    // 깊이는 잇되 사슬 고리는 남기지 않는다.
    expect((await pool.query(`select cause_message_id from message where id = $1`, [id])).rows[0].cause_message_id).toBeNull();
  });

  it('사람 권한을 나르지 않는다 — principal·위임장·사슬 고리·머지 사슬이 모두 끊긴다', async () => {
    const { rootId } = await closedDelegation();
    const reported = await report(onePat, rootId);
    await pool.query(`update message set principal_account_id = $2 where id = $1`, [reported, adminId]);
    const principal = await pool.query(
      `select ${PRINCIPAL_FROM_CAUSE_SQL} as id
         from inbox i join message m on m.id = i.message_id join account a on a.id = m.author_id
        where i.account_id = $1 and i.message_id = $2`,
      [leadId, reported]);
    expect(principal.rows[0].id).toBeNull();
    const db = await pool.connect();
    try {
      expect(await verifiedCauseLink(db, leadId, reported)).toBeNull();
    } finally {
      db.release();
    }
    expect(await causeChainRoot(pool, { agentId: leadId, causeMessageId: reported, now: new Date() })).toBeNull();
    const mandate = await pool.query(
      `insert into mandate (owner_account_id, delegator_account_id, root_message_id, channel_id, thread_root_id, created_at, last_activity_at)
       values ($1, $1, $2, $3, $2, now(), now()) returning id`, [adminId, rootId, channelId]);
    await pool.query(`update message set mandate_id = $2 where id = $1`, [reported, mandate.rows[0].id]);
    const op = await registerOperator(app, adminToken, 'fmac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [leadId, op.operatorId, adminId]);
    const lease = await issueTurnLease(pool, { agentId: leadId, operatorId: op.operatorId, causeMessageId: reported });
    expect(lease.ok).toBe(true);
    const row = await pool.query(`select mandate_id, principal_account_id from secret_turn_lease where agent_id = $1 and cause_message_id = $2`, [leadId, reported]);
    expect(row.rows[0]).toEqual({ mandate_id: null, principal_account_id: null });
  });

  it('대조군: 평범한 멘션으로 받은 글은 사슬 고리가 된다', async () => {
    const rootId = await openThread();
    const mention = await pool.query(
      `insert into message (channel_id, thread_root_id, author_id, body, kind, seq)
       select $1, $2, $3, '본문', 'user', coalesce(max(seq), 0) + 1 from message where channel_id = $1 returning id`,
      [channelId, rootId, oneId]);
    const id = mention.rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [leadId, id]);
    const db = await pool.connect();
    try {
      expect(await verifiedCauseLink(db, leadId, id)).toBe(id);
    } finally {
      db.release();
    }
  });

  it('위임자가 채널에서 빠졌거나 꺼졌으면 넣지 않는다', async () => {
    const { rootId } = await closedDelegation();
    await pool.query(`update account set disabled_at = now() where id = $1`, [leadId]);
    try {
      expect(await reasons(await report(onePat, rootId))).toEqual([]);
    } finally {
      await pool.query(`update account set disabled_at = null where id = $1`, [leadId]);
    }
    await pool.query(`update channel set visibility = 'private' where id = $1`, [channelId]);
    await pool.query(`delete from channel_member where channel_id = $1 and account_id = $2`, [channelId, leadId]);
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [channelId, oneId]);
    try {
      expect(await reasons(await report(onePat, rootId))).toEqual([]);
    } finally {
      await pool.query(`update channel set visibility = 'public' where id = $1`, [channelId]);
    }
  });
});

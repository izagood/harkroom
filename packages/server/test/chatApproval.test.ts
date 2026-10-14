import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { agentPat, bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { toolAllowsFor } from '../src/services/permissionRequests.js';
import { parseChatApproval } from '../src/services/chatApproval.js';

// 소유자가 글로 권한 요청을 승인한다(스레드 795a9663, jaebin B · security 기준 1~20).
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const link = (id: string) => `harkroom://message/${id}`;

describe('parseChatApproval — 글 전체가 승인 낱말 + 멘션·카드 링크뿐일 때만', () => {
  it('맞는 꼴', () => {
    expect(parseChatApproval('승인')).toEqual({ cardIds: [] });
    expect(parseChatApproval('  승인함. ')).toEqual({ cardIds: [] });
    expect(parseChatApproval('Approve!')).toEqual({ cardIds: [] });
    expect(parseChatApproval(`<@${ID}> 승인 ${link(ID)}`)).toEqual({ cardIds: [ID] });
    expect(parseChatApproval(`승인 [sriov 카드](${link(ID)}) ${link(ID)}`)).toEqual({ cardIds: [ID] });
  });

  it('문장·부정·의문·거절·인용·코드·다른 링크는 승인이 아니다', () => {
    for (const body of [
      '승인 말고 기다려', '승인 안 함', '승인할까?', '승인?', '거절', 'deny', '좋아', '승인 승인', '',
      `> 승인 ${link(ID)}`, '`승인`', '```\n승인\n```', `승인 https://example.com/${ID}`, '#rcms 권한 카드 2장 승인 <- 승인함',
    ]) expect(parseChatApproval(body), body).toBeNull();
  });
});

describe('글 승인 → decidePermissionRequest(카드 버튼과 같은 효과)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let alicePat: string;
  let agentId: string; let agentToken: string;
  let ch: string; let otherCh: string; let bobOnly: string;
  let client: Client;
  let n = 0;

  const text = (r: Awaited<ReturnType<Client['callTool']>>): any =>
    JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
  const root = async (channelId = ch): Promise<string> =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'do it', 'user') returning id`,
      [channelId, alice.accountId])).rows[0].id as string;
  /** 새 규칙으로 권한 요청 하나 — 카드 id·요청 id. */
  const ask = async (threadRootId: string, channelId = ch, extra: Record<string, unknown> = {}) => {
    n += 1;
    const r = text(await client.callTool({ name: 'permission.request', arguments: {
      channelId, threadRootId, reason: '확인', kind: 'tool', rule: `Bash(kubectl --context ops -n sitebot get pods${n}:*)`, ...extra,
    } }));
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    return { cardId: r.cardMessageId as string, requestId: r.requestId as string };
  };
  const say = (token: string, body: string, threadRootId?: string, channelId = ch) =>
    app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body, ...(threadRootId ? { threadRootId } : {}) } });
  const status = async (requestId: string) =>
    (await pool.query(`select status from permission_request where id = $1`, [requestId])).rows[0].status as string;
  const card = async (cardId: string) => (await pool.query(`select meta from message where id = $1`, [cardId])).rows[0].meta;
  const systemLines = async (threadRootId: string) =>
    (await pool.query(`select body, meta from message where thread_root_id = $1 and kind = 'system' and meta ? 'chatApproval' order by seq`, [threadRootId])).rows as { body: string; meta: any }[];

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    alicePat = await agentPat(alice.accountId, 'alice-cli');
    ({ accountId: agentId, pat: agentToken } = await createAgent(app, admin.token, 'sitebot'));
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    const op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'sitebot' } })).json().id as string;
    otherCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'task' } })).json().id as string;
    bobOnly = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'admin-only', visibility: 'private' } })).json().id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2)`, [bobOnly, agentId]);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth(agentToken) } }));
  });
  afterAll(async () => { await client.close(); await app.close(); await db.stop(); });

  it('카드 스레드에 소유자가 「승인」 → grant·카드 답·에이전트 깨움·확인 줄', async () => {
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    const res = await say(alice.token, '승인', thread);
    expect(res.statusCode).toBe(201);
    expect(await status(requestId)).toBe('granted');
    const meta = await card(cardId);
    expect(meta.ask.answeredWith).toBe('approve');
    expect(meta.permissionRequest.decidedVia).toEqual({ kind: 'chat', messageId: res.json().id, target: 'T2' });
    // 카드 답이 요청한 에이전트를 깨운다 — 버튼과 같은 `ask_answered`.
    expect((await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2 and reason = 'ask_answered'`, [agentId, cardId])).rowCount).toBe(1);
    const lines = await systemLines(thread);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toContain('✓ sitebot');
    expect(lines[0]!.meta.chatApproval.results).toEqual([{ requestId, cardMessageId: cardId, ok: true }]);
    const audit = (await pool.query(`select detail from audit_log where action = 'permission.approved' and detail->>'requestId' = $1`, [requestId])).rows[0].detail;
    expect(audit).toMatchObject({ via: 'chat', messageId: res.json().id });
  });

  it('소유자가 아닌 사람·소유자의 PAT·에이전트 글은 승인하지 않는다', async () => {
    const thread = await root();
    const { requestId } = await ask(thread);
    expect((await say(bob.token, '승인', thread)).statusCode).toBe(201);
    expect((await say(admin.token, '승인', thread)).statusCode).toBe(201);
    // 사람 PAT 는 지금 글 올리기에서 401 이다 — 길이 다시 열려도 사람 세션이 아니므로 승인하지 않는다.
    expect([201, 401]).toContain((await say(alicePat, '승인', thread)).statusCode);
    await say(agentToken, '승인', thread);
    expect(await status(requestId)).toBe('pending');
    expect(await systemLines(thread)).toHaveLength(0);
  });

  /** T3 시험은 「소유자의 기다리는 요청 수」를 세므로 앞 시험이 남긴 요청을 먼저 만료시킨다. */
  const expireAll = () => pool.query(`update permission_request set expires_at = now() - interval '1 second' where status = 'pending'`);

  it('T3 — 카드 없는 다른 스레드의 맨 「승인」: 기다리는 요청이 하나뿐이면 그것을 승인하고 확인 줄을 단다', async () => {
    await expireAll();
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    const elsewhere = await root(otherCh);
    const res = await say(alice.token, '승인함', elsewhere, otherCh);
    expect(res.statusCode).toBe(201);
    expect(await status(requestId)).toBe('granted');
    expect((await card(cardId)).ask.answeredWith).toBe('approve');
    const lines = await systemLines(elsewhere);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toContain('✓ sitebot');
    expect(lines[0]!.body).toContain('거두려면');
    const audit = (await pool.query(`select detail from audit_log where action = 'permission.approved' and detail->>'requestId' = $1`, [requestId])).rows[0].detail;
    expect(audit).toMatchObject({ via: 'chat', messageId: res.json().id, chatTarget: 'T3' });
  });

  it('T3 — 기다리는 요청이 둘이면 승인하지 않고 후보 링크 목록만 남긴다', async () => {
    await expireAll();
    const a = await ask(await root()); const b = await ask(await root());
    const elsewhere = await root(otherCh);
    await say(alice.token, '승인', elsewhere, otherCh);
    expect([await status(a.requestId), await status(b.requestId)]).toEqual(['pending', 'pending']);
    const body = (await systemLines(elsewhere))[0]!.body;
    expect(body).toContain('2개라');
    expect(body).toContain(link(a.cardId));
    expect(body).toContain(link(b.cardId));
  });

  it('T3 — 글보다 뒤에 생긴 요청은 대상이 아니다', async () => {
    await expireAll();
    const { cardId, requestId } = await ask(await root());
    await pool.query(`update message set created_at = now() + interval '1 minute' where id = $1`, [cardId]);
    const elsewhere = await root(otherCh);
    await say(alice.token, '승인', elsewhere, otherCh);
    expect(await status(requestId)).toBe('pending');
    expect((await systemLines(elsewhere))[0]!.body).toContain('먼저 온 권한 요청이 없어');
  });

  it('T3 — 남의 에이전트 요청은 대상이 아니다', async () => {
    await expireAll();
    const { requestId } = await ask(await root());
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, bob.accountId]);
    try {
      const elsewhere = await root(otherCh);
      await say(alice.token, '승인', elsewhere, otherCh);
      expect(await status(requestId)).toBe('pending');
      expect(await systemLines(elsewhere)).toHaveLength(0);
    } finally {
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    }
  });

  it('카드가 둘인 스레드의 맨 「승인」은 하나도 승인하지 않는다 — 링크를 붙이면 그 카드만', async () => {
    const thread = await root();
    const a = await ask(thread); const b = await ask(thread);
    await say(alice.token, '승인', thread);
    expect([await status(a.requestId), await status(b.requestId)]).toEqual(['pending', 'pending']);
    expect((await systemLines(thread))[0]!.body).toContain('2장');
    expect((await systemLines(thread))[0]!.body).toContain(link(a.cardId));
    await say(alice.token, `승인 ${link(b.cardId)}`, thread);
    expect([await status(a.requestId), await status(b.requestId)]).toEqual(['pending', 'granted']);
  });

  it('다른 채널에서 카드 링크를 붙인 「승인」은 그 카드를 승인한다', async () => {
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    const elsewhere = await root(otherCh);
    await say(alice.token, `<@${agentId}> 승인 ${link(cardId)}`, elsewhere, otherCh);
    expect(await status(requestId)).toBe('granted');
    expect(await toolAllowsFor(pool, agentId, ch)).toContain(`Bash(kubectl --context ops -n sitebot get pods${n}:*)`);
  });

  it('볼 수 없는 채널의 카드 링크는 승인하지 않는다', async () => {
    const hidden = await root(bobOnly);
    const { cardId, requestId } = await ask(hidden, bobOnly);
    const elsewhere = await root(otherCh);
    await say(alice.token, `승인 ${link(cardId)}`, elsewhere, otherCh);
    expect(await status(requestId)).toBe('pending');
    expect((await systemLines(elsewhere))[0]!.body).toContain('볼 수 없다');
  });

  it('맨 글을 고쳐 링크를 덧붙여도 다시 판정하지 않는다', async () => {
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    const elsewhere = await root(otherCh);
    // 처음엔 승인 꼴이 아닌 글 — 고쳐서 승인 꼴이 돼도 다시 판정하지 않는다.
    const posted = await say(alice.token, '확인해 볼게', elsewhere, otherCh);
    const edit = await app.inject({
      method: 'PATCH', url: `/channels/${otherCh}/messages/${posted.json().id}`, headers: auth(alice.token), payload: { body: `승인 ${link(cardId)}` },
    });
    expect(edit.statusCode).toBe(200);
    expect(await status(requestId)).toBe('pending');
  });

  it('인용 안에만 승인 낱말과 링크가 있는 글은 승인하지 않는다', async () => {
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    await say(alice.token, `> 승인 ${link(cardId)}`, thread);
    await say(alice.token, `jaebin 이 이렇게 썼다:\n> 승인 ${link(cardId)}`, thread);
    expect(await status(requestId)).toBe('pending');
  });

  it('머지 거절에서 온 카드는 글로 승인하지 않는다', async () => {
    const thread = await root();
    const r = text(await client.callTool({ name: 'permission.request', arguments: { channelId: ch, threadRootId: thread, reason: 'merge', kind: 'merge', repo: 'acme-org/chat-approval' } }));
    expect(r.error).toBeUndefined();
    const denial = (await pool.query(
      `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at)
       values ($1, 'repo:acme-org/chat-approval', 7, $2, $3, $4, gen_random_uuid(), now() + interval '1 hour') returning id`,
      [agentId, 'a'.repeat(40), ch, thread])).rows[0].id;
    await pool.query(`update permission_request set denial_id = $2 where id = $1`, [r.requestId, denial]);
    await say(alice.token, `승인 ${link(r.cardMessageId)}`, thread);
    expect(await status(r.requestId)).toBe('pending');
    expect((await systemLines(thread))[0]!.body).toContain('머지 거절 카드');
  });

  it('정확한 명령 요청은 글로는 이번 한 번만 연다(1시간은 버튼에서만)', async () => {
    const thread = await root();
    const { requestId } = await ask(thread);
    // 명령 요청은 파일을 재는 오퍼레이터를 거쳐야 열려서, 요청 줄을 command 로 바꿔 결정 단계만 잰다.
    await pool.query(`update permission_request set kind = 'command', target = $2 where id = $1`,
      [requestId, 'kubectl --kubeconfig /etc/k/ops.yaml --context ops -n sitebot rollout restart deploy/web']);
    await say(alice.token, '승인', thread);
    expect((await pool.query(`select status, grant_mode from permission_request where id = $1`, [requestId])).rows[0]).toEqual({ status: 'granted', grant_mode: 'once' });
  });
});

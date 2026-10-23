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

describe('parseChatApproval — 문장 속 명시적 승인 낱말(G2)·부정·의문·인용·코드', () => {
  const P = (cardIds: string[], action: 'approve' | 'deny' | null, block: string | null = null, ciWord = false) => ({ cardIds, action, block, ciWord });
  const cases: [string, ReturnType<typeof P> | null][] = [
    ['승인', P([], 'approve')],
    ['  승인함. ', P([], 'approve')],
    ['Approve!', P([], 'approve')],
    ['approved', P([], 'approve')],
    ['승인해', P([], 'approve')],
    ['승인했어', P([], 'approve')],
    ['승인합니다', P([], 'approve')],
    ['머지 승인했어', P([], 'approve')],
    ['허락해 줄게', P([], 'approve')],
    ['그거 머지해', P([], 'approve')],
    ['진행해', P([], 'approve')],
    ['ok go ahead and approve it', P([], 'approve')],
    [`${link(ID)} 이 카드 승인해`, P([ID], 'approve')],
    [`<@${ID}> 승인 ${link(ID)}`, P([ID], 'approve')],
    [`승인 [sriov 카드](${link(ID)}) ${link(ID)}`, P([ID], 'approve')],
    [`CI 무시하고 머지해 ${link(ID)}`, P([ID], 'approve', null, true)],
    ['ignore CI and approve', P([], 'approve', null, true)],
    // 「다」·「요」·「줘」로 끝나는 보통 승인 — 물음 끝(까·나·니·냐·는지)으로 보지 않는다
    ['승인할게', P([], 'approve')],
    ['승인해 주세요', P([], 'approve')],
    ['승인했어요.', P([], 'approve')],
    ['머지해줘', P([], 'approve')],
    ['진행하세요!', P([], 'approve')],
    ['네 승인합니다. 진행해', P([], 'approve')],
    // 거부·금지·미루기·물음표 없는 물음 — 승인하지 않는다(fail closed)
    ['승인 못 해', P([], 'approve', 'negated')],
    ['허락 못 함', P([], 'approve', 'negated')],
    ['승인 금지', P([], 'approve', 'negated')],
    ['승인 불가', P([], 'approve', 'negated')],
    ['승인 거부할게', P([], 'approve', 'negated')],
    ['승인은 나중에 할게', P([], 'approve', 'negated')],
    ['승인 중지', P([], 'approve', 'negated')],
    ['머지해 이따가', P([], 'approve', 'negated')],
    ['머지해도 될까', P([], 'approve', 'question')],
    ['머지해도 되나', P([], 'approve', 'question')],
    ['진행해도 괜찮을까', P([], 'approve', 'question')],
    ['승인했니', P([], 'approve', 'question')],
    ['승인해도 돼', P([], 'approve', 'question')],
    [`이거 머지해도 되는지 ${link(ID)}`, P([ID], 'approve', 'question')],
    // 허용 꼴(security F3) — 낱말이 맨 끝 서술어가 아니면 정하지 않는다
    ['승인 좀 미뤄', P([], 'approve', 'negated')],
    ['승인은 좀 이르다', P([], 'approve', 'notFinal')],
    ['승인 아직이야', P([], 'approve', 'negated')],
    ['승인 말아', P([], 'approve', 'negated')],
    ['승인 노', P([], 'approve', 'notFinal')],
    ['승인 X', P([], 'approve', 'notFinal')],
    ['승인 ㄴㄴ', P([], 'approve', 'negated')],
    ['승인하면 큰일', P([], 'approve', 'notFinal')],
    ['승인해 줄래', P([], 'approve', 'notFinal')],
    ['안 승인해', P([], 'approve', 'negated')],
    ['approve later', P([], 'approve', 'negated')],
    ['approve the other one', P([], 'approve', 'notFinal')],
    [`거절은 좀 그래 ${link(ID)}`, P([ID], 'deny', 'denyNotFinal')],
    // security n14 — 「없이」는 승인이 아니다.
    ['승인 없이 진행해', P([], 'approve', 'negated')],
    ['권한 없이 머지해', P([], 'approve', 'negated')],
    ['ok 승인해', P([], 'approve')],
    ['승인 부탁', P([], 'approve')],
    ['좋아 승인 👍', P([], 'approve')],
    ['네, 승인했어요~ ㅎㅎ', P([], 'approve')],
    // 부정·보류·의문 — 낱말은 있지만 정하지 않는다
    ['승인 말고 기다려', P([], 'approve', 'negated')],
    ['승인 안 함', P([], 'approve', 'negated')],
    ['아직 승인하지 마', P([], 'approve', 'negated')],
    ['승인 보류', P([], 'approve', 'negated')],
    ['승인 취소', P([], 'approve', 'negated')],
    ['잠깐, 승인은 나중에', P([], 'approve', 'negated')],
    ['아니 승인 아니야', P([], 'approve', 'negated')],
    ["don't approve", P([], 'approve', 'negated')],
    ['승인할까?', P([], 'approve', 'question')],
    ['승인?', P([], 'approve', 'question')],
    [`이거 승인해도 돼？ ${link(ID)}`, P([ID], 'approve', 'question')],
    // 바이패스는 승인이 아니다
    ['바이패스 승인', P([], 'approve', 'bypass')],
    ['bypass it', P([], null, 'bypass')],
    // 거절
    ['거절', P([], 'deny')],
    ['deny', P([], 'deny')],
    [`거절해 ${link(ID)}`, P([ID], 'deny')],
    ['승인 아니고 거절', P([], 'approve', 'negated')],
    ['승인 거절', P([], 'approve', 'conflict')],
    // 링크만 — 낱말은 없다
    [`이 카드 봐줘 ${link(ID)}`, P([ID], null)],
    // 결정과 관계없는 글
    ['좋아', null],
    ['', null],
    ['승인 요청 왔네', null],
    ['승인 대기 중', null],
    ['승인받았어', null],
    ['미승인 상태', null],
    ['머지 충돌 났다', null],
    ['진행 상황 공유', null],
    ['approval flow docs', null],
    [`> 승인 ${link(ID)}`, null],
    [`jaebin 이 이렇게 썼다:\n> 승인 ${link(ID)}`, null],
    ['`승인`', null],
    ['```\n승인\n```', null],
    [`\`\`\`\n승인 ${link(ID)}\n\`\`\``, null],
    [`승인 https://example.com/${ID}`, P([], 'approve')],
  ];
  it.each(cases)('%j', (body, want) => {
    expect(parseChatApproval(body)).toEqual(want);
  });
  it('2000자 넘는 글은 보지 않는다', () => {
    expect(parseChatApproval(`승인 ${'x'.repeat(2000)}`)).toBeNull();
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
    // 하루 상한(20)에 걸리지 않게 앞 시험의 요청을 하루 전으로 민다.
    await pool.query(`update permission_request set created_at = created_at - interval '2 days' where agent_id = $1`, [agentId]);
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
    expect(meta.ask.answeredWith).toBe('approve_new_mandate');
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
    expect((await card(cardId)).ask.answeredWith).toBe('approve_new_mandate');
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
    // 후보 목록은 링크만 — 규칙 원문·채널 이름·핸들을 싣지 않는다(security F2).
    expect(body).not.toContain('kubectl');
    expect(body).not.toContain('#sitebot');
    expect(body).not.toContain('sitebot ·');
  });

  it('T3 — 글보다 뒤에 생긴 요청은 대상이 아니다', async () => {
    await expireAll();
    const { cardId, requestId } = await ask(await root());
    await pool.query(`update message set created_at = now() + interval '1 minute' where id = $1`, [cardId]);
    const elsewhere = await root(otherCh);
    await say(alice.token, '승인', elsewhere, otherCh);
    expect(await status(requestId)).toBe('pending');
    expect((await systemLines(elsewhere))[0]!.body).toContain('먼저 온 기다리는 요청이 없다');
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
    expect((await systemLines(thread))[0]!.body).not.toContain('kubectl');
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
    // 거절 줄에는 그 채널의 이름·규칙 원문이 실리지 않는다(security F1).
    const line = (await systemLines(elsewhere))[0]!;
    expect(line.body).toContain('볼 수 없는 채널의 카드');
    expect(line.body).not.toContain('kubectl');
    expect(line.body).not.toContain('admin-only');
    expect(JSON.stringify(line.meta.chatApproval)).not.toContain(requestId);
  });

  it('T3 — 유일한 후보가 볼 수 없는 채널의 요청이면 승인하지 않고 내용도 적지 않는다', async () => {
    await expireAll();
    const { requestId } = await ask(await root(bobOnly), bobOnly);
    const elsewhere = await root(otherCh);
    await say(alice.token, '승인', elsewhere, otherCh);
    expect(await status(requestId)).toBe('pending');
    const body = (await systemLines(elsewhere))[0]!.body;
    expect(body).toContain('볼 수 없는 채널의 카드');
    expect(body).not.toContain('kubectl');
    expect(body).not.toContain('admin-only');
  });

  it('T3 — 권한 카드가 이미 정해진 스레드의 「승인」은 다른 스레드의 요청으로 넘어가지 않는다(F3)', async () => {
    await expireAll();
    const thread = await root();
    const decided = await ask(thread);
    const btn = await app.inject({ method: 'POST', url: `/agents/${agentId}/permission-requests/${decided.requestId}/approve`, headers: auth(alice.token) });
    expect(btn.statusCode).toBe(200);
    const other = await ask(await root());
    await say(alice.token, '승인', thread);
    expect(await status(other.requestId)).toBe('pending');
    expect((await systemLines(thread))[0]!.body).toContain('이미 정해졌거나 만료됐다');
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

  /** 머지 거절 카드 — 거절 기록(head·사유)을 카드에 묶는다. */
  const mergeCard = async (thread: string, opts: { head?: string; cardHead?: string; ci?: boolean } = {}) => {
    n += 1;
    await pool.query(`update permission_request set created_at = created_at - interval '2 days' where agent_id = $1`, [agentId]);
    const r = text(await client.callTool({ name: 'permission.request', arguments: { channelId: ch, threadRootId: thread, reason: 'merge', kind: 'merge', repo: `acme-org/chat-approval${n}` } }));
    expect(r.error, JSON.stringify(r)).toBeUndefined();
    const head = opts.head ?? 'a'.repeat(40);
    const denial = (await pool.query(
      `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at, reason, failed_checks)
       values ($1, $2, 7, $3, $4, $5, gen_random_uuid(), now() + interval '1 hour', $6, $7) returning id`,
      [agentId, `repo:acme-org/chat-approval${n}`, head, ch, thread, opts.ci ? 'ci_not_green' : 'not_granted', opts.ci ? ['build'] : []])).rows[0].id;
    await pool.query(`update permission_request set denial_id = $2 where id = $1`, [r.requestId, denial]);
    const once = { number: 7, headSha: opts.cardHead ?? head, reason: opts.ci ? 'ci_not_green' : 'not_granted', ...(opts.ci ? { failedChecks: ['build'] } : {}) };
    await pool.query(`update message set meta = jsonb_set(meta, '{permissionRequest,once}', $2::jsonb) where id = $1`, [r.cardMessageId, JSON.stringify(once)]);
    return { cardId: r.cardMessageId as string, requestId: r.requestId as string };
  };

  it('머지 거절 카드 — 글로 이번 한 번 머지(head 는 카드 값, gh 계정은 비워 오퍼레이터가 고른다)', async () => {
    const thread = await root();
    const m = await mergeCard(thread);
    await say(alice.token, `머지 승인했어 ${link(m.cardId)}`, thread);
    expect(await status(m.requestId)).toBe('approved_once');
    const ap = (await pool.query(`select head_sha, gh_user, relax_checks from merge_approval where agent_id = $1 order by approved_at desc limit 1`, [agentId])).rows[0];
    expect(ap).toEqual({ head_sha: 'a'.repeat(40), gh_user: null, relax_checks: false });
  });

  it('머지 거절 카드 — 카드 스레드의 맨 「머지해」도 그 카드 하나면 정한다', async () => {
    const thread = await root();
    const m = await mergeCard(thread);
    await say(alice.token, '응 머지해', thread);
    expect(await status(m.requestId)).toBe('approved_once');
  });

  it('머지 거절 카드 — head 가 카드와 다르면 승인하지 않고 안내한다', async () => {
    const thread = await root();
    const m = await mergeCard(thread, { head: 'b'.repeat(40), cardHead: 'a'.repeat(40) });
    await say(alice.token, `승인 ${link(m.cardId)}`, thread);
    expect(await status(m.requestId)).toBe('pending');
    const line = (await systemLines(thread))[0]!;
    expect(line.body).toContain('승인 안 됨');
    expect(line.body).toContain('head');
    expect(line.meta.i18n).toEqual({ key: 'system.chatApproval.headChanged', args: {} });
  });

  it('CI 실패 카드 — 「CI 무시」가 없으면 안내, 있으면 CI 무시하고 한 번', async () => {
    const thread = await root();
    const m = await mergeCard(thread, { ci: true });
    await say(alice.token, `승인 ${link(m.cardId)}`, thread);
    expect(await status(m.requestId)).toBe('pending');
    expect((await systemLines(thread))[0]!.meta.i18n.key).toBe('system.chatApproval.ciWord');
    await say(alice.token, `CI 무시하고 승인 ${link(m.cardId)}`, thread);
    expect(await status(m.requestId)).toBe('approved_once');
    const ap = (await pool.query(`select relax_checks, ci_override from merge_approval where agent_id = $1 order by approved_at desc limit 1`, [agentId])).rows[0];
    expect(ap).toEqual({ relax_checks: true, ci_override: true });
  });

  it('문장 속 승인 — 링크한 권한 카드를 승인한다', async () => {
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    const elsewhere = await root(otherCh);
    await say(alice.token, `${link(cardId)} 이 카드 승인해`, elsewhere, otherCh);
    expect(await status(requestId)).toBe('granted');
  });

  it('링크 없는 문장 승인 — 이 스레드에 정할 카드가 하나면 그것', async () => {
    const thread = await root();
    const { requestId } = await ask(thread);
    await say(alice.token, '확인했어, 승인합니다', thread);
    expect(await status(requestId)).toBe('granted');
  });

  it('부정·의문·바이패스 — 정하지 않고 「승인 안 됨」 한 줄', async () => {
    const thread = await root();
    const { requestId } = await ask(thread);
    for (const [body, key] of [['승인 말고 기다려', 'negated'], ['승인할까?', 'question'], ['바이패스 승인', 'bypass'], ['승인 노', 'notFinal']] as const) {
      await say(alice.token, body, thread);
      const lines = await systemLines(thread);
      expect(lines.at(-1)!.meta.i18n, body).toEqual({ key: `system.chatApproval.${key}`, args: {} });
      expect(lines.at(-1)!.body.startsWith('⚠️ 승인 안 됨:')).toBe(true);
    }
    expect(await status(requestId)).toBe('pending');
  });

  it('거절 — 링크가 있으면 거절하고, 없으면 안내만', async () => {
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    await say(alice.token, '거절', thread);
    expect(await status(requestId)).toBe('pending');
    expect((await systemLines(thread)).at(-1)!.meta.i18n.key).toBe('system.chatApproval.denyNeedsLink');
    await say(alice.token, `거절해 ${link(cardId)}`, thread);
    expect(await status(requestId)).toBe('denied');
  });

  it('조용히 넘기지 않는다 — 링크만 있고 낱말이 없으면 안내 한 줄', async () => {
    const thread = await root();
    const { cardId, requestId } = await ask(thread);
    const elsewhere = await root(otherCh);
    await say(alice.token, `이 카드 봐줘 ${link(cardId)}`, elsewhere, otherCh);
    expect(await status(requestId)).toBe('pending');
    const lines = await systemLines(elsewhere);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.meta.i18n.key).toBe('system.chatApproval.noWord');
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

  describe('거울 카드 — 서버가 인정하는 진짜 거울만 원본으로 센다(F2)', () => {
    let otherBot: string;
    beforeAll(async () => {
      otherBot = (await createAgent(app, admin.token, 'otherbot')).accountId;
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [otherBot, bob.accountId]);
    });
    /** 다른 채널 스레드에 원본 카드를 가리키는 거울 하나 — 선택지는 원본과 같게. */
    const mirrorIn = async (cardId: string, authorId: string) => {
      const thread = await root(otherCh);
      const options = (await card(cardId)).ask.options;
      const mirrorId = (await pool.query(
        `insert into message (channel_id, author_id, body, kind, thread_root_id, meta) values ($1, $2, '거울', 'user', $3, $4) returning id`,
        [otherCh, authorId, thread, JSON.stringify({ kind: 'ask', ask: { prompt: '권한', options, to: { kind: 'human' }, mirrorOf: cardId } })])).rows[0].id as string;
      return { thread, mirrorId };
    };

    it('남의 에이전트가 세운 거울 스레드의 「진행해」·그 거울 링크는 원본을 정하지 않는다', async () => {
      await expireAll();
      const { requestId, cardId } = await ask(await root());
      const fake = await mirrorIn(cardId, otherBot);
      expect((await say(alice.token, '진행해', fake.thread, otherCh)).statusCode).toBe(201);
      expect(await status(requestId)).toBe('pending');
      expect((await say(alice.token, `${link(fake.mirrorId)} 승인해`, fake.thread, otherCh)).statusCode).toBe(201);
      expect(await status(requestId)).toBe('pending');
      expect((await card(cardId)).ask.answeredWith).toBeUndefined();
    });

    it('소유자 에이전트가 세운 진짜 거울은 스레드의 「진행해」로 원본을 정한다', async () => {
      await expireAll();
      const { requestId, cardId } = await ask(await root());
      const real = await mirrorIn(cardId, agentId);
      expect((await say(alice.token, '진행해', real.thread, otherCh)).statusCode).toBe(201);
      expect(await status(requestId)).toBe('granted');
      expect((await card(cardId)).permissionRequest.decidedVia).toMatchObject({ kind: 'chat', target: 'T2' });
    });

    it('진짜 거울 링크로도 원본을 정한다', async () => {
      await expireAll();
      const { requestId, cardId } = await ask(await root());
      const real = await mirrorIn(cardId, agentId);
      const elsewhere = await root(otherCh);
      expect((await say(alice.token, `${link(real.mirrorId)} 승인해`, elsewhere, otherCh)).statusCode).toBe(201);
      expect(await status(requestId)).toBe('granted');
    });
  });
});

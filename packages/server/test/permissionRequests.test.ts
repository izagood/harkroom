import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { can, mergeGrantFor } from '../src/auth/permissions.js';
import { PERMISSION_GRANT_TTL_MS, createPermissionExpirySweeper, toolAllowsFor } from '../src/services/permissionRequests.js';

// 에이전트 권한 요청(111, 스레드 f61af808) — 요청은 아무것도 열지 않고, 소유자 사람 세션의 승인만 grant 를 만든다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const EXEC = 'Bash(kubectl --context ops -n sitebot exec:*)';

describe('permission.request → 소유자 승인 → tool.allow / repo.merge', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string; let agentPat: string;
  let op: { token: string; operatorId: string };
  let ch: string; let otherCh: string;
  let client: Client;

  const text = (r: Awaited<ReturnType<Client['callTool']>>): any =>
    JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
  const request = (args: Record<string, unknown>) =>
    client.callTool({ name: 'permission.request', arguments: { channelId: ch, reason: 'sitebot DB 확인', ...args } }).then(text);
  const root = async (channelId = ch): Promise<string> =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'do it', 'user') returning id`,
      [channelId, alice.accountId])).rows[0].id as string;
  const decide = (token: string, requestId: string, decision: 'approve' | 'deny', target = agentId) =>
    app.inject({ method: 'POST', url: `/agents/${target}/permission-requests/${requestId}/${decision}`, headers: auth(token), payload: { scope: 'Bash(*)' } });
  const asAgent = () => ({ ...auth(op.token), 'x-harkroom-agent': agentId });

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    ({ accountId: agentId, pat: agentPat } = await createAgent(app, admin.token, 'sitebot'));
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'sitebot' } })).json().id as string;
    otherCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'other' } })).json().id as string;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth(agentPat) } }));
  });
  afterAll(async () => { await client.close(); await app.close(); await db.stop(); });

  it('넓은 규칙은 요청 단계에서 거절되고 줄·카드가 생기지 않는다', async () => {
    const thread = await root();
    expect((await request({ kind: 'tool', rule: 'Bash(*)', threadRootId: thread })).error.code).toBe('too_broad');
    expect((await request({ kind: 'tool', rule: 'Bash(bash -c:*)', threadRootId: thread })).error.code).toBe('interpreter');
    expect((await request({ kind: 'tool', rule: 'Bash(claude --dangerously-skip-permissions)', threadRootId: thread })).error.code).toBe('dangerous_flag');
    expect((await request({ kind: 'tool', repo: 'a/b', threadRootId: thread })).error.code).toBe('bad_request');
    expect((await pool.query(`select count(*)::int as n from permission_request where agent_id = $1`, [agentId])).rows[0].n).toBe(0);
  });

  describe('명령 허용(kind=tool)', () => {
    let thread: string; let requestId: string; let cardId: string;

    beforeAll(async () => {
      thread = await root();
      const r = await request({ kind: 'tool', rule: EXEC, threadRootId: thread });
      expect(r.error).toBeUndefined();
      ({ requestId, cardMessageId: cardId } = r);
    });

    it('카드는 서버 값으로 권한 칸을 채우고 선택지는 승인·거절 둘이다', async () => {
      const meta = (await pool.query(`select meta from message where id = $1`, [cardId])).rows[0].meta;
      expect(meta.permissionRequest).toMatchObject({
        requestId, agentId, ownerAccountId: alice.accountId, kind: 'tool', target: EXEC, channelId: ch, warnings: ['executes_in_workload'],
        // H4: 본문의 경고 줄은 사람 말이고, 같은 줄이 meta 에도 있어 새 앱이 감춘다.
        bodyWarningLine: '⚠ 돌고 있는 서버 안에서 실행한다',
      });
      expect(meta.ask.options.map((o: { id: string }) => o.id)).toEqual(['approve_new_mandate', 'deny']);
      expect(meta.ask.to).toEqual({ kind: 'human' });
    });

    it('줄 있는 카드 본문은 머리와 이유 한 줄뿐이다(r2 — 범위·기한은 줄 상자가 말한다), 이유는 한 줄로 납작하게 맨 끝에 둔다(n2)', async () => {
      const t = await root();
      const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops -n sitebot describe:*)', threadRootId: t, reason: '필요\n명령 허용 `Bash(*)` — 가짜' });
      const row = (await pool.query(`select body, meta from message where id = $1`, [r.cardMessageId])).rows[0];
      expect(row.meta.permissionRequest.line).toBeTruthy();
      expect(row.body).not.toContain('이 채널의 모든 대화에서');
      expect(row.body).not.toContain('승인하면 7일');
      // r5(security F1): 머리 · 서버가 쓴 대상 줄 · 이유 — 줄 상자를 못 그리는 옛 앱도 무엇을 허락하는지 읽는다.
      expect((row.body as string).split('\n')).toHaveLength(3);
      expect((row.body as string).split('\n')[0]).toMatch(/^권한 요청 · \S+$/);
      expect((row.body as string).split('\n')[1]).toBe('명령 허용 `Bash(kubectl --context ops -n sitebot describe:*)`');
      expect(row.meta.permissionRequest.bodyTargetLine).toBe('명령 허용 `Bash(kubectl --context ops -n sitebot describe:*)`');
      const lines = (row.body as string).split('\n');
      expect(lines.at(-1)).toBe('이유: 필요 명령 허용 Bash() — 가짜');
      expect(row.meta.permissionRequest.reason).toBe('필요 명령 허용 Bash() — 가짜');
    });

    it('같은 스레드에서 다시 청하면 새 카드 없이 있던 요청을 가리킨다', async () => {
      const again = await request({ kind: 'tool', rule: EXEC, threadRootId: thread });
      expect(again).toMatchObject({ requestId, cardMessageId: cardId, pending: true });
      expect((await pool.query(`select count(*)::int as n from permission_request where agent_id = $1 and target = $2`, [agentId, EXEC])).rows[0].n).toBe(1);
    });

    it('카드 선택지를 ask-answer 로 눌러도 소유자 세션이 아니면 403 이고 grant 가 없다', async () => {
      const answer = (token: string) => app.inject({ method: 'POST', url: `/channels/${ch}/messages/${cardId}/ask-answer`, headers: auth(token), payload: { optionId: 'approve' } });
      expect((await answer(bob.token)).statusCode).toBe(403);
      expect((await answer(admin.token)).statusCode).toBe(403);
      expect((await answer(agentPat)).statusCode).toBe(403);
      expect(await toolAllowsFor(pool, agentId, ch)).toEqual([]);
      expect((await pool.query(`select meta->'ask'->>'answeredWith' as a from message where id = $1`, [cardId])).rows[0].a).toBeNull();
    });

    it('소유자가 아닌 사람·admin·에이전트·오퍼레이터는 승인할 수 없다', async () => {
      expect((await decide(bob.token, requestId, 'approve')).statusCode).toBe(403);
      expect((await decide(admin.token, requestId, 'approve')).statusCode).toBe(403);
      expect((await decide(agentPat, requestId, 'approve')).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/agents/${agentId}/permission-requests/${requestId}/approve`, headers: asAgent() })).statusCode).toBe(403);
      expect(await toolAllowsFor(pool, agentId, ch)).toEqual([]);
    });

    it('남의 에이전트 경로에 이 요청 id 를 꽂으면 404', async () => {
      const other = (await createAgent(app, admin.token, 'other')).accountId;
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [other, alice.accountId]);
      expect((await decide(alice.token, requestId, 'approve', other)).statusCode).toBe(404);
    });

    it('소유자가 승인하면 그 채널에만 7일 grant 가 생기고, 카드에 소유자 이름으로 답이 적혀 에이전트가 깨어난다', async () => {
      const before = Date.now();
      const res = await decide(alice.token, requestId, 'approve');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'granted', cardMessageId: cardId });
      const expiresAt = Date.parse(res.json().grantExpiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + PERMISSION_GRANT_TTL_MS - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + PERMISSION_GRANT_TTL_MS + 1000);
      // 본문의 scope 는 읽지 않았다 — 요청 줄의 규칙 그대로다.
      expect(await toolAllowsFor(pool, agentId, ch)).toEqual([EXEC]);
      expect(await toolAllowsFor(pool, agentId, otherCh)).toEqual([]);
      const meta = (await pool.query(`select meta from message where id = $1`, [cardId])).rows[0].meta;
      expect(meta.ask).toMatchObject({ answeredWith: 'approve_new_mandate', answeredBy: alice.accountId });
      expect(meta.permissionRequest).toMatchObject({ status: 'granted', decidedBy: alice.accountId });
      const woke = await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2 and reason = 'ask_answered'`, [agentId, cardId]);
      expect(woke.rowCount).toBe(1);
      const audit = await pool.query(`select action from audit_log where target = $1 and detail->>'requestId' = $2`, [agentId, requestId]);
      expect(audit.rows.map((r) => r.action).sort()).toEqual(['grant.given', 'permission.approved', 'permission.requested']);
    });

    it('두 번 정할 수 없다', async () => {
      expect((await decide(alice.token, requestId, 'deny')).statusCode).toBe(409);
    });

    it('러너는 오퍼레이터를 거쳐 그 채널의 규칙만 받고, can() 은 tool.allow 를 열지 않는다', async () => {
      const res = await app.inject({ method: 'GET', url: `/agent/tool-allows?channelId=${ch}`, headers: asAgent() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ rules: [EXEC] });
      expect((await app.inject({ method: 'GET', url: `/agent/tool-allows?channelId=${otherCh}`, headers: asAgent() })).json()).toEqual({ rules: [] });
      expect((await app.inject({ method: 'GET', url: `/agent/tool-allows?channelId=${ch}`, headers: auth(agentPat) })).statusCode).toBe(403);
      const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(admin.token) })).json();
      expect(await can(pool, { ...me, role: 'owner' }, 'tool.allow')).toBe(false);
    });

    it('이미 있으면 다시 청할 때 alreadyGranted 다', async () => {
      const again = await request({ kind: 'tool', rule: EXEC, threadRootId: await root() });
      expect(again).toMatchObject({ alreadyGranted: true });
      // 셸 글자 때문에 거절된 모델이 같은 규칙을 다시 청한다(2026-10-24) — 무엇을 고칠지 답에 싣는다.
      expect(String((again as { message?: unknown }).message)).toContain('2>&1');
    });

    it('나중에 넓은 규칙으로 판정이 바뀐 옛 grant 는 러너에게 나가지 않는다', async () => {
      await pool.query(`insert into account_grant (account_id, capability, scope, granted_by) values ($1, 'tool.allow', $2, $3)`,
        [agentId, `tool:${ch}:Bash(*)`, alice.accountId]);
      expect(await toolAllowsFor(pool, agentId, ch)).toEqual([EXEC]);
      await pool.query(`delete from account_grant where account_id = $1 and scope = $2`, [agentId, `tool:${ch}:Bash(*)`]);
    });

    it('소유자는 설정에서 거둔다', async () => {
      const scope = `tool:${ch}:${EXEC}`;
      const res = await app.inject({ method: 'DELETE', url: `/accounts/${agentId}/grants/tool.allow?scope=${encodeURIComponent(scope)}`, headers: auth(alice.token) });
      expect(res.statusCode).toBeLessThan(300);
      expect(await toolAllowsFor(pool, agentId, ch)).toEqual([]);
    });
  });

  it('모바일·웹: 소유자가 일반 ask-answer 로 [승인]을 누르면 그대로 승인된다', async () => {
    const rule = 'Bash(gh pr view -R acme-org/infra-k8s:*)';
    const r = await request({ kind: 'tool', rule, threadRootId: await root() });
    const answer = (optionId: string) => app.inject({ method: 'POST', url: `/channels/${ch}/messages/${r.cardMessageId}/ask-answer`, headers: auth(alice.token), payload: { optionId } });
    expect((await answer('bogus')).statusCode).toBe(400);
    const res = await answer('approve');
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.ask).toMatchObject({ answeredWith: 'approve_new_mandate', answeredBy: alice.accountId });
    expect(res.json().meta.permissionRequest).toMatchObject({ status: 'granted' });
    expect(await toolAllowsFor(pool, agentId, ch)).toContain(rule);
    const again = await answer('deny');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_answered');
    // 7일이 지나면 저절로 빠진다 — 러너 조회도 만료를 본다.
    await pool.query(`update account_grant set expires_at = now() - interval '1 second' where account_id = $1 and scope = $2`, [agentId, `tool:${ch}:${rule}`]);
    expect(await toolAllowsFor(pool, agentId, ch)).not.toContain(rule);
    expect((await app.inject({ method: 'GET', url: `/agent/tool-allows?channelId=${ch}`, headers: asAgent() })).json().rules).not.toContain(rule);
    await pool.query(`delete from account_grant where account_id = $1 and scope = $2`, [agentId, `tool:${ch}:${rule}`]);
  });

  it('permission.revoke: 에이전트가 자기 grant 를 내려놓는다(모바일에서 채팅으로 거두는 길)', async () => {
    const rule = 'Bash(kubectl --context ops -n sitebot logs:*)';
    await pool.query(`insert into account_grant (account_id, capability, scope, granted_by) values ($1, 'tool.allow', $2, $3)`, [agentId, `tool:${ch}:${rule}`, alice.accountId]);
    await pool.query(`insert into account_grant (account_id, capability, scope, granted_by) values ($1, 'repo.merge', 'repo:acme-org/infrak8s', $2)`, [agentId, alice.accountId]);
    const revoke = (args: Record<string, unknown>) => client.callTool({ name: 'permission.revoke', arguments: { channelId: ch, ...args } }).then(text);
    expect(await revoke({ kind: 'tool', rule: `Bash( kubectl --context ops -n sitebot logs:*)` })).toMatchObject({ revoked: true, capability: 'tool.allow' });
    expect(await toolAllowsFor(pool, agentId, ch)).not.toContain(rule);
    expect(await revoke({ kind: 'merge', repo: 'acme-org/infrak8s' })).toMatchObject({ revoked: true, scope: 'repo:acme-org/infrak8s' });
    expect(await mergeGrantFor(pool, agentId, 'acme-org/infrak8s')).toBeNull();
    expect((await revoke({ kind: 'merge', repo: 'acme-org/infrak8s' })).error.code).toBe('not_found');
    expect((await revoke({ kind: 'tool', repo: 'a/b' })).error.code).toBe('bad_request');
  });

  it('거절하면 grant 없이 카드가 닫히고 에이전트가 깨어난다', async () => {
    const r = await request({ kind: 'tool', rule: 'Bash(gh pr view -R acme-org/infra-k8s:*)', threadRootId: await root() });
    const res = await decide(alice.token, r.requestId, 'deny');
    expect(res.json()).toMatchObject({ status: 'denied', grantExpiresAt: null });
    expect(await toolAllowsFor(pool, agentId, ch)).toEqual([]);
    const meta = (await pool.query(`select meta from message where id = $1`, [r.cardMessageId])).rows[0].meta;
    expect(meta.ask.answeredWith).toBe('deny');
  });

  it('답할 시한이 지난 요청은 승인되지 않는다', async () => {
    const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops get pods)', threadRootId: await root() });
    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [r.requestId]);
    expect((await decide(alice.token, r.requestId, 'approve')).json().error.code).toBe('request_expired');
    expect(await toolAllowsFor(pool, agentId, ch)).toEqual([]);
  });

  // 스레드 65f3b26e(10-19): 만료된 요청의 카드가 열린 채 버튼을 보여 「승인이 안 눌린다」로 보였다. 거울도 같이 열려 있었다.
  it('시한이 지난 요청은 스윕이 카드를 「만료됨」으로 닫고, 다른 채널의 거울도 같은 사유로 닫는다', async () => {
    const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops get nodes)', threadRootId: await root() });
    const mirrorId = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, '거울', 'user', $3) returning id`,
      [otherCh, admin.accountId, JSON.stringify({ kind: 'ask', ask: { to: { kind: 'human' }, options: [{ id: 'approve', label: '승인' }, { id: 'deny', label: '거절' }], mirrorOf: r.cardMessageId } })],
    )).rows[0].id as string;
    const sweeper = createPermissionExpirySweeper(pool);
    await sweeper.sweep();
    // 시한 안의 요청은 건드리지 않는다.
    expect((await pool.query(`select status from permission_request where id = $1`, [r.requestId])).rows[0].status).toBe('pending');

    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [r.requestId]);
    await sweeper.sweep();
    expect((await pool.query(`select status from permission_request where id = $1`, [r.requestId])).rows[0].status).toBe('expired');
    const card = (await pool.query(`select meta from message where id = $1`, [r.cardMessageId])).rows[0].meta;
    expect(card.permissionRequest.status).toBe('expired');
    expect(card.ask).toMatchObject({ closedReason: 'expired' });
    expect(card.ask.closedAt).toBeTruthy();
    expect(card.ask.answeredWith).toBeUndefined();
    const mirror = (await pool.query(`select meta from message where id = $1`, [mirrorId])).rows[0].meta;
    expect(mirror.ask).toMatchObject({ closedReason: 'expired' });
    // 닫힌 뒤에도 결정은 받지 않는다 — 다시 청해야 한다.
    expect((await decide(alice.token, r.requestId, 'approve')).json().error.code).toBe('already_decided');
    expect(await toolAllowsFor(pool, agentId, ch)).toEqual([]);
  });

  // 만료 전환(132): 요청한 에이전트를 한 번 깨우고, 두 번째 스윕은 아무것도 하지 않는다. 감사도 한 줄.
  it('만료 스윕은 요청한 에이전트를 한 번만 깨우고(ask_closed), 다시 돌아도 아무것도 바꾸지 않는다', async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); origError(...a); };
    try {
      const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops get pods)', threadRootId: await root() });
      const mirrorId = (await pool.query(
        `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, '거울', 'user', $3) returning id`,
        [otherCh, admin.accountId, JSON.stringify({ kind: 'ask', ask: { to: { kind: 'human' }, options: [{ id: 'approve', label: '승인' }], mirrorOf: r.cardMessageId } })],
      )).rows[0].id as string;
      await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [r.requestId]);
      const wakes = async () => (await pool.query(
        `select count(*)::int as n from inbox where account_id = $1 and message_id = $2 and reason = 'ask_closed'`, [agentId, r.cardMessageId])).rows[0].n;
      const sweeper = createPermissionExpirySweeper(pool);
      await sweeper.sweep();
      expect(await wakes()).toBe(1);
      const card1 = (await pool.query(`select meta from message where id = $1`, [r.cardMessageId])).rows[0].meta;
      expect(card1).not.toBeNull();
      expect(card1.ask).toMatchObject({ closedReason: 'expired' });
      expect((await pool.query(`select meta from message where id = $1`, [mirrorId])).rows[0].meta.ask).toMatchObject({ closedReason: 'expired' });
      const audits = async () => (await pool.query(
        `select count(*)::int as n from audit_log where action = 'permission.expired' and detail->>'requestId' = $1`, [r.requestId])).rows[0].n;
      expect(await audits()).toBe(1);

      await sweeper.sweep();
      expect(await wakes()).toBe(1);
      expect(await audits()).toBe(1);
      expect((await pool.query(`select meta from message where id = $1`, [r.cardMessageId])).rows[0].meta).toEqual(card1);
      expect(errors.filter((e) => String((e as unknown[])[0]).includes('sweep error') || String((e as unknown[])[0]).includes('follow-up error'))).toEqual([]);
    } finally {
      console.error = origError;
    }
  });

  // 대체(132): 만료된 요청을 다시 내면 옛 요청이 새 요청을 가리킨다. 시한 안이면 지금처럼 같은 요청을 돌려준다.
  it('시한이 지난 같은 요청을 다시 내면 옛 요청은 superseded 로 새 요청에 이어지고 옛 카드는 대체로 닫힌다', async () => {
    const thread = await root();
    const rule = 'Bash(kubectl --context ops get deploy)';
    const first = await request({ kind: 'tool', rule, threadRootId: thread });
    // 시한 안 — 같은 요청을 돌려준다(대체 없음).
    const again = await request({ kind: 'tool', rule, threadRootId: thread });
    expect(again).toMatchObject({ requestId: first.requestId, pending: true });
    expect((await pool.query(`select superseded_by from permission_request where id = $1`, [first.requestId])).rows[0].superseded_by).toBeNull();

    // 시한이 지났지만 스윕 전(pending) → superseded.
    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [first.requestId]);
    const second = await request({ kind: 'tool', rule, threadRootId: thread });
    expect(second.requestId).not.toBe(first.requestId);
    const old = (await pool.query(`select status, superseded_by from permission_request where id = $1`, [first.requestId])).rows[0];
    expect(old).toEqual({ status: 'superseded', superseded_by: second.requestId });
    const oldCard = (await pool.query(`select meta from message where id = $1`, [first.cardMessageId])).rows[0].meta;
    expect(oldCard.ask).toMatchObject({ closedReason: 'superseded', supersededBy: second.cardMessageId });
    expect(oldCard.permissionRequest).toMatchObject({ status: 'superseded', supersededBy: second.requestId });
    expect((await decide(alice.token, first.requestId, 'approve')).json().error.code).toBe('superseded');
    // 대체는 깨우지 않는다 — 에이전트가 방금 다시 청했다. 스윕도 그 줄을 건드리지 않는다.
    await createPermissionExpirySweeper(pool).sweep();
    expect((await pool.query(`select count(*)::int as n from inbox where account_id = $1 and message_id = $2`, [agentId, first.cardMessageId])).rows[0].n).toBe(0);

    // 이미 expired 로 닫힌 요청 → 상태는 두고 superseded_by 만 잇는다.
    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [second.requestId]);
    await createPermissionExpirySweeper(pool).sweep();
    const third = await request({ kind: 'tool', rule, threadRootId: thread });
    expect((await pool.query(`select status, superseded_by from permission_request where id = $1`, [second.requestId])).rows[0])
      .toEqual({ status: 'expired', superseded_by: third.requestId });
    expect((await pool.query(`select meta from message where id = $1`, [second.cardMessageId])).rows[0].meta.ask).toMatchObject({ closedReason: 'expired' });
    // 이미 이어진 줄은 다시 잇지 않는다.
    expect((await pool.query(`select superseded_by from permission_request where id = $1`, [first.requestId])).rows[0].superseded_by).toBe(second.requestId);
  });

  it('스윕 전에 만료된 카드를 누르면 그 자리에서 카드가 닫힌다', async () => {
    const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops get svc)', threadRootId: await root() });
    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [r.requestId]);
    const res = await app.inject({
      method: 'POST', url: `/channels/${ch}/messages/${r.cardMessageId}/ask-answer`, headers: auth(alice.token), payload: { optionId: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    const card = (await pool.query(`select meta from message where id = $1`, [r.cardMessageId])).rows[0].meta;
    expect(card.ask).toMatchObject({ closedReason: 'expired' });
    expect(card.permissionRequest.status).toBe('expired');
  });

  it('머지(kind=merge)도 같은 카드로 받고, 승인하면 그 저장소 grant 가 생긴다', async () => {
    const r = await request({ kind: 'merge', repo: 'Acme-Org/infra-k8s', threadRootId: await root() });
    expect(r.error).toBeUndefined();
    const meta = (await pool.query(`select meta from message where id = $1`, [r.cardMessageId])).rows[0].meta;
    expect(meta.permissionRequest).toMatchObject({ kind: 'merge', target: 'acme-org/infra-k8s', channelId: null });
    expect(await mergeGrantFor(pool, agentId, 'acme-org/infra-k8s')).toBeNull();
    expect((await decide(alice.token, r.requestId, 'approve')).statusCode).toBe(200);
    expect(await mergeGrantFor(pool, agentId, 'acme-org/infra-k8s')).toMatchObject({ grantedBy: alice.accountId, allowAgentCause: false });
  });

  describe('설정 화면에서 직접 주기(tool.allow)', () => {
    const put = (token: string, scope: string, extra: Record<string, unknown> = {}) =>
      app.inject({ method: 'PUT', url: `/accounts/${agentId}/grants`, headers: auth(token), payload: { capability: 'tool.allow', scope, ...extra } });

    it('소유자 세션은 정규형 규칙을 기한 없이도 준다', async () => {
      const res = await put(alice.token, `tool:${ch}:Bash(kubectl --context ops get:*)`);
      expect(res.statusCode).toBe(200);
      expect(await toolAllowsFor(pool, agentId, ch)).toContain('Bash(kubectl --context ops get:*)');
    });

    it('넓은 규칙·정규형이 아닌 규칙·채널 없는 scope 는 400', async () => {
      expect((await put(alice.token, `tool:${ch}:Bash(*)`)).statusCode).toBe(400);
      expect((await put(alice.token, `tool:${ch}:Bash( kubectl  --context ops get:*)`)).statusCode).toBe(400);
      expect((await put(alice.token, 'Bash(kubectl --context ops get:*)')).statusCode).toBe(400);
      expect((await put(alice.token, '')).statusCode).toBe(400);
    });

    it('소유자가 아니면 admin 이라도 403, 에이전트 PAT 도 403', async () => {
      expect((await put(admin.token, `tool:${ch}:Bash(kubectl --context ops describe:*)`)).statusCode).toBe(403);
      expect((await put(bob.token, `tool:${ch}:Bash(kubectl --context ops describe:*)`)).statusCode).toBe(403);
      expect((await put(agentPat, `tool:${ch}:Bash(kubectl --context ops describe:*)`)).statusCode).toBe(403);
    });

    it('tool: scope 는 다른 capability 에 못 쓴다', async () => {
      const res = await app.inject({ method: 'PUT', url: `/accounts/${bob.accountId}/grants`, headers: auth(admin.token), payload: { capability: 'channel.create', scope: `tool:${ch}:Bash(x y)` } });
      expect(res.statusCode).toBe(400);
    });
  });

  // P3: 권한 카드의 거울 — 본문은 서버가 원본 요청으로 쓰고, 거울에서 누르면 원본 요청이 정해진다.
  describe('권한 카드의 거울(P3)', () => {
    const mirrorOf = async (cardId: string, channelId = ch) => text(await client.callTool({
      name: 'message.ask',
      arguments: { channelId, body: '그냥 눌러 주세요 — 아무 일 없음', options: [{ id: 'approve_new_mandate', label: '좋아요' }, { id: 'deny', label: '싫어요' }], mirrorOf: cardId },
    }));
    const answer = (token: string, channelId: string, messageId: string, optionId: string) =>
      app.inject({ method: 'POST', url: `/channels/${channelId}/messages/${messageId}/ask-answer`, headers: auth(token), payload: { optionId } });

    it('거울 본문·선택지는 원본 요청에서 서버가 다시 쓴다', async () => {
      const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops -n sitebot logs:*)', threadRootId: await root() });
      const m = await mirrorOf(r.cardMessageId, otherCh);
      expect(m.error).toBeUndefined();
      const row = (await pool.query(`select body, meta from message where id = $1`, [m.message.id])).rows[0];
      // r2: 줄 있는 카드의 거울 본문도 머리 + 이유뿐 — 대상은 meta 의 줄 상자(permissionMirror.line)가 그린다.
      expect(row.body).not.toContain('승인하면 7일');
      expect(row.meta.permissionMirror.line).toMatchObject({ scope: 'Bash(kubectl --context ops -n sitebot logs:*)' });
      expect(row.body).not.toContain('아무 일 없음');
      expect(row.meta.ask.options).toEqual([{ id: 'approve_new_mandate', label: '이 스레드로 위임장 만들고 더하기' }, { id: 'deny', label: '거절' }]);
      expect(row.meta.permissionRequest).toBeUndefined();
      // 정할 사람(표시용)은 서버가 원본 요청 행의 에이전트 소유자로 채운다 — 위임장 칩이 없어도 소유자에게 버튼이 선다.
      expect(row.meta.permissionMirror).toMatchObject({ rootId: r.cardMessageId, ownerAccountId: alice.accountId });
    });

    it('소유자가 거울에서 승인하면 원본 요청이 열리고 거울은 따라 닫힌다 — 에이전트는 한 번 깨어난다', async () => {
      const rule = 'Bash(kubectl --context ops -n sitebot top:*)';
      const r = await request({ kind: 'tool', rule, threadRootId: await root() });
      const m = await mirrorOf(r.cardMessageId, otherCh);
      expect((await answer(bob.token, otherCh, m.message.id, 'approve')).statusCode).toBe(403);
      const res = await answer(alice.token, otherCh, m.message.id, 'approve');
      expect(res.statusCode).toBe(200);
      expect(res.json().meta.ask).toMatchObject({ answeredWith: 'approve_new_mandate', answeredBy: alice.accountId, mirrorOf: r.cardMessageId });
      expect((await pool.query(`select status from permission_request where id = $1`, [r.requestId])).rows[0].status).toBe('granted');
      expect(await toolAllowsFor(pool, agentId, ch)).toContain(rule);
      const wakes = (await pool.query(
        `select count(*)::int as n from inbox where account_id = $1 and message_id = $2 and reason = 'ask_answered'`, [agentId, r.cardMessageId])).rows[0].n;
      expect(wakes).toBe(1);
      // 다시 누르면 이미 정해졌다.
      expect((await answer(alice.token, otherCh, m.message.id, 'deny')).statusCode).toBe(409);
    });

    it('만료된 원본은 거울에서도 409 request_expired', async () => {
      const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops -n sitebot get events)', threadRootId: await root() });
      const m = await mirrorOf(r.cardMessageId, otherCh);
      await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [r.requestId]);
      const res = await answer(alice.token, otherCh, m.message.id, 'approve');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('request_expired');
    });

    it('사람이 직접 세운 가짜 거울로는 정하지 않는다(403)', async () => {
      const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops -n sitebot get svc)', threadRootId: await root() });
      const fake = (await pool.query(
        `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, '거울', 'user', $3) returning id`,
        [otherCh, admin.accountId, JSON.stringify({ kind: 'ask', ask: { to: { kind: 'human' }, options: [{ id: 'approve', label: '승인' }, { id: 'deny', label: '거절' }], mirrorOf: r.cardMessageId } })],
      )).rows[0].id as string;
      expect((await answer(alice.token, otherCh, fake, 'approve')).statusCode).toBe(403);
      expect((await pool.query(`select status from permission_request where id = $1`, [r.requestId])).rows[0].status).toBe('pending');
    });
  });
});

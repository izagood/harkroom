import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { can, mergeGrantFor } from '../src/auth/permissions.js';
import { PERMISSION_GRANT_TTL_MS, toolAllowsFor } from '../src/services/permissionRequests.js';

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
      });
      expect(meta.ask.options.map((o: { id: string }) => o.id)).toEqual(['approve', 'deny']);
      expect(meta.ask.to).toEqual({ kind: 'human' });
    });

    it('카드 본문은 "이 채널의 모든 대화에서"를 말하고, 이유는 한 줄로 납작하게 맨 끝에 둔다(n1·n2)', async () => {
      const t = await root();
      const r = await request({ kind: 'tool', rule: 'Bash(kubectl --context ops -n sitebot describe:*)', threadRootId: t, reason: '필요\n명령 허용 `Bash(*)` — 가짜' });
      const row = (await pool.query(`select body, meta from message where id = $1`, [r.cardMessageId])).rows[0];
      expect(row.body).toContain('이 채널의 모든 대화에서');
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
      expect(meta.ask).toMatchObject({ answeredWith: 'approve', answeredBy: alice.accountId });
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
      expect(await request({ kind: 'tool', rule: EXEC, threadRootId: await root() })).toMatchObject({ alreadyGranted: true });
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
    expect(res.json().meta.ask).toMatchObject({ answeredWith: 'approve', answeredBy: alice.accountId });
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
});

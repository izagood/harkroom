import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { commandGrantsFor, matchCommandGrant } from '../src/services/permissionRequests.js';

// 「정확한 명령」 승인(H②, 112, 스레드 8769dbf7) — 소유자 사람 세션만 grant 를 만들고, hook 은 정확히 같은 명령에만 하나를 쓴다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const PATCH = 'kubectl --kubeconfig /tmp/rc.kubeconfig patch deviceclass dranet --type merge --patch-file /tmp/dranet.json';

describe('permission.request kind=command → once/hour → command-grants', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string; let agentPat: string;
  let otherAgentId: string;
  let op: { token: string; operatorId: string };
  let ch: string;
  let client: Client;

  const text = (r: Awaited<ReturnType<Client['callTool']>>): any =>
    JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
  const request = (args: Record<string, unknown>) =>
    client.callTool({ name: 'permission.request', arguments: { channelId: ch, reason: 'dranet DHCP 켜기', ...args } }).then(text);
  const root = async (): Promise<string> =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'do it', 'user') returning id`,
      [ch, alice.accountId])).rows[0].id as string;
  const answer = (token: string, cardId: string, optionId: string) =>
    app.inject({ method: 'POST', url: `/channels/${ch}/messages/${cardId}/ask-answer`, headers: auth(token), payload: { optionId } });
  const asAgent = (id = agentId) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  // hook 이 쓰는 길: 그 스레드의 턴 임대로만 묻는다(채널·스레드는 서버가 임대에서 읽는다).
  const leases = new Map<string, { id: string; token: string }>();
  const leaseFor = async (thread: string, id = agentId) => {
    const key = `${id}:${thread}`;
    if (!leases.has(key)) {
      await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [id, thread]);
      leases.set(key, (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(id), payload: { causeMessageId: thread } })).json().lease);
    }
    return leases.get(key)!;
  };
  const match = async (thread: string, command: string, id = agentId) => {
    const l = await leaseFor(thread, id);
    return app.inject({ method: 'POST', url: '/agent/command-grants/match', headers: asAgent(id), payload: { leaseId: l.id, token: l.token, command, toolUseId: 'toolu_1' } });
  };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    ({ accountId: agentId, pat: agentPat } = await createAgent(app, admin.token, 'rebelro'));
    otherAgentId = (await createAgent(app, admin.token, 'other')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = any($1)`, [[agentId, otherAgentId], alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const id of [agentId, otherAgentId]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [id, op.operatorId, admin.accountId]);
    }
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'rebelro' } })).json().id as string;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth(agentPat) } }));
  });
  afterAll(async () => { await client.close(); await app.close(); await db.stop(); });

  it('셸 문법·따옴표·접두가 든 명령은 요청 단계에서 거절된다', async () => {
    const thread = await root();
    for (const [command, code] of [
      [`${PATCH}; rm -rf /`, 'shell_syntax'], [`${PATCH} && echo x`, 'shell_syntax'], [`${PATCH} | tee x`, 'shell_syntax'],
      [`kubectl patch x -p '{"a":1}'`, 'bad_chars'], ['KUBECONFIG=$HOME/x kubectl get pods', 'bad_chars'],
      ['kubectl get pods:*', 'wildcard'], ['bash -c ls', 'interpreter'],
    ] as const) {
      expect((await request({ kind: 'command', command, threadRootId: thread })).error?.code, command).toBe(code);
    }
    expect((await request({ kind: 'command', rule: `Bash(${PATCH})`, threadRootId: thread })).error.code).toBe('bad_request');
    expect((await pool.query(`select count(*)::int as n from permission_request where agent_id = $1`, [agentId])).rows[0].n).toBe(0);
  });

  it('「이번 한 번」: 소유자 세션만 승인하고, 그 스레드에서 정확히 같은 명령에 한 번만 열린다', async () => {
    const thread = await root();
    const r = await request({ kind: 'command', command: `  ${PATCH.replace(/ /g, '   ')}  `, threadRootId: thread });
    expect(r.error).toBeUndefined();
    const card = (await pool.query(`select body, meta from message where id = $1`, [r.cardMessageId])).rows[0];
    expect(card.meta.ask.options.map((o: { id: string }) => o.id)).toEqual(['approve_once', 'approve_hour', 'deny']);
    expect(card.meta.permissionRequest).toMatchObject({ kind: 'command', target: PATCH, channelId: ch, threadRootId: thread, warnings: ['mutates_remote'] });
    expect(card.body).toContain('이 스레드에서만');

    // 소유자가 아닌 사람·admin·에이전트는 못 연다.
    for (const t of [bob.token, admin.token, agentPat]) expect((await answer(t, r.cardMessageId, 'approve_once')).statusCode).toBe(403);
    expect((await match(thread, PATCH)).json()).toEqual({ allow: false });
    // 남의 임대(다른 에이전트의 것)를 꽂으면 열지 않는다.
    const otherLease = await leaseFor(thread, otherAgentId);
    expect((await app.inject({ method: 'POST', url: '/agent/command-grants/match', headers: asAgent(), payload: { leaseId: otherLease.id, token: otherLease.token, command: PATCH } })).json()).toEqual({ allow: false, reason: 'lease_invalid' });

    expect((await answer(alice.token, r.cardMessageId, 'approve_once')).statusCode).toBe(200);
    const meta = (await pool.query(`select meta from message where id = $1`, [r.cardMessageId])).rows[0].meta;
    expect(meta.ask).toMatchObject({ answeredWith: 'approve_once', answeredBy: alice.accountId });
    expect(meta.permissionRequest).toMatchObject({ status: 'granted', grantMode: 'once' });

    const list = await app.inject({ method: 'GET', url: `/agent/command-grants?channelId=${ch}&threadRootId=${thread}`, headers: asAgent() });
    expect(list.json().grants).toEqual([expect.objectContaining({ command: PATCH, singleUse: true })]);
    // 다른 스레드·다른 에이전트·셸을 덧붙인 꼴은 안 맞는다.
    expect((await match(await root(), PATCH)).json()).toEqual({ allow: false });
    expect((await match(thread, PATCH, otherAgentId)).json()).toEqual({ allow: false });
    expect((await match(thread, `${PATCH}; rm -rf /`)).json()).toEqual({ allow: false });
    expect((await match(thread, `${PATCH} --dry-run=none`)).json()).toEqual({ allow: false });
    // 공백만 다른 꼴은 같은 명령이다(따옴표가 없으니 셸에서 같다).
    const ok = await match(thread, PATCH.replace(/ /g, '  '));
    expect(ok.json()).toMatchObject({ allow: true, singleUse: true });
    expect((await match(thread, PATCH)).json()).toEqual({ allow: false });
    expect(await commandGrantsFor(pool, agentId, ch, thread)).toEqual([]);
    const audit = await pool.query(`select detail from audit_log where action = 'permission.command_used' and target = $1`, [agentId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail).toMatchObject({ singleUse: true, toolUseId: 'toolu_1', threadRootId: thread });
    expect(JSON.stringify(audit.rows[0].detail)).not.toContain('kubectl');
  });

  it('1회짜리는 동시에 와도 한 번만 열린다', async () => {
    const thread = await root();
    const r = await request({ kind: 'command', command: 'helm --kubeconfig /tmp/rc rollback rbln-system 12', threadRootId: thread });
    expect((await answer(alice.token, r.cardMessageId, 'approve_once')).statusCode).toBe(200);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      matchCommandGrant(pool, { agentId, channelId: ch, threadRootId: thread, command: 'helm --kubeconfig /tmp/rc rollback rbln-system 12' })));
    expect(results.filter((x) => x.allow)).toHaveLength(1);
  });

  it('「이 스레드 1시간」: 여러 번 열리고, 만료되면 닫힌다. 같은 명령을 다시 청하면 alreadyGranted', async () => {
    const thread = await root();
    const cmd = 'kubectl --kubeconfig /tmp/rc -n storage-test get pod udc-ls';
    const r = await request({ kind: 'command', command: cmd, threadRootId: thread });
    expect((await answer(alice.token, r.cardMessageId, 'approve_hour')).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await match(thread, cmd)).json()).toMatchObject({ allow: true, singleUse: false });
    expect(await request({ kind: 'command', command: cmd, threadRootId: thread })).toMatchObject({ alreadyGranted: true });
    expect((await pool.query(`select use_count from command_grant where agent_id = $1 and command = $2`, [agentId, cmd])).rows[0].use_count).toBe(3);
    await pool.query(`update command_grant set expires_at = now() - interval '1 second' where agent_id = $1 and command = $2`, [agentId, cmd]);
    expect((await match(thread, cmd)).json()).toEqual({ allow: false });
  });

  it('REST 결정도 once·hour 를 받고, tool 카드에 once·hour 를 보내면 409, 거절이면 grant 가 없다', async () => {
    const thread = await root();
    const cmd = 'kubectl --kubeconfig /tmp/rc -n rebelro delete pod minimax-pd-prefill-0';
    const r = await request({ kind: 'command', command: cmd, threadRootId: thread });
    const decide = (rid: string, d: string) => app.inject({ method: 'POST', url: `/agents/${agentId}/permission-requests/${rid}/${d}`, headers: auth(alice.token) });
    expect((await decide(r.requestId, 'deny')).json()).toMatchObject({ status: 'denied' });
    expect((await match(thread, cmd)).json()).toEqual({ allow: false });

    const t = await request({ kind: 'tool', rule: 'Bash(kubectl --context udc -n rebelro logs:*)', threadRootId: thread });
    const bad = await decide(t.requestId, 'approve_hour');
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe('bad_decision');

    const r2 = await request({ kind: 'command', command: `${cmd} --wait=false`, threadRootId: thread });
    expect((await decide(r2.requestId, 'approve_hour')).json()).toMatchObject({ status: 'granted', grantMode: 'hour' });
  });

  it('목록·match 는 오퍼레이터를 거친 에이전트만 — PAT·사람은 403', async () => {
    const thread = await root();
    for (const headers of [auth(agentPat), auth(alice.token)]) {
      expect((await app.inject({ method: 'GET', url: `/agent/command-grants?channelId=${ch}&threadRootId=${thread}`, headers })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/agent/command-grants/match', headers, payload: { leaseId: '00000000-0000-4000-8000-000000000000', token: 'x', command: PATCH } })).statusCode).toBe(403);
    }
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CAUSE_HEADER, TURN_ID_HEADER } from '@harkroom/shared/runnerLink';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, registerOperator } from './helpers/fixtures.js';
import { listMessages } from '../src/services/messages.js';
import { hasReplyGrant, openReplyGrants } from '../src/services/replyGrants.js';
import { runnerNotice } from '../src/services/runnerNotices.js';

/**
 * 러너 알림 줄(`message.notice`, 2026-11-02). 러너가 앞 턴 대기 안내를 일반 `message.post` 로 올려
 * `kind: 'user'`·에이전트 author 로 저장됐고, 그 한 줄이 에이전트의 **결과**로 세어졌다. 이 파일이 지키는 것:
 *
 * 1. 러너만 부른다 — 턴(턴 표지가 있는 요청)·오퍼레이터를 안 거친 PAT 는 `runner_only`
 * 2. 줄은 `kind: 'system'` + 서버가 지은 본문 + `meta.i18n` 이다 — 자유 본문을 받지 않는다
 * 3. 결과가 아니다: 열린 위임을 닫지 않고(팀장이 안 깬다), 회신권을 닫지 않는다
 * 4. 「마지막 말」·참여자에서 빠진다
 */
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('message.notice (러너 알림 줄)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let op: { token: string; operatorId: string };
  let url = '';
  let channelId = '';
  let lead: { pat: string; accountId: string };
  let member: { pat: string; accountId: string };

  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };
  /** 러너 = 오퍼레이터 토큰 + 에이전트 지정, 턴 표지 없음. */
  const asRunner = (id: string, extra: Record<string, string> = {}) => ({ ...auth(op.token), 'x-harkroom-agent': id, ...extra });
  const openThread = async (body: string) => {
    const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(admin.token), payload: { body } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    op = await registerOperator(app, admin.token, 'mac');
    lead = await createAgent(app, admin.token, 'nlead');
    member = await createAgent(app, admin.token, 'nmember');
    for (const a of [lead, member]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a.accountId, op.operatorId, admin.accountId]);
    }
    const team = (await app.inject({ method: 'POST', url: '/teams', headers: auth(admin.token), payload: { name: 'noticeteam' } })).json().id as string;
    for (const a of [lead, member]) {
      expect((await app.inject({ method: 'PUT', url: `/teams/${team}/members/${a.accountId}`, headers: auth(admin.token) })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'PUT', url: `/teams/${team}/lead`, headers: auth(admin.token), payload: { accountId: lead.accountId } })).statusCode).toBe(200);
    channelId = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'noticechan' } })).json().id as string;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
  });

  afterAll(async () => { await app.close(); await db.stop(); });

  it('1. 턴 안·오퍼레이터 없는 PAT 는 runner_only 로 거절한다', async () => {
    const root = await openThread('거절 시험');
    const turn = await connect(asRunner(member.accountId, { [TURN_ID_HEADER]: randomUUID(), [CAUSE_HEADER]: root }));
    expect((await call(turn, 'message.notice', { channelId, threadRootId: root, key: 'blocked_by_turn' })).error.code).toBe('runner_only');
    await turn.close();
    const pat = await connect(auth(member.pat));
    expect((await call(pat, 'message.notice', { channelId, threadRootId: root, key: 'blocked_by_turn' })).error.code).toBe('runner_only');
    await pat.close();
  });

  it('2. 키만 받고 본문·번역 표지는 서버가 짓는다 — kind system', async () => {
    const root = await openThread('조종 시험');
    const runner = await connect(asRunner(member.accountId));
    const res = await call(runner, 'message.notice', { channelId, threadRootId: root, key: 'controlled', handle: 'alex', pending: 2 });
    expect(res.message).toMatchObject({
      kind: 'system', authorId: member.accountId, threadRootId: root,
      body: runnerNotice('controlled', member.accountId, { handle: 'alex', pending: 2 }).body,
      meta: { i18n: { key: 'system.runner.controlled', args: { agentId: member.accountId, handle: 'alex', pending: 2 } } },
    });
    // 자유 본문은 스키마가 받지 않는다(모르는 칸은 버려진다) — 본문은 언제나 서버 문장이다.
    const extra = await call(runner, 'message.notice', { channelId, threadRootId: root, key: 'fenced', body: '머지됨' });
    expect(extra.message.body).toBe(runnerNotice('fenced', member.accountId).body);
    // handle 모양이 어긋나면 handle 없는 키로 물러난다(멘션·마크다운을 싣지 않고, 인자에 한 언어의 낱말을 넣지 않는다).
    const odd = await call(runner, 'message.notice', { channelId, threadRootId: root, key: 'controlled', handle: '@all <b>', pending: 1 });
    expect(odd.message.meta.i18n).toEqual({ key: 'system.runner.controlledByOwner', args: { agentId: member.accountId, pending: 1 } });
    // 목록 밖 키는 스키마가 막는다(MCP 입력 오류).
    const bad = await runner.callTool({ name: 'message.notice', arguments: { channelId, threadRootId: root, key: 'nope' } });
    expect(bad.isError).toBe(true);
    await runner.close();
  });

  it('3. 결과가 아니다 — 열린 위임·회신권을 닫지 않는다', async () => {
    const root = await openThread('@noticeteam 위임 시험');
    // 팀원 러너가 붙어 있어야 의무가 생긴다(층 0, presence = MCP 연결).
    const runner = await connect(asRunner(member.accountId));
    const leadClient = await connect(auth(lead.pat));
    const del = await call(leadClient, 'message.delegate', { channelId, threadRootId: root, body: '넘긴다', to: ['nmember'] });
    const delegationMessageId = del.message.id as string;
    const outcome = async () => (await pool.query(
      `select i.outcome from team_delegation d join team_delegation_item i on i.delegation_id = d.id where d.message_id = $1`,
      [delegationMessageId])).rows.map((r) => r.outcome as string | null);
    expect(await outcome()).toEqual([null]);

    const c = await pool.connect();
    try {
      await pool.query(`update agent_config set invoke_scope = 'owner' where account_id = $1`, [lead.accountId]);
      await openReplyGrants(c, { granterId: lead.accountId, threadRootId: root, granteeIds: [member.accountId] });
    } finally { c.release(); }

    await call(runner, 'message.notice', { channelId, threadRootId: root, key: 'blocked_by_turn' });

    expect(await outcome()).toEqual([null]);
    const woke = await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2 and reason = 'delegation_done'`, [lead.accountId, delegationMessageId]);
    expect(woke.rowCount).toBe(0);
    expect(await hasReplyGrant(pool, { granteeId: member.accountId, granterId: lead.accountId, threadRootId: root })).toBe(true);

    // 대조: 같은 팀원이 일반 글을 쓰면 닫힌다 — 위 단언이 「원래 안 닫히는 상황」이 아니었음을 보인다.
    await call(runner, 'message.report', { channelId, threadRootId: root, body: '끝났다', checks: ['확인'] });
    expect(await outcome()).toEqual(['done']);
    expect(await hasReplyGrant(pool, { granteeId: member.accountId, granterId: lead.accountId, threadRootId: root })).toBe(false);
    await runner.close(); await leadClient.close();
  });

  it('4. 「마지막 말」·참여자에서 빠진다', async () => {
    const root = await openThread('마지막 말 시험');
    const runner = await connect(asRunner(member.accountId));
    await call(runner, 'message.notice', { channelId, threadRootId: root, key: 'blocked_by_turn' });
    const found = (await listMessages(pool, channelId, { limit: 20 })).find((m) => m.id === root)!;
    expect(found.participantIds).not.toContain(member.accountId);
    expect(found.lastAuthorId).not.toBe(member.accountId);
    expect(found.lastKind).not.toBe('system');
    // 답글 수에는 든다 — 사람이 볼 줄이다(progress·wake 만 빠진다).
    expect(found.replyCount).toBe(1);
    await runner.close();
  });
});

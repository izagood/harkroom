import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CAUSE_HEADER } from '@harkroom/shared/runnerLink';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { CAUSE_CHAIN_MAX_HOPS, causeChainRoot } from '../src/services/mergeGrants.js';
import { decidePermissionRequest, openPermissionRequest } from '../src/services/permissionRequests.js';
import { grantFromDenial } from '../src/services/mergeDenials.js';

// 머지 cause 를 위임 사슬로 넓히기(A안, 스레드 0e30c565) — security C1~C5·Q3 의 회귀선.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const SHA = 'b'.repeat(40);
const REPO = 'izagood/harkroom';

describe('merge cause chain (A안)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string; let tmPat: string;
  let sec: string;
  let stranger: string;
  let op: { token: string; operatorId: string };
  let ch: string;
  let n = 0;

  const asAgent = (id = tm) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  /** 메시지 하나를 바로 넣는다. `wake` 를 주면 그 계정에 inbox 를 만든다(그 글이 그 계정을 깨웠다). */
  const msg = async (author: string, o: {
    cause?: string | null; kind?: string; meta?: Record<string, unknown>; wake?: string; reason?: string; ageMs?: number; deleted?: boolean;
  } = {}): Promise<string> => {
    const at = new Date(Date.now() - (o.ageMs ?? 0));
    const id = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta, cause_message_id, created_at, deleted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [ch, author, `m${n++}`, o.kind ?? 'user', JSON.stringify(o.meta ?? {}), o.cause ?? null, at, o.deleted ? at : null])).rows[0].id as string;
    if (o.wake) await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, $3)`, [o.wake, id, o.reason ?? 'mention']);
    return id;
  };
  const lease = async (causeMessageId: string, agent = tm) =>
    (await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId } })).json().lease as { id: string; token: string };
  const check = (l: { id: string; token: string }, number = 7, agent = tm) =>
    app.inject({ method: 'POST', url: '/agent/merge-checks', headers: asAgent(agent), payload: { leaseId: l.id, token: l.token, repo: REPO, number, headSha: SHA } });
  const setGrant = async (agent: string, o: { allowAgentCause?: boolean } = {}) => {
    await pool.query(`delete from account_grant where account_id = $1 and capability = 'repo.merge'`, [agent]);
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause) values ($1, 'repo.merge', $2, $3, $4, $5)`,
      [agent, `repo:${REPO}`, alice.accountId, new Date(Date.now() + 7 * 86_400_000), o.allowAgentCause ?? false]);
  };
  /** 소유자 alice 의 글 → sec(같은 소유자) 의 위임 글 → tm 의 턴. */
  const ownerChain = async () => {
    const root = await msg(alice.accountId, { wake: sec });
    const hop = await msg(sec, { cause: root, wake: tm });
    return { root, hop };
  };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    ({ accountId: tm, pat: tmPat } = await createAgent(app, admin.token, 'tm'));
    sec = (await createAgent(app, admin.token, 'sec')).accountId;
    stranger = (await createAgent(app, admin.token, 'stranger')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = any($1::uuid[])`, [[tm, sec], alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [stranger, bob.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, sec, stranger]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'chain' } })).json().id as string;
  });
  afterAll(async () => { await app.close(); await db.stop(); });
  beforeEach(async () => { await setGrant(tm); });

  describe('사슬이 이어지면 통과한다', () => {
    it('소유자 글 → 같은 소유자 에이전트의 위임 → 이 턴: 통과, 감사 viaChain 에 뿌리와 고리', async () => {
      const { root, hop } = await ownerChain();
      const res = await check(await lease(hop));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ allowed: true, causeByHuman: true });
      const audit = (await pool.query(
        `select detail from audit_log where action = 'repo.merge.checked' and detail->'viaChain'->>'rootId' = $1`, [root])).rows[0]?.detail;
      expect(audit.viaChain).toEqual({ rootId: root, path: [hop, root] });
      expect(audit.causeByHuman).toBe(false);
    });

    it('wake 대기 줄도 고리다 — 소유자 글로 뜬 턴이 건 wake 로 깨어난 턴은 통과', async () => {
      const root = await msg(alice.accountId, { wake: tm });
      const wake = await msg(tm, { kind: 'wake', meta: { kind: 'wake' }, cause: root, wake: tm, reason: 'wake' });
      expect((await check(await lease(wake))).statusCode).toBe(200);
    });

    it('소유자가 같은 소유자 에이전트의 ask 에 직접 답했으면 그 ask 가 뿌리다', async () => {
      const ask = await msg(sec, { meta: { kind: 'ask', ask: { prompt: 'go?', options: [], answeredWith: 'yes', answeredBy: alice.accountId } }, wake: sec, reason: 'ask_answered' });
      const hop = await msg(sec, { cause: ask, wake: tm });
      expect((await check(await lease(hop))).statusCode).toBe(200);
    });

    it(`${CAUSE_CHAIN_MAX_HOPS}칸까지는 따라가고 그 너머는 끊는다`, async () => {
      const build = async (hops: number) => {
        let cur = await msg(alice.accountId);
        for (let i = 0; i < hops; i++) cur = await msg(sec, { cause: cur });
        return cur;
      };
      expect(await causeChainRoot(pool, { agentId: tm, causeMessageId: await build(CAUSE_CHAIN_MAX_HOPS), now: new Date() })).not.toBeNull();
      expect(await causeChainRoot(pool, { agentId: tm, causeMessageId: await build(CAUSE_CHAIN_MAX_HOPS + 1), now: new Date() })).toBeNull();
    });
  });

  describe('끊기면 지금처럼 cause_not_human 과 카드', () => {
    const denied = async (cause: string) => {
      const res = await check(await lease(cause));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('cause_not_human');
      expect(res.json().error.denialId).toEqual(expect.any(String));
    };
    it('뿌리가 소유자가 아닌 사람(bob)', async () => {
      const root = await msg(bob.accountId);
      await denied(await msg(sec, { cause: root, wake: tm }));
    });
    it('중간 고리가 다른 소유자의 에이전트', async () => {
      const root = await msg(alice.accountId);
      await denied(await msg(stranger, { cause: root, wake: tm }));
    });
    it('뿌리가 소유자 이름의 자동화 글(meta.automation)', async () => {
      const root = await msg(alice.accountId, { meta: { automation: { id: 'x' } } });
      await denied(await msg(sec, { cause: root, wake: tm }));
    });
    it('뿌리가 7일보다 오래됨', async () => {
      const root = await msg(alice.accountId, { ageMs: 8 * 86_400_000 });
      await denied(await msg(sec, { cause: root, wake: tm }));
    });
    it('중간 고리가 지워짐', async () => {
      const root = await msg(alice.accountId);
      const mid = await msg(sec, { cause: root, deleted: true });
      await denied(await msg(sec, { cause: mid, wake: tm }));
    });
    it('뿌리가 지워짐', async () => {
      const root = await msg(alice.accountId, { deleted: true });
      await denied(await msg(sec, { cause: root, wake: tm }));
    });
    it('고리가 없음(옛 글 — cause 가 null)', async () => {
      await denied(await msg(sec, { wake: tm }));
    });
    it('순환은 돌지 않고 끊긴다', async () => {
      const a = await msg(sec);
      const b = await msg(sec, { cause: a });
      await pool.query(`alter table message disable trigger message_cause_insert_only`);
      await pool.query(`update message set cause_message_id = $2 where id = $1`, [a, b]);
      await pool.query(`alter table message enable trigger message_cause_insert_only`);
      expect(await causeChainRoot(pool, { agentId: tm, causeMessageId: b, now: new Date() })).toBeNull();
    });
    it('C2: 소유자를 바꾸면 옛 사슬은 끊긴다(중간 고리의 소유자, 머지 에이전트의 소유자 둘 다)', async () => {
      const { hop } = await ownerChain();
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [sec, bob.accountId]);
      expect(await causeChainRoot(pool, { agentId: tm, causeMessageId: hop, now: new Date() })).toBeNull();
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [sec, alice.accountId]);
      expect(await causeChainRoot(pool, { agentId: tm, causeMessageId: hop, now: new Date() })).not.toBeNull();
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [tm, bob.accountId]);
      expect(await causeChainRoot(pool, { agentId: tm, causeMessageId: hop, now: new Date() })).toBeNull();
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [tm, alice.accountId]);
    });
    it('C2: 소유자 계정이 막혔으면 사슬은 없다', async () => {
      const { hop } = await ownerChain();
      await pool.query(`update account set disabled_at = now() where id = $1`, [alice.accountId]);
      expect(await causeChainRoot(pool, { agentId: tm, causeMessageId: hop, now: new Date() })).toBeNull();
      await pool.query(`update account set disabled_at = null where id = $1`, [alice.accountId]);
    });
    it('C3: 같은 소유자 에이전트의 ask 에 소유자가 아닌 사람이 답했으면 그 ask 의 cause 를 따라가지 않는다', async () => {
      const root = await msg(alice.accountId);
      const ask = await msg(sec, { cause: root, meta: { kind: 'ask', ask: { prompt: 'go?', options: [], answeredWith: 'yes', answeredBy: bob.accountId } }, wake: sec, reason: 'ask_answered' });
      await denied(await msg(sec, { cause: ask, wake: tm }));
    });
    it('C3: 거울(mirrorOf)·일괄 답(answeredVia) 은 소유자가 답했어도 뿌리가 아니다', async () => {
      for (const extra of [{ mirrorOf: '00000000-0000-4000-8000-000000000001' }, { answeredVia: 'bundle' }]) {
        const ask = await msg(sec, { meta: { kind: 'ask', ask: { prompt: 'go?', options: [], answeredWith: 'yes', answeredBy: alice.accountId, ...extra } } });
        await denied(await msg(sec, { cause: ask, wake: tm }));
      }
    });
  });

  describe('C4: 사슬은 유효한 grant + 직접 판정 실패일 때만', () => {
    it('grant 가 없으면 사슬이 이어져도 not_granted(카드 id 없음)', async () => {
      await pool.query(`delete from account_grant where account_id = $1 and capability = 'repo.merge'`, [tm]);
      const { hop } = await ownerChain();
      const res = await check(await lease(hop));
      expect(res.json().error).toEqual(expect.objectContaining({ code: 'not_granted' }));
      expect(res.json().error.denialId).toBeUndefined();
    });
    it('allow_agent_cause 갈래는 사슬을 보지 않는다 — 감사에 viaChain 이 없다', async () => {
      await setGrant(tm, { allowAgentCause: true });
      const hop = await msg(stranger, { wake: tm });
      const l = await lease(hop);
      expect((await check(l)).statusCode).toBe(200);
      const d = (await pool.query(`select detail from audit_log where action = 'repo.merge.checked' and detail->>'leaseId' = $1`, [l.id])).rows[0].detail;
      expect(d.viaChain).toBeUndefined();
    });
    it('사람이 직접 띄운 턴은 지금처럼 통과하고 viaChain 이 없다', async () => {
      const l = await lease(await msg(alice.accountId, { wake: tm }));
      expect((await check(l)).statusCode).toBe(200);
      const d = (await pool.query(`select detail from audit_log where action = 'repo.merge.checked' and detail->>'leaseId' = $1`, [l.id])).rows[0].detail;
      expect(d.viaChain).toBeUndefined();
    });
  });

  describe('C5: 머지 시스템 줄은 본문 고정, 뿌리는 meta 에만', () => {
    it('사슬로 통과한 머지의 「머지됨」 줄', async () => {
      const { root, hop } = await ownerChain();
      const l = await lease(hop);
      expect((await check(l, 21)).statusCode).toBe(200);
      const res = await app.inject({ method: 'POST', url: '/agent/merge-results', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo: REPO, number: 21, headSha: SHA, result: 'merged', mergeSha: 'c'.repeat(40) } });
      expect(res.statusCode).toBe(201);
      const line = (await pool.query(`select body, meta from message where id = $1`, [res.json().messageId])).rows[0];
      expect(line.body).not.toContain(root);
      expect(line.body).not.toContain('harkroom://');
      expect(line.meta.merge.chainRootId).toBe(root);
    });
  });

  describe('C1: cause_message_id 는 오퍼레이터 경유·insert 때만', () => {
    let url = '';
    const connect = async (headers: Record<string, string>) => {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
      return client;
    };
    const post = async (headers: Record<string, string>, body: string) => {
      const client = await connect(headers);
      try {
        const r = await client.callTool({ name: 'message.post', arguments: { channelId: ch, body } });
        return JSON.parse((r.content as { text: string }[])[0]!.text).message.id as string;
      } finally { await client.close(); }
    };
    const causeOf = async (id: string) => (await pool.query(`select cause_message_id as c from message where id = $1`, [id])).rows[0].c as string | null;
    beforeAll(async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
    });

    it('오퍼레이터를 거친 발화는 자기를 깨운 cause 를 저장한다', async () => {
      const cause = await msg(alice.accountId, { wake: tm });
      const id = await post({ ...asAgent(), [CAUSE_HEADER]: cause }, 'ok');
      expect(await causeOf(id)).toBe(cause);
    });
    it('PAT 경로로 온 헤더는 저장하지 않는다', async () => {
      const cause = await msg(alice.accountId, { wake: tm });
      const id = await post({ ...auth(tmPat), [CAUSE_HEADER]: cause }, 'pat');
      expect(await causeOf(id)).toBeNull();
    });
    it('자기를 깨우지 않은 소유자 글 id 를 헤더에 넣어도 저장하지 않는다', async () => {
      const notMine = await msg(alice.accountId, { wake: sec });
      const id = await post({ ...asAgent(), [CAUSE_HEADER]: notMine }, 'forged');
      expect(await causeOf(id)).toBeNull();
    });
    it('turn.wake 대기 줄도 오퍼레이터 경유면 cause 를 저장한다', async () => {
      const cause = await msg(alice.accountId, { wake: tm });
      const client = await connect({ ...asAgent(), [CAUSE_HEADER]: cause });
      try {
        const head = await msg(alice.accountId);
        const r = await client.callTool({ name: 'turn.wake', arguments: { channelId: ch, threadRootId: head, notBeforeSec: 60, reason: 'wait CI' } });
        const out = JSON.parse((r.content as { text: string }[])[0]!.text);
        expect(await causeOf(out.message.id)).toBe(cause);
      } finally { await client.close(); }
    });
    it('저장된 cause 는 갱신(고치기 포함)으로 바꿀 수 없다 — null 에서 값으로도', async () => {
      const cause = await msg(alice.accountId, { wake: tm });
      const id = await post({ ...asAgent(), [CAUSE_HEADER]: cause }, 'fixed');
      const other = await msg(alice.accountId);
      await expect(pool.query(`update message set cause_message_id = $2 where id = $1`, [id, other])).rejects.toThrow(/insert/);
      const bare = await msg(sec);
      await expect(pool.query(`update message set cause_message_id = $2 where id = $1`, [bare, other])).rejects.toThrow(/insert/);
      const edit = await app.inject({ method: 'PATCH', url: `/channels/${ch}/messages/${id}`, headers: asAgent(), payload: { body: 'edited' } });
      expect(edit.statusCode).toBeLessThan(500);
      expect(await causeOf(id)).toBe(cause);
    });
  });

  describe('Q3: PR 이 머지·닫히면 기다리는 머지 카드를 닫는다', () => {
    /** tm 이 PR 에서 cause_not_human 으로 막혀 카드(권한 요청)를 세운 상태. */
    const card = async (number: number, agent = tm) => {
      const cause = await msg(sec, { wake: agent });
      const l = await lease(cause, agent);
      const res = await check(l, number, agent);
      const denialId = res.json().error.denialId as string;
      const opened = await openPermissionRequest(pool, {
        agentId: agent, kind: 'merge', repo: REPO, reason: 'merge', channelId: ch, threadRootId: cause,
        denial: { id: denialId, number, headSha: SHA, reason: 'cause_not_human' },
      });
      if (!opened.ok || !('created' in opened) || !opened.created) throw new Error('no card');
      const cardId = await msg(agent, { meta: { kind: 'ask', ask: { prompt: 'merge?', options: [{ id: 'approve', label: 'ok' }] }, permissionRequest: opened.created.meta } });
      await pool.query(`update permission_request set card_message_id = $2 where id = $1`, [opened.created.requestId, cardId]);
      await pool.query(`update merge_denial set card_message_id = $2 where id = $1`, [denialId, cardId]);
      return { requestId: opened.created.requestId, denialId, cardId, thread: cause };
    };
    const statusOf = async (requestId: string) => (await pool.query(`select status from permission_request where id = $1`, [requestId])).rows[0].status as string;

    it('Q3-a: 통과한 판정 뒤의 merged 보고는 모든 에이전트의 그 PR 카드를 닫고, 닫힌 카드는 결정·7일 허락에 409', async () => {
      await setGrant(sec);
      const mine = await card(31);
      const theirs = await card(31, sec);
      const other = await card(32);
      const l = await lease(await msg(alice.accountId, { wake: tm }));
      expect((await check(l, 31)).statusCode).toBe(200);
      const res = await app.inject({ method: 'POST', url: '/agent/merge-results', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo: REPO, number: 31, headSha: SHA, result: 'merged' } });
      expect(res.statusCode).toBe(201);
      expect(await statusOf(mine.requestId)).toBe('obsolete');
      expect(await statusOf(theirs.requestId)).toBe('obsolete');
      expect(await statusOf(other.requestId)).toBe('pending');
      const meta = (await pool.query(`select meta from message where id = $1`, [mine.cardId])).rows[0].meta;
      expect(meta.permissionRequest).toMatchObject({ status: 'obsolete', obsoleteReason: 'merged' });
      expect(meta.ask.closedAt).toEqual(expect.any(String));
      const once = await decidePermissionRequest(pool, { agentId: tm, requestId: mine.requestId, actorId: alice.accountId, decision: 'approve_once', once: { ghUser: 'izagood', relaxChecks: false, number: 31, headSha: SHA } });
      expect(once).toMatchObject({ ok: false, status: 409, code: 'pr_closed' });
      const approve = await decidePermissionRequest(pool, { agentId: tm, requestId: mine.requestId, actorId: alice.accountId, decision: 'approve' });
      expect(approve).toMatchObject({ ok: false, status: 409, code: 'pr_closed' });
      expect(await grantFromDenial(pool, { agentId: tm, denialId: mine.denialId, actorId: alice.accountId })).toMatchObject({ ok: false, status: 409, code: 'pr_closed' });
      const ans = await app.inject({ method: 'POST', url: `/channels/${ch}/messages/${mine.cardId}/ask-answer`, headers: auth(alice.token), payload: { optionId: 'approve' } });
      expect(ans.statusCode).toBeGreaterThanOrEqual(400);
      expect((await pool.query(`select count(*)::int as n from audit_log where action = 'repo.merge.obsoleted' and detail->>'source' = 'merge_result'`)).rows[0].n).toBe(1);
    });

    it('Q3-c: 닫힌 거절 기록은 다시 쓰지 않는다 — 같은 스레드에서 다시 막히면 새 기록·새 카드', async () => {
      const c = await card(41);
      const l = await lease(await msg(alice.accountId, { wake: tm }));
      expect((await check(l, 41)).statusCode).toBe(200);
      await app.inject({ method: 'POST', url: '/agent/merge-results', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo: REPO, number: 41, headSha: SHA, result: 'merged' } });
      const again = await msg(sec, { wake: tm });
      await pool.query(`update message set thread_root_id = $2 where id = $1`, [again, c.thread]);
      const res = await check(await lease(again), 41);
      expect(res.json().error.denialId).not.toBe(c.denialId);
    });

    it('Q3-b: closed 보고는 그 에이전트 자신의 카드만 닫고, 카드가 없으면 409 no_card, 머지됨 줄·merged 감사는 없다', async () => {
      await setGrant(sec);
      const mine = await card(51);
      const theirs = await card(51, sec);
      const l = await lease(await msg(sec, { wake: tm }));
      const closed = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/agent/merge-closed', headers: asAgent(), payload: { leaseId: l.id, token: l.token, repo: REPO, ...payload } });
      expect((await closed({ number: 52, state: 'CLOSED' })).json().error.code).toBe('no_card');
      const res = await closed({ number: 51, state: 'MERGED' });
      expect(res.statusCode).toBe(200);
      expect(await statusOf(mine.requestId)).toBe('obsolete');
      expect(await statusOf(theirs.requestId)).toBe('pending');
      expect((await pool.query(`select count(*)::int as n from audit_log where action = 'repo.merge.merged' and (detail->>'number')::int = 51`)).rows[0].n).toBe(0);
      const audit = (await pool.query(`select detail from audit_log where action = 'repo.merge.obsoleted' and (detail->>'number')::int = 51`)).rows[0].detail;
      expect(audit).toMatchObject({ source: 'wrapper_report', onlyAgentId: tm, reportedState: 'MERGED' });
      // 사람 세션·PAT 는 이 길을 못 쓴다
      expect((await app.inject({ method: 'POST', url: '/agent/merge-closed', headers: auth(tmPat), payload: { leaseId: l.id, token: l.token, repo: REPO, number: 51, state: 'CLOSED' } })).statusCode).toBe(403);
    });
  });
});

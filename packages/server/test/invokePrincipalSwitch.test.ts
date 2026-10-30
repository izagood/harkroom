import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { editMessage, postMessage } from '../src/services/messages.js';
import { PRINCIPAL_INVOKE_DAILY_CAP } from '../src/services/invokePrincipal.js';

// 에이전트 호출 권한 재설계 3단계 — 에이전트 글의 막힌 멘션은 `기존 규칙 OR mayInvoke(대상, principal)` 로 열린다(기본 켜짐).
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('invoke principal switch (3단계)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string; let sec: string; let zed: string; let chn: string;
  let op: { token: string; operatorId: string };
  let ch: string; let ch2: string;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const post = async (authorId: string, body: string, o: { threadRootId?: string; chainCause?: string; channelId?: string; meta?: Record<string, unknown> } = {}) => {
    const r = await postMessage(pool, {
      channelId: o.channelId ?? ch, authorId, body, threadRootId: o.threadRootId ?? null, chainCause: o.chainCause ?? null,
      authVia: 'session', ...(o.meta ? { meta: o.meta } : {}),
    });
    if (r.failure) throw new Error(String(r.failure));
    return r.message.id as string;
  };
  const lease = async (causeMessageId: string, agent: string) => {
    const res = await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId } });
    expect(res.statusCode).toBe(200);
  };
  const metaOf = async (id: string) =>
    (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta as Record<string, unknown> | null;
  const inboxCount = async (accountId: string, messageId: string) =>
    Number((await pool.query(`select count(*) from inbox where account_id = $1 and message_id = $2`, [accountId, messageId])).rows[0].count);
  /** tm 이 `cause` 로 깬 턴에서 `@sec @zed` 를 부른다. */
  const hop = async (cause: string, threadRootId: string) => post(tm, '@sec @zed review', { threadRootId, chainCause: cause });

  beforeAll(async () => {
    delete process.env.HARKROOM_PRINCIPAL_INVOKE; // 기본값(켜짐)으로 잰다.
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    sec = (await createAgent(app, admin.token, 'sec')).accountId;
    zed = (await createAgent(app, admin.token, 'zed')).accountId;
    chn = (await createAgent(app, admin.token, 'chn')).accountId;
    // tm 은 누구나(community) · sec 는 alice 만(owner) · zed 는 admin 만(owner) · chn 은 그 채널 멤버만(channel).
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'community' where account_id = $1`, [tm, alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [sec, alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [zed, admin.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'channel' where account_id = $1`, [chn, admin.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, sec, zed, chn]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    const mk = async (name: string) => (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name } })).json().id as string;
    ch = await mk('switch'); ch2 = await mk('switch-side');
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [ch, [alice.accountId, tm, sec, zed, chn]]);
    // bob 은 ch 의 멤버가 아니다 — ch2 에서만 tm 을 부른다.
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [ch2, [bob.accountId, tm]]);
    await pool.query(`delete from channel_member where channel_id = $1 and account_id = $2`, [ch, bob.accountId]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('alice 가 깨운 턴 — sec 는 alice 권한으로 열리고 zed 는 그대로 막힌다', async () => {
    const root = await post(alice.accountId, '@tm go');
    await lease(root, tm);
    const m = await hop(root, root);
    const meta = await metaOf(m);
    expect(meta?.invokedAsPrincipal).toEqual({ principalId: alice.accountId, handles: ['sec'], ids: [sec] });
    expect(meta?.mentionDenied).toEqual(['zed']);
    expect(meta?.mentionDeniedPrincipal).toBe('denied');
    expect(meta?.mentionPrincipalShadow).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain('causeReasons');
    expect(await inboxCount(sec, m)).toBe(1);
    expect(await inboxCount(zed, m)).toBe(0);
  });

  it('T2 세탁 경로 — bob 이 깨운 턴은 sec 도 막힌다', async () => {
    const root = await post(bob.accountId, '@tm go', { channelId: ch2 });
    await lease(root, tm);
    const m = await post(tm, '@sec @zed review', { chainCause: root });
    const meta = await metaOf(m);
    expect(meta?.mentionDenied).toEqual(['sec', 'zed']);
    expect(meta?.mentionDeniedPrincipal).toBe('denied');
    expect(meta?.invokedAsPrincipal).toBeUndefined();
    expect(await inboxCount(sec, m)).toBe(0);
  });

  it('기존 규칙이 먼저다 — 에이전트 자신이 부를 수 있으면 principal 권한을 쓰지 않는다(표시도 없음)', async () => {
    const root = await post(bob.accountId, '@tm side', { channelId: ch2 });
    await lease(root, tm);
    // chn 은 channel 범위 — tm 자신이 ch 멤버라 지금 규칙으로 지나간다. bob(ch 멤버 아님)의 권한은 쓰이지 않는다.
    const m = await post(tm, '@chn look', { chainCause: root });
    const meta = await metaOf(m);
    expect(meta?.mentionDenied).toBeUndefined();
    expect(meta?.invokedAsPrincipal).toBeUndefined();
    expect(await inboxCount(chn, m)).toBe(1);
  });

  it('T3 편승 — alice 의 스레드에 답글을 쓴 사람의 권한만 쓴다', async () => {
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [ch, bob.accountId]);
    try {
      const root = await post(alice.accountId, '@tm start');
      await lease(root, tm);
      const reply = await post(bob.accountId, '@tm more', { threadRootId: root });
      await lease(reply, tm);
      const m = await hop(reply, root);
      expect((await metaOf(m))?.invokedAsPrincipal).toBeUndefined();
      expect(await inboxCount(sec, m)).toBe(0);
    } finally {
      await pool.query(`delete from channel_member where channel_id = $1 and account_id = $2`, [ch, bob.accountId]);
    }
  });

  it('임대 없음·wake·거울 카드·자동화 — 사람 없는 턴으로 막힌다(none)', async () => {
    const noLease = await post(alice.accountId, '@tm no lease');
    const cases: string[] = [noLease];

    const wakeRoot = await post(alice.accountId, '@tm wake');
    await lease(wakeRoot, tm);
    const own = await post(tm, 'later', { threadRootId: wakeRoot, chainCause: wakeRoot });
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake')`, [tm, own]);
    await lease(own, tm);
    cases.push(own);

    const card = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, 'card', 'user', $3) returning id`,
      [ch, tm, JSON.stringify({ ask: { answeredBy: alice.accountId, mirrorOf: tm } })])).rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [tm, card]);
    await lease(card, tm);
    cases.push(card);

    const auto = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, '@tm auto', 'user', $3) returning id`,
      [ch, alice.accountId, JSON.stringify({ automation: { id: 'a1' } })])).rows[0].id as string;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [tm, auto]);
    await lease(auto, tm);
    cases.push(auto);

    for (const cause of cases) {
      const m = await hop(cause, cause === own ? wakeRoot : cause);
      const meta = await metaOf(m);
      expect(meta?.mentionDenied).toEqual(['sec', 'zed']);
      expect(meta?.mentionDeniedPrincipal).toBe('none');
      expect(await inboxCount(sec, m)).toBe(0);
    }
  });

  it('C4 — 에이전트 글의 수정은 부르지 않고 principal 권한도 빌리지 않는다', async () => {
    const root = await post(alice.accountId, '@tm edit');
    await lease(root, tm);
    const own = await post(tm, 'plain', { threadRootId: root, chainCause: root });
    const r = await editMessage(pool, { channelId: ch, messageId: own, actorId: tm, body: '@sec now' });
    expect(typeof r).toBe('object');
    expect((await metaOf(own))?.invokedAsPrincipal).toBeUndefined();
    expect(await inboxCount(sec, own)).toBe(0);
  });

  it('n2 — 글쓴이가 넣은 서버 부름 meta 는 걷어 낸다', async () => {
    const forged = {
      invokedAsPrincipal: { principalId: admin.accountId, handles: ['zed'], ids: [zed] },
      mentionDenied: ['zed'], mentionDeniedPrincipal: 'none', mentionPrincipalShadow: { principalId: admin.accountId },
      mentionChainCapped: ['zed'], mentionChainLimit: 1, mentionChainReason: 'age', keep: 1,
    };
    const human = await metaOf(await post(alice.accountId, 'hello', { meta: forged }));
    expect(human).toEqual({ keep: 1 });
    const root = await post(alice.accountId, '@tm forge');
    await lease(root, tm);
    const agent = await metaOf(await post(tm, 'nothing to call', { threadRootId: root, chainCause: root, meta: forged }));
    for (const k of Object.keys(forged).filter((k) => k !== 'keep')) expect(agent?.[k]).toBeUndefined();
  });

  it('하루 상한 — principal 하나가 빌려 준 글이 상한에 닿으면 막힌다(capped)', async () => {
    await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta, principal_account_id)
       select $1, $2, 'x', 'user', '{"invokedAsPrincipal":{}}'::jsonb, $3 from generate_series(1, $4::int)`,
      [ch, tm, alice.accountId, PRINCIPAL_INVOKE_DAILY_CAP]);
    const root = await post(alice.accountId, '@tm cap');
    await lease(root, tm);
    const m = await hop(root, root);
    const meta = await metaOf(m);
    expect(meta?.mentionDenied).toEqual(['sec', 'zed']);
    expect(meta?.mentionDeniedPrincipal).toBe('capped');
    expect(await inboxCount(sec, m)).toBe(0);
  });
});

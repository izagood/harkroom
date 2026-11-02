import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { listInbox, postMessage } from '../src/services/messages.js';

// 위임장의 시작 스레드를 inbox 항목에 싣는다(`InboxEntry.startedIn`, 2026-11-02). 동료의 보고로 깬 턴이 사람에게 갈 보고를
// 앵커 밖 채널 최상위에 올린 사건(#task 루트 글)의 짝이다.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('inbox startedIn (mandate start thread)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let tm: string; let sec: string; let stranger: string;
  let op: { token: string; operatorId: string };
  let task: string; let cmdb: string;

  const asAgent = (id: string) => ({ ...auth(op.token), 'x-harkroom-agent': id });
  const post = async (channelId: string, authorId: string, body: string, o: { threadRootId?: string; chainCause?: string } = {}) => {
    const r = await postMessage(pool, { channelId, authorId, body, threadRootId: o.threadRootId ?? null, chainCause: o.chainCause ?? null, authVia: 'session' });
    if (r.failure) throw new Error(String(r.failure));
    return r.message.id as string;
  };
  const lease = async (causeMessageId: string, agent: string) => {
    const r = await app.inject({ method: 'POST', url: '/agent/turn-leases', headers: asAgent(agent), payload: { causeMessageId } });
    expect(r.statusCode).toBe(200);
  };
  const entryOf = async (accountId: string, messageId: string) =>
    (await listInbox(pool, accountId, {})).find((e) => e.messageId === messageId);
  const channel = async (name: string) => {
    const id = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name } })).json().id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [id, [alice.accountId, bob.accountId, tm, sec, stranger]]);
    return id;
  };
  /** 사건 꼴: 사람이 #task 에서 tm 을 부르고 → tm 이 #cmdb 새 머리로 sec 에게 넘기고 → sec 의 보고가 tm 을 깨운다. */
  const chain = async (startChannel: string) => {
    const root = await post(startChannel, alice.accountId, '@tm 옛 툴 API 확인해 봐');
    await lease(root, tm);
    const hop = await post(cmdb, tm, '@sec 읽기만 해서 확인해 줘', { chainCause: root });
    await lease(hop, sec);
    const report = await post(cmdb, sec, '@tm 결과 보고', { threadRootId: hop, chainCause: hop });
    return { root, hop, report };
  };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    tm = (await createAgent(app, admin.token, 'tm')).accountId;
    sec = (await createAgent(app, admin.token, 'sec')).accountId;
    stranger = (await createAgent(app, admin.token, 'stranger')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = any($1::uuid[])`, [[tm, sec], alice.accountId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [stranger, bob.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    for (const a of [tm, sec, stranger]) {
      await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a, op.operatorId, admin.accountId]);
    }
    task = await channel('task');
    cmdb = await channel('cmdb');
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('동료의 보고로 깬 창구 턴에 시작 스레드를 싣는다(사건 꼴)', async () => {
    const { root, report } = await chain(task);
    expect((await entryOf(tm, report))?.startedIn).toEqual({ channelId: task, threadRootId: root });
  });

  it('일을 넘겨받은 동료에게는 싣지 않는다 — 사람이 그 스레드에서 부른 적이 없다', async () => {
    const { hop } = await chain(task);
    const e = await entryOf(sec, hop);
    expect(e).toBeDefined();
    expect(e && 'startedIn' in e).toBe(false);
  });

  it('사람이 직접 부른 글에는 싣지 않는다 — 앵커가 보고처다', async () => {
    const { root } = await chain(task);
    const reply = await post(task, alice.accountId, '@tm 하나 더', { threadRootId: root });
    const e = await entryOf(tm, reply);
    expect(e).toBeDefined();
    expect(e && 'startedIn' in e).toBe(false);
  });

  it('시작 스레드 안에서 동료가 부르면 싣지 않는다 — 앵커와 같다', async () => {
    const root = await post(task, alice.accountId, '@tm 같이 보자');
    await lease(root, tm);
    const hop = await post(task, tm, '@sec 여기서 봐 줘', { threadRootId: root, chainCause: root });
    await lease(hop, sec);
    const back = await post(task, sec, '@tm 봤다', { threadRootId: root, chainCause: hop });
    const e = await entryOf(tm, back);
    expect(e).toBeDefined();
    expect(e && 'startedIn' in e).toBe(false);
  });

  it('시작 채널을 지금 볼 수 없으면 싣지 않는다(비공개 · 멤버 아님)', async () => {
    const priv = await channel('priv');
    const { report } = await chain(priv);
    expect((await entryOf(tm, report))?.startedIn).toBeDefined();
    await pool.query(`update channel set visibility = 'private' where id = $1`, [priv]);
    await pool.query(`delete from channel_member where channel_id = $1 and account_id = $2`, [priv, tm]);
    const e = await entryOf(tm, report);
    expect(e).toBeDefined();
    expect(e && 'startedIn' in e).toBe(false);
  });

  it('끝난 위임장·다른 소유자의 에이전트에는 싣지 않는다', async () => {
    const { root, report } = await chain(task);
    const m = (await pool.query(`select mandate_id from message where id = $1`, [root])).rows[0].mandate_id as string;
    await pool.query(`update mandate set ended_at = now(), end_reason = 'test' where id = $1`, [m]);
    const e = await entryOf(tm, report);
    expect(e && 'startedIn' in e).toBe(false);
    // 다른 소유자(bob)의 에이전트 글에는 위임 키가 없다 → 실리지 않는다.
    const root2 = await post(task, alice.accountId, '@tm 다시');
    await lease(root2, tm);
    const hop2 = await post(cmdb, tm, '@stranger 봐 줘', { chainCause: root2 });
    await lease(hop2, stranger);
    const r2 = await post(cmdb, stranger, '@tm 끝', { threadRootId: hop2, chainCause: hop2 });
    const e2 = await entryOf(tm, r2);
    expect(e2).toBeDefined();
    expect(e2 && 'startedIn' in e2).toBe(false);
  });
});

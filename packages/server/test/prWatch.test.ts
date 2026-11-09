import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { autoWatchOnQueued, createWatch, delegationHasOpenWatch, reportWatchStatus } from '../src/services/prWatch.js';

// PR 감시(위임 재설계 P5).
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const HEAD = 'a'.repeat(40);
const REPO = 'example-org/example-repo';

describe('pr watch', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let alice: { token: string; accountId: string };
  let agentId: string; let agent2: string;
  let op: { token: string; operatorId: string };
  let ch: string; let other: string; let root: string; let otherRoot: string;
  const prev = process.env.HARKROOM_DELEGATION_V2;

  const grant = (id: string) => pool.query(`insert into account_grant (account_id, capability, scope, granted_by) values ($1, 'repo.merge', $2, $3)`,
    [id, `repo:${REPO}`, alice.accountId]);
  const watch = (accountId: string, extra: Partial<Parameters<typeof createWatch>[1]> = {}) =>
    createWatch(pool, { accountId, repo: REPO, number: 7, head: HEAD, until: 'checks', channelId: ch, threadRootId: root, ...extra });

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    ({ accountId: agentId } = await createAgent(app, admin.token, 'watcher'));
    ({ accountId: agent2 } = await createAgent(app, admin.token, 'watcher2'));
    for (const a of [agentId, agent2]) await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [a, alice.accountId]);
    op = await registerOperator(app, admin.token, 'mac');
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agentId, op.operatorId, admin.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'dev' } })).json().id as string;
    other = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'other' } })).json().id as string;
    for (const a of [agentId, agent2]) await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [ch, a]);
    root = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'ci?', 'user') returning id`, [ch, alice.accountId])).rows[0].id;
    otherRoot = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'x', 'user') returning id`, [other, admin.accountId])).rows[0].id;
  });
  afterAll(async () => { await app.close(); await db.stop(); });
  beforeEach(async () => {
    process.env.HARKROOM_DELEGATION_V2 = '1';
    await pool.query(`delete from pr_watch`);
    await pool.query(`delete from account_grant where capability in ('repo.merge', 'repo.read')`);
  });
  afterEach(() => { if (prev === undefined) delete process.env.HARKROOM_DELEGATION_V2; else process.env.HARKROOM_DELEGATION_V2 = prev; });

  it('스위치가 꺼지면 disabled — 아무 행도 없다', async () => {
    delete process.env.HARKROOM_DELEGATION_V2;
    await grant(agentId);
    expect(await watch(agentId)).toEqual({ ok: false, code: 'disabled' });
    expect(await autoWatchOnQueued(pool, { agentId, repo: REPO, number: 7, headSha: HEAD, channelId: ch, threadRootId: root })).toBeNull();
    expect((await pool.query(`select count(*)::int n from pr_watch`)).rows[0].n).toBe(0);
  });

  it('grant 가 없으면 not_granted', async () => {
    expect(await watch(agentId)).toEqual({ ok: false, code: 'not_granted' });
  });

  it('멤버가 아닌 채널·다른 채널의 스레드는 forbidden', async () => {
    await grant(agentId);
    expect(await watch(agentId, { channelId: other, threadRootId: otherRoot })).toEqual({ ok: false, code: 'forbidden' });
    expect(await watch(agentId, { threadRootId: otherRoot })).toEqual({ ok: false, code: 'forbidden' });
  });

  it('source 는 인자가 아니다 — 도구 길은 늘 manual', async () => {
    await grant(agentId);
    const r = await watch(agentId, { source: 'merge_queue' } as never);
    expect(r.ok).toBe(true);
    expect((await pool.query(`select source from pr_watch_subscriber`)).rows).toEqual([{ source: 'manual' }]);
  });

  it('두 구독자는 감시 하나로 합친다', async () => {
    await grant(agentId); await grant(agent2);
    const a = await watch(agentId); const b = await watch(agent2);
    expect(a.ok && b.ok && a.watchId === b.watchId).toBe(true);
    expect((await pool.query(`select count(*)::int n from pr_watch`)).rows[0].n).toBe(1);
    expect((await pool.query(`select count(*)::int n from pr_watch_subscriber`)).rows[0].n).toBe(2);
  });

  it('폴러 보고: 바뀌면 구독자 스레드에 시스템 줄·구독자만 wake, 체크가 다 끝나면 done', async () => {
    await grant(agentId); await grant(agent2);
    const a = await watch(agentId); await watch(agent2);
    if (!a.ok) throw new Error('watch');
    const pending = await reportWatchStatus(pool, { agentId, watchId: a.watchId, status: { state: 'OPEN', headRefOid: HEAD, checks: [{ name: 'ci', conclusion: 'IN_PROGRESS' }] } });
    expect(pending).toMatchObject({ ok: true, changed: true, state: 'open' });
    // 같은 상태는 다시 깨우지 않는다.
    expect(await reportWatchStatus(pool, { agentId, watchId: a.watchId, status: { state: 'OPEN', headRefOid: HEAD, checks: [{ name: 'ci', conclusion: 'IN_PROGRESS' }] } }))
      .toMatchObject({ ok: true, changed: false });
    const done = await reportWatchStatus(pool, { agentId, watchId: a.watchId, status: { state: 'OPEN', headRefOid: HEAD, checks: [{ name: 'ci', conclusion: 'SUCCESS' }] } });
    expect(done).toMatchObject({ ok: true, changed: true, state: 'done' });
    expect((await pool.query(`select state from pr_watch where id = $1`, [a.watchId])).rows[0].state).toBe('done');
    const lines = (await pool.query(`select body, kind from message where thread_root_id = $1 and meta ? 'prWatch' order by created_at`, [root])).rows;
    expect(lines.length).toBe(4); // 두 번 바뀜 × 구독자 둘(같은 스레드)
    expect(lines.every((l) => l.kind === 'system' && !l.body.includes('@'))).toBe(true);
    const wakes = (await pool.query(`select distinct account_id from inbox where reason = 'wake'`)).rows.map((r) => r.account_id).sort();
    expect(wakes).toEqual([agentId, agent2].sort());
    expect(wakes).not.toContain(alice.accountId);
  });

  it('head 가 밀리면 gone', async () => {
    await grant(agentId);
    const a = await watch(agentId); if (!a.ok) throw new Error('watch');
    expect(await reportWatchStatus(pool, { agentId, watchId: a.watchId, status: { state: 'OPEN', headRefOid: 'b'.repeat(40), checks: [] } }))
      .toMatchObject({ ok: true, state: 'gone' });
  });

  it('머지 큐 보고는 merge_queue 감시(until merged)를 건다', async () => {
    const r = await autoWatchOnQueued(pool, { agentId, repo: REPO, number: 7, headSha: HEAD, channelId: ch, threadRootId: root });
    expect(r?.ok).toBe(true);
    expect((await pool.query(`select w.until, s.source, s.account_id from pr_watch w join pr_watch_subscriber s on s.watch_id = w.id`)).rows)
      .toEqual([{ until: 'merged', source: 'merge_queue', account_id: agentId }]);
  });

  it('위임 없는 감시는 외부 대기가 아니다', async () => {
    expect(await delegationHasOpenWatch(pool, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('operator due 라우트: 스위치 꺼지면 빈 목록', async () => {
    delete process.env.HARKROOM_DELEGATION_V2;
    const res = await app.inject({ method: 'GET', url: '/agent/pr-watches/due', headers: { ...auth(op.token), 'x-harkroom-agent': agentId } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ watches: [] });
  });
});

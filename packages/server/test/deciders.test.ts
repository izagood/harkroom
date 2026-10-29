import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { mayDecideFor, mayDecideSql } from '../src/services/deciders.js';
import { decide } from '../src/services/decisions.js';
import { toolAllowsFor } from '../src/services/permissionRequests.js';

// 누가 권한·머지 카드를 정하나(소유자 결정 2026-10-29) — 「그 채널에서 이 에이전트를 부를 수 있는 사람」. 범위 넷·게스트·비상 스위치,
// 그리고 JS 판정(`mayDecideFor`)과 SQL 조각(`mayDecideSql`)이 같은 답을 내는지.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const OPTIONS = [{ id: 'approve', label: '7일 허락하고 다시 시도' }, { id: 'deny', label: '거절' }];

describe('deciders — 카드를 정할 수 있는 사람', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string;
  let ch: string;

  const setScope = (scope: string) => pool.query(`update agent_config set invoke_scope = $2 where account_id = $1`, [agentId, scope]);
  const both = async (actorId: string, channelId = ch) => {
    const js = (await mayDecideFor(pool, { agentId, actorId, channelId })).ok;
    const sql = (await pool.query<{ ok: boolean }>(`select ${mayDecideSql('$1::uuid', '$2::uuid', '$3::uuid')} as ok`, [agentId, actorId, channelId])).rows[0]!.ok;
    expect(sql).toBe(js);
    return js;
  };
  const permissionCard = async (kind: 'tool' | 'merge', target: string, channelId = ch) => {
    const root = (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, '부탁', 'user') returning id`, [channelId, bob.accountId])).rows[0].id as string;
    const requestId = (await pool.query(
      `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at)
       values ($1, $2, $3, '확인', '{}', $4, $5, now(), now() + interval '1 day') returning id`,
      [agentId, kind, target, channelId, root])).rows[0].id as string;
    const cardId = (await pool.query(`insert into message (channel_id, author_id, thread_root_id, body, kind, meta) values ($1, $2, $3, '카드', 'user', $4) returning id`,
      [channelId, agentId, root, JSON.stringify({ kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' } }, permissionRequest: { requestId, status: 'pending' } })])).rows[0].id as string;
    await pool.query(`update permission_request set card_message_id = $2 where id = $1`, [requestId, cardId]);
    return { requestId, cardId, root };
  };

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    agentId = (await createAgent(app, admin.token, 'sitebot')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'deciders' } })).json().id as string;
  });
  afterAll(async () => { await app.close(); await db.stop(); });
  beforeEach(async () => {
    await pool.query(`update agent_config set invoke_scope = 'community', user_decide = true where account_id = $1`, [agentId]);
    await pool.query(`update account set role = 'member' where id = $1`, [bob.accountId]);
    await pool.query(`delete from agent_invoker where agent_id = $1`, [agentId]);
    await pool.query(`delete from channel_member where channel_id = $1 and account_id = $2`, [ch, bob.accountId]);
  });

  it('소유자는 범위와 스위치에 관계없이 정한다', async () => {
    await setScope('owner');
    await pool.query(`update agent_config set user_decide = false where account_id = $1`, [agentId]);
    expect(await both(alice.accountId)).toBe(true);
    expect(await mayDecideFor(pool, { agentId, actorId: alice.accountId, channelId: ch })).toMatchObject({ ok: true, asOwner: true });
  });

  it('범위 넷 — owner 는 소유자만, list 는 명단, channel 은 그 채널 멤버, community 는 누구나', async () => {
    await setScope('owner');
    expect(await both(bob.accountId)).toBe(false);
    await setScope('list');
    expect(await both(bob.accountId)).toBe(false);
    await pool.query(`insert into agent_invoker (agent_id, account_id) values ($1, $2)`, [agentId, bob.accountId]);
    expect(await both(bob.accountId)).toBe(true);
    await setScope('channel');
    expect(await both(bob.accountId)).toBe(false);
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2)`, [ch, bob.accountId]);
    expect(await both(bob.accountId)).toBe(true);
    await setScope('community');
    expect(await both(bob.accountId)).toBe(true);
    expect(await mayDecideFor(pool, { agentId, actorId: bob.accountId, channelId: ch })).toMatchObject({ ok: true, asOwner: false });
  });

  it('게스트·꺼진 스위치·에이전트 계정·채널 없음은 정하지 못한다', async () => {
    await pool.query(`update account set role = 'guest' where id = $1`, [bob.accountId]);
    expect(await both(bob.accountId)).toBe(false);
    await pool.query(`update account set role = 'member' where id = $1`, [bob.accountId]);
    await pool.query(`update agent_config set user_decide = false where account_id = $1`, [agentId]);
    expect(await both(bob.accountId)).toBe(false);
    await pool.query(`update agent_config set user_decide = true where account_id = $1`, [agentId]);
    expect(await both(agentId)).toBe(false);
    expect((await mayDecideFor(pool, { agentId, actorId: bob.accountId, channelId: null })).ok).toBe(false);
  });

  it('소유자가 아닌 사람이 정하면 grant 는 그 사람 이름, 카드에 표지, 소유자에게 알림 줄이 선다', async () => {
    const { requestId, cardId, root } = await permissionCard('merge', 'repo:acme/app');
    const out = await decide(pool, { kind: 'permission', requestId, agentId, cardMessageId: cardId }, bob.accountId, { option: 'approve', via: 'button' });
    expect(out).toMatchObject({ kind: 'permission', ok: true });
    const g = (await pool.query(`select granted_by from account_grant where account_id = $1 and capability = 'repo.merge' and scope = 'repo:acme/app'`, [agentId])).rows[0];
    expect(g.granted_by).toBe(bob.accountId);
    expect((await pool.query(`select decided_by from permission_request where id = $1`, [requestId])).rows[0].decided_by).toBe(bob.accountId);
    const card = (await pool.query(`select meta from message where id = $1`, [cardId])).rows[0].meta;
    expect(card.permissionRequest).toMatchObject({ status: 'granted', decidedBy: bob.accountId, decidedByOwner: false });
    const notice = (await pool.query(`select body, meta from message where thread_root_id = $1 and meta ? 'permissionUserDecision'`, [root])).rows[0];
    expect(notice.meta.permissionUserDecision).toMatchObject({ requestId, actorId: bob.accountId, ownerAccountId: alice.accountId });
    expect(notice.meta.i18n.key).toBe('system.permission.approvedByUser');
    const audit = (await pool.query(`select detail from audit_log where action = 'permission.approved' and detail->>'requestId' = $1`, [requestId])).rows[0];
    expect(audit.detail.asOwner).toBe(false);
  });

  it('security F2: 소유자가 못 보는 비공개 채널에서 승인하면 소유자↔에이전트 DM 으로 따로 알린다(채널 이름은 싣지 않는다)', async () => {
    const priv = (await pool.query(`insert into channel (name, kind, visibility) values ('bob-secret-room', 'standard', 'private') returning id`)).rows[0].id as string;
    await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2), ($1, $3)`, [priv, agentId, bob.accountId]);
    const { requestId, cardId } = await permissionCard('merge', 'repo:acme/private', priv);
    const before = Number((await pool.query(`select count(*) from inbox where account_id = $1`, [alice.accountId])).rows[0].count);
    const out = await decide(pool, { kind: 'permission', requestId, agentId, cardMessageId: cardId }, bob.accountId, { option: 'approve', via: 'button' });
    expect(out).toMatchObject({ kind: 'permission', ok: true });
    const rows = (await pool.query(
      `select i.reason, m.body, m.meta, c.kind as "channelKind" from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
        where i.account_id = $1 order by i.created_at desc`, [alice.accountId])).rows;
    expect(rows.length - before).toBe(1);
    expect(rows[0].channelKind).toBe('dm');
    expect(rows[0].meta.permissionUserDecision).toMatchObject({ requestId, actorId: bob.accountId, via: 'dm' });
    expect(rows[0].body).not.toContain('bob-secret-room');
  });

  it('소유자가 아닌 사람의 재승인은 살아 있는 grant 를 덮어 늘리지 않는다(security 9)', async () => {
    const live = new Date(Date.now() + 3_600_000);
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause) values ($1, 'repo.merge', 'repo:acme/live', $2, $3, false)`,
      [agentId, alice.accountId, live]);
    const { requestId, cardId } = await permissionCard('merge', 'repo:acme/live');
    const out = await decide(pool, { kind: 'permission', requestId, agentId, cardMessageId: cardId }, bob.accountId, { option: 'approve', via: 'button' });
    expect(out).toMatchObject({ kind: 'permission', ok: true });
    const g = (await pool.query(`select granted_by, expires_at from account_grant where account_id = $1 and scope = 'repo:acme/live'`, [agentId])).rows[0];
    expect(g.granted_by).toBe(alice.accountId);
    expect(new Date(g.expires_at).getTime()).toBe(live.getTime());
  });

  it('범위가 좁아지면 소유자가 아닌 사람이 준 tool 허락은 그 순간부터 쓰이지 않는다(security 4)', async () => {
    await setScope('list');
    await pool.query(`insert into agent_invoker (agent_id, account_id) values ($1, $2)`, [agentId, bob.accountId]);
    const { requestId, cardId } = await permissionCard('tool', 'Bash(kubectl get pods:*)');
    const out = await decide(pool, { kind: 'permission', requestId, agentId, cardMessageId: cardId }, bob.accountId, { option: 'approve', via: 'button' });
    expect(out).toMatchObject({ kind: 'permission', ok: true });
    expect(await toolAllowsFor(pool, agentId, ch)).toContain('Bash(kubectl get pods:*)');
    await pool.query(`delete from agent_invoker where agent_id = $1 and account_id = $2`, [agentId, bob.accountId]);
    expect(await toolAllowsFor(pool, agentId, ch)).not.toContain('Bash(kubectl get pods:*)');
  });

  it('decide-check — 사람 세션이 이 채널에서 정할 수 있는지 돌려준다', async () => {
    const ask = (token: string) => app.inject({ method: 'GET', url: `/agents/${agentId}/decide-check?channelId=${ch}`, headers: auth(token) });
    await setScope('owner');
    expect((await ask(bob.token)).json()).toEqual({ viewerCanDecide: false, asOwner: false, decideScope: 'owner', ownerAccountId: alice.accountId });
    await setScope('list');
    expect((await ask(bob.token)).json()).toMatchObject({ viewerCanDecide: false, decideScope: 'list' });
    await setScope('community');
    expect((await ask(bob.token)).json()).toEqual({ viewerCanDecide: true, asOwner: false, decideScope: 'community', ownerAccountId: alice.accountId });
    expect((await ask(alice.token)).json()).toMatchObject({ viewerCanDecide: true, asOwner: true });
    // 비상 스위치가 꺼지면 범위와 관계없이 switchOff — 소유자만 정한다.
    await pool.query(`update agent_config set user_decide = false where account_id = $1`, [agentId]);
    expect((await ask(bob.token)).json()).toMatchObject({ viewerCanDecide: false, decideScope: 'switchOff' });
    expect((await ask(alice.token)).json()).toMatchObject({ viewerCanDecide: true, decideScope: 'switchOff' });
  });

  it('decide-check — 볼 수 없는 채널이면 소유자 id·범위를 주지 않는다(security n6)', async () => {
    await setScope('community');
    await pool.query(`update agent_config set user_decide = true where account_id = $1`, [agentId]);
    const hidden = (await pool.query(`insert into channel (name, kind, visibility) values ('n6-hidden-room', 'standard', 'private') returning id`)).rows[0].id as string;
    const res = await app.inject({ method: 'GET', url: `/agents/${agentId}/decide-check?channelId=${hidden}`, headers: auth(bob.token) });
    expect(res.json()).toEqual({ viewerCanDecide: false, asOwner: false, decideScope: null, ownerAccountId: null });
    // 소유자는 볼 수 없는 채널이어도 정할 수 있는 사람이라 그대로 받는다.
    expect((await app.inject({ method: 'GET', url: `/agents/${agentId}/decide-check?channelId=${hidden}`, headers: auth(alice.token) })).json())
      .toMatchObject({ viewerCanDecide: true, asOwner: true, ownerAccountId: alice.accountId });
  });
});

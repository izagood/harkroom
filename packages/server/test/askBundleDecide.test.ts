// 묶음 카드에서 권한 카드를 그 자리에서 정한다 — 원 카드와 같은 판정(`decide`)을 거치고, 원본 카드에 답이 적혀 요청 에이전트가
// 깨어나며, 감사·카드 meta 에는 `via: bundle` 로 남는다. 줄의 `link` 는 옛 앱용 표지일 뿐 서버 판정에 쓰지 않는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { mintPat } from '../src/services/pats.js';
import { resolveBundleItem, upsertAskBundle } from '../src/services/askBundles.js';
import { linkPermissionCard, openPermissionRequest, permissionCardOptions } from '../src/services/permissionRequests.js';
import { postMessage } from '../src/services/messages.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('묶음 줄에서 권한 카드 정하기', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string;
  let agentPat: string;
  let pmId: string;
  let ch: string;
  let privCh: string;
  let pmCh: string;
  let n = 0;

  const newRoot = async (channelId: string) =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind) values ($1, $2, 'do it', 'user') returning id`, [channelId, alice.accountId])).rows[0].id as string;
  const card = async (channelId = ch, opts: { rule?: string; root?: string } = {}) => {
    n += 1;
    const root = opts.root ?? await newRoot(channelId);
    const rule = opts.rule ?? `Bash(kubectl --context ops get pods${n}:*)`;
    const opened = await openPermissionRequest(pool, { agentId, kind: 'tool', rule, reason: '확인', channelId, threadRootId: root });
    if (!opened.ok || !('created' in opened)) throw new Error(JSON.stringify(opened));
    const meta = opened.created.meta;
    const cardId = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta, thread_root_id) values ($1, $2, '권한 요청', 'user', $3, $4) returning id`,
      [channelId, agentId, JSON.stringify({ kind: 'ask', ask: { options: permissionCardOptions('tool', { mandate: false }), to: { kind: 'human' } }, permissionRequest: meta }), root])).rows[0].id as string;
    await linkPermissionCard(pool, opened.created.requestId, cardId);
    return { requestId: opened.created.requestId, cardId, root, rule };
  };
  const bundleOf = async (rootIds: string[]) => {
    const head = await newRoot(pmCh);
    const made = await upsertAskBundle(pool, { callerId: pmId, channelId: pmCh, threadRootId: head, body: '정할 것', rootIds });
    if (!made.ok) throw new Error(JSON.stringify(made));
    return { bundleId: made.message.id, head };
  };
  const press = (token: string, bundleId: string, rootId: string, optionId = 'approve_new_mandate', extra: Record<string, unknown> = {}, channelId = pmCh) =>
    app.inject({ method: 'POST', url: `/channels/${channelId}/messages/${bundleId}/ask-bundle/answer`, headers: auth(token), payload: { rootId, optionId, ...extra } });
  const metaOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta;
  const statusOf = async (requestId: string) => (await pool.query(`select status from permission_request where id = $1`, [requestId])).rows[0].status as string;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    ({ accountId: agentId, pat: agentPat } = await createAgent(app, admin.token, 'rowbot'));
    ({ accountId: pmId } = await createAgent(app, admin.token, 'rowpm'));
    await pool.query(`update agent_config set owner_account_id = $2, invoke_scope = 'owner' where account_id = $1`, [agentId, alice.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'rows-work' } })).json().id as string;
    pmCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'rows-task' } })).json().id as string;
    privCh = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'rows-private' } })).json().id as string;
    await pool.query(`update channel set visibility = 'private' where id = $1`, [privCh]);
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [privCh, [alice.accountId, agentId, pmId]]);
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('소유자가 줄에서 정하면 원본에 답이 적히고, 에이전트가 깨어나고, via: bundle 로 남는다', async () => {
    const c = await card();
    const { bundleId } = await bundleOf([c.cardId]);
    const res = await press(alice.token, bundleId, c.cardId);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(bundleId);
    const meta = await metaOf(c.cardId);
    expect(meta.ask).toMatchObject({ answeredWith: 'approve_new_mandate', answeredBy: alice.accountId });
    expect(meta.ask.answeredVia).toBeUndefined();
    expect(meta.permissionRequest).toMatchObject({ status: 'granted', decidedBy: alice.accountId, decidedVia: { kind: 'bundle', bundleMessageId: bundleId } });
    expect((await pool.query(`select reason from inbox where account_id = $1 and message_id = $2`, [agentId, c.cardId])).rows.map((r) => r.reason)).toEqual(['ask_answered']);
    const audit = (await pool.query(`select detail from audit_log where action = 'permission.approved' and actor_id = $1 and detail->>'requestId' = $2`, [alice.accountId, c.requestId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ via: 'bundle', bundleMessageId: bundleId });
  });

  it('위임장이 있는 카드의 [이 위임장 동안]은 요청 스레드의 위임장에 줄을 적고 그 줄에도 via: bundle 이 남는다', async () => {
    await pool.query(`insert into channel_member (channel_id, account_id) select $1, unnest($2::uuid[]) on conflict do nothing`, [ch, [alice.accountId, agentId]]);
    const posted = await postMessage(pool, { channelId: ch, authorId: alice.accountId, body: '@rowbot 봐 줘', threadRootId: null, authVia: 'session' });
    if (posted.failure) throw new Error(String(posted.failure));
    const root = posted.message.id as string;
    const mandateId = (await pool.query(`select mandate_id from message where id = $1`, [root])).rows[0].mandate_id as string;
    expect(mandateId).toBeTruthy();
    n += 1;
    const opened = await openPermissionRequest(pool, { agentId, kind: 'tool', rule: `Bash(kubectl --context ops get pods${n}:*)`, reason: '확인', channelId: ch, threadRootId: root, mandateId });
    if (!opened.ok || !('created' in opened)) throw new Error(JSON.stringify(opened));
    const cardId = (await pool.query(
      `insert into message (channel_id, author_id, body, kind, meta, thread_root_id) values ($1, $2, '권한 요청', 'user', $3, $4) returning id`,
      [ch, agentId, JSON.stringify({ kind: 'ask', ask: { options: permissionCardOptions('tool', { mandate: true }), to: { kind: 'human' } }, permissionRequest: opened.created.meta }), root])).rows[0].id as string;
    await linkPermissionCard(pool, opened.created.requestId, cardId);
    const { bundleId } = await bundleOf([cardId]);
    expect((await press(alice.token, bundleId, cardId, 'approve_mandate')).statusCode).toBe(200);
    const lines = (await pool.query(`select mandate_id as "mandateId", via from mandate_line where request_id = $1`, [opened.created.requestId])).rows;
    expect(lines).toEqual([{ mandateId, via: 'bundle' }]);
  });

  it('거절도 원 카드와 같이 적힌다. 정해진 줄을 다시 누르면 409 다', async () => {
    const c = await card();
    const { bundleId } = await bundleOf([c.cardId]);
    expect((await press(alice.token, bundleId, c.cardId, 'deny')).statusCode).toBe(200);
    expect((await metaOf(c.cardId)).ask.answeredWith).toBe('deny');
    expect(await statusOf(c.requestId)).toBe('denied');
    const again = await press(alice.token, bundleId, c.cardId, 'approve_new_mandate');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_answered');
  });

  it('결정권이 없으면 묶음에서도 403 이다 — 범위가 넓어지지 않는다', async () => {
    const c = await card();
    const { bundleId } = await bundleOf([c.cardId]);
    const res = await press(bob.token, bundleId, c.cardId);
    expect(res.statusCode).toBe(403);
    expect(await statusOf(c.requestId)).toBe('pending');
    expect((await metaOf(c.cardId)).ask.answeredWith).toBeUndefined();
  });

  it('결정권은 묶음 채널이 아니라 요청 채널로 잰다', async () => {
    await pool.query(`update agent_config set invoke_scope = 'channel' where account_id = $1`, [agentId]);
    try {
      await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [pmCh, bob.accountId]);
      const c = await card();
      const { bundleId } = await bundleOf([c.cardId]);
      expect((await press(bob.token, bundleId, c.cardId)).statusCode).toBe(403);
      await pool.query(`insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`, [ch, bob.accountId]);
      expect((await press(bob.token, bundleId, c.cardId)).statusCode).toBe(200);
      expect((await metaOf(c.cardId)).permissionRequest).toMatchObject({ decidedBy: bob.accountId, decidedByOwner: false });
    } finally {
      await pool.query(`update agent_config set invoke_scope = 'owner' where account_id = $1`, [agentId]);
    }
  });

  it('원본 채널을 못 보는 사람은 묶음을 볼 수 있어도 정하지 못한다', async () => {
    const c = await card(privCh);
    const { bundleId } = await bundleOf([c.cardId]);
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, bob.accountId]);
    try {
      const res = await press(bob.token, bundleId, c.cardId);
      expect(res.statusCode).toBe(403);
      expect(await statusOf(c.requestId)).toBe('pending');
    } finally {
      await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    }
  });

  it('사람 세션만 된다 — 사람 PAT·에이전트 토큰은 403', async () => {
    const c = await card();
    const { bundleId } = await bundleOf([c.cardId]);
    const minted = await mintPat(pool, alice.accountId, 'row-test', { actorId: alice.accountId, actorHandle: 'alice' });
    if (!minted.ok) throw new Error('pat not minted');
    // 사람 PAT 는 지금 인증 단계에서 401 이다. 그 길이 열려도 세션이 아니므로 403 이어야 한다.
    expect([401, 403]).toContain((await press(minted.token, bundleId, c.cardId)).statusCode);
    expect((await press(agentPat, bundleId, c.cardId)).statusCode).toBe(403);
    expect(await statusOf(c.requestId)).toBe('pending');
  });

  it('묶음에 없는 카드는 정하지 못한다', async () => {
    const inside = await card();
    const outside = await card();
    const { bundleId } = await bundleOf([inside.cardId]);
    expect((await press(alice.token, bundleId, outside.cardId)).statusCode).toBe(404);
    expect(await statusOf(outside.requestId)).toBe('pending');
  });

  it('옛 묶음의 link 표지가 남아 있어도 줄에서 정한다(옛 앱은 그 표지로 링크를 그린다)', async () => {
    const c = await card();
    const { bundleId } = await bundleOf([c.cardId]);
    expect((await metaOf(bundleId)).askBundle.items[0]).toMatchObject({ rootId: c.cardId, link: true });
    expect((await press(alice.token, bundleId, c.cardId)).statusCode).toBe(200);
  });

  it('「추천대로」 일괄은 권한 줄을 계속 뺀다 — link 표지가 없어도 원본 meta 로 잰다', async () => {
    const c = await card();
    const { bundleId } = await bundleOf([c.cardId]);
    await pool.query(
      `update message set meta = jsonb_set(meta, '{askBundle,items,0}', (meta->'askBundle'->'items'->0) - 'link') where id = $1`, [bundleId]);
    const res = await app.inject({ method: 'POST', url: `/channels/${pmCh}/messages/${bundleId}/ask-bundle/accept-recommended`, headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([{ rootId: c.cardId, outcome: 'skipped_link' }]);
    expect(await statusOf(c.requestId)).toBe('pending');
  });

  it('askBundleResolve 는 권한 줄을 닫지 못한다 — link 표지가 없어도', async () => {
    const c = await card();
    const { bundleId, head } = await bundleOf([c.cardId]);
    await pool.query(
      `update message set meta = jsonb_set(meta, '{askBundle,items,0}', (meta->'askBundle'->'items'->0) - 'link') where id = $1`, [bundleId]);
    const reply = await postMessage(pool, { channelId: pmCh, authorId: alice.accountId, body: '승인', threadRootId: head });
    if (reply.failure) throw new Error(String(reply.failure));
    expect(await resolveBundleItem(pool, { callerId: pmId, bundleId, rootId: c.cardId, replyMessageId: reply.message.id })).toEqual({ ok: false, code: 'bundle_item_link' });
    expect(await statusOf(c.requestId)).toBe('pending');
  });

  it('시한이 지나 다시 낸 권한 요청의 새 카드가 같은 묶음에 줄로 붙는다', async () => {
    const first = await card();
    const { bundleId } = await bundleOf([first.cardId]);
    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [first.requestId]);
    const second = await card(ch, { rule: first.rule, root: first.root });
    const items = (await metaOf(bundleId)).askBundle.items as { rootId: string }[];
    expect(items.map((i) => i.rootId)).toEqual([first.cardId, second.cardId]);
    expect((await metaOf(first.cardId)).ask).toMatchObject({ closedReason: 'superseded', supersededBy: second.cardId });
    expect((await press(alice.token, bundleId, second.cardId)).statusCode).toBe(200);
  });
});

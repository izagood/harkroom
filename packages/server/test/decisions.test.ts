import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { decide, resolveDecision } from '../src/services/decisions.js';
import { renderPermissionMirror } from '../src/services/permissionRequests.js';

// 결정 해석(M2) — 카드 글 id 하나가 무엇을 정하는 카드인지, 거울은 원본으로 따라가는지.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const OPTIONS = [{ id: 'approve', label: '7일 허락하고 다시 시도' }, { id: 'deny', label: '거절' }];

describe('resolveDecision · decide', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let alice: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  let agentId: string;
  let ch: string;
  let adminToken: string;

  const message = async (meta: Record<string, unknown>, authorId = agentId): Promise<string> =>
    (await pool.query(`insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, '카드', 'user', $3) returning id`,
      [ch, authorId, JSON.stringify(meta)])).rows[0].id as string;
  const askMeta = (extra: Record<string, unknown> = {}) => ({ kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' }, ...extra } });
  /** 권한 요청 줄 + 그 카드. */
  const permissionCard = async () => {
    const root = await message({}, alice.accountId);
    const requestId = (await pool.query(
      `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at)
       values ($1, 'tool', 'Bash(kubectl get pods:*)', '확인', '{}', $2, $3, now(), now() + interval '1 day') returning id`,
      [agentId, ch, root])).rows[0].id as string;
    const cardId = await message({ ...askMeta(), permissionRequest: { requestId, status: 'pending' } });
    await pool.query(`update permission_request set card_message_id = $2 where id = $1`, [requestId, cardId]);
    return { requestId, cardId };
  };
  const status = async (requestId: string) => (await pool.query(`select status from permission_request where id = $1`, [requestId])).rows[0].status as string;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    const admin = await bootstrapAdmin(app);
    adminToken = admin.token;
    alice = await createMember(app, admin.token, 'alice');
    bob = await createMember(app, admin.token, 'bob');
    agentId = (await createAgent(app, admin.token, 'sitebot')).accountId;
    await pool.query(`update agent_config set owner_account_id = $2 where account_id = $1`, [agentId, alice.accountId]);
    ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'decide' } })).json().id as string;
  });
  afterAll(async () => { await app.close(); await db.stop(); });

  it('권한 카드 → permission(요청 줄에서 읽은 에이전트·소유자)', async () => {
    const { requestId, cardId } = await permissionCard();
    expect(await resolveDecision(pool, cardId)).toEqual({ kind: 'permission', requestId, agentId, cardMessageId: cardId, ownerAccountId: alice.accountId });
  });

  it('일반 물음 카드 → ask', async () => {
    const id = await message(askMeta());
    expect(await resolveDecision(pool, id)).toEqual({ kind: 'ask', cardMessageId: id });
  });

  it('거울 → 원본으로 따라가고 거울 id 를 남긴다', async () => {
    const { requestId, cardId } = await permissionCard();
    const mirror = await message(askMeta({ mirrorOf: cardId }));
    expect(await resolveDecision(pool, mirror)).toMatchObject({ kind: 'permission', requestId, cardMessageId: cardId, mirrorMessageId: mirror });
    const askRoot = await message(askMeta());
    const askMirror = await message(askMeta({ mirrorOf: askRoot }));
    expect(await resolveDecision(pool, askMirror)).toEqual({ kind: 'ask', cardMessageId: askRoot, mirrorMessageId: askMirror });
  });

  it('원본이 지워진 거울은 거울 혼자 물음이다', async () => {
    const askRoot = await message(askMeta());
    const askMirror = await message(askMeta({ mirrorOf: askRoot }));
    await pool.query(`update message set deleted_at = now() where id = $1`, [askRoot]);
    expect(await resolveDecision(pool, askMirror)).toEqual({ kind: 'ask', cardMessageId: askMirror });
  });

  it('없는 글·지운 글·결정 카드가 아닌 글 → null', async () => {
    expect(await resolveDecision(pool, '0f8fad5b-d9cb-469f-a165-70867728950e')).toBeNull();
    expect(await resolveDecision(pool, await message({}))).toBeNull();
    const gone = await message(askMeta());
    await pool.query(`update message set deleted_at = now() where id = $1`, [gone]);
    expect(await resolveDecision(pool, gone)).toBeNull();
  });

  it('권한 카드의 거울에서 정하면 원본 요청이 정해지고 거울은 따라 닫힌다(via mirror)', async () => {
    const { requestId, cardId } = await permissionCard();
    const mirror = await message(askMeta({ mirrorOf: cardId }));
    const ref = (await resolveDecision(pool, mirror))!;
    expect(await decide(pool, ref, alice.accountId, { option: 'approve', via: 'mirror' })).toMatchObject({ kind: 'permission', ok: true, result: { status: 'granted', cardMessageId: cardId } });
    expect(await status(requestId)).toBe('granted');
    const card = (await pool.query(`select meta from message where id = $1`, [cardId])).rows[0].meta;
    expect(card.permissionRequest.decidedVia).toEqual({ kind: 'mirror', mirrorMessageId: mirror });
    expect(card.ask).toMatchObject({ answeredWith: 'approve', answeredBy: alice.accountId });
    const m = (await pool.query(`select meta from message where id = $1`, [mirror])).rows[0].meta;
    expect(m.ask).toMatchObject({ answeredWith: 'approve', answeredBy: alice.accountId });
    const audit = (await pool.query(`select detail from audit_log where action = 'permission.approved' and detail->>'requestId' = $1`, [requestId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ via: 'mirror', mirrorMessageId: mirror });
  });

  it('거울로도 소유자가 아니면 403 — 요청은 그대로', async () => {
    const { requestId, cardId } = await permissionCard();
    const mirror = await message(askMeta({ mirrorOf: cardId }));
    const ref = (await resolveDecision(pool, mirror))!;
    expect(await decide(pool, ref, bob.accountId, { option: 'approve', via: 'mirror' })).toMatchObject({ kind: 'permission', ok: false, status: 403, code: 'forbidden' });
    expect(await status(requestId)).toBe('pending');
  });

  it('부른 쪽이 소유자를 넘기지 않아도 DB 의 소유자로 대조한다(security n1)', async () => {
    const { requestId } = await permissionCard();
    expect(await decide(pool, { kind: 'permission', requestId, agentId, cardMessageId: null }, bob.accountId, { option: 'approve', via: 'button' }))
      .toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    expect(await status(requestId)).toBe('pending');
  });

  it('서버가 세운 거울이 아니면 정하지 않는다 — 사람이 쓴 것·다른 소유자 에이전트가 쓴 것·선택지가 다른 것', async () => {
    const { requestId, cardId } = await permissionCard();
    const other = (await createAgent(app, adminToken, `otherbot${Date.now() % 100000}`)).accountId;
    const fakes = [
      await message(askMeta({ mirrorOf: cardId }), alice.accountId),
      await message(askMeta({ mirrorOf: cardId }), other),
      await message({ kind: 'ask', ask: { options: [{ id: 'approve', label: '네' }, { id: 'later', label: '나중에' }], to: { kind: 'human' }, mirrorOf: cardId } }),
    ];
    for (const fake of fakes) {
      const ref = (await resolveDecision(pool, fake))!;
      expect(await decide(pool, ref, alice.accountId, { option: 'approve', via: 'mirror' })).toEqual({ kind: 'ask', result: 'forbidden' });
    }
    expect(await status(requestId)).toBe('pending');
  });

  it('만료된 원본은 거울에서도 409 request_expired', async () => {
    const { requestId, cardId } = await permissionCard();
    await pool.query(`update permission_request set expires_at = now() - interval '1 minute' where id = $1`, [requestId]);
    const mirror = await message(askMeta({ mirrorOf: cardId }));
    const ref = (await resolveDecision(pool, mirror))!;
    expect(await decide(pool, ref, alice.accountId, { option: 'approve', via: 'mirror' })).toMatchObject({ ok: false, status: 409, code: 'request_expired' });
  });

  it('머지 거절 카드의 거울에서 [이번 한 번] — 원본 카드의 PR·head 로, gh 계정은 오퍼레이터가 고른다', async () => {
    const { requestId, cardId } = await permissionCard();
    const head = 'b'.repeat(40);
    const root = (await pool.query(`select thread_root_id from permission_request where id = $1`, [requestId])).rows[0].thread_root_id;
    const denial = (await pool.query(
      `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at)
       values ($1, 'repo:acme-org/mirror-once', 9, $2, $3, $4, gen_random_uuid(), now() + interval '1 hour') returning id`,
      [agentId, head, ch, root])).rows[0].id;
    await pool.query(`update permission_request set kind = 'merge', target = 'acme-org/mirror-once', denial_id = $2 where id = $1`, [requestId, denial]);
    await pool.query(`update message set meta = jsonb_set(meta, '{permissionRequest,once}', $2::jsonb) where id = $1`,
      [cardId, JSON.stringify({ number: 9, headSha: head, reason: 'not_granted' })]);
    const mirror = await message(askMeta({ mirrorOf: cardId }));
    const ref = (await resolveDecision(pool, mirror))!;
    const out = await decide(pool, ref, alice.accountId, { option: 'approve_once', via: 'mirror' });
    expect(out).toMatchObject({ kind: 'permission', ok: true, result: { status: 'approved_once' } });
    const audit = (await pool.query(`select detail from audit_log where action = 'repo.merge.approved_once' and detail->>'requestId' = $1`, [requestId])).rows[0].detail;
    expect(audit).toMatchObject({ ghUser: null, ghUserChosenBy: 'operator', number: 9, headSha: head });
  });

  it('권한 카드 거울의 본문·선택지는 원본 요청으로 서버가 쓴다 — 원본을 못 보는 채널이면 중립 한 줄', async () => {
    const { cardId } = await permissionCard();
    await pool.query(`update message set meta = meta || $2::jsonb where id = $1`, [cardId, JSON.stringify({
      permissionRequest: { requestId: 'x', agentId, ownerAccountId: alice.accountId, kind: 'tool', target: 'Bash(kubectl get pods:*)', channelId: ch, threadRootId: ch, warnings: [], reason: '파드 확인', requestedAt: '', expiresAt: '' },
    })]);
    const same = (await renderPermissionMirror(pool, cardId, ch))!;
    expect(same.body).toContain('Bash(kubectl get pods:*)');
    expect(same.body).toContain('파드 확인');
    expect(same.options.map((o) => o.id)).toEqual(['approve', 'deny']);
    // 원본이 비공개 채널이고 거울 채널에 그 채널을 못 보는 사람이 있으면 대상·이유를 싣지 않는다.
    await pool.query(`update channel set visibility = 'private' where id = $1`, [ch]);
    try {
      const other = (await app.inject({ method: 'POST', url: '/channels', headers: auth(bob.token), payload: { name: `mirror-${Date.now() % 100000}` } })).json().id as string;
      const neutral = (await renderPermissionMirror(pool, cardId, other))!;
      expect(neutral.body).not.toContain('kubectl');
      expect(neutral.body).not.toContain('파드 확인');
      // 원본 카드 링크(id 만)는 싣는다(n9).
      expect(neutral.body).toContain(`harkroom://message/${cardId}`);
    } finally {
      await pool.query(`update channel set visibility = 'public' where id = $1`, [ch]);
    }
    expect(await renderPermissionMirror(pool, await message(askMeta()), ch)).toBeNull();
  });

  it('소유자가 아니면 403, 모르는 선택지는 400, 소유자 버튼은 정하고 감사에 via 가 남는다', async () => {
    const { requestId, cardId } = await permissionCard();
    const ref = (await resolveDecision(pool, cardId))!;
    expect(await decide(pool, ref, bob.accountId, { option: 'approve', via: 'button' })).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    expect(await decide(pool, ref, alice.accountId, { option: 'maybe', via: 'button' })).toMatchObject({ ok: false, status: 400, code: 'unknown_option' });
    expect(await status(requestId)).toBe('pending');
    expect(await decide(pool, ref, alice.accountId, { option: 'deny', via: 'button' })).toMatchObject({ kind: 'permission', ok: true, result: { status: 'denied' } });
    expect(await status(requestId)).toBe('denied');
    const audit = (await pool.query(`select detail from audit_log where action = 'permission.denied' and detail->>'requestId' = $1`, [requestId])).rows[0].detail;
    expect(audit).toMatchObject({ via: 'button' });
    const meta = (await pool.query(`select meta from message where id = $1`, [cardId])).rows[0].meta;
    expect(meta.permissionRequest.decidedVia).toBeUndefined();
  });
});

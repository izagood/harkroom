import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { decide, resolveDecision } from '../src/services/decisions.js';

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

  it('권한 카드의 거울에서는 정하지 않는다 — 지금처럼 거절(forbidden), 요청은 그대로', async () => {
    const { requestId, cardId } = await permissionCard();
    const mirror = await message(askMeta({ mirrorOf: cardId }));
    const ref = (await resolveDecision(pool, mirror))!;
    expect(await decide(pool, ref, alice.accountId, { option: 'approve', via: 'mirror' })).toEqual({ kind: 'ask', result: 'forbidden' });
    expect(await status(requestId)).toBe('pending');
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

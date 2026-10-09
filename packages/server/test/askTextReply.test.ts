// 선택 카드 A′ — 사람이 카드를 누르지 않고 글로 답하면 카드가 `replied` 로 닫힌다(2026-10-09, 스레드 596146cc).
// 그리고 supersedes — 물어본 쪽이 새 카드로 옛 카드를 대신한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { checkAskSupersede, postMessage, supersedeAsk } from '../src/services/messages.js';
import type { AskMeta } from '@harkroom/shared';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let agentId: string;
let agentPat: string;
let memberToken: string;
let memberId: string;
let channelId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const OPTIONS = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: agentId, pat: agentPat } = await createAgent(app, adminToken, 'replybot'));
  ({ token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'replymember'));
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'ask-reply' } });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

/** 스레드 머리 하나와 그 안의 카드 하나를 심는다. 머리는 사람 글이다. */
async function seedThreadWithAsk(
  ask: Partial<AskMeta['ask']> = {}, extraMeta: Record<string, unknown> = {},
): Promise<{ rootId: string; askId: string }> {
  const root = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(memberToken), payload: { body: '해 줘' },
  });
  const rootId = root.json().message?.id ?? root.json().id;
  const meta = { kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' }, ...ask }, ...extraMeta };
  const posted = await postMessage(pool, { channelId, authorId: agentId, body: '골라 줘', threadRootId: rootId, meta });
  return { rootId, askId: (posted as { message: { id: string } }).message.id };
}

const reply = (token: string, rootId: string, body = '이건 다르게 해 줘') => app.inject({
  method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body, threadRootId: rootId },
});
const askOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta.ask;

describe('글로 답하면 카드가 접힌다(A′)', () => {
  it('사람이 같은 스레드에 글을 쓰면 열린 카드가 replied 로 닫힌다', async () => {
    const { rootId, askId } = await seedThreadWithAsk();
    const res = await reply(memberToken, rootId);
    expect(res.statusCode).toBe(201);
    const replyId = res.json().message?.id ?? res.json().id;
    expect(await askOf(askId)).toMatchObject({ closedBy: memberId, closedReason: 'replied', replyMessageId: replyId });
    expect((await askOf(askId)).closedAt).toBeTruthy();
  });

  it('replied 로 닫힌 카드도 늦게 고를 수 있다', async () => {
    const { rootId, askId } = await seedThreadWithAsk();
    await reply(memberToken, rootId);
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${askId}/ask-answer`,
      headers: auth(memberToken), payload: { optionId: 'b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.ask.answeredWith).toBe('b');
  });

  it('에이전트 글은 카드를 닫지 않는다', async () => {
    const { rootId, askId } = await seedThreadWithAsk();
    const res = await reply(agentPat, rootId, '보충한다');
    expect(res.statusCode).toBe(201);
    expect((await askOf(askId)).closedAt).toBeUndefined();
  });

  it('남에게 간 카드는 다른 사람 글로 닫히지 않는다', async () => {
    const { rootId, askId } = await seedThreadWithAsk({ to: { kind: 'account', accountId: agentId } });
    await reply(memberToken, rootId);
    expect((await askOf(askId)).closedAt).toBeUndefined();
  });

  it('권한 요청·머지 거절·거울 카드는 글로 닫지 않는다', async () => {
    const perm = await seedThreadWithAsk({}, { permissionRequest: { id: 'x' } });
    await reply(memberToken, perm.rootId);
    expect((await askOf(perm.askId)).closedAt).toBeUndefined();

    const denial = await seedThreadWithAsk({}, { mergeDenial: { denialId: 'x' } });
    await reply(memberToken, denial.rootId);
    expect((await askOf(denial.askId)).closedAt).toBeUndefined();

    const original = await seedThreadWithAsk();
    const mirror = await seedThreadWithAsk({ mirrorOf: original.askId });
    await reply(memberToken, mirror.rootId);
    expect((await askOf(mirror.askId)).closedAt).toBeUndefined();
  });

  it('원본이 글 답으로 닫히면 거울도 같은 사유로 닫힌다', async () => {
    const original = await seedThreadWithAsk();
    const mirror = await seedThreadWithAsk({ mirrorOf: original.askId });
    await reply(memberToken, original.rootId);
    expect(await askOf(mirror.askId)).toMatchObject({ closedReason: 'replied', closedBy: memberId });
  });

  it('「답하지 않기」로 닫힌 카드는 글이 와도 그대로다', async () => {
    const { rootId, askId } = await seedThreadWithAsk();
    const closed = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${askId}/ask-close`, headers: auth(memberToken),
    });
    expect(closed.statusCode).toBe(200);
    await reply(memberToken, rootId);
    expect((await askOf(askId)).closedReason).toBe('declined');
  });
});

describe('supersedes — 새 카드가 옛 카드를 대신한다', () => {
  it('글 답으로 닫힌 내 카드를 같은 스레드의 새 카드가 대신한다', async () => {
    const { rootId, askId } = await seedThreadWithAsk();
    await reply(memberToken, rootId);
    expect(await checkAskSupersede(pool, { oldId: askId, callerId: agentId, channelId, threadRootId: rootId })).toBeNull();
    const next = await postMessage(pool, {
      channelId, authorId: agentId, body: '다시 묻는다', threadRootId: rootId,
      meta: { kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' } } },
    });
    const newId = (next as { message: { id: string } }).message.id;
    await supersedeAsk(pool, { oldId: askId, newId, actorId: agentId });
    expect(await askOf(askId)).toMatchObject({ closedReason: 'superseded', supersededBy: newId });
  });

  it('남의 카드·다른 스레드·답한 카드·답하지 않기로 닫힌 카드는 거절한다', async () => {
    const { rootId, askId } = await seedThreadWithAsk();
    expect(await checkAskSupersede(pool, { oldId: askId, callerId: memberId, channelId, threadRootId: rootId })).toBe('supersedes_not_yours');
    const other = await seedThreadWithAsk();
    expect(await checkAskSupersede(pool, { oldId: askId, callerId: agentId, channelId, threadRootId: other.rootId })).toBe('supersedes_other_thread');

    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${askId}/ask-answer`,
      headers: auth(memberToken), payload: { optionId: 'a' },
    });
    expect(await checkAskSupersede(pool, { oldId: askId, callerId: agentId, channelId, threadRootId: rootId })).toBe('supersedes_resolved');

    const declined = await seedThreadWithAsk();
    await app.inject({ method: 'POST', url: `/channels/${channelId}/messages/${declined.askId}/ask-close`, headers: auth(memberToken) });
    expect(await checkAskSupersede(pool, { oldId: declined.askId, callerId: agentId, channelId, threadRootId: declined.rootId })).toBe('supersedes_resolved');
  });

  it('권한 요청 카드는 내 카드여도 대신하지 못한다(security F1)', async () => {
    const perm = await seedThreadWithAsk({}, { permissionRequest: { id: 'x' } });
    expect(await checkAskSupersede(pool, { oldId: perm.askId, callerId: agentId, channelId, threadRootId: perm.rootId })).toBe('supersedes_permission_card');
    // 검사를 건너뛰어도 update 가 권한 카드를 건드리지 않는다.
    await supersedeAsk(pool, { oldId: perm.askId, newId: perm.rootId, actorId: agentId });
    expect((await askOf(perm.askId)).closedAt).toBeUndefined();
  });

  it('superseded 로 닫힌 옛 카드는 늦은 답을 받지 않는다(security n1)', async () => {
    const { rootId, askId } = await seedThreadWithAsk();
    const next = await postMessage(pool, {
      channelId, authorId: agentId, body: '다시 묻는다', threadRootId: rootId,
      meta: { kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' } } },
    });
    await supersedeAsk(pool, { oldId: askId, newId: (next as { message: { id: string } }).message.id, actorId: agentId });
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages/${askId}/ask-answer`,
      headers: auth(memberToken), payload: { optionId: 'a' },
    });
    expect(res.statusCode).toBe(409);
    expect((await askOf(askId)).answeredWith).toBeUndefined();
  });
});

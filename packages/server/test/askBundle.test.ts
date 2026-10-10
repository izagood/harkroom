// 선택 카드 P1 — 묶음 카드(2026-10-10, 스레드 596146cc). 관리 에이전트가 여러 에이전트의 사람 앞 카드를 한 장에 줄로
// 모으고, 사람이 줄을 고르면 원본에 그 사람 이름으로 적힌다. 「추천대로」는 되돌릴 수 없는 줄을 서버가 뺀다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { postMessage, supersedeAsk } from '../src/services/messages.js';
import { isIrreversible, resolveBundleItem, upsertAskBundle } from '../src/services/askBundles.js';
import { readThreadStatusFacts } from '../src/services/threadStatus.js';
import { enqueueBundlePush } from '../src/services/push/pushJobs.js';
import { hashToken } from '../src/auth/tokens.js';
import type { AskMeta } from '@harkroom/shared';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let workerId: string;
let pmId: string;
let memberToken: string;
let memberId: string;
let workChannel: string;
let pmChannel: string;
let pmRoot: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const OPTIONS = [{ id: 'a', label: '이걸로', recommended: true }, { id: 'b', label: '저걸로' }];

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ accountId: workerId } = await createAgent(app, adminToken, 'bundleworker'));
  ({ accountId: pmId } = await createAgent(app, adminToken, 'bundlepm'));
  ({ token: memberToken, accountId: memberId } = await createMember(app, adminToken, 'bundlemember'));
  workChannel = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'bundle-work' } })).json().id;
  pmChannel = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'bundle-task' } })).json().id;
  const root = await app.inject({ method: 'POST', url: `/channels/${pmChannel}/messages`, headers: auth(memberToken), payload: { body: '결정 모음' } });
  pmRoot = root.json().message?.id ?? root.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const idOf = (posted: unknown) => (posted as { message: { id: string } }).message.id;

/** 작업 채널에 스레드 하나와 그 안의 사람 앞 카드 하나를 심는다. */
async function seedAsk(
  ask: Partial<AskMeta['ask']> = {}, extraMeta: Record<string, unknown> = {}, body = '골라 줘',
): Promise<{ threadId: string; askId: string }> {
  const head = await app.inject({ method: 'POST', url: `/channels/${workChannel}/messages`, headers: auth(memberToken), payload: { body: '해 줘' } });
  const threadId = head.json().message?.id ?? head.json().id;
  const meta = { kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' }, ...ask }, ...extraMeta };
  const posted = await postMessage(pool, { channelId: workChannel, authorId: workerId, body, threadRootId: threadId, meta });
  return { threadId, askId: idOf(posted) };
}

async function bundleOf(rootIds: string[], bundleId?: string) {
  return upsertAskBundle(pool, { callerId: pmId, channelId: pmChannel, threadRootId: pmRoot, body: '정할 것', rootIds, bundleId });
}
const askOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta.ask;
const itemsOf = async (id: string) => (await pool.query(`select meta from message where id = $1`, [id])).rows[0].meta.askBundle.items;

describe('묶음 카드 세우기 — 줄마다 거울 검사', () => {
  it('사람 앞 카드 둘을 한 장에 담는다. 권한 요청 카드는 링크 줄이다', async () => {
    const one = await seedAsk({ prompt: 'PAT 범위' });
    const perm = await seedAsk({}, { permissionRequest: { id: 'x' } });
    const res = await bundleOf([one.askId, perm.askId]);
    expect(res.ok).toBe(true);
    const items = await itemsOf((res as { message: { id: string } }).message.id);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ rootId: one.askId, prompt: 'PAT 범위', askerId: workerId, channelId: workChannel });
    expect(items[0].options[0]).toMatchObject({ id: 'a', recommended: true });
    expect(items[1]).toMatchObject({ rootId: perm.askId, link: true });
  });

  it('머지 거절 카드도 링크 줄이다 — 묶음에서 답하지 못한다(security n3)', async () => {
    const denial = await seedAsk({}, { mergeDenial: { denialId: 'x' } });
    const bundleId = ((await bundleOf([denial.askId])) as { message: { id: string } }).message.id;
    expect((await itemsOf(bundleId))[0]).toMatchObject({ rootId: denial.askId, link: true });
    const res = await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages/${bundleId}/ask-bundle/answer`,
      headers: auth(memberToken), payload: { rootId: denial.askId, optionId: 'a' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('거울·에이전트 앞·정해진 카드는 거절한다', async () => {
    const original = await seedAsk();
    const mirror = await seedAsk({ mirrorOf: original.askId });
    expect(await bundleOf([mirror.askId])).toMatchObject({ ok: false, code: 'mirror_of_mirror' });
    const toAgent = await seedAsk({ to: { kind: 'account', accountId: pmId } });
    expect(await bundleOf([toAgent.askId])).toMatchObject({ ok: false, code: 'mirror_not_human' });
    const closed = await seedAsk({ closedAt: new Date().toISOString(), closedReason: 'declined' });
    expect(await bundleOf([closed.askId])).toMatchObject({ ok: false, code: 'mirror_resolved' });
  });

  it('같은 bundleId 에 줄을 더한다. 남의 묶음은 고치지 못한다', async () => {
    const one = await seedAsk();
    const two = await seedAsk();
    const first = await bundleOf([one.askId]);
    const bundleId = (first as { message: { id: string } }).message.id;
    expect((await bundleOf([two.askId, one.askId], bundleId)).ok).toBe(true);
    expect((await itemsOf(bundleId)).map((i: { rootId: string }) => i.rootId)).toEqual([one.askId, two.askId]);
    const foreign = await upsertAskBundle(pool, { callerId: workerId, channelId: pmChannel, threadRootId: pmRoot, body: 'x', rootIds: [two.askId], bundleId });
    expect(foreign).toMatchObject({ ok: false, code: 'bundle_not_yours' });
  });
});

describe('줄에 답하기 — 원본에 누른 사람 이름으로', () => {
  it('사람이 줄을 고르면 원본에 그 사람 이름으로 적힌다', async () => {
    const one = await seedAsk();
    const bundleId = ((await bundleOf([one.askId])) as { message: { id: string } }).message.id;
    const res = await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages/${bundleId}/ask-bundle/answer`,
      headers: auth(memberToken), payload: { rootId: one.askId, optionId: 'b' },
    });
    expect(res.statusCode).toBe(200);
    expect(await askOf(one.askId)).toMatchObject({ answeredWith: 'b', answeredBy: memberId });
  });

  it('권한 요청 링크 줄·묶음에 없는 원본·다른 채널 경로는 거절한다', async () => {
    const perm = await seedAsk({}, { permissionRequest: { id: 'x' } });
    const stranger = await seedAsk();
    const bundleId = ((await bundleOf([perm.askId])) as { message: { id: string } }).message.id;
    const link = await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages/${bundleId}/ask-bundle/answer`,
      headers: auth(memberToken), payload: { rootId: perm.askId, optionId: 'a' },
    });
    expect(link.statusCode).toBe(403);
    expect((await askOf(perm.askId)).answeredWith).toBeUndefined();
    const notRow = await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages/${bundleId}/ask-bundle/answer`,
      headers: auth(memberToken), payload: { rootId: stranger.askId, optionId: 'a' },
    });
    expect(notRow.statusCode).toBe(404);
    const wrongChannel = await app.inject({
      method: 'POST', url: `/channels/${workChannel}/messages/${bundleId}/ask-bundle/answer`,
      headers: auth(memberToken), payload: { rootId: perm.askId, optionId: 'a' },
    });
    expect(wrongChannel.statusCode).toBe(404);
  });
});

describe('「추천대로」 — 되돌릴 수 없는 줄은 서버가 뺀다', () => {
  it('추천이 하나인 보통 줄만 답하고 나머지는 사유와 함께 남긴다', async () => {
    const plain = await seedAsk({ prompt: '문구를 어떻게 할까' });
    const merge = await seedAsk({ prompt: 'PR #12 를 머지할까' });
    const flagged = await seedAsk({ prompt: '이름을 바꿀까', irreversible: true });
    const noRec = await seedAsk({ prompt: '색을 고를까', options: [{ id: 'a', label: '파랑' }, { id: 'b', label: '빨강' }] });
    const perm = await seedAsk({}, { permissionRequest: { id: 'x' } });
    const bundleId = ((await bundleOf([plain.askId, merge.askId, flagged.askId, noRec.askId, perm.askId])) as { message: { id: string } }).message.id;
    const res = await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages/${bundleId}/ask-bundle/accept-recommended`, headers: auth(memberToken),
    });
    expect(res.statusCode).toBe(200);
    const outcomes = Object.fromEntries(res.json().results.map((r: { rootId: string; outcome: string }) => [r.rootId, r.outcome]));
    expect(outcomes).toEqual({
      [plain.askId]: 'answered', [merge.askId]: 'skipped_irreversible', [flagged.askId]: 'skipped_irreversible',
      [noRec.askId]: 'skipped_no_recommendation', [perm.askId]: 'skipped_link',
    });
    // 일괄 답에는 표지가 남는다 — 머지·비밀 래퍼가 이것을 사람이 띄운 턴으로 세지 않는다(security F1).
    expect(await askOf(plain.askId)).toMatchObject({ answeredWith: 'a', answeredBy: memberId, answeredVia: 'bundle_bulk' });
    expect((await askOf(merge.askId)).answeredWith).toBeUndefined();
  });

  it('줄 하나를 골라 누른 답에는 표지가 없다', async () => {
    const one = await seedAsk();
    const bundleId = ((await bundleOf([one.askId])) as { message: { id: string } }).message.id;
    await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages/${bundleId}/ask-bundle/answer`,
      headers: auth(memberToken), payload: { rootId: one.askId, optionId: 'a' },
    });
    const ask = await askOf(one.askId);
    expect(ask.answeredWith).toBe('a');
    expect(ask).not.toHaveProperty('answeredVia');
  });

  it('isIrreversible 은 권한·머지 거절 카드·표시·낱말을 모두 잡는다', () => {
    const ask = (over: Record<string, unknown> = {}) => ({ kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'human' }, ...over } });
    expect(isIrreversible({ ...ask(), permissionRequest: {} }, '')).toBe(true);
    expect(isIrreversible({ ...ask(), mergeDenial: {} }, '')).toBe(true);
    expect(isIrreversible(ask({ irreversible: true }), '')).toBe(true);
    expect(isIrreversible(ask(), 'v0.4.21 배포를 할까')).toBe(true);
    expect(isIrreversible(ask({ options: [{ id: 'a', label: 'secret 회전' }, { id: 'b', label: '그대로' }] }), '')).toBe(true);
    expect(isIrreversible(ask(), '버튼 문구를 고를까')).toBe(false);
  });
});

describe('askBundleResolve — 묶음 스레드의 사람 글로 한 줄을 닫는다', () => {
  it('사람 글을 근거로 원본을 그 사람 이름의 「글로 답함」으로 닫고 요지를 싣는다', async () => {
    const one = await seedAsk();
    const bundleId = ((await bundleOf([one.askId])) as { message: { id: string } }).message.id;
    const said = await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages`, headers: auth(memberToken), payload: { body: 'PAT 는 다르게 하자', threadRootId: pmRoot },
    });
    const replyId = said.json().message?.id ?? said.json().id;
    // 묶음 스레드의 글은 줄을 자동으로 닫지 않는다(묶음에는 ask meta 가 없다).
    expect((await askOf(one.askId)).closedAt).toBeUndefined();
    const res = await resolveBundleItem(pool, { callerId: pmId, bundleId, rootId: one.askId, replyMessageId: replyId, note: 'PAT 는 다르게' });
    expect(res.ok).toBe(true);
    expect(await askOf(one.askId)).toMatchObject({
      closedReason: 'replied', closedBy: memberId, replyMessageId: replyId, replyNote: 'PAT 는 다르게', replyNoteBy: pmId,
    });
    const woke = await pool.query(`select 1 from inbox where account_id = $1 and message_id = $2 and reason = 'ask_closed'`, [workerId, one.askId]);
    expect(woke.rowCount).toBe(1);
  });

  it('에이전트 글·남의 묶음은 근거가 되지 못한다', async () => {
    const one = await seedAsk();
    const bundleId = ((await bundleOf([one.askId])) as { message: { id: string } }).message.id;
    const agentSaid = await postMessage(pool, { channelId: pmChannel, authorId: pmId, body: '내가 정했다', threadRootId: pmRoot });
    expect(await resolveBundleItem(pool, { callerId: pmId, bundleId, rootId: one.askId, replyMessageId: idOf(agentSaid) }))
      .toMatchObject({ ok: false, code: 'bundle_reply_invalid' });
    const said = await app.inject({
      method: 'POST', url: `/channels/${pmChannel}/messages`, headers: auth(memberToken), payload: { body: '다르게', threadRootId: pmRoot },
    });
    expect(await resolveBundleItem(pool, { callerId: workerId, bundleId, rootId: one.askId, replyMessageId: said.json().message?.id ?? said.json().id }))
      .toMatchObject({ ok: false, code: 'bundle_not_yours' });
    expect((await askOf(one.askId)).closedAt).toBeUndefined();
  });
});

describe('supersedes — 새 카드가 같은 묶음에 들어간다', () => {
  it('옛 줄을 담은 묶음에 새 카드가 줄로 더해진다', async () => {
    const one = await seedAsk();
    const bundleId = ((await bundleOf([one.askId])) as { message: { id: string } }).message.id;
    const next = await postMessage(pool, {
      channelId: workChannel, authorId: workerId, body: '다시 묻는다', threadRootId: one.threadId,
      meta: { kind: 'ask', ask: { options: OPTIONS, to: { kind: 'human' } } },
    });
    await supersedeAsk(pool, { oldId: one.askId, newId: idOf(next), actorId: workerId });
    expect((await itemsOf(bundleId)).map((i: { rootId: string }) => i.rootId)).toEqual([one.askId, idOf(next)]);
  });
});

describe('🙋·Inbox 는 묶음 하나에 한 줄(3c)', () => {
  /** 채널 목록에서 그 스레드 머리의 열린 사람 물음 수. */
  const headCount = async (channel: string, rootId: string) => {
    const res = await app.inject({ method: 'GET', url: `/channels/${channel}/messages?limit=200`, headers: auth(memberToken) });
    const rows = (res.json().messages ?? res.json()) as { id: string; openAskHumanCount: number | null }[];
    return rows.find((r) => r.id === rootId)?.openAskHumanCount;
  };

  it('묶음에 담긴 원본은 원 스레드에서 세지 않고, 묶음 스레드가 하나로 센다', async () => {
    const pmHead = await app.inject({ method: 'POST', url: `/channels/${pmChannel}/messages`, headers: auth(memberToken), payload: { body: '3c 모음' } });
    const pmThread = pmHead.json().message?.id ?? pmHead.json().id;
    const one = await seedAsk();
    const two = await seedAsk();
    expect(await headCount(workChannel, one.threadId)).toBe(1);

    await upsertAskBundle(pool, { callerId: pmId, channelId: pmChannel, threadRootId: pmThread, body: '정할 것', rootIds: [one.askId, two.askId] });
    expect(await headCount(workChannel, one.threadId)).toBe(0);
    expect(await headCount(workChannel, two.threadId)).toBe(0);
    // 줄이 둘이어도 묶음 하나에 한 번이다.
    expect(await headCount(pmChannel, pmThread)).toBe(1);
    expect((await readThreadStatusFacts(pool, one.threadId))!.facts.humanAsk).toBeNull();
    expect((await readThreadStatusFacts(pool, pmThread))!.facts.humanAsk).toMatchObject({ askerId: pmId });

    // 한 줄이 정해져도 열린 줄이 남으면 그대로, 다 정해지면 0.
    await app.inject({ method: 'POST', url: `/channels/${workChannel}/messages/${one.askId}/ask-answer`, headers: auth(memberToken), payload: { optionId: 'a' } });
    expect(await headCount(pmChannel, pmThread)).toBe(1);
    await app.inject({ method: 'POST', url: `/channels/${workChannel}/messages/${two.askId}/ask-close`, headers: auth(memberToken) });
    expect(await headCount(pmChannel, pmThread)).toBe(0);
    expect((await readThreadStatusFacts(pool, pmThread))!.facts.humanAsk).toBeNull();
  });
});

describe('묶음 푸시는 1분 안의 것을 하나로(3c)', () => {
  it('같은 사람·같은 묶음에 나가지 않은 푸시가 있으면 더 넣지 않는다', async () => {
    const session = memberToken;
    await pool.query(
      `insert into push_device (account_id, session_token_hash, platform, apns_env, token, prefs)
       values ($1, $2, 'ios', 'production', $3, '{}')`, [memberId, hashToken(session), 'b'.repeat(64)]);
    // 이 사람이 끼지 않은 스레드에 세운다 — 답글 푸시가 따로 생기지 않게.
    const head = await app.inject({ method: 'POST', url: `/channels/${pmChannel}/messages`, headers: auth(adminToken), payload: { body: '푸시 모음' } });
    const headId = head.json().message?.id ?? head.json().id;
    const one = await seedAsk();
    const bundle = await upsertAskBundle(pool, { callerId: pmId, channelId: pmChannel, threadRootId: headId, body: '정할 것', rootIds: [one.askId] });
    const bundleId = (bundle as { message: { id: string } }).message.id;
    await enqueueBundlePush(pool, memberId, bundleId);
    await enqueueBundlePush(pool, memberId, bundleId);
    await enqueueBundlePush(pool, memberId, bundleId);
    const jobs = await pool.query(
      `select not_before > now() + interval '50 seconds' as delayed from push_job where account_id = $1 and message_id = $2`, [memberId, bundleId]);
    expect(jobs.rowCount).toBe(1);
    expect(jobs.rows[0].delayed).toBe(true);
    // 이미 다른 사유(답글·멘션)로 나갈 푸시가 있는 묶음 글에는 둘째 알림을 얹지 않는다.
    const replied = await bundleOf([(await seedAsk()).askId]);
    const repliedId = (replied as { message: { id: string } }).message.id;
    const before = (await pool.query(`select count(*)::int as n from push_job where account_id = $1 and message_id = $2`, [memberId, repliedId])).rows[0].n;
    await enqueueBundlePush(pool, memberId, repliedId);
    const after = (await pool.query(`select count(*)::int as n from push_job where account_id = $1 and message_id = $2`, [memberId, repliedId])).rows[0].n;
    expect(after).toBe(Math.max(before, 1));
    // 에이전트에게는 넣지 않는다.
    await enqueueBundlePush(pool, pmId, bundleId);
    expect((await pool.query(`select 1 from push_job where account_id = $1`, [pmId])).rowCount).toBe(0);
  });
});

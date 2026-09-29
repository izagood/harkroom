import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { MENTION_EDIT_SKIPPED_HEADER, NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';

/**
 * 수정으로 넣은 멘션도 부른다(jaebin 승인 D1~D5, `editMessage` 머리 주석).
 * 처음엔 멘션 없이 쓰고 나중에 고쳐 `@handle` 을 넣으면 그 대상의 턴이 떠야 한다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botPat: string;
let botId: string;
let peerId: string;
let member: { token: string; accountId: string };
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: botPat, accountId: botId } = await createAgent(app, adminToken, 'edbot'));
  ({ accountId: peerId } = await createAgent(app, adminToken, 'edpeer'));
  member = await createMember(app, adminToken, 'edhuman');
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'editmention' } });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

async function post(token: string, body: string) {
  const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}
const edit = (token: string, id: string, body: string) =>
  app.inject({ method: 'PATCH', url: `/channels/${channelId}/messages/${id}`, headers: auth(token), payload: { body } });
async function inboxOf(messageId: string) {
  return (await pool.query(
    `select account_id, reason, via_edit from inbox where message_id = $1 order by id`, [messageId],
  )).rows as { account_id: string; reason: string; via_edit: boolean }[];
}

describe('edit adds a mention', () => {
  it('invokes an agent mentioned only by the edit, marked via_edit', async () => {
    const m = await post(adminToken, '멘션 없이 쓴 글');
    expect(await inboxOf(m.id)).toEqual([]);

    const res = await edit(adminToken, m.id, '@edbot 이거 봐 달라');

    expect(res.statusCode).toBe(200);
    expect(res.headers[NOTIFIED_COUNT_HEADER]).toBe('1');
    expect(res.headers[NOTIFIED_HEADER]).toBe(botId);
    expect(res.headers[MENTION_EDIT_SKIPPED_HEADER]).toBeUndefined();
    expect(await inboxOf(m.id)).toEqual([{ account_id: botId, reason: 'mention', via_edit: true }]);
  });

  // 러너는 `viaEdit` 로 "수정으로 추가된 멘션"을 안다(076). 게시로 생긴 항목에는 키가 없다.
  it('exposes viaEdit on the inbox entry only for edit-created calls', async () => {
    const posted = await post(adminToken, '@edbot 게시로 부름');
    const later = await post(adminToken, '나중에 고칠 글');
    await edit(adminToken, later.id, '@edbot 수정으로 부름');

    const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(botPat) });
    const entries = res.json().entries as { messageId: string; viaEdit?: boolean }[];

    expect(entries.find((e) => e.messageId === later.id)?.viaEdit).toBe(true);
    expect(entries.find((e) => e.messageId === posted.id)).not.toHaveProperty('viaEdit');
  });

  // D1 — 이미 이 메시지로 받은 사람은 다시 부르지 않는다. 넣었다 뺐다 다시 넣어도 그렇다.
  it('never calls the same account twice for one message', async () => {
    const m = await post(adminToken, '@edbot 처음부터 부른 글');
    expect(await inboxOf(m.id)).toHaveLength(1);

    const again = await edit(adminToken, m.id, '@edbot 처음부터 부른 글 (오타 고침)');
    expect(again.headers[NOTIFIED_COUNT_HEADER]).toBe('0');
    await edit(adminToken, m.id, '멘션을 뺐다');
    await edit(adminToken, m.id, '@edbot 다시 넣었다');

    const rows = await inboxOf(m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.via_edit).toBe(false);
  });

  it('calls only the newly added target', async () => {
    const m = await post(adminToken, '@edbot 하나만');

    const res = await edit(adminToken, m.id, '@edbot @edpeer 둘로 늘렸다');

    expect(res.headers[NOTIFIED_HEADER]).toBe(peerId);
    expect((await inboxOf(m.id)).map((r) => [r.account_id, r.via_edit])).toEqual([[botId, false], [peerId, true]]);
  });

  // 사람도 같은 inbox 로 알림을 받는다.
  it('notifies a human added by an edit', async () => {
    const m = await post(adminToken, '사람을 부르기 전');

    await edit(adminToken, m.id, '@edhuman 확인 부탁');

    expect((await inboxOf(m.id)).map((r) => r.account_id)).toEqual([member.accountId]);
  });

  // D4 — `@channel` 도 수정으로 부를 수 있고, 이미 받은 사람은 빠진다.
  it('fans out @channel added by an edit, skipping who already has it', async () => {
    const m = await post(adminToken, '@edbot 먼저');

    await edit(adminToken, m.id, '@edbot 먼저, 그리고 @channel');

    const rows = await inboxOf(m.id);
    expect(rows.filter((r) => r.account_id === botId)).toHaveLength(1);
    expect(rows.map((r) => r.account_id)).toEqual(expect.arrayContaining([botId, peerId, member.accountId]));
    expect(rows.map((r) => r.account_id)).not.toContain(adminId);
  });

  it('wakes a team lead added by an edit as a team mention', async () => {
    const team = (await app.inject({ method: 'POST', url: '/teams', headers: auth(adminToken), payload: { name: 'edteam' } })).json();
    await app.inject({ method: 'PUT', url: `/teams/${team.id}/members/${peerId}`, headers: auth(adminToken) });
    await app.inject({ method: 'PUT', url: `/teams/${team.id}/lead`, headers: auth(adminToken), payload: { accountId: peerId } });
    const m = await post(adminToken, '팀 부르기 전');

    await edit(adminToken, m.id, '@edteam 맡아 달라');

    expect(await inboxOf(m.id)).toEqual([{ account_id: peerId, reason: 'team_mention', via_edit: true }]);
  });

  // 호출 게이트는 수정에도 그대로 선다 — 막힌 부름은 meta 에 남는다.
  it('applies the invoke gate and records the denial', async () => {
    const privy = await createAgent(app, adminToken, 'edprivy');
    await app.inject({
      method: 'PATCH', url: `/accounts/agents/${privy.accountId}`, headers: auth(adminToken),
      payload: { ownerAccountId: adminId, invokeScope: 'owner' },
    });
    const m = await post(member.token, '게이트 확인 전');

    const res = await edit(member.token, m.id, '@edprivy 불러 본다');

    expect(await inboxOf(m.id)).toEqual([]);
    expect(res.json().meta.mentionDenied).toEqual(['edprivy']);
  });

  // D2 — 작성 뒤 24시간이 지나면 저장만 하고 부르지 않는다. 이유는 헤더로 돌려준다.
  it('does not invoke from an edit of a message older than 24 hours', async () => {
    const m = await post(adminToken, '오래된 글');
    await pool.query(`update message set created_at = now() - interval '25 hours' where id = $1`, [m.id]);

    const res = await edit(adminToken, m.id, '@edbot 뒤늦게');

    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe(`<@${botId}> 뒤늦게`);
    expect(res.headers[MENTION_EDIT_SKIPPED_HEADER]).toBe('too_old');
    expect(await inboxOf(m.id)).toEqual([]);
  });

  it('does not report a skip when the old edit adds no mention', async () => {
    const m = await post(adminToken, '오래된 글 둘');
    await pool.query(`update message set created_at = now() - interval '25 hours' where id = $1`, [m.id]);

    const res = await edit(adminToken, m.id, '오래된 글 둘 (오타)');

    expect(res.headers[MENTION_EDIT_SKIPPED_HEADER]).toBeUndefined();
  });

  // D3 — 에이전트가 쓴 글의 수정은 부르지 않는다.
  it('does not invoke from an edit of an agent-authored message', async () => {
    const m = await post(botPat, '에이전트의 보고');

    const res = await edit(botPat, m.id, '@edpeer 에이전트가 고쳐 부른다');

    expect(res.headers[MENTION_EDIT_SKIPPED_HEADER]).toBe('agent_author');
    expect(await inboxOf(m.id)).toEqual([]);
  });
});

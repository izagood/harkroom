// 인박스 항목은 **지금 볼 수 있는 채널의 것만** 나간다(#1018 security F1 후속, 2026-10-02).
//
// 항목은 부를 때의 가시성으로 만들어지고 남는다 — 비공개 채널에서 내보내져도 inbox 행은 그대로다
// (`removeChannelMember`). 거르지 않으면 나간 사람이 그 채널의 본문을 인박스로 계속 받는다.
// 러너의 `inbox.poll` 도 같은 `listInbox(unreadOnly)` 를 쓰므로 여기서 함께 잰다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { InboxEntry } from '@harkroom/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { listInbox, postMessage } from '../src/services/messages.js';
import { addChannelMember, removeChannelMember } from '../src/services/channels.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let botId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: botId } = await createAgent(app, adminToken, 'visbot'));
});
afterAll(async () => { await app.close(); await stop(); });

async function channel(name: string, visibility: 'public' | 'private') {
  const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name, visibility } });
  expect(ch.statusCode).toBe(201);
  return ch.json().id as string;
}
async function callAdmin(channelId: string, body: string) {
  const posted = await postMessage(pool, { channelId, authorId: botId, body, threadRootId: null, meta: {} });
  return (posted as { message: { id: string } }).message.id;
}
async function rest(query: string): Promise<InboxEntry[]> {
  const res = await app.inject({ method: 'GET', url: `/inbox${query}`, headers: auth(adminToken) });
  expect(res.statusCode).toBe(200);
  return res.json().entries;
}
const has = (rows: InboxEntry[], messageId: string) => rows.some((e) => e.messageId === messageId);

describe('listInbox — 지금 볼 수 있는 채널만', () => {
  it('비공개 채널에서 내보내지면 그 부름이 인박스·안 읽음·러너 폴 어디에도 없다', async () => {
    const ch = await channel('vis-private', 'private');
    const id = await callAdmin(ch, '@admin 비공개 일');
    expect(has(await rest(''), id)).toBe(true);
    expect(has(await rest('?unread=1'), id)).toBe(true);
    expect(has(await listInbox(pool, adminId, { unreadOnly: true }), id)).toBe(true);

    await removeChannelMember(pool, ch, adminId);
    expect(has(await rest(''), id)).toBe(false);
    expect(has(await rest('?unread=1'), id)).toBe(false);
    // 러너의 inbox.poll 이 쓰는 그 호출 — 나간 채널의 부름으로는 턴이 뜨지 않는다.
    expect(has(await listInbox(pool, adminId, { unreadOnly: true }), id)).toBe(false);
    // 행은 지우지 않는다(다시 들어오면 다시 보인다).
    const row = await pool.query('select count(*)::int as n from inbox where message_id = $1 and account_id = $2', [id, adminId]);
    expect(row.rows[0].n).toBe(1);
  });

  it('다시 들어오면 다시 보인다', async () => {
    const ch = await channel('vis-rejoin', 'private');
    const id = await callAdmin(ch, '@admin 돌아올 일');
    await removeChannelMember(pool, ch, adminId);
    expect(has(await rest(''), id)).toBe(false);
    await addChannelMember(pool, ch, adminId);
    expect(has(await rest(''), id)).toBe(true);
  });

  it('공개 채널의 부름은 멤버가 아니어도 그대로 보인다', async () => {
    const ch = await channel('vis-public', 'public');
    const id = await callAdmin(ch, '@admin 공개 일');
    await removeChannelMember(pool, ch, adminId);
    expect(has(await rest(''), id)).toBe(true);
  });

  /**
   * **바뀐 동작**(PR 본문에 적음): 비공개 채널에서 그 채널의 멤버가 아닌 계정을 **직접** 부르면
   * 서버는 지금도 inbox 행을 만든다(집합·@channel 은 가시성으로 거르지만 직접 부름은 안 거른다).
   * 예전에는 그 행이 그대로 나가 비멤버가 비공개 본문을 받고, 에이전트면 읽지도 쓰지도 못할 채널로
   * 턴이 떴다. 이제 나가지 않는다.
   */
  it('비공개 채널에서 비멤버를 직접 부르면 그 부름은 나가지 않는다(턴도 안 뜬다)', async () => {
    const ch = await channel('vis-direct', 'private');
    const { accountId: strangerId } = await createAgent(app, adminToken, 'stranger');
    const posted = await postMessage(pool, { channelId: ch, authorId: adminId, body: '@stranger 비밀 일', threadRootId: null, meta: {} });
    const id = (posted as { message: { id: string } }).message.id;
    const row = await pool.query('select count(*)::int as n from inbox where message_id = $1 and account_id = $2', [id, strangerId]);
    expect(row.rows[0].n).toBe(1);
    expect(has(await listInbox(pool, strangerId, { unreadOnly: true }), id)).toBe(false);
  });
});

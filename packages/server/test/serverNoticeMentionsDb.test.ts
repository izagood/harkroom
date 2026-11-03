import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { recordBlocked } from '../src/services/blockedCards.js';

/**
 * 서버 알림 줄 멘션 원칙의 회귀(services/noticeText.ts) — 남이 쓴 글이 섞이는 막힘 카드 줄이 그 글 속 멘션으로
 * 아무도 부르지 않는다. 대조군으로 같은 글을 사람이 쓰면 부른다(시험이 「원래 안 부르던 것」을 재지 않게).
 */
let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let admin: { token: string; accountId: string };
let mina: { token: string; accountId: string };
let bot: { accountId: string; pat: string };
let ch: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const inboxFor = async (accountId: string, rootId: string) => (await pool.query(
  `select i.reason from inbox i join message m on m.id = i.message_id where i.account_id = $1 and (m.thread_root_id = $2 or m.id = $2)`,
  [accountId, rootId],
)).rows as { reason: string }[];

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  admin = await bootstrapAdmin(app);
  mina = await createMember(app, admin.token, 'mina');
  bot = await createAgent(app, admin.token, 'noticebot');
  ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'notice-mentions' } })).json().id;
  for (const id of [mina.accountId, bot.accountId]) {
    await app.inject({ method: 'POST', url: `/channels/${ch}/members`, headers: auth(admin.token), payload: { accountId: id } });
  }
});
afterAll(async () => { await app.close(); await stop(); });

describe('서버 알림 줄은 남이 쓴 글 속 멘션으로 부르지 않는다', () => {
  it('막힘 카드: 경로·연결 이름에 @mina·@channel 이 있어도 inbox 0', async () => {
    const root = (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(admin.token), payload: { body: 'root' } })).json().id as string;
    const id = await recordBlocked(pool, {
      agentId: bot.accountId, channelId: ch, threadRootId: root, code: 'no_grant',
      connectorId: null, connectorName: '@channel 연결', method: 'GET', path: '/v1/@mina <@' + mina.accountId + '>',
    });
    expect(id).not.toBeNull();
    expect(await inboxFor(mina.accountId, root)).toEqual([]);

    // 대조군: 사람이 같은 꼴로 쓰면 부른다.
    await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(admin.token), payload: { body: '@mina 봐 줘', threadRootId: root } });
    expect((await inboxFor(mina.accountId, root)).length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { postMessage } from '../src/services/messages.js';
import { runMigrations } from '../src/db/migrate.js';

/**
 * 시스템 줄 번역 표지(`meta.i18n`, i18n P5 ①)가 **DB 에 무엇으로 남는가**.
 *
 * - C1: 사람·에이전트 글에 실려 온 표지는 저장되지 않는다(`postMessage` 한 곳에서 막는다).
 * - 멤버 들고남 줄은 본문과 표지를 함께 남긴다(C8).
 * - 116 백필: 옛 멤버 줄만, 세 본문과 정확히 같은 줄만, 본문은 그대로, 다시 돌려도 같다(C6).
 */
const M116 = '116_system_i18n_member_backfill.sql';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let channelId: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` }, payload: { name: 'i18n' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const metaOf = async (id: string) =>
  (await pool.query<{ body: string; meta: Record<string, unknown> }>('select body, meta from message where id = $1', [id])).rows[0]!;

describe('C1 — 표지는 서버가 만든 시스템 줄에만 남는다', () => {
  const forged = { key: 'system.merge.merged', args: { repo: 'o/r', number: 1, sha: 'abc' } };

  it('사람 글(user)에 실린 meta.i18n 은 저장되지 않는다', async () => {
    const posted = await postMessage(pool, { channelId, authorId: adminId, body: 'hi', meta: { i18n: forged } });
    expect(posted.failure).toBeUndefined();
    expect((await metaOf(posted.message!.id)).meta).not.toHaveProperty('i18n');
  });

  it('진행 줄(progress)에 실린 것도 저장되지 않는다', async () => {
    const posted = await postMessage(pool, { channelId, authorId: adminId, body: 'p', kind: 'progress', meta: { i18n: forged } });
    expect((await metaOf(posted.message!.id)).meta).not.toHaveProperty('i18n');
  });

  it('시스템 줄이어도 목록 밖 키는 저장되지 않는다', async () => {
    const posted = await postMessage(pool, {
      channelId, authorId: adminId, body: 's', kind: 'system', meta: { i18n: { key: '__proto__', args: {} } },
    });
    expect((await metaOf(posted.message!.id)).meta).not.toHaveProperty('i18n');
  });

  it('REST 로 보낸 글의 몸에 meta 를 실어도 남지 않는다', async () => {
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'rest', meta: { i18n: forged } },
    });
    expect(res.statusCode).toBe(201);
    expect((await metaOf(res.json().id)).meta).not.toHaveProperty('i18n');
  });
});

describe('멤버 들고남 줄은 본문과 표지를 함께 남긴다(C8)', () => {
  it('초대하면 「추가」 본문과 system.member.added 표지가 같은 대상을 가리킨다', async () => {
    const { accountId } = await createMember(app, adminToken, 'mira');
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/members`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { accountId },
    });
    expect(res.statusCode).toBeLessThan(300);
    const row = (await pool.query<{ body: string; meta: Record<string, unknown> }>(
      `select body, meta from message where channel_id = $1 and kind = 'system' order by seq desc limit 1`, [channelId])).rows[0]!;
    expect(row.body).toBe('{account}님이 채널에 추가되었습니다.');
    expect(row.meta).toMatchObject({ accountId, i18n: { key: 'system.member.added', args: { accountId } } });
  });
});

describe('116 — 옛 멤버 줄 백필(C6)', () => {
  it('세 본문과 정확히 같은 옛 시스템 줄만 채우고, 본문은 그대로, 다시 돌려도 같다', async () => {
    const { accountId } = await createMember(app, adminToken, 'oldie');
    const insert = async (body: string, kind: string, meta: Record<string, unknown>) =>
      (await pool.query<{ id: string }>(
        `insert into message (channel_id, author_id, body, kind, meta) values ($1, $2, $3, $4, $5) returning id`,
        [channelId, adminId, body, kind, JSON.stringify(meta)])).rows[0]!.id;

    const added = await insert('{account}님이 채널에 추가되었습니다.', 'system', { accountId });
    const left = await insert('{account}님이 채널에서 나갔습니다.', 'system', { accountId });
    const removed = await insert('{account}님이 채널에서 제거되었습니다.', 'system', { accountId });
    // 걸리면 안 되는 것들
    const userSame = await insert('{account}님이 채널에 추가되었습니다.', 'user', { accountId });
    const noAccount = await insert('{account}님이 채널에 추가되었습니다.', 'system', {});
    const otherBody = await insert('{account}님이 이 스레드에서 x 의 모델 지정을 풀었습니다. 다음 턴부터 기본값으로 돕니다.', 'system', { accountId });
    const nearBody = await insert('{account}님이 채널에 추가되었습니다', 'system', { accountId });
    const already = await insert('{account}님이 채널에서 나갔습니다.', 'system', {
      accountId, i18n: { key: 'system.member.left', args: { accountId: 'kept' } },
    });

    const rerun = async () => {
      await pool.query('delete from schema_migrations where name = $1', [M116]);
      await runMigrations(pool);
    };
    await rerun();

    expect((await metaOf(added)).meta).toMatchObject({ i18n: { key: 'system.member.added', args: { accountId } } });
    expect((await metaOf(left)).meta).toMatchObject({ i18n: { key: 'system.member.left', args: { accountId } } });
    expect((await metaOf(removed)).meta).toMatchObject({ i18n: { key: 'system.member.removed', args: { accountId } } });
    expect((await metaOf(added)).body).toBe('{account}님이 채널에 추가되었습니다.');
    for (const id of [userSame, noAccount, otherBody, nearBody]) {
      expect((await metaOf(id)).meta, id).not.toHaveProperty('i18n');
    }
    // 이미 있는 표지는 덮지 않는다.
    expect((await metaOf(already)).meta).toMatchObject({ i18n: { args: { accountId: 'kept' } } });

    // 멱등: 한 번 더 돌려도 같다.
    const before = (await metaOf(added)).meta;
    await rerun();
    expect((await metaOf(added)).meta).toEqual(before);
  });
});

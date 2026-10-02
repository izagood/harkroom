import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { searchMessages, SEARCH_MAX_AUTHORS } from '../src/services/messages.js';

/**
 * `/search` 거르기(S1): 보낸 사람·기간·첨부·정렬, 결과 첨부 요약.
 *
 * security 가 짚은 셋을 고정한다 — ① 거르기는 가시성 술어 **안쪽**에서만 좁힌다(남의 private 채널을
 * 보낸 사람·첨부로 걸러도 안 나온다) ② `authorId` 개수 상한 ③ 첨부 요약은 보이는 메시지 것만.
 */

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let bobToken: string;
let bobId: string;
let pub: string;
let secret: string;
const ids: Record<string, string> = {};

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function post(token: string, channelId: string, body: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function attach(messageId: string, uploader: string, filename: string): Promise<void> {
  await pool.query(
    `insert into attachment (message_id, uploader_id, filename, content_type, size_bytes, storage_key, attached_at)
     values ($1, $2, $3, 'image/png', 10, $4, now())`,
    [messageId, uploader, filename, randomUUID()],
  );
}

const search = (token: string, qs: string) => app.inject({ method: 'GET', url: `/search?${qs}`, headers: auth(token) });
const bodies = (res: { json(): { messages: { body: string }[] } }) => res.json().messages.map((m) => m.body);

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ token: bobToken, accountId: bobId } = await createMember(app, adminToken, 'bob'));
  pub = (await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'pub' } })).json().id;
  secret = (await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'secret', visibility: 'private' },
  })).json().id;

  // 시각은 손으로 정한다 — 기간·최신순을 결정적으로 재려고.
  ids.old = await post(adminToken, pub, 'release plan old');
  ids.bob = await post(adminToken, pub, 'release plan by bob');
  ids.file = await post(adminToken, pub, 'release plan with screenshot');
  ids.hidden = await post(adminToken, secret, 'release plan hidden secret');
  await pool.query(`update message set created_at = '2026-09-01T00:00:00Z' where id = $1`, [ids.old]);
  await pool.query(`update message set created_at = '2026-09-20T00:00:00Z', author_id = $2 where id = $1`, [ids.bob, bobId]);
  await pool.query(`update message set created_at = '2026-09-25T00:00:00Z' where id = $1`, [ids.file]);
  // 못 보는 채널의 글도 bob 이 쓴 것처럼, 첨부도 달아 둔다 — 거르기가 넓히는 갈래가 없는지 본다.
  await pool.query(`update message set created_at = '2026-09-26T00:00:00Z', author_id = $2 where id = $1`, [ids.hidden, bobId]);
  await attach(ids.file, adminId, 'shot.png');
  await attach(ids.hidden, adminId, 'hidden.png');
});
afterAll(async () => { await app.close(); await stop(); });

describe('search filters (S1)', () => {
  it('authorId 로 그 사람이 쓴 것만, 여럿이면 그중 누구든', async () => {
    expect(bodies(await search(adminToken, `q=release&authorId=${bobId}`))).toEqual(['release plan hidden secret', 'release plan by bob']);
    const both = bodies(await search(adminToken, `q=release&authorId=${bobId}&authorId=${adminId}&sort=recent`));
    expect(both).toHaveLength(4);
  });

  it('after·before 는 [after, before) 구간', async () => {
    expect(bodies(await search(adminToken, 'q=release&after=2026-09-20T00:00:00Z&before=2026-09-26T00:00:00Z&sort=recent')))
      .toEqual(['release plan with screenshot', 'release plan by bob']);
    // 시간대가 붙은 시각도 그 순간으로 읽는다: 09-01 08:00 KST = 08-31 23:00Z → 09-01 00:00Z 글보다 앞.
    expect(bodies(await search(adminToken, 'q=release&before=2026-09-01T08:00:00%2B09:00'))).toEqual([]);
    expect(bodies(await search(adminToken, 'q=release&before=2026-09-01T10:00:00%2B09:00'))).toEqual(['release plan old']);
    expect(bodies(await search(adminToken, 'q=release&before=2026-09-02T00:00:00Z'))).toEqual(['release plan old']);
  });

  it('hasAttachment=true 는 첨부가 붙은 것만, 결과에 첨부 요약을 싣는다(storage_key 없이)', async () => {
    const res = await search(adminToken, `q=release&hasAttachment=true&channelId=${pub}`);
    expect(res.statusCode).toBe(200);
    const [m] = res.json().messages;
    expect(res.json().messages).toHaveLength(1);
    expect(m.body).toBe('release plan with screenshot');
    expect(m.attachments).toEqual([expect.objectContaining({ filename: 'shot.png', contentType: 'image/png', sizeBytes: 10 })]);
    expect(JSON.stringify(m.attachments)).not.toContain('storage');
    // false 는 거르지 않는다(없는 것만 고르는 뜻이 아니다).
    expect(bodies(await search(adminToken, `q=release&hasAttachment=false&channelId=${pub}`))).toHaveLength(3);
  });

  it('sort=recent 는 관련도와 상관없이 최신순', async () => {
    // 「release plan」 둘 다 맞는 글이 관련도로는 앞서도 최신순에서는 시각이 정한다.
    expect(bodies(await search(adminToken, `q=release plan&sort=recent&channelId=${pub}`)))
      .toEqual(['release plan with screenshot', 'release plan by bob', 'release plan old']);
  });

  it('① 거르기는 가시성 안쪽에서만 — 못 보는 private 채널의 글은 어떤 조합으로도 안 나온다', async () => {
    for (const qs of [
      'q=release',
      `q=release&authorId=${bobId}`,
      'q=release&hasAttachment=true',
      'q=hidden&after=2026-09-25T00:00:00Z',
      `q=secret&authorId=${bobId}&hasAttachment=true&sort=recent`,
    ]) {
      const res = await search(bobToken, qs);
      expect(res.statusCode, qs).toBe(200);
      expect(bodies(res), qs).not.toContain('release plan hidden secret');
    }
    // 같은 질의를 볼 수 있는 사람(admin)이 던지면 나온다 — 위 결과가 우연히 빈 것이 아니다.
    expect(bodies(await search(adminToken, `q=secret&authorId=${bobId}&hasAttachment=true`))).toEqual(['release plan hidden secret']);
  });

  it('③ 첨부 요약은 보이는 메시지 것만 — 남의 private 첨부 이름이 응답 어디에도 없다', async () => {
    const res = await search(bobToken, 'q=release&hasAttachment=true');
    expect(res.payload).not.toContain('hidden.png');
    expect(bodies(res)).toEqual(['release plan with screenshot']);
  });

  it(`② authorId 는 ${SEARCH_MAX_AUTHORS} 개까지 — 넘으면 400, 서비스도 앞 ${SEARCH_MAX_AUTHORS} 개로 자른다`, async () => {
    const many = Array.from({ length: SEARCH_MAX_AUTHORS + 1 }, () => randomUUID());
    const res = await search(adminToken, `q=release&${many.map((id) => `authorId=${id}`).join('&')}`);
    expect(res.statusCode).toBe(400);
    const ok = await search(adminToken, `q=release&${many.slice(0, SEARCH_MAX_AUTHORS).map((id) => `authorId=${id}`).join('&')}`);
    expect(ok.statusCode).toBe(200);
    // 서비스를 직접 불러도 상한 뒤의 id 는 버린다 — bob 이 열한 번째면 bob 의 글은 안 나온다.
    const page = await searchMessages(pool, adminId, 'release', { authorIds: [...many.slice(0, SEARCH_MAX_AUTHORS), bobId] });
    expect(page.messages).toEqual([]);
  });

  it('모양이 틀린 거르기는 400 — 조용히 무시하지 않는다', async () => {
    for (const qs of ['authorId=nope', 'after=yesterday', 'hasAttachment=1', 'sort=random']) {
      expect((await search(adminToken, `q=release&${qs}`)).statusCode, qs).toBe(400);
    }
  });
});

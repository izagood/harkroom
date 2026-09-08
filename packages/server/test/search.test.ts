import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { searchMessages } from '../src/services/messages.js';

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
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'archive' },
  });
  channelId = ch.json().id;
  for (const body of ['deploy pipeline is green', 'lunch anyone?', 'pipeline failed again']) {
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
    });
  }
});
afterAll(async () => { await app.close(); await stop(); });

describe('search', () => {
  it('finds messages by word, orders by seq desc, and respects limit', async () => {
    // Test 1: finds messages by word with correct seq desc ordering
    const res = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toHaveLength(2);
    expect(bodies).toContain('deploy pipeline is green');
    expect(bodies).toEqual(['pipeline failed again', 'deploy pipeline is green']); // newest first, seq desc

    // Test 2: limit parameter works (before soft delete, when 2 messages match)
    const allResults = await searchMessages(pool, adminId, 'pipeline');
    const limitedResults = await searchMessages(pool, adminId, 'pipeline', { limit: 1 });
    expect(allResults.messages).toHaveLength(2);
    expect(allResults.hasMore).toBe(false);
    // 잘렸다는 사실이 응답에 실린다 — 팔레트가 '더 보기'를 세울지 판단하는 유일한 근거다.
    expect(limitedResults.messages).toHaveLength(1);
    expect(limitedResults.hasMore).toBe(true);
    // offset 이 그 뒤를 잇는다(정렬이 rank 라 seq 커서는 이 순서에서 뜻이 없다).
    const second = await searchMessages(pool, adminId, 'pipeline', { limit: 1, offset: 1 });
    expect(second.messages[0]!.id).not.toBe(limitedResults.messages[0]!.id);
  });

  /**
   * 부실함의 대부분이 여기였다: `simple` config 는 어간을 떼지 않아 조사 하나가 붙으면
   * tsvector 매치가 통째로 죽는다(실측: '검색을' @@ '검색' → false). 부분문자열 갈래가
   * 그것과 파일명 부분일치를 살린다.
   */
  it('finds Korean words with a particle attached, and partial identifiers', async () => {
    for (const body of ['검색을 켜고 왔다', 'SearchPalette.tsx 를 고쳤다']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    const ko = await app.inject({
      method: 'GET', url: '/search?q=%EA%B2%80%EC%83%89', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ko.json().messages.map((m: { body: string }) => m.body)).toContain('검색을 켜고 왔다');

    const partial = await app.inject({
      method: 'GET', url: '/search?q=SearchPalette', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(partial.json().messages.map((m: { body: string }) => m.body)).toContain('SearchPalette.tsx 를 고쳤다');
  });

  /**
   * `_` 는 like 의 메타문자다("아무 글자 하나"). 이스케이프하지 않으면 `a_b` 로 찾을 때
   * `aXb` 가 딸려 온다 — 사람이 친 글자 그대로 찾는 것이 아니게 된다.
   *
   * 미끼(`zqzaXbzqz`)를 한 낱말로 둔 것은 tsvector 갈래가 이 줄을 대신 맞혀 버리지 않게
   * 하기 위해서다 — 그러면 이스케이프가 깨져도 초록이 된다.
   */
  it('treats like metacharacters in the query as literal text', async () => {
    for (const body of ['token zqza_bzqz here', 'token zqzaXbzqz here']) {
      await app.inject({
        method: 'POST', url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
      });
    }
    const res = await app.inject({
      method: 'GET', url: '/search?q=zqza_bzqz', headers: { authorization: `Bearer ${adminToken}` },
    });
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toContain('token zqza_bzqz here');
    expect(bodies).not.toContain('token zqzaXbzqz here');
  });

  /**
   * 진행 줄은 사람이 찾는 말이 아니다 — 답글 수에서 뺀 것과 같은 목록(shared::countsAsReply).
   * 여기 없으면 에이전트 진행 줄이 상위 N 건을 채워 정작 찾던 말이 응답에 안 들어온다.
   */
  it('leaves progress and wake lines out of the results', async () => {
    const posted = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'zebra anchor' },
    });
    await pool.query(
      `insert into message (id, channel_id, thread_root_id, author_id, body, kind)
       values (gen_random_uuid(), $1, $2, $3, 'zebra progress line', 'progress')`,
      [channelId, posted.json().id, adminId],
    );
    const res = await app.inject({
      method: 'GET', url: '/search?q=zebra', headers: { authorization: `Bearer ${adminToken}` },
    });
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toContain('zebra anchor');
    expect(bodies).not.toContain('zebra progress line');
  });

  /** ⌘F 스코프. 루트 자신도 포함한다 — 루트의 말을 못 찾으면 "이 스레드에서 찾기"가 아니다. */
  it('scopes to one thread, root included', async () => {
    const root = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'quokka root' },
    });
    const rootId = root.json().id;
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'quokka reply', threadRootId: rootId },
    });
    await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { body: 'quokka elsewhere' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=quokka&channelId=${channelId}&threadRootId=${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const bodies = res.json().messages.map((m: { body: string }) => m.body);
    expect(bodies.sort()).toEqual(['quokka reply', 'quokka root']);
  });

  it('excludes deleted messages', async () => {
    // Get a message to delete
    const res = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    const pipelineMessages = res.json().messages;
    const messageToDelete = pipelineMessages[0];

    // Soft delete the message
    await pool.query('update message set deleted_at = now() where id = $1', [messageToDelete.id]);

    // Verify deleted message is excluded from search
    const afterDelete = await app.inject({
      method: 'GET', url: '/search?q=pipeline', headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(afterDelete.json().messages).toHaveLength(1);
    expect(afterDelete.json().messages[0].body).toBe('deploy pipeline is green');
  });
});

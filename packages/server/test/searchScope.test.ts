import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

/**
 * #221 — "이 대화 안에서만 찾기"의 회귀선.
 *
 * 여기서 지키는 것은 두 가지다. 첫째, 스코프는 **서버 질의**를 좁힌다 — 전역 결과를 받아
 * 클라이언트에서 거르면 상위 N 건 밖으로 밀린 것은 애초에 손에 들어오지 않는다(`finds a match
 * that global search truncates away`가 그 경우를 실제로 만든다). 둘째, 스코프를 준다고
 * 가시성이 느슨해지지 않는다 — 볼 수 없는 채널을 스코프로 주면 403 이고 본문은 새지 않는다.
 */
let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let outsiderPat: string;
let alphaId: string;
let betaId: string;
let secretId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const SECRET_BODY = 'apple turnover classified';

async function createChannel(name: string, visibility: 'public' | 'private'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name, visibility },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function post(channelId: string, body: string): Promise<void> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body },
  });
  expect(res.statusCode).toBe(201);
}

async function search(token: string, q: string, channelId?: string) {
  const scope = channelId ? `&channelId=${channelId}` : '';
  return app.inject({ method: 'GET', url: `/search?q=${q}${scope}`, headers: auth(token) });
}

const bodiesOf = (res: { json: () => { messages: { body: string }[] } }): string[] =>
  res.json().messages.map((m) => m.body);

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ pat: outsiderPat } = await createAgent(app, adminToken, 'outsider'));

  alphaId = await createChannel('alpha', 'public');
  betaId = await createChannel('beta', 'public');
  secretId = await createChannel('secret', 'private');

  // beta 의 needle 을 **먼저** 넣는다. seq 는 전역 identity 라, 뒤이어 alpha 에 needle 이
  // 잔뜩 쌓이면 이 한 건은 전역 검색의 상위 50건 밖으로 밀려난다 — 5번 테스트의 무대다.
  await post(betaId, 'needle in the beta haystack');
  await post(betaId, 'apple cider vinegar');
  await post(alphaId, 'apple pie recipe');
  await post(secretId, SECRET_BODY);

  // 잡음 60건은 REST 를 거치지 않고 직접 넣는다 — 여기서 확인하려는 것은 POST 경로가 아니라
  // 전역 검색이 실제로 잘린다는 사실이고, `search` 는 생성 컬럼이라 INSERT 만으로 채워진다.
  for (let i = 0; i < 60; i += 1) {
    await pool.query(
      `insert into message (channel_id, author_id, body, kind) values ($1, $2, $3, 'user')`,
      [alphaId, adminId, `needle noise ${i}`],
    );
  }
});
afterAll(async () => { await app.close(); await stop(); });

describe('search channel scope (#221)', () => {
  it('returns only that channel when channelId is given', async () => {
    const res = await search(adminToken, 'apple', betaId);
    expect(res.statusCode).toBe(200);
    expect(bodiesOf(res)).toEqual(['apple cider vinegar']);
  });

  it('never returns another channel match under a scope', async () => {
    const res = await search(adminToken, 'apple', betaId);
    expect(bodiesOf(res)).not.toContain('apple pie recipe');
    expect(bodiesOf(res)).not.toContain(SECRET_BODY);
    // 반대 방향도 같아야 한다 — 스코프는 한쪽만 막는 것이 아니다.
    const other = await search(adminToken, 'apple', alphaId);
    expect(bodiesOf(other)).toEqual(['apple pie recipe']);
  });

  it('stays global when channelId is omitted', async () => {
    const res = await search(adminToken, 'apple');
    expect(res.statusCode).toBe(200);
    const bodies = bodiesOf(res);
    expect(bodies).toContain('apple pie recipe');
    expect(bodies).toContain('apple cider vinegar');
    expect(bodies).toContain(SECRET_BODY); // admin 은 secret 의 멤버다
  });

  it('403s on a channel the requester cannot see, and leaks no body', async () => {
    const res = await search(outsiderPat, 'apple', secretId);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(SECRET_BODY);
    expect(res.body).not.toContain('apple');
  });

  it('finds a match that global search truncates away', async () => {
    // 전제 확인: 전역으로는 잡히지 않는다. 이게 깨지면 아래 단언은 아무것도 증명하지 못한다.
    const global = await search(adminToken, 'needle');
    expect(bodiesOf(global)).not.toContain('needle in the beta haystack');

    const scoped = await search(adminToken, 'needle', betaId);
    expect(bodiesOf(scoped)).toEqual(['needle in the beta haystack']);
  });

  it('rejects a malformed channelId instead of silently going global', async () => {
    const res = await search(adminToken, 'apple', 'not-a-uuid');
    expect(res.statusCode).toBe(400);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let token: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  token = (await bootstrapAdmin(app)).token;
});
afterAll(async () => {
  await app.close();
  await stop();
});

/**
 * 앱과 러너는 본문 없는 POST 를 쓴다 — 그때 `content-type` 을 붙이지 않는다.
 * 앞단 프록시가 그 헤더를 **빈 문자열로 채워** 보내면 fastify 가 415 로 거절하고,
 * 라우트는 아예 돌지 않는다.
 *
 * 그 결과가 앱의 **"Disconnected"**(티켓을 못 받아 WS 를 못 연다)와 러너의
 * `agent/activity 실패: 415` 다. 서버는 `/healthz` 200 으로 멀쩡해 보인다.
 */
describe('빈 content-type 은 헤더가 없는 것과 같다', () => {
  const auth = () => ({ authorization: `Bearer ${token}` });

  it('issues a ws ticket when the header arrives empty', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ws-ticket',
      headers: { ...auth(), 'content-type': '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket).toBeTruthy();
  });

  /** 헤더가 아예 없는 경우는 원래도 됐다 — 함께 지켜 둔다. */
  it('still works with no header at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/ws-ticket', headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  /** 공백만 있는 것도 미디어 타입이 아니다. */
  it('treats a whitespace-only header as absent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ws-ticket',
      headers: { ...auth(), 'content-type': '   ' },
    });
    expect(res.statusCode).toBe(200);
  });

  /**
   * **본문이 있는 요청의 판정은 건드리지 않는다.** 훅은 헤더를 지우기만 하고, 그 뒤는
   * fastify 가 평소대로 본다 — 여기서 400/415 중 무엇이 되든 **415 라우트 밖 거절이
   * 아니라 서버가 본문을 보고 내린 판단**이어야 한다.
   */
  it('does not make the server accept a body it cannot parse', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: 'not json at all',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  /** 진짜 미디어 타입은 그대로 존중한다 — 지우는 것은 빈 값뿐이다. */
  it('leaves a real content-type alone', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { loginId: 'nobody', password: 'wrong-password' },
    });
    // 401 이면 본문이 파싱돼 라우트까지 갔다는 뜻이다(415 가 아니다).
    expect(res.statusCode).toBe(401);
  });
});

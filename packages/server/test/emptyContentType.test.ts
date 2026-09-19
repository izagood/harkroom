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
 * 앱과 러너는 본문 없는 POST 를 쓴다(`api.ts` 는 본문이 있을 때만 `content-type` 을 넣는다).
 * **앞단이 그 헤더를 채워서** 보내면 fastify 가 415 로 라우트 밖에서 거절하고, 라우트는
 * 아예 돌지 않는다.
 *
 * 그 결과가 앱의 "Disconnected"(티켓을 못 받아 WS 를 못 연다)와 러너의
 * `agent/activity 실패: 415` 다. 서버는 `/healthz` 200 으로 멀쩡해 보인다.
 *
 * 무엇이 붙을지는 앞단이 정하므로 **값을 열거하지 않는다** — 본문이 없다는 사실로 판정한다.
 */
describe('본문이 없으면 content-type 을 따지지 않는다', () => {
  const auth = () => ({ authorization: `Bearer ${token}` });

  /** 앱과 러너가 **실제로** 본문 없이 부르는 곳 전부. */
  const bodyless = ['/ws-ticket', '/auth/logout', '/invites', '/agent/activity'];

  /** 앞단이 붙일 수 있는 값들. 실측된 것(x-www-form-urlencoded)과 그 밖의 것을 섞는다. */
  const injected = [
    'application/x-www-form-urlencoded', // Cloudflare 터널이 실제로 붙인 값
    '', // 빈 문자열
    '   ', // 공백만
    'application/octet-stream',
    'text/html; charset=utf-8',
  ];

  for (const ct of injected) {
    it(`routes a bodyless POST when the proxy injects ${JSON.stringify(ct)}`, async () => {
      for (const url of bodyless) {
        const res = await app.inject({
          method: 'POST', url, headers: { ...auth(), 'content-type': ct },
        });
        // 415 면 라우트 밖에서 거절된 것이다. 그 외(200·401·403…)는 라우트까지 갔다는 뜻이고,
        // 무엇을 답하든 그것은 이 훅의 관심사가 아니다.
        expect(res.statusCode, `${url} with content-type ${JSON.stringify(ct)}`).not.toBe(415);
      }
    });
  }

  /**
   * **터널은 본문이 0 바이트여도 `transfer-encoding: chunked` 를 붙인다.**
   *
   * 처음 고칠 때 chunked 를 "본문 있음" 으로 보고 건너뛰게 했는데, 그 예외가 곧 고치려던
   * 경우 전부였다 — 배포하고 나서야 증상이 그대로인 것으로 드러났다. chunked 는 "길이를
   * 미리 모른다" 는 뜻이지 "본문이 있다" 는 뜻이 아니다.
   */
  for (const ct of injected) {
    it(`routes a chunked bodyless POST with ${JSON.stringify(ct)}`, async () => {
      for (const url of bodyless) {
        const res = await app.inject({
          method: 'POST', url,
          headers: { ...auth(), 'content-type': ct, 'transfer-encoding': 'chunked' },
        });
        expect(res.statusCode, `${url} chunked with ${JSON.stringify(ct)}`).not.toBe(415);
      }
    });
  }

  it('still works with no header at all', async () => {
    for (const url of bodyless) {
      const res = await app.inject({ method: 'POST', url, headers: auth() });
      expect(res.statusCode, url).not.toBe(415);
    }
  });

  /**
   * **본문이 있으면 방어를 그대로 둔다.** 훅이 타입 검사를 통째로 없애는 것이 아니다 —
   * 알 수 없는 타입으로 실제 본문을 보내면 여전히 415 여야 한다.
   */
  it('still rejects an unparseable media type when a body is present', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'loginId=x&password=y',
    });
    expect(res.statusCode).toBe(415);
  });

  /** 진짜 JSON 본문은 평소대로 파싱된다 — 401 이면 라우트까지 갔다는 뜻이다. */
  it('leaves a real json body alone', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { loginId: 'nobody', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
  });
});

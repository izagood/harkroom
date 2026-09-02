import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { CHANNEL_NAME_PATTERN } from '@murmur/shared';
import { DEFAULT_CHANNEL_NAME } from '../src/routes/authRoutes.js';

let app: FastifyInstance;
let stop: () => Promise<void>;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
});
afterAll(async () => {
  await app.close();
  await stop();
});

describe('bootstrap & login', () => {
  // 부트스트랩은 워크스페이스 전체에 한 번뿐이다 — 이 파일의 뒤 테스트들이 여기서 만든
  // 계정으로 로그인한다. 그래서 "기본 채널이 시딩된다"를 **별도 테스트로 두면 안 된다**:
  // 그 테스트가 1회성 부트스트랩을 소진해 뒤 테스트가 전부 409/401 로 무너진다.
  // 시딩 확인은 부트스트랩이 성공하는 이 자리에서 함께 한다.
  it('bootstraps first admin with a default channel, then rejects a second bootstrap', async () => {
    const r1 = await app.inject({
      method: 'POST', url: '/bootstrap',
      payload: { handle: 'jaebin', displayName: 'Jaebin', password: 'pw123456' },
    });
    expect(r1.statusCode).toBe(201);

    const token = (await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { handle: 'jaebin', password: 'pw123456' },
    })).json().token as string;
    const channels = await app.inject({
      method: 'GET', url: '/channels',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(channels.statusCode).toBe(200);
    // 설치한 사람이 로그인해서 빈 화면을 보지 않는다는 것이 #97 의 요지다.
    expect(channels.json().channels).toHaveLength(1);
    expect(channels.json().channels[0]).toMatchObject({ name: DEFAULT_CHANNEL_NAME, kind: 'standard' });
    // 시딩된 이름이 POST /channels 의 이름 규칙을 만족해야 한다 — 규칙을 손으로 다시 쓰지 않고
    // 서버·클라이언트가 공유하는 상수를 그대로 쓴다.
    expect(channels.json().channels[0].name).toMatch(new RegExp(CHANNEL_NAME_PATTERN));

    const r2 = await app.inject({
      method: 'POST', url: '/bootstrap',
      payload: { handle: 'x', displayName: 'X', password: 'pw123456' },
    });
    expect(r2.statusCode).toBe(409);
  });

  it('logs in and reads /auth/me', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { handle: 'jaebin', password: 'pw123456' },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json();
    const me = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ handle: 'jaebin', kind: 'human', isAdmin: true });
  });

  it('rejects wrong password and missing token', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { handle: 'jaebin', password: 'nope-nope' },
    });
    expect(bad.statusCode).toBe(401);
    const noauth = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(noauth.statusCode).toBe(401);
  });
});

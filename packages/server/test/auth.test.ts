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
      payload: { handle: 'jaebin', loginId: 'jaebin', displayName: 'Jaebin', password: 'pw123456' },
    });
    expect(r1.statusCode).toBe(201);

    const token = (await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'pw123456' },
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
      payload: { handle: 'x', loginId: 'x', displayName: 'X', password: 'pw123456' },
    });
    expect(r2.statusCode).toBe(409);
  });

  it('logs in and reads /auth/me', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'pw123456' },
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
      payload: { loginId: 'jaebin', password: 'nope-nope' },
    });
    expect(bad.statusCode).toBe(401);
    const noauth = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(noauth.statusCode).toBe(401);
  });
});

describe('password change', () => {
  it('changes password and new password works for login', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'pw123456' },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json();

    const change = await app.inject({
      method: 'POST', url: '/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'pw123456', newPassword: 'newpassword123' },
    });
    expect(change.statusCode).toBe(204);

    const loginNew = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'newpassword123' },
    });
    expect(loginNew.statusCode).toBe(200);
  });

  it('old password does not work after change', async () => {
    const loginOld = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'pw123456' },
    });
    expect(loginOld.statusCode).toBe(401);
  });

  it('rejects wrong current password', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'newpassword123' },
    });
    expect(login.statusCode).toBe(200);
    const { token } = login.json();

    const change = await app.inject({
      method: 'POST', url: '/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'wrong-password', newPassword: 'another123' },
    });
    expect(change.statusCode).toBe(401);
    expect(change.json()).toMatchObject({ error: { code: 'invalid_credentials' } });
  });

  it('rejects unauthenticated request', async () => {
    const change = await app.inject({
      method: 'POST', url: '/auth/password',
      payload: { currentPassword: 'pw123456', newPassword: 'new123456' },
    });
    expect(change.statusCode).toBe(401);
  });

  it('rejects new password that is too short', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'newpassword123' },
    });
    const { token } = login.json();

    const change = await app.inject({
      method: 'POST', url: '/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'newpassword123', newPassword: 'short' },
    });
    expect(change.statusCode).toBe(400);
  });

  it('invalidates other sessions but keeps current session', async () => {
    const login1 = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'newpassword123' },
    });
    const token1 = login1.json().token as string;

    const login2 = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'newpassword123' },
    });
    const token2 = login2.json().token as string;

    const change = await app.inject({
      method: 'POST', url: '/auth/password',
      headers: { authorization: `Bearer ${token1}` },
      payload: { currentPassword: 'newpassword123', newPassword: 'finalpassword123' },
    });
    expect(change.statusCode).toBe(204);

    const useToken1 = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(useToken1.statusCode).toBe(200);

    const useToken2 = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(useToken2.statusCode).toBe(401);
  });

  it('records audit log without password or hash', async () => {
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { loginId: 'jaebin', password: 'finalpassword123' },
    });
    const { token } = login.json();

    await app.inject({
      method: 'POST', url: '/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'finalpassword123', newPassword: 'lastpassword123' },
    });

    const audit = await app.inject({
      method: 'GET', url: '/audit?limit=5',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(audit.statusCode).toBe(200);
    const { entries } = audit.json() as { entries: Array<{ action: string; detail: Record<string, unknown> }> };
    const passwordLog = entries.find(l => l.action === 'password.changed');
    expect(passwordLog).toBeDefined();
    const detail = passwordLog!.detail;
    expect(detail).not.toHaveProperty('password');
    expect(detail).not.toHaveProperty('password_hash');
    expect(detail).toHaveProperty('otherSessionsInvalidated');
  });
});

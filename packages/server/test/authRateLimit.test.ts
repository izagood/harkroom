import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;

const LOGIN_MAX = 3;
const UPLOAD_MAX = 3;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  // 창을 길게 두고 최대치를 낮춘다 — 시간이 아니라 횟수로 검증한다.
  app = await buildServer({ pool: db.pool, rateLimits: {
    login: { windowMs: 60_000, max: LOGIN_MAX },
    upload: { windowMs: 60_000, max: UPLOAD_MAX },
  } });
  ({ token: adminToken } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const login = (password: string, ip = '10.0.0.1') => app.inject({
  method: 'POST', url: '/auth/login', payload: { loginId: 'admin', password }, remoteAddress: ip,
});

describe('인증 표면 레이트 리밋', () => {
  // /auth/login 은 Argon2 검증을 한다 — 의도적으로 비싼 연산이다. 무제한 요청은 브루트포스
  // 벡터이면서 동시에 CPU 소진 벡터다.
  it('refuses further login attempts from one address once the limit is hit', async () => {
    for (let i = 0; i < LOGIN_MAX; i += 1) {
      const res = await login('wrong-password');
      expect(res.statusCode).toBe(401); // 리밋에 걸리기 전까지는 정상적으로 인증 실패
    }

    const limited = await login('wrong-password');

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  // 리밋은 주소별이다. 한 공격자가 정상 사용자를 밀어내면 리밋이 곧 DoS 수단이 된다.
  it('counts per address so one attacker does not lock out everyone', async () => {
    for (let i = 0; i < LOGIN_MAX + 1; i += 1) await login('wrong-password', '10.0.0.2');
    expect((await login('wrong-password', '10.0.0.2')).statusCode).toBe(429);

    const other = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'admin', password: 'pw123456' },
      remoteAddress: '10.0.0.3',
    });

    expect(other.statusCode).toBe(200);
    expect(other.json().token).toBeTruthy();
  });

  // 리밋은 인증 표면만 좁힌다. 에이전트가 정상적으로 많이 부르는 경로(발화·조회)는 건드리지 않는다.
  it('leaves authenticated traffic alone', async () => {
    for (let i = 0; i < LOGIN_MAX + 5; i += 1) {
      const res = await app.inject({
        method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${adminToken}` },
        remoteAddress: '10.0.0.4',
      });
      expect(res.statusCode).toBe(200);
    }
  });

  // 리밋은 핸들러 앞에서 걸린다 — 그래서 계정 존재 여부를 드러내지 않아야 한다.
  it('does not reveal whether the handle exists', async () => {
    for (let i = 0; i < LOGIN_MAX + 1; i += 1) {
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { loginId: 'nobody', password: 'x' },
        remoteAddress: '10.0.0.5',
      });
    }
    const unknown = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'nobody', password: 'x' },
      remoteAddress: '10.0.0.5',
    });
    const known = await login('wrong-password', '10.0.0.6');

    expect(unknown.statusCode).toBe(429);
    expect(known.statusCode).toBe(401);
    expect(JSON.stringify(unknown.json())).not.toContain('nobody');
  });

  it('limits account creation surfaces too', async () => {
    const attempts = [];
    for (let i = 0; i < 12; i += 1) {
      attempts.push((await app.inject({
        method: 'POST', url: '/auth/register',
        payload: { handle: `spam${i}`, loginId: `spam${i}`, displayName: 'x', password: 'pw123456', inviteToken: 'nope' },
        remoteAddress: '10.0.0.7',
      })).statusCode);
    }

    expect(attempts).toContain(429);
  });
});

// 25MB 제한은 **한 번의** 업로드 크기만 막는다. 반복해서 올리면 디스크가 조용히 찬다 —
// 제한이 있는데도 채울 수 있으면 그 제한은 용량을 지키지 못한다.
describe('업로드 표면 레이트 리밋', () => {
  it('refuses further uploads from one address once the limit is hit', async () => {
    const upload = () => app.inject({
      method: 'POST', url: '/uploads', headers: {
        ...auth(adminToken),
        'content-type': 'multipart/form-data; boundary=X',
      },
      remoteAddress: '10.0.9.1',
      payload: '--X\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n'
        + 'Content-Type: text/plain\r\n\r\nhello\r\n--X--\r\n',
    });

    const codes: number[] = [];
    for (let i = 0; i < UPLOAD_MAX + 2; i += 1) codes.push((await upload()).statusCode);

    expect(codes).toContain(429);
    // 리밋 전 요청은 리밋 때문에 실패하지 않아야 한다(업로드 자체의 성공/실패와 무관).
    expect(codes.slice(0, UPLOAD_MAX).every((c) => c !== 429)).toBe(true);
  });

  it('counts uploads per address', async () => {
    const upload = (ip: string) => app.inject({
      method: 'POST', url: '/uploads',
      headers: { ...auth(adminToken), 'content-type': 'multipart/form-data; boundary=Y' },
      remoteAddress: ip,
      payload: '--Y\r\nContent-Disposition: form-data; name="file"; filename="b.txt"\r\n'
        + 'Content-Type: text/plain\r\n\r\nhi\r\n--Y--\r\n',
    });
    for (let i = 0; i < UPLOAD_MAX + 2; i += 1) await upload('10.0.9.2');
    expect((await upload('10.0.9.2')).statusCode).toBe(429);

    expect((await upload('10.0.9.3')).statusCode).not.toBe(429);
  });
});

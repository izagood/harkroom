import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;

const MAX = 3;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const boot = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(boot));
  await boot.close();
});
afterAll(async () => stop());

const build = (trustProxy?: boolean): Promise<FastifyInstance> => buildServer({
  pool, trustProxy, rateLimits: { login: { windowMs: 60_000, max: MAX } },
});

const login = (app: FastifyInstance, remoteAddress: string, forwardedFor?: string) => app.inject({
  method: 'POST', url: '/auth/login', payload: { handle: 'admin', password: 'wrong' },
  remoteAddress,
  ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
});

describe('프록시 신뢰 — 기본값(끔)', () => {
  // 이것이 가장 중요하다. 헤더를 신뢰하면 공격자가 X-Forwarded-For 를 매 요청마다 바꿔
  // **리밋을 무한히 우회**한다. Fastify 기본값이 안전하다는 것을 고정해 둔다.
  it('ignores X-Forwarded-For so the limit cannot be escaped by spoofing it', async () => {
    const app = await build();

    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i += 1) {
      // 매번 다른 값을 보낸다 — 헤더가 키에 쓰이면 전부 통과할 것이다.
      codes.push((await login(app, '10.5.0.1', `203.0.113.${i}`)).statusCode);
    }

    expect(codes).toContain(429);
    await app.close();
  });
});

describe('프록시 신뢰 — 켬', () => {
  // 리버스 프록시 뒤에서는 소켓 주소가 프록시 하나뿐이라, 켜지 않으면 **모든 클라이언트가
  // 한 버킷을 공유**한다. compose 배포가 지금 그 상태다(모든 요청이 브리지 게이트웨이로 보인다).
  it('keys the limit per forwarded client instead of lumping everyone together', async () => {
    const app = await build(true);

    for (let i = 0; i < MAX + 1; i += 1) await login(app, '10.5.0.9', '198.51.100.7');
    const exhausted = await login(app, '10.5.0.9', '198.51.100.7');
    const other = await login(app, '10.5.0.9', '198.51.100.8');

    expect(exhausted.statusCode).toBe(429);
    expect(other.statusCode).not.toBe(429); // 같은 프록시를 거친 다른 클라이언트
    await app.close();
  });

  it('records the forwarded client in the audit log, not the proxy', async () => {
    const app = await build(true);

    await app.inject({
      method: 'POST', url: '/auth/login', payload: { handle: 'admin', password: 'wrong' },
      remoteAddress: '10.5.0.9', headers: { 'x-forwarded-for': '198.51.100.42' },
    });

    const row = await pool.query(
      `select ip from audit_log where action = 'login.failed' order by id desc limit 1`,
    );
    expect(row.rows[0]?.ip).toBe('198.51.100.42');
    await app.close();
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let pool: Pool;
let stop: () => Promise<void>;

const ACCOUNT_MAX = 3;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const boot = await buildServer({ pool });
  await bootstrapAdmin(boot);
  await boot.close();
});
afterAll(async () => stop());

// 주소 단위 리밋은 넉넉히 둔다 — 여기서 재는 것은 계정 단위 리밋 하나다.
const build = (): Promise<FastifyInstance> => buildServer({
  pool,
  rateLimits: { login: { windowMs: 60_000, max: 1000 }, loginAccount: { windowMs: 60_000, max: ACCOUNT_MAX } },
});

let ipSeq = 0;
/** 매번 다른 주소에서 보낸다 — 주소를 바꿔도(XFF 위조가 통하는 상황) 계정 리밋은 걸려야 한다. */
const login = (app: FastifyInstance, loginId: string, password: string) => {
  ipSeq += 1;
  return app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId, password },
    remoteAddress: `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`,
  });
};

describe('계정 단위 로그인 실패 상한', () => {
  it('locks an account after repeated failures even when every attempt comes from a new address', async () => {
    const app = await build();

    for (let i = 0; i < ACCOUNT_MAX; i += 1) {
      expect((await login(app, 'admin', 'wrong')).statusCode).toBe(401);
    }
    const locked = await login(app, 'admin', 'wrong');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('rate_limited');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    // 막혀 있는 동안은 맞는 비밀번호도 거절한다 — 아니면 대입이 계속 맞혀 볼 수 있다.
    expect((await login(app, 'admin', 'pw123456')).statusCode).toBe(429);
    await app.close();
  });

  it('matches the login id case-insensitively, like the lookup does', async () => {
    const app = await build();

    for (let i = 0; i < ACCOUNT_MAX; i += 1) await login(app, i % 2 ? 'ADMIN' : 'Admin', 'wrong');

    expect((await login(app, 'admin', 'pw123456')).statusCode).toBe(429);
    await app.close();
  });

  // 계정이 있든 없든 같은 횟수에서 같은 모양으로 막힌다 — 429 여부로 계정 존재가 드러나면 안 된다.
  it('does not reveal whether the login id exists', async () => {
    const app = await build();

    const codes = async (loginId: string) => {
      const out: number[] = [];
      for (let i = 0; i < ACCOUNT_MAX + 1; i += 1) out.push((await login(app, loginId, 'wrong')).statusCode);
      return out;
    };
    const real = await codes('admin');
    const ghost = await codes('nobody-here');

    expect(ghost).toEqual(real);
    expect(real.at(-1)).toBe(429);
    await app.close();
  });

  it('clears the count on a successful login so occasional typos never add up', async () => {
    const app = await build();

    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < ACCOUNT_MAX - 1; i += 1) await login(app, 'admin', 'wrong');
      expect((await login(app, 'admin', 'pw123456')).statusCode).toBe(200);
    }
    await app.close();
  });

  it('counts each account on its own', async () => {
    const app = await build();

    for (let i = 0; i < ACCOUNT_MAX + 1; i += 1) await login(app, 'someone-else', 'wrong');

    expect((await login(app, 'admin', 'pw123456')).statusCode).toBe(200);
    await app.close();
  });
});

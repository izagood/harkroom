import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import argon2 from 'argon2';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let pool: Pool;
let stop: () => Promise<void>;

const PER_IP_MAX = 3;
const ACCOUNT_MAX = 6;

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const boot = await buildServer({ pool });
  await bootstrapAdmin(boot);
  await boot.close();
});
afterAll(async () => stop());

// 주소 단위 리밋은 넉넉히 둔다 — 여기서 재는 것은 계정 단위 리밋 둘이다.
const build = (): Promise<FastifyInstance> => buildServer({
  pool,
  rateLimits: {
    login: { windowMs: 60_000, max: 1000 },
    loginAccountIp: { windowMs: 60_000, max: PER_IP_MAX },
    loginAccount: { windowMs: 60_000, max: ACCOUNT_MAX },
  },
});

let ipSeq = 0;
/** 주소를 주지 않으면 매번 새 주소에서 보낸다 — 주소를 바꿔 가며(분산·XFF 위조) 노리는 경우다. */
const login = (app: FastifyInstance, loginId: string, password: string, ip?: string) => {
  ipSeq += 1;
  return app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId, password },
    remoteAddress: ip ?? `10.9.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`,
  });
};

describe('계정 단위 로그인 상한', () => {
  it('stops one address hammering an account without locking the owner out', async () => {
    const app = await build();

    for (let i = 0; i < PER_IP_MAX; i += 1) {
      expect((await login(app, 'admin', 'wrong', '10.8.0.1')).statusCode).toBe(401);
    }
    const locked = await login(app, 'admin', 'wrong', '10.8.0.1');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('rate_limited');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    // 남이 내 계정을 잠그지 못한다 — 주인은 자기 주소에서 그대로 들어온다.
    expect((await login(app, 'admin', 'pw123456', '10.8.0.2')).statusCode).toBe(200);
    await app.close();
  });

  it('locks the account once attempts from many addresses add up, even for the right password', async () => {
    const app = await build();

    for (let i = 0; i < ACCOUNT_MAX; i += 1) {
      expect((await login(app, 'admin', 'wrong')).statusCode).toBe(401);
    }
    // 막혀 있는 동안은 맞는 비밀번호도 거절한다 — 아니면 대입이 계속 맞혀 볼 수 있다.
    expect((await login(app, 'admin', 'pw123456')).statusCode).toBe(429);
    await app.close();
  });

  it('does not let an address that is already stopped eat the account-wide budget', async () => {
    const app = await build();

    // 한 주소가 상한을 한참 넘겨 두드려도, 넘친 시도는 계정 전체로 세지 않는다.
    for (let i = 0; i < ACCOUNT_MAX * 3; i += 1) await login(app, 'admin', 'wrong', '10.8.1.1');

    expect((await login(app, 'admin', 'pw123456', '10.8.1.2')).statusCode).toBe(200);
    await app.close();
  });

  it('normalises the login id so case and spaces do not give a fresh bucket', async () => {
    const app = await build();

    const variants = ['Admin', 'ADMIN', ' admin', 'admin '];
    for (let i = 0; i < PER_IP_MAX; i += 1) await login(app, variants[i % variants.length]!, 'wrong', '10.8.2.1');

    expect((await login(app, 'admin', 'pw123456', '10.8.2.1')).statusCode).toBe(429);
    await app.close();
  });

  // 계정이 있든 없든 같은 횟수에서 같은 모양으로 막힌다 — 429 여부로 계정 존재가 드러나면 안 된다.
  it('answers the same way whether or not the login id exists', async () => {
    const app = await build();

    const run = async (loginId: string) => {
      const out: { status: number; body: string; retry: unknown }[] = [];
      for (let i = 0; i < ACCOUNT_MAX + 1; i += 1) {
        const res = await login(app, loginId, 'wrong');
        out.push({ status: res.statusCode, body: res.body, retry: res.headers['retry-after'] !== undefined });
      }
      return out;
    };
    const real = await run('admin');
    const ghost = await run('nobody-here');

    expect(ghost).toEqual(real);
    expect(real.at(-1)!.status).toBe(429);
    await app.close();
  });

  // 없는 계정에서 Argon2 를 건너뛰면 응답 시간만으로 계정 존재가 드러난다 — 없어도 검증을 한 번 돈다.
  it('runs a password verification even when the login id does not exist', async () => {
    const app = await build();
    const verify = vi.spyOn(argon2, 'verify');

    expect((await login(app, 'nobody-at-all', 'wrong')).statusCode).toBe(401);

    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
    await app.close();
  });

  it('clears the count on a successful login so occasional typos never add up', async () => {
    const app = await build();

    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < PER_IP_MAX - 1; i += 1) await login(app, 'admin', 'wrong', '10.8.3.1');
      expect((await login(app, 'admin', 'pw123456', '10.8.3.1')).statusCode).toBe(200);
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

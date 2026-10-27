// 쓰는 세션은 늘어난다(슬라이딩) — 14일 고정이었을 때 앱을 쓰던 사람이 14일째에 로그아웃됐다(2026-10-27).
// 그래도 처음 로그인에서 90일이 지나면 더 늘지 않는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { hashToken } from '../src/auth/tokens.js';

let app: FastifyInstance; let stop: () => Promise<void>; let pool: Pool;
let adminToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const DAY = 86_400_000;

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
});
afterAll(async () => { await app.close(); await stop(); });

/** 세션 행의 시각을 옮긴다 — 만든 지 `createdDaysAgo` 일, 남은 기간 `leftDays` 일. */
async function age(token: string, createdDaysAgo: number, leftDays: number): Promise<void> {
  await pool.query(
    `update session set created_at = now() - make_interval(secs => $2), expires_at = now() + make_interval(secs => $3)
      where token_hash = $1`,
    [hashToken(token), createdDaysAgo * 86_400, leftDays * 86_400],
  );
}
async function expiresIn(token: string): Promise<number> {
  const r = await pool.query<{ ms: number }>(
    `select extract(epoch from (expires_at - now())) * 1000 as ms from session where token_hash = $1`, [hashToken(token)]);
  return Number(r.rows[0]!.ms);
}
const me = (token: string) => app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) });

describe('세션 슬라이딩 연장', () => {
  it('남은 기간이 7일 미만이면 쓰는 순간 14일로 늘어난다', async () => {
    const { token } = await createMember(app, adminToken, 'slide1');
    await age(token, 13, 1);
    expect((await me(token)).statusCode).toBe(200);
    const left = await expiresIn(token);
    expect(left).toBeGreaterThan(13.9 * DAY);
    expect(left).toBeLessThanOrEqual(14 * DAY + 60_000);
  });

  it('7일 넘게 남았으면 행을 건드리지 않는다', async () => {
    const { token } = await createMember(app, adminToken, 'slide2');
    await age(token, 4, 10);
    await me(token);
    const left = await expiresIn(token);
    expect(left).toBeLessThan(10 * DAY + 60_000);
    expect(left).toBeGreaterThan(9.9 * DAY);
  });

  it('처음 로그인에서 90일을 넘겨 늘리지 않는다', async () => {
    const { token } = await createMember(app, adminToken, 'slide3');
    await age(token, 85, 2);
    await me(token);
    const left = await expiresIn(token);
    // 상한(created_at + 90일)까지만 — 남은 기간은 5일 안팎이다.
    expect(left).toBeGreaterThan(4.9 * DAY);
    expect(left).toBeLessThan(5.1 * DAY);
  });

  it('상한에 닿은 세션은 그대로 만료된다 — 다시 로그인해야 한다', async () => {
    const { token } = await createMember(app, adminToken, 'slide4');
    await age(token, 90, -0.001);
    expect((await me(token)).statusCode).toBe(401);
  });

  it('만료된 세션은 되살리지 않는다', async () => {
    const { token } = await createMember(app, adminToken, 'slide5');
    await age(token, 14, -0.001);
    expect((await me(token)).statusCode).toBe(401);
    expect(await expiresIn(token)).toBeLessThan(0);
  });
});

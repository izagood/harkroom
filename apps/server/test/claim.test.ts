import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { hashToken, newToken } from '../src/auth/tokens.js';
import { seedClaimToken } from '../src/services/claimToken.js';
import { DEFAULT_CHANNEL_NAME } from '../src/routes/authRoutes.js';


/**
 * `/claim` 은 **워크스페이스마다 한 번만** 성공한다. 그래서 다른 테스트 파일들처럼 `beforeAll`
 * 로 DB 하나를 공유하면 첫 테스트가 그 한 번을 소진해 나머지가 전부 409 가 된다
 * (auth.test.ts 상단이 `/bootstrap` 에 대해 같은 함정을 적어 두었다).
 *
 * 여기서는 **테스트마다 새 DB** 를 띄운다. 느리지만, 이 라우트의 관심사가 정확히 "두 번째는
 * 안 된다" 라서 그 격리가 시험 대상 그 자체다.
 */
let app: FastifyInstance;
let pool: pg.Pool;
let stop: () => Promise<void>;

beforeEach(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
});
afterEach(async () => {
  await app.close();
  await stop();
});

/** 토큰을 하나 심고 원문을 돌려준다. gate 가 하는 일을 테스트가 흉내낸다. */
async function seed(): Promise<string> {
  const { token, hash } = newToken('claim');
  await seedClaimToken(pool, hash);
  return token;
}

const body = (claimToken: string) => ({
  claimToken,
  loginId: 'owner',
  handle: 'owner',
  displayName: 'Owner',
  password: 'pw123456',
});

describe('POST /claim', () => {
  it('claims the workspace with a valid token, seeding admin + default channel', async () => {
    const token = await seed();
    const res = await app.inject({ method: 'POST', url: '/claim', payload: body(token) });
    expect(res.statusCode).toBe(201);

    // 첫 사람은 **관리자**여야 한다 — 아니면 그 워크스페이스는 아무도 운영할 수 없다.
    const acc = await pool.query(`select is_admin, kind from account where id = $1`, [res.json().id]);
    expect(acc.rows[0]).toMatchObject({ is_admin: true, kind: 'human' });

    // 설치한 사람이 로그인해서 빈 화면을 보지 않는다(#97 의 요지, /bootstrap 과 같다).
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'owner', password: 'pw123456' },
    });
    const channels = await app.inject({
      method: 'GET', url: '/channels', headers: { authorization: `Bearer ${login.json().token}` },
    });
    expect(channels.json().channels[0]).toMatchObject({ name: DEFAULT_CHANNEL_NAME });
  });

  it('rejects a wrong token with 404 and creates nothing', async () => {
    await seed();
    const res = await app.inject({ method: 'POST', url: '/claim', payload: body('claim_nope') });
    expect(res.statusCode).toBe(404);
    const acc = await pool.query(`select 1 from account where kind = 'human'`);
    expect(acc.rowCount).toBe(0);
  });

  /** 이 라우트가 존재하는 이유 그 자체 — 토큰 없이는 워크스페이스를 가져갈 수 없다. */
  it('rejects when no token was ever seeded', async () => {
    const res = await app.inject({ method: 'POST', url: '/claim', payload: body('claim_anything') });
    expect(res.statusCode).toBe(404);
  });

  it('burns the token: a second claim with the same token fails', async () => {
    const token = await seed();
    expect((await app.inject({ method: 'POST', url: '/claim', payload: body(token) })).statusCode).toBe(201);

    // 같은 토큰으로 다른 계정을 만들려는 시도. **소진됐으므로 실패해야 한다.**
    const second = await app.inject({
      method: 'POST', url: '/claim',
      payload: { ...body(token), loginId: 'intruder', handle: 'intruder' },
    });
    expect(second.statusCode).not.toBe(201);
    const humans = await pool.query(`select 1 from account where kind = 'human'`);
    expect(humans.rowCount).toBe(1);
  });

  /**
   * 토큰이 **되살아나도** 남의 워크스페이스에 관리자가 하나 더 생기지 않는다. 운영 실수로
   * 같은 해시를 다시 심는 경우를 상정한 두 번째 관문이다.
   */
  it('refuses with 409 when a human already exists, even with a fresh valid token', async () => {
    const first = await seed();
    expect((await app.inject({ method: 'POST', url: '/claim', payload: body(first) })).statusCode).toBe(201);

    const revived = await seed(); // 새 토큰 — 관문 1 은 통과한다
    const res = await app.inject({
      method: 'POST', url: '/claim',
      payload: { ...body(revived), loginId: 'intruder', handle: 'intruder' },
    });
    expect(res.statusCode).toBe(409);
    expect((await pool.query(`select 1 from account where kind = 'human'`)).rowCount).toBe(1);
  });

  /** 실패한 클레임은 토큰을 태우지 않는다 — 태우면 사용자가 오타 한 번에 영영 막힌다. */
  it('does not burn the token when the claim itself fails', async () => {
    const token = await seed();
    const bad = await app.inject({
      method: 'POST', url: '/claim',
      payload: { ...body(token), password: 'short' }, // zod 가 거절한다(min 8)
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    const ok = await app.inject({ method: 'POST', url: '/claim', payload: body(token) });
    expect(ok.statusCode).toBe(201);
  });

  /** 원문이 아니라 해시만 저장된다 — 테이블이 새도 토큰은 새지 않는다. */
  it('stores only the hash, never the raw token', async () => {
    const token = await seed();
    const rows = await pool.query(`select token_hash from claim_token`);
    expect(rows.rows[0].token_hash).toBe(hashToken(token));
    expect(rows.rows[0].token_hash).not.toBe(token);
  });

  it('records who claimed it', async () => {
    const token = await seed();
    const res = await app.inject({ method: 'POST', url: '/claim', payload: body(token) });
    const row = await pool.query(`select used_at, used_by from claim_token`);
    expect(row.rows[0].used_at).not.toBeNull();
    expect(row.rows[0].used_by).toBe(res.json().id);
  });

  it('leaves an audit trail marked as claim', async () => {
    const token = await seed();
    await app.inject({ method: 'POST', url: '/claim', payload: body(token) });
    const audit = await pool.query(
      `select detail from audit_log where action = 'account.created'`);
    expect(audit.rows[0].detail).toMatchObject({ via: 'claim', isAdmin: true });
  });
});

describe('seedClaimToken', () => {
  it('is idempotent and does not resurrect a burned token', async () => {
    const { token, hash } = newToken('claim');
    expect(await seedClaimToken(pool, hash)).toBe(true);
    await app.inject({ method: 'POST', url: '/claim', payload: body(token) });

    // 재시작을 흉내낸다. **used_at 이 살아 있어야 한다** — 이것이 env 가 아니라 테이블에
    // 두는 이유 전부다.
    expect(await seedClaimToken(pool, hash)).toBe(false);
    const row = await pool.query(`select used_at from claim_token`);
    expect(row.rows[0].used_at).not.toBeNull();
  });

  it('does nothing when unset — self-host never learns this path', async () => {
    expect(await seedClaimToken(pool, undefined)).toBe(false);
    expect(await seedClaimToken(pool, '  ')).toBe(false);
    expect((await pool.query(`select 1 from claim_token`)).rowCount).toBe(0);
  });

  /**
   * 원문을 실수로 넣으면 **기동에서 선다.** 그대로 심으면 서버는 정상으로 보이지만 어떤
   * 토큰으로도 클레임이 안 되고, 그 사실이 클레임을 시도할 때까지 드러나지 않는다.
   */
  it('rejects a value that is not a sha256 digest', async () => {
    await expect(seedClaimToken(pool, 'claim_raw-token-by-mistake')).rejects.toThrow(/sha256/);
    expect((await pool.query(`select 1 from claim_token`)).rowCount).toBe(0);
  });
});

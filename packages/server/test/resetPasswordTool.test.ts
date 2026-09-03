// `scripts/reset-password.ts` 는 **잠긴 관리자를 푸는 유일한 탈출구**다(#110). API 로는
// 풀 수 없는 경로이므로(풀 수 있으면 그게 취약점이다) 이것이 깨지면 제품 안에 출구가 없다.
// 그래서 스크립트를 **실제로 실행해서** 검증한다 — 로직을 import 해 흉내내면 argv·env 처리와
// 트랜잭션 경계가 검증되지 않고, 그게 이 도구에서 틀리기 쉬운 부분이다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';

const run = promisify(execFile);

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let uri: string;

const HANDLE = 'lockedadmin';
const OLD = 'old-password-1';
const NEW = 'brand-new-password-2';

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  uri = db.uri;
  app = await buildServer({ pool: db.pool });
  await app.inject({
    method: 'POST', url: '/bootstrap',
    payload: { handle: HANDLE, loginId: HANDLE, displayName: 'Locked Admin', password: OLD },
  });
});
afterAll(async () => { await app.close(); await stop(); });

const login = (password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: HANDLE, password } });

/** 리포지토리 안의 tsx 를 직접 쓴다 — npx 로 받아오면 네트워크에 의존한다. */
const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const script = join(process.cwd(), 'scripts', 'reset-password.ts');

describe('reset-password 운영 도구', () => {
  it('비밀번호를 바꾸고, 옛 세션을 죽이고, 감사에 남긴다', async () => {
    // 잠기기 전에 살아 있던 세션 하나. 도구를 돌린 뒤 이것이 죽어야 한다.
    const before = await login(OLD);
    expect(before.statusCode).toBe(200);
    const oldToken = before.json().token as string;

    await run(tsx, [script, HANDLE], {
      env: { ...process.env, DATABASE_URL: uri, MURMUR_NEW_PASSWORD: NEW },
      timeout: 60_000,
    });

    // 새 비밀번호로 로그인된다 — 해시 행을 보지 않고 로그인을 태워 확인한다.
    expect((await login(NEW)).statusCode).toBe(200);
    // 옛 비밀번호는 죽었다.
    expect((await login(OLD)).statusCode).toBe(401);
    // 옛 세션도 죽었다 — 잠긴 상황을 푸는 도구이므로 남아 있으면 안 된다.
    const me = await app.inject({
      method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(me.statusCode).toBe(401);

    // 감사에 남고, 비밀번호도 해시도 그 안에 없다.
    const rows = await pool.query(
      `select actor_id, actor_handle, detail from audit_log where action = 'password.changed' order by id`,
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    const last = rows.rows[rows.rowCount! - 1];
    expect(last.detail).toMatchObject({ via: 'operational_tool' });
    // 누가 돌렸는지 서버는 알 수 없다 — 모르는 것을 아는 척하지 않는다.
    expect(last.actor_id).toBeNull();
    expect(last.actor_handle).toBeNull();
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain(NEW);
    expect(dump).not.toContain('argon2');
  }, 90_000);

  it('handle 이나 MURMUR_NEW_PASSWORD 가 없으면 사용법을 내고 실패한다', async () => {
    const noHandle = await run(tsx, [script], {
      env: { ...process.env, DATABASE_URL: uri, MURMUR_NEW_PASSWORD: NEW },
    }).then(() => null, (e: { code?: number; stderr?: string }) => e);
    expect(noHandle?.code).toBe(1);
    expect(noHandle?.stderr).toContain('사용법');

    const noPassword = await run(tsx, [script, HANDLE], {
      env: { ...process.env, DATABASE_URL: uri, MURMUR_NEW_PASSWORD: '' },
    }).then(() => null, (e: { code?: number; stderr?: string }) => e);
    expect(noPassword?.code).toBe(1);
  }, 90_000);

  it('규칙을 어기는 비밀번호를 거절한다 — 서버와 같은 규칙이다', async () => {
    const tooShort = await run(tsx, [script, HANDLE], {
      env: { ...process.env, DATABASE_URL: uri, MURMUR_NEW_PASSWORD: 'short' },
    }).then(() => null, (e: { code?: number; stderr?: string }) => e);
    expect(tooShort?.code).toBe(1);
    expect(tooShort?.stderr).toContain('8~128');
  }, 90_000);

  it('없는 handle 은 거절한다', async () => {
    const missing = await run(tsx, [script, 'nobody-here'], {
      env: { ...process.env, DATABASE_URL: uri, MURMUR_NEW_PASSWORD: NEW },
    }).then(() => null, (e: { code?: number; stderr?: string }) => e);
    expect(missing?.code).toBe(1);
  }, 90_000);
});

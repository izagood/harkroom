import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;

/** 로그 라인을 JSON 으로 모으는 싱크. 프로덕션은 stdout 이고 여기서만 갈아끼운다. */
function capture(): { lines: Record<string, unknown>[]; stream: Writable; text(): string } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const raw of String(chunk).split('\n').filter(Boolean)) {
        try { lines.push(JSON.parse(raw)); } catch { /* 비정형 라인 무시 */ }
      }
      cb();
    },
  });
  return { lines, stream, text: () => JSON.stringify(lines) };
}

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
  const boot = await buildServer({ pool });
  ({ token: adminToken } = await bootstrapAdmin(boot));
  await boot.close();
});
afterAll(async () => stop());

describe('요청 로깅', () => {
  it('logs one completed request with method, path, status and a request id', async () => {
    const log = capture();
    const app: FastifyInstance = await buildServer({ pool, logStream: log.stream, logLevel: 'info' });
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();

    const done = log.lines.find((l) => typeof l.res === 'object' && l.res !== null);
    expect(done).toBeTruthy();
    expect(log.text()).toContain('/healthz');
    expect(done!.reqId).toBeTruthy();
    expect((done!.res as { statusCode: number }).statusCode).toBe(200);
  });

  // 로그는 오래 남고 널리 읽힌다. Bearer 토큰이 거기 적히면 로그 열람 권한이 곧 계정 권한이 된다.
  it('never writes the authorization header into the log', async () => {
    const log = capture();
    const app = await buildServer({ pool, logStream: log.stream, logLevel: 'info' });
    await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${adminToken}` } });
    await app.close();

    expect(log.text()).not.toContain(adminToken);
    expect(log.text().toLowerCase()).not.toContain('bearer ');
  });

  // WS 티켓은 URL 쿼리에 실린다(브라우저가 헤더를 못 붙여서). 그 URL 을 그대로 로깅하면
  // 티켓을 URL 에서 뺀 이유 — "프록시 로그에 남는다" — 가 우리 로그에서 그대로 재현된다.
  it('redacts a ws ticket that rides in the query string', async () => {
    const log = capture();
    const app = await buildServer({ pool, logStream: log.stream, logLevel: 'info' });
    await app.inject({ method: 'GET', url: '/ws?ticket=murt_supersecretvalue' });
    await app.close();

    expect(log.text()).not.toContain('murt_supersecretvalue');
    expect(log.text()).toContain('ticket=REDACTED');
  });

  it('honors the configured level so a quiet deployment stays quiet', async () => {
    const log = capture();
    const app = await buildServer({ pool, logStream: log.stream, logLevel: 'silent' });
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();

    expect(log.lines).toEqual([]);
  });
});

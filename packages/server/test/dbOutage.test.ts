// DB 가 잠깐 끊겨도 서버 프로세스가 죽지 않는다(2026-10-12). 그날 Postgres 가 OOM 으로 네 번 죽었고,
// 그때마다 서버도 exit 1 로 같이 죽어 503 이 났다 — 주기 작업들이 `pool.connect` 실패를 놓쳐
// `void sweep()` 이 처리 안 된 거절(unhandled rejection)이 됐다. 여기서는 서버와 Postgres 사이에
// TCP 중계를 세워 그것을 끊었다 잇는 것으로 "DB 재시작"을 흉내 낸다.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { createPool } from '../src/db/pool.js';
import { runMigrationsWhenReachable } from '../src/db/migrate.js';
import { isTransientDbError, retryWhileDbUnreachable } from '../src/db/retry.js';
import { createScheduledMessageSweeper } from '../src/services/scheduledMessages.js';
import { createAutomationSweeper } from '../src/services/automations.js';
import { createDelegationDeadlineSweeper } from '../src/services/delegations.js';
import { createAgentWakeSweeper } from '../src/services/agentWakes.js';
import { createStaleRequestSweeper } from '../src/services/staleRequests.js';
import { createCredentialSweep } from '../src/ws/socketLifetime.js';

/** Postgres 앞의 끊을 수 있는 중계. `down()` 은 열린 연결까지 끊는다 — 재시작한 DB 와 같다. */
function createDbProxy(target: { host: string; port: number }) {
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  let port = 0;
  const listen = () => new Promise<void>((resolve, reject) => {
    if (server) { resolve(); return; }
    server = net.createServer((c) => {
      const u = net.connect(target.port, target.host);
      sockets.add(c); sockets.add(u);
      const drop = () => { c.destroy(); u.destroy(); sockets.delete(c); sockets.delete(u); };
      c.on('error', drop); u.on('error', drop); c.on('close', drop); u.on('close', drop);
      c.pipe(u); u.pipe(c);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  return {
    up: listen,
    get port() { return port; },
    async down() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = null;
    },
  };
}

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: FastifyInstance;
let proxy: ReturnType<typeof createDbProxy>;
let viaProxy: pg.Pool;
const poolErrors: Error[] = [];
const escaped: unknown[] = [];
const onEscape = (reason: unknown) => { escaped.push(reason); };

beforeAll(async () => {
  db = await startTestDb();
  app = await buildServer({ pool: db.pool });
  const url = new URL(db.uri);
  proxy = createDbProxy({ host: url.hostname, port: Number(url.port) });
  await proxy.up();
  url.hostname = '127.0.0.1';
  url.port = String(proxy.port);
  viaProxy = createPool(url.toString(), (err) => { poolErrors.push(err); });
  // 프로세스를 죽였을 두 갈래를 잡아 센다 — 하나라도 오면 실패다.
  process.on('unhandledRejection', onEscape);
  process.on('uncaughtException', onEscape);
});
afterAll(async () => {
  process.off('unhandledRejection', onEscape);
  process.off('uncaughtException', onEscape);
  await viaProxy.end().catch(() => {});
  await proxy.down();
  await app.close();
  await db.stop();
});
afterEach(async () => { await proxy.up().catch(() => {}); });

const ticks = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

describe('DB 가 끊겼다 돌아와도 프로세스가 산다', () => {
  it('주기 작업은 끊긴 동안 오류를 삼키고, 돌아오면 밀린 일을 한다', async () => {
    const { token, accountId } = await bootstrapAdmin(app);
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${token}` }, payload: { name: 'outage' },
    });
    const channelId = ch.json().id as string;
    const sched = await db.pool.query<{ id: string }>(
      `insert into scheduled_message (channel_id, author_id, body, send_at)
       values ($1, $2, 'after the outage', now() - interval '1 minute') returning id`, [channelId, accountId]);

    // 트랜잭션을 쥔 채(빌려 간 클라이언트) 끊기는 경우 — pg-pool 은 이때 error 리스너를 떼 둔다.
    const borrowed = await viaProxy.connect();
    await proxy.down();

    const scheduled = createScheduledMessageSweeper(viaProxy);
    const sweeps = [
      scheduled.sweep(),
      createAutomationSweeper(viaProxy).sweep(),
      createDelegationDeadlineSweeper(viaProxy).sweep(),
      createAgentWakeSweeper(viaProxy).sweep(),
      createStaleRequestSweeper(viaProxy, {
        presence: { online: () => [], offlineSince: () => null }, staleAfterMs: 0, startupGraceMs: 0,
      }).sweep(),
    ];
    await expect(Promise.all(sweeps)).resolves.toBeDefined();

    // 자격증명 재검증 — 끊긴 동안 소켓을 닫지 않는다(DB 장애가 전원 로그아웃이 되면 안 된다).
    const closed: number[] = [];
    const cred = createCredentialSweep(viaProxy, 20);
    cred.track({ close: (code: number) => { closed.push(code); } } as never, 'hash');
    await new Promise((r) => setTimeout(r, 150));
    cred.stop();

    await ticks();
    expect(escaped).toEqual([]);
    expect(closed).toEqual([]);
    expect(poolErrors.length).toBeGreaterThan(0); // 빌려 간 클라이언트의 끊김은 보고로 왔다
    borrowed.release();

    await proxy.up();
    await scheduled.sweep();
    const row = await db.pool.query(`select sent_message_id from scheduled_message where id = $1`, [sched.rows[0]!.id]);
    expect(row.rows[0]!.sent_message_id).not.toBeNull();
    await ticks();
    expect(escaped).toEqual([]);
  });

  it('기동 마이그레이션은 DB 를 기다렸다가 끝난다', async () => {
    await proxy.down();
    const logs: string[] = [];
    const run = runMigrationsWhenReachable(viaProxy, { log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 800));
    await proxy.up();
    await expect(run).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes('database unreachable'))).toBe(true);
    expect(escaped).toEqual([]);
  });
});

describe('retryWhileDbUnreachable', () => {
  const opts = { label: 't', deadlineMs: 10_000, sleep: async () => {}, log: () => {} };

  it('닿지 못한 실패만 다시 한다', async () => {
    let n = 0;
    const v = await retryWhileDbUnreachable(async () => {
      if (++n < 3) throw Object.assign(new Error('connect EPERM 10.0.0.1:5432'), { code: 'EPERM' });
      return 'ok';
    }, opts);
    expect([v, n]).toEqual(['ok', 3]);
  });

  it('질의의 실패(깨진 마이그레이션)는 바로 던진다', async () => {
    let n = 0;
    const syntax = Object.assign(new Error('syntax error at or near "x"'), { code: '42601' });
    await expect(retryWhileDbUnreachable(async () => { n++; throw syntax; }, opts)).rejects.toBe(syntax);
    expect(n).toBe(1);
  });

  it('시한을 넘기면 마지막 오류를 던진다', async () => {
    let t = 0;
    const err = new Error('timeout exceeded when trying to connect');
    await expect(retryWhileDbUnreachable(async () => { throw err; }, {
      ...opts, deadlineMs: 3_000, now: () => t, sleep: async (ms) => { t += ms; },
    })).rejects.toBe(err);
  });

  it('실측 로그의 문구를 닿지 못한 실패로 읽는다', () => {
    expect(isTransientDbError(Object.assign(new Error('connect EPERM 10.0.0.1:5432'), { code: 'EPERM' }))).toBe(true);
    expect(isTransientDbError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('the database system is starting up'), { code: '57P03' }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false);
  });
});

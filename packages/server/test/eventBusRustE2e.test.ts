// 버스 경유 이벤트 순서 — 끝에서 끝(S5.1d, Rust 전환).
//
// Rust 쪽이 `harkroom_bus::publish` 로 트랜잭션마다 이벤트 하나를 커밋하면(`crates/harkroom-bus/examples/publish_lines.rs`),
// 이 프로세스의 버스(`eventBus.ts`)가 받아 WS 구독자에게 **커밋한 순서 그대로** 내는지 본다. 같은 메시지의 created → updated 가
// 뒤집혀 도착하면 화면은 고친 본문을 옛 본문으로 덮는다 — 그래서 이 순서가 S5.1 완료 조건이다.
//
// 거치는 길은 운영과 같다: Rust 바이너리 → Postgres(outbox + NOTIFY) → `startEventBus`(모양 검사) → `emitEvent` →
// `wsPlugin.visibleTo`(받는 사람 판정) → 실제 WebSocket. 가짜로 바꾼 것은 없다.
//
// Rust 바이너리가 있어야 돈다(`HARKROOM_BUS_PUBLISH_BIN`). `pnpm test`(check 잡)는 이 바이너리를 빌드하지 않아 건너뛰고,
// `Rust crates` 워크플로의 `bus-e2e` 잡이 바이너리를 빌드해 이 파일만 돌린다.
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/buildServer.js';
import { startEventBus, type EventBus } from '../src/eventBus.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { startTestDb, type TestDb } from './helpers/testDb.js';

const BIN = process.env.HARKROOM_BUS_PUBLISH_BIN;
// `bus-e2e` 잡은 이것을 켠다 — 바이너리 경로를 잃어 조용히 건너뛰는 것을 통과로 읽지 않게.
if (process.env.HARKROOM_BUS_E2E_REQUIRED === '1' && !BIN) throw new Error('HARKROOM_BUS_PUBLISH_BIN 이 없다(bus-e2e 잡은 건너뛸 수 없다)');

/** Rust 쪽에 이벤트를 줄마다 넘기고, 커밋한 outbox id 를 받는다. */
function publishFromRust(uri: string, events: unknown[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN!, [], {
      env: { PATH: process.env.PATH ?? '', HARKROOM_BUS_DATABASE_URL: uri },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += String(b); });
    child.stderr.on('data', (b: Buffer) => { err += String(b); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.split('\n').filter(Boolean));
      else reject(new Error(`publish_lines exit ${code}: ${err}`));
    });
    child.stdin.end(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
}

interface Socket { ws: WebSocket; got: Array<{ type: string } & Record<string, unknown>> }

describe.skipIf(!BIN)('버스 경유 이벤트 순서 — Rust 가 커밋한 순서대로 WS 에 도착한다', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let bus: EventBus;
  let base: string;
  let admin: { token: string; accountId: string };
  let bob: { token: string; accountId: string };
  const sockets: Socket[] = [];

  async function open(token: string): Promise<Socket> {
    const t = await app.inject({ method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` } });
    const ws = new WebSocket(`ws://${base}/ws?ticket=${encodeURIComponent(t.json().ticket as string)}`);
    const s: Socket = { ws, got: [] };
    // 첫 프레임(presence.snapshot)이 오면 구독이 붙은 것이다 — 그 전에 낸 이벤트는 받지 못한다.
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const e = JSON.parse(String(raw)) as Socket['got'][number];
        if (e.type === 'presence.snapshot') resolve();
        s.got.push(e);
      });
    });
    sockets.push(s);
    return s;
  }
  const only = (s: Socket, prefix: string) => s.got.filter((e) => e.type.startsWith(prefix));
  async function until(cond: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  }

  beforeAll(async () => {
    db = await startTestDb();
    app = await buildServer({ pool: db.pool });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
    admin = await bootstrapAdmin(app);
    bob = await createMember(app, admin.token, 'bob');
    // 운영(main.ts)과 같은 꼴 — emit 을 주지 않으면 이 프로세스의 `emitEvent` 로 낸다.
    bus = await startEventBus({
      pool: db.pool,
      connect: async () => { const c = new pg.Client({ connectionString: db.uri }); await c.connect(); return c; },
      log: () => {},
    });
  });
  afterAll(async () => {
    for (const s of sockets) s.ws.close();
    await bus?.stop();
    await app?.close();
    await db?.stop();
  });

  it('같은 메시지의 created → updated 가, 다른 메시지와 섞여도 커밋 순서 그대로 오고 받는 사람 판정을 지난다', async () => {
    const a = await open(admin.token);
    const b = await open(bob.token);

    const N = 40;
    const row = (i: number, body: string, editedAt: string | null) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, seq: i + 1, channelId: 'c', threadRootId: null,
      authorId: admin.accountId, body, kind: 'user', meta: {}, createdAt: '2026-11-10T00:00:00.000Z', editedAt,
      reactions: [], attachments: [],
    });
    // created(i) 바로 뒤에 updated(i-1) — 한 메시지의 두 이벤트 사이에 다른 메시지의 이벤트가 끼는 꼴(실제 채널과 같다).
    const events: Array<Record<string, unknown>> = [];
    for (let i = 0; i < N; i += 1) {
      // 짝수 created 는 본문을 크게(약 256KB) 싣는다 — 다시 읽기가 뒤의 작은 줄보다 늦게 끝나는 꼴. 받는 쪽이 줄을 병렬로 읽으면
      // 여기서 순서가 뒤집힌다(직렬 처리를 되돌리면 이 시험이 실패하는 것을 확인했다).
      const pad = i % 2 === 0 ? `\n${'가'.repeat(64 * 1024)}` : '';
      events.push({ type: 'message.created', message: row(i, `v1-${i}${pad}`, null), audience: [admin.accountId] });
      if (i > 0) events.push({ type: 'message.updated', message: row(i - 1, `v2-${i - 1}`, '2026-11-10T00:00:01.000Z'), audience: [admin.accountId] });
    }
    events.push({ type: 'message.updated', message: row(N - 1, `v2-${N - 1}`, '2026-11-10T00:00:01.000Z'), audience: [admin.accountId] });
    // bob 의 소켓이 살아 있음을 보이는 끝 표지 — bob 이 위 이벤트를 하나도 못 받은 것이 「연결이 죽어서」가 아님을 가른다.
    events.push({ type: 'inbox.updated', accountId: bob.accountId });

    const started = Date.now();
    const ids = await publishFromRust(db.uri, events);
    expect(ids).toHaveLength(events.length);

    await until(() => only(a, 'message.').length >= 2 * N && only(b, 'inbox.').length >= 1);
    const elapsed = Date.now() - started;

    const label = (type: unknown, m: unknown) => `${String(type)}:${(m as { body: string }).body.split('\n')[0]}`;
    const seen = only(a, 'message.').map((e) => label(e.type, e.message));
    const want = events.filter((e) => String(e.type).startsWith('message.')).map((e) => label(e.type, e.message));
    expect(seen).toEqual(want);
    // 각 메시지에 대해 created 가 updated 보다 먼저 — 위 전체 비교가 이미 보장하지만, 실패했을 때 읽기 쉬운 형태로 한 번 더.
    for (let i = 0; i < N; i += 1) {
      expect(seen.indexOf(`message.created:v1-${i}`)).toBeLessThan(seen.indexOf(`message.updated:v2-${i}`));
    }
    // 받는 사람 판정이 버스 경로에도 그대로 걸린다 — audience 밖의 bob 은 메시지 이벤트를 하나도 받지 않는다.
    expect(only(b, 'message.')).toEqual([]);
    expect(only(b, 'inbox.')).toEqual([{ type: 'inbox.updated', accountId: bob.accountId }]);
    expect(bus.stats()).toMatchObject({ received: events.length, dropped: 0 });
    console.log(`bus e2e: ${events.length} events, rust commit → last ws frame ${elapsed}ms, lastLagMs=${bus.stats().lastLagMs?.toFixed(1)}`);
  });
});

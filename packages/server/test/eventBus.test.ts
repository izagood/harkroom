// 이벤트 버스(S5.0) — `event_outbox` 에 쓰고 NOTIFY 로 id 만 보내면, 이 프로세스의 이벤트로 나온다.
// 쓰는 쪽 SQL 은 Rust crate(`crates/harkroom-bus`)가 쓰는 것과 같은 계약이다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_BUS_TYPES, EVENT_OUTBOX_CHANNEL, startEventBus, toWorkspaceEvent, type EventBus } from '../src/eventBus.js';
import type { WorkspaceEvent } from '../src/events.js';
import { startTestDb, type TestDb } from './helpers/testDb.js';

describe('toWorkspaceEvent — 모양 검사', () => {
  it('events.ts 의 이벤트 종류를 빠짐없이 안다(종류를 더하면 여기도 더해야 한다)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'events.ts'), 'utf8');
    const declared = new Set([...src.matchAll(/\{ type: '([A-Za-z_.]+)'/g)].map((m) => m[1]!));
    expect([...EVENT_BUS_TYPES].sort()).toEqual([...declared].sort());
  });

  it('모르는 종류·받는 사람이 없는 것·계정 없는 계정 이벤트는 버린다', () => {
    expect(toWorkspaceEvent({ type: 'nope', audience: 'all' })).toBeNull();
    expect(toWorkspaceEvent({ type: 'message.created', message: {} })).toBeNull();
    expect(toWorkspaceEvent({ type: 'message.created', message: {}, audience: [1] })).toBeNull();
    expect(toWorkspaceEvent({ type: 'inbox.updated' })).toBeNull();
    expect(toWorkspaceEvent(['x'])).toBeNull();
    expect(toWorkspaceEvent({ type: 'inbox.updated', accountId: 'a' })).not.toBeNull();
    expect(toWorkspaceEvent({ type: 'presence.changed', accountId: 'a', online: true })).not.toBeNull();
  });
});

describe('startEventBus — outbox + NOTIFY(id)', () => {
  let db: TestDb;
  let bus: EventBus;
  const got: WorkspaceEvent[] = [];

  /** 쓰는 쪽 계약(Rust `harkroom_bus::publish` 와 같은 SQL). */
  async function publish(event: unknown): Promise<string> {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      const r = await c.query<{ id: string }>('insert into event_outbox (event) values ($1) returning id', [JSON.stringify(event)]);
      await c.query('select pg_notify($1, $2)', [EVENT_OUTBOX_CHANNEL, r.rows[0]!.id]);
      await c.query('commit');
      return r.rows[0]!.id;
    } finally {
      c.release();
    }
  }
  const waitFor = async (n: number): Promise<void> => {
    for (let i = 0; i < 200 && got.length < n; i += 1) await new Promise((r) => setTimeout(r, 10));
  };

  beforeAll(async () => {
    db = await startTestDb();
    bus = await startEventBus({
      pool: db.pool,
      connect: async () => { const c = new pg.Client({ connectionString: db.uri }); await c.connect(); return c; },
      emit: (e) => got.push(e),
      log: () => {},
    });
  });
  afterAll(async () => {
    await bus?.stop();
    await db?.stop();
  });

  it('다른 프로세스가 쓴 이벤트가 이 프로세스의 이벤트로 나온다 — 본문이 NOTIFY 상한(8000바이트)보다 커도', async () => {
    const body = '가'.repeat(8000);
    const event = { type: 'message.created', message: { id: 'm1', body }, audience: 'all' };
    await publish(event);
    await waitFor(1);
    expect(got).toEqual([event]);
    const s = bus.stats();
    expect(s.received).toBe(1);
    expect(s.lastLagMs).toBeGreaterThanOrEqual(0);
  });

  it('모양이 틀린 줄과 숫자가 아닌 알림은 버리고, 그 뒤 것은 계속 나른다', async () => {
    got.length = 0;
    await publish({ type: 'message.created', message: {} });
    await db.pool.query('select pg_notify($1, $2)', [EVENT_OUTBOX_CHANNEL, 'not-a-number']);
    await publish({ type: 'inbox.updated', accountId: 'acct-1' });
    // 알림마다 줄을 따로 다시 읽으므로(풀 연결 여럿) 버린 줄의 읽기가 정상 줄보다 늦게 끝날 수 있다 — 버린 수도 기다린다.
    for (let i = 0; i < 200 && (got.length < 1 || bus.stats().dropped < 2); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ type: 'inbox.updated', accountId: 'acct-1' }]);
    expect(bus.stats().dropped).toBe(2);
  });

  it('커밋되지 않은 쓰기는 나가지 않는다(NOTIFY 는 커밋 때만 간다)', async () => {
    got.length = 0;
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      const r = await c.query<{ id: string }>('insert into event_outbox (event) values ($1) returning id', [JSON.stringify({ type: 'inbox.updated', accountId: 'x' })]);
      await c.query('select pg_notify($1, $2)', [EVENT_OUTBOX_CHANNEL, r.rows[0]!.id]);
      await c.query('rollback');
    } finally {
      c.release();
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toEqual([]);
  });
});

describe('startEventBus — 순서', () => {
  let db: TestDb;
  let bus: EventBus;
  const got: WorkspaceEvent[] = [];

  beforeAll(async () => {
    db = await startTestDb();
    // 다시 읽기마다 지연을 거꾸로 준다(앞 알림일수록 늦게 끝난다) — 병렬로 읽으면 순서가 뒤집힌다.
    let n = 0;
    const slowPool = {
      query: async (...args: unknown[]) => {
        const delay = Math.max(0, 60 - (n++) * 6);
        await new Promise((r) => setTimeout(r, delay));
        return (db.pool.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as pg.Pool;
    bus = await startEventBus({
      pool: slowPool,
      connect: async () => { const c = new pg.Client({ connectionString: db.uri }); await c.connect(); return c; },
      emit: (e) => got.push(e),
      log: () => {},
    });
  });
  afterAll(async () => {
    await bus?.stop();
    await db?.stop();
  });

  it('알림(커밋) 순서대로 낸다 — 다시 읽기가 늦게 끝나도 뒤 이벤트가 앞질러 나가지 않는다', async () => {
    const N = 10;
    for (let i = 0; i < N; i += 1) {
      const c = await db.pool.connect();
      try {
        await c.query('begin');
        const r = await c.query<{ id: string }>('insert into event_outbox (event) values ($1) returning id', [JSON.stringify({ type: 'inbox.updated', accountId: `a${i}` })]);
        await c.query('select pg_notify($1, $2)', [EVENT_OUTBOX_CHANNEL, r.rows[0]!.id]);
        await c.query('commit');
      } finally {
        c.release();
      }
    }
    for (let i = 0; i < 400 && got.length < N; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(got.map((e) => (e as { accountId: string }).accountId)).toEqual(Array.from({ length: N }, (_, i) => `a${i}`));
  });
});

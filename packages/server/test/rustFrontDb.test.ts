// Rust 앞단(`crates/harkroom-server`)의 DB 대조 시험(`tests/auth.rs`·`tests/perm.rs`)을 TS 마이그레이션이 전부 적용된
// 실제 Postgres 에 돌린다. 두 시험은 `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛰므로, 스키마를 가진 이 스위트가
// 시험마다 새 DB 를 복제해 넘긴다. CI `bus-e2e` 잡이 `HARKROOM_RUST_DB_TESTS=1` 로 켠다 — 그 밖에서는 건너뛴다.
//
// S5.2 P1 부터 **TS·Rust 대조 시험**(`tests/contrast.rs`)도 여기서 돈다: 같은 DB 에 TS 서버(buildServer)와 그것을 상류로 둔
// 앞단 바이너리를 띄우고, 픽스처를 넣은 뒤 같은 요청을 두 쪽에 보내 답이 같은지 본다.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, createMember, registerOperator } from './helpers/fixtures.js';
import { startTestDb } from './helpers/testDb.js';
import { fanOutCalls, postMessage, resolveMentionCalls } from '../src/services/messages.js';
import { writeFileSync as writeCases } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  addChannelMember, audienceFor, channelListAudience, channelListLostAudience, createChannel, getOrCreateDm, removeChannelMember,
} from '../src/services/channels.js';
import { startEventBus } from '../src/eventBus.js';
import {
  invokeFactsFor, isEligibleDelegate, mayInvoke, mayInvokeTeam, type InvokeVia, type TeamInvokeFacts,
} from '../src/services/invokeGate.js';
import { emitEvent, onEvent, type WorkspaceEvent } from '../src/events.js';
import pg from 'pg';
import WebSocket from 'ws';

const ON = process.env.HARKROOM_RUST_DB_TESTS === '1';
const MANIFEST = fileURLToPath(new URL('../../../crates/harkroom-server/Cargo.toml', import.meta.url));

function cargo(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', [args[0]!, '--manifest-path', MANIFEST, '--locked', ...args.slice(1)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += String(b); });
    child.stderr.on('data', (b: Buffer) => { out += String(b); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** `write.rs::OPERATOR_PRIVILEGES`(+ 시퀀스) 만 가진 쓰기 역할 — homelab 이 운영 쓰기 역할에 더할 GRANT 와 같은 표. */
const OPERATOR_GRANTS = [
  'insert, update on operator',
  'insert, delete on operator_upgrade',
  'usage on sequence operator_upgrade_id_seq',
  'insert, update on operator_gh_report',
  'update on agent_assignment',
  'update on secret_grant',
  'insert on audit_log',
];

/** `loops/wake.rs::WAKE_PRIVILEGES`(+ 시퀀스) 만 가진 쓰기 역할 — homelab 이 운영 쓰기 역할에 더할 GRANT 와 같은 표(S5.3 C5b). */
const WAKE_GRANTS = [
  'update (fired_at) on agent_wake',
  'insert on inbox',
  'update (meta) on message',
  'insert on event_outbox',
  'usage on sequence event_outbox_id_seq',
];

/** `loops/retention.rs::RETENTION_PRIVILEGES` 만 가진 쓰기 역할(S5.3 C5c). */
const RETENTION_GRANTS = ['delete on idempotency_key', 'delete on session'];

/** `loops/outbox_prune.rs::OUTBOX_PRUNE_PRIVILEGES` 만 가진 쓰기 역할(S5.3 C5c-4). */
const OUTBOX_PRUNE_GRANTS = ['delete on event_outbox'];

/** `loops/mandate_idle.rs::MANDATE_IDLE_PRIVILEGES`(+ 시퀀스) 만 가진 쓰기 역할(S5.3 C5c-2a). */
const MANDATE_IDLE_GRANTS = [
  'update (ended_at, end_reason) on mandate',
  'update (revoked_at) on mandate_line',
  'update (meta) on message',
  'insert on audit_log',
  'insert on event_outbox',
  'usage on sequence event_outbox_id_seq',
];

/** `loops/permission_expire.rs::PERMISSION_EXPIRE_PRIVILEGES`(+ 시퀀스) 만 가진 쓰기 역할(S5.3 C5c-2b). */
/** `loops/bg.rs::BG_PRIVILEGES` 만 가진 쓰기 역할(S5.3 C5c-3a). */
const BG_GRANTS = ['update (status, error, finished_at) on bg_job'];
/** `loops/bg_produce.rs::BG_PRODUCE_PRIVILEGES` 만 가진 쓰기 역할(S5.3 C5c-3b-1) — 넣는 칸만. */
const BG_PRODUCE_GRANTS = ['insert (account_id, kind, day, input) on bg_job'];

/** `core/turn_lease.rs::TURN_LEASE_PRIVILEGES` 만 가진 쓰기 역할(S5.3 C6b) — 임대 행 넣기와 세 칸 고치기. */
const TURN_LEASE_GRANTS = [
  'insert on secret_turn_lease',
  'update (ended_at, expires_at, last_renewed_at) on secret_turn_lease',
  'insert on audit_log',
];

const PERMISSION_EXPIRE_GRANTS = [
  'update (status, decided_at) on permission_request',
  'update (meta) on message',
  'insert on inbox',
  'insert on audit_log',
  'insert on event_outbox',
  'usage on sequence event_outbox_id_seq',
];

async function operatorWriteRole(db: { pool: pg.Pool; uri: string }, grants: readonly string[] = OPERATOR_GRANTS): Promise<string> {
  const rw = `op_rw_${Math.random().toString(36).slice(2, 10)}`;
  await db.pool.query(`create role ${rw} login password '${rw}' nosuperuser nocreatedb nocreaterole nobypassrls connection limit 8`);
  await db.pool.query(`grant pg_read_all_data to ${rw}`);
  for (const g of grants) await db.pool.query(`grant ${g} to ${rw}`);
  const u = new URL(db.uri);
  u.username = rw;
  u.password = rw;
  return u.toString();
}

describe.skipIf(!ON)('Rust 앞단 DB 대조 시험 — 실제 스키마로', () => {
  for (const name of ['auth', 'perm', 'operator', 'loops', 'wake', 'outbox_listener', 'retention', 'mandate_idle', 'permission_expire', 'bg', 'bg_produce', 'outbox_prune', 'turn_lease']) {
    it(`tests/${name}.rs`, async () => {
      const db = await startTestDb();
      try {
        const env: Record<string, string> = { HARKROOM_TEST_DATABASE_URL: db.uri };
        // C2a — 오퍼레이터 시험은 쓰기 풀을 `write.rs::OPERATOR_PRIVILEGES` 만 가진 역할로 돌린다(homelab GRANT 표가 모자라면 여기서 빨개진다).
        if (name === 'operator') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db);
        // C5b — 예약 깨움 sweep 도 `WAKE_PRIVILEGES` 만 가진 역할로 돌린다.
        if (name === 'wake') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, WAKE_GRANTS);
        // C5c — 보존 정리도 `RETENTION_PRIVILEGES` 만 가진 역할로.
        if (name === 'retention') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, RETENTION_GRANTS);
        // C5c-2a — 위임 idle 끝도 `MANDATE_IDLE_PRIVILEGES` 만 가진 역할로.
        if (name === 'mandate_idle') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, MANDATE_IDLE_GRANTS);
        // C5c-2b — 권한 요청 만료도 `PERMISSION_EXPIRE_PRIVILEGES` 만 가진 역할로.
        if (name === 'permission_expire') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, PERMISSION_EXPIRE_GRANTS);
        // C5c-3a — 백그라운드 회차 닫기도 `BG_PRIVILEGES` 만 가진 역할로.
        if (name === 'bg') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, BG_GRANTS);
        // C5c-3b-1 — 백그라운드 회차 생산도 `BG_PRODUCE_PRIVILEGES` 만 가진 역할로.
        if (name === 'bg_produce') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, BG_PRODUCE_GRANTS);
        // C5c-4 — outbox 정리도 `OUTBOX_PRUNE_PRIVILEGES` 만 가진 역할로.
        if (name === 'outbox_prune') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, OUTBOX_PRUNE_GRANTS);
        // C6b — 턴 임대도 `TURN_LEASE_PRIVILEGES` 만 가진 역할로.
        if (name === 'turn_lease') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db, TURN_LEASE_GRANTS);
        const r = await cargo(['test', '--test', name, '--', '--nocapture'], env);
        expect(r.code, r.out).toBe(0);
        // DB 가 없어 건너뛴 것을 통과로 읽지 않는다.
        expect(r.out, r.out).not.toContain('skip: HARKROOM_TEST_DATABASE_URL unset');
        expect(r.out).toMatch(/test result: ok\. [1-9]\d* passed/);
      } finally {
        await db.stop();
      }
    }, 600_000);
  }

  // C5b — 같은 깨움 200건을 TS sweep(`createAgentWakeSweeper`)과 Rust sweep(`loops::wake::sweep`)이 **문지기 없이 동시에** 쓸어도
  // 한 깨움은 한 번만 뜬다(skip locked + fired_at). 문지기가 평소 한쪽만 돌리지만, 주인을 바꾸는 순간 겹쳐도 안전하다는 바닥이다.
  it('예약 깨움 — TS·Rust 동시 sweep 에도 200건이 정확히 한 번씩 뜬다', async () => {
    const db = await startTestDb();
    try {
      const agent = await db.pool.query<{ id: string }>(
        `insert into account(handle, display_name, kind) values ('wake_dual', 'wake_dual', 'agent') returning id`);
      const ch = await db.pool.query<{ id: string }>(`insert into channel(name, kind) values ('wake-dual', 'standard') returning id`);
      const a = agent.rows[0]!.id; const c = ch.rows[0]!.id;
      await db.pool.query(
        `with m as (
           insert into message(channel_id, author_id, body, kind, meta)
           select $2, $1, 'w' || g, 'wake', '{"wake":{}}'::jsonb from generate_series(1, 200) g returning id)
         insert into agent_wake(account_id, channel_id, message_id, wake_at)
         select $1, $2, m.id, now() - interval '1 minute' from m`, [a, c]);
      const { createAgentWakeSweeper } = await import('../src/services/agentWakes.js');
      const ts = createAgentWakeSweeper(db.pool);
      const due = async () => Number((await db.pool.query(
        `select count(*)::int as n from agent_wake where fired_at is null and canceled_at is null and wake_at <= now()`)).rows[0].n);
      const rust = cargo(['test', '--test', 'wake', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, WAKE_GRANTS),
        HARKROOM_WAKE_DUAL: '1',
      });
      // Rust 쪽이 연결을 연 뒤에 TS 도 쓸기 시작한다(컴파일 시간 동안 TS 가 혼자 다 쓸지 않게).
      const t0 = Date.now();
      while (Number((await db.pool.query(
        `select count(*)::int as n from pg_stat_activity where application_name = 'harkroom-wake-dual'`)).rows[0].n) === 0) {
        if (Date.now() - t0 > 540_000) throw new Error('rust side never connected');
        await new Promise((r) => setTimeout(r, 20));
      }
      while (await due() > 0) await ts.sweep();
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/wake-dual rust fired (\d+)/);
      expect(m, r.out).not.toBeNull();
      const counts = (await db.pool.query(
        `select (select count(*)::int from inbox where account_id = $1 and reason = 'wake') as inbox,
                (select count(distinct message_id)::int from inbox where account_id = $1) as distinct_inbox,
                (select count(*)::int from agent_wake where account_id = $1 and fired_at is not null) as fired,
                (select count(*)::int from message where channel_id = $2 and meta->'wake' ? 'firedAt') as stamped`, [a, c])).rows[0];
      expect(counts).toEqual({ inbox: 200, distinct_inbox: 200, fired: 200, stamped: 200 });
      console.log(`wake-dual: rust ${m![1]} / ts ${200 - Number(m![1])}`);
    } finally {
      await db.stop();
    }
  }, 600_000);

  // C5c — 만료 30일 지난 세션 20000건(배치 20번 분량)을 TS sweep(`createRetentionSweeper`, 지우기 켬)과 Rust sweep 이 **문지기 없이 동시에** 지워도
  // 지운 수의 합이 정확히 20000 이고(두 번 세지 않음) 남길 줄은 남는다. 이 sweep 은 skip locked 가 아니라 ctid 배치 delete 라 멱등이 바닥이다.
  it('보존 정리 — TS·Rust 동시 sweep 에도 지운 수 합이 정확하고 남길 줄은 남는다', async () => {
    const db = await startTestDb();
    try {
      const a = (await db.pool.query<{ id: string }>(
        `insert into account(handle, display_name, kind) values ('ret_dual', 'ret_dual', 'agent') returning id`)).rows[0]!.id;
      await db.pool.query(
        `insert into session(token_hash, account_id, expires_at)
         select 'dual-old-' || g, $1::uuid, now() - interval '31 days' from generate_series(1, 20000) g
         union all select 'dual-keep', $1::uuid, now() - interval '29 days'`, [a]);
      const { createRetentionSweeper } = await import('../src/services/retention.js');
      const ts = createRetentionSweeper(db.pool, { log: () => {}, deleteEnabled: true });
      const old = async () => Number((await db.pool.query(
        `select count(*)::int as n from session where account_id = $1 and expires_at < now() - interval '30 days'`, [a])).rows[0].n);
      const rust = cargo(['test', '--test', 'retention', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, RETENTION_GRANTS),
        HARKROOM_RETENTION_DUAL: a,
      });
      const t0 = Date.now();
      while (Number((await db.pool.query(
        `select count(*)::int as n from pg_stat_activity where application_name = 'harkroom-retention-dual'`)).rows[0].n) === 0) {
        if (Date.now() - t0 > 540_000) throw new Error('rust side never connected');
        await new Promise((r) => setTimeout(r, 20));
      }
      let tsDeleted = 0;
      while (await old() > 0) tsDeleted += (await ts.sweep()).reduce((n, x) => n + x.deleted, 0);
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/retention-dual rust deleted (\d+) overlapped (\d+)/);
      expect(m, r.out).not.toBeNull();
      expect(tsDeleted + Number(m![1])).toBe(20000);
      // 실제로 겹쳤는지 — Rust 가 지울 줄이 남은 동안 sweep 을 돌렸어야 한다(둘이 같은 ctid 묶음을 고르므로 Rust 가 줄 잠금에서
      // 기다린 뒤 0 건일 수 있다 — 그래도 겹친 것이고, 판정은 합이 정확한가다).
      expect(Number(m![2]), r.out).toBeGreaterThan(0);
      expect(tsDeleted).toBeGreaterThan(0);
      const left = (await db.pool.query<{ token_hash: string }>(
        `select token_hash from session where account_id = $1`, [a])).rows.map((x) => x.token_hash);
      expect(left).toEqual(['dual-keep']);
      console.log(`retention-dual: rust ${m![1]} (overlapped sweeps ${m![2]}) / ts ${tsDeleted}`);
    } finally {
      await db.stop();
    }
  }, 600_000);

  // C5c-4 — 한 시간 지난 outbox 줄 20000건을 TS `pruneEventOutbox` 와 Rust `loops::outbox_prune::prune` 이 **문지기 없이 동시에** 지워도
  // 지운 수의 합이 정확히 20000 이고 남길 줄(30분)은 남는다. 이 sweep 은 조건 delete 라 늦은 쪽은 줄 잠금을 기다린 뒤 이미 지운 줄을 건너뛴다.
  it('outbox 정리 — TS·Rust 동시 sweep 에도 지운 수 합이 정확하고 남길 줄은 남는다', async () => {
    const db = await startTestDb();
    try {
      const tag = 'op-dual';
      // 남길 줄은 30분 — Rust 시험 빌드를 기다리는 동안(최대 9분) 한 시간을 넘기지 않는다.
      await db.pool.query(
        `insert into event_outbox(event, created_at)
         select jsonb_build_object('t', $1::text, 'k', 'old-' || g), now() - interval '61 minutes' from generate_series(1, 20000) g
         union all select jsonb_build_object('t', $1::text, 'k', 'keep'), now() - interval '30 minutes'`, [tag]);
      const { pruneEventOutbox } = await import('../src/eventBus.js');
      const old = async () => Number((await db.pool.query(
        `select count(*)::int as n from event_outbox where event->>'t' = $1 and created_at < now() - interval '1 hour'`, [tag])).rows[0].n);
      const lockWaiters = async () => Number((await db.pool.query(
        `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like 'delete from event_outbox%'`)).rows[0].n);
      // 겹침을 확실히 만든다 — 줄 잠금을 먼저 쥐고(풀 밖 연결이라 idle-in-transaction 시한이 없다), Rust 와 TS 의 delete 가 **둘 다** 그
      // 잠금에서 기다리는 것을 본 뒤 놓는다. 두 쪽이 같은 줄을 동시에 지우고, 늦은 쪽은 이미 지운 줄을 건너뛴다.
      const holder = new pg.Client({ connectionString: db.uri });
      await holder.connect();
      let tsDeleted = 0;
      let rust: ReturnType<typeof cargo>;
      try {
        await holder.query('begin');
        await holder.query(`select id from event_outbox where event->>'t' = $1 for update`, [tag]);
        rust = cargo(['test', '--test', 'outbox_prune', '--', '--nocapture'], {
          HARKROOM_TEST_DATABASE_URL: db.uri,
          HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, OUTBOX_PRUNE_GRANTS),
          HARKROOM_OUTBOX_PRUNE_DUAL: tag,
        });
        const t0 = Date.now();
        while (Number((await db.pool.query(
          `select count(*)::int as n from pg_stat_activity where application_name = 'harkroom-outbox-prune-dual' and wait_event_type = 'Lock'`)).rows[0].n) === 0) {
          if (Date.now() - t0 > 540_000) throw new Error('rust delete never waited on the row lock');
          await new Promise((r) => setTimeout(r, 20));
        }
        const tsPrune = pruneEventOutbox(db.pool);
        const t1 = Date.now();
        while (await lockWaiters() < 2) {
          if (Date.now() - t1 > 10_000) throw new Error('ts delete never waited on the row lock');
          await new Promise((r) => setTimeout(r, 20));
        }
        await holder.query('rollback');
        tsDeleted += await tsPrune;
      } finally {
        await holder.end();
      }
      while (await old() > 0) tsDeleted += await pruneEventOutbox(db.pool);
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/outbox-prune-dual rust deleted (\d+) overlapped (\d+)/);
      expect(m, r.out).not.toBeNull();
      expect(tsDeleted + Number(m![1])).toBe(20000);
      expect(Number(m![2]), r.out).toBeGreaterThan(0);
      const left = (await db.pool.query<{ k: string }>(
        `select event->>'k' as k from event_outbox where event->>'t' = $1`, [tag])).rows.map((x) => x.k);
      expect(left).toEqual(['keep']);
      console.log(`outbox-prune-dual: rust ${m![1]} (overlapped sweeps ${m![2]}) / ts ${tsDeleted}`);
    } finally {
      await db.stop();
    }
  }, 600_000);

  // C5c-3a — 지난 일감 3000개(죽은 running 1500 + 어제 queued 1500)를 TS `close`(스위치 켬)와 Rust `loops::bg::close` 가 **문지기 없이
  // 동시에** 닫아도 닫은 수의 합이 정확히 3000 이다(한 줄은 한 번만 닫힌다). 겹침은 줄 잠금으로 확실히 만든다 — 두 쪽이 같은 줄에서 기다리다 함께 풀린다. 이 sweep 은 skip locked 가 아니라 조건부 update 라,
  // 늦은 쪽은 줄 잠금을 기다린 뒤 조건(status)을 다시 보고 건너뛴다.
  it('bg 회차 닫기 — TS·Rust 동시 닫기에도 닫은 수 합이 정확하다', async () => {
    const db = await startTestDb();
    try {
      // (account, kind, day) 유일 — 에이전트 1000명 × (running 하나·queued 하나·남을 것 하나).
      await db.pool.query(
        `insert into account(handle, display_name, kind) select 'bgd' || g, 'bgd' || g, 'agent' from generate_series(1, 1500) g`);
      const ids = (await db.pool.query<{ id: string }>(`select id from account where handle like 'bgd%'`)).rows.map((r) => r.id);
      await db.pool.query(
        `insert into bg_job (account_id, kind, day, status, claimed_at)
         select a, 'distill', (now() at time zone 'Asia/Seoul')::date, 'running', now() - interval '20 minutes' from unnest($1::uuid[]) a
         union all select a, 'cleanup', (now() at time zone 'Asia/Seoul')::date - 1, 'queued', null from unnest($1::uuid[]) a
         union all select a, 'organize', (now() at time zone 'Asia/Seoul')::date, 'queued', null from unnest($1::uuid[]) a`, [ids]);
      const { createBgJobSweeper } = await import('../src/services/bgJobs.js');
      const ts = createBgJobSweeper(db.pool, { HARKROOM_BACKGROUND_ENABLED: '1' });
      const left = async () => Number((await db.pool.query(
        `select count(*)::int as n from bg_job where (status = 'running' and claimed_at < now() - interval '15 minutes')
            or (status = 'queued' and day < (now() at time zone 'Asia/Seoul')::date)`)).rows[0].n);
      const holder = await db.pool.connect();
      await holder.query('begin');
      await holder.query(`select id from bg_job where (status = 'running' and claimed_at < now() - interval '15 minutes')
                             or (status = 'queued' and day < (now() at time zone 'Asia/Seoul')::date) for update`);
      const tsFirst = ts.close();
      const rust = cargo(['test', '--test', 'bg', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, BG_GRANTS),
        HARKROOM_BG_DUAL: ids[0]!,
      });
      const t0 = Date.now();
      while (Number((await db.pool.query(
        `select count(*)::int as n from pg_stat_activity where application_name = 'harkroom-bg-dual'`)).rows[0].n) === 0) {
        if (Date.now() - t0 > 540_000) throw new Error('rust side never connected');
        await new Promise((r) => setTimeout(r, 20));
      }
      // TS 의 close 와 Rust 의 close 가 둘 다 줄 잠금에서 기다리는가.
      while (Number((await db.pool.query(
        `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like 'update bg_job%'`)).rows[0].n) < 2) {
        if (Date.now() - t0 > 540_000) throw new Error('both sides never waited on the row locks');
        await new Promise((r) => setTimeout(r, 20));
      }
      // 겹침을 확실히 만든다: 닫힐 줄을 모두 잠근 채 두 쪽이 다 잠금에서 기다릴 때까지 둔 뒤 놓는다.
      let tsT = 0; let tsE = 0;
      await holder.query('commit');
      holder.release();
      const first = await tsFirst;
      tsT += first.timeout; tsE += first.expired;
      while (await left() > 0) { const c = await ts.close(); tsT += c.timeout; tsE += c.expired; }
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/bg-dual rust timeout (\d+) expired (\d+) overlapped (\d+)/);
      expect(m, r.out).not.toBeNull();
      expect(tsT + Number(m![1])).toBe(1500);
      expect(tsE + Number(m![2])).toBe(1500);
      const kept = Number((await db.pool.query(`select count(*)::int as n from bg_job where status = 'queued' and kind = 'organize'`)).rows[0].n);
      expect(kept).toBe(1500);
      expect(Number(m![3]), r.out).toBeGreaterThan(0);
      console.log(`bg-dual: rust ${m![1]}+${m![2]} (overlapped ${m![3]}) / ts ${tsT}+${tsE}`);
    } finally {
      await db.stop();
    }
  }, 600_000);

  // C5c-3b-1 — 같은 시드에 Rust `produce_distill` 과 TS `produceDistillJobs` 를 차례로 돌려 생긴 bg_job 줄(account·kind·day·input)이 같다.
  // 경우: 메모 있음 · 메모 없고 사람 글 있음 / 들어감 — 사람 글 없음 · 비공개 채널 비멤버 · 다른 하네스 · done 1시간 / 빠짐.
  it('bg 증류 생산 — TS·Rust 가 같은 시드에서 같은 줄을 넣는다', async () => {
    const db = await startTestDb();
    try {
      const q = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.pool.query<T>(sql, args)).rows;
      const acct = async (handle: string, kind: string) =>
        (await q<{ id: string }>(
          `insert into account(handle, display_name, kind, login_id) values ($1, $1, $2, case when $2 = 'human' then $1 end) returning id`, [handle, kind]))[0]!.id;
      const cfg = async (id: string, harness: string) => q(
        `insert into agent_config (account_id, bg_enabled, harness) values ($1, true, $2)
         on conflict (account_id) do update set bg_enabled = true, harness = $2`, [id, harness]);
      const human = await acct('bgp_h', 'human');
      const a = await acct('bgp_x', 'agent');
      await cfg(a, 'claude-code');
      const cx = await acct('bgp_cx', 'agent');
      await cfg(cx, 'codex');
      const ch = async (vis: string) => (await q<{ id: string }>(
        `insert into channel(name, kind, visibility) values ('bgp-' || gen_random_uuid(), 'standard', $1) returning id`, [vis]))[0]!.id;
      const pub = await ch('public');
      const priv = await ch('private');
      const thread = async (channel: string, author: string, opts: { note?: boolean; humanReply?: boolean; doneAgo: string }) => {
        const root = (await q<{ id: string }>(
          `insert into message(channel_id, author_id, body, kind) values ($1, $2, '보고', 'user') returning id`, [channel, author]))[0]!.id;
        if (opts.humanReply) {
          await q(`insert into message(channel_id, author_id, body, kind, thread_root_id) values ($1, $2, '정정', 'user', $3)`, [channel, human, root]);
        }
        if (opts.note) await q(`insert into thread_note (account_id, thread_root_id, body) values ($1, $2, '메모')`, [author, root]);
        await q(`insert into thread_status (root_id, status, emoji, account_id, updated_at) values ($1, 'done', '✅', $2, now() - $3::interval)`,
          [root, author, opts.doneAgo]);
        return root;
      };
      const withNote = await thread(pub, a, { note: true, doneAgo: '48 hours' });
      const corrected = await thread(pub, a, { humanReply: true, doneAgo: '50 hours' });
      const selfOnly = await thread(pub, a, { doneAgo: '52 hours' });
      const hidden = await thread(priv, a, { note: true, doneAgo: '54 hours' });
      const otherHarness = await thread(pub, cx, { note: true, doneAgo: '56 hours' });
      const fresh = await thread(pub, a, { note: true, doneAgo: '1 hour' });

      const dump = async () => (await q<{ account_id: string; kind: string; day: string; input: { threadIds: string[] } }>(
        `select account_id, kind, day::text as day, input from bg_job order by account_id, kind`))
        .map((r) => ({ ...r, input: { threadIds: [...r.input.threadIds] } }));
      const rust = await cargo(['test', '--test', 'bg_produce', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, BG_PRODUCE_GRANTS),
        HARKROOM_BG_PRODUCE_ONLY: '1',
      });
      expect(rust.code, rust.out).toBe(0);
      expect(rust.out, rust.out).toMatch(/bg-produce rust queued 1 day \d{4}-\d{2}-\d{2}/);
      const rs = await dump();
      await q(`delete from bg_job`);
      // TS 는 앱 시계로 돈다 — 같은 KST 날짜의 04:00(창 안)으로 맞춘다. done 시각은 이 차이(최대 하루)보다 넉넉히 떨어뜨렸다.
      const day = (await q<{ d: string }>(`select (now() at time zone 'Asia/Seoul')::date::text as d`))[0]!.d;
      const { produceDistillJobs } = await import('../src/services/bgJobs.js');
      const tsOut = await produceDistillJobs(db.pool, new Date(`${day}T04:00:00+09:00`), { HARKROOM_BACKGROUND_ENABLED: '1' });
      expect(tsOut.queued).toBe(1);
      const ts = await dump();
      expect(rs).toEqual(ts);
      expect(rs).toEqual([{ account_id: a, kind: 'distill', day, input: { threadIds: [corrected, withNote] } }]);
      for (const x of [selfOnly, hidden, otherHarness, fresh]) expect(rs[0]!.input.threadIds).not.toContain(x);
    } finally {
      await db.stop();
    }
  }, 600_000);

  // C5c-3b-2 — 하루 상한은 TS·Rust 가 **동시에** 생산해도 지켜진다: 후보 에이전트 10, 상한 3. 날짜 advisory 잠금을 시험이 먼저 쥐고 두 쪽이
  // 다 그 잠금에서 기다릴 때 놓는다(겹침을 확실히). 넣은 줄 합이 정확히 3 — 상한 비교가 `<` 가 아니면(예: `<=`) 4 가 되어 빨개진다.
  it('bg 생산 하루 상한 — TS·Rust 동시 생산에도 상한을 넘지 않는다', async () => {
    const db = await startTestDb();
    try {
      const q = async <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.pool.query<T>(sql, args)).rows;
      const ch = (await q<{ id: string }>(`insert into channel(name, kind, visibility) values ('bgcap', 'standard', 'public') returning id`))[0]!.id;
      for (let i = 0; i < 10; i++) {
        const a = (await q<{ id: string }>(`insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id`, [`bgcap${i}`]))[0]!.id;
        await q(`insert into agent_config (account_id, bg_enabled, harness) values ($1, true, 'claude-code')
                 on conflict (account_id) do update set bg_enabled = true, harness = 'claude-code'`, [a]);
        const root = (await q<{ id: string }>(`insert into message(channel_id, author_id, body, kind) values ($1, $2, '보고', 'user') returning id`, [ch, a]))[0]!.id;
        await q(`insert into thread_note (account_id, thread_root_id, body) values ($1, $2, '메모')`, [a, root]);
        await q(`insert into thread_status (root_id, status, emoji, account_id, updated_at) values ($1, 'done', '✅', $2, now() - interval '48 hours')`, [root, a]);
      }
      const day = (await q<{ d: string }>(`select to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d`))[0]!.d;
      const holder = await db.pool.connect();
      await holder.query('begin');
      await holder.query(`select pg_advisory_xact_lock(hashtext('bg_job_daily:' || $1))`, [day]);
      const { produceDistillJobs } = await import('../src/services/bgJobs.js');
      const env = { HARKROOM_BACKGROUND_ENABLED: '1', HARKROOM_BACKGROUND_DAILY_MAX: '3' };
      const tsRun = produceDistillJobs(db.pool, new Date(`${day}T04:00:00+09:00`), env);
      const rust = cargo(['test', '--test', 'bg_produce', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, BG_PRODUCE_GRANTS),
        HARKROOM_BG_PRODUCE_ONLY: '1',
        HARKROOM_BG_PRODUCE_MAX: '3',
      });
      const t0 = Date.now();
      while (Number((await q<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like 'select pg_advisory_xact_lock%'`))[0]!.n) < 2) {
        if (Date.now() - t0 > 540_000) throw new Error('both sides never waited on the day lock');
        await new Promise((r) => setTimeout(r, 20));
      }
      await holder.query('commit');
      holder.release();
      const tsOut = await tsRun;
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/bg-produce rust queued (\d+) day/);
      expect(m, r.out).not.toBeNull();
      const rows = Number((await q<{ n: number }>(`select count(*)::int as n from bg_job where day = $1::date`, [day]))[0]!.n);
      expect(rows).toBe(3);
      expect(tsOut.queued + Number(m![1])).toBe(3);
      console.log(`bg-cap: rust ${m![1]} / ts ${tsOut.queued} (refused ts ${JSON.stringify(tsOut.refused)})`);
    } finally {
      await db.stop();
    }
  }, 600_000);

  // C5c-2a — 7일 넘은 위임 500건(묶음 3번 분량, 각자 살아 있는 줄 하나)을 TS sweep(`endIdleMandates`)과 Rust sweep 이 **문지기 없이 동시에**
  // 끝내도 한 위임은 한 번만 끝난다(skip locked + ended_at is null) — 끝낸 수 합 500 · 감사 500 · 위임마다 감사 한 줄 · 줄 전부 revoked.
  it('위임 idle 끝 — TS·Rust 동시 sweep 에도 500건이 정확히 한 번씩 끝난다', async () => {
    const db = await startTestDb();
    try {
      const a = (await db.pool.query<{ id: string }>(
        `insert into account(handle, display_name, kind) values ('mi_dual', 'mi_dual', 'agent') returning id`)).rows[0]!.id;
      const c = (await db.pool.query<{ id: string }>(`insert into channel(name, kind) values ('mi-dual', 'standard') returning id`)).rows[0]!.id;
      await db.pool.query(
        `with r as (insert into message(channel_id, author_id, body, kind)
                    select $2, $1, 'm' || g, 'user' from generate_series(1, 500) g returning id),
              m as (insert into mandate(owner_account_id, delegator_account_id, root_message_id, channel_id, thread_root_id, last_activity_at)
                    select $1, $1, r.id, $2, r.id, now() - interval '8 days' from r returning id)
         insert into mandate_line(mandate_id, cap, scope, granted_by, via) select m.id, 'tool', 'Bash(git status)', $1, 'button' from m`, [a, c]);
      const { endIdleMandates } = await import('../src/services/mandateEnd.js');
      const open = async () => Number((await db.pool.query(
        `select count(*)::int as n from mandate where owner_account_id = $1 and ended_at is null`, [a])).rows[0].n);
      const rust = cargo(['test', '--test', 'mandate_idle', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, MANDATE_IDLE_GRANTS),
        HARKROOM_MANDATE_IDLE_DUAL: a,
      });
      const t0 = Date.now();
      while (Number((await db.pool.query(
        `select count(*)::int as n from pg_stat_activity where application_name = 'harkroom-mandate-idle-dual'`)).rows[0].n) === 0) {
        if (Date.now() - t0 > 540_000) throw new Error('rust side never connected');
        await new Promise((r) => setTimeout(r, 20));
      }
      let tsEnded = 0;
      while (await open() > 0) tsEnded += await endIdleMandates(db.pool, { limit: 20 });
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/mandate-idle-dual rust ended (\d+) overlapped (\d+)/);
      expect(m, r.out).not.toBeNull();
      expect(tsEnded + Number(m![1])).toBe(500);
      const counts = (await db.pool.query(
        `select (select count(*)::int from mandate where owner_account_id = $1 and end_reason = 'idle') as ended,
                (select count(*)::int from mandate_line l join mandate d on d.id = l.mandate_id
                  where d.owner_account_id = $1 and l.revoked_at is null) as live,
                (select count(*)::int from audit_log g join mandate d on g.target = d.id::text
                  where d.owner_account_id = $1 and g.action = 'mandate.ended') as audits,
                (select count(distinct g.target)::int from audit_log g join mandate d on g.target = d.id::text
                  where d.owner_account_id = $1 and g.action = 'mandate.ended') as distinct_audits`, [a])).rows[0];
      expect(counts).toEqual({ ended: 500, live: 0, audits: 500, distinct_audits: 500 });
      console.log(`mandate-idle-dual: rust ${m![1]} (overlapped sweeps ${m![2]}) / ts ${tsEnded}`);
    } finally {
      await db.stop();
    }
  }, 600_000);

  // C5c-2b — 시한 지난 권한 요청 500건(묶음 10번 분량, 각자 열린 카드 하나)을 TS sweep(`expirePermissionRequests`)과 Rust sweep 이
  // **문지기 없이 동시에** 만료해도 한 요청은 한 번만 만료된다(skip locked + status = 'pending') — 만료 수 합 500 · 감사 500(요청마다 하나) ·
  // 카드 전부 expired 로 닫힘 · 카드마다 에이전트 깨움(ask_closed) 정확히 하나.
  it('권한 요청 만료 — TS·Rust 동시 sweep 에도 500건이 정확히 한 번씩 만료된다', async () => {
    const db = await startTestDb();
    try {
      const a = (await db.pool.query<{ id: string }>(
        `insert into account(handle, display_name, kind) values ('pe_dual', 'pe_dual', 'agent') returning id`)).rows[0]!.id;
      const c = (await db.pool.query<{ id: string }>(`insert into channel(name, kind) values ('pe-dual', 'standard') returning id`)).rows[0]!.id;
      await db.pool.query(
        `with r as (insert into permission_request(agent_id, kind, target, reason, channel_id, thread_root_id, expires_at)
                    select $1, 'tool', 'Bash(n' || g || ')', 'x', $2, gen_random_uuid(), now() - interval '1 minute'
                      from generate_series(1, 500) g returning id),
              m as (insert into message(channel_id, author_id, body, kind, meta)
                    select $2, $1, 'card', 'user', jsonb_build_object(
                      'permissionRequest', jsonb_build_object('requestId', r.id::text, 'status', 'pending'),
                      'ask', jsonb_build_object('question', 'q', 'options', jsonb_build_array('ok'), 'reqId', r.id::text))
                      from r returning id)
         select count(*) from m`, [a, c]);
      // 같은 문장의 CTE 가 넣은 줄은 바깥 update 에 안 보인다 — 카드 잇기는 따로.
      await db.pool.query(
        `update permission_request p set card_message_id = g.id from message g
          where p.agent_id = $1 and g.channel_id = $2 and g.meta->'ask'->>'reqId' = p.id::text`, [a, c]);
      const { expirePermissionRequests } = await import('../src/services/permissionRequests.js');
      const due = async () => Number((await db.pool.query(
        `select count(*)::int as n from permission_request where agent_id = $1 and status = 'pending'`, [a])).rows[0].n);
      const rust = cargo(['test', '--test', 'permission_expire', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, PERMISSION_EXPIRE_GRANTS),
        HARKROOM_PERMISSION_EXPIRE_DUAL: a,
      });
      const t0 = Date.now();
      while (Number((await db.pool.query(
        `select count(*)::int as n from pg_stat_activity where application_name = 'harkroom-permission-expire-dual'`)).rows[0].n) === 0) {
        if (Date.now() - t0 > 540_000) throw new Error('rust side never connected');
        await new Promise((r) => setTimeout(r, 20));
      }
      let tsExpired = 0;
      while (await due() > 0) tsExpired += await expirePermissionRequests(db.pool, { now: new Date() });
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/permission-expire-dual rust expired (\d+) overlapped (\d+)/);
      expect(m, r.out).not.toBeNull();
      expect(tsExpired + Number(m![1])).toBe(500);
      const counts = (await db.pool.query(
        `select (select count(*)::int from permission_request where agent_id = $1 and status = 'expired') as expired,
                (select count(*)::int from message g join permission_request p on p.card_message_id = g.id
                  where p.agent_id = $1 and g.meta->'ask'->>'closedReason' = 'expired'
                    and g.meta->'permissionRequest'->>'status' = 'expired') as closed,
                (select count(*)::int from audit_log g join permission_request p on g.detail->>'requestId' = p.id::text
                  where p.agent_id = $1 and g.action = 'permission.expired') as audits,
                (select count(distinct g.detail->>'requestId')::int from audit_log g join permission_request p on g.detail->>'requestId' = p.id::text
                  where p.agent_id = $1 and g.action = 'permission.expired') as distinct_audits,
                (select count(*)::int from inbox i join permission_request p on p.card_message_id = i.message_id
                  where p.agent_id = $1 and i.account_id = $1 and i.reason = 'ask_closed') as wakes,
                (select count(distinct i.message_id)::int from inbox i join permission_request p on p.card_message_id = i.message_id
                  where p.agent_id = $1 and i.account_id = $1 and i.reason = 'ask_closed') as distinct_wakes`, [a])).rows[0];
      expect(counts).toEqual({ expired: 500, closed: 500, audits: 500, distinct_audits: 500, wakes: 500, distinct_wakes: 500 });
      console.log(`permission-expire-dual: rust ${m![1]} (overlapped sweeps ${m![2]}) / ts ${tsExpired}`);
    } finally {
      await db.stop();
    }
  }, 600_000);
});

// S5.3 C6b — 턴 임대 동시 발급. TS `issueTurnLease` 와 Rust `core::turn_lease::issue` 가 같은 DB 에서 같은 부름들을 두고 맞붙어도
// 부름마다 살아 있는 임대는 정확히 하나다(같은 advisory 열쇠로 줄을 선다). 양쪽은 출발 잠금으로 같이 출발해 같은 차례로 넷씩 청한다 — 열쇠가 어긋나면
// 살아 있는 임대 유일 색인의 23505 가 어느 한쪽에서 터져 실패한다(망가뜨리기 시험으로 확인). 한쪽이 받으면 다른 쪽은 lease_used 다.
describe.skipIf(!ON)('턴 임대 — TS·Rust 동시 발급', () => {
  it('부름 300개를 양쪽이 동시에 청해도 부름마다 임대 하나', async () => {
    const N = 300;
    const db = await startTestDb();
    try {
      const q1 = async (sql: string, args: unknown[] = []) => (await db.pool.query<{ id: string }>(sql, args)).rows[0]!.id;
      const human = await q1(`insert into account(handle, display_name, kind, login_id) values ('tl_h', 'tl_h', 'human', 'tl_h') returning id`);
      const agent = await q1(`insert into account(handle, display_name, kind) values ('tl_a', 'tl_a', 'agent') returning id`);
      const op = await q1(`insert into operator(owner_account_id, name, token_hash) values ($1, 'op', 'x') returning id`, [human]);
      const ch = await q1(`insert into channel(name, kind) values ('tl-dual', 'standard') returning id`);
      await db.pool.query(
        `with m as (insert into message(channel_id, author_id, body, kind)
                    select $1, $2, 'm' || g, 'user' from generate_series(1, ${N}) g returning id)
         insert into inbox(account_id, message_id, reason) select $3, id, 'mention' from m`, [ch, human, agent]);
      const causes = (await db.pool.query<{ id: string }>(
        `select message_id as id from inbox where account_id = $1 order by created_at, message_id`, [agent])).rows.map((r) => r.id);
      const { issueTurnLease } = await import('../src/services/secretAccess.js');
      const rust = cargo(['test', '--test', 'turn_lease', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri,
        HARKROOM_TEST_WRITE_DATABASE_URL: await operatorWriteRole(db, TURN_LEASE_GRANTS),
        HARKROOM_TURN_LEASE_DUAL: `${agent}:${op}`,
      });
      // 출발 잠금 — Rust 가 이 잠금을 기다리기 시작하면 풀고 양쪽이 같이 출발한다.
      const gate = await db.pool.connect();
      await gate.query(`select pg_advisory_lock(hashtext('turn-lease-dual-start'))`);
      const t0 = Date.now();
      while (Number((await db.pool.query(
        `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`)).rows[0].n) === 0) {
        if (Date.now() - t0 > 540_000) { gate.release(); throw new Error('rust side never reached the start gate'); }
        await new Promise((r) => setTimeout(r, 20));
      }
      await gate.query(`select pg_advisory_unlock(hashtext('turn-lease-dual-start'))`);
      gate.release();
      let tsIssued = 0; let tsUsed = 0;
      // 넷씩 나란히 — TS 쪽 안에서도 겹친다.
      for (let i = 0; i < causes.length; i += 4) {
        const out = await Promise.all(causes.slice(i, i + 4).map((c) =>
          issueTurnLease(db.pool, { agentId: agent, operatorId: op, causeMessageId: c })));
        for (const o of out) {
          if (o.ok) tsIssued += 1;
          else if (o.code === 'lease_used') tsUsed += 1;
          else throw new Error(`unexpected ${o.code}`);
        }
      }
      const r = await rust;
      expect(r.code, r.out).toBe(0);
      const m = r.out.match(/turn-lease-dual rust issued (\d+) used (\d+) other (\d+)/);
      expect(m, r.out).not.toBeNull();
      const [rsIssued, rsUsed, rsOther] = [Number(m![1]), Number(m![2]), Number(m![3])];
      expect(rsOther).toBe(0);
      // 받은 수 합 = 부름 수, 거절 수 합 = 부름 수(한쪽이 받으면 다른 쪽은 거절).
      expect(tsIssued + rsIssued).toBe(N);
      expect(tsUsed + rsUsed).toBe(N);
      // 누가 더 받는지는 지연에 달렸다(같은 차례라 앞선 쪽이 대개 다 받고 뒤쪽은 열쇠에서 기다린 뒤 lease_used). 겹침 자체는
      // 열쇠를 어긋나게 한 망가뜨리기 시험이 23505 로 빨개지는 것으로 확인했다.
      const rows = (await db.pool.query(
        `select count(*)::int as total, count(distinct cause_message_id)::int as causes,
                count(*) filter (where ended_at is null)::int as live
           from secret_turn_lease where agent_id = $1`, [agent])).rows[0];
      expect(rows).toEqual({ total: N, causes: N, live: N });
      console.log(`turn-lease-dual: rust ${rsIssued} / ts ${tsIssued}`);
    } finally {
      await db.stop();
    }
  }, 600_000);
});

// S5.3 C1a — 받는 사람 계산(`core/audience.rs`)이 TS 함수와 같은 답인가. 픽스처는 TS 서비스 함수로 넣고 Rust 시험이 찍은 답과 맞춘다.
// 멤버 순서는 TS 도 정하지 않으므로 정렬해 본다.
describe.skipIf(!ON)('받는 사람 계산 — TS·Rust 같은 답', () => {
  it('공개·비공개·DM·탈퇴자·admin·없는 채널', async () => {
    const db = await startTestDb();
    try {
      const pool = db.pool;
      const acct = async (handle: string, admin: boolean): Promise<string> => (await pool.query(
        `insert into account(handle, display_name, kind, login_id, role, is_admin)
         values ($1, $1, 'human', $1, $2, $3) returning id`, [handle, admin ? 'admin' : 'member', admin],
      )).rows[0].id as string;
      const admin = await acct('aud-admin', true);
      const m1 = await acct('aud-m1', false);
      const m2 = await acct('aud-m2', false);
      const leaver = await acct('aud-leaver', false);
      await acct('aud-outsider', false);
      const pub = await createChannel(pool, { name: 'aud-pub' });
      const priv = await createChannel(pool, { name: 'aud-priv', visibility: 'private', creatorId: m1 });
      await addChannelMember(pool, priv.id, leaver);
      await removeChannelMember(pool, priv.id, leaver);
      // public 채널에 멤버로 들어간 사람이 있어도 전원이다.
      await addChannelMember(pool, pub.id, m2);
      const dm = await getOrCreateDm(pool, [m1, m2]);
      const missing = '00000000-0000-4000-8000-000000000000';
      const ids = [pub.id, priv.id, dm.id, missing];
      const norm = (a: 'all' | string[]) => (a === 'all' ? a : [...a].sort());
      const want: Record<string, unknown> = {};
      for (const id of ids) {
        want[id] = {
          for: norm(await audienceFor(pool, id)),
          list: norm(await channelListAudience(pool, id)),
          lost: [...(await channelListLostAudience(pool, id))].sort(),
        };
      }
      // 픽스처가 갈래를 실제로 가르는지(전부 'all' 이면 대조가 아무것도 못 잡는다).
      expect(want[priv.id]).toMatchObject({ for: [m1], list: [admin, m1].sort() });
      expect((want[dm.id] as { for: string[] }).for).toEqual([m1, m2].sort());
      const r = await cargo(['test', '--test', 'audience', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri, HARKROOM_AUDIENCE_CHANNELS: ids.join(','),
      });
      expect(r.code, r.out).toBe(0);
      const line = r.out.split('\n').find((l) => l.startsWith('AUDIENCE_JSON '));
      expect(line, r.out).toBeDefined();
      expect(JSON.parse(line!.slice('AUDIENCE_JSON '.length))).toEqual(want);
    } finally {
      await db.stop();
    }
  }, 600_000);
});

// S5.3 C3a-3b-1 — 호출 게이트(`core/invoke_gate.rs`)가 TS `invokeGate.ts` 와 같은 판정인가. 범위 넷·꺼짐·지움·설정 없음·형제 신뢰(083)·
// 대리 명단(073)·회신권(084: 열림·만료·닫힘)·팀 범위(068)를 실제 행으로 넣고, 축(에이전트×호출자×채널×부름 길×스레드)의 곱 전부를
// 두 쪽이 같은 순서로 판정한다. 갈래마다 참·거짓이 둘 다 나오는지도 본다(전부 같은 답이면 대조가 아무것도 못 잡는다).
describe.skipIf(!ON)('호출 게이트 — TS·Rust 같은 판정', () => {
  it('범위·꺼짐·대리 호출자·회신권·팀', async () => {
    const db = await startTestDb();
    const client = await db.pool.connect();
    try {
      const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
      const human = async (handle: string): Promise<string> => (await q(
        `insert into account(handle, display_name, kind, login_id, role, is_admin)
         values ($1, $1, 'human', $1, 'member', false) returning id`, [handle])).rows[0].id as string;
      const agent = async (
        handle: string,
        cfg: { scope: string; owner?: string | null; trust?: boolean } | null,
        state: { disabled?: boolean; deleted?: boolean } = {},
      ): Promise<string> => {
        const id = (await q(
          `insert into account(handle, display_name, kind, role, is_admin, disabled_at, deleted_at)
           values ($1, $1, 'agent', 'member', false, case when $2 then now() end, case when $3 then now() end) returning id`,
          [handle, Boolean(state.disabled), Boolean(state.deleted)])).rows[0].id as string;
        if (cfg) {
          await q(`insert into agent_config(account_id, invoke_scope, owner_account_id, trust_siblings) values ($1, $2, $3, $4)`,
            [id, cfg.scope, cfg.owner ?? null, cfg.trust ?? true]);
        }
        return id;
      };
      const owner = await human('ig-owner');
      const other = await human('ig-other');
      const member = await human('ig-member');
      const lister = await human('ig-lister');
      const aCom = await agent('ig-com', { scope: 'community', owner });
      const aOwn = await agent('ig-own', { scope: 'owner', owner, trust: false });
      const aOwnTrust = await agent('ig-own-trust', { scope: 'owner', owner, trust: true });
      const aList = await agent('ig-list', { scope: 'list', owner });
      const aChan = await agent('ig-chan', { scope: 'channel', owner });
      const aOff = await agent('ig-off', { scope: 'community', owner }, { disabled: true });
      const aGone = await agent('ig-gone', { scope: 'owner', owner }, { deleted: true });
      const aBare = await agent('ig-bare', null);
      const aOrphan = await agent('ig-orphan', { scope: 'owner', owner: null });
      // 대리 호출자 후보 — 같은 소유자의 owner 에이전트(명단 밖·명단 안), 같은 소유자의 community, 남의 owner, 지운 형제.
      const sib = await agent('ig-sib', { scope: 'owner', owner });
      const sibListed = await agent('ig-sib-listed', { scope: 'owner', owner });
      const sibCom = await agent('ig-sib-com', { scope: 'community', owner });
      const sibOther = await agent('ig-sib-other', { scope: 'owner', owner: other });
      const sibGone = await agent('ig-sib-gone', { scope: 'owner', owner }, { deleted: true });
      const replier = await agent('ig-replier', { scope: 'community', owner: other });
      const expired = await agent('ig-expired', { scope: 'community', owner: other });
      const closed = await agent('ig-closed', { scope: 'community', owner: other });
      await q(`insert into agent_owner_delegate(agent_id, delegate_id) values ($1, $2), ($3, $2)`, [aOwn, sibListed, aGone]);
      await q(`insert into agent_invoker(agent_id, account_id) values ($1, $2)`, [aList, lister]);
      const ch = await createChannel(db.pool, { name: 'ig-ch' });
      await addChannelMember(db.pool, ch.id, member);
      const dm = await getOrCreateDm(db.pool, [member, other]);
      const thread = (await q(`insert into message(channel_id, author_id, body, kind) values ($1, $2, 'root', 'user') returning id`,
        [ch.id, owner])).rows[0].id as string;
      const otherThread = (await q(`insert into message(channel_id, author_id, body, kind) values ($1, $2, 'root2', 'user') returning id`,
        [ch.id, owner])).rows[0].id as string;
      // 회신권: replier←aOwn 열림, expired←aOwn 만료, closed←aOwn 닫힘. aList→replier 도 열어 둔다(같은 스레드·다른 대상).
      await q(`insert into invoke_reply_grant(grantee_id, granter_id, thread_root_id, expires_at, closed_at) values
        ($1, $4, $5, now() + interval '1 hour', null),
        ($2, $4, $5, now() - interval '1 second', null),
        ($3, $4, $5, now() + interval '1 hour', now()),
        ($1, $6, $5, now() + interval '1 hour', null)`, [replier, expired, closed, aOwn, thread, aList]);
      const team = async (name: string, scope: string, ownerId: string | null) => (await q(
        `insert into agent_team(name, created_by, invoke_scope, owner_account_id) values ($1, $2, $3, $4)
         returning id as "teamId", invoke_scope as "invokeScope", owner_account_id as "ownerAccountId"`,
        [name, owner, scope, ownerId])).rows[0] as TeamInvokeFacts;
      const tCom = await team('ig-t-com', 'community', owner);
      const tOwn = await team('ig-t-own', 'owner', owner);
      const tOrphan = await team('ig-t-orphan', 'owner', null);
      const tList = await team('ig-t-list', 'list', owner);
      const tChan = await team('ig-t-chan', 'channel', owner);
      await q(`insert into agent_team_invoker(team_id, account_id) values ($1, $2)`, [tList.teamId, lister]);

      const missing = '00000000-0000-4000-8000-000000000000';
      const agents = [aCom, aOwn, aOwnTrust, aList, aChan, aOff, aGone, aBare, aOrphan];
      const axes = {
        factIds: [...agents, owner, missing],
        agents,
        callers: [owner, other, member, lister, sib, sibListed, sibCom, sibOther, sibGone, replier, expired, closed, aOwn],
        channels: [ch.id, dm.id, ''],
        vias: ['mention', 'team', 'group', 'channel_all', 'auto_mention'] satisfies InvokeVia[],
        threads: [null, thread, otherThread],
        teams: [tCom, tOwn, tOrphan, tList, tChan],
      };

      const facts = await invokeFactsFor(client, axes.factIds);
      const want = {
        facts: Object.fromEntries([...facts].map(([id, f]) => [id, { invokeScope: f.invokeScope, ownerAccountId: f.ownerAccountId, off: f.off }])),
        agent: [] as boolean[],
        delegate: [] as boolean[],
        team: [] as boolean[],
      };
      for (const a of agents) for (const callerId of axes.callers) for (const channelId of axes.channels)
        for (const via of axes.vias) for (const replyGrantThreadId of axes.threads)
          want.agent.push(await mayInvoke(client, facts.get(a)!, { callerId, channelId, via, replyGrantThreadId }));
      for (const a of agents) for (const callerId of axes.callers) for (const listed of [true, false])
        want.delegate.push(await isEligibleDelegate(client, facts.get(a)!, callerId, { listed }));
      for (const t of axes.teams) for (const callerId of axes.callers) for (const channelId of axes.channels)
        want.team.push(await mayInvokeTeam(client, t, { callerId, channelId }));

      // 픽스처가 갈래를 실제로 가르는지 — TS 정본의 답으로 확인한다.
      const at = (a: string, c: string, chId: string, via: InvokeVia, t: string | null) =>
        want.agent[(((agents.indexOf(a) * axes.callers.length + axes.callers.indexOf(c)) * axes.channels.length
          + axes.channels.indexOf(chId)) * axes.vias.length + axes.vias.indexOf(via)) * axes.threads.length + axes.threads.indexOf(t)];
      expect(Object.keys(want.facts).sort(), '사람·없는 id 는 빠진다').toEqual([...agents].sort());
      expect(want.facts[aBare], '설정 없는 에이전트는 community').toMatchObject({ invokeScope: 'community', off: false });
      expect([want.facts[aOff]?.off, want.facts[aGone]?.off]).toEqual([true, true]);
      expect(at(aCom, other, '', 'auto_mention', null)).toBe(true);
      expect(at(aOff, owner, ch.id, 'mention', null)).toBe(false);
      expect([at(aOwn, owner, '', 'mention', null), at(aOwn, other, ch.id, 'mention', null), at(aOwn, owner, ch.id, 'group', null)])
        .toEqual([true, false, false]);
      expect([at(aOwn, sib, ch.id, 'mention', null), at(aOwn, sibListed, ch.id, 'mention', null), at(aOwnTrust, sib, ch.id, 'team', null),
        at(aOwnTrust, sibCom, ch.id, 'mention', null), at(aOwnTrust, sibOther, ch.id, 'mention', null), at(aOwnTrust, sibGone, ch.id, 'mention', null)])
        .toEqual([false, true, true, false, false, false]);
      expect([at(aList, lister, ch.id, 'mention', null), at(aList, other, ch.id, 'team', null)]).toEqual([true, false]);
      expect([at(aChan, member, ch.id, 'mention', null), at(aChan, member, dm.id, 'mention', null), at(aChan, other, ch.id, 'mention', null),
        at(aChan, member, '', 'mention', null)]).toEqual([true, false, false, false]);
      expect([at(aOwn, replier, ch.id, 'mention', thread), at(aOwn, replier, ch.id, 'team', thread), at(aOwn, replier, ch.id, 'mention', otherThread),
        at(aOwn, replier, ch.id, 'mention', null), at(aOwn, expired, ch.id, 'mention', thread), at(aOwn, closed, ch.id, 'mention', thread)])
        .toEqual([true, false, false, false, false, false]);
      for (const part of [want.agent, want.delegate, want.team]) expect(new Set(part)).toEqual(new Set([true, false]));

      const r = await cargo(['test', '--test', 'invoke_gate', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri, HARKROOM_INVOKE_AXES: JSON.stringify(axes),
      });
      expect(r.code, r.out).toBe(0);
      const line = r.out.split('\n').find((l) => l.startsWith('INVOKE_JSON '));
      expect(line, r.out).toBeDefined();
      const got = JSON.parse(line!.slice('INVOKE_JSON '.length)) as typeof want;
      expect(got.facts).toEqual(want.facts);
      // 어긋나면 첫 자리를 축 이름으로 보여 준다(2만 칸 배열 diff 는 읽을 수 없다).
      for (const k of ['agent', 'delegate', 'team'] as const) {
        expect(got[k].length, k).toBe(want[k].length);
        const i = got[k].findIndex((v, n) => v !== want[k][n]);
        expect(i, `${k} 첫 어긋남 #${i}`).toBe(-1);
      }
    } finally {
      client.release();
      await db.stop();
    }
  }, 600_000);
});

// S5.3 C3a-3b-2 — 「누구를 부르나」(`core/mention_calls.rs`)가 TS `resolveMentionCalls` 와 같은 판정인가. 같은 DB 에 픽스처를 넣고
// 사례마다 TS 답을 만든 뒤, 같은 사례를 Rust 시험에 넘겨 찍힌 답과 맞춘다(집합 칸은 정렬해 견준다).
describe.skipIf(!ON)('누구를 부르나 — TS·Rust 같은 판정', () => {
  it('사슬 상한·게이트·principal(켬/끔/하루 상한)·팀 계획·그룹·@channel·지칭', async () => {
    const db = await startTestDb();
    const client = await db.pool.connect();
    try {
      const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
      const acct = async (handle: string, kind: 'human' | 'agent', o: { admin?: boolean; disabled?: boolean } = {}) => (await q(
        `insert into account(handle, display_name, kind, login_id, role, is_admin, disabled_at)
         values ($1, $1, $2, case when $2 = 'human' then $1 end, $3, $4, case when $5 then now() end) returning id`,
        [handle, kind, o.admin ? 'admin' : 'member', Boolean(o.admin), Boolean(o.disabled)])).rows[0].id as string;
      const h1 = await acct('mc-h1', 'human', { admin: true });
      const h2 = await acct('mc-h2', 'human');
      const agent = async (handle: string, scope: string, owner: string | null, disabled = false) => {
        const id = await acct(handle, 'agent', { disabled });
        await q(`insert into agent_config(account_id, owner_account_id, invoke_scope) values ($1, $2, $3)`, [id, owner, scope]);
        return id;
      };
      const botc = await agent('mc-botc', 'community', h1);
      const boto = await agent('mc-boto', 'owner', h1);
      const botl = await agent('mc-botl', 'list', h1);
      const botch = await agent('mc-botch', 'channel', h1);
      const botoff = await agent('mc-botoff', 'community', h1, true);
      await q(`insert into agent_invoker(agent_id, account_id) values ($1, $2)`, [botl, h2]);
      const ch = (await createChannel(db.pool, { name: 'mc-room' })).id;
      await q(`insert into channel_member(channel_id, account_id) values ($1, $2)`, [ch, h2]);
      const team = async (name: string, scope: string, lead: string | null, members: string[]) => {
        const id = (await q(`insert into agent_team(name, created_by, invoke_scope, owner_account_id) values ($1, $2, $3, $2) returning id`,
          [name, h1, scope])).rows[0].id as string;
        for (const m of members) await q(`insert into agent_team_member(team_id, agent_account_id) values ($1, $2)`, [id, m]);
        if (lead) await q(`update agent_team set lead_account_id = $2 where id = $1`, [id, lead]);
        return id;
      };
      await team('mc-squad', 'community', botc, [botc, boto]);
      await team('mc-crowd', 'community', null, [botc, boto, botl, botoff]);
      await team('mc-locked', 'owner', null, [botc]);
      const g = (await q(`insert into handle_group(handle, display_name) values ('mc-crew', 'Crew') returning id`)).rows[0].id as string;
      for (const m of [h1, h2, botc]) await q(`insert into handle_group_member(group_id, account_id) values ($1, $2)`, [g, m]);
      await q(`update mention_policy set chain_limit = 3`);
      // h2 는 하루 상한(200)에 닿은 principal — 그의 권한으로 연 에이전트 글 200개.
      await q(`insert into message (channel_id, author_id, body, kind, meta, principal_account_id)
               select $1, $2, 'p', 'user', '{"invokedAsPrincipal":{}}'::jsonb, $3 from generate_series(1, 200)`, [ch, botc, h2]);
      const H = 3_600_000;
      const base = { channelId: ch, mentionDepth: 0, chainBound: false, chainStartedAtMs: null as number | null, principalId: null as string | null, principalInvokeEnabled: true, replyGrantThreadId: null as string | null };
      const cases = [
        { ...base, body: '@mc-botc @mc-boto @mc-botl @mc-botch hi @mc-h1', authorId: h2, authorIsAgent: false },
        { ...base, body: '@mc-boto @mc-botl 일', authorId: botc, authorIsAgent: true },
        { ...base, body: '@mc-boto 일', authorId: botc, authorIsAgent: true, principalId: h1 },
        { ...base, body: '@mc-boto 일', authorId: botc, authorIsAgent: true, principalId: h1, principalInvokeEnabled: false },
        { ...base, body: '@mc-botl 일', authorId: botc, authorIsAgent: true, principalId: h2 },
        { ...base, body: '@mc-boto 일', authorId: botc, authorIsAgent: true, principalId: h2 },
        { ...base, body: '@mc-botl @mc-h1 일', authorId: botc, authorIsAgent: true, mentionDepth: 3 },
        { ...base, body: '@mc-boto 일', authorId: h1, authorIsAgent: false, chainBound: true, mentionDepth: 1, chainStartedAtMs: Date.now() - 25 * H },
        { ...base, body: '@mc-boto 일', authorId: h1, authorIsAgent: false, chainBound: true, mentionDepth: 1, chainStartedAtMs: Date.now() - H },
        { ...base, body: '@mc-squad 해 줘', authorId: h2, authorIsAgent: false },
        { ...base, body: '@mc-crowd 해 줘', authorId: h2, authorIsAgent: false },
        { ...base, body: '@mc-locked 가', authorId: h2, authorIsAgent: false },
        { ...base, body: '@mc-squad @mc-botc 함께', authorId: h1, authorIsAgent: false },
        { ...base, body: '앞말 @mc-boto 중간 @mc-squad', authorId: botc, authorIsAgent: true },
        { ...base, body: '@channel 공지 @mc-crew', authorId: h1, authorIsAgent: false },
        { ...base, body: '@channel 공지', authorId: botc, authorIsAgent: true },
        { ...base, body: '공지 @channel', authorId: botc, authorIsAgent: true },
        { ...base, body: `<@${boto}> 토큰으로 부름 @mc-botoff`, authorId: h2, authorIsAgent: false },
        { ...base, body: '`@mc-botc` 코드 > 와 @없는사람', authorId: h1, authorIsAgent: false },
      ];
      const sort = (v: Iterable<string>) => [...v].sort();
      const want: unknown[] = [];
      const prev = process.env.HARKROOM_PRINCIPAL_INVOKE;
      for (const c of cases) {
        process.env.HARKROOM_PRINCIPAL_INVOKE = c.principalInvokeEnabled ? '' : 'off';
        const r = await resolveMentionCalls(client, {
          body: c.body, channelId: c.channelId, authorId: c.authorId, authorIsAgent: c.authorIsAgent, mentionDepth: c.mentionDepth,
          chainBound: c.chainBound, chainStartedAt: c.chainStartedAtMs == null ? null : new Date(c.chainStartedAtMs),
          replyGrantThreadId: c.replyGrantThreadId, principal: c.principalId ? { id: c.principalId, causeReasons: [] } : null,
        });
        want.push({
          normalizedBody: r.normalizedBody, accountHandles: sort(r.accountHandles), calledIds: r.calledIds,
          cappedIds: sort(r.cappedIds), deniedIds: sort(r.deniedIds), teamPlans: r.teamPlans,
          targetCall: r.targetCall.map((t) => `${t.kind}:${t.id}`), channelCalled: r.channelCalled, callMeta: r.callMeta,
        });
      }
      if (prev === undefined) delete process.env.HARKROOM_PRINCIPAL_INVOKE; else process.env.HARKROOM_PRINCIPAL_INVOKE = prev;
      // 픽스처가 갈래를 실제로 가르는지 — 막힘·상한·principal(연 것·그림자·하루 상한)·팀장·팀 막힘이 다 나와야 한다.
      const metas = want.map((w) => (w as { callMeta: Record<string, unknown> }).callMeta);
      for (const k of ['mentionDenied', 'mentionChainCapped', 'invokedAsPrincipal', 'mentionPrincipalShadow', 'mentionDeniedPrincipal', 'mentionRefs', 'mentionChainReason']) {
        expect(metas.some((m) => k in m), `사례가 ${k} 를 만든다`).toBe(true);
      }
      expect(metas.some((m) => m.mentionDeniedPrincipal === 'capped'), '하루 상한').toBe(true);
      const file = joinPath(tmpdir(), `mention-cases-${process.pid}.json`);
      writeCases(file, JSON.stringify(cases));
      const r = await cargo(['test', '--test', 'mention_calls', '--', '--nocapture'], {
        HARKROOM_TEST_DATABASE_URL: db.uri, HARKROOM_MENTION_CASES: file,
      });
      expect(r.code, r.out).toBe(0);
      const line = r.out.split('\n').find((l) => l.startsWith('MENTION_CALLS_JSON '));
      expect(line, r.out).toBeDefined();
      const got = JSON.parse(line!.slice('MENTION_CALLS_JSON '.length)) as unknown[];
      for (let i = 0; i < cases.length; i++) expect(got[i], `사례 ${i}: ${cases[i]!.body}`).toEqual(want[i]);
    } finally {
      client.release();
      await db.stop();
    }
  }, 600_000);
});

// S5.3 C3a-3b-3 — 호출함 쓰기(`core/mention_fanout.rs`)가 TS `fanOutCalls` 와 같은 줄을 남기는가. 사례마다 트랜잭션 안에서 글 행을 넣고
// 판정→팬아웃을 돌린 뒤 inbox(받는 사람·사유·팀)·push_job·숨김 해제를 읽고 롤백한다. 같은 사례를 Rust 시험이 돌려 찍은 답과 맞춘다.
describe.skipIf(!ON)('호출함 쓰기 — TS·Rust 같은 줄', () => {
  it('계정·@channel·집합·팀(팀장/팀원)·차단·숨김 해제·푸시·중복 부름 · 권한 없으면 오류', async () => {
    const db = await startTestDb();
    const client = await db.pool.connect();
    try {
      const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
      const acct = async (handle: string, kind: 'human' | 'agent', admin = false) => (await q(
        `insert into account(handle, display_name, kind, login_id, role, is_admin)
         values ($1, $1, $2, case when $2 = 'human' then $1 end, $3, $4) returning id`,
        [handle, kind, admin ? 'admin' : 'member', admin])).rows[0].id as string;
      const h1 = await acct('fo-h1', 'human', true);
      const h2 = await acct('fo-h2', 'human');
      const h3 = await acct('fo-h3', 'human');
      const h4 = await acct('fo-h4', 'human');
      const h5 = await acct('fo-h5', 'human');
      const agent = async (handle: string, scope: string) => {
        const id = await acct(handle, 'agent');
        await q(`insert into agent_config(account_id, owner_account_id, invoke_scope) values ($1, $2, $3)`, [id, h1, scope]);
        return id;
      };
      const botc = await agent('fo-botc', 'community');
      const boto = await agent('fo-boto', 'owner');
      const ch = (await createChannel(db.pool, { name: 'fo-room' })).id;
      const team = async (name: string, lead: string | null, members: string[]) => {
        const id = (await q(`insert into agent_team(name, created_by, invoke_scope, owner_account_id) values ($1, $2, 'community', $2) returning id`,
          [name, h1])).rows[0].id as string;
        for (const m of members) await q(`insert into agent_team_member(team_id, agent_account_id) values ($1, $2)`, [id, m]);
        if (lead) await q(`update agent_team set lead_account_id = $2 where id = $1`, [id, lead]);
        return id;
      };
      await team('fo-squad', botc, [botc, boto]);
      await team('fo-crowd', null, [botc, boto]);
      const g = (await q(`insert into handle_group(handle, display_name) values ('fo-crew', 'Crew') returning id`)).rows[0].id as string;
      for (const m of [h1, h2, h3, h4, h5]) await q(`insert into handle_group_member(group_id, account_id) values ($1, $2)`, [g, m]);
      // h3 는 이 채널을 숨겼다(부름이면 되살아난다). h4 는 폰이 있다(사람이면 push_job). h5 는 botc 를 막았다(botc 글은 안 받는다).
      await q(`insert into channel_pref (account_id, channel_id, hidden_at) values ($1, $2, now())`, [h3, ch]);
      await q(`insert into session(token_hash, account_id, expires_at) values ('fo-sess', $1, now() + interval '1 day')`, [h4]);
      await q(`insert into push_device (account_id, session_token_hash, platform, apns_env, token, prefs)
               values ($1, 'fo-sess', 'ios', 'sandbox', $2, '{}'::jsonb)`, [h4, 'a'.repeat(64)]);
      await q(`insert into account_block (blocker_id, blocked_id) values ($1, $2)`, [h5, botc]);
      const base = { channelId: ch, principalId: null as string | null, threadRootId: null as string | null };
      const cases = [
        { ...base, body: '@fo-h2 @fo-h3 @fo-h4 @fo-h5 @fo-boto 봐', authorId: botc, authorIsAgent: true },
        { ...base, body: '@channel 공지', authorId: h1, authorIsAgent: false },
        { ...base, body: '@fo-crew 모여', authorId: botc, authorIsAgent: true },
        { ...base, body: '@fo-squad @fo-botc 함께', authorId: h1, authorIsAgent: false },
        { ...base, body: '@fo-crowd 해 줘', authorId: h2, authorIsAgent: false },
        { ...base, body: '@fo-squad 해 줘', authorId: h4, authorIsAgent: false },
        { ...base, body: '@fo-h2 @fo-h2 두 번 @fo-h1', authorId: h1, authorIsAgent: false },
        { ...base, body: '@fo-boto 일', authorId: botc, authorIsAgent: true, principalId: h1 },
      ];
      const want: unknown[] = [];
      for (const c of cases) {
        await q('begin');
        try {
          const mid = (await q(`insert into message (channel_id, author_id, body, kind, thread_root_id) values ($1, $2, $3, 'user', $4) returning id`,
            [c.channelId, c.authorId, c.body, c.threadRootId])).rows[0].id as string;
          const r = await resolveMentionCalls(client, {
            body: c.body, channelId: c.channelId, authorId: c.authorId, authorIsAgent: c.authorIsAgent, mentionDepth: 0,
            chainBound: false, chainStartedAt: null, replyGrantThreadId: null,
            principal: c.principalId ? { id: c.principalId, causeReasons: [] } : null,
          });
          await fanOutCalls(client, { channelId: c.channelId, authorId: c.authorId, messageId: mid }, r, new Set());
          const inbox = (await q(`select account_id, reason, team_id from inbox where message_id = $1 order by id`, [mid])).rows
            .map((x) => `${x.account_id}:${x.reason}:${x.team_id ?? '-'}`);
          const push = (await q(`select account_id, reason from push_job where message_id = $1 order by inbox_id`, [mid])).rows
            .map((x) => `${x.account_id}:${x.reason}`);
          const revealed = (await q(`select account_id::text from channel_pref where channel_id = $1 and hidden_at is null order by account_id`, [c.channelId])).rows
            .map((x) => x.account_id as string);
          want.push({ inbox, push, revealed });
        } finally {
          await q('rollback');
        }
      }
      // 픽스처가 갈래를 실제로 가르는지 — 팀장 항목(팀 실림)·푸시·숨김 해제·차단·중복 제거가 다 나와야 한다.
      const rows = want as { inbox: string[]; push: string[]; revealed: string[] }[];
      expect(rows.some((w) => w.inbox.some((l) => /:team_mention:[0-9a-f-]{36}$/.test(l))), '팀장 항목에 팀').toBe(true);
      expect(rows.some((w) => w.push.length > 0), '푸시 줄').toBe(true);
      expect(rows.some((w) => w.revealed.includes(h3)), '숨김 해제').toBe(true);
      expect(rows[0]!.inbox.some((l) => l.startsWith(h5)), '막은 사람은 안 받는다').toBe(false);
      expect(rows[0]!.inbox.some((l) => l.startsWith(boto)), 'owner 게이트에 막힘').toBe(false);
      expect(rows[6]!.inbox.filter((l) => l.startsWith(h2)).length, '두 번 불러도 한 줄').toBe(1);
      const file = joinPath(tmpdir(), `fanout-cases-${process.pid}.json`);
      writeCases(file, JSON.stringify(cases));
      const r = await cargo(['test', '--test', 'mention_fanout', '--', '--nocapture', '--test-threads=1'], {
        HARKROOM_TEST_DATABASE_URL: db.uri, HARKROOM_FANOUT_CASES: file,
      });
      expect(r.code, r.out).toBe(0);
      expect(r.out, '권한 없으면 오류를 돌려준다').toContain('FANOUT_ERR_OK');
      // 두 시험이 한 출력에 섞이므로 줄 머리가 아니라 표지 뒤를 읽는다.
      const line = r.out.split('\n').find((l) => l.includes('FANOUT_JSON '));
      expect(line, r.out).toBeDefined();
      const got = JSON.parse(line!.slice(line!.indexOf('FANOUT_JSON ') + 'FANOUT_JSON '.length)) as unknown[];
      for (let i = 0; i < cases.length; i++) expect(got[i], `사례 ${i}: ${cases[i]!.body}`).toEqual(want[i]);
    } finally {
      client.release();
      await db.stop();
    }
  }, 600_000);
});

/** 비어 있는 TCP 포트 하나. 닫은 뒤 앞단이 잡기까지 틈이 있지만 CI 러너 하나에서 겹칠 일은 드물다. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** 앞단 바이너리를 띄우고 `front: listening` 줄과 `front: rust routes [...]` 줄을 기다린다. */
async function startFront(bin: string, env: Record<string, string>): Promise<{ child: ChildProcess; log: () => string }> {
  const child = spawn(bin, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (b: Buffer) => { log += String(b); });
  child.stderr!.on('data', (b: Buffer) => { log += String(b); });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`front did not start:\n${log}`)), 30_000);
    const tick = setInterval(() => {
      if (log.includes('front: listening')) { clearTimeout(t); clearInterval(tick); resolve(); }
    }, 50);
    child.on('exit', (code) => { clearTimeout(t); clearInterval(tick); reject(new Error(`front exited ${code}:\n${log}`)); });
  });
  return { child, log: () => log };
}

describe.skipIf(!ON)('TS·Rust 대조 시험 — 같은 DB 의 두 서버', () => {
  it('tests/contrast.rs', async () => {
    const built = await cargo(['build', '--bin', 'harkroom-server-rs'], {});
    expect(built.code, built.out).toBe(0);
    const bin = `${dirname(MANIFEST)}/target/debug/harkroom-server-rs`;

    const db = await startTestDb();
    // 감사 `ip` 대조(trust-proxy) — 두 서버가 같은 규칙으로 루프백만 프록시로 믿는다(운영은 파드 대역 CIDR 하나).
    const TRUST = ['127.0.0.1', '::1'];
    // CORS 대조 — 두 서버에 같은 허용 출처(데스크톱 앱의 출처)를 준다.
    const CORS = 'tauri://localhost';
    const app = await buildServer({ pool: db.pool, trustProxy: TRUST, corsOrigins: [CORS] });
    let front: ChildProcess | undefined;
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const tsUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

      // 픽스처 — 옮긴 라우트(GET /accounts·/dms·/mcp-servers·/audit)가 빈 목록이 아닌 값을 내도록.
      const admin = await bootstrapAdmin(app);
      const member = await createMember(app, admin.token, 'mem');
      const agent = await createAgent(app, admin.token, 'bot');
      const auth = { authorization: `Bearer ${admin.token}` };
      const ok = async (p: Promise<{ statusCode: number; body: string }>) => {
        const r = await p;
        expect(r.statusCode, r.body).toBeLessThan(300);
        return JSON.parse(r.body || '{}') as Record<string, unknown>;
      };
      const dm = await ok(app.inject({ method: 'POST', url: '/dms', headers: auth, payload: { accountIds: [member.accountId] } }));
      // 말이 없는 DM(lastMessageAt null) 하나.
      await ok(app.inject({ method: 'POST', url: '/dms', headers: auth, payload: { accountIds: [agent.accountId] } }));
      for (const body of ['first', 'second']) {
        // created_at 은 마이크로초까지 있다 — `lastMessageAt` 글자꼴(::text)이 그대로 나와야 한다.
        await ok(app.inject({ method: 'POST', url: `/channels/${String(dm.id)}/messages`, headers: auth, payload: { body } }));
      }
      const crew = await ok(app.inject({ method: 'POST', url: '/handle-groups', headers: auth, payload: { handle: 'crew', displayName: 'Crew' } }));
      await ok(app.inject({ method: 'POST', url: '/handle-groups', headers: auth, payload: { handle: 'empty-crew', displayName: 'Empty' } }));
      const squad = await ok(app.inject({ method: 'POST', url: '/teams', headers: auth, payload: { name: 'squad' } }));
      await ok(app.inject({ method: 'POST', url: '/teams', headers: auth, payload: { name: 'alpha' } }));

      // S5.2 P2 픽스처 — 팀(팀원·호출 허용)·집합(구성원 둘)·스킬(제안/승인/오래된 승인/비활성 + 사용)·설정.
      const crewId = String((crew.group as Record<string, unknown> | undefined)?.id ?? crew.id);
      const squadId = String((squad.team as Record<string, unknown> | undefined)?.id ?? squad.id);
      const bot2 = await createAgent(app, admin.token, 'bot2');
      const member2 = await createMember(app, admin.token, 'mem2');
      await ok(app.inject({ method: 'POST', url: `/handle-groups/${crewId}/members`, headers: auth, payload: { accountIds: [member.accountId, member2.accountId, admin.accountId] } }));
      for (const a of [agent.accountId, bot2.accountId]) {
        await ok(app.inject({ method: 'PUT', url: `/teams/${squadId}/members/${a}`, headers: auth }));
      }
      await ok(app.inject({ method: 'PUT', url: `/teams/${squadId}/invokers/${member.accountId}`, headers: auth }));
      await ok(app.inject({ method: 'PUT', url: `/teams/${squadId}/scope`, headers: auth, payload: { invokeScope: 'list' } }));
      await db.pool.query(
        `insert into workspace_skill (slug, body, proposed_by, proposed_at, approved_by, approved_at, disabled_at, flagged_at, flag_reason) values
         ('pending-one', 'p', $1, now() - interval '1 day', null, null, null, now(), 'looks odd'),
         ('fresh-one', 'f', $1, now() - interval '3 days', $2, now() - interval '2 days', null, null, null),
         ('stale-one', 's', $1, now() - interval '40 days', $2, now() - interval '35 days', null, null, null),
         ('used-old', 'u', $1, now() - interval '40 days', $2, now() - interval '30 days', null, null, null),
         ('off-one', 'o', $1, now() - interval '50 days', $2, now() - interval '45 days', now() - interval '5 days', null, null)`,
        [agent.accountId, admin.accountId],
      );
      await db.pool.query(
        `insert into workspace_skill_usage (slug, account_id, used_at) values
         ('used-old', $1, now() - interval '2 days'), ('used-old', $1, now() - interval '1 hour'), ('fresh-one', $1, now())`,
        [agent.accountId],
      );
      await ok(app.inject({ method: 'PUT', url: '/settings/agent-defaults', headers: auth, payload: { harness: 'codex', model: 'm-1', effort: 'high' } }));
      await ok(app.inject({ method: 'PUT', url: '/settings/mention-policy', headers: auth, payload: { chainLimit: 12 } }));
      await ok(app.inject({ method: 'PUT', url: '/mcp-servers/notes', headers: auth, payload: { credentialKind: 'community' } }));
      // S5.2 P2b 픽스처 — 인박스 「오늘」(open·done): 카드(사람·계정 지목·답한 것·거울·같은 작성자 더 새 것)·실패(안 풀림·풀림)·
      // 권한 요청(주인 = admin)·스레드 상태(stuck·running·waiting·done)·보고·seen 커서 한 명·비공개 채널 남의 글.
      const today = await ok(app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'today' } }));
      const todayId = String(today.id);
      await ok(app.inject({ method: 'POST', url: `/channels/${todayId}/members`, headers: auth, payload: { accountId: agent.accountId } }));
      await ok(app.inject({ method: 'POST', url: `/channels/${todayId}/members`, headers: auth, payload: { accountId: member.accountId } }));
      const say = async (body: string, o: { root?: string; ch?: string; meta?: Record<string, unknown>; author?: string } = {}) =>
        ((await postMessage(db.pool, {
          channelId: o.ch ?? todayId, authorId: o.author ?? agent.accountId, body, threadRootId: o.root ?? null, meta: o.meta ?? {},
        })) as { message: { id: string } }).message.id;
      const ask = (to: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
        kind: 'ask', ask: { prompt: '어느 쪽?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to, ...extra },
      });
      const work = await say('@admin @mem 일');
      const oldCard = await say('@admin 첫 카드', { root: work, meta: ask({ kind: 'human' }) });
      await say('@admin 둘째 카드', { root: work, meta: ask({ kind: 'human' }) });
      await say('@mem 너에게 카드', { meta: ask({ kind: 'account', accountId: member.accountId }) });
      await say('@admin 답한 카드', { meta: ask({ kind: 'human' }, { answeredWith: 'a' }) });
      await say('@admin 거울 카드', { meta: ask({ kind: 'human' }, { mirrorOf: oldCard }) });
      await say('@admin 막혔다', { meta: { kind: 'failure', failure: { retryable: true, reason: '권한' } } });
      const solved = await say('@admin 풀린 실패', { meta: { kind: 'failure', failure: { retryable: false, what: 'x' } } });
      await say('이어서 됐다', { root: solved, meta: { kind: 'report', report: { summary: '됐다' } } });
      await say('@admin @mem 보고', { meta: { kind: 'report', report: { summary: 'r1' } } });
      const stuck = await say('@admin 멈춘 일');
      const running = await say('@admin 도는 일');
      const waiting = await say('@admin @mem 기다리는 일');
      const finished = await say('@admin @mem 끝난 일');
      await db.pool.query(
        `insert into thread_status (root_id, status, emoji) values ($1, 'stuck', '🛑'), ($2, 'running', '💬'), ($3, 'waiting', '⏳'), ($4, 'done', '✅')`,
        [stuck, running, waiting, finished],
      );
      const permRoot = await say('권한 스레드');
      const requestId = (await db.pool.query<{ id: string }>(
        `insert into permission_request (agent_id, kind, target, reason, warnings, channel_id, thread_root_id, created_at, expires_at)
         values ($1, 'tool', 'Bash(kubectl get pods:*)', '확인', '{}', $2, $3, now(), now() + interval '1 day') returning id`,
        [agent.accountId, todayId, permRoot])).rows[0]!.id;
      const permCard = await say('권한 카드', { root: permRoot, meta: { ...ask({ kind: 'human' }), permissionRequest: { requestId, status: 'pending' } } });
      await db.pool.query('update permission_request set card_message_id = $2 where id = $1', [requestId, permCard]);
      // 비공개 채널(mem 은 없음)의 글 — 남은 inbox 줄이 있어도 mem 에게 새면 안 된다.
      const priv = await ok(app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'today-private', visibility: 'private' } }));
      await ok(app.inject({ method: 'POST', url: `/channels/${String(priv.id)}/members`, headers: auth, payload: { accountId: agent.accountId } }));
      const secret = await say('@admin 비밀 카드', { ch: String(priv.id), meta: ask({ kind: 'human' }) });
      await db.pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'mention')`, [member.accountId, secret]);
      // 나이·isNew 가 갈리도록 몇 글을 과거로 — 그리고 admin 만 seen 커서를 그 사이에 둔다.
      await db.pool.query(`update message set created_at = now() - interval '3 days' where id = any($1::uuid[])`, [[oldCard, stuck]]);
      await ok(app.inject({ method: 'PUT', url: '/inbox/today/seen', headers: auth, payload: { upTo: new Date(Date.now() - 60_000).toISOString() } }));

      const audit = (await db.pool.query<{ n: string }>('select count(*)::text as n from audit_log')).rows[0]!.n;
      expect(Number(audit), 'audit_log 가 비면 /audit 대조가 빈 목록끼리 비교한다').toBeGreaterThan(3);

      // S5.2 P3 — 쓰기 역할. **`write.rs::REQUIRED_PRIVILEGES` 만** 준다(homelab GRANT 와 같은 표). 넓은 권한으로 돌리면
      // 앞단이 목록에 없는 표를 쓰기 시작해도 이 시험이 못 잡는다.
      const rw = `front_rw_${Math.random().toString(36).slice(2, 10)}`;
      // connection limit = 쓰기 풀 2 + 루프 문지기 풀 7(루프 수) + 루프 sweep 풀 3 (S5.3 C5c-4 — 운영 역할 한도도 이만큼 받아야 한다).
      await db.pool.query(`create role ${rw} login password '${rw}' nosuperuser nocreatedb nocreaterole nobypassrls connection limit 12`);
      for (const q of [
        `grant pg_read_all_data to ${rw}`,
        `grant insert on event_outbox to ${rw}`,
        `grant usage on sequence event_outbox_id_seq to ${rw}`,
        `grant insert on audit_log to ${rw}`,
        `grant insert, update on inbox_view_cursor to ${rw}`,
        // P4d — 인증 미들웨어의 기록.
        `grant update on session to ${rw}`,
        `grant update on pat to ${rw}`,
        // P4a — 설정·스킬.
        `grant update on agent_defaults to ${rw}`,
        `grant insert, update on mention_policy to ${rw}`,
        `grant update on workspace_skill to ${rw}`,
        `grant insert on workspace_skill_usage to ${rw}`,
        `grant usage on sequence workspace_skill_usage_id_seq to ${rw}`,
        `grant insert on builtin_skill_usage to ${rw}`,
        `grant usage on sequence builtin_skill_usage_id_seq to ${rw}`,
        // P4b — 팀·집합.
        `grant insert, update, delete on agent_team to ${rw}`,
        `grant insert, delete on agent_team_member to ${rw}`,
        `grant insert, delete on agent_team_invoker to ${rw}`,
        `grant insert, update, delete on handle_group to ${rw}`,
        `grant insert, delete on handle_group_member to ${rw}`,
        // P4c — 신고 해결·차단.
        `grant update on message_report to ${rw}`,
        `grant insert, delete on account_block to ${rw}`,
        // P4c-2 — 작업 항목 지우기·스레드 임대·푸시 기기.
        `grant delete on work_item to ${rw}`,
        `grant insert, update, delete on agent_thread_claim to ${rw}`,
        `grant insert, update, delete on push_device to ${rw}`,
        // S5.3 C2a — 오퍼레이터 코어(`OPERATOR_PRIVILEGES`). 없으면 앞단은 `/operator`·`/operators*` 를 TS 에 남긴다.
        ...OPERATOR_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C3a-1 — 리액션 쓰기(`msg_react.rs::MESSAGE_REACTION_PRIVILEGES`). 없으면 앞단은 리액션 줄을 TS 에 남긴다.
        `grant insert, update, delete on message_reaction to ${rw}`,
        // 칸 권한만 — 앞단이 `has_column_privilege` 로 알아보고 리액션 줄을 붙여야 한다(아래 「reaction core off」 없음).
        `grant update (meta) on message to ${rw}`,
        // S5.3 C3a-2 — 지우기·채널에도 보이기(`msg_delete.rs::MESSAGE_DELETE_PRIVILEGES`). 칸 권한 둘. 없으면 「message delete core off」.
        `grant update (deleted_at, also_in_channel) on message to ${rw}`,
        // S5.3 C3a-3c — 글 고치기(`msg_edit.rs::MESSAGE_EDIT_PRIVILEGES`). 없으면 「message edit core off」(아래에서 그 길도 본다).
        `grant update (body, meta, edited_at) on message to ${rw}`,
        `grant insert on inbox to ${rw}`,
        `grant update (via_edit) on inbox to ${rw}`,
        // C4b ④-a — MCP inbox.read(`writes.rs::INBOX_READ_PRIVILEGES`).
        `grant update (read_at) on inbox to ${rw}`,
        // C4b ④-a(2/2) — MCP bg.claim(`bg_claim.rs::BG_CLAIM_PRIVILEGES`).
        `grant select on bg_job to ${rw}`,
        `grant update (status, claimed_at) on bg_job to ${rw}`,
        `grant insert on push_job to ${rw}`,
        `grant update (hidden_at) on channel_pref to ${rw}`,
        // S5.3 C1c-1 — 글 올리기 뼈대(`msg_post.rs::MESSAGE_POST_PRIVILEGES`). 없으면 「message post core off」(아래에서 그 길도 본다).
        `grant insert on message to ${rw}`,
        `grant insert on idempotency_key to ${rw}`,
        `grant update (message_id, attached_at) on attachment to ${rw}`,
        // S5.3 C1c-2a — 사람 새 머리의 부름과 위임(inbox·push_job·channel_pref 는 위 글 고치기 줄에 이미 있다).
        `grant insert on mandate to ${rw}`,
        `grant update (last_activity_at) on mandate to ${rw}`,
        `grant update (mandate_id) on message to ${rw}`,
        // S5.3 C1c-3b — 사람 답글의 깨움 선점(fired_at·message.meta 는 아래 깨움 루프 줄에 이미 있다).
        `grant update (canceled_at, canceled_by_message_id) on agent_wake to ${rw}`,
        // S5.3 C5b — 예약 깨움 루프(`loops/wake.rs::WAKE_PRIVILEGES`). 없으면 「loop wake off」 — 루프는 TS 에 남는다.
        ...WAKE_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C5c — 보존 정리 루프(`loops/retention.rs::RETENTION_PRIVILEGES`).
        ...RETENTION_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C5c-2a — 위임 idle 끝 루프(`loops/mandate_idle.rs::MANDATE_IDLE_PRIVILEGES`).
        ...MANDATE_IDLE_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C5c-2b — 권한 요청 만료 루프(`loops/permission_expire.rs::PERMISSION_EXPIRE_PRIVILEGES`).
        ...PERMISSION_EXPIRE_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C5c-3a — 백그라운드 회차 닫기(`loops/bg.rs::BG_PRIVILEGES`).
        ...BG_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C5c-3b-2 — 백그라운드 회차 생산(`loops/bg_produce.rs::BG_PRODUCE_PRIVILEGES`). 없으면 「loop bg.produce off」.
        ...BG_PRODUCE_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C5c-4 — outbox 정리(`loops/outbox_prune.rs::OUTBOX_PRUNE_PRIVILEGES`). 없으면 「loop outbox.prune off」.
        ...OUTBOX_PRUNE_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C6a-1 — 인박스 읽음 표시(`core/inbox_read.rs::INBOX_READ_PRIVILEGES`). 칸 권한 하나. 없으면 「inbox read core off」.
        `grant update (read_at) on inbox to ${rw}`,
      ]) await db.pool.query(q);
      const writeUrl = new URL(db.uri);
      writeUrl.username = rw;
      writeUrl.password = rw;
      // 앞단이 outbox 에 넣은 이벤트가 TS 버스(LISTEN)로 건너오는지.
      const busEvents: WorkspaceEvent[] = [];
      const bus = await startEventBus({
        pool: db.pool,
        connect: async () => { const c = new pg.Client({ connectionString: db.uri }); await c.connect(); return c; },
        emit: (e) => { busEvents.push(e); },
        log: () => {},
      });

      const port = await freePort();
      const f = await startFront(bin, {
        UPSTREAM_URL: tsUrl, DATABASE_URL: db.uri, PORT: String(port), HARKROOM_FRONT_TS_ROUTES: '', DATABASE_WRITE_URL: writeUrl.toString(),
        TRUST_PROXY: TRUST.join(','), CORS_ORIGINS: CORS,
        // S5.3 C0 — 코어 /ws·/ws-ticket 을 켠다. 주기는 시험이 기다릴 수 있게 줄인다(기본값은 TS 와 같다).
        HARKROOM_CORE: 'rust', HARKROOM_WS_APP_HEARTBEAT_MS: '300', HARKROOM_WS_REVALIDATE_MS: '500',
      });
      expect(f.log()).toContain('front: core rust');
      expect(f.log()).toContain('/operator, /operators*');
      expect(f.log()).toContain('front: trust proxy 2 cidr(s)');
      front = f.child;
      // 앞단이 옮긴 줄을 **직접** 답하는지 — 모두 TS 로 넘기면 대조는 TS 끼리 비교해 늘 통과한다.
      for (const key of [
        'GET /accounts', 'GET /dms', 'GET /mcp-servers', 'GET /audit',
        'GET /teams', 'GET /teams/{id}', 'GET /handle-groups', 'GET /handle-groups/{id}',
        'GET /skills', 'GET /skills/{slug}', 'GET /settings/agent-defaults', 'GET /settings/mention-policy',
        'GET /inbox/today/open', 'GET /inbox/today/done', 'PUT /inbox/today/seen',
        'PUT /settings/agent-defaults', 'PUT /settings/mention-policy', 'POST /skills/usage',
        'POST /skills/{slug}/approve', 'DELETE /skills/{slug}',
        'POST /teams', 'PATCH /teams/{id}', 'DELETE /teams/{id}', 'PUT /teams/{id}/scope', 'PUT /teams/{id}/lead',
        'PUT /teams/{id}/invokers/{accountId}', 'DELETE /teams/{id}/invokers/{accountId}',
        'PUT /teams/{id}/members/{accountId}', 'DELETE /teams/{id}/members/{accountId}',
        'POST /handle-groups', 'PATCH /handle-groups/{id}', 'DELETE /handle-groups/{id}',
        'POST /handle-groups/{id}/members', 'DELETE /handle-groups/{id}/members',
        'GET /admin/reports', 'GET /accounts/me/blocks',
        'POST /admin/reports/{id}/resolve', 'PUT /accounts/me/blocks/{id}', 'DELETE /accounts/me/blocks/{id}',
        'GET /work-items', 'DELETE /work-items/{id}', 'POST /agent/thread-claims', 'POST /agent/thread-claims/release',
        'PUT /push/devices', 'DELETE /push/devices/current',
      ]) {
        expect(f.log(), key).toContain(`"${key}"`);
      }
      expect(f.log()).toContain('front: write pool on');
      expect(f.log()).not.toContain('missing privileges');
      expect(f.log()).toContain('front: loop wake on');
      expect(f.log()).toContain('front: loop retention on (delete=false');
      expect(f.log()).toContain('front: loop mandate.idle on');
      expect(f.log()).toContain('front: loop bg.produce on (enabled=false');
      expect(f.log()).toContain('front: loop permission.expire on');
      expect(f.log()).toContain('front: loop bg on (enabled=false');
      expect(f.log()).toContain('front: loop outbox.prune on');

      const r = await cargo(['test', '--test', 'contrast', '--', '--nocapture'], {
        HARKROOM_CONTRAST_TS_URL: tsUrl,
        HARKROOM_CONTRAST_RS_URL: `http://127.0.0.1:${port}`,
        HARKROOM_CONTRAST_TOKEN: admin.token,
        HARKROOM_CONTRAST_MEMBER_TOKEN: member.token,
        HARKROOM_CONTRAST_TEAM_ID: squadId,
        HARKROOM_CONTRAST_GROUP_ID: crewId,
      });
      expect(r.code, `${r.out}\n--- front log ---\n${f.log()}`).toBe(0);
      expect(r.out, r.out).not.toContain('skip: HARKROOM_CONTRAST');
      expect(r.out).toMatch(/contrast: [1-9]\d* case\(s\) compared/);

      // S5.3 C1b-1a — `GET /messages/{id}`(코어 `msg_read.rs`). 성공은 본문 전체가 같아야 한다(겉 시각은 toISOString 꼴,
      // 리액션·첨부·상태 리액션 안의 시각은 PG 꼴 그대로). 거절은 상태·코드까지(문구는 zod 와 다르다).
      expect(f.log()).toContain('"GET /messages/{id}"');
      await db.pool.query(
        `insert into message_reaction (message_id, account_id, emoji) values ($1, $2, '👀'), ($1, $3, '👀'), ($1, $2, '✅')`,
        [work, admin.accountId, member.accountId],
      );
      await db.pool.query(`update message set edited_at = now() - interval '1 hour' where id = $1`, [oldCard]);
      const gone = await say('지울 글');
      await db.pool.query(`update message set deleted_at = now() where id = $1`, [gone]);
      const getMsg = async (base: string, id: string, token?: string) => {
        const res = await fetch(`${base}/messages/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        const json = JSON.parse(await res.text()) as { error?: { code: string } };
        return { status: res.status, code: json.error?.code, body: json.error ? undefined : json };
      };
      for (const [name, id, token] of [
        ['리액션 붙은 머리', work, admin.token],
        ['고친 답글', oldCard, member.token],
        ['상태 리액션', waiting, member.token],
        ['비공개 채널 — 멤버 아님 → 403', secret, member.token],
        ['비공개 채널 — admin 도 멤버 아님 → 403', secret, admin.token],
        ['비공개 채널 — 멤버', secret, agent.pat],
        ['지운 글 → 404', gone, admin.token],
        ['없는 id → 404', '0f8fad5b-d9cb-469f-a165-70867728950e', admin.token],
        ['uuid 아님 → 400', 'not-a-uuid', admin.token],
        ['익명 → 401', work, undefined],
        ['익명·uuid 아님 → 401(인증이 먼저)', 'not-a-uuid', undefined],
      ] as const) {
        const [a, b] = [await getMsg(tsUrl, id, token), await getMsg(`http://127.0.0.1:${port}`, id, token)];
        expect(b, name).toEqual(a);
      }
      const head = (await getMsg(`http://127.0.0.1:${port}`, work, admin.token)).body as Record<string, unknown>;
      expect((head.reactions as unknown[]).length, '리액션이 빈 목록끼리 비교하면 안 된다').toBe(2);

      // S5.3 C1e-1 — 채널 읽기 GET 9줄(코어 `channels.rs`). 성공은 본문 전체(timestamptz 칸은 toISOString 꼴), 거절은 상태·코드까지.
      for (const k of ['GET /channels', 'GET /reads', 'GET /channels/{id}/read', 'GET /channels/{id}/members', 'GET /channels/prefs',
        'GET /channel-sections', 'GET /channels/{id}/auto-mentions', 'GET /channels/{id}/doc', 'GET /channels/{id}/scheduled',
        'GET /channels/{id}/pins', 'GET /channels/{id}/delete-info']) {
        expect(f.log()).toContain(`"${k}"`);
      }
      await ok(app.inject({ method: 'PATCH', url: `/channels/${todayId}/pref`, headers: auth, payload: { starred: true, notifyLevel: 'mentions' } }));
      await ok(app.inject({ method: 'PATCH', url: `/channels/${String(priv.id)}/pref`, headers: auth, payload: { hidden: true } }));
      await ok(app.inject({ method: 'POST', url: '/channel-sections', headers: auth, payload: { name: 'Work' } }));
      await ok(app.inject({ method: 'PUT', url: `/channels/${todayId}/auto-mentions/${agent.accountId}`, headers: auth, payload: { mode: 'always' } }));
      await db.pool.query(
        `insert into channel_doc (channel_id, body, updated_by, updated_at) values ($1, '문서 본문', $2, now() - interval '2 hours')`,
        [todayId, admin.accountId],
      );
      await db.pool.query(
        `insert into scheduled_message (channel_id, author_id, body, send_at) values ($1, $2, '나중에', now() + interval '1 day'),
           ($1, $3, '남의 예약', now() + interval '2 days')`,
        [todayId, admin.accountId, member.accountId],
      );
      await db.pool.query(`update channel set archived_at = now() - interval '1 day' where id = $1`, [String(priv.id)]);
      // 핀: 리액션이 붙은 글·스레드 답글 하나씩, 그리고 지운 글의 핀(조인에서 빠져야 한다).
      const gonePin = await say('지울 핀');
      await db.pool.query(
        `insert into message_pin (message_id, channel_id, pinned_by, pinned_at) values
           ($1, $4, $5, now() - interval '1 hour'), ($2, $4, $5, now()), ($3, $4, $5, now() - interval '2 hours')`,
        [work, oldCard, gonePin, todayId, admin.accountId],
      );
      await db.pool.query(`update message set deleted_at = now() where id = $1`, [gonePin]);
      const getJson = async (base: string, path: string, token?: string) => {
        const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        const json = JSON.parse(await res.text()) as { error?: { code: string } };
        return { status: res.status, code: json.error?.code, body: json.error ? undefined : json };
      };
      const privId = String(priv.id);
      const missingCh = '0f8fad5b-d9cb-469f-a165-70867728950e';
      for (const [path, token] of [
        ['/channels', admin.token], ['/channels', member.token], ['/channels', agent.pat], ['/channels', undefined],
        ['/reads', admin.token], ['/reads', member.token],
        [`/channels/${todayId}/read`, member.token], [`/channels/${privId}/read`, member.token], [`/channels/${missingCh}/read`, admin.token],
        ['/channels/not-a-uuid/read', admin.token],
        [`/channels/${todayId}/members`, member.token], [`/channels/${privId}/members`, member.token], [`/channels/${privId}/members`, admin.token],
        [`/channels/${missingCh}/members`, admin.token], [`/channels/${String(dm.id)}/members`, member.token],
        ['/channels/prefs', admin.token], ['/channels/prefs', member.token],
        ['/channel-sections', admin.token], ['/channel-sections', member.token],
        [`/channels/${todayId}/auto-mentions`, member.token], [`/channels/${privId}/auto-mentions`, member.token],
        [`/channels/${todayId}/doc`, member.token], [`/channels/${privId}/doc`, admin.token], [`/channels/${privId}/doc`, member.token],
        [`/channels/${missingCh}/doc`, admin.token],
        [`/channels/${todayId}/scheduled`, admin.token], [`/channels/${todayId}/scheduled`, member.token], [`/channels/${privId}/scheduled`, member.token],
        [`/channels/${todayId}/pins`, member.token], [`/channels/${privId}/pins`, member.token], [`/channels/${privId}/pins`, admin.token],
        ['/channels/not-a-uuid/pins', admin.token],
        [`/channels/${privId}/delete-info`, admin.token], [`/channels/${privId}/delete-info`, member.token],
        [`/channels/${privId}/delete-info`, undefined], [`/channels/${todayId}/delete-info`, admin.token],
        [`/channels/${String(dm.id)}/delete-info`, admin.token], [`/channels/${missingCh}/delete-info`, admin.token],
      ] as const) {
        const [a, b] = [await getJson(tsUrl, path, token), await getJson(`http://127.0.0.1:${port}`, path, token)];
        expect(b, `${path} ${token === admin.token ? 'admin' : token === member.token ? 'mem' : token ? 'agent' : 'anon'}`).toEqual(a);
      }
      // S5.3 C4a-3 — MCP 읽기 도구를 Rust 가 답한다. 같은 JSON-RPC 요청을 TS `/mcp` 와 앞단에 보내 **SSE 글자 그대로**(키 순서·
      // 이스케이프까지) 비교한다. Rust 가 답한 것은 `x-harkroom-core: mcp` 로 가른다 — 인자 모양이 zod 와 다르면 Rust 는 TS 로 넘긴다.
      const mcpCall = async (base: string, token: string, name: string, args: unknown, id: unknown = 1, extra: Record<string, string> = {}) => {
        const params = args === undefined ? { name } : { name, arguments: args };
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }),
        });
        return { status: res.status, type: res.headers.get('content-type'), text: await res.text(), core: res.headers.get('x-harkroom-core') };
      };
      for (const [name, tool, args, answeredByRust, id] of [
        ['workspace.guide', 'workspace.guide', {}, true, 20],
        ['workspace.guide turn', 'workspace.guide', { mode: 'turn' }, true, 21],
        ['workspace.guide turn avcs=false', 'workspace.guide', { mode: 'turn', avcs: false }, true, 22],
        ['workspace.guide avcs=0 은 전문', 'workspace.guide', { avcs: 0 }, true, 23],
        ['workspace.guide 인자 없음 → TS(검증 오류)', 'workspace.guide', undefined, false, 24],
        ['workspace.guide 모르는 mode → TS', 'workspace.guide', { mode: 'x' }, false, 25],
        ['workspace.guide mode null → TS', 'workspace.guide', { mode: null }, false, 26],
        ['account.me', 'account.me', {}, true, 1],
        ['account.me 인자 없음', 'account.me', undefined, true, 'str-id'],
        ['account.me 배열 인자 → TS', 'account.me', [], false, 2],
        ['channel.list', 'channel.list', {}, true, 3],
        ['account.list', 'account.list', {}, true, 12],
        ['account.list 문자열 인자 → TS', 'account.list', 'x', false, 13],
        ['channel.doc 문서 있음', 'channel.doc', { channelId: todayId }, true, 4],
        // 볼 수 있는데 문서가 없는 채널 — today-private 은 에이전트가 멤버이고 문서를 넣지 않았다(멤버 아닌 DM 은 아래 forbidden 줄이 본다).
        ['channel.doc 문서 없음(볼 수 있는 비공개 채널)', 'channel.doc', { channelId: privId }, true, 5],
        ['channel.doc 없는 채널 → 빈 문서', 'channel.doc', { channelId: missingCh }, true, 6],
        ['channel.doc 멤버 아닌 DM → forbidden', 'channel.doc', { channelId: String(dm.id) }, true, 7],
        ['channel.doc 모르는 키는 버린다', 'channel.doc', { channelId: todayId, extra: 1 }, true, 8],
        ['channel.doc uuid 아님 → TS', 'channel.doc', { channelId: 'nope' }, false, 9],
        ['channel.doc 문자열 인자 → TS', 'channel.doc', todayId, false, 10],
        ['channel.doc 인자 없음 → TS', 'channel.doc', undefined, false, 11],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, agent.pat, tool, args, id), await mcpCall(`http://127.0.0.1:${port}`, agent.pat, tool, args, id)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
        expect(a.core, 'TS 는 이 표지를 달지 않는다').toBeNull();
      }
      // message.read — 본문 멘션 되돌리기(계정·집합·팀·모르는 id)와 시스템 줄(relatedAccountId), 스레드·since·limit 갈래.
      const readCh = String((await ok(app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'mcp-read' } }))).id);
      await ok(app.inject({ method: 'POST', url: `/channels/${readCh}/members`, headers: auth, payload: { accountId: agent.accountId } }));
      const readRoot = await say('@mem @crew @squad 부름 "따옴표" \\ 끝', { ch: readCh });
      // 모르는 계정 토큰 — 게시가 받는 길이 없어(받는 사람 행이 깨진다) 본문을 직접 덧붙인다.
      await db.pool.query(`update message set body = body || ' <@00000000-0000-4000-8000-000000000000>' where id = $1`, [readRoot]);
      await say('답글 @bot2', { ch: readCh, root: readRoot });
      const sys = await say('시스템 줄', { ch: readCh });
      await db.pool.query(`update message set kind = 'system' where id = $1`, [sys]);
      const readSeq = (await db.pool.query<{ seq: string }>(`select seq::text from message where id = $1`, [readRoot])).rows[0]!.seq;
      for (const [name, args, answeredByRust] of [
        ['message.read', { channelId: readCh }, true],
        ['message.read limit', { channelId: readCh, limit: 1 }, true],
        ['message.read since', { channelId: readCh, since: Number(readSeq) }, true],
        ['message.read since 0', { channelId: readCh, since: 0 }, true],
        ['message.read 스레드', { channelId: readCh, threadRootId: readRoot }, true],
        ['message.read 많은 글 채널', { channelId: todayId, limit: 500 }, true],
        ['message.read 멤버 아닌 DM → forbidden', { channelId: String(dm.id) }, true],
        ['message.read 없는 채널', { channelId: missingCh }, true],
        ['message.read limit 0 → TS', { channelId: readCh, limit: 0 }, false],
        ['message.read limit 501 → TS', { channelId: readCh, limit: 501 }, false],
        ['message.read limit 소수 → TS', { channelId: readCh, limit: 1.5 }, false],
        ['message.read since 음수 → TS', { channelId: readCh, since: -1 }, false],
        ['message.read 스레드 uuid 아님 → TS', { channelId: readCh, threadRootId: 'x' }, false],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, agent.pat, 'message.read', args), await mcpCall(`http://127.0.0.1:${port}`, agent.pat, 'message.read', args)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
      }
      const readText = (await mcpCall(`http://127.0.0.1:${port}`, agent.pat, 'message.read', { channelId: readCh })).text;
      for (const want of ['@mem', '@crew', '@squad', '@bot2', 'relatedAccountId', '<@00000000-0000-4000-8000-000000000000>']) expect(readText).toContain(want);

      // S5.3 C4a-4 — memory.list · secret.list · thread.note.list. 픽스처: 기억(요약·걸린 판·보관), 비밀(채널 한정 둘·파일·값 없음·만료),
      // 스레드 메모(여러 줄·긴 한글·걸린 메모·못 보는 채널), 그리고 bgCleanup 이 참일 수 있는 에이전트(→ TS).
      await db.pool.query(
        `insert into agent_memory (account_id, slug, value, kind, description, flagged_at, flag_reason, archived_at) values
           ($1, 'core', 'c', 'topic', null, null, null, null),
           ($1, 'mem/a', 'a', 'topic', '언제 "여는지" 한 줄', null, null, null),
           ($1, 'mem/b', 'b', 'procedure', '걸린 요약', now(), 'odd', null),
           ($1, 'mem/z-old', 'z', 'topic', null, null, null, now())`,
        [agent.accountId]);
      const owner = (await db.pool.query<{ o: string }>(`select owner_account_id as o from agent_config where account_id = $1`, [agent.accountId])).rows[0]!.o;
      const sec = async (name: string, kind: string, o: { filename?: string; desc?: string; expired?: boolean; sealed?: boolean } = {}) =>
        (await db.pool.query<{ id: string }>(
          `insert into secret (name, kind, filename, description, owner_account_id, expires_at) values ($1, $2, $3, $4, $5, $6) returning id`,
          [name, kind, o.filename ?? null, o.desc ?? '', owner, o.expired ? new Date(Date.now() - 3600_000) : null])).rows[0]!.id;
      for (const [name, kind, o, channels] of [
        ['b-token', 'text', { desc: '배포 토큰' }, [null, todayId]],
        ['a-key', 'file', { filename: 'id.pem' }, [readCh]],
        ['c-empty', 'text', { sealed: false }, [null]],
        ['d-expired', 'text', { expired: true }, [null]],
      ] as const) {
        const id = await sec(name, kind, o);
        await db.pool.query(`insert into secret_version (secret_id, version, sealed, size_bytes) values ($1, 1, $2, 1)`, [id, 'sealed' in o && !o.sealed ? null : 'x']);
        for (const ch of channels) await db.pool.query(`insert into secret_grant (secret_id, agent_id, channel_id, granted_by) values ($1, $2, $3, $4)`, [id, agent.accountId, ch, owner]);
      }
      const longRoot = await say(`${'가'.repeat(70)}😀 끝`, { ch: readCh });
      const flaggedRoot = await say('걸린 메모의 스레드', { ch: readCh });
      await db.pool.query(
        `insert into thread_note (account_id, thread_root_id, body, flag_reason, updated_at) values
           ($1, $2, E'\n  \n  첫 줄 \n둘째 줄', null, now() - interval '3 hours'),
           ($1, $3, $5, null, now() - interval '2 hours'),
           ($1, $4, '숨길 본문', 'looks odd', now() - interval '1 hour'),
           ($1, $6, '오늘 채널 메모', null, now())`,
        [agent.accountId, readRoot, longRoot, flaggedRoot, `﻿${'나'.repeat(130)}`, work]);
      await db.pool.query(`update agent_config set bg_enabled = true, harness = 'claude-code' where account_id = $1`, [bot2.accountId]);
      for (const [name, token, tool, args, answeredByRust] of [
        ['memory.list', agent.pat, 'memory.list', {}, true],
        ['memory.list 인자 없음', agent.pat, 'memory.list', undefined, true],
        ['memory.list 배열 인자 → TS', agent.pat, 'memory.list', [], false],
        ['memory.list 기억 없는 에이전트(bgCleanup 참일 수 있음) → TS', bot2.pat, 'memory.list', {}, false],
        ['secret.list', agent.pat, 'secret.list', {}, true],
        ['secret.list 받은 것 없음', bot2.pat, 'secret.list', {}, true],
        ['secret.list 문자열 인자 → TS', agent.pat, 'secret.list', 'x', false],
        ['thread.note.list', agent.pat, 'thread.note.list', {}, true],
        ['thread.note.list 채널', agent.pat, 'thread.note.list', { channelId: readCh }, true],
        ['thread.note.list 없는 채널', agent.pat, 'thread.note.list', { channelId: missingCh }, true],
        ['thread.note.list limit 1', agent.pat, 'thread.note.list', { limit: 1 }, true],
        ['thread.note.list limit 100', agent.pat, 'thread.note.list', { limit: 100 }, true],
        ['thread.note.list limit 0 → TS', agent.pat, 'thread.note.list', { limit: 0 }, false],
        ['thread.note.list limit 101 → TS', agent.pat, 'thread.note.list', { limit: 101 }, false],
        ['thread.note.list uuid 아님 → TS', agent.pat, 'thread.note.list', { channelId: 'x' }, false],
        ['thread.note.list 인자 없음 → TS', agent.pat, 'thread.note.list', undefined, false],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, token, tool, args), await mcpCall(`http://127.0.0.1:${port}`, token, tool, args)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
      }
      // 빈 값끼리 비교해 통과하지 않게.
      const rsUrl4 = `http://127.0.0.1:${port}`;
      const memText = (await mcpCall(rsUrl4, agent.pat, 'memory.list', {})).text;
      for (const want of ['mem/a', '여는지', 'rev\\":\\"']) expect(memText).toContain(want);
      expect(memText).not.toContain('mem/z-old');
      expect(memText).not.toContain('걸린 요약');
      const secText = (await mcpCall(rsUrl4, agent.pat, 'secret.list', {})).text;
      for (const want of ['b-token', 'a-key', 'id.pem', todayId]) expect(secText).toContain(want);
      for (const gone of ['c-empty', 'd-expired']) expect(secText).not.toContain(gone);
      const noteText = (await mcpCall(rsUrl4, agent.pat, 'thread.note.list', {})).text;
      for (const want of ['첫 줄', '…', 'flagged\\":true', '오늘 채널 메모']) expect(noteText).toContain(want);
      expect(noteText).not.toContain('숨길 본문');

      // S5.3 C4a-5 — security 지적(#2185): flag_reason 이 빈 글자인 메모는 TS 에서 본문 첫 줄을 보이고(`? '' :` 의 거짓) flagged 는 참
      // (`!== null`). 그리고 memory.revisions — 빈 칸은 키째 빠지고, chars 는 UTF-16 길이, detail 은 jsonb 키 순서 그대로.
      const emptyFlagRoot = await say('빈 표시 메모의 스레드', { ch: readCh });
      await db.pool.query(
        `insert into thread_note (account_id, thread_root_id, body, flag_reason, updated_at) values ($1, $2, '빈 표시라 보이는 본문', '', now() + interval '1 minute')`,
        [agent.accountId, emptyFlagRoot]);
      await db.pool.query(
        `insert into agent_memory_revision (account_id, slug, value, description, updated_at, replaced_at, reason, detail, kind, flagged) values
           ($1, 'mem/a', 'a😀b', '옛 요약', now() - interval '3 days', now() - interval '2 days', null, null, 'topic', false),
           ($1, 'mem/a', '합친 판', '', now() - interval '2 days', now() - interval '1 day', 'merge', '{"from": ["mem/x", "mem/y"], "n": 2}', null, false),
           ($1, 'mem/a', '걸린 판', null, now() - interval '1 day', now() - interval '1 hour', 'restore', '{}', 'procedure', true),
           ($1, 'mem/a', '같은 시각 둘', null, now() - interval '1 day', now() - interval '1 hour', null, 'null', null, false),
           ($1, 'core', 'c0', null, now() - interval '1 day', now() - interval '1 hour', null, null, null, false)`,
        [agent.accountId]);
      for (const [name, tool, args, answeredByRust] of [
        ['thread.note.list 빈 flag_reason', 'thread.note.list', {}, true],
        ['memory.revisions', 'memory.revisions', { slug: 'mem/a' }, true],
        ['memory.revisions core', 'memory.revisions', { slug: 'core' }, true],
        ['memory.revisions 판 없음', 'memory.revisions', { slug: 'mem/none' }, true],
        ['memory.revisions 모르는 키는 버린다', 'memory.revisions', { slug: 'mem/a', x: 1 }, true],
        ['memory.revisions slug 꼴 틀림 → TS(invalid_slug)', 'memory.revisions', { slug: 'Mem/A' }, false],
        ['memory.revisions 빈 slug → TS', 'memory.revisions', { slug: '' }, false],
        ['memory.revisions 수 slug → TS', 'memory.revisions', { slug: 1 }, false],
        ['memory.revisions 인자 없음 → TS', 'memory.revisions', undefined, false],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, agent.pat, tool, args), await mcpCall(rsUrl4, agent.pat, tool, args)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
      }
      expect((await mcpCall(rsUrl4, agent.pat, 'thread.note.list', {})).text).toContain('빈 표시라 보이는 본문');
      const revText = (await mcpCall(rsUrl4, agent.pat, 'memory.revisions', { slug: 'mem/a' })).text;
      for (const want of ['mem/x', 'merge', 'restore', 'flagged', 'chars\\":4', 'detail\\":{}']) expect(revText).toContain(want);

      // S5.3 C4a-6a — workitem.list(주인 보드 중 내가 볼 수 있는 스레드에 붙은 것) · automation.list(이 턴을 시킨 사람 = 소유자의
      // 승인된 자동화, 원인은 `x-harkroom-cause` 로 판정 — 없음·남의 것·1시간 넘음·자동화 글·에이전트 글).
      // 에이전트가 못 보는 스레드 — 관리자와 멤버의 DM(에이전트는 그 DM 의 멤버가 아니다).
      const privRoot = await say('DM 머리', { ch: String(dm.id), author: admin.accountId });
      await db.pool.query(
        `insert into work_item (owner_account_id, source, external_key, url, title, state, thread_root_id, updated_by, updated_at) values
           ($1, 'github', 'izagood/x#1', 'https://example.com/pr/1', 'PR "하나"', 'active', $2, $3, now() - interval '3 hours'),
           ($1, 'jira', 'RC-1', null, '스레드 없는 티켓', 'mine', null, $1, now() - interval '2 hours'),
           ($1, 'avcs', 'repo/abcdef012345', null, 'DM 일감', null, $4, $1, now() - interval '1 hour'),
           ($1, 'other', 'k-2', null, '오늘 채널 일감', 'done', $5, null, now())`,
        [owner, readRoot, agent.accountId, privRoot, work]);
      await db.pool.query(
        `insert into automation (owner_id, channel_id, name, body, trigger, enabled, paused_reason, approved_at, deleted_at, created_at) values
           ($1, $2, '아침 정리', $3, '{"kind": "cron", "cron": "0 9 * * 1", "tz": "Asia/Seoul"}', true, null, now(), null, now() - interval '4 hours'),
           ($1, $2, '멈춘 것', '짧은 본문', '{"kind": "event", "events": ["repo.merged"], "n": 3}', false, 'too_many_failures', now(), null, now() - interval '3 hours'),
           ($1, $2, '승인 전', '본문', '{"kind": "cron"}', true, null, null, null, now() - interval '2 hours'),
           ($1, $2, '지운 것', '본문', '{"kind": "cron"}', true, null, now(), now(), now() - interval '1 hour')`,
        [owner, todayId, `${'가'.repeat(205)}`]);
      const autoIds = (await db.pool.query<{ id: string; name: string }>(`select id, name from automation where owner_id = $1`, [owner])).rows;
      const paused = autoIds.find((r) => r.name === '멈춘 것')!.id;
      await db.pool.query(
        `insert into automation_run (automation_id, event_key, trigger_kind, status, created_at) values
           ($1, 'e1', 'event', 'sent', now() - interval '30 minutes'), ($1, 'e2', 'event', 'failed', now() - interval '10 minutes')`,
        [paused]);
      const ownerHandle = (await db.pool.query<{ h: string }>(`select handle as h from account where id = $1`, [owner])).rows[0]!.h;
      void ownerHandle;
      const cause = await say('@bot 자동화 목록 보여 줘', { author: owner });
      const staleCause = await say('@bot 옛 부탁', { author: owner });
      await db.pool.query(`update message set created_at = now() - interval '2 hours' where id = $1`, [staleCause]);
      const autoPost = await say('@bot 자동화가 쓴 글', { author: owner, meta: { automation: { id: autoIds[0]!.id } } });
      const agentCause = await say('@bot 에이전트가 부른 글', { author: bot2.accountId });
      for (const [name, tool, args, answeredByRust, extra] of [
        ['workitem.list', 'workitem.list', {}, true, {}],
        ['workitem.list source', 'workitem.list', { source: 'github' }, true, {}],
        ['workitem.list 스레드', 'workitem.list', { threadRootId: readRoot }, true, {}],
        ['workitem.list 못 보는 스레드', 'workitem.list', { threadRootId: privRoot }, true, {}],
        ['workitem.list 모르는 source → TS', 'workitem.list', { source: 'nope' }, false, {}],
        ['workitem.list uuid 아님 → TS', 'workitem.list', { threadRootId: 'x' }, false, {}],
        ['workitem.list 인자 없음 → TS', 'workitem.list', undefined, false, {}],
        ['automation.list 원인', 'automation.list', {}, true, { 'x-harkroom-cause': cause }],
        ['automation.list 원인(대문자)', 'automation.list', {}, true, { 'x-harkroom-cause': cause.toUpperCase() }],
        ['automation.list 원인 없음', 'automation.list', {}, true, {}],
        ['automation.list 원인 꼴 아님', 'automation.list', {}, true, { 'x-harkroom-cause': `bg:${cause}` }],
        ['automation.list 나를 안 부른 글', 'automation.list', {}, true, { 'x-harkroom-cause': work }],
        ['automation.list 1시간 넘음', 'automation.list', {}, true, { 'x-harkroom-cause': staleCause }],
        ['automation.list 자동화 글', 'automation.list', {}, true, { 'x-harkroom-cause': autoPost }],
        ['automation.list 에이전트 글', 'automation.list', {}, true, { 'x-harkroom-cause': agentCause }],
        ['automation.list 배열 인자 → TS', 'automation.list', [], false, { 'x-harkroom-cause': cause }],
        // `inputSchema: {}` 라 인자가 없으면 SDK 검증 오류(C4a-6a 에서 Rust 가 답하던 것을 C4b 에서 고침).
        ['automation.list 인자 없음 → TS', 'automation.list', undefined, false, { 'x-harkroom-cause': cause }],
      ] as const) {
        const [a, b] = [
          await mcpCall(tsUrl, agent.pat, tool, args, 1, extra as Record<string, string>),
          await mcpCall(rsUrl4, agent.pat, tool, args, 1, extra as Record<string, string>),
        ];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
      }
      // 빈 값끼리 비교해 통과하지 않게.
      const wiText = (await mcpCall(rsUrl4, agent.pat, 'workitem.list', {})).text;
      for (const want of ['izagood/x#1', '오늘 채널 일감']) expect(wiText).toContain(want);
      for (const gone of ['스레드 없는 티켓', 'DM 일감']) expect(wiText).not.toContain(gone);
      const auText = (await mcpCall(rsUrl4, agent.pat, 'automation.list', {}, 1, { 'x-harkroom-cause': cause })).text;
      for (const want of ['아침 정리', '멈춘 것', 'too_many_failures', 'failed', '…', 'Asia/Seoul']) expect(auText).toContain(want);
      for (const gone of ['승인 전', '지운 것']) expect(auText).not.toContain(gone);

      // S5.3 C4b — grant.list(위임 줄 mine·given + 명령 허용 줄 toolRules·hiddenToolRules). 규칙이 있는 에이전트(agent)와 없는 에이전트(bot2,
      // 다시 받은 위임 줄 하나만)를 둘 다 대조한다. active 는 Rust 가 harkroom_proto 의 판정(TS 골든 고정)으로 낸다.
      const conn = (await db.pool.query<{ id: string }>(
        `insert into api_connector (name, owner_account_id, base_url, auth_kind, methods) values ('grant-conn', $1, 'https://api.example.com', 'none', '{GET,POST}') returning id`,
        [owner])).rows[0]!.id;
      const parentGrant = (await db.pool.query<{ id: string }>(
        `insert into account_grant (account_id, capability, scope, granted_by, limits, delegate_depth, expires_at)
         values ($1, 'api.call', $2, $3, '{"methods": ["GET"], "pathPrefix": "/api/"}', 1, now() + interval '20 days') returning id`,
        [agent.accountId, `connector:${conn}`, owner])).rows[0]!.id;
      await db.pool.query(
        `insert into account_grant (account_id, capability, scope, granted_by, limits, parent_grant_id)
         values ($1, 'api.call', $2, $3, '{"methods": ["GET"], "pathPrefix": "/api/x"}', $4)`,
        [bot2.accountId, `connector:${conn}`, agent.accountId, parentGrant]);
      const allow = (ch: string, rule: string, expires: string | null = null) => db.pool.query(
        `insert into account_grant (account_id, capability, scope, granted_by, expires_at) values ($1, 'tool.allow', $2, $3, $4::timestamptz)`,
        [agent.accountId, `tool:${ch}:${rule}`, owner, expires]);
      await allow(todayId, 'Bash(kubectl get pods:*)', new Date(Date.now() + 7 * 86400_000).toISOString());
      await allow(todayId, 'Bash(kubectl  get  pods)');
      await allow(readCh, 'Bash(*)');
      await allow(readCh, 'mcp__other__tool');
      await allow(String(dm.id), 'Bash(ls -la)');
      await allow(todayId, 'Bash(git status)', new Date(Date.now() - 86400_000).toISOString());
      for (const [name, token, args, answeredByRust] of [
        ['grant.list 규칙 있음', agent.pat, {}, true],
        ['grant.list 인자 없음 → TS(검증 오류)', agent.pat, undefined, false],
        ['grant.list 규칙 없음(다시 받은 위임만)', bot2.pat, {}, true],
        ['grant.list 배열 인자 → TS', agent.pat, [], false],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, token, 'grant.list', args), await mcpCall(rsUrl4, token, 'grant.list', args)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
      }
      // 빈 값끼리 비교해 통과하지 않게 — 줄이 실렸고, active 가 참·거짓 둘 다 나오며, 못 보는 채널 규칙은 개수만.
      const glText = (await mcpCall(rsUrl4, agent.pat, 'grant.list', {})).text;
      for (const want of ['grant-conn', 'pathPrefix', 'kubectl get pods:*', 'active\\":true', 'active\\":false', 'hiddenToolRules\\":1', 'mcp__other__tool']) expect(glText).toContain(want);
      for (const gone of ['ls -la', 'git status']) expect(glText).not.toContain(gone);
      const gl2 = (await mcpCall(rsUrl4, bot2.pat, 'grant.list', {})).text;
      for (const want of ['toolRules\\":[]', 'hiddenToolRules\\":0', 'pathPrefix']) expect(gl2).toContain(want);
      // S5.3 C4b-w1 — 쓰기 도구 message.react·unreact. 같은 요청을 TS·Rust 에 차례로 보내 답 글자를 비교한다(리액션은 같은 결과로
      // 수렴한다 — 두 번째 달기는 on conflict, 떼기는 없는 것도 성공). 그다음 Rust 만 쓴 줄로 DB·이벤트를 따로 본다.
      const reactMsg = await say('리액션 받을 글', { ch: readCh });
      const fullMsg = await say('한도 찬 글', { ch: readCh });
      const many = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙'];
      for (const e of many) {
        await db.pool.query(`insert into message_reaction (message_id, account_id, emoji) values ($1, $2, $3)`, [fullMsg, agent.accountId, e]);
      }
      for (const [name, tool, args, answeredByRust] of [
        ['message.react', 'message.react', { channelId: readCh, messageId: reactMsg, emoji: '👍' }, true],
        ['message.react 이모지 아님', 'message.react', { channelId: readCh, messageId: reactMsg, emoji: 'abc' }, true],
        ['message.react 33자 → TS(zod)', 'message.react', { channelId: readCh, messageId: reactMsg, emoji: '👍'.repeat(17) }, false],
        ['message.react 못 보는 DM', 'message.react', { channelId: String(dm.id), messageId: reactMsg, emoji: '👍' }, true],
        ['message.react 없는 글', 'message.react', { channelId: readCh, messageId: missingCh, emoji: '👍' }, true],
        ['message.react 한도 참', 'message.react', { channelId: readCh, messageId: fullMsg, emoji: '🥳' }, true],
        ['message.react 이미 단 것은 한도 밖', 'message.react', { channelId: readCh, messageId: fullMsg, emoji: '😀' }, true],
        ['message.react uuid 아님 → TS', 'message.react', { channelId: 'x', messageId: reactMsg, emoji: '👍' }, false],
        ['message.unreact', 'message.unreact', { channelId: readCh, messageId: reactMsg, emoji: '👍' }, true],
        ['message.unreact 못 보는 DM', 'message.unreact', { channelId: String(dm.id), messageId: reactMsg, emoji: '👍' }, true],
        ['message.unreact 인자 없음 → TS', 'message.unreact', undefined, false],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, agent.pat, tool, args), await mcpCall(rsUrl4, agent.pat, tool, args)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
      }
      // W7 — 거부 길마다 Rust 가 답했는지와 거절 코드를 따로 본다. 「못 보는 DM」 은 에이전트가 정말 멤버가 아닌지부터 확인한다.
      expect((await db.pool.query(`select 1 from channel_member where channel_id = $1 and account_id = $2`, [String(dm.id), agent.accountId])).rowCount).toBe(0);
      for (const [tool, args, code] of [
        ['message.react', { channelId: String(dm.id), messageId: reactMsg, emoji: '👍' }, 'forbidden'],
        ['message.unreact', { channelId: String(dm.id), messageId: reactMsg, emoji: '👍' }, 'forbidden'],
        ['message.react', { channelId: readCh, messageId: missingCh, emoji: '👍' }, 'not_found'],
        ['message.react', { channelId: readCh, messageId: fullMsg, emoji: '🥳' }, 'too_many_reactions'],
        ['message.react', { channelId: readCh, messageId: reactMsg, emoji: 'abc' }, 'bad_request'],
      ] as const) {
        const r = await mcpCall(rsUrl4, agent.pat, tool, args);
        expect(r.core, `${tool} ${code} — Rust 가 답한다`).toBe('mcp');
        expect(r.text, `${tool} ${code}`).toContain(`\\"code\\":\\"${code}\\"`);
      }
      // W5 — TS 와 Rust 가 각자 다른 글에 같은 달기·떼기를 하고, 행과 실시간 알림(구독자에게 가는 이벤트)이 같은지 본다.
      // TS 는 자기 프로세스에서 바로 내고(onEvent), Rust 는 outbox → TS 버스로 건너온다(busEvents).
      const tsMsgW = await say('TS 가 리액션', { ch: readCh });
      const rsMsgW = await say('Rust 가 리액션', { ch: readCh });
      const seenTs: WorkspaceEvent[] = [];
      const offW = onEvent((e) => { seenTs.push(e); });
      const busFrom = busEvents.length;
      for (const [base, m] of [[tsUrl, tsMsgW], [rsUrl4, rsMsgW]] as const) {
        await mcpCall(base, agent.pat, 'message.react', { channelId: readCh, messageId: m, emoji: '🙌' });
        await mcpCall(base, agent.pat, 'message.unreact', { channelId: readCh, messageId: m, emoji: '🙌' });
        await mcpCall(base, agent.pat, 'message.react', { channelId: readCh, messageId: m, emoji: '🫡' });
      }
      const until = Date.now() + 5000;
      const fromRs = () => busEvents.slice(busFrom).filter((e) => (e as { messageId?: string }).messageId === rsMsgW);
      while (fromRs().length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      offW();
      const norm = (list: WorkspaceEvent[], m: string) => list
        .filter((e) => (e as { messageId?: string }).messageId === m)
        .map((e) => JSON.parse(JSON.stringify(e).split(m).join('<msg>')) as unknown);
      expect(norm(fromRs(), rsMsgW), 'Rust 이벤트 = TS 이벤트').toEqual(norm(seenTs, tsMsgW));
      expect(norm(seenTs, tsMsgW)).toHaveLength(3);
      const rowsOf = async (m: string) => (await db.pool.query<{ emoji: string; source: string }>(
        `select emoji, source from message_reaction where message_id = $1 order by emoji`, [m])).rows;
      expect(await rowsOf(rsMsgW), 'Rust 행 = TS 행').toEqual(await rowsOf(tsMsgW));
      expect(await rowsOf(rsMsgW)).toEqual([{ emoji: '🫡', source: 'user' }]);

      // W1 — 쓰기를 시작한 뒤의 오류는 TS 로 넘기지 않는다. 쓰기 역할에서 insert 권한을 잠깐 거두면 insert 가 실패한다 →
      // Rust 가 `internal` 로 답하고(core=mcp), TS 가 대신 쓰지 않았으니 행이 없어야 한다.
      const w1Msg = await say('W1 쓰기 실패', { ch: readCh });
      await db.pool.query(`revoke insert on message_reaction from ${rw}`);
      try {
        const w1 = await mcpCall(rsUrl4, agent.pat, 'message.react', { channelId: readCh, messageId: w1Msg, emoji: '🧪' });
        expect(w1.core, 'W1 — Rust 가 답한다').toBe('mcp');
        expect(w1.text).toContain('\\"code\\":\\"internal\\"');
        expect((await db.pool.query(`select 1 from message_reaction where message_id = $1`, [w1Msg])).rowCount, 'TS 가 대신 쓰지 않았다').toBe(0);
      } finally {
        await db.pool.query(`grant insert on message_reaction to ${rw}`);
      }
      // Rust 만 쓴 줄 — DB 에 남고 이벤트(outbox)가 TS 와 같은 모양으로 나간다.
      const rustOnly = await say('Rust 만 리액션', { ch: readCh });
      const outboxBefore = (await db.pool.query<{ n: number }>(`select count(*)::int as n from event_outbox`)).rows[0]!.n;
      const r1 = await mcpCall(rsUrl4, agent.pat, 'message.react', { channelId: readCh, messageId: rustOnly, emoji: '🎉' });
      expect(r1.core).toBe('mcp');
      expect(r1.text).toContain('emoji\\":\\"🎉');
      expect((await db.pool.query(`select 1 from message_reaction where message_id = $1 and account_id = $2 and emoji = '🎉' and source = 'user'`,
        [rustOnly, agent.accountId])).rowCount).toBe(1);
      const ev = (await db.pool.query<{ event: Record<string, unknown> }>(
        `select event from event_outbox where event->>'type' = 'reaction.added' and event->>'messageId' = $1 order by id desc limit 1`,
        [rustOnly])).rows[0]!.event;
      expect(ev).toMatchObject({ type: 'reaction.added', channelId: readCh, messageId: rustOnly, emoji: '🎉', accountId: agent.accountId });
      expect((await db.pool.query<{ n: number }>(`select count(*)::int as n from event_outbox`)).rows[0]!.n).toBeGreaterThan(outboxBefore);
      const r2 = await mcpCall(rsUrl4, agent.pat, 'message.unreact', { channelId: readCh, messageId: rustOnly, emoji: '🎉' });
      expect(r2.core).toBe('mcp');
      expect((await db.pool.query(`select 1 from message_reaction where message_id = $1 and emoji = '🎉'`, [rustOnly])).rowCount).toBe(0);

      // S5.3 C4b ④-a — inbox.read. TS·Rust 가 각자 같은 꼴의 항목(내 안 읽은 둘 · 내 이미 읽은 것 · 남의 것)을 읽음으로 하고,
      // 답 글자(`{"read":2}`)와 행(읽음 시각이 생긴 것)이 같은지 본다. 실수 꼴·안전 범위 밖·빈 배열은 TS 가 답한다.
      const inboxMsg = await say('inbox.read 대상', { ch: readCh });
      const inboxSet = async () => {
        const ins = async (acct: string, read: boolean) => Number((await db.pool.query<{ id: string }>(
          `insert into inbox (account_id, message_id, reason, read_at) values ($1, $2, 'mention', ${read ? 'now()' : 'null'}) returning id`,
          [acct, inboxMsg])).rows[0]!.id);
        return [await ins(agent.accountId, false), await ins(agent.accountId, false), await ins(agent.accountId, true), await ins(bot2.accountId, false)];
      };
      const readRows = async (ids: number[]) => (await db.pool.query<{ read: boolean }>(
        `select read_at is not null as read from inbox where id = any($1) order by id`, [ids])).rows.map((r) => r.read);
      const [tsIds, rsIds] = [await inboxSet(), await inboxSet()];
      const ir = [await mcpCall(tsUrl, agent.pat, 'inbox.read', { ids: tsIds }), await mcpCall(rsUrl4, agent.pat, 'inbox.read', { ids: rsIds })];
      expect({ status: ir[1]!.status, type: ir[1]!.type, text: ir[1]!.text }, 'inbox.read').toEqual({ status: ir[0]!.status, type: ir[0]!.type, text: ir[0]!.text });
      expect(ir[1]!.core, 'inbox.read — Rust 가 답한다').toBe('mcp');
      expect(ir[1]!.text).toContain('read\\":2');
      expect(await readRows(rsIds), 'Rust 행 = TS 행').toEqual(await readRows(tsIds));
      expect(await readRows(rsIds)).toEqual([true, true, true, false]);
      for (const [name, args] of [
        ['inbox.read 실수 꼴 → TS', { ids: [1.5] }],
        ['inbox.read 안전 범위 밖 → TS', { ids: [9007199254740993] }],
        ['inbox.read 빈 배열 → TS', { ids: [] }],
        ['inbox.read 인자 없음 → TS', undefined],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, agent.pat, 'inbox.read', args), await mcpCall(rsUrl4, agent.pat, 'inbox.read', args)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(null);
      }

      // S5.3 C4b ④-a(2/2) — bg.claim. 켜짐은 TS admit 의 `bgEnabled` 로만 안다(꺼짐 → TS 가 `disabled`). 러너가 아닌 꼴(PAT·cause·턴 id)은
      // TS 가 `runner_only` 로 답한다. 켜진 러너면 Rust 가 답하고 글자가 TS 와 같다 — 창 밖이면 outside_window, 창 안이면 일감이 없어 none
      // (시각을 주입할 수 없어 창 안의 집기·distill digest 는 `bg_claim.rs` 단위 시험이 본다).
      const bgOp = await registerOperator(app, admin.token, 'bg-mac');
      await db.pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [agent.accountId, bgOp.operatorId, admin.accountId]);
      const asRunner = { 'x-harkroom-agent': agent.accountId };
      const bgPair = async (token: string, extra: Record<string, string>) =>
        [await mcpCall(tsUrl, token, 'bg.claim', {}, 1, extra), await mcpCall(rsUrl4, token, 'bg.claim', {}, 1, extra)];
      const prevBg = process.env.HARKROOM_BACKGROUND_ENABLED;
      try {
        delete process.env.HARKROOM_BACKGROUND_ENABLED;
        for (const [name, token, extra, code] of [
          ['bg.claim 꺼짐 → TS(disabled)', bgOp.token, asRunner, 'disabled'],
          ['bg.claim PAT → TS(runner_only)', agent.pat, {}, 'runner_only'],
        ] as const) {
          const [a, b] = await bgPair(token, extra);
          expect({ status: b!.status, type: b!.type, text: b!.text }, name).toEqual({ status: a!.status, type: a!.type, text: a!.text });
          expect(b!.core, `${name} — 누가 답했나`).toBe(null);
          expect(a!.text, name).toContain(code);
        }
        process.env.HARKROOM_BACKGROUND_ENABLED = '1';
        for (const [name, extra] of [
          ['bg.claim cause 턴 → TS', { ...asRunner, 'x-harkroom-cause': 'mention:x' }],
          ['bg.claim 턴 id → TS', { ...asRunner, 'x-harkroom-turn-id': 'turn-1' }],
          ['bg.claim 빈 턴 id 도 턴 → TS', { ...asRunner, 'x-harkroom-turn-id': '' }],
        ] as const) {
          const [a, b] = await bgPair(bgOp.token, extra);
          expect({ status: b!.status, type: b!.type, text: b!.text }, name).toEqual({ status: a!.status, type: a!.type, text: a!.text });
          expect(b!.core, `${name} — 누가 답했나`).toBe(null);
        }
        const [a, b] = await bgPair(bgOp.token, asRunner);
        expect({ status: b!.status, type: b!.type, text: b!.text }, 'bg.claim 켜진 러너').toEqual({ status: a!.status, type: a!.type, text: a!.text });
        expect(b!.core, 'bg.claim 켜진 러너 — Rust 가 답한다').toBe('mcp');
        expect(b!.text).toMatch(/outside_window|none/);
      } finally {
        if (prevBg === undefined) delete process.env.HARKROOM_BACKGROUND_ENABLED; else process.env.HARKROOM_BACKGROUND_ENABLED = prevBg;
      }

      // S5.3 C4b-ask — message.askBundleResolve. TS·Rust 가 **각자의 묶음·원본**으로 같은 시나리오를 돌리고, 답 글자(id·시각만 자리표로)·
      // 원본 meta·깨움 inbox·실시간 이벤트를 견준다. 묶음 줄(TS askBundleItem 모양)은 meta 로 직접 세운다 — askBundle 은 아직 TS 다.
      {
        const bOpts = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
        const cardMeta = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
          ({ kind: 'ask', ask: { prompt: '고를까?', options: bOpts, to: { kind: 'human' }, ...extra }, ...top });
        const fixture = async (tag: string) => {
          const root = await say(`${tag} 원본`, { ch: readCh, author: bot2.accountId, meta: cardMeta() });
          const answered = await say(`${tag} 답한 원본`, { ch: readCh, author: bot2.accountId, meta: cardMeta({ answeredWith: 'a' }) });
          const perm = await say(`${tag} 권한 원본`, { ch: readCh, author: bot2.accountId, meta: cardMeta({}, { permissionRequest: { kind: 'tool' } }) });
          const linked = await say(`${tag} 링크 줄 원본`, { ch: readCh, author: bot2.accountId, meta: cardMeta() });
          const toMem = await say(`${tag} mem 앞 원본`, { ch: readCh, author: bot2.accountId, meta: cardMeta({ to: { kind: 'account', accountId: member.accountId } }) });
          const plain = await say(`${tag} 카드 아님`, { ch: readCh, author: bot2.accountId });
          const item = (rootId: string, extra: Record<string, unknown> = {}) => ({ rootId, prompt: '고를까?', options: bOpts, ...extra });
          const items = [item(root), item(answered), item(perm), item(linked, { link: { kind: 'permission' } }), item(toMem), item(plain)];
          const bundle = await say(`${tag} 묶음`, { ch: readCh, meta: { kind: 'askBundle', askBundle: { items } } });
          const notMine = await say(`${tag} 남의 묶음`, { ch: readCh, author: bot2.accountId, meta: { kind: 'askBundle', askBundle: { items } } });
          const reply = await say(`${tag} 사람 답`, { ch: readCh, root: bundle, author: admin.accountId });
          const agentReply = await say(`${tag} 에이전트 답`, { ch: readCh, root: bundle });
          const elsewhere = await say(`${tag} 다른 스레드 사람 글`, { ch: readCh, author: admin.accountId });
          return { root, answered, perm, linked, toMem, plain, bundle, notMine, reply, agentReply, elsewhere };
        };
        type Fx = Awaited<ReturnType<typeof fixture>>;
        const [fT, fR] = [await fixture('T'), await fixture('R')];
        const ids = (x: Fx) => Object.entries(x).map(([k, v]) => [v, `<${k}>`] as const);
        const normText = (t: string, x: Fx) => ids(x)
          .reduce((s, [v, k]) => s.split(v).join(k), t)
          .replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)/g, '<ts>')
          .replace(/(\\*"seq\\*":)\d+/g, '$1"<seq>"')
          .replace(/(T|R) (원본|답한 원본|권한 원본|링크 줄 원본|mem 앞 원본|카드 아님|묶음|남의 묶음|사람 답|에이전트 답|다른 스레드 사람 글)/g, '$2');
        const cases: [string, (x: Fx) => unknown, boolean][] = [
          ['없는 묶음', (x) => ({ bundleId: missingCh, rootId: x.root, replyMessageId: x.reply }), true],
          ['남의 묶음', (x) => ({ bundleId: x.notMine, rootId: x.root, replyMessageId: x.reply }), true],
          ['묶음 아닌 글', (x) => ({ bundleId: x.plain, rootId: x.root, replyMessageId: x.reply }), true],
          ['줄 없음', (x) => ({ bundleId: x.bundle, rootId: x.reply, replyMessageId: x.reply }), true],
          ['권한 원본', (x) => ({ bundleId: x.bundle, rootId: x.perm, replyMessageId: x.reply }), true],
          ['링크 줄', (x) => ({ bundleId: x.bundle, rootId: x.linked, replyMessageId: x.reply }), true],
          ['에이전트 글', (x) => ({ bundleId: x.bundle, rootId: x.root, replyMessageId: x.agentReply }), true],
          ['다른 스레드 글', (x) => ({ bundleId: x.bundle, rootId: x.root, replyMessageId: x.elsewhere }), true],
          ['답한 원본', (x) => ({ bundleId: x.bundle, rootId: x.answered, replyMessageId: x.reply }), true],
          ['mem 앞 원본에 admin 글', (x) => ({ bundleId: x.bundle, rootId: x.toMem, replyMessageId: x.reply }), true],
          ['카드 아닌 원본', (x) => ({ bundleId: x.bundle, rootId: x.plain, replyMessageId: x.reply }), true],
          ['note 빈 글 → TS(zod)', (x) => ({ bundleId: x.bundle, rootId: x.root, replyMessageId: x.reply, note: '' }), false],
          ['note 숫자 → TS(zod)', (x) => ({ bundleId: x.bundle, rootId: x.root, replyMessageId: x.reply, note: 1 }), false],
          ['uuid 아님 → TS', (x) => ({ bundleId: 'x', rootId: x.root, replyMessageId: x.reply }), false],
          ['인자 없음 → TS', () => undefined, false],
          ['닫기', (x) => ({ bundleId: x.bundle, rootId: x.root, replyMessageId: x.reply, note: '  A 로 가자  ' }), true],
          ['다시 닫기', (x) => ({ bundleId: x.bundle, rootId: x.root, replyMessageId: x.reply }), true],
        ];
        const seenB: WorkspaceEvent[] = [];
        const offB = onEvent((e) => { seenB.push(e); });
        const busFromB = busEvents.length;
        for (const [name, args, byRust] of cases) {
          const a = await mcpCall(tsUrl, agent.pat, 'message.askBundleResolve', args(fT));
          const b = await mcpCall(rsUrl4, agent.pat, 'message.askBundleResolve', args(fR));
          expect({ status: b.status, type: b.type, text: normText(b.text, fR) }, name)
            .toEqual({ status: a.status, type: a.type, text: normText(a.text, fT) });
          expect(b.core, `${name} — 누가 답했나`).toBe(byRust ? 'mcp' : null);
        }
        // 빈 것끼리 같아 통과하지 않게 — 거절 코드와 성공 모양을 Rust 답에서 따로 본다.
        const rsB = (args: unknown) => mcpCall(rsUrl4, agent.pat, 'message.askBundleResolve', args);
        for (const [code, args] of [
          ['bundle_not_found', { bundleId: missingCh, rootId: fR.root, replyMessageId: fR.reply }],
          ['bundle_not_yours', { bundleId: fR.notMine, rootId: fR.root, replyMessageId: fR.reply }],
          ['bundle_item_not_found', { bundleId: fR.bundle, rootId: fR.reply, replyMessageId: fR.reply }],
          ['bundle_item_link', { bundleId: fR.bundle, rootId: fR.perm, replyMessageId: fR.reply }],
          ['bundle_reply_invalid', { bundleId: fR.bundle, rootId: fR.toMem, replyMessageId: fR.reply }],
          ['bundle_item_resolved', { bundleId: fR.bundle, rootId: fR.answered, replyMessageId: fR.reply }],
          ['mirror_not_found', { bundleId: fR.bundle, rootId: fR.plain, replyMessageId: fR.reply }],
        ] as const) {
          const r = await rsB(args);
          expect(r.core, code).toBe('mcp');
          expect(r.text, code).toContain(`\\"code\\":\\"${code}\\"`);
        }
        // 원본 meta — 닫은 이름은 글쓴 사람(admin), 요지는 다듬어 실리고 요지를 옮긴 쪽은 에이전트.
        const askOf = async (id: string) => (await db.pool.query<{ ask: Record<string, unknown> }>(
          `select meta->'ask' as ask from message where id = $1`, [id])).rows[0]!.ask;
        const strip = (a: Record<string, unknown>, x: Fx) => ({ ...a, closedAt: typeof a.closedAt, replyMessageId: a.replyMessageId === x.reply });
        expect(strip(await askOf(fR.root), fR), 'Rust 원본 = TS 원본').toEqual(strip(await askOf(fT.root), fT));
        expect(await askOf(fR.root)).toMatchObject({ closedBy: admin.accountId, closedReason: 'replied', replyNote: 'A 로 가자', replyNoteBy: agent.accountId });
        // 원본을 세운 쪽(bot2) 깨움 — 양쪽 다 ask_closed 한 줄.
        const woke = async (id: string) => (await db.pool.query<{ reason: string }>(
          `select reason from inbox where account_id = $1 and message_id = $2`, [bot2.accountId, id])).rows.map((r) => r.reason);
        expect(await woke(fR.root)).toEqual(await woke(fT.root));
        expect(await woke(fR.root)).toEqual(['ask_closed']);
        // 실시간 이벤트 — TS(onEvent) 와 Rust(outbox → 버스)를 audience 까지 견준다. 상태 리액션(TS 감시자가 message.updated 를 듣고
        // 다는 것)은 Rust 쪽에서도 TS 프로세스가 내므로 쓰기 이벤트와 따로 둔다(C3b-1 대조와 같은 까닭).
        const mine = (list: WorkspaceEvent[], x: Fx) => list
          .filter((e) => !e.type.startsWith('reaction.'))
          .filter((e) => { const s = JSON.stringify(e); return s.includes(x.root) || s.includes(x.bundle) || (e.type === 'inbox.updated' && (e as { accountId?: string }).accountId === bot2.accountId); })
          .map((e) => JSON.parse(normText(JSON.stringify(e), x)) as unknown)
          // 묶음 맞추기의 차례는 TS·Rust 모두 정하지 않는다(order by 없음) — 차례 말고 모음으로 견준다.
          .sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)));
        const untilB = Date.now() + 5000;
        while (mine(busEvents.slice(busFromB), fR).length < mine(seenB, fT).length && Date.now() < untilB) await new Promise((r) => setTimeout(r, 50));
        offB();
        expect(mine(seenB, fT).length, 'TS 이벤트가 있다').toBeGreaterThanOrEqual(3);
        expect(mine(busEvents.slice(busFromB), fR), 'Rust 이벤트 = TS 이벤트').toEqual(mine(seenB, fT));

        // W1 — 쓰기 뒤 오류는 TS 로 넘기지 않는다. meta 고치기 권한을 잠깐 거두면 update 가 실패 → Rust internal, 원본은 열린 채.
        const w1 = await fixture('W');
        await db.pool.query(`revoke update (meta) on message from ${rw}`);
        try {
          const r = await rsB({ bundleId: w1.bundle, rootId: w1.root, replyMessageId: w1.reply });
          expect(r.core, 'W1 — Rust 가 답한다').toBe('mcp');
          expect(r.text).toContain('\\"code\\":\\"internal\\"');
          expect((await askOf(w1.root)).closedAt, 'TS 가 대신 닫지 않았다').toBeUndefined();
        } finally {
          await db.pool.query(`grant update (meta) on message to ${rw}`);
        }

        // 대문자 replyMessageId — 원본 meta 에는 입력 글자가 아니라 DB 의 id(소문자)가 적힌다. TS(`reply.id`)와 같다.
        const [uT, uR] = [await fixture('UT'), await fixture('UR')];
        const upper = (x: Fx) => ({ bundleId: x.bundle, rootId: x.root, replyMessageId: x.reply.toUpperCase() });
        expect((await mcpCall(tsUrl, agent.pat, 'message.askBundleResolve', upper(uT))).core, '대문자 — TS').toBeNull();
        expect((await rsB(upper(uR))).core, '대문자 — Rust 가 답한다').toBe('mcp');
        expect((await askOf(uT.root)).replyMessageId, 'TS 는 소문자로 적는다').toBe(uT.reply);
        expect((await askOf(uR.root)).replyMessageId, 'Rust 도 소문자로 적는다').toBe(uR.reply);
      }

      // S5.3 C4a-6b — message.search. 본문 멘션 되돌리기·시스템 줄·스코프(채널·스레드)·거르기(보낸 사람·첨부)·정렬·쪽(51개 → hasMore,
      // 천장 1000)·못 보는 채널(결과에서 빠짐 · 범위로 주면 forbidden). `@`·기간·틀린 꼴은 TS 로 넘긴다.
      const searchCh = String((await ok(app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'mcp-search' } }))).id);
      await ok(app.inject({ method: 'POST', url: `/channels/${searchCh}/members`, headers: auth, payload: { accountId: agent.accountId } }));
      for (let i = 0; i < 53; i += 1) await say(`대량검색어 ${i} 줄`, { ch: searchCh });
      const searchRoot = await say('스레드검색 머리 @mem', { ch: searchCh });
      await say('스레드검색 답글', { ch: searchCh, root: searchRoot });
      await say('스레드검색 남의 글', { ch: searchCh, author: admin.accountId });
      await say('100%_퍼센트 밑줄', { ch: searchCh });
      // 에이전트가 못 보는 곳 — 관리자와 멤버의 DM(비공개 채널 today-private 에는 에이전트가 멤버로 들어 있다).
      await say('비밀검색어 못 보는 곳', { ch: String(dm.id), author: admin.accountId });
      for (const [name, args, answeredByRust] of [
        ['message.search', { query: '부름' }, true],
        ['message.search 시스템 줄', { query: '시스템' }, true],
        ['message.search 최신순', { query: '스레드검색', sort: 'recent' }, true],
        ['message.search 관련도(명시)', { query: '스레드검색', sort: 'relevance' }, true],
        ['message.search 채널', { query: '스레드검색', channelId: searchCh }, true],
        ['message.search 스레드(루트 포함)', { query: '스레드검색', threadRootId: searchRoot }, true],
        ['message.search 보낸 사람', { query: '스레드검색', authorIds: [admin.accountId] }, true],
        ['message.search 보낸 사람 빈 배열', { query: '스레드검색', authorIds: [] }, true],
        ['message.search 첨부만', { query: '스레드검색', hasAttachment: true }, true],
        ['message.search 첨부 false', { query: '스레드검색', hasAttachment: false }, true],
        ['message.search 51개 → hasMore', { query: '대량검색어' }, true],
        ['message.search 둘째 쪽', { query: '대량검색어', offset: 50 }, true],
        ['message.search 천장', { query: '대량검색어', offset: 1000 }, true],
        ['message.search like 메타문자', { query: '100%_' }, true],
        ['message.search 낱말 없음', { query: '!!!' }, true],
        ['message.search 두 글자 중간', { query: '검색' }, true],
        ['message.search 못 보는 채널의 글', { query: '비밀검색어' }, true],
        ['message.search 멤버 아닌 DM → forbidden', { query: '비밀검색어', channelId: String(dm.id) }, true],
        ['message.search 없는 채널', { query: 'x', channelId: missingCh }, true],
        ['message.search 모르는 키는 버린다', { query: '부름', extra: 1 }, true],
        ['message.search @ → TS', { query: '@bot2' }, false],
        ['message.search after → TS', { query: '부름', after: '2026-01-01T00:00:00Z' }, false],
        ['message.search before → TS', { query: '부름', before: '2026-01-01T00:00:00+09:00' }, false],
        ['message.search 빈 질의 → TS', { query: '' }, false],
        ['message.search 정렬 틀림 → TS', { query: '부름', sort: 'old' }, false],
        ['message.search offset 1001 → TS', { query: '부름', offset: 1001 }, false],
        ['message.search 보낸 사람 uuid 아님 → TS', { query: '부름', authorIds: ['x'] }, false],
        ['message.search 첨부 문자열 → TS', { query: '부름', hasAttachment: 'true' }, false],
        ['message.search 질의 없음 → TS', {}, false],
      ] as const) {
        const [a, b] = [await mcpCall(tsUrl, agent.pat, 'message.search', args), await mcpCall(rsUrl4, agent.pat, 'message.search', args)];
        expect({ status: b.status, type: b.type, text: b.text }, name).toEqual({ status: a.status, type: a.type, text: a.text });
        expect(b.core, `${name} — 누가 답했나`).toBe(answeredByRust ? 'mcp' : null);
      }
      // 빈 값끼리 비교해 통과하지 않게.
      const seText = (await mcpCall(rsUrl4, agent.pat, 'message.search', { query: '부름' })).text;
      for (const want of ['@mem', '@crew', '@squad', 'hasMore\\":false']) expect(seText).toContain(want);
      expect((await mcpCall(rsUrl4, agent.pat, 'message.search', { query: '대량검색어' })).text).toContain('hasMore\\":true');
      expect((await mcpCall(rsUrl4, agent.pat, 'message.search', { query: '시스템' })).text).toContain('relatedAccountId');
      expect((await mcpCall(rsUrl4, agent.pat, 'message.search', { query: '비밀검색어' })).text).not.toContain('못 보는 곳');
      // forbidden 갈래를 실제로 타는지 — TS 와 같다는 것만으로는 둘 다 성공해도 통과한다. 에이전트는 이 DM(관리자·멤버)의 멤버가 아니다
      // (비공개 채널 today-private 에는 멤버라 그 채널로는 이 갈래가 닿지 않는다).
      // 빈 문서 갈래도 실제로 타는지(forbidden 이 아니라 빈 문서).
      const emptyDoc = await mcpCall(rsUrl4, agent.pat, 'channel.doc', { channelId: privId });
      expect(emptyDoc.core).toBe('mcp');
      expect(emptyDoc.text).toContain(`\\"channelId\\":\\"${privId}\\",\\"body\\":\\"\\",\\"updatedBy\\":null`);
      for (const [tool, args] of [
        ['channel.doc', { channelId: String(dm.id) }],
        ['message.read', { channelId: String(dm.id) }],
        ['message.search', { query: '비밀검색어', channelId: String(dm.id) }],
      ] as const) {
        const r = await mcpCall(rsUrl4, agent.pat, tool, args);
        expect(r.core, `${tool} — Rust 가 답한다`).toBe('mcp');
        expect(r.text, `${tool} forbidden`).toContain('\\"code\\":\\"forbidden\\"');
      }
      // 빈 값끼리 비교해 통과하지 않게 — 문서·목록이 실제로 실렸는지.
      const docText = (await mcpCall(`http://127.0.0.1:${port}`, agent.pat, 'channel.doc', { channelId: todayId })).text;
      expect(docText).toContain('문서 본문');
      expect((await mcpCall(`http://127.0.0.1:${port}`, agent.pat, 'channel.list', {})).text).toContain('today');
      const listText = (await mcpCall(`http://127.0.0.1:${port}`, agent.pat, 'account.list', {})).text;
      for (const want of ['squad', 'crew', 'leadAccountId', 'bot2']) expect(listText).toContain(want);

      // 빈 목록끼리 비교해 통과하지 않게 — 픽스처가 실제로 칸을 채웠는지.
      const rs = `http://127.0.0.1:${port}`;
      const prefsBody = (await getJson(rs, '/channels/prefs', admin.token)).body as { prefs: Record<string, unknown>[]; sections: unknown[] };
      expect(prefsBody.prefs.some((p) => p.starredAt && p.notifyLevel === 'mentions'), '시각 칸이 찬 pref').toBe(true);
      expect(prefsBody.sections.length).toBeGreaterThan(0);
      expect(((await getJson(rs, `/channels/${todayId}/scheduled`, admin.token)).body as { scheduled: unknown[] }).scheduled).toHaveLength(1);
      expect(((await getJson(rs, `/channels/${todayId}/auto-mentions`, member.token)).body as { autoMentions: unknown[] }).autoMentions).toHaveLength(1);
      expect(((await getJson(rs, '/channels', admin.token)).body as { channels: Record<string, unknown>[] }).channels.some((c) => c.archivedAt), '보관 시각 칸').toBe(true);
      const pinsBody = (await getJson(rs, `/channels/${todayId}/pins`, member.token)).body as { pins: { messageId: string; pinnedAt: string; message: { reactions: unknown[] } }[] };
      expect(pinsBody.pins.map((p) => p.messageId), '지운 글의 핀은 빠지고 최근 핀이 먼저').toEqual([oldCard, work]);
      expect(pinsBody.pins[1]!.message.reactions.length).toBeGreaterThan(0);
      expect((await getJson(rs, `/channels/${privId}/delete-info`, admin.token)).body).toMatchObject({ name: 'today-private' });

      // S5.3 C1b-1b — `GET /channels/{id}/messages`(코어 `msg_list.rs`). 9갈래·hasMore·planProgress 를 본문 전체로 견준다.
      // 거절은 상태·코드까지(문구는 zod 와 다르다).
      expect(f.log()).toContain('"GET /channels/{id}/messages"');
      // 계획판 픽스처 — work 의 계획이 자식 넷을 잇는다: 다른 공개 채널(계획 있음)·같은 채널(계획 없음)·비공개 채널(숨김)·지운 머리(숨김).
      const other = await ok(app.inject({ method: 'POST', url: '/channels', headers: auth, payload: { name: 'plans-other' } }));
      const childPub = await say('공개 자식', { ch: String(other.id) });
      const childGone = await say('지울 자식');
      await db.pool.query(`update message set deleted_at = now() where id = $1`, [childGone]);
      const step = (id: string, groupId: string | null, state: string, dependsOn: string[] = []) =>
        ({ id, groupId, title: id, state, links: [], dependsOn });
      const plan = (rootId: string, channelId: string, doc: Record<string, unknown>) => db.pool.query(
        `insert into thread_plan (root_id, channel_id, doc, rev, updated_at) values ($1, $2, $3::jsonb, 3, now() - interval '5 minutes')`,
        [rootId, channelId, JSON.stringify(doc)],
      );
      await plan(childPub, String(other.id), {
        goal: '자식', groups: [], steps: [step('s1', null, 'done'), step('s2', null, 'active'), step('s3', null, 'todo', ['s2'])],
      });
      await plan(work, todayId, {
        goal: '부모',
        groups: [
          { id: 'g1', title: '내 단계', dependsOn: [] },
          { id: 'g2', title: '공개 자식', linkedRootId: childPub, dependsOn: ['g1'] },
          { id: 'g3', title: '같은 채널', linkedRootId: running, dependsOn: [] },
          { id: 'g4', title: '비공개', linkedRootId: secret, dependsOn: [] },
          { id: 'g5', title: '지운 것', linkedRootId: childGone, dependsOn: [] },
        ],
        steps: [step('s1', 'g1', 'done'), step('s2', 'g1', 'blocked'), step('s3', null, 'todo', ['s1'])],
      });
      // 계획만 있고 자식이 없는 머리 하나(stuck).
      await plan(stuck, todayId, { goal: '혼자', groups: [], steps: [step('s1', null, 'active')] });
      const seqOf = async (id: string) => Number((await db.pool.query<{ seq: string }>('select seq::text from message where id = $1', [id])).rows[0]!.seq);
      const [workSeq, waitingSeq, cardSeq] = [await seqOf(work), await seqOf(waiting), await seqOf(oldCard)];
      const lst = `/channels/${todayId}/messages`;
      let planned = 0;
      for (const [path, token] of [
        [lst, member.token], [`${lst}?limit=3`, member.token], [`${lst}?limit=500`, admin.token],
        [`${lst}?since=${workSeq}&limit=4`, member.token], [`${lst}?since=${waitingSeq}`, agent.pat],
        [`${lst}?before=${waitingSeq}&limit=3`, member.token], [`${lst}?before=${waitingSeq}&feed=1&limit=3`, member.token],
        [`${lst}?before=${waitingSeq}&feed=1`, admin.token],
        [`${lst}?around=${waitingSeq}&limit=4`, member.token], [`${lst}?around=${workSeq}`, member.token],
        [`${lst}?thread=${work}`, member.token], [`${lst}?thread=${work}&limit=1`, member.token],
        [`${lst}?thread=${work}&before=${cardSeq + 5}&limit=1`, member.token], [`${lst}?thread=${work}&since=${workSeq}&limit=1`, member.token],
        [`${lst}?thread=${work}&around=${cardSeq}&limit=2`, member.token], [`${lst}?thread=${work.toUpperCase()}`, member.token],
        [`/channels/${String(other.id)}/messages`, member.token], [`/channels/${String(dm.id)}/messages?limit=1`, admin.token],
        [`/channels/${privId}/messages`, agent.pat], [`/channels/${privId}/messages`, member.token], [`/channels/${privId}/messages`, admin.token],
        [`/channels/${missingCh}/messages`, admin.token], ['/channels/not-a-uuid/messages', admin.token],
        [`${lst}?before=3&since=1`, member.token], [`${lst}?feed=1`, member.token], [`${lst}?feed=1&since=3`, member.token],
        [`${lst}?feed=true&before=3`, member.token], [`${lst}?feed=1&before=3&thread=${work}`, member.token],
        [`${lst}?limit=0`, member.token], [`${lst}?limit=501`, member.token], [`${lst}?limit=1.5`, member.token],
        [`${lst}?limit=1&limit=2`, member.token], [`${lst}?limit=`, member.token], [`${lst}?limit=%200x10`, member.token],
        [`${lst}?since=-1`, member.token], [`${lst}?thread=nope`, member.token], [`${lst}?other=1&limit=2`, member.token],
        [lst, undefined], [`${lst}?limit=0`, undefined],
      ] as const) {
        const [a, b] = [await getJson(tsUrl, path, token), await getJson(rs, path, token)];
        expect(b, `${path} ${token === admin.token ? 'admin' : token === member.token ? 'mem' : token ? 'agent' : 'anon'}`).toEqual(a);
        planned += ((b.body as { messages?: { planProgress?: unknown }[] } | undefined)?.messages ?? []).filter((m) => m.planProgress).length;
      }
      expect(planned, '계획판 진행률이 실제로 붙은 행').toBeGreaterThan(0);
      const full = (await getJson(rs, `${lst}?limit=500`, member.token)).body as { messages: { id: string; planProgress?: Record<string, unknown> | null }[]; hasMore: boolean };
      expect(full.hasMore).toBe(false);
      expect((await getJson(rs, `${lst}?limit=3`, member.token)).body).toMatchObject({ hasMore: true });
      // 공개 자식(1/3 끝)은 열리고, 비공개·지운 자식은 숨김으로 센다 — 값은 TS 와의 본문 대조가 지킨다. 여기서는 칸이 찼는지만.
      expect(full.messages.find((m) => m.id === work)?.planProgress).toMatchObject({ rev: 3 });
      expect(full.messages.find((m) => m.id === waiting)?.planProgress, '계획 없는 머리는 null').toBeNull();

      // S5.2 P3 — `PUT /inbox/today/seen` 대조. 거절은 상태·코드까지(문구는 zod 와 다르다), 성공은 본문까지 같아야 한다.
      const rsUrl = `http://127.0.0.1:${port}`;
      const put = async (base: string, o: { token?: string; ct?: string; body?: string }) => {
        const headers: Record<string, string> = {};
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        if (o.ct) headers['content-type'] = o.ct;
        const res = await fetch(`${base}/inbox/today/seen`, { method: 'PUT', headers, body: o.body });
        const text = await res.text();
        const json = text ? JSON.parse(text) as { seenAt?: string; error?: { code: string } } : {};
        return { status: res.status, code: json.error?.code, seenAt: json.seenAt };
      };
      const J = 'application/json';
      const upTo = (s: string) => JSON.stringify({ upTo: s });
      for (const [name, o] of [
        ['익명·본문 없음 → 401', {}],
        ['익명·빈 json → 400(본문이 인증보다 먼저)', { ct: J, body: '' }],
        ['익명·깨진 json → 400', { ct: J, body: '{' }],
        ['익명·모르는 형식 → 415', { ct: 'application/xml', body: '<a/>' }],
        ['본문 없음 → 400', { token: agent.pat }],
        ['text/plain → 400', { token: agent.pat, ct: 'text/plain', body: 'x' }],
        ['배열 → 400', { token: agent.pat, ct: J, body: '[]' }],
        ['upTo 숫자 → 400', { token: agent.pat, ct: J, body: JSON.stringify({ upTo: 1 }) }],
        ['오프셋 없음 → 400', { token: agent.pat, ct: J, body: upTo('2026-11-13T09:00:00') }],
        ['없는 날 → 400', { token: agent.pat, ct: J, body: upTo('2026-02-29T00:00:00Z') }],
        ['오프셋 +24:00 → 500(JS Invalid Date)', { token: agent.pat, ct: J, body: upTo('2026-11-13T09:00+24:00') }],
      ] as const) {
        const [a, b] = [await put(tsUrl, o), await put(rsUrl, o)];
        expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
      }
      // 정상: mem 의 커서를 Rust 로 처음 세운다 → 이벤트 한 번. 같은 값을 TS 로 → 같은 값. 더 옛 값 → 그대로·이벤트 없음.
      const t1 = '2026-11-13T09:00:00.123456+09:00';
      const memSeen = await put(rsUrl, { token: member.token, ct: J, body: upTo(t1) });
      expect(memSeen).toEqual({ status: 200, code: undefined, seenAt: '2026-11-13T00:00:00.123Z' });
      expect(await put(tsUrl, { token: member.token, ct: J, body: upTo(t1) })).toEqual(memSeen);
      expect(await put(rsUrl, { token: member.token, ct: J, body: upTo('2026-11-12T00:00:00Z') })).toEqual(memSeen);
      // 미래는 지금으로 자른다.
      const before = Date.now();
      const fut = await put(rsUrl, { token: member.token, ct: J, body: upTo('2999-01-01T00:00:00Z') });
      expect(fut.status).toBe(200);
      expect(Date.parse(fut.seenAt!)).toBeGreaterThanOrEqual(before - 5_000);
      expect(Date.parse(fut.seenAt!)).toBeLessThanOrEqual(Date.now());
      const tsFut = await put(tsUrl, { token: member.token, ct: J, body: upTo('2999-01-01T00:00:00Z') });
      expect(Date.parse(tsFut.seenAt!)).toBeGreaterThanOrEqual(Date.parse(fut.seenAt!));
      // Rust 가 올린 두 번(처음·미래)만 버스로 건너온다 — 바뀌지 않은 PUT 은 이벤트가 없다.
      const deadline = Date.now() + 10_000;
      const mine = () => busEvents.filter((e) => e.type === 'inbox.updated' && (e as { accountId?: string }).accountId === member.accountId);
      while (mine().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
      expect(mine().length, JSON.stringify(busEvents)).toBe(2);

      // S5.2 P4a — 설정·스킬 쓰기. 거절은 두 구현의 상태·코드를 견주고(문구는 zod 와 다르다), 성공은 Rust 로 쓰고 TS 로 다시 읽어
      // 본문이 같은지 본다(같은 줄을 두 번 쓸 수 없는 것들이라).
      const call = async (base: string, method: string, path: string, o: { token?: string; ct?: string; body?: string } = {}) => {
        const headers: Record<string, string> = {};
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        if (o.ct) headers['content-type'] = o.ct;
        const res = await fetch(`${base}${path}`, { method, headers, body: o.body });
        const text = await res.text();
        const json = text ? JSON.parse(text) as Record<string, unknown> : {};
        return { status: res.status, code: (json.error as { code?: string } | undefined)?.code, json };
      };
      const A = admin.token;
      for (const [name, m, path, o] of [
        ['defaults 멤버 → 403', 'PUT', '/settings/agent-defaults', { token: member.token, ct: J, body: '{}' }],
        ['defaults 익명·깨진 json → 400(본문 먼저)', 'PUT', '/settings/agent-defaults', { ct: J, body: '{' }],
        ['defaults 모르는 harness → 400', 'PUT', '/settings/agent-defaults', { token: A, ct: J, body: JSON.stringify({ harness: 'nope' }) }],
        ['defaults harness null → 400', 'PUT', '/settings/agent-defaults', { token: A, ct: J, body: JSON.stringify({ harness: null }) }],
        ['defaults 본문 없음 → 400', 'PUT', '/settings/agent-defaults', { token: A }],
        ['policy 0 → 400', 'PUT', '/settings/mention-policy', { token: A, ct: J, body: '{"chainLimit":0}' }],
        ['policy 소수 → 400', 'PUT', '/settings/mention-policy', { token: A, ct: J, body: '{"chainLimit":1.5}' }],
        ['policy 멤버 → 403', 'PUT', '/settings/mention-policy', { token: member.token, ct: J, body: '{"chainLimit":5}' }],
        ['usage 사람 → 400 invalid_account', 'POST', '/skills/usage', { token: member.token, ct: J, body: '{"slugs":[]}' }],
        ['usage 모르는 키 → 400', 'POST', '/skills/usage', { token: agent.pat, ct: J, body: '{"slugs":[],"x":1}' }],
        ['usage 익명 → 401', 'POST', '/skills/usage', { ct: J, body: '{"slugs":[]}' }],
        ['approve 멤버 → 403', 'POST', '/skills/pending-one/approve', { token: member.token }],
        ['approve 없음 → 404', 'POST', '/skills/no-such-skill/approve', { token: A }],
        ['approve 이미 → 409', 'POST', '/skills/fresh-one/approve', { token: A }],
        ['disable 이미 → 409', 'DELETE', '/skills/off-one', { token: A }],
        ['disable 없음 → 404', 'DELETE', '/skills/no-such-skill', { token: A }],
      ] as const) {
        const [a, b] = [await call(tsUrl, m, path, o), await call(rsUrl, m, path, o)];
        expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
      }
      const auditBefore = Number((await db.pool.query<{ n: string }>('select coalesce(max(id), 0)::text as n from audit_log')).rows[0]!.n);
      const defs = await call(rsUrl, 'PUT', '/settings/agent-defaults', { token: A, ct: J, body: JSON.stringify({ model: null, effort: 'low' }) });
      expect(defs.json).toEqual({ harness: 'codex', model: null, effort: 'low' });
      expect((await call(tsUrl, 'GET', '/settings/agent-defaults', { token: A })).json).toEqual(defs.json);
      const pol = await call(rsUrl, 'PUT', '/settings/mention-policy', { token: A, ct: J, body: '{"chainLimit":20}' });
      expect(pol.json).toEqual({ chainLimit: 20 });
      expect((await call(tsUrl, 'GET', '/settings/mention-policy', { token: A })).json).toEqual(pol.json);
      const audits = (await db.pool.query<{ action: string; actor_id: string; detail: unknown }>(
        'select action, actor_id::text, detail from audit_log where id > $1 order by id', [auditBefore])).rows;
      expect(audits).toEqual([
        { action: 'agent.defaults.updated', actor_id: admin.accountId, detail: { before: { harness: 'codex', model: 'm-1', effort: 'high' }, after: defs.json } },
        { action: 'mention.policy.updated', actor_id: admin.accountId, detail: { before: { chainLimit: 12 }, after: { chainLimit: 20 } } },
      ]);
      // trust-proxy — 같은 X-Forwarded-For 를 두 서버에 보내면 감사 `ip` 가 같아야 한다. 맨 왼쪽(클라이언트가 마음대로 쓰는 칸)은
      // 믿지 않는다: 소켓(루프백)만 믿고 그 바로 바깥 값에서 멈춘다.
      for (const [xff, want] of [['203.0.113.7', '203.0.113.7'], ['6.6.6.6, 203.0.113.7', '203.0.113.7'], [undefined, null]] as const) {
        const got: (string | null)[] = [];
        for (const [base, n] of [[rsUrl, 31], [tsUrl, 32]] as const) {
          const headers: Record<string, string> = { authorization: `Bearer ${A}`, 'content-type': J };
          if (xff) headers['x-forwarded-for'] = xff;
          const res = await fetch(`${base}/settings/mention-policy`, { method: 'PUT', headers, body: JSON.stringify({ chainLimit: n }) });
          expect(res.status).toBe(200);
          const row = await db.pool.query<{ ip: string | null }>(
            `select ip from audit_log where action = 'mention.policy.updated' order by id desc limit 1`);
          got.push(row.rows[0]!.ip);
        }
        expect(got[0], `XFF ${xff ?? '(없음)'}: Rust 와 TS 의 감사 ip`).toEqual(got[1]);
        if (want) expect(got[0]).toBe(want);
        else expect(got[0], 'XFF 가 없으면 소켓 주소(루프백)').toMatch(/127\.0\.0\.1|::1/);
      }
      for (const [m, path, slug, ty] of [
        ['POST', '/skills/pending-one/approve', 'pending-one', 'skill.approved'],
        ['DELETE', '/skills/stale-one', 'stale-one', 'skill.disabled'],
      ] as const) {
        const r = await call(rsUrl, m, path, { token: A });
        expect(r.status, path).toBe(200);
        expect((await call(tsUrl, 'GET', `/skills/${slug}`, { token: A })).json, path).toEqual(r.json);
        const until = Date.now() + 10_000;
        const seen = () => busEvents.find((e) => e.type === ty && (e as { skill?: { slug?: string } }).skill?.slug === slug);
        while (!seen() && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
        expect(seen(), `${ty} 이벤트가 버스로 와야 한다`).toBeTruthy();
      }
      const usageBody = JSON.stringify({ slugs: ['fresh-one', 'pending-one', 'off-one', 'harkroom-probe', 'BAD', 'fresh-one'] });
      const [uRs, uTs] = [
        await call(rsUrl, 'POST', '/skills/usage', { token: agent.pat, ct: J, body: usageBody }),
        await call(tsUrl, 'POST', '/skills/usage', { token: agent.pat, ct: J, body: usageBody }),
      ];
      expect(uRs.status).toBe(200);
      expect(uRs.json).toEqual(uTs.json);
      expect(new Set((uRs.json as { recorded: string[] }).recorded)).toEqual(new Set(['fresh-one', 'pending-one', 'harkroom-probe']));

      // S5.2 P4b — 팀·집합 쓰기. 거절은 두 구현의 상태·코드를 견주고(바꾸지 않는 요청만), 성공은 Rust 로 쓰고 TS 로 다시 읽는다.
      // 성공 요청은 X-Forwarded-For 를 실어 감사 ip 가 trust-proxy 규칙으로 채워지는지도 본다.
      const XFF = '203.0.113.9';
      const callX = async (base: string, method: string, path: string, body?: unknown, token = A) => {
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-forwarded-for': XFF };
        if (body !== undefined) headers['content-type'] = J;
        const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        const json = text ? JSON.parse(text) as Record<string, unknown> : {};
        return { status: res.status, code: (json.error as { code?: string } | undefined)?.code, json };
      };
      const ghost = '00000000-0000-4000-8000-000000000999';
      for (const [name, m, path, body, token] of [
        ['팀 만들기 잘못된 이름 → 400', 'POST', '/teams', { name: 'a' }, A],
        ['팀 만들기 멤버·잘못된 이름', 'POST', '/teams', { name: 'a' }, member.token],
        ['팀 만들기 이미 있는 팀 → 400', 'POST', '/teams', { name: 'SQUAD' }, A],
        ['팀 만들기 계정 이름 → 400', 'POST', '/teams', { name: 'mem' }, A],
        ['팀 이름 바꾸기 잘못된 이름 → 400', 'PATCH', `/teams/${squadId}`, { name: 'deleted-x' }, A],
        ['팀 이름 바꾸기 없는 팀 → 404', 'PATCH', `/teams/${ghost}`, { name: 'zzz' }, A],
        ['팀 이름 바꾸기 남의 팀 → 403', 'PATCH', `/teams/${squadId}`, { name: 'zzz' }, member.token],
        ['팀 범위 모르는 값 → 400', 'PUT', `/teams/${squadId}/scope`, { invokeScope: 'all' }, A],
        ['팀 범위 owner 인데 소유자 없음 → 400', 'PUT', `/teams/${squadId}/scope`, { invokeScope: 'owner', ownerAccountId: null }, A],
        ['팀장 키 없음 → 400', 'PUT', `/teams/${squadId}/lead`, {}, A],
        ['팀장 팀원 아님 → 400', 'PUT', `/teams/${squadId}/lead`, { accountId: member.accountId }, A],
        ['팀원 사람 → 400', 'PUT', `/teams/${squadId}/members/${member.accountId}`, undefined, A],
        ['팀원 없는 계정 → 404', 'PUT', `/teams/${squadId}/members/${ghost}`, undefined, A],
        ['호출 허용 없는 팀 → 404', 'PUT', `/teams/${ghost}/invokers/${member.accountId}`, undefined, A],
        ['호출 허용 없는 계정 → 404', 'PUT', `/teams/${squadId}/invokers/${ghost}`, undefined, A],
        ['팀 지우기 없는 팀 → 404', 'DELETE', `/teams/${ghost}`, undefined, A],
        ['집합 만들기 잘못된 본문', 'POST', '/handle-groups', { handle: 'x' }, member.token],
        ['집합 만들기 이미 있는 집합 → 400', 'POST', '/handle-groups', { handle: 'CREW', displayName: 'x' }, A],
        ['집합 만들기 계정 이름 → 400', 'POST', '/handle-groups', { handle: 'mem', displayName: 'x' }, A],
        ['집합 이름 빈 값 → 400', 'PATCH', `/handle-groups/${crewId}`, { displayName: '' }, A],
        ['집합 구성원 빈 배열 → 400', 'POST', `/handle-groups/${crewId}/members`, { accountIds: [] }, A],
        ['집합 구성원 에이전트 → 400', 'POST', `/handle-groups/${crewId}/members`, { accountIds: [agent.accountId] }, A],
        ['집합 구성원 없는 집합 → 404', 'DELETE', `/handle-groups/${ghost}/members`, { accountIds: [member.accountId] }, A],
        ['집합 지우기 없는 집합 → 404', 'DELETE', `/handle-groups/${ghost}`, undefined, A],
      ] as const) {
        const [a, b] = [await callX(tsUrl, m, path, body, token), await callX(rsUrl, m, path, body, token)];
        expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
      }
      const auditMark = Number((await db.pool.query<{ n: string }>('select coalesce(max(id), 0)::text as n from audit_log')).rows[0]!.n);
      const tsTeam = async (id: string) => (await callX(tsUrl, 'GET', `/teams/${id}`)).json as { team: Record<string, unknown>; members: { accountId: string }[]; invokers: string[] };
      const made = await callX(rsUrl, 'POST', '/teams', { name: 'rteam' });
      expect(made.status).toBe(201);
      const rteam = String(made.json.id);
      expect((await tsTeam(rteam)).team).toEqual(made.json);
      const renamed = await callX(rsUrl, 'PATCH', `/teams/${rteam}`, { name: 'rteam2' });
      expect(renamed.json.name).toBe('rteam2');
      expect((await tsTeam(rteam)).team).toEqual(renamed.json);
      const mem = await callX(rsUrl, 'PUT', `/teams/${rteam}/members/${bot2.accountId}`);
      expect(mem.json).toEqual({ members: (await tsTeam(rteam)).members });
      const lead = await callX(rsUrl, 'PUT', `/teams/${rteam}/lead`, { accountId: bot2.accountId });
      expect(lead.json.leadAccountId).toBe(bot2.accountId);
      expect((await tsTeam(rteam)).team).toEqual(lead.json);
      expect((await callX(rsUrl, 'PUT', `/teams/${rteam}/scope`, { invokeScope: 'list' })).json.invokeScope).toBe('list');
      expect((await callX(rsUrl, 'PUT', `/teams/${rteam}/invokers/${member.accountId}`)).json).toEqual({ invokers: [member.accountId] });
      expect((await callX(rsUrl, 'DELETE', `/teams/${rteam}/invokers/${member.accountId}`)).json).toEqual({ invokers: [] });
      // 팀원이 남은 채로 지운다 — 구성원 줄은 FK cascade 가 지운다(쓰기 역할의 DELETE 와 상관없이).
      expect((await callX(rsUrl, 'DELETE', `/teams/${rteam}`)).status).toBe(204);
      expect((await callX(tsUrl, 'GET', `/teams/${rteam}`)).status).toBe(404);
      expect((await db.pool.query('select 1 from agent_team_member where team_id = $1', [rteam])).rowCount).toBe(0);
      const grp = await callX(rsUrl, 'POST', '/handle-groups', { handle: 'rgroup', displayName: 'R' });
      expect(grp.status).toBe(201);
      const rgroup = String(grp.json.id);
      const tsGroup = async () => (await callX(tsUrl, 'GET', `/handle-groups/${rgroup}`)).json as { group: Record<string, unknown>; members: string[] };
      expect((await tsGroup()).group).toEqual(grp.json);
      expect((await callX(rsUrl, 'POST', `/handle-groups/${rgroup}/members`, { accountIds: [member.accountId, member2.accountId] })).json)
        .toEqual({ members: (await tsGroup()).members });
      expect((await callX(rsUrl, 'DELETE', `/handle-groups/${rgroup}/members`, { accountIds: [member2.accountId] })).json).toEqual({ members: [member.accountId] });
      const regrp = await callX(rsUrl, 'PATCH', `/handle-groups/${rgroup}`, { displayName: 'R2' });
      expect((await tsGroup()).group).toEqual(regrp.json);
      expect((await callX(rsUrl, 'DELETE', `/handle-groups/${rgroup}`)).status).toBe(204);
      expect((await db.pool.query('select 1 from handle_group_member where group_id = $1', [rgroup])).rowCount).toBe(0);
      const teamAudits = (await db.pool.query<{ action: string; ip: string | null; actor_id: string }>(
        `select action, ip, actor_id::text from audit_log where id > $1 and (action like 'team.%' or action like 'handle_group.%') order by id`, [auditMark])).rows;
      expect(teamAudits.map((r) => r.action)).toEqual([
        'team.created', 'team.updated', 'team.member.added', 'team.lead.set', 'team.scope.set',
        'team.invoker.added', 'team.invoker.removed', 'team.deleted',
        'handle_group.created', 'handle_group.members.added', 'handle_group.members.removed', 'handle_group.updated', 'handle_group.deleted',
      ]);
      expect(new Set(teamAudits.map((r) => r.ip)), '감사 ip 가 trust-proxy 규칙으로 채워진다').toEqual(new Set([XFF]));
      expect(new Set(teamAudits.map((r) => r.actor_id))).toEqual(new Set([admin.accountId]));
      const until3 = Date.now() + 10_000;
      const evs = () => busEvents.filter((e) => (e.type === 'agent_team.changed' && (e as { teamId?: string }).teamId === rteam)
        || (e.type === 'handle_group.changed' && (e as { groupId?: string }).groupId === rgroup));
      while (evs().length < 13 && Date.now() < until3) await new Promise((res) => setTimeout(res, 100));
      expect(evs().length, '쓴 만큼 이벤트가 버스로 온다').toBe(13);

      // S5.2 P4c — 신고 해결·차단(+ 그 읽기 둘). 신고 올리기는 TS 에 남는다(프로세스 메모리 상한).
      const msgs = (await db.pool.query<{ id: string }>(
        `select id::text from message where deleted_at is null and author_id <> $1 order by created_at, id limit 3`, [member.accountId])).rows.map((r) => r.id);
      expect(msgs.length).toBe(3);
      for (const [i, mid] of msgs.entries()) {
        await db.pool.query(
          `insert into message_report (message_id, reporter_id, reason, note, body_snapshot, created_at, resolved_at, resolved_by, resolution)
           select $1, $2, $3, $4, m.body, now() - make_interval(mins => $5), case when $6 then now() end, case when $6 then $7::uuid end, case when $6 then 'dismissed' end
             from message m where m.id = $1`,
          [mid, member.accountId, ['spam', 'abuse', 'other'][i], i === 1 ? '메모' : null, 30 - i, i === 2, admin.accountId]);
      }
      const reportIds = (await db.pool.query<{ id: string }>('select id::text from message_report order by created_at, id')).rows.map((r) => r.id);
      const page1 = await callX(tsUrl, 'GET', '/admin/reports?status=all&limit=1');
      for (const path of [
        '/admin/reports', '/admin/reports?status=all', '/admin/reports?status=resolved', '/admin/reports?status=all&limit=1',
        `/admin/reports?status=all&after=${String(page1.json.nextAfter)}`, '/admin/reports?status=closed', '/admin/reports?after=nope',
        '/admin/reports?limit=0', '/accounts/me/blocks',
      ]) {
        const [a, b] = [await callX(tsUrl, 'GET', path), await callX(rsUrl, 'GET', path)];
        expect({ status: b.status, json: b.status === 400 ? b.code : b.json }, path)
          .toEqual({ status: a.status, json: a.status === 400 ? a.code : a.json });
      }
      expect((await callX(rsUrl, 'GET', '/admin/reports', undefined, member.token)).status).toBe(403);
      const openReport = reportIds[0]!;
      for (const [name, m, path, body, token] of [
        ['해결 멤버 → 403', 'POST', `/admin/reports/${openReport}/resolve`, { resolution: 'removed' }, member.token],
        ['해결 모르는 처리 → 400', 'POST', `/admin/reports/${openReport}/resolve`, { resolution: 'deleted' }, A],
        ['해결 없는 신고 → 404', 'POST', `/admin/reports/${ghost}/resolve`, { resolution: 'removed' }, A],
        ['해결 이미 처리됨 → 404', 'POST', `/admin/reports/${reportIds[2]!}/resolve`, { resolution: 'removed' }, A],
        ['해결 uuid 아님 → 400', 'POST', '/admin/reports/nope/resolve', { resolution: 'removed' }, A],
        ['차단 에이전트 → 403', 'PUT', `/accounts/me/blocks/${member2.accountId}`, undefined, agent.pat],
        ['차단 자기 자신 → 400', 'PUT', `/accounts/me/blocks/${member.accountId}`, undefined, member.token],
        ['차단 없는 계정 → 404', 'PUT', `/accounts/me/blocks/${ghost}`, undefined, member.token],
        ['차단 uuid 아님 → 400', 'PUT', '/accounts/me/blocks/nope', undefined, member.token],
        ['차단 풀기 익명 → 401', 'DELETE', `/accounts/me/blocks/${member2.accountId}`, undefined, ''],
      ] as const) {
        const [a, b] = [await callX(tsUrl, m, path, body, token), await callX(rsUrl, m, path, body, token)];
        expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
      }
      const modMark = Number((await db.pool.query<{ n: string }>('select coalesce(max(id), 0)::text as n from audit_log')).rows[0]!.n);
      expect((await callX(rsUrl, 'POST', `/admin/reports/${openReport}/resolve`, { resolution: 'removed' })).status).toBe(204);
      const resolved = ((await callX(tsUrl, 'GET', '/admin/reports?status=resolved')).json.reports as Record<string, unknown>[])
        .find((r) => r.id === openReport);
      expect(resolved).toMatchObject({ resolution: 'removed', resolvedBy: admin.accountId });
      expect((await callX(tsUrl, 'POST', `/admin/reports/${openReport}/resolve`, { resolution: 'removed' })).status, '두 번 처리되지 않는다').toBe(404);
      const modAudit = (await db.pool.query<{ action: string; ip: string | null; detail: Record<string, unknown> }>(
        `select action, ip, detail from audit_log where id > $1 and action = 'message.report.resolved'`, [modMark])).rows;
      expect(modAudit).toEqual([{ action: 'message.report.resolved', ip: XFF, detail: { resolution: 'removed', messageId: msgs[0] } }]);
      expect((await callX(rsUrl, 'PUT', `/accounts/me/blocks/${member2.accountId}`, undefined, member.token)).status).toBe(204);
      expect((await callX(rsUrl, 'PUT', `/accounts/me/blocks/${member2.accountId}`, undefined, member.token)).status, '다시 막아도 204').toBe(204);
      const tsBlocks = await callX(tsUrl, 'GET', '/accounts/me/blocks', undefined, member.token);
      expect((tsBlocks.json.blocks as { accountId: string }[]).map((b) => b.accountId)).toEqual([member2.accountId]);
      expect((await callX(rsUrl, 'GET', '/accounts/me/blocks', undefined, member.token)).json).toEqual(tsBlocks.json);
      expect((await callX(rsUrl, 'DELETE', `/accounts/me/blocks/${member2.accountId}`, undefined, member.token)).status).toBe(204);
      expect((await callX(tsUrl, 'GET', '/accounts/me/blocks', undefined, member.token)).json).toEqual({ blocks: [] });

      // S5.2 P4c-2 — 작업 항목(읽기·지우기)·스레드 임대·푸시 기기. 작업 항목 쓰기(PUT)는 TS 에 남아 픽스처를 TS 로 만든다.
      const wi = async (token: string, key: string, threadRootId: string | null = null) => (await callX(tsUrl, 'PUT', '/work-items',
        { source: 'github', externalKey: key, title: `t-${key}`, state: 'mine', url: 'https://example.com/x', threadRootId }, token)).json.item as { id: string };
      const memItem = await wi(member.token, 'm1');
      await wi(member.token, 'm2');
      const adminItem = await wi(A, 'a1');
      for (const [path, token] of [
        ['/work-items', member.token], ['/work-items?source=github', member.token], ['/work-items', A], ['/work-items', agent.pat],
        ['/work-items?source=gitlab', member.token], ['/work-items?threadRootId=nope', member.token],
      ] as const) {
        const [a, b] = [await callX(tsUrl, 'GET', path, undefined, token), await callX(rsUrl, 'GET', path, undefined, token)];
        expect({ status: b.status, json: b.status === 400 ? b.code : b.json }, path).toEqual({ status: a.status, json: a.status === 400 ? a.code : a.json });
      }
      const chan = (await db.pool.query<{ channel_id: string }>('select channel_id::text from message where id = $1', [msgs[0]])).rows[0]!.channel_id;
      const claimBody = (holder: string, extra: Record<string, unknown> = {}) => ({ channelId: chan, threadRootId: msgs[0], holder, ...extra });
      const T64 = 'AB'.repeat(32);
      for (const [name, m, path, body, token] of [
        ['항목 지우기 uuid 아님 → 400', 'DELETE', '/work-items/nope', undefined, member.token],
        ['항목 지우기 없는 것 → 404', 'DELETE', `/work-items/${ghost}`, undefined, member.token],
        ['항목 지우기 남의 보드 → 404', 'DELETE', `/work-items/${adminItem.id}`, undefined, member.token],
        ['항목 지우기 에이전트·스레드 없는 주인 항목 → 404', 'DELETE', `/work-items/${adminItem.id}`, undefined, agent.pat],
        ['임대 사람 → 403', 'POST', '/agent/thread-claims', claimBody('h'), member.token],
        ['임대 본문 없음 → 400', 'POST', '/agent/thread-claims', undefined, agent.pat],
        ['임대 ttl 작음 → 400', 'POST', '/agent/thread-claims', claimBody('h', { ttlSec: 5 }), agent.pat],
        ['임대 놓기 holder 빔 → 400', 'POST', '/agent/thread-claims/release', claimBody(''), agent.pat],
        ['푸시 PAT → 403', 'PUT', '/push/devices', { token: T64, platform: 'ios', env: 'sandbox' }, agent.pat],
        ['푸시 익명 → 401', 'PUT', '/push/devices', { token: T64, platform: 'ios', env: 'sandbox' }, ''],
        ['푸시 잘못된 토큰 → 400', 'PUT', '/push/devices', { token: 'zz', platform: 'ios', env: 'sandbox' }, member.token],
        ['푸시 모르는 키 → 400', 'PUT', '/push/devices', { token: T64, platform: 'ios', env: 'sandbox', x: 1 }, member.token],
        ['푸시 끄기 PAT → 403', 'DELETE', '/push/devices/current', undefined, agent.pat],
      ] as const) {
        const [a, b] = [await callX(tsUrl, m, path, body, token), await callX(rsUrl, m, path, body, token)];
        expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
      }
      // 지우기: Rust 로 지우면 TS 목록에서 빠지고, 주인에게 inbox.updated 가 버스로 온다.
      const inboxBefore = busEvents.filter((e) => e.type === 'inbox.updated' && (e as { accountId?: string }).accountId === member.accountId).length;
      expect((await callX(rsUrl, 'DELETE', `/work-items/${memItem.id}`, undefined, member.token)).status).toBe(204);
      expect(((await callX(tsUrl, 'GET', '/work-items', undefined, member.token)).json.items as { id: string }[]).map((i) => i.id)).not.toContain(memItem.id);
      const until4 = Date.now() + 10_000;
      const inboxNow = () => busEvents.filter((e) => e.type === 'inbox.updated' && (e as { accountId?: string }).accountId === member.accountId).length;
      while (inboxNow() <= inboxBefore && Date.now() < until4) await new Promise((res) => setTimeout(res, 100));
      expect(inboxNow()).toBe(inboxBefore + 1);
      // 임대: 두 서버가 같은 표를 본다 — Rust 가 잡으면 TS 의 다른 holder 는 409, 놓으면 TS 가 잡는다. 409 는 같은 expiresAt 을 싣는다.
      const c1 = await fetch(`${rsUrl}/agent/thread-claims`, { method: 'POST', headers: { authorization: `Bearer ${agent.pat}`, 'content-type': J }, body: JSON.stringify(claimBody('h1', { ttlSec: 60 })) });
      expect(c1.status).toBe(200);
      expect(c1.headers.get('cache-control')).toBe('no-store');
      const c1j = await c1.json() as { claimed: boolean; expiresAt: string };
      expect(c1j.claimed).toBe(true);
      const [tsBusy, rsBusy] = [
        await callX(tsUrl, 'POST', '/agent/thread-claims', claimBody('h2'), agent.pat),
        await callX(rsUrl, 'POST', '/agent/thread-claims', claimBody('h3'), agent.pat),
      ];
      expect(tsBusy).toMatchObject({ status: 409, code: 'thread_claimed' });
      expect(rsBusy.json).toEqual(tsBusy.json);
      expect(tsBusy.json.expiresAt).toBe(c1j.expiresAt);
      expect((await callX(rsUrl, 'POST', '/agent/thread-claims/release', claimBody('h2'), agent.pat)).status, '남의 임대는 안 지운다').toBe(204);
      expect((await callX(tsUrl, 'POST', '/agent/thread-claims', claimBody('h2'), agent.pat)).status).toBe(409);
      expect((await callX(rsUrl, 'POST', '/agent/thread-claims/release', claimBody('h1'), agent.pat)).status).toBe(204);
      expect((await callX(tsUrl, 'POST', '/agent/thread-claims', claimBody('h2'), agent.pat)).status).toBe(200);
      // 푸시: Rust 로 등록 → TS 로 같은 토큰을 다시 등록하면 같은 줄이고 prefs 는 합쳐진다 → Rust 로 끄면 그 세션 줄이 사라진다.
      const reg = await callX(rsUrl, 'PUT', '/push/devices', { token: T64, platform: 'ios', env: 'sandbox', prefs: { preview: true } }, member.token);
      expect(reg.status).toBe(200);
      expect(reg.json).toMatchObject({ platform: 'ios', env: 'sandbox', prefs: { mention: true, dm: true, threadReply: true, ask: true, preview: true, badge: true } });
      expect(reg.json).not.toHaveProperty('token');
      const reg2 = await callX(tsUrl, 'PUT', '/push/devices', { token: T64.toLowerCase(), platform: 'ios', env: 'production', prefs: { dm: false } }, member.token);
      expect(reg2.json.id).toBe(reg.json.id);
      expect(reg2.json.prefs).toEqual({ mention: true, dm: false, threadReply: true, ask: true, preview: true, badge: true });
      expect(reg2.json.createdAt).toBe(reg.json.createdAt);
      expect((await callX(rsUrl, 'DELETE', '/push/devices/current', undefined, member.token)).status).toBe(204);
      expect((await db.pool.query('select 1 from push_device where account_id = $1', [member.accountId])).rowCount).toBe(0);

      // S5.2 P4d — 옮긴 라우트를 지난 요청도 세션을 늘리고 PAT 사용 시각을 남긴다(쓰기 풀로). 읽기 역할로 하면 조용히 실패하던 것.
      await db.pool.query(`update session set expires_at = now() + interval '1 day' where account_id = $1`, [member.accountId]);
      await db.pool.query(`update pat set last_used_at = now() - interval '1 hour' where account_id = $1`, [agent.accountId]);
      for (const token of [member.token, agent.pat]) {
        const res = await fetch(`${rsUrl}/settings/mention-policy`, { headers: { authorization: `Bearer ${token}` } });
        expect(res.status).toBe(200);
      }
      // P4a — 이 기록은 응답 뒤에 돈다(`auth::record`), 잠깐 기다려 본다.
      const recorded = async () => {
        const sess = await db.pool.query<{ left: number }>(
          `select extract(epoch from (max(expires_at) - now()))::int / 86400 as left from session where account_id = $1`, [member.accountId]);
        const used = await db.pool.query<{ fresh: boolean }>(
          `select bool_and(last_used_at > now() - interval '1 minute') as fresh from pat where account_id = $1 and revoked_at is null`, [agent.accountId]);
        return { left: sess.rows[0]!.left, fresh: used.rows[0]!.fresh };
      };
      const until2 = Date.now() + 5_000;
      let rec = await recorded();
      while ((rec.left < 13 || !rec.fresh) && Date.now() < until2) {
        await new Promise((res) => setTimeout(res, 100));
        rec = await recorded();
      }
      expect(rec.left, '세션이 14일로 늘어야 한다').toBeGreaterThanOrEqual(13);
      expect(rec.fresh, 'PAT 사용 시각이 새로 찍혀야 한다').toBe(true);

      // 대조 블록의 이벤트 거르기 — 리액션 이벤트는 요청한 계정 것만 남긴다. TS 의 스레드 상태 watcher 가 뒤에 다는 상태 리액션
      // (`reaction.*`, accountId = 상태 주인 에이전트)은 요청의 쓰기가 아니고, Rust 가 맡은 쪽에서는 outbox(`busEvents`)에 없다.
      const byActor = (actor: string) => (e: WorkspaceEvent) =>
        !/^reaction\./.test(e.type) || (e as { accountId?: string }).accountId === actor;
      // S5.3 C3a-1 — 리액션 쓰기(코어 `msg_react.rs`). 같은 시나리오를 TS 와 Rust 에 **각자의 글**로 돌려 응답·남은 행·이벤트
      // (이름·모양·받는 사람·순서)를 견준다. TS 이벤트는 프로세스 안(`onEvent`), Rust 이벤트는 outbox → 버스(`busEvents`)로 받는다.
      {
        const RX = '/channels/{id}/messages/{messageId}/reactions/{emoji}';
        expect(f.log()).toContain(`"PUT ${RX}"`);
        expect(f.log()).toContain(`"DELETE ${RX}"`);
        expect(f.log()).not.toContain('reaction core off');
        const rxPath = (ch: string, m: string, e: string) => `/channels/${ch}/messages/${m}/reactions/${encodeURIComponent(e)}`;
        const dmId = String(dm.id);
        const wakeMsg = async () => {
          const id = await say('깨움 줄', { author: admin.accountId });
          await db.pool.query(
            `update message set kind = 'wake', meta = jsonb_build_object('kind', 'wake', 'wake', jsonb_build_object('agentId', $2::text)) where id = $1`,
            [id, agent.accountId],
          );
          return id;
        };
        const side = async () => ({
          msg: await say('리액션 받을 글'), wake: await wakeMsg(),
          dmMsg: await say('DM 리액션', { ch: dmId, author: admin.accountId }),
        });
        const T = await side();
        const R = await side();
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const FILL = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚'];
        const run = async (base: string, s: { msg: string; wake: string; dmMsg: string }) => {
          const out: { step: string; status: number; code?: string; json: Record<string, unknown> }[] = [];
          const step = async (name: string, m: string, path: string) => {
            const r = await callX(base, m, path);
            out.push({ step: name, status: r.status, code: r.code, json: r.json });
          };
          await step('PUT 추가', 'PUT', rxPath(todayId, s.msg, '👍'));
          await step('PUT 다시(멱등)', 'PUT', rxPath(todayId, s.msg, '👍'));
          // 서버가 단 상태 리액션은 사람이 같은 것을 누르면 사람 것이 된다(한도에는 그때부터 센다).
          await db.pool.query(`insert into message_reaction (message_id, account_id, emoji, source) values ($1, $2, '⏳', 'status')`, [s.msg, admin.accountId]);
          await step('PUT 상태 리액션 올리기', 'PUT', rxPath(todayId, s.msg, '⏳'));
          for (const e of FILL) await step(`PUT 채우기 ${e}`, 'PUT', rxPath(todayId, s.msg, e));
          await step('PUT 21번째 → 409', 'PUT', rxPath(todayId, s.msg, '🙂'));
          await step('PUT 한도에서 이미 누른 것 → 200', 'PUT', rxPath(todayId, s.msg, '👍'));
          await step('DELETE 사람 리액션', 'DELETE', rxPath(todayId, s.msg, '👍'));
          await db.pool.query(`insert into message_reaction (message_id, account_id, emoji, source) values ($1, $2, '🛑', 'status')`, [s.msg, admin.accountId]);
          await step('DELETE 상태 리액션만 있음 → 204·남음·이벤트 없음', 'DELETE', rxPath(todayId, s.msg, '🛑'));
          await step('DELETE 없는 것 → 204', 'DELETE', rxPath(todayId, s.msg, '🎉'));
          await step('PUT ✅ 깨움 줄', 'PUT', rxPath(todayId, s.wake, '✅'));
          await step('PUT ✅ 깨움 줄 다시(시각 안 덮음)', 'PUT', rxPath(todayId, s.wake, '✅'));
          await step('PUT DM(받는 사람 목록)', 'PUT', rxPath(dmId, s.dmMsg, '👀'));
          await step('DELETE DM', 'DELETE', rxPath(dmId, s.dmMsg, '👀'));
          return out;
        };
        const tsOut = await run(tsUrl, T);
        const rsOut = await run(rsUrl, R);
        expect(rsOut).toEqual(tsOut);
        expect(tsOut.find((o) => o.step === 'PUT 21번째 → 409')?.status).toBe(409);
        // 남은 행 — 이모지·출처가 같아야 한다(상태 🛑 는 남는다).
        const rows = async (ids: string[]) => (await db.pool.query<{ i: number; emoji: string; source: string }>(
          `select array_position($1::uuid[], message_id) as i, emoji, source from message_reaction
            where message_id = any($1::uuid[]) order by 1, emoji, source`, [ids])).rows;
        const tRows = await rows([T.msg, T.wake, T.dmMsg]);
        expect(await rows([R.msg, R.wake, R.dmMsg])).toEqual(tRows);
        expect(tRows.filter((r) => r.i === 1).length, '👍 를 뗀 뒤 19 + 상태 🛑').toBe(20);
        expect(tRows).toContainEqual({ i: 1, emoji: '🛑', source: 'status' });
        expect(tRows).toContainEqual({ i: 1, emoji: '⏳', source: 'user' });
        const checked = async (id: string) => (await db.pool.query<{ c: string | null }>(`select meta->'wake'->>'checkedAt' as c from message where id = $1`, [id])).rows[0]!.c;
        expect(await checked(R.wake)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        expect(await checked(T.wake)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        // 이벤트 — 글 id·계정은 자리표로 바꿔 견준다. message.updated 의 본문은 칸 이름과 깨움 확인 시각만 본다(시각·id 는 다르다).
        const norm = (s: { msg: string; wake: string; dmMsg: string }) => (e: WorkspaceEvent) => {
          const o = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
          const label = (id: unknown) => (id === s.msg ? 'MSG' : id === s.wake ? 'WAKE' : id === s.dmMsg ? 'DM' : null);
          if (o.type === 'message.updated') {
            const m = o.message as Record<string, unknown>;
            const wake = (m.meta as { wake?: { checkedAt?: unknown } }).wake;
            return { type: o.type, audience: o.audience, id: label(m.id), kind: m.kind, keys: Object.keys(m).sort(), checkedAt: typeof wake?.checkedAt };
          }
          return { ...o, messageId: label(o.messageId) };
        };
        // 요청이 낸 쓰기만 — 스레드 상태 리액션(`threadStatus.ts` watcher)은 `message.updated`·상태 이모지 떼기를 듣고 TS 쪽에서 **뒤에**
        // 달며(T 에만 생기고 나는 때가 watcher 에 달렸다), 그 `accountId` 는 상태 주인 에이전트다. 이 시나리오의 리액션은 전부 admin 이 한다.
        const mineOf = (evs: WorkspaceEvent[], s: { msg: string; wake: string; dmMsg: string }) => evs.filter((e) => {
          const o = e as { messageId?: string; message?: { id?: string } };
          const id = o.messageId ?? o.message?.id;
          return (id === s.msg || id === s.wake || id === s.dmMsg) && byActor(admin.accountId)(e);
        }).map(norm(s));
        const want = mineOf(tsEvents, T);
        offTs();
        const until4 = Date.now() + 10_000;
        while (mineOf(busEvents, R).length < want.length && Date.now() < until4) await new Promise((res) => setTimeout(res, 100));
        expect(mineOf(busEvents, R)).toEqual(want);
        // 빈 것끼리 비교하지 않게 — 그리고 상태 🛑 떼기·두 번째 ✅ 는 이벤트가 없다.
        expect(want.map((e) => e.type)).toEqual([
          'reaction.added', 'reaction.added', 'reaction.added', ...FILL.map(() => 'reaction.added'), 'reaction.added',
          'reaction.removed', 'reaction.removed',
          'reaction.added', 'message.updated', 'reaction.added',
          'reaction.added', 'reaction.removed',
        ]);
        expect(want.find((e) => e.type === 'message.updated')).toMatchObject({ id: 'WAKE', kind: 'wake', checkedAt: 'string' });
        expect(want.at(-1)?.audience, 'DM 은 구성원 목록').toEqual(expect.arrayContaining([admin.accountId, member.accountId]));
        expect(want.at(-1)?.audience).toEqual(await audienceFor(db.pool, dmId));
        expect(want[0]?.audience).toEqual(await audienceFor(db.pool, todayId));
        // 거절 — 바꾸지 않는 요청만, 상태·코드를 견준다(문구는 zod 와 다르다).
        const zz = '0f8fad5b-d9cb-469f-a165-70867728950e';
        for (const [name, m, path, token] of [
          ['PUT 이모지 아님 → 400', 'PUT', rxPath(todayId, T.msg, 'abc'), A],
          ['PUT 이모지+글자 → 400', 'PUT', rxPath(todayId, T.msg, '👍a'), A],
          ['PUT 33자 → 400', 'PUT', rxPath(todayId, T.msg, 'a'.repeat(33)), A],
          ['PUT uuid 아님 → 400', 'PUT', rxPath('not-a-uuid', T.msg, '👍'), A],
          ['PUT 비공개 채널 멤버 아님 → 403', 'PUT', rxPath(String(priv.id), secret, '👍'), member.token],
          ['PUT 비공개 채널 admin 도 멤버 아님 → 403', 'PUT', rxPath(String(priv.id), secret, '👍'), A],
          ['DELETE 비공개 채널 멤버 아님 → 403', 'DELETE', rxPath(String(priv.id), secret, '👍'), member.token],
          ['PUT 다른 채널의 글 → 404', 'PUT', rxPath(dmId, T.msg, '👍'), A],
          ['PUT 없는 글 → 404', 'PUT', rxPath(todayId, zz, '👍'), A],
          ['PUT 없는 채널 → 404', 'PUT', rxPath(ghost, T.msg, '👍'), A],
          ['PUT 지운 글 → 404', 'PUT', rxPath(todayId, gone, '👍'), A],
          ['DELETE uuid 아님 → 400', 'DELETE', rxPath(todayId, 'x', '👍'), A],
        ] as const) {
          const [a, b] = [await callX(tsUrl, m, path, undefined, token), await callX(rsUrl, m, path, undefined, token)];
          expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
        }
        for (const m of ['PUT', 'DELETE']) {
          const p = rxPath(todayId, T.msg, '👍');
          const [a, b] = [await fetch(`${tsUrl}${p}`, { method: m }), await fetch(`${rsUrl}${p}`, { method: m })];
          expect(b.status, `${m} 익명 → 401`).toBe(a.status);
        }
        expect((await rows([T.msg])).length, '거절은 행을 바꾸지 않는다').toBe(20);
      }

      // S5.3 C3a-2 — 지우기·「채널에도 보이기」 켜고 끄기(코어 `msg_delete.rs`). 리액션과 같이 TS·Rust 에 **각자의 글**로 같은 시나리오를
      // 돌려 응답(상태·코드·본문 모양)·이벤트(이름·모양·받는 사람·순서)·남은 행·감사를 견준다.
      {
        const DEL = '/channels/{id}/messages/{messageId}';
        const ALSO = `${DEL}/also-in-channel`;
        for (const k of [`DELETE ${DEL}`, `DELETE ${ALSO}`, `PUT ${ALSO}`]) expect(f.log()).toContain(`"${k}"`);
        expect(f.log()).not.toContain('message delete core off');
        const msgPath = (ch: string, m: string) => `/channels/${ch}/messages/${m}`;
        const alsoPath = (ch: string, m: string) => `${msgPath(ch, m)}/also-in-channel`;
        const side = async () => {
          const lone = await say('혼자인 머리', { author: admin.accountId });
          const head = await say('답글 남는 머리', { author: admin.accountId });
          const keep = await say('남는 답글', { root: head, author: member.accountId });
          const head2 = await say('마지막 답글과 사라질 머리', { author: admin.accountId });
          const last = await say('마지막 답글', { root: head2, author: admin.accountId });
          const reply = await say('채널로 올릴 답글', { root: head, author: admin.accountId });
          const memberMsg = await say('멤버 글', { author: member.accountId });
          return { lone, head, keep, head2, last, reply, memberMsg };
        };
        type Side = Awaited<ReturnType<typeof side>>;
        const T = await side();
        const R = await side();
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const labelOf = (sd: Side) => (v: unknown) => {
          for (const [k, id] of Object.entries(sd)) if (v === id) return k.toUpperCase();
          return v;
        };
        // 본문은 모양만 견준다 — id 는 자리표로, 시각은 있음/없음으로, seq 는 수인지만.
        const shape = (sd: Side) => (v: unknown): unknown => {
          const lab = labelOf(sd);
          if (Array.isArray(v)) return v.map(shape(sd));
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
              o[k] = /At$/.test(k) ? (x === null ? null : typeof x) : k === 'seq' ? typeof x : shape(sd)(x);
            }
            return o;
          }
          return lab(v);
        };
        const run = async (base: string, sd: Side) => {
          const out: { step: string; status: number; code?: string; body: unknown }[] = [];
          const step = async (name: string, m: string, path: string, token = A) => {
            const r = await callX(base, m, path, undefined, token);
            out.push({ step: name, status: r.status, code: r.code, body: Object.keys(r.json).length ? shape(sd)(r.json) : null });
          };
          await step('PUT 답글을 채널로', 'PUT', alsoPath(todayId, sd.reply));
          await step('PUT 다시(멱등)', 'PUT', alsoPath(todayId, sd.reply));
          await step('PUT 머리 → 400 not_thread_reply', 'PUT', alsoPath(todayId, sd.lone));
          await step('PUT 남의 답글 → 403', 'PUT', alsoPath(todayId, sd.keep));
          await step('DELETE also 멤버가 남의 것 → 403', 'DELETE', alsoPath(todayId, sd.reply), member.token);
          await step('DELETE also 거두기', 'DELETE', alsoPath(todayId, sd.reply));
          await step('DELETE also 다시(멱등)', 'DELETE', alsoPath(todayId, sd.reply));
          await step('DELETE also admin 이 남의 것', 'DELETE', alsoPath(todayId, sd.keep));
          await step('DELETE 멤버가 남의 글 → 403', 'DELETE', msgPath(todayId, sd.lone), member.token);
          await step('DELETE 혼자인 머리 → 204', 'DELETE', msgPath(todayId, sd.lone));
          await step('DELETE 지운 글 → 404', 'DELETE', msgPath(todayId, sd.lone));
          await step('DELETE 답글 남는 머리 → 200 자리표시자', 'DELETE', msgPath(todayId, sd.head));
          await step('DELETE 머리2 → 200 자리표시자', 'DELETE', msgPath(todayId, sd.head2));
          await step('DELETE 마지막 답글 → 204(머리도 사라짐)', 'DELETE', msgPath(todayId, sd.last));
          await step('DELETE admin 이 멤버 글 → 204', 'DELETE', msgPath(todayId, sd.memberMsg));
          await step('DELETE 지운 머리에 also → 404', 'DELETE', alsoPath(todayId, sd.lone));
          return out;
        };
        const tsOut = await run(tsUrl, T);
        const rsOut = await run(rsUrl, R);
        expect(rsOut).toEqual(tsOut);
        const st = (step: string) => tsOut.find((o) => o.step === step);
        expect(st('DELETE 답글 남는 머리 → 200 자리표시자')?.status).toBe(200);
        expect(st('DELETE 마지막 답글 → 204(머리도 사라짐)')?.status).toBe(204);
        expect((st('PUT 답글을 채널로')?.body as { alsoInChannel?: boolean }).alsoInChannel).toBe(true);
        // 남은 행 — 지운 시각·채널에도 보이기가 같은 자리에 같은 값.
        const rowsOf = async (sd: Side) => (await db.pool.query<{ k: string; deleted: boolean; also: boolean }>(
          `select k, m.deleted_at is not null as deleted, m.also_in_channel as also
             from jsonb_each_text($1::jsonb) j(k, id) join message m on m.id = j.id::uuid order by k`, [JSON.stringify(sd)])).rows;
        expect(await rowsOf(R)).toEqual(await rowsOf(T));
        // 이벤트.
        // 요청이 낸 쓰기만 — 지우기·채널로 올리기가 낸 `message.*` 뒤에 TS watcher 가 다는 상태 리액션은 뺀다(리액션 블록과 같은 까닭).
        const mineOf = (evs: WorkspaceEvent[], sd: Side) => evs.filter((e) => {
          const o = e as { messageId?: string; message?: { id?: string } };
          const id = o.messageId ?? o.message?.id;
          return Object.values(sd).includes(id as string) && byActor(admin.accountId)(e);
        }).map((e) => shape(sd)(JSON.parse(JSON.stringify(e))));
        const want = mineOf(tsEvents, T);
        offTs();
        const until5 = Date.now() + 10_000;
        while (mineOf(busEvents, R).length < want.length && Date.now() < until5) await new Promise((res) => setTimeout(res, 100));
        expect(mineOf(busEvents, R)).toEqual(want);
        expect(want.map((e) => (e as { type: string }).type)).toEqual([
          'message.updated', 'message.updated', 'message.updated', 'message.updated', 'message.updated',
          'message.deleted', 'message.updated', 'message.updated', 'message.deleted', 'message.deleted', 'message.deleted',
        ]);
        // 마지막 답글을 지우면 그 답글 다음에 자리표시자로 서 있던 머리도 `message.deleted`.
        expect(want.slice(-3).map((e) => (e as { messageId?: string }).messageId)).toEqual(['LAST', 'HEAD2', 'MEMBERMSG']);
        // 감사 — 지우기마다 한 줄, 본문 없이 `{ channelId }`.
        const audits = async (sd: Side) => (await db.pool.query<{ t: string; d: unknown }>(
          `select target as t, detail as d from audit_log where action = 'message.deleted' and target = any($1::text[]) order by id`,
          [Object.values(sd)])).rows.map((r) => ({ t: labelOf(sd)(r.t), d: r.d }));
        const tAud = await audits(T);
        expect(await audits(R)).toEqual(tAud);
        expect(tAud.map((a) => a.t)).toEqual(['LONE', 'HEAD', 'HEAD2', 'LAST', 'MEMBERMSG']);
        // 거절 — 바꾸지 않는 요청만, 상태·코드(문구는 zod 와 다르다).
        for (const [name, m, path, token] of [
          ['DELETE uuid 아님 → 400', 'DELETE', msgPath(todayId, 'x'), A],
          ['DELETE also uuid 아님 → 400', 'DELETE', alsoPath('nope', T.reply), A],
          ['PUT also uuid 아님 → 400', 'PUT', alsoPath(todayId, 'x'), A],
          ['DELETE 비공개 채널 멤버 아님 → 403', 'DELETE', msgPath(String(priv.id), secret), member.token],
          ['PUT also 비공개 채널 멤버 아님 → 403', 'PUT', alsoPath(String(priv.id), secret), member.token],
          ['PUT also 보관된 채널 → 403 channel_archived', 'PUT', alsoPath(String(priv.id), secret), A],
          ['DELETE 다른 채널의 글 → 404', 'DELETE', msgPath(String(dm.id), T.keep), A],
          ['DELETE 없는 채널 → 404', 'DELETE', msgPath(ghost, T.keep), A],
          ['PUT also 없는 글 → 404', 'PUT', alsoPath(todayId, ghost), A],
        ] as const) {
          const [a, b] = [await callX(tsUrl, m, path, undefined, token), await callX(rsUrl, m, path, undefined, token)];
          expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
        }
        for (const [m, p] of [['DELETE', msgPath(todayId, T.keep)], ['PUT', alsoPath(todayId, T.keep)], ['DELETE', alsoPath(todayId, T.keep)]] as const) {
          const [a, b] = [await fetch(`${tsUrl}${p}`, { method: m }), await fetch(`${rsUrl}${p}`, { method: m })];
          expect(b.status, `${m} ${p} 익명 → 401`).toBe(a.status);
        }
        expect((await rowsOf(T)).find((r) => r.k === 'keep')?.deleted, '거절은 행을 바꾸지 않는다').toBe(false);
        // 쓰기와 이벤트는 한 트랜잭션 — outbox 넣기가 실패하면 지우기·채널로 올리기·거두기도 되돌아가야 한다(다른 화면에 지운 본문이 남지 않게).
        // 앞단 쓰기 역할의 outbox 권한을 잠시 거두어 이벤트 넣기를 실패시킨다.
        const txMsg = await say('트랜잭션 머리', { author: admin.accountId });
        const txReply = await say('트랜잭션 답글', { root: txMsg, author: admin.accountId });
        await db.pool.query(`revoke insert on event_outbox from ${rw}`);
        try {
          for (const [name, m, path] of [
            ['DELETE 글', 'DELETE', msgPath(todayId, txMsg)],
            ['PUT also', 'PUT', alsoPath(todayId, txReply)],
          ] as const) {
            const r = await callX(rsUrl, m, path);
            expect(r.status, `${name} — 이벤트 실패면 500`).toBe(500);
          }
          await db.pool.query(`update message set also_in_channel = true where id = $1`, [txReply]);
          expect((await callX(rsUrl, 'DELETE', alsoPath(todayId, txReply))).status, 'DELETE also — 이벤트 실패면 500').toBe(500);
        } finally {
          await db.pool.query(`grant insert on event_outbox to ${rw}`);
        }
        const txRows = (await db.pool.query<{ id: string; deleted: boolean; also: boolean }>(
          `select id, deleted_at is not null as deleted, also_in_channel as also from message where id = any($1::uuid[])`,
          [[txMsg, txReply]])).rows;
        expect(txRows.find((r) => r.id === txMsg)?.deleted, '지우기가 되돌아갔다').toBe(false);
        expect(txRows.find((r) => r.id === txReply)?.also, '거두기가 되돌아갔다(앞에서 켜 둔 값 그대로)').toBe(true);
        // 권한을 돌려준 뒤에는 정상으로 지워진다.
        expect((await callX(rsUrl, 'DELETE', msgPath(todayId, txMsg))).status).toBe(200);
      }

      // S5.3 C3a-3c — 글 고치기(코어 `msg_edit.rs`). TS·Rust 에 **각자의 글**로 같은 시나리오를 돌려 응답(상태·코드·헤더·본문 모양)·
      // 이벤트·inbox 행(via_edit)을 견준다. 그다음 고치기 권한이 없는 앞단은 이 줄을 붙이지 않고 TS 로 넘기는지 본다.
      {
        const EDIT = 'PATCH /channels/{id}/messages/{messageId}';
        expect(f.log()).toContain(`"${EDIT}"`);
        expect(f.log()).not.toContain('message edit core off');
        const ePath = (ch: string, m: string) => `/channels/${ch}/messages/${m}`;
        const side = async () => {
          const mine = await say('고칠 글', { author: admin.accountId });
          const old = await say('오래된 글', { author: admin.accountId });
          await db.pool.query(`update message set created_at = now() - interval '25 hours' where id = $1`, [old]);
          const agentMsg = await say('에이전트 글');
          const sys = await say('시스템 글', { author: admin.accountId });
          await db.pool.query(`update message set kind = 'system' where id = $1`, [sys]);
          const gone = await say('지울 글', { author: admin.accountId });
          await db.pool.query(`update message set deleted_at = now() where id = $1`, [gone]);
          return { mine, old, agentMsg, sys, gone };
        };
        type Side = Awaited<ReturnType<typeof side>>;
        const T = await side();
        const R = await side();
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const labelOf = (sd: Side) => (v: unknown) => {
          for (const [k, id] of Object.entries(sd)) if (v === id) return k.toUpperCase();
          return v;
        };
        const shape = (sd: Side) => (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(shape(sd));
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
              o[k] = /At$/.test(k) ? (x === null ? null : typeof x) : k === 'seq' ? typeof x : shape(sd)(x);
            }
            return o;
          }
          return labelOf(sd)(v);
        };
        const edit = async (base: string, path: string, body: unknown, token: string = A) => {
          const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': J };
          const res = await fetch(`${base}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
          const text = await res.text();
          const json = text ? JSON.parse(text) as Record<string, unknown> : {};
          return {
            status: res.status, code: (json.error as { code?: string } | undefined)?.code, json,
            count: res.headers.get('x-harkroom-notified-count'), notified: res.headers.get('x-harkroom-notified'),
            skipped: res.headers.get('x-harkroom-mention-edit-skipped'),
          };
        };
        const run = async (base: string, sd: Side) => {
          const out: unknown[] = [];
          const step = async (name: string, path: string, body: unknown, token?: string) => {
            const r = await edit(base, path, body, token);
            out.push({ step: name, status: r.status, code: r.code, count: r.count, notified: r.notified, skipped: r.skipped, body: r.json.error ? null : shape(sd)(r.json) });
          };
          await step('새 멘션 → 부름', ePath(todayId, sd.mine), { body: '고침 @mem 봐 줘' });
          await step('같은 멘션 다시 → 새로 받은 사람 없음', ePath(todayId, sd.mine), { body: '또 고침 @mem' });
          await step('멘션 뺌', ePath(todayId, sd.mine), { body: '멘션 없음' });
          await step('24h 지난 글에 멘션 → too_old', ePath(todayId, sd.old), { body: '늦은 @mem' });
          await step('에이전트 글 → agent_author', ePath(todayId, sd.agentMsg), { body: '@mem 에이전트가 고침' }, agent.pat);
          await step('남의 글 → 403', ePath(todayId, sd.mine), { body: 'x' }, member.token);
          await step('시스템 글 → 403', ePath(todayId, sd.sys), { body: 'x' });
          await step('지운 글 → 404', ePath(todayId, sd.gone), { body: 'x' });
          await step('빈 본문 → 400', ePath(todayId, sd.mine), { body: '' });
          await step('8001자 → 400', ePath(todayId, sd.mine), { body: 'a'.repeat(8001) });
          await step('본문 없음 → 400', ePath(todayId, sd.mine), {});
          await step('비공개 비멤버 → 403', ePath(String(priv.id), secret), { body: 'x' }, member.token);
          await step('다른 채널 경로 → 404', ePath(String(dm.id), sd.mine), { body: 'x' });
          await step('uuid 아님 → 400', ePath(todayId, 'x'), { body: 'x' });
          return out;
        };
        const tsOut = await run(tsUrl, T);
        const rsOut = await run(rsUrl, R);
        expect(rsOut).toEqual(tsOut);
        const st = (n: string) => (tsOut as { step: string; count: string | null; skipped: string | null }[]).find((o) => o.step === n);
        expect(st('새 멘션 → 부름')?.count, '부름이 실제로 inbox 를 만든다').toBe('1');
        expect(st('24h 지난 글에 멘션 → too_old')?.skipped).toBe('too_old');
        expect(st('에이전트 글 → agent_author')?.skipped).toBe('agent_author');
        const anon = async (base: string) => (await fetch(`${base}${ePath(todayId, T.mine)}`, { method: 'PATCH', headers: { 'content-type': J }, body: '{"body":"x"}' })).status;
        expect(await anon(rsUrl), '익명 → 401').toBe(await anon(tsUrl));
        // inbox 행 — 사유·via_edit 이 같은 자리에.
        const inboxOf = async (sd: Side) => (await db.pool.query<{ k: string; reason: string; via: boolean }>(
          `select k, i.reason, i.via_edit as via from jsonb_each_text($1::jsonb) j(k, id) join inbox i on i.message_id = j.id::uuid order by k, i.id`,
          [JSON.stringify(sd)])).rows;
        const tInbox = await inboxOf(T);
        expect(await inboxOf(R)).toEqual(tInbox);
        expect(tInbox).toContainEqual({ k: 'mine', reason: 'mention', via: true });
        // 이벤트 — 종류·받는 사람.
        const mineOf = (evs: WorkspaceEvent[], sd: Side) => evs.filter((e) => {
          const o = e as { message?: { id?: string } };
          return o.message ? Object.values(sd).includes(o.message.id as string) : false;
        }).map((e) => ({ type: e.type, id: labelOf(sd)((e as { message: { id: string } }).message.id) }));
        const want = mineOf(tsEvents, T);
        offTs();
        const until6 = Date.now() + 10_000;
        while (mineOf(busEvents, R).length < want.length && Date.now() < until6) await new Promise((res) => setTimeout(res, 100));
        expect(mineOf(busEvents, R)).toEqual(want);
        expect(want.length, '고친 글마다 message.updated').toBe(5);
        // 한 트랜잭션 — 호출함 쓰기가 실패하면(앞단 역할의 inbox 넣기 권한을 잠시 거둠) 고치기도 되돌아간다.
        const txEdit = await say('트랜잭션 고치기', { author: admin.accountId });
        await db.pool.query(`revoke insert on inbox from ${rw}`);
        try {
          expect((await edit(rsUrl, ePath(todayId, txEdit), { body: '부름 @mem' })).status, '호출함 쓰기 실패면 500').toBe(500);
        } finally {
          await db.pool.query(`grant insert on inbox to ${rw}`);
        }
        const txRow = (await db.pool.query<{ body: string; edited: boolean }>(
          `select body, edited_at is not null as edited from message where id = $1`, [txEdit])).rows[0]!;
        expect(txRow, '본문·고친 시각이 그대로').toEqual({ body: '트랜잭션 고치기', edited: false });
        // 고치기 권한이 없는 앞단 — 스위치가 rust 여도 이 줄을 붙이지 않고(기동 기록), 같은 요청은 TS 가 답한다.
        await db.pool.query(`revoke update (body, meta, edited_at) on message from ${rw}`);
        // 앞단 둘이 같은 역할로 붙으므로 시험 역할의 연결 한도를 잠시 푼다(이 시험 DB 에서만).
        await db.pool.query(`alter role ${rw} connection limit -1`);
        const port2 = await freePort();
        let front2: ChildProcess | undefined;
        try {
          const f2 = await startFront(bin, {
            UPSTREAM_URL: tsUrl, DATABASE_URL: db.uri, PORT: String(port2), HARKROOM_FRONT_TS_ROUTES: '', DATABASE_WRITE_URL: writeUrl.toString(),
            TRUST_PROXY: TRUST.join(','), CORS_ORIGINS: CORS, HARKROOM_CORE: 'rust',
          });
          front2 = f2.child;
          const until7 = Date.now() + 10_000;
          while (!f2.log().includes('front: rust core routes') && Date.now() < until7) await new Promise((res) => setTimeout(res, 100));
          expect(f2.log()).toContain('message edit core off — missing privileges');
          expect(f2.log()).not.toContain(`"${EDIT}"`);
          const viaFront = await edit(`http://127.0.0.1:${port2}`, ePath(todayId, T.mine), { body: 'TS 가 받는다' });
          expect(viaFront.status, '권한이 없으면 TS 가 받아 200').toBe(200);
          expect((viaFront.json as { body?: string }).body).toBe('TS 가 받는다');
        } finally {
          front2?.kill('SIGTERM');
          await db.pool.query(`grant update (body, meta, edited_at) on message to ${rw}`);
        }
      }

      // S5.3 C3b-1 — 선택 카드 답하기·닫기(코어 `ask.rs`). TS·Rust 에 **각자의 카드**로 같은 시나리오를 돌려 응답·이벤트·inbox 깨움을 견준다.
      // 권한·머지 카드와 종류를 모르는 카드는 Rust 가 판정하지 않고 TS 로 넘긴다 — 결과가 TS 와 같아야 한다.
      {
        const ASKP = '/channels/{id}/messages/{messageId}';
        for (const k of [`POST ${ASKP}/ask-answer`, `POST ${ASKP}/ask-close`]) expect(f.log()).toContain(`"${k}"`);
        expect(f.log()).not.toContain('ask card core off');
        const askMeta = (to: Record<string, unknown>, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
          kind: 'ask', ask: { prompt: '어느 쪽?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to, ...extra }, ...top,
        });
        const H = { kind: 'human' };
        const side = async () => {
          const plain = await say('@admin 카드', { meta: askMeta(H) });
          const toMem = await say('@mem 카드', { meta: askMeta({ kind: 'account', accountId: member.accountId }) });
          const toMem2 = await say('@mem 카드2', { meta: askMeta({ kind: 'account', accountId: member.accountId }) });
          const toAdm = await say('@admin 관리자에게 카드', { meta: askMeta({ kind: 'account', accountId: admin.accountId }) });
          const text = await say('@admin 글로 답할 카드', { meta: askMeta(H) });
          const root = await say('@admin 원본', { meta: askMeta(H) });
          const mirror = await say('@admin 거울', { meta: askMeta(H, { mirrorOf: root }) });
          const closeMe = await say('@admin 닫을 카드', { meta: askMeta(H) });
          const croot = await say('@admin 닫을 원본', { meta: askMeta(H) });
          const cmirror = await say('@admin 닫을 거울', { meta: askMeta(H, { mirrorOf: croot }) });
          const perm = await say('@admin 권한 표지 카드', { meta: askMeta(H, {}, { permissionRequest: { status: 'pending' } }) });
          const merge = await say('@admin 머지 표지 카드', { meta: askMeta(H, {}, { mergeDenial: { repo: 'example/x' } }) });
          const odd = await say('@admin 모르는 종류', { meta: { ...askMeta(H), kind: 'askSomethingNew' } });
          const pmirror = await say('@admin 권한 표지의 거울', { meta: askMeta(H, { mirrorOf: perm }) });
          const notAsk = await say('그냥 글', { author: admin.accountId });
          return { plain, toMem, toMem2, toAdm, text, root, mirror, closeMe, croot, cmirror, perm, merge, odd, pmirror, notAsk };
        };
        type Side = Awaited<ReturnType<typeof side>>;
        const T = await side();
        const R = await side();
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const labelOf = (sd: Side) => (v: unknown) => {
          for (const [k, id] of Object.entries(sd)) if (v === id) return k.toUpperCase();
          return v;
        };
        const shape = (sd: Side) => (v: unknown): unknown => {
          const lab = labelOf(sd);
          if (Array.isArray(v)) return v.map(shape(sd));
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
              o[k] = /At$/.test(k) ? (x === null ? null : typeof x) : k === 'seq' ? typeof x : shape(sd)(x);
            }
            return o;
          }
          return lab(v);
        };
        const ans = (ch: string, m: string) => `/channels/${ch}/messages/${m}/ask-answer`;
        const cls = (ch: string, m: string) => `/channels/${ch}/messages/${m}/ask-close`;
        const run = async (base: string, sd: Side) => {
          const out: { step: string; status: number; code?: string; body: unknown }[] = [];
          const step = async (name: string, path: string, body?: unknown, token = A) => {
            const r = await callX(base, 'POST', path, body ?? {}, token);
            out.push({ step: name, status: r.status, code: r.code, body: r.status === 200 ? shape(sd)(r.json) : null });
          };
          await step('답 a', ans(todayId, sd.plain), { optionId: 'a' });
          await step('다시 b → 409', ans(todayId, sd.plain), { optionId: 'b' });
          await step('없는 선택지 → 400', ans(todayId, sd.toMem), { optionId: 'z' }, member.token);
          await step('남에게 온 카드 → 403', ans(todayId, sd.toMem2), { optionId: 'a' });
          await step('받는 사람이 답', ans(todayId, sd.toMem), { optionId: 'b' }, member.token);
          await step('글로 답', ans(todayId, sd.text), { text: '  직접 쓴 답  ' });
          await step('거울에 답 → 원본에 먼저', ans(todayId, sd.mirror), { optionId: 'b' });
          await step('원본은 이미 정해짐 → 409', ans(todayId, sd.root), { optionId: 'a' });
          await step('닫기', cls(todayId, sd.closeMe));
          await step('다시 닫기(멱등)', cls(todayId, sd.closeMe));
          await step('답한 카드 닫기 → 409', cls(todayId, sd.plain));
          await step('닫은 카드에 늦은 답', ans(todayId, sd.closeMe), { optionId: 'a' });
          await step('거울 닫기 → 원본도', cls(todayId, sd.cmirror));
          await step('남에게 온 카드 닫기 → 403', cls(todayId, sd.toAdm), undefined, member.token);
          await step('권한 표지 카드 → TS', ans(todayId, sd.perm), { optionId: 'a' });
          await step('권한 표지 카드 글 → TS', ans(todayId, sd.perm), { text: 'x' });
          await step('머지 표지 카드 → TS', ans(todayId, sd.merge), { optionId: 'a' });
          await step('알 수 없는 kind → TS', ans(todayId, sd.odd), { optionId: 'a' });
          await step('알 수 없는 kind 닫기 → TS', cls(todayId, sd.odd));
          await step('권한 표지의 거울 → TS', ans(todayId, sd.pmirror), { optionId: 'a' });
          await step('물음 아닌 글 → 404', ans(todayId, sd.notAsk), { optionId: 'a' });
          return out;
        };
        const tsOut = await run(tsUrl, T);
        const rsOut = await run(rsUrl, R);
        expect(rsOut).toEqual(tsOut);
        const st = (step: string) => tsOut.find((o) => o.step === step);
        expect(st('답 a')?.status).toBe(200);
        expect(st('다시 b → 409')?.status).toBe(409);
        expect(st('거울 닫기 → 원본도')?.status).toBe(200);
        // 남은 카드 meta(시각 칸은 있음/없음만).
        const metaOf = async (sd: Side) => (await db.pool.query<{ k: string; ask: unknown }>(
          `select k, m.meta->'ask' as ask from jsonb_each_text($1::jsonb) j(k, id) join message m on m.id = j.id::uuid order by k`,
          [JSON.stringify(sd)])).rows.map((r) => ({ k: r.k, ask: shape(sd)(r.ask) }));
        expect(await metaOf(R)).toEqual(await metaOf(T));
        // 깨움 — 물어본 쪽 inbox 줄(사유·카드).
        const wakes = async (sd: Side) => (await db.pool.query<{ m: string; r: string }>(
          `select message_id::text as m, reason as r from inbox where message_id = any($1::uuid[]) and reason in ('ask_answered', 'ask_closed') order by id`,
          [Object.values(sd)])).rows.map((r) => ({ m: labelOf(sd)(r.m), r: r.r }));
        const tWakes = await wakes(T);
        expect(await wakes(R)).toEqual(tWakes);
        expect(tWakes.length).toBeGreaterThan(0);
        // 이벤트 — 이름·모양·받는 사람·순서(거울 경로의 겹친 `message.updated` 까지).
        // TS 로 넘긴 카드(권한·머지·모르는 종류)의 이벤트는 R 쪽도 TS 프로세스에서 난다 — Rust 가 맡은 카드끼리 견주고,
        // 넘긴 카드는 R 의 이벤트가 TS 쪽(`onEvent`)에만 있고 outbox(`busEvents`)에는 없는 것으로 「TS 가 처리했다」를 본다.
        const HANDED = ['perm', 'merge', 'odd', 'pmirror'] as const;
        const idsOf = (sd: Side, handed: boolean) => Object.entries(sd)
          .filter(([k]) => (HANDED as readonly string[]).includes(k) === handed).map(([, id]) => id);
        const mineOf = (evs: WorkspaceEvent[], sd: Side, handed = false) => evs.filter((e) => {
          const o = e as { messageId?: string; message?: { id?: string } };
          return idsOf(sd, handed).includes((o.messageId ?? o.message?.id) as string);
        }).map((e) => shape(sd)(JSON.parse(JSON.stringify(e))));
        // 스레드 상태 리액션(👀 등, `threadStatus.ts` watcher)은 답·닫기 쓰기가 아니라 그 `message.updated` 를 들은 TS watcher 가 뒤에 단다 —
        // 운영은 outbox → TS 버스의 기본 `emit` 이 `emitEvent` 라 R 쪽 쓰기도 watcher 에 닿는다. 이 시험의 버스는 `busEvents` 로만 받으므로,
        // R 의 쓰기 이벤트를 운영처럼 `emitEvent` 로 넘겨 watcher 가 달게 한다. 쓰기 이벤트와 떼어 따로 견준다(나는 때가 watcher 에 달렸다).
        const isStatus = (e: unknown) => /^reaction\./.test(String((e as { type?: unknown }).type));
        const writes = (evs: unknown[]) => evs.filter((e) => !isStatus(e));
        const statusOf = (evs: unknown[]) => evs.filter(isStatus).map((e) => JSON.stringify(e)).sort();
        const settle = async (ok: () => boolean) => {
          const until = Date.now() + 10_000;
          while (!ok() && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
        };
        const want = writes(mineOf(tsEvents, T));
        await settle(() => mineOf(busEvents, R).length >= want.length);
        expect(mineOf(busEvents, R), 'Rust 가 낸 쓰기 이벤트 = TS').toEqual(want);
        const rIds = idsOf(R, false);
        for (const e of busEvents.filter((x) => {
          const o = x as { messageId?: string; message?: { id?: string } };
          return rIds.includes((o.messageId ?? o.message?.id) as string);
        })) emitEvent(e);
        // T 쪽 watcher 도 디바운스(300ms) 뒤에 단다 — 빈 목록끼리 견주지 않게 T 가 난 뒤, 한 번 더 디바운스만큼 기다려 굳힌다.
        await settle(() => statusOf(mineOf(tsEvents, T)).length > 0);
        await new Promise((res) => setTimeout(res, 1_000));
        expect(statusOf(mineOf(tsEvents, T)).length, '상태 리액션이 빈 목록끼리 비교하면 안 된다').toBeGreaterThan(0);
        await settle(() => statusOf(mineOf(tsEvents, R)).length >= statusOf(mineOf(tsEvents, T)).length);
        expect(statusOf(mineOf(tsEvents, R)), '상태 리액션(TS watcher)도 같다').toEqual(statusOf(mineOf(tsEvents, T)));
        const handedT = writes(mineOf(tsEvents, T, true));
        expect(handedT.length, '머지 표지 카드는 TS 가 답해 이벤트가 난다').toBeGreaterThan(0);
        expect(writes(mineOf(tsEvents, R, true)), '넘긴 카드는 TS 가 처리했다').toEqual(handedT);
        expect(mineOf(busEvents, R, true), '넘긴 카드는 Rust outbox 에 없다').toEqual([]);
        offTs();
        // 거절 — 상태·코드.
        for (const [name, path, body, token] of [
          ['uuid 아님 → 400', ans(todayId, 'x'), { optionId: 'a' }, A],
          ['본문 둘 다 → 400', ans(todayId, T.toMem2), { optionId: 'a', text: 'x' }, A],
          ['본문 비었음 → 400', ans(todayId, T.toMem2), {}, A],
          ['글 공백뿐 → 400', ans(todayId, T.toMem2), { text: '   ' }, A],
          ['비공개 채널 멤버 아님 → 403', ans(String(priv.id), secret), { optionId: 'a' }, member.token],
          ['다른 채널의 글 → 404', ans(String(dm.id), T.toMem2), { optionId: 'a' }, A],
          ['닫기 없는 글 → 404', cls(todayId, ghost), undefined, A],
        ] as const) {
          const [a, b] = [await callX(tsUrl, 'POST', path, body ?? {}, token), await callX(rsUrl, 'POST', path, body ?? {}, token)];
          expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
        }
        // 판정·쓰기·이벤트는 한 트랜잭션 — outbox 넣기가 실패하면 답·닫힘도 되돌아간다.
        const txCard = await say('@admin 트랜잭션 카드', { meta: askMeta(H) });
        await db.pool.query(`revoke insert on event_outbox from ${rw}`);
        try {
          expect((await callX(rsUrl, 'POST', ans(todayId, txCard), { optionId: 'a' })).status, '답 — 이벤트 실패면 500').toBe(500);
          expect((await callX(rsUrl, 'POST', cls(todayId, txCard), {})).status, '닫기 — 이벤트 실패면 500').toBe(500);
        } finally {
          await db.pool.query(`grant insert on event_outbox to ${rw}`);
        }
        const txAsk = (await db.pool.query<{ ask: Record<string, unknown> }>(`select meta->'ask' as ask from message where id = $1`, [txCard])).rows[0]!.ask;
        expect(txAsk.answeredWith ?? null, '답이 되돌아갔다').toBeNull();
        expect(txAsk.closedAt ?? null, '닫힘이 되돌아갔다').toBeNull();
        expect((await callX(rsUrl, 'POST', ans(todayId, txCard), { optionId: 'a' })).status).toBe(200);
        // 카드 쓰기 권한이 없는 앞단 — 스위치가 rust 여도 이 줄을 붙이지 않고(기동 기록), 같은 요청은 TS 가 답한다.
        const lateCard = await say('@admin 둘째 앞단 카드', { meta: askMeta(H) });
        await db.pool.query(`revoke update (meta) on message from ${rw}`);
        // 앞단 둘이 같은 역할로 붙으므로 시험 역할의 연결 한도를 잠시 푼다(이 시험 DB 에서만).
        await db.pool.query(`alter role ${rw} connection limit -1`);
        const port2 = await freePort();
        let front2: ChildProcess | undefined;
        try {
          const f2 = await startFront(bin, {
            UPSTREAM_URL: tsUrl, DATABASE_URL: db.uri, PORT: String(port2), HARKROOM_FRONT_TS_ROUTES: '', DATABASE_WRITE_URL: writeUrl.toString(),
            TRUST_PROXY: TRUST.join(','), CORS_ORIGINS: CORS, HARKROOM_CORE: 'rust',
          });
          front2 = f2.child;
          const until2 = Date.now() + 10_000;
          while (!f2.log().includes('front: rust core routes') && Date.now() < until2) await new Promise((res) => setTimeout(res, 100));
          expect(f2.log()).toContain('ask card core off — missing privileges');
          expect(f2.log()).not.toContain(`"POST ${ASKP}/ask-answer"`);
          // C3b-2a — 묶음 카드 REST 도 같은 잠금이라 함께 빠진다.
          expect(f2.log()).not.toContain(`"POST ${ASKP}/ask-bundle/answer"`);
          const viaFront = await callX(`http://127.0.0.1:${port2}`, 'POST', ans(todayId, lateCard), { optionId: 'b' });
          expect(viaFront.status, '권한이 없으면 TS 가 받아 200').toBe(200);
          expect(((viaFront.json as { meta?: { ask?: { answeredWith?: string } } }).meta?.ask?.answeredWith)).toBe('b');
        } finally {
          front2?.kill('SIGTERM');
          await db.pool.query(`grant update (meta) on message to ${rw}`);
        }
      }
      // S5.3 C3b-2a — 묶음 카드 REST(코어 `ask_bundle.rs`): 한 줄에 답·「추천대로」. TS·Rust 에 **각자의 묶음·원본 카드**로 같은 시나리오를
      // 돌려 응답·원본 meta·깨움·이벤트를 견준다. 권한 줄·모르는 kind 줄·`once` 가 실린 답은 Rust 가 정하지 않고 TS 로 넘긴다 —
      // 줄마다 따로 재는지(같은 묶음 안 평범한 줄은 Rust 가 답한다)도 본다.
      {
        const ASKP = '/channels/{id}/messages/{messageId}';
        for (const k of [`POST ${ASKP}/ask-bundle/answer`, `POST ${ASKP}/ask-bundle/accept-recommended`]) expect(f.log()).toContain(`"${k}"`);
        const H = { kind: 'human' };
        const opts = (rec?: 'a' | 'b') => [{ id: 'a', label: '가', ...(rec === 'a' ? { recommended: true } : {}) }, { id: 'b', label: '나', ...(rec === 'b' ? { recommended: true } : {}) }];
        const card = (body: string, ask: Record<string, unknown>, top: Record<string, unknown> = {}) =>
          say(body, { meta: { kind: 'ask', ask: { prompt: '어느 쪽?', options: opts(), to: H, ...ask }, ...top } });
        const bundleOf = (roots: string[], linkOf: string[] = []) => say('묶음', {
          author: admin.accountId,
          meta: { kind: 'askBundle', askBundle: { items: roots.map((rootId) => ({ rootId, askerId: null, channelId: todayId, threadRootId: null, prompt: '어느 쪽?', options: opts(), ...(linkOf.includes(rootId) ? { link: true } : {}) })) } },
        });
        const side = async () => {
          const plain = await card('묶음 줄 카드', {});
          const plain2 = await card('묶음 줄 카드2', {});
          const toMem = await card('멤버 앞 카드', { to: { kind: 'account', accountId: member.accountId } });
          const perm = await card('권한 표지 카드', {}, { permissionRequest: { status: 'pending' } });
          const odd = await say('모르는 종류', { meta: { kind: 'askSomethingNew', ask: { prompt: 'x', options: opts(), to: H } } });
          // 연쇄 백스톱 카드 — TS 는 평범하게 답하지만(선택지가 곧 서버 결정) Rust 는 그 결정을 정하지 않는다 → 넘긴 길로 TS 가 답해야 한다.
          const backstop = await card('백스톱 카드', {}, { chainBackstop: { agentId: admin.accountId } });
          const src = await card('거울의 원본', {});
          const mirror = await card('거울 카드', { mirrorOf: src });
          const recB = await card('추천 b', { options: opts('b') });
          const deploy = await card('배포할까요', { options: opts('a') });
          const noRec = await card('추천 없음', {});
          const done = await card('이미 답한 카드', { options: opts('a'), answeredWith: 'a', answeredBy: admin.accountId, answeredAt: new Date().toISOString() });
          const mergeCard = await card('머지 표지', { options: opts('a') }, { mergeDenial: { repo: 'example/x' } });
          const linked = await card('링크 줄', { options: opts('a') });
          const recA2 = await card('추천 a 둘째', { options: opts('a') });
          const odd2 = await say('모르는 종류2', { meta: { kind: 'askSomethingNew', ask: { prompt: 'x', options: opts('a'), to: H } } });
          const B1 = await bundleOf([plain, plain2, toMem, perm, odd, mirror]);
          // 백스톱 줄은 따로 — TS 가 답하면 그 묶음의 `message.updated` 도 TS 에서 난다(넘긴 쪽 이벤트로 센다).
          const B4 = await bundleOf([backstop]);
          const B2 = await bundleOf([recB, deploy, noRec, done, mergeCard, linked], [linked]);
          const B3 = await bundleOf([recA2, odd2]);
          return { plain, plain2, toMem, perm, odd, backstop, src, mirror, recB, deploy, noRec, done, mergeCard, linked, recA2, odd2, B1, B2, B3, B4 };
        };
        type Side = Awaited<ReturnType<typeof side>>;
        const T = await side();
        const R = await side();
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const labelOf = (sd: Side) => (v: unknown) => {
          for (const [k, id] of Object.entries(sd)) if (v === id) return k.toUpperCase();
          return v;
        };
        const shape = (sd: Side) => (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(shape(sd));
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
              o[k] = /At$/.test(k) ? (x === null ? null : typeof x) : k === 'seq' ? typeof x : shape(sd)(x);
            }
            return o;
          }
          return labelOf(sd)(v);
        };
        const bAns = (m: string) => `/channels/${todayId}/messages/${m}/ask-bundle/answer`;
        const bAcc = (m: string) => `/channels/${todayId}/messages/${m}/ask-bundle/accept-recommended`;
        const run = async (base: string, sd: Side) => {
          const out: { step: string; status: number; code?: string; body: unknown }[] = [];
          const step = async (name: string, path: string, body: unknown, token = A) => {
            const r = await callX(base, 'POST', path, body, token);
            out.push({ step: name, status: r.status, code: r.code, body: r.status === 200 ? shape(sd)(r.json) : null });
          };
          await step('줄에 답', bAns(sd.B1), { rootId: sd.plain, optionId: 'a' });
          await step('다시 → 409', bAns(sd.B1), { rootId: sd.plain, optionId: 'b' });
          await step('없는 선택지 → 400', bAns(sd.B1), { rootId: sd.plain2, optionId: 'z' });
          await step('묶음에 없는 줄 → 404', bAns(sd.B1), { rootId: sd.recB, optionId: 'a' });
          await step('남에게 온 줄 → 403', bAns(sd.B1), { rootId: sd.toMem, optionId: 'a' });
          await step('거울 줄 → 403', bAns(sd.B1), { rootId: sd.mirror, optionId: 'a' });
          await step('권한 줄 → TS', bAns(sd.B1), { rootId: sd.perm, optionId: 'a' });
          await step('모르는 kind 줄 → TS', bAns(sd.B1), { rootId: sd.odd, optionId: 'a' });
          await step('백스톱 줄 → TS', bAns(sd.B4), { rootId: sd.backstop, optionId: 'a' });
          await step('once 실림 → TS', bAns(sd.B1), { rootId: sd.plain2, optionId: 'a', once: { number: 1, headSha: 'x' } });
          await step('같은 묶음의 평범한 줄은 그대로', bAns(sd.B1), { rootId: sd.plain2, optionId: 'b' });
          await step('묶음 아님 → 404', bAns(sd.plain), { rootId: sd.plain, optionId: 'a' });
          await step('본문 틀림 → 400', bAns(sd.B1), { rootId: 'x', optionId: 'a' });
          await step('비멤버 비공개 → 403', `/channels/${String(priv.id)}/messages/${sd.B1}/ask-bundle/answer`, { rootId: sd.plain, optionId: 'a' }, member.token);
          await step('추천대로', bAcc(sd.B2), {});
          await step('추천대로 다시', bAcc(sd.B2), {});
          await step('넘길 줄이 섞인 추천대로 → TS', bAcc(sd.B3), {});
          await step('추천대로 묶음 아님 → 404', bAcc(sd.recB), {});
          return out;
        };
        const tsOut = await run(tsUrl, T);
        const rsOut = await run(rsUrl, R);
        expect(rsOut).toEqual(tsOut);
        const st = (n: string) => tsOut.find((o) => o.step === n)!;
        expect(st('줄에 답').status).toBe(200);
        expect(st('다시 → 409').status).toBe(409);
        expect((st('추천대로').body as { results: { rootId: string; outcome: string }[] }).results).toEqual([
          { rootId: 'RECB', outcome: 'answered' }, { rootId: 'DEPLOY', outcome: 'skipped_irreversible' },
          { rootId: 'NOREC', outcome: 'skipped_no_recommendation' }, { rootId: 'DONE', outcome: 'resolved' },
          { rootId: 'MERGECARD', outcome: 'skipped_link' }, { rootId: 'LINKED', outcome: 'skipped_link' },
        ]);
        // 원본 meta(시각 칸은 있음/없음만) — 「추천대로」의 답에는 `answeredVia` 가 붙는다.
        const metaOf = async (sd: Side) => (await db.pool.query<{ k: string; ask: unknown }>(
          `select k, m.meta->'ask' as ask from jsonb_each_text($1::jsonb) j(k, id) join message m on m.id = j.id::uuid where k not like 'B%' order by k`,
          [JSON.stringify(sd)])).rows.map((r) => ({ k: r.k, ask: shape(sd)(r.ask) }));
        const tMeta = await metaOf(T);
        expect(await metaOf(R)).toEqual(tMeta);
        expect((tMeta.find((x) => x.k === 'recB')?.ask as { answeredVia?: string }).answeredVia).toBe('bundle_bulk');
        // 깨움 — 물어본 쪽 inbox 줄.
        const wakes = async (sd: Side) => (await db.pool.query<{ m: string; r: string }>(
          `select message_id::text as m, reason as r from inbox where message_id = any($1::uuid[]) and reason in ('ask_answered', 'ask_closed') order by id`,
          [Object.values(sd)])).rows.map((r) => ({ m: labelOf(sd)(r.m), r: r.r }));
        expect(await wakes(R)).toEqual(await wakes(T));
        // 이벤트 — 쓰기(`message.updated`)만, 이름·모양·받는 사람·순서. 넘긴 줄(권한·모르는 kind·once·B3)은 TS 에서 나고 Rust outbox 에 없다.
        const HANDED = ['perm', 'odd', 'backstop', 'recA2', 'odd2', 'B3', 'B4'];
        const writesOf = (evs: WorkspaceEvent[], sd: Side, handed: boolean) => evs.filter((e) => {
          if (e.type !== 'message.updated') return false;
          const id = (e as { message: { id: string } }).message.id;
          return Object.entries(sd).some(([k, v]) => v === id && HANDED.includes(k) === handed);
        }).map((e) => shape(sd)(JSON.parse(JSON.stringify(e))));
        const want = writesOf(tsEvents, T, false);
        expect(want.length, '답한 줄마다 원본·묶음 message.updated').toBeGreaterThan(0);
        const until = Date.now() + 10_000;
        while (writesOf(busEvents, R, false).length < want.length && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
        expect(writesOf(busEvents, R, false), 'Rust 가 낸 쓰기 이벤트 = TS').toEqual(want);
        const handedT = writesOf(tsEvents, T, true);
        expect(handedT.length, '넘긴 줄도 TS 가 답해 이벤트가 난다').toBeGreaterThan(0);
        expect(writesOf(tsEvents, R, true), '넘긴 줄은 TS 가 처리했다').toEqual(handedT);
        expect(writesOf(busEvents, R, true), '넘긴 줄은 Rust outbox 에 없다').toEqual([]);
        offTs();
        // 한 트랜잭션 — outbox 넣기가 실패하면 답이 되돌아간다.
        const txCard = await card('트랜잭션 묶음 줄', {});
        const txB = await bundleOf([txCard]);
        await db.pool.query(`revoke insert on event_outbox from ${rw}`);
        try {
          expect((await callX(rsUrl, 'POST', bAns(txB), { rootId: txCard, optionId: 'a' })).status, '이벤트 실패면 500').toBe(500);
        } finally {
          await db.pool.query(`grant insert on event_outbox to ${rw}`);
        }
        const txAsk = (await db.pool.query<{ ask: Record<string, unknown> }>(`select meta->'ask' as ask from message where id = $1`, [txCard])).rows[0]!.ask;
        expect(txAsk.answeredWith ?? null, '답이 되돌아갔다').toBeNull();
      }
      // S5.3 C1c-1 — 글 올리기 뼈대(코어 `msg_post.rs`). 사람·세션·최상위·DM 아님·부름·URL·승인 낱말·링크 없는 글만 Rust 가 올리고,
      // 나머지는 읽은 바이트 그대로 TS 로 넘긴다. TS·Rust 에 같은 시나리오를 돌려 응답(상태·코드·헤더·본문 모양)과 이벤트를 견주고,
      // 넘긴 글은 그 `message.created` 가 TS 쪽(`onEvent`)에만 있고 Rust outbox(`busEvents`)에는 없는 것으로 「TS 가 올렸다」를 본다.
      {
        const POST = 'POST /channels/{id}/messages';
        expect(f.log()).toContain(`"${POST}"`);
        expect(f.log()).not.toContain('message post core off');
        const mPath = (ch: string) => `/channels/${ch}/messages`;
        const upload = async (who: string, name: string) => (await db.pool.query<{ id: string }>(
          `insert into attachment (uploader_id, filename, content_type, size_bytes, storage_key) values ($1, $2, 'text/plain', 1, $3) returning id`,
          [who, name, `test/${name}-${Math.random().toString(36).slice(2)}`])).rows[0]!.id;
        const side = async (tag: string) => ({
          att1: await upload(admin.accountId, 'a1.txt'),
          att2: await upload(admin.accountId, 'a2.txt'),
          others: await upload(member.accountId, 'm.txt'),
          root: await say(`${tag} 머리`, { author: admin.accountId }),
          key: `c1c1-${tag}-${Date.now()}`,
        });
        type Side = Awaited<ReturnType<typeof side>>;
        const T = await side('t');
        const R = await side('r');
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const shape = (sd: Side) => (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(shape(sd));
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
              o[k] = /At$/.test(k) ? (x === null ? null : typeof x) : k === 'seq' ? typeof x : shape(sd)(x);
            }
            return o;
          }
          if (typeof v !== 'string') return v;
          let out = v;
          for (const [k, id] of Object.entries(sd)) if (k !== 'key') out = out.split(id).join(k.toUpperCase());
          return out.replace(UUID_RE, '<uuid>');
        };
        const send = async (base: string, path: string, body: unknown, token: string = A, key?: string) => {
          const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': J };
          if (key) headers['idempotency-key'] = key;
          const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
          const text = await res.text();
          const json = text ? JSON.parse(text) as Record<string, unknown> : {};
          return { status: res.status, code: (json.error as { code?: string } | undefined)?.code, json, count: res.headers.get('x-harkroom-notified-count') };
        };
        const HANDED = ['TS: 승인 낱말', 'TS: 메시지 링크', 'TS: URL', 'TS: DM', 'TS: 에이전트(PAT)', 'TS: 모델 지정 키'];
        const run = async (base: string, sd: Side) => {
          const out: { step: string; status: number; code?: string; count: string | null; body: unknown; id?: string }[] = [];
          const step = async (name: string, path: string, body: unknown, token?: string, key?: string) => {
            const r = await send(base, path, body, token, key);
            out.push({ step: name, status: r.status, code: r.code, count: r.count, body: r.json.error ? null : shape(sd)(r.json), id: r.json.error ? undefined : r.json.id as string });
          };
          await step('평범한 글', mPath(todayId), { body: '안녕 C1c-1', alsoInChannel: true });
          await step('첨부 둘(고른 순서)', mPath(todayId), { body: '', attachmentIds: [sd.att2, sd.att1] });
          await step('재시도 키 첫 번', mPath(todayId), { body: '한 번만' }, A, sd.key);
          await step('재시도 키 다시 → 재생 200', mPath(todayId), { body: '한 번만' }, A, sd.key);
          await step('남의 첨부 → 400', mPath(todayId), { body: 'x', attachmentIds: [sd.others] });
          await step('이미 붙은 첨부 → 400', mPath(todayId), { body: 'x', attachmentIds: [sd.att1] });
          await step('없는 첨부 → 400', mPath(todayId), { body: 'x', attachmentIds: ['0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b'] });
          await step('빈 본문 → 400', mPath(todayId), { body: '' });
          await step('공백뿐 → 400', mPath(todayId), { body: ' \n　' });
          await step('8001자 → 400', mPath(todayId), { body: 'a'.repeat(8001) });
          await step('첨부 uuid 아님 → 400', mPath(todayId), { body: 'x', attachmentIds: ['x'] });
          await step('alsoInChannel 글자 → 400', mPath(todayId), { body: 'x', alsoInChannel: 'yes' });
          await step('비공개 비멤버 → 403', mPath(String(priv.id)), { body: 'x' }, member.token);
          await step('채널 uuid 아님 → 400', mPath('x'), { body: 'x' });
          await step('TS: 승인 낱말', mPath(todayId), { body: '승인합니다' });
          await step('TS: 메시지 링크', mPath(todayId), { body: `이것 harkroom://message/${sd.root}` });
          await step('TS: URL', mPath(todayId), { body: '자료 https://example.com/a' });
          // C1c-3a 부터 Rust 가 맡는다(자세한 대조는 아래 사람 답글 블록).
          await step('스레드 답글', mPath(todayId), { body: '답글', threadRootId: sd.root });
          await step('TS: DM', mPath(String(dm.id)), { body: 'DM 글' });
          await step('TS: 에이전트(PAT)', mPath(todayId), { body: '에이전트 글' }, agent.pat);
          await step('TS: 모델 지정 키', mPath(todayId), { body: '모델', agentModels: [] });
          return out;
        };
        const tsOut = await run(tsUrl, T);
        const rsOut = await run(rsUrl, R);
        const strip = (o: typeof tsOut) => o.map(({ id: _id, ...rest }) => rest);
        expect(strip(rsOut)).toEqual(strip(tsOut));
        const st = (o: typeof tsOut, n: string) => o.find((x) => x.step === n)!;
        expect(st(tsOut, '평범한 글').status).toBe(201);
        expect(st(tsOut, '평범한 글').count).toBe('0');
        expect(st(tsOut, '재시도 키 다시 → 재생 200').count, '재생은 헤더 없음').toBeNull();
        expect(st(rsOut, '재시도 키 다시 → 재생 200').id, 'Rust 재생도 같은 글').toBe(st(rsOut, '재시도 키 첫 번').id);
        expect(st(tsOut, 'TS: 승인 낱말').status).toBe(201);
        expect((st(tsOut, '첨부 둘(고른 순서)').body as { attachments: { id: string }[] }).attachments.map((a) => a.id).sort()).toEqual(['ATT1', 'ATT2']);
        // 이벤트 — Rust 가 맡은 글은 outbox 에, 넘긴 글은 TS 에서. 모양·받는 사람이 TS 와 같다.
        const created = (evs: WorkspaceEvent[], ids: string[], sd: Side) => evs
          .filter((e) => e.type === 'message.created' && ids.includes((e as { message: { id: string } }).message.id))
          .map((e) => shape(sd)(JSON.parse(JSON.stringify(e))));
        const idsOf = (o: typeof tsOut, handed: boolean) => o.filter((x) => x.status === 201 && HANDED.includes(x.step) === handed).map((x) => x.id!);
        const want = created(tsEvents, idsOf(tsOut, false), T);
        expect(want.length, '맡은 글마다 message.created(C1c-3a 부터 스레드 답글 포함)').toBe(4);
        const until8 = Date.now() + 10_000;
        while (created(busEvents, idsOf(rsOut, false), R).length < want.length && Date.now() < until8) await new Promise((res) => setTimeout(res, 100));
        expect(created(busEvents, idsOf(rsOut, false), R), 'Rust 가 낸 message.created = TS').toEqual(want);
        const handedT = created(tsEvents, idsOf(tsOut, true), T);
        expect(handedT.length, '넘긴 글도 올라갔다').toBe(idsOf(tsOut, true).length);
        expect(created(tsEvents, idsOf(rsOut, true), R), '넘긴 글은 TS 가 올렸다').toEqual(handedT);
        expect(created(busEvents, idsOf(rsOut, true), R), '넘긴 글은 Rust outbox 에 없다').toEqual([]);
        offTs();
        const anon = async (base: string) => (await fetch(`${base}${mPath(todayId)}`, { method: 'POST', headers: { 'content-type': J }, body: '{"body":"x"}' })).status;
        expect(await anon(rsUrl), '익명 → 401').toBe(await anon(tsUrl));
        // 한 트랜잭션 — outbox 넣기가 실패하면 글·첨부·재시도 키가 남지 않는다.
        const txAtt = await upload(admin.accountId, 'tx.txt');
        await db.pool.query(`revoke insert on event_outbox from ${rw}`);
        try {
          expect((await send(rsUrl, mPath(todayId), { body: 'C1c-1 트랜잭션 글', attachmentIds: [txAtt] }, A, 'c1c1-tx')).status, '이벤트 실패면 500').toBe(500);
        } finally {
          await db.pool.query(`grant insert on event_outbox to ${rw}`);
        }
        const left = (await db.pool.query<{ msgs: number; att: string | null; keys: number }>(
          `select (select count(*)::int from message where body = 'C1c-1 트랜잭션 글') as msgs,
                  (select message_id::text from attachment where id = $1) as att,
                  (select count(*)::int from idempotency_key where key = 'c1c1-tx') as keys`, [txAtt])).rows[0];
        expect(left, '글·첨부 잇기·재시도 키 모두 되돌아갔다').toEqual({ msgs: 0, att: null, keys: 0 });
        // 올리기 권한이 없는 앞단 — 스위치가 rust 여도 이 줄을 붙이지 않고(기동 기록), 같은 요청은 TS 가 답한다.
        await db.pool.query(`revoke insert on idempotency_key from ${rw}`);
        await db.pool.query(`alter role ${rw} connection limit -1`);
        const port3 = await freePort();
        let front3: ChildProcess | undefined;
        try {
          const f3 = await startFront(bin, {
            UPSTREAM_URL: tsUrl, DATABASE_URL: db.uri, PORT: String(port3), HARKROOM_FRONT_TS_ROUTES: '', DATABASE_WRITE_URL: writeUrl.toString(),
            TRUST_PROXY: TRUST.join(','), CORS_ORIGINS: CORS, HARKROOM_CORE: 'rust',
          });
          front3 = f3.child;
          const until9 = Date.now() + 10_000;
          while (!f3.log().includes('front: rust core routes') && Date.now() < until9) await new Promise((res) => setTimeout(res, 100));
          expect(f3.log()).toContain('message post core off — missing privileges');
          expect(f3.log()).not.toContain(`"${POST}"`);
          const viaFront = await send(`http://127.0.0.1:${port3}`, mPath(todayId), { body: 'TS 가 올린다' });
          expect(viaFront.status, '권한이 없으면 TS 가 받아 201').toBe(201);
          expect((viaFront.json as { body?: string }).body).toBe('TS 가 올린다');
        } finally {
          front3?.kill('SIGTERM');
          await db.pool.query(`grant insert on idempotency_key to ${rw}`);
        }
      }
      // S5.3 C1c-2a — 사람 새 머리 글의 부름과 위임. 같은 시나리오를 TS·Rust 에 돌려 응답(상태·받은 사람 수·id 헤더)·글(본문·부름 meta)·
      // inbox 행(받은 사람·사유·팀)·위임(주인·맡긴 사람)·`mandate.created` 감사·이벤트(message.created → inbox.updated 차례)를 견준다.
      {
        const mPath = `/channels/${todayId}/messages`;
        const saved = (await db.pool.query<{ id: string; scope: string; ud: boolean; owner: string | null }>(
          `select account_id::text as id, invoke_scope as scope, user_decide as ud, owner_account_id::text as owner from agent_config where account_id = any($1::uuid[])`,
          [[agent.accountId, bot2.accountId]])).rows;
        expect(saved.map((r) => r.owner), '두 에이전트 다 admin 소유').toEqual([admin.accountId, admin.accountId]);
        // bot 은 주인만 부른다(막힌 부름), bot2 는 누구나 부르고 사용 권한자가 정한다(맡긴 사람 위임).
        await db.pool.query(`update agent_config set invoke_scope = 'owner' where account_id = $1`, [agent.accountId]);
        await db.pool.query(`update agent_config set invoke_scope = 'community', user_decide = true where account_id = $1`, [bot2.accountId]);
        const names = new Map<string, string>([[admin.accountId, 'ADMIN'], [member.accountId, 'MEM'], [member2.accountId, 'MEM2'], [agent.accountId, 'BOT'], [bot2.accountId, 'BOT2']]);
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const shape = (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(shape);
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = /At$/.test(k) ? (x === null ? null : typeof x) : k === 'seq' ? typeof x : shape(x);
            return o;
          }
          return typeof v === 'string' ? v.replace(UUID_RE, (id) => names.get(id) ?? '<uuid>') : v;
        };
        const send = async (base: string, body: string, token: string) => {
          const res = await fetch(`${base}${mPath}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': J }, body: JSON.stringify({ body }) });
          const json = await res.json() as Record<string, unknown>;
          return { status: res.status, count: res.headers.get('x-harkroom-notified-count'), ids: shape(res.headers.get('x-harkroom-notified')), id: json.id as string, message: shape(json) };
        };
        const facts = async (id: string) => ({
          inbox: shape((await db.pool.query(`select account_id::text as who, reason, team_id::text as team from inbox where message_id = $1 order by id`, [id])).rows),
          mandate: shape((await db.pool.query(
            `select d.owner_account_id::text as owner, d.delegator_account_id::text as delegator, (d.root_message_id = m.id and d.thread_root_id = m.id) as rooted
               from message m join mandate d on d.id = m.mandate_id where m.id = $1`, [id])).rows),
          audit: shape((await db.pool.query(
            `select g.action, g.actor_id::text as actor, g.detail - 'mandateId' - 'rootMessageId' - 'threadRootId' as detail
               from audit_log g join message m on g.target = m.mandate_id::text where m.id = $1`, [id])).rows),
        });
        const SCENES: [string, string, string][] = [
          ['사람 하나', '@mem 봐 줘', A],
          ['자기 에이전트 → 위임', '@bot 맡아 줘', A],
          ['남의 에이전트(정할 수 있음) → 맡긴 사람 위임', '@bot2 부탁', member.token],
          ['막힌 부름', '@bot 해 줘', member.token],
          ['집합', '@crew 모여', A],
          ['팀', '@squad 같이', A],
          ['@channel', '@channel 공지', A],
          ['없는 이름', '@nobody 여기', A],
        ];
        const run = async (base: string, evs: () => WorkspaceEvent[]) => {
          const out: unknown[] = [];
          for (const [name, body, token] of SCENES) {
            const before = evs().length;
            const r = await send(base, body, token);
            const until = Date.now() + 10_000;
            const mine = () => evs().slice(before).filter((e) =>
              (e.type === 'message.created' && (e as { message: { id: string } }).message.id === r.id) || e.type === 'inbox.updated');
            while (!mine().some((e) => e.type === 'message.created') && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
            await new Promise((res) => setTimeout(res, 200));
            out.push({ name, ...r, id: undefined, ...(await facts(r.id)), events: shape(JSON.parse(JSON.stringify(mine()))) });
          }
          return out;
        };
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const tsOut = await run(tsUrl, () => tsEvents);
        offTs();
        const rsOut = await run(rsUrl, () => busEvents);
        expect(rsOut).toEqual(tsOut);
        // 빈 것끼리 같음으로 통과하지 않게 — 받은 사람·위임·감사가 실제로 있다.
        type Row = { name: string; count: string; inbox: unknown[]; mandate: { delegator: string | null }[]; audit: unknown[]; events: unknown[] };
        const by = (n: string) => (tsOut as Row[]).find((x) => x.name === n)!;
        expect(by('사람 하나').count).toBe('1');
        expect(by('자기 에이전트 → 위임').mandate).toEqual([{ owner: 'ADMIN', delegator: 'ADMIN', rooted: true }]);
        expect(by('자기 에이전트 → 위임').audit.length).toBe(1);
        expect(by('남의 에이전트(정할 수 있음) → 맡긴 사람 위임').mandate).toEqual([{ owner: 'ADMIN', delegator: 'MEM', rooted: true }]);
        expect(by('막힌 부름').count).toBe('0');
        expect(Number(by('집합').count)).toBeGreaterThan(1);
        expect(by('@channel').inbox.length).toBeGreaterThan(1);
        expect(by('사람 하나').events.length, 'message.created + inbox.updated').toBe(2);
        for (const r of saved) await db.pool.query(`update agent_config set invoke_scope = $2, user_decide = $3 where account_id = $1`, [r.id, r.scope, r.ud]);
      }

      // S5.3 C1c-3a — 사람 답글. 머리를 서버마다 새로 세우고(직접 넣거나 그 서버로 올려) 답을 TS·Rust 에 돌려 응답·글·inbox
      // (`thread_reply`)·위임(잇기·키 없는 머리)·감사·이벤트를 견준다. 아직 TS 몫인 스레드(지워진 머리·열린 카드)도 두 쪽이 같다.
      {
        const mPath = `/channels/${todayId}/messages`;
        const saved = (await db.pool.query<{ id: string; scope: string }>(
          `select account_id::text as id, invoke_scope as scope from agent_config where account_id = any($1::uuid[])`,
          [[agent.accountId, bot2.accountId]])).rows;
        await db.pool.query(`update agent_config set invoke_scope = 'owner' where account_id = $1`, [agent.accountId]);
        await db.pool.query(`update agent_config set invoke_scope = 'community' where account_id = $1`, [bot2.accountId]);
        const names = new Map<string, string>([[admin.accountId, 'ADMIN'], [member.accountId, 'MEM'], [member2.accountId, 'MEM2'], [agent.accountId, 'BOT'], [bot2.accountId, 'BOT2']]);
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const shape = (v: unknown): unknown => {
          if (Array.isArray(v)) return v.map(shape);
          if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = /At$/.test(k) ? (x === null ? null : typeof x) : k === 'seq' ? typeof x : shape(x);
            return o;
          }
          return typeof v === 'string' ? v.replace(UUID_RE, (id) => names.get(id) ?? '<uuid>') : v;
        };
        const send = async (base: string, payload: Record<string, unknown>, token: string) => {
          const res = await fetch(`${base}${mPath}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': J }, body: JSON.stringify(payload) });
          const json = await res.json() as Record<string, unknown>;
          return { status: res.status, count: res.headers.get('x-harkroom-notified-count'), ids: shape(res.headers.get('x-harkroom-notified')), id: json.id as string | undefined, message: shape(json) };
        };
        const direct = async (author: string, body: string) => (await db.pool.query<{ id: string }>(
          `insert into message (channel_id, author_id, body, kind) values ($1, $2, $3, 'user') returning id::text as id`, [todayId, author, body])).rows[0]!.id;
        const settle = () => new Promise((res) => setTimeout(res, 300));
        const facts = async (id: string | undefined) => id ? {
          inbox: shape((await db.pool.query(`select account_id::text as who, reason from inbox where message_id = $1 order by id`, [id])).rows),
          mandate: shape((await db.pool.query(
            `select d.owner_account_id::text as owner, d.delegator_account_id::text as delegator, d.root_message_id = m.thread_root_id as on_root,
                    (select r.mandate_id = d.id from message r where r.id = m.thread_root_id) as root_keyed
               from message m join mandate d on d.id = m.mandate_id where m.id = $1`, [id])).rows),
          audit: shape((await db.pool.query(
            `select g.action, g.actor_id::text as actor, g.detail - 'mandateId' - 'rootMessageId' - 'threadRootId' as detail
               from audit_log g join message m on g.target = m.mandate_id::text where m.id = $1`, [id])).rows),
          // C1c-3b — 이 스레드의 깨움이 접혔나(이 답 때문에)·깨었나, 대기 줄 meta 의 닫힌 시각, 깨움 inbox.
          wakes: (await db.pool.query(
            `select w.fired_at is not null as fired, w.canceled_at is not null as canceled, w.canceled_by_message_id is not distinct from $1::uuid as by_reply,
                    m.meta->'wake' ? 'firedAt' as stamped_fired, m.meta->'wake' ? 'canceledAt' as stamped_canceled,
                    (select coalesce(array_agg(i.reason order by i.id), '{}') from inbox i where i.message_id = m.id) as wake_inbox
               from agent_wake w join message m on m.id = w.message_id
              where m.thread_root_id = (select thread_root_id from message where id = $1)`, [id])).rows,
        } : {};
        // 머리 하나와 그 스레드에 BOT2 가 걸어 둔 열린 깨움 하나(보고처 = 그 스레드).
        const withWake = async () => {
          const root = await direct(member.accountId, '질문');
          const w = (await db.pool.query<{ id: string }>(
            `insert into message (channel_id, thread_root_id, author_id, body, kind, meta) values ($1, $2, $3, '다시 볼게', 'user', $4::jsonb) returning id::text as id`,
            [todayId, root, bot2.accountId, JSON.stringify({ wake: { reportTo: { channelId: todayId, threadRootId: root } } })])).rows[0]!.id;
          await db.pool.query(`insert into agent_wake (account_id, channel_id, message_id, wake_at) values ($1, $2, $3, now() + interval '1 hour')`, [bot2.accountId, todayId, w]);
          return root;
        };
        // [이름, 머리 만들기(base → 머리 id), 답 본문(머리 id → payload), 답하는 사람]
        type Scene = [string, (base: string) => Promise<string>, (root: string) => Record<string, unknown>, string, ('ts' | undefined)?];
        const SCENES: Scene[] = [
          ['남의 머리에 답 → thread_reply', async () => direct(member.accountId, '질문'), (r) => ({ body: '답', threadRootId: r }), A],
          ['자기 머리에 답 → 아무도', async () => direct(admin.accountId, '혼잣말'), (r) => ({ body: '덧붙임', threadRootId: r }), A],
          ['에이전트 머리(누구나) → 게이트 통과', async () => direct(bot2.accountId, '보고'), (r) => ({ body: '고마워', threadRootId: r }), member.token],
          ['에이전트 머리(주인만) → 게이트 막힘', async () => direct(agent.accountId, '보고'), (r) => ({ body: '고마워', threadRootId: r }), member.token],
          ['부름 + 머리 주인', async () => direct(member.accountId, '질문'), (r) => ({ body: '@mem2 같이 봐', threadRootId: r }), A],
          ['머리 주인을 부름(한 번만)', async () => direct(member.accountId, '질문'), (r) => ({ body: '@mem 답이야', threadRootId: r }), A],
          ['위임 잇기', async (b) => (await send(b, { body: '@bot 맡아 줘' }, A)).id!, () => ({}), A],
          ['키 없는 머리 → owner_reply 위임', async () => direct(admin.accountId, '계획'), (r) => ({ body: '@bot 이어서', threadRootId: r }), A],
          ['alsoInChannel', async () => direct(member.accountId, '질문'), (r) => ({ body: '채널에도', threadRootId: r, alsoInChannel: true }), A],
          ['열린 깨움 → 지금 깨움', withWake, (r) => ({ body: '다시 봐 줘', threadRootId: r }), A],
          ['열린 깨움 + 부름 → 접음', withWake, (r) => ({ body: '@bot2 지금 봐', threadRootId: r }), A],
          ['없는 머리 → bad_thread', async () => '00000000-0000-4000-8000-000000000000', (r) => ({ body: '답', threadRootId: r }), A],
          ['지워진 머리 → TS 몫', async () => { const id = await direct(member.accountId, '지울 글'); await db.pool.query(`update message set deleted_at = now() where id = $1`, [id]); return id; }, (r) => ({ body: '답', threadRootId: r }), A, 'ts'],
          ['열린 카드 스레드 → TS 몫', async () => { const id = await direct(member.accountId, '물음'); await db.pool.query(
            `insert into message (channel_id, thread_root_id, author_id, body, kind, meta) values ($1, $2, $3, '고를래?', 'user', $4::jsonb)`,
            [todayId, id, bot2.accountId, JSON.stringify({ kind: 'ask', ask: { to: { kind: 'human' }, options: [{ id: 'a', label: 'A' }] } })]); return id; },
          (r) => ({ body: 'A 로', threadRootId: r }), A, 'ts'],
          ['머리 id 가 null → 400', async () => '', () => ({ body: '답', threadRootId: null }), A],
        ];
        // TS 몫 갈래는 Rust 서버에서도 TS 가 올리므로 그 장면의 이벤트는 TS 버스에서 읽는다(Rust outbox 에 없어야 한다).
        const handedOnRust: string[] = [];
        const run = async (base: string, own: () => WorkspaceEvent[], tsBus: () => WorkspaceEvent[]) => {
          const out: unknown[] = [];
          for (const [name, mkRoot, payload, token, side] of SCENES) {
            const evs = side === 'ts' ? tsBus : own;
            const root = await mkRoot(base);
            await settle();
            const p = payload(root);
            const body = Object.keys(p).length ? p : { body: '추가로', threadRootId: root };
            const before = evs().length;
            const busBefore = own().length;
            const r = await send(base, body, token);
            const until = Date.now() + 10_000;
            const mine = () => evs().slice(before).filter((e) =>
              (e.type === 'message.created' && (e as { message: { id: string } }).message.id === r.id) || e.type === 'inbox.updated'
              || e.type === 'thread.reportWakes.changed'
              || (e.type === 'message.updated' && !!(e as { message: { meta?: { wake?: unknown } } }).message.meta?.wake));
            while (r.status === 201 && !mine().some((e) => e.type === 'message.created') && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
            await settle();
            if (side === 'ts' && own !== tsBus && own().slice(busBefore).some((e) => e.type === 'message.created' && (e as { message: { id: string } }).message.id === r.id)) handedOnRust.push(name);
            out.push({ name, ...r, id: undefined, ...(await facts(r.id)), events: shape(JSON.parse(JSON.stringify(mine()))) });
          }
          return out;
        };
        const tsEvents: WorkspaceEvent[] = [];
        const offTs = onEvent((e) => { tsEvents.push(e); });
        const tsGet = () => tsEvents;
        const tsOut = await run(tsUrl, tsGet, tsGet);
        const rsOut = await run(rsUrl, () => busEvents, tsGet);
        offTs();
        expect(rsOut).toEqual(tsOut);
        expect(handedOnRust, 'TS 몫 스레드의 답은 Rust outbox 에 없다').toEqual([]);
        type Row = { name: string; status: number; count: string; inbox: { who: string; reason: string }[]; mandate: unknown[]; audit: { detail: { via: string } }[]; message: { alsoInChannel?: boolean } };
        const by = (n: string) => (tsOut as Row[]).find((x) => x.name === n)!;
        expect(by('남의 머리에 답 → thread_reply').inbox).toEqual([{ who: 'MEM', reason: 'thread_reply' }]);
        expect(by('자기 머리에 답 → 아무도').count).toBe('0');
        expect(by('에이전트 머리(누구나) → 게이트 통과').inbox).toEqual([{ who: 'BOT2', reason: 'thread_reply' }]);
        expect(by('에이전트 머리(주인만) → 게이트 막힘').count).toBe('0');
        expect(by('부름 + 머리 주인').inbox.map((x) => x.reason)).toEqual(['mention', 'thread_reply']);
        expect(by('머리 주인을 부름(한 번만)').inbox).toEqual([{ who: 'MEM', reason: 'mention' }]);
        expect(by('위임 잇기').mandate).toEqual([{ owner: 'ADMIN', delegator: 'ADMIN', on_root: true, root_keyed: true }]);
        expect(by('키 없는 머리 → owner_reply 위임').mandate).toEqual([{ owner: 'ADMIN', delegator: 'ADMIN', on_root: true, root_keyed: true }]);
        expect(by('키 없는 머리 → owner_reply 위임').audit.map((a) => a.detail.via)).toEqual(['owner_reply']);
        expect(by('alsoInChannel').message.alsoInChannel).toBe(true);
        type W = { wakes: Record<string, unknown>[]; events: { type: string }[] };
        const woke = (tsOut as (Row & W)[]).find((x) => x.name === '열린 깨움 → 지금 깨움')!;
        expect(woke.wakes).toEqual([{ fired: true, canceled: false, by_reply: false, stamped_fired: true, stamped_canceled: false, wake_inbox: ['wake'] }]);
        expect(woke.events.map((e) => e.type)).toEqual(['inbox.updated', 'thread.reportWakes.changed', 'message.updated', 'message.created', 'inbox.updated']);
        const folded = (tsOut as (Row & W)[]).find((x) => x.name === '열린 깨움 + 부름 → 접음')!;
        expect(folded.wakes).toEqual([{ fired: false, canceled: true, by_reply: true, stamped_fired: false, stamped_canceled: true, wake_inbox: [] }]);
        expect(by('없는 머리 → bad_thread').status).toBe(400);
        expect(by('지워진 머리 → TS 몫').status).toBe(201);
        expect(by('열린 카드 스레드 → TS 몫').status).toBe(201);
        for (const r of saved) await db.pool.query(`update agent_config set invoke_scope = $2 where account_id = $1`, [r.id, r.scope]);
      }

      // S5.3 C6a-1 — 인박스 읽음 표시(코어 `inbox_read.rs`). 거절은 상태·코드를 견주고, 정상은 TS·Rust 에 각자의 줄로 같은 시나리오를 돌려
      // 남은 행(읽음 여부·내 것만·이미 읽은 시각은 그대로)이 같은지 본다. TS 는 이벤트를 내지 않는다 — Rust 도 내지 않는다.
      {
        expect(f.log()).toContain('"POST /inbox/read"');
        expect(f.log()).not.toContain('inbox read core off');
        const seed = async () => {
          const ids = (await db.pool.query<{ id: string }>(
            `insert into inbox (account_id, message_id, reason)
             select a, $3::uuid, 'mention' from unnest(array[$1::uuid, $1::uuid, $1::uuid, $2::uuid]) a returning id::text`,
            [member.accountId, member2.accountId, msgs[0]])).rows.map((r) => Number(r.id));
          // 셋째 줄은 미리 읽어 둔다(시각을 덮지 않는지 본다).
          await db.pool.query(`update inbox set read_at = '2026-01-01T00:00:00Z' where id = $1`, [ids[2]]);
          return ids;
        };
        const state = async (ids: number[]) => (await db.pool.query<{ i: number; read: boolean; old: boolean }>(
          `select array_position($1::bigint[], id) as i, read_at is not null as read, coalesce(read_at = '2026-01-01T00:00:00Z', false) as old
             from inbox where id = any($1::bigint[]) order by 1`, [ids])).rows;
        const run = async (base: string) => {
          const ids = await seed();
          const out: unknown[] = [];
          // 내 줄 둘(하나는 이미 읽음)·남의 줄·없는 id 를 한 번에.
          const r1 = await callX(base, 'POST', '/inbox/read', { ids: [ids[0], ids[2], ids[3], 9_000_000_000, 1.0 * ids[0]!] }, member.token);
          out.push({ status: r1.status, json: r1.json }, await state(ids));
          // 다시 불러도 그대로(멱등).
          const r2 = await callX(base, 'POST', '/inbox/read', { ids: [ids[0]], extra: true }, member.token);
          out.push({ status: r2.status }, await state(ids));
          // 남은 내 줄을 에이전트 PAT 로는 못 바꾼다(남의 줄).
          const r3 = await callX(base, 'POST', '/inbox/read', { ids: [ids[1]] }, agent.pat);
          out.push({ status: r3.status }, await state(ids));
          return out;
        };
        const busBefore = busEvents.length;
        const [tsOut, rsOut] = [await run(tsUrl), await run(rsUrl)];
        expect(rsOut).toEqual(tsOut);
        expect(tsOut[1]).toEqual([
          { i: 1, read: true, old: false }, { i: 2, read: false, old: false },
          { i: 3, read: true, old: true }, { i: 4, read: false, old: false },
        ]);
        expect(tsOut[0]).toEqual({ status: 204, json: {} });
        for (const [name, body, token] of [
          ['익명 → 401', { ids: [1] }, ''],
          ['ids 없음 → 400', {}, member.token],
          ['ids 빈 배열 → 400', { ids: [] }, member.token],
          ['ids 소수 → 400', { ids: [1.5] }, member.token],
          ['ids 문자열 → 400', { ids: ['1'] }, member.token],
          ['ids 숫자 하나 → 400', { ids: 1 }, member.token],
          ['배열 본문 → 400', [1], member.token],
          ['bigint 밖 → 500', { ids: [1e20] }, member.token],
        ] as const) {
          const [a, b] = [await callX(tsUrl, 'POST', '/inbox/read', body, token), await callX(rsUrl, 'POST', '/inbox/read', body, token)];
          expect({ status: b.status, code: b.code }, name).toEqual({ status: a.status, code: a.code });
        }
        for (const [name, init] of [
          ['익명·본문 없음 → 401', {}],
          ['본문 없음 → 400', { headers: { authorization: `Bearer ${member.token}` } }],
          ['익명·깨진 json → 400', { headers: { 'content-type': J }, body: '{' }],
          ['text/plain → 400', { headers: { authorization: `Bearer ${member.token}`, 'content-type': 'text/plain' }, body: 'x' }],
          ['익명·모르는 형식 → 415', { headers: { 'content-type': 'application/xml' }, body: '<a/>' }],
        ] as const) {
          const [a, b] = [await fetch(`${tsUrl}/inbox/read`, { method: 'POST', ...init }), await fetch(`${rsUrl}/inbox/read`, { method: 'POST', ...init })];
          expect(b.status, name).toBe(a.status);
        }
        await new Promise((res) => setTimeout(res, 500));
        expect(busEvents.slice(busBefore).filter((e) => e.type === 'inbox.updated'), '읽음 표시는 이벤트가 없다').toEqual([]);
      }
      await bus.stop();

      // S5.3 C0 — `/ws`. 같은 시나리오를 TS 와 Rust 코어에 돌려 프레임을 견준다.
      interface Sock { ws: WebSocket; frames: Record<string, unknown>[]; closed: Promise<number> }
      const ticket = async (base: string, token: string): Promise<string> => {
        const res = await fetch(`${base}/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
        expect(res.status, `${base} /ws-ticket`).toBe(200);
        return String(((await res.json()) as { ticket: string }).ticket);
      };
      const open = (base: string, query: string): Promise<Sock> => new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws${query}`);
        const frames: Record<string, unknown>[] = [];
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
        ws.on('open', () => resolve({ ws, frames, closed }));
        ws.on('error', reject);
      });
      const waitFor = async (s: Sock, pred: (f: Record<string, unknown>) => boolean, ms = 5_000) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          const hit = s.frames.find(pred);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 50));
        }
        return undefined;
      };
      const socks: Sock[] = [];
      try {
        // 티켓: 없음·두 번 쓰기는 4401(두 서버 같음).
        for (const base of [tsUrl, rsUrl]) {
          expect(await (await open(base, '')).closed, `${base} 티켓 없음`).toBe(4401);
          const t = await ticket(base, member.token);
          const first = await open(base, `?ticket=${encodeURIComponent(t)}`);
          socks.push(first);
          expect(await (await open(base, `?ticket=${encodeURIComponent(t)}`)).closed, `${base} 티켓 재사용`).toBe(4401);
          const snap = await waitFor(first, (f) => f.type === 'presence.snapshot');
          expect((snap?.online as string[]) ?? [], `${base} 스냅숏에 나`).toContain(member.accountId);
        }
        const [tsMem, rsMem] = socks as [Sock, Sock];
        // 앱 hb 프레임(Rust 는 시험용으로 300ms).
        expect(await waitFor(rsMem, (f) => f.type === 'hb'), 'hb 프레임').toMatchObject({ type: 'hb', intervalMs: 300 });
        // 이벤트: Rust 가 쓴 것(outbox) → Rust 코어 소켓에 도착, TS 버스가 받은 것과 같은 모양. 남의 계정 이벤트는 오지 않는다.
        const rsAdmin = await open(rsUrl, `?ticket=${encodeURIComponent(await ticket(rsUrl, A))}`);
        socks.push(rsAdmin);
        const grp2 = await callX(rsUrl, 'POST', '/handle-groups', { handle: 'wsgroup', displayName: 'W' });
        expect(grp2.status).toBe(201);
        const ev = await waitFor(rsMem, (f) => f.type === 'handle_group.changed' && f.groupId === grp2.json.id);
        expect(ev, '코어 소켓이 outbox 이벤트를 받는다').toEqual({ type: 'handle_group.changed', groupId: grp2.json.id, audience: 'all' });
        const seen = await callX(rsUrl, 'PUT', '/inbox/today/seen', { upTo: new Date().toISOString() }, member.token);
        expect(seen.status).toBe(200);
        expect(await waitFor(rsMem, (f) => f.type === 'inbox.updated'), '내 inbox.updated').toEqual({ type: 'inbox.updated', accountId: member.accountId });
        await new Promise((r) => setTimeout(r, 300));
        expect(rsAdmin.frames.filter((f) => f.type === 'inbox.updated' && f.accountId === member.accountId), '남의 inbox.updated 는 안 옴').toEqual([]);
        // 입력 중: 공개 채널에서 member 가 치면 admin 은 [member], member 자신은 [] 를 받는다 — TS 와 같은 모양.
        const pub = await callX(tsUrl, 'POST', '/channels', { name: 'ws-typing', visibility: 'public' });
        const pubId = String((pub.json.channel as { id?: string } | undefined)?.id ?? pub.json.id);
        const tsAdmin = await open(tsUrl, `?ticket=${encodeURIComponent(await ticket(tsUrl, A))}`);
        socks.push(tsAdmin);
        const typingFrames: Record<string, unknown>[][] = [];
        for (const [memS, adminS] of [[tsMem, tsAdmin], [rsMem, rsAdmin]] as const) {
          memS.ws.send(JSON.stringify({ type: 'typing', channelId: pubId }));
          const toAdmin = await waitFor(adminS, (f) => f.type === 'typing.changed' && f.channelId === pubId);
          const toMe = await waitFor(memS, (f) => f.type === 'typing.changed' && f.channelId === pubId);
          typingFrames.push([toAdmin!, toMe!]);
          memS.ws.send('not json');
          memS.ws.send(JSON.stringify({ type: 'typing.stop', channelId: pubId }));
        }
        expect(typingFrames[1], 'Rust 입력 중 = TS 입력 중').toEqual(typingFrames[0]);
        expect(typingFrames[1]![0]).toEqual({ type: 'typing.changed', channelId: pubId, accountIds: [member.accountId], audience: [admin.accountId] });
        // 자격증명 재검증: 세션이 사라지면 4401 로 닫는다(Rust 시험 주기 500ms).
        const rsMem2 = await open(rsUrl, `?ticket=${encodeURIComponent(await ticket(rsUrl, member2.token))}`);
        socks.push(rsMem2);
        await db.pool.query('delete from session where account_id = $1', [member2.accountId]);
        const code = await Promise.race([rsMem2.closed, new Promise<number>((r) => setTimeout(() => r(-1), 5_000))]);
        expect(code, '무효가 된 자격증명은 4401').toBe(4401);
      } finally {
        for (const s of socks) s.ws.terminate();
      }

      // 11-14 「Load failed」 장애 재발 막기 — 앞단이 답하는 **모든** 줄이 TS 와 같은 CORS 머리를 내는가. 줄 목록은 앞단 기동 기록에서
      // 읽는다(새 줄이 생기면 저절로 들어온다). 요청은 바꾸는 것이 없게(없는 id·빈 본문) 보낸다 — 머리만 본다.
      // 옮긴 줄(`front: rust routes`)과 코어 줄(`front: rust core routes` — `route_table.rs` 가 붙이면서 적는 표)을 **합쳐** 본다.
      // 코어에 새 HTTP 줄이 붙으면 저절로 여기 들어온다(손으로 시험을 더하지 않는다 — 11-14 CORS 빠짐 두 번의 교훈).
      const moved = JSON.parse((/front: rust routes (\[.*\])/.exec(f.log()) ?? [])[1] ?? '[]') as string[];
      expect(moved.length, '앞단 줄 목록을 읽어야 한다').toBeGreaterThan(40);
      const coreKeys = JSON.parse((/front: rust core routes (\[.*?\]) sockets/.exec(f.log()) ?? [])[1] ?? '[]') as string[];
      expect(coreKeys, '코어 줄 목록(/ws-ticket·/operators*)을 읽어야 한다').toEqual(expect.arrayContaining(['POST /ws-ticket', 'GET /operators', 'DELETE /operators/{id}']));
      const keys = [...moved, ...coreKeys];
      const CORS_HEADERS = ['access-control-allow-origin', 'access-control-expose-headers', 'access-control-allow-credentials'];
      const VOLATILE = new Set(['date', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);
      const headerDiffs: string[] = [];
      const fill = (p: string) => p.replace(/\{slug\}/g, 'no-such-skill').replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000999');
      for (const key of keys) {
        const [method, path] = key.split(' ') as [string, string];
        for (const origin of [CORS, 'https://evil.example']) {
          const req = (base: string) => fetch(`${base}${fill(path)}`, { method, headers: { authorization: `Bearer ${A}`, origin } });
          const [a, b] = [await req(tsUrl), await req(rsUrl)];
          await a.arrayBuffer(); await b.arrayBuffer();
          for (const h of CORS_HEADERS) expect(b.headers.get(h), `${key} ${origin} ${h}`).toBe(a.headers.get(h));
          expect((b.headers.get('vary') ?? '').toLowerCase(), `${key} vary`).toContain('origin');
          if (origin === CORS) {
            expect(b.headers.get('access-control-allow-origin'), `${key} 허용 출처`).toBe(CORS);
            const names = (r: Response) => new Set([...r.headers.keys()].filter((n) => !VOLATILE.has(n)));
            const [na, nb] = [names(a), names(b)];
            const onlyTs = [...na].filter((n) => !nb.has(n));
            const onlyRs = [...nb].filter((n) => !na.has(n));
            if (onlyTs.length || onlyRs.length) headerDiffs.push(`${key} (${a.status}/${b.status}) TS만: ${onlyTs.join(',') || '-'} · Rust만: ${onlyRs.join(',') || '-'}`);
          } else {
            expect(b.headers.get('access-control-allow-origin'), `${key} 목록 밖 출처`).toBeNull();
          }
        }
      }
      // 같은 모든 줄의 프리플라이트 — 그 줄의 메서드를 ACRM 으로. 상태·CORS 머리가 TS 와 같아야 한다(TS 는 `@fastify/cors` 가 답한다).
      for (const key of keys) {
        const [method, path] = key.split(' ') as [string, string];
        const headers = { origin: CORS, 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' };
        const [a, b] = [
          await fetch(`${tsUrl}${fill(path)}`, { method: 'OPTIONS', headers }),
          await fetch(`${rsUrl}${fill(path)}`, { method: 'OPTIONS', headers }),
        ];
        await a.arrayBuffer(); await b.arrayBuffer();
        expect(b.status, `preflight ${key}`).toBe(a.status);
        for (const h of [...CORS_HEADERS, 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) {
          expect(b.headers.get(h), `preflight ${key} ${h}`).toBe(a.headers.get(h));
        }
        // `Access-Control-Request-Method` 없는 프리플라이트 — TS(`@fastify/cors` strictPreflight)는 400 「Invalid Preflight Request」.
        const [e, g] = [
          await fetch(`${tsUrl}${fill(path)}`, { method: 'OPTIONS', headers: { origin: CORS } }),
          await fetch(`${rsUrl}${fill(path)}`, { method: 'OPTIONS', headers: { origin: CORS } }),
        ];
        const [et, gt] = [await e.text(), await g.text()];
        expect(g.status, `ACRM 없는 preflight ${key}`).toBe(e.status);
        expect(gt, `ACRM 없는 preflight ${key} 본문`).toBe(et);
        for (const h of CORS_HEADERS) expect(g.headers.get(h), `ACRM 없는 preflight ${key} ${h}`).toBe(e.headers.get(h));
        // 인증 없는 본 요청(401·403 등) — 인증 층보다 바깥에서 CORS 가 붙는가.
        const [c, d] = [
          await fetch(`${tsUrl}${fill(path)}`, { method, headers: { origin: CORS } }),
          await fetch(`${rsUrl}${fill(path)}`, { method, headers: { origin: CORS } }),
        ];
        await c.arrayBuffer(); await d.arrayBuffer();
        for (const h of CORS_HEADERS) expect(d.headers.get(h), `${key} 인증 없음 ${h}`).toBe(c.headers.get(h));
      }
      // 코어 줄과 같은 경로의 **다른 메서드**는 TS 가 답한다 — Rust 가 405 로 막지 않는다(`route_table::ts_fallback`).
      // 예: 코어 `GET /channels/{id}/messages` 옆 TS `POST`(글 쓰기). 인증 없이 보내 바꾸는 것이 없게 하고, 상태가 TS 와 같아야 한다.
      for (const path of new Set(coreKeys.map((k) => k.split(' ')[1]!))) {
        const mine = new Set(coreKeys.filter((k) => k.endsWith(` ${path}`)).map((k) => k.split(' ')[0]!));
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => !mine.has(m))) {
          const [a, b] = [
            await fetch(`${tsUrl}${fill(path)}`, { method, headers: { origin: CORS } }),
            await fetch(`${rsUrl}${fill(path)}`, { method, headers: { origin: CORS } }),
          ];
          await a.arrayBuffer(); await b.arrayBuffer();
          expect(b.status, `${method} ${path} — 코어 줄과 같은 경로의 다른 메서드는 TS 답 그대로`).toBe(a.status);
        }
      }
      // 같은 축의 다른 머리 차이(보안·캐시 머리 등) — 보고용으로 남긴다.
      console.log(`rust-front header diff (${headerDiffs.length}):\n${headerDiffs.join('\n')}`);
      // 프리플라이트(옮긴 줄의 OPTIONS 는 앞단이 TS 로 넘긴다 — 두 답이 같아야 한다).
      for (const headers of [{ origin: CORS, 'access-control-request-method': 'PUT' }, { origin: CORS }] as Record<string, string>[]) {
        const [a, b] = [
          await fetch(`${tsUrl}/settings/mention-policy`, { method: 'OPTIONS', headers }),
          await fetch(`${rsUrl}/settings/mention-policy`, { method: 'OPTIONS', headers }),
        ];
        expect(b.status).toBe(a.status);
        for (const h of [...CORS_HEADERS, 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) {
          expect(b.headers.get(h), `preflight ${h}`).toBe(a.headers.get(h));
        }
      }
    } finally {
      front?.kill('SIGTERM');
      await app.close();
      await db.stop();
    }
  }, 900_000);
});

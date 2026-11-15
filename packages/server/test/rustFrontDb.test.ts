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
import { bootstrapAdmin, createAgent, createMember } from './helpers/fixtures.js';
import { startTestDb } from './helpers/testDb.js';
import { postMessage } from '../src/services/messages.js';
import {
  addChannelMember, audienceFor, channelListAudience, channelListLostAudience, createChannel, getOrCreateDm, removeChannelMember,
} from '../src/services/channels.js';
import { startEventBus } from '../src/eventBus.js';
import {
  invokeFactsFor, isEligibleDelegate, mayInvoke, mayInvokeTeam, type InvokeVia, type TeamInvokeFacts,
} from '../src/services/invokeGate.js';
import { onEvent, type WorkspaceEvent } from '../src/events.js';
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
  for (const name of ['auth', 'perm', 'operator', 'loops', 'wake', 'outbox_listener', 'retention']) {
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
      // connection limit = 쓰기 풀 2 + 루프 문지기 풀 2 + 루프 sweep 풀 3 (S5.3 C5c — 운영 역할 한도도 이만큼 받아야 한다).
      await db.pool.query(`create role ${rw} login password '${rw}' nosuperuser nocreatedb nocreaterole nobypassrls connection limit 7`);
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
        // S5.3 C5b — 예약 깨움 루프(`loops/wake.rs::WAKE_PRIVILEGES`). 없으면 「loop wake off」 — 루프는 TS 에 남는다.
        ...WAKE_GRANTS.map((g) => `grant ${g} to ${rw}`),
        // S5.3 C5c — 보존 정리 루프(`loops/retention.rs::RETENTION_PRIVILEGES`).
        ...RETENTION_GRANTS.map((g) => `grant ${g} to ${rw}`),
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
      const mcpCall = async (base: string, token: string, name: string, args: unknown, id: unknown = 1) => {
        const params = args === undefined ? { name } : { name, arguments: args };
        const res = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
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
        ['channel.doc 문서 없음(DM)', 'channel.doc', { channelId: String(dm.id) }, true, 5],
        ['channel.doc 없는 채널 → 빈 문서', 'channel.doc', { channelId: missingCh }, true, 6],
        ['channel.doc 비공개·멤버 아님 → forbidden', 'channel.doc', { channelId: privId }, true, 7],
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
        ['message.read 비공개·멤버 아님 → forbidden', { channelId: privId }, true],
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
        const mineOf = (evs: WorkspaceEvent[], s: { msg: string; wake: string; dmMsg: string }) => evs.filter((e) => {
          const o = e as { messageId?: string; message?: { id?: string } };
          const id = o.messageId ?? o.message?.id;
          return id === s.msg || id === s.wake || id === s.dmMsg;
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
        const mineOf = (evs: WorkspaceEvent[], sd: Side) => evs.filter((e) => {
          const o = e as { messageId?: string; message?: { id?: string } };
          const id = o.messageId ?? o.message?.id;
          return Object.values(sd).includes(id as string);
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

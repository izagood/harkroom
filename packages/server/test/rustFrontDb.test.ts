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
import type { WorkspaceEvent } from '../src/events.js';
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

async function operatorWriteRole(db: { pool: pg.Pool; uri: string }): Promise<string> {
  const rw = `op_rw_${Math.random().toString(36).slice(2, 10)}`;
  await db.pool.query(`create role ${rw} login password '${rw}' nosuperuser nocreatedb nocreaterole nobypassrls connection limit 8`);
  await db.pool.query(`grant pg_read_all_data to ${rw}`);
  for (const g of OPERATOR_GRANTS) await db.pool.query(`grant ${g} to ${rw}`);
  const u = new URL(db.uri);
  u.username = rw;
  u.password = rw;
  return u.toString();
}

describe.skipIf(!ON)('Rust 앞단 DB 대조 시험 — 실제 스키마로', () => {
  for (const name of ['auth', 'perm', 'operator']) {
    it(`tests/${name}.rs`, async () => {
      const db = await startTestDb();
      try {
        const env: Record<string, string> = { HARKROOM_TEST_DATABASE_URL: db.uri };
        // C2a — 오퍼레이터 시험은 쓰기 풀을 `write.rs::OPERATOR_PRIVILEGES` 만 가진 역할로 돌린다(homelab GRANT 표가 모자라면 여기서 빨개진다).
        if (name === 'operator') env.HARKROOM_TEST_WRITE_DATABASE_URL = await operatorWriteRole(db);
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
      await db.pool.query(`create role ${rw} login password '${rw}' nosuperuser nocreatedb nocreaterole nobypassrls connection limit 4`);
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
      await bus.stop();

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
      const keys = JSON.parse((/front: rust routes (\[.*\])/.exec(f.log()) ?? [])[1] ?? '[]') as string[];
      expect(keys.length, '앞단 줄 목록을 읽어야 한다').toBeGreaterThan(40);
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
      // 코어 `/ws-ticket`(C0)도 데스크톱이 교차 출처로 부른다 — 본 요청과 프리플라이트 둘 다 TS 와 같아야 한다.
      for (const [method, headers] of [
        ['POST', { authorization: `Bearer ${A}`, origin: CORS }],
        ['OPTIONS', { origin: CORS, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' }],
      ] as const) {
        const [a, b] = [await fetch(`${tsUrl}/ws-ticket`, { method, headers }), await fetch(`${rsUrl}/ws-ticket`, { method, headers })];
        await a.arrayBuffer(); await b.arrayBuffer();
        expect(b.status, `${method} /ws-ticket`).toBe(a.status);
        for (const h of [...CORS_HEADERS, 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) {
          expect(b.headers.get(h), `${method} /ws-ticket ${h}`).toBe(a.headers.get(h));
        }
      }
      // C2a — 오퍼레이터 REST(`/operators*`)도 데스크톱이 교차 출처로 부른다. 앞단 줄 목록(`front: rust routes`)에는 없으므로 따로 본다.
      // 본 요청(인증 있음·없음)과 프리플라이트가 TS 와 같은 상태·CORS 머리인가. 바꾸는 요청은 없는 id 로만 보낸다.
      const OP_MISSING = '00000000-0000-4000-8000-000000000999';
      const opCases: [string, string, Record<string, string>][] = [
        ['GET', '/operators', { authorization: `Bearer ${A}`, origin: CORS }],
        ['GET', '/operators', { origin: CORS }],
        ['GET', '/operators', { authorization: `Bearer ${A}`, origin: 'https://evil.example' }],
        ['GET', `/operators/${OP_MISSING}/capabilities`, { authorization: `Bearer ${A}`, origin: CORS }],
        ['DELETE', `/operators/${OP_MISSING}`, { authorization: `Bearer ${A}`, origin: CORS }],
        ['OPTIONS', '/operators', { origin: CORS, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }],
        ['OPTIONS', '/operators/register-codes', { origin: CORS, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }],
        ['OPTIONS', `/operators/${OP_MISSING}`, { origin: CORS, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'authorization' }],
        ['OPTIONS', '/operators', { origin: CORS }],
      ];
      for (const [method, path, headers] of opCases) {
        const [a, b] = [await fetch(`${tsUrl}${path}`, { method, headers }), await fetch(`${rsUrl}${path}`, { method, headers })];
        await a.arrayBuffer(); await b.arrayBuffer();
        const label = `${method} ${path} ${headers.origin}${headers.authorization ? ' auth' : ''}`;
        expect(b.status, label).toBe(a.status);
        for (const h of [...CORS_HEADERS, 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) {
          expect(b.headers.get(h), `${label} ${h}`).toBe(a.headers.get(h));
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

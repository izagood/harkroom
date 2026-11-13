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
import { startEventBus } from '../src/eventBus.js';
import type { WorkspaceEvent } from '../src/events.js';
import pg from 'pg';

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

describe.skipIf(!ON)('Rust 앞단 DB 대조 시험 — 실제 스키마로', () => {
  for (const name of ['auth', 'perm']) {
    it(`tests/${name}.rs`, async () => {
      const db = await startTestDb();
      try {
        const r = await cargo(['test', '--test', name, '--', '--nocapture'], { HARKROOM_TEST_DATABASE_URL: db.uri });
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
    const app = await buildServer({ pool: db.pool });
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
      });
      front = f.child;
      // 앞단이 옮긴 줄을 **직접** 답하는지 — 모두 TS 로 넘기면 대조는 TS 끼리 비교해 늘 통과한다.
      for (const key of [
        'GET /accounts', 'GET /dms', 'GET /mcp-servers', 'GET /audit',
        'GET /teams', 'GET /teams/{id}', 'GET /handle-groups', 'GET /handle-groups/{id}',
        'GET /skills', 'GET /skills/{slug}', 'GET /settings/agent-defaults', 'GET /settings/mention-policy',
        'GET /inbox/today/open', 'GET /inbox/today/done', 'PUT /inbox/today/seen',
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
      await bus.stop();

      // S5.2 P4d — 옮긴 라우트를 지난 요청도 세션을 늘리고 PAT 사용 시각을 남긴다(쓰기 풀로). 읽기 역할로 하면 조용히 실패하던 것.
      await db.pool.query(`update session set expires_at = now() + interval '1 day' where account_id = $1`, [member.accountId]);
      await db.pool.query(`update pat set last_used_at = now() - interval '1 hour' where account_id = $1`, [agent.accountId]);
      for (const token of [member.token, agent.pat]) {
        const res = await fetch(`${rsUrl}/settings/mention-policy`, { headers: { authorization: `Bearer ${token}` } });
        expect(res.status).toBe(200);
      }
      const sess = await db.pool.query<{ left: number }>(
        `select extract(epoch from (max(expires_at) - now()))::int / 86400 as left from session where account_id = $1`, [member.accountId]);
      expect(sess.rows[0]!.left, '세션이 14일로 늘어야 한다').toBeGreaterThanOrEqual(13);
      const used = await db.pool.query<{ fresh: boolean }>(
        `select bool_and(last_used_at > now() - interval '1 minute') as fresh from pat where account_id = $1 and revoked_at is null`, [agent.accountId]);
      expect(used.rows[0]!.fresh, 'PAT 사용 시각이 새로 찍혀야 한다').toBe(true);
    } finally {
      front?.kill('SIGTERM');
      await app.close();
      await db.stop();
    }
  }, 900_000);
});

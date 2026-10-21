import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CAUSE_HEADER, TURN_ID_HEADER } from '@harkroom/shared/runnerLink';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent, registerOperator } from './helpers/fixtures.js';
import {
  BG_MAX_WRITES, claimBgJob, completeBgJob, createBgJobSweeper, DISTILL_MAX_THREADS, enqueueBgJob, inBgWindow, kstDay, produceDistillJobs,
} from '../src/services/bgJobs.js';
import { getThreadNote, setThreadNote } from '../src/services/threadNote.js';

// 백그라운드 턴 G1 · BG1(설계 harkroom://message/4a44f18a) — 큐·창·상한·서버 허용 목록의 회귀선.
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const ON = { HARKROOM_BACKGROUND_ENABLED: '1' } as NodeJS.ProcessEnv;
/** 2026-10-21 04:00 KST — 창 안. */
const IN_WINDOW = new Date('2026-10-20T19:00:00Z');
/** 2026-10-21 12:00 KST — 창 밖. */
const NOON = new Date('2026-10-21T03:00:00Z');

describe('bg_job (BG1)', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let app: FastifyInstance;
  let admin: { token: string; accountId: string };
  let op: { token: string; operatorId: string };
  let url = '';
  const prevEnv = process.env.HARKROOM_BACKGROUND_ENABLED;

  const agent = async (handle: string) => {
    const a = await createAgent(app, admin.token, handle);
    await pool.query(`insert into agent_assignment (agent_id, operator_id, assigned_by) values ($1, $2, $3)`, [a.accountId, op.operatorId, admin.accountId]);
    return a;
  };
  const asAgent = (id: string, extra: Record<string, string> = {}) => ({ ...auth(op.token), 'x-harkroom-agent': id, ...extra });
  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };
  /** running 인 회차를 바로 만든다(창·시각과 무관하게 서버 허용 목록을 보려고). */
  const runningJob = async (accountId: string, threadIds: string[]) => (await pool.query(
    `insert into bg_job (account_id, kind, day, status, input, claimed_at) values ($1, 'distill', $2::date, 'running', $3::jsonb, now()) returning id`,
    [accountId, kstDay(new Date()), JSON.stringify({ threadIds })],
  )).rows[0].id as string;

  beforeAll(async () => {
    db = await startTestDb(); pool = db.pool;
    app = await buildServer({ pool });
    admin = await bootstrapAdmin(app);
    op = await registerOperator(app, admin.token, 'mac');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/mcp` : '';
    process.env.HARKROOM_BACKGROUND_ENABLED = '1';
  });
  afterAll(async () => {
    if (prevEnv === undefined) delete process.env.HARKROOM_BACKGROUND_ENABLED; else process.env.HARKROOM_BACKGROUND_ENABLED = prevEnv;
    await app.close(); await db.stop();
  });

  it('창은 03~07 KST, 날짜는 KST 로 센다', () => {
    expect(inBgWindow(IN_WINDOW)).toBe(true);
    expect(inBgWindow(NOON)).toBe(false);
    expect(inBgWindow(new Date('2026-10-20T22:00:00Z'))).toBe(false); // 07:00 KST — 끝은 열린 구간
    expect(kstDay(IN_WINDOW)).toBe('2026-10-21');
  });

  it('enqueue: 스위치 꺼짐이면 거절, (에이전트, 종류, 날짜) 하루 1회, 서버 하루 상한', async () => {
    const a = await agent('bg-q1');
    const b = await agent('bg-q2');
    expect(await enqueueBgJob(pool, { accountId: a.accountId, kind: 'distill', input: {}, now: IN_WINDOW }, {})).toEqual({ refused: 'disabled' });
    const first = await enqueueBgJob(pool, { accountId: a.accountId, kind: 'distill', input: { threadIds: [] }, now: IN_WINDOW }, ON);
    expect('job' in first && first.job.status).toBe('queued');
    expect(await enqueueBgJob(pool, { accountId: a.accountId, kind: 'distill', input: {}, now: IN_WINDOW }, ON)).toEqual({ refused: 'exists' });
    const used = (await pool.query(`select count(*)::int as n from bg_job where day = '2026-10-21'`)).rows[0].n as number;
    expect(await enqueueBgJob(pool, { accountId: b.accountId, kind: 'distill', input: {}, now: IN_WINDOW }, { ...ON, HARKROOM_BACKGROUND_DAILY_MAX: String(used) }))
      .toEqual({ refused: 'daily_cap' });
  });

  it('claim: 창 밖·꺼짐이면 안 준다, 창 안이면 running 으로 집고, complete 는 한 번만 닫는다', async () => {
    const a = await agent('bg-c1');
    await enqueueBgJob(pool, { accountId: a.accountId, kind: 'cleanup', input: {}, now: IN_WINDOW }, ON);
    expect(await claimBgJob(pool, a.accountId, NOON, ON)).toEqual({ job: null, reason: 'outside_window' });
    expect(await claimBgJob(pool, a.accountId, IN_WINDOW, {})).toEqual({ job: null, reason: 'disabled' });
    const got = await claimBgJob(pool, a.accountId, IN_WINDOW, ON);
    expect(got.job?.status).toBe('running');
    expect(await claimBgJob(pool, a.accountId, IN_WINDOW, ON)).toEqual({ job: null, reason: 'none' });
    expect(await completeBgJob(pool, a.accountId, got.job!.id, { status: 'done', summary: '없음 — 되풀이할 교훈 없음' })).toBe('ok');
    expect(await completeBgJob(pool, a.accountId, got.job!.id, { status: 'failed' })).toBe('not_running');
    const other = await agent('bg-c2');
    expect(await completeBgJob(pool, other.accountId, got.job!.id, { status: 'done' })).toBe('not_found');
  });

  it('3번 연속 실패하면 그 (에이전트, 종류)는 멈춘다', async () => {
    const a = await agent('bg-p1');
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      await pool.query(`insert into bg_job (account_id, kind, day, status) values ($1, 'distill', $2, 'failed')`, [a.accountId, d]);
    }
    expect(await enqueueBgJob(pool, { accountId: a.accountId, kind: 'distill', input: {}, now: IN_WINDOW }, ON)).toEqual({ refused: 'paused' });
    expect('job' in await enqueueBgJob(pool, { accountId: a.accountId, kind: 'cleanup', input: {}, now: IN_WINDOW }, ON)).toBe(true);
  });

  it('sweep: 집고 죽은 회차는 failed(timeout), 지난 날의 일감은 skipped(expired)', async () => {
    const a = await agent('bg-s1');
    const stale = (await pool.query(`insert into bg_job (account_id, kind, day, status, claimed_at) values ($1, 'distill', '2026-10-21', 'running', now() - interval '20 minutes') returning id`, [a.accountId])).rows[0].id;
    const old = (await pool.query(`insert into bg_job (account_id, kind, day) values ($1, 'cleanup', '2026-10-19') returning id`, [a.accountId])).rows[0].id;
    await createBgJobSweeper(pool, ON).sweep(new Date());
    const rows = (await pool.query(`select id, status, error from bg_job where id = any($1::uuid[])`, [[stale, old]])).rows;
    expect(rows.find((r) => r.id === stale)).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(rows.find((r) => r.id === old)).toMatchObject({ status: 'skipped', error: 'expired' });
  });

  describe('증류 생산자(BG3)', () => {
    /** 스레드 하나: 루트 글 + done 상태(나이) + 그 에이전트의 메모. */
    const thread = async (ch: string, agentId: string, o: { doneAgoMs?: number; status?: string; note?: boolean } = {}) => {
      const root = (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(admin.token), payload: { body: 'distill me' } })).json().id as string;
      await pool.query(
        `insert into thread_status (root_id, status, emoji, account_id, updated_at) values ($1, $2, '✅', $3, now() - ($4 || ' milliseconds')::interval)`,
        [root, o.status ?? 'done', agentId, String(o.doneAgoMs ?? 25 * 3600_000)],
      );
      if (o.note !== false) await setThreadNote(pool, agentId, root, '진행 메모', undefined, null);
      return root;
    };

    it('done 24h 넘은 메모 스레드를 볼 수 있는 것만 오래된 것부터 10개 묶어 하루 1회 넣고, 창이 끝난 뒤엔 넣지 않는다', async () => {
      const a = await agent('bg-d1');
      const pub = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'bg-d1-pub' } })).json().id as string;
      const priv = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'bg-d1-priv', visibility: 'private' } })).json().id as string;
      const old = await thread(pub, a.accountId, { doneAgoMs: 48 * 3600_000 });
      const fresh = await thread(pub, a.accountId, { doneAgoMs: 3600_000 }); // done 1시간 — 아직
      const running = await thread(pub, a.accountId, { status: 'running' });
      // 그 에이전트가 못 보는 채널 — 가장 오래 done 이라, 거르지 않으면 맨 앞에 선다.
      const hidden = await thread(priv, a.accountId, { doneAgoMs: 100 * 3600_000 });
      const noNote = await thread(pub, a.accountId, { note: false, doneAgoMs: 80 * 3600_000 });
      const archived = await thread(pub, a.accountId, { doneAgoMs: 90 * 3600_000 });
      await pool.query(`update thread_note set archived_at = now() where thread_root_id = $1`, [archived]);
      const more: string[] = [];
      for (let i = 0; i < DISTILL_MAX_THREADS + 2; i++) more.push(await thread(pub, a.accountId, { doneAgoMs: (40 - i) * 3600_000 }));

      expect((await produceDistillJobs(pool, new Date('2026-10-20T23:30:00Z'), ON)).queued).toBe(0); // 08:30 KST — 창 끝남
      const done = await produceDistillJobs(pool, IN_WINDOW, ON);
      expect(done.queued).toBeGreaterThanOrEqual(1);
      const job = (await pool.query(`select input from bg_job where account_id = $1 and kind = 'distill' and day = '2026-10-21'`, [a.accountId])).rows[0];
      const ids = job.input.threadIds as string[];
      expect(ids).toHaveLength(DISTILL_MAX_THREADS);
      expect(ids[0]).toBe(old); // 가장 오래 done 인 것부터
      for (const x of [fresh, running, hidden, noNote, archived]) expect(ids).not.toContain(x);
      // 하루 1회 — 다시 돌아도 늘지 않는다.
      expect((await produceDistillJobs(pool, IN_WINDOW, ON)).refused.exists).toBeGreaterThanOrEqual(1);
      // 날짜로 좁힌다 — 서버의 진짜 sweep(이 시험이 스위치를 켰다)이 실제 03~07 KST 에 돌면 오늘 날짜로 하나를 더 넣을 수 있다.
      expect((await pool.query(`select count(*)::int as n from bg_job where account_id = $1 and kind = 'distill' and day = '2026-10-21'`, [a.accountId])).rows[0].n).toBe(1);
      expect((await produceDistillJobs(pool, IN_WINDOW, {})).queued).toBe(0); // 스위치 꺼짐
    });

    it('done 으로 끝난 증류 회차는 입력 메모를 보관하고(읽기에서 빠짐), 다시 쓰면 열린다 · 실패한 회차는 보관하지 않는다', async () => {
      const a = await agent('bg-d2');
      const ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'bg-d2' } })).json().id as string;
      const r1 = await thread(ch, a.accountId);
      const r2 = await thread(ch, a.accountId);
      const ok = (await pool.query(`insert into bg_job (account_id, kind, day, status, input, claimed_at) values ($1, 'distill', '2026-10-21', 'running', $2::jsonb, now()) returning id`, [a.accountId, JSON.stringify({ threadIds: [r1] })])).rows[0].id;
      const bad = (await pool.query(`insert into bg_job (account_id, kind, day, status, input, claimed_at) values ($1, 'distill', '2026-10-22', 'running', $2::jsonb, now()) returning id`, [a.accountId, JSON.stringify({ threadIds: [r2] })])).rows[0].id;
      expect(await completeBgJob(pool, a.accountId, ok, { status: 'done', summary: '없음' })).toBe('ok');
      expect(await completeBgJob(pool, a.accountId, bad, { status: 'failed', error: 'timeout' })).toBe('ok');
      expect(await getThreadNote(pool, a.accountId, r1)).toBeNull();
      expect(await getThreadNote(pool, a.accountId, r2)).not.toBeNull();
      expect((await pool.query(`select archived_by_run from thread_note where thread_root_id = $1`, [r1])).rows[0].archived_by_run).toBe(ok);
      // 보관된 메모는 없는 것과 같다 — 새로 쓰기로 다시 연다.
      expect(await setThreadNote(pool, a.accountId, r1, '다시', { updatedAt: null }, null)).toMatchObject({ updatedAt: expect.any(Date) });
      expect((await getThreadNote(pool, a.accountId, r1))?.body).toBe('다시');
    });

    it('하루 상한은 동시에 넣어도 넘지 않는다(security n4)', async () => {
      const xs = await Promise.all(['bg-n4a', 'bg-n4b', 'bg-n4c'].map((h) => agent(h)));
      const day = new Date('2026-11-01T19:00:00Z');
      const used = (await pool.query(`select count(*)::int as n from bg_job where day = $1::date`, [kstDay(day)])).rows[0].n as number;
      const env = { ...ON, HARKROOM_BACKGROUND_DAILY_MAX: String(used + 1) } as NodeJS.ProcessEnv;
      const rs = await Promise.all(xs.map((x) => enqueueBgJob(pool, { accountId: x.accountId, kind: 'cleanup', input: {}, now: day }, env)));
      expect(rs.filter((r) => 'job' in r)).toHaveLength(1);
      expect(rs.filter((r) => 'refused' in r && r.refused === 'daily_cap')).toHaveLength(2);
    });
  });

  describe('cause bg:<jobId> — 서버 허용 목록', () => {
    it('밖 도구·입력 밖 스레드·메모 쓰기·core·지우기를 거절하고, 쓰기는 회차에 묶어 센다', async () => {
      const a = await agent('bg-m1');
      const ch = (await app.inject({ method: 'POST', url: '/channels', headers: auth(admin.token), payload: { name: 'bg-m1' } })).json().id as string;
      const root = (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(admin.token), payload: { body: 'input thread' } })).json().id as string;
      const other = (await app.inject({ method: 'POST', url: `/channels/${ch}/messages`, headers: auth(admin.token), payload: { body: 'not input' } })).json().id as string;
      const jobId = await runningJob(a.accountId, [root]);
      const turnId = randomUUID();
      const c = await connect(asAgent(a.accountId, { [CAUSE_HEADER]: `bg:${jobId}`, [TURN_ID_HEADER]: turnId }));
      try {
        expect((await call(c, 'message.post', { channelId: ch, body: 'leak' })).error.code).toBe('bg_tool_not_allowed');
        expect((await call(c, 'turn.wake', { channelId: ch, threadRootId: root, notBeforeSec: 60, reason: 'x' })).error.code).toBe('bg_tool_not_allowed');
        expect((await call(c, 'message.read', { channelId: ch, threadRootId: other })).error.code).toBe('bg_thread_not_in_input');
        expect((await call(c, 'message.read', { channelId: ch })).error.code).toBe('bg_thread_not_in_input');
        expect((await call(c, 'message.read', { channelId: ch, threadRootId: root })).messages.length).toBeGreaterThan(0);
        expect((await call(c, 'thread.note', { threadRootId: root, body: '덮기' })).error.code).toBe('bg_note_read_only');
        expect((await call(c, 'thread.note', { threadRootId: root })).note).toBeNull();
        expect((await call(c, 'memory.set', { slug: 'core', value: 'x' })).error.code).toBe('bg_core_forbidden');

        expect(await call(c, 'memory.set', { slug: 'mem/lesson', value: 'v1', kind: 'topic' })).toEqual({ ok: true });
        expect(await call(c, 'memory.set', { slug: 'mem/lesson', value: 'v2', kind: 'topic' })).toEqual({ ok: true });
        expect((await call(c, 'memory.set', { slug: 'mem/lesson', value: null })).error.code).toBe('bg_delete_forbidden');
        // 거절된 쓰기(kind 빠짐)는 상한을 쓰지 않는다.
        expect((await call(c, 'memory.set', { slug: 'mem/lesson', value: 'v3' })).error.code).toBe('kind_required');

        const job = (await pool.query(`select writes from bg_job where id = $1`, [jobId])).rows[0];
        expect(job.writes).toBe(2);
        const changes = (await pool.query(`select slug, op from bg_job_change where run_id = $1 order by id`, [jobId])).rows;
        expect(changes).toEqual([{ slug: 'mem/lesson', op: 'create' }, { slug: 'mem/lesson', op: 'update' }]);
        const rev = (await pool.query(`select run_id, turn_id from agent_memory_revision where account_id = $1 and slug = 'mem/lesson'`, [a.accountId])).rows;
        expect(rev).toEqual([{ run_id: jobId, turn_id: turnId }]);

        // merge 는 into 하나 + from 수만큼 센다(security F1): from 10개 merge 는 11건, 두 번째는 상한을 넘어 거절되고 아무것도 안 센다.
        const tens = Array.from({ length: 10 }, (_, i) => `mem/m${i}`);
        for (const sl of [...tens, ...tens.map((t) => `${t}b`)]) await pool.query(`insert into agent_memory (account_id, slug, value, kind) values ($1, $2, 'x', 'topic')`, [a.accountId, sl]);
        await pool.query(`update bg_job set writes = 0 where id = $1`, [jobId]);
        expect(await call(c, 'memory.merge', { into: 'mem/merged-a', from: tens, value: 'a', kind: 'topic' })).toMatchObject({ ok: true });
        expect((await pool.query(`select writes from bg_job where id = $1`, [jobId])).rows[0].writes).toBe(11);
        expect((await call(c, 'memory.merge', { into: 'mem/merged-b', from: tens.map((t) => `${t}b`), value: 'b', kind: 'topic' })).error.code).toBe('bg_write_limit');
        expect((await pool.query(`select writes from bg_job where id = $1`, [jobId])).rows[0].writes).toBe(11);
        expect((await pool.query(`select count(*)::int as n from bg_job_change where run_id = $1 and op = 'archive'`, [jobId])).rows[0].n).toBe(10);

        await pool.query(`update bg_job set writes = $2 where id = $1`, [jobId, BG_MAX_WRITES]);
        expect((await call(c, 'memory.set', { slug: 'mem/more', value: 'x', kind: 'topic' })).error.code).toBe('bg_write_limit');

        expect((await call(c, 'bg.complete', { jobId: randomUUID(), status: 'done' })).error.code).toBe('not_your_job');
        expect(await call(c, 'bg.complete', { jobId, status: 'done', summary: 'mem/lesson 갱신' })).toEqual({ ok: true });
        // 닫힌 회차의 세션으로는 아무것도 못 한다.
        expect((await call(c, 'memory.get', { slug: 'mem/lesson' })).error.code).toBe('bg_job_not_running');
      } finally { await c.close(); }
    });

    it('남의 회차 id·PAT 로 온 bg 꼴은 권한을 얻지 못한다', async () => {
      const a = await agent('bg-m2');
      const b = await agent('bg-m3');
      const jobOfB = await runningJob(b.accountId, []);
      const c = await connect(asAgent(a.accountId, { [CAUSE_HEADER]: `bg:${jobOfB}`, [TURN_ID_HEADER]: randomUUID() }));
      try {
        expect((await call(c, 'memory.get', { slug: 'mem/x' })).error.code).toBe('bg_job_not_running');
      } finally { await c.close(); }
      // PAT(오퍼레이터 없음)로 붙은 클라이언트의 bg 꼴은 무시된다 — 좁혀지지도, 회차를 닫지도 못한다.
      const p = await connect({ ...auth(a.pat), [CAUSE_HEADER]: `bg:${jobOfB}` });
      try {
        expect((await call(p, 'bg.complete', { jobId: jobOfB, status: 'done' })).error.code).toBe('not_your_job');
      } finally { await p.close(); }
    });

    it('bg.claim 은 러너만(턴 표지가 있으면 거절), 일반 턴은 회차를 닫지 못한다, 일반 턴의 쓰기도 turn_id 를 남긴다', async () => {
      const a = await agent('bg-m4');
      const turnId = randomUUID();
      const t = await connect(asAgent(a.accountId, { [TURN_ID_HEADER]: turnId }));
      try {
        expect((await call(t, 'bg.claim')).error.code).toBe('runner_only');
        const jobId = await runningJob(a.accountId, []);
        expect((await call(t, 'bg.complete', { jobId, status: 'done' })).error.code).toBe('not_your_job');
        await call(t, 'memory.set', { slug: 'mem/n', value: '1', kind: 'topic' });
        await call(t, 'memory.set', { slug: 'mem/n', value: '2', kind: 'topic' });
        const rev = (await pool.query(`select run_id, turn_id from agent_memory_revision where account_id = $1 and slug = 'mem/n'`, [a.accountId])).rows;
        expect(rev).toEqual([{ run_id: null, turn_id: turnId }]);
      } finally { await t.close(); }
      // 러너(턴 표지 없음)는 집을 수 있다 — 창·일감에 따라 job 이 null 일 뿐 거절은 아니다.
      const r = await connect(asAgent(a.accountId));
      try {
        const got = await call(r, 'bg.claim');
        expect(got.error).toBeUndefined();
        if (got.job === null) expect(['outside_window', 'none']).toContain(got.reason);
      } finally { await r.close(); }
    });
  });
});

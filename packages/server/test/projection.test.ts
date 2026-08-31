import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { startFakeAvcs } from './helpers/fakeAvcsServer.js';
import { httpAvcsClient, type AvcsServerClient } from '../src/avcs/client.js';
import { ProjectionWorker, ensureSystemAccount } from '../src/avcs/projection.js';
import { createChannel } from '../src/services/channels.js';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let pool: Pool;
let stop: () => Promise<void>;
let fake: Awaited<ReturnType<typeof startFakeAvcs>>;
let worker: ProjectionWorker;
let channelId: string;
const REPO = 'proj-repo';

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  fake = await startFakeAvcs();
  const systemAccountId = await ensureSystemAccount(pool);
  worker = new ProjectionWorker({ pool, avcs: httpAvcsClient(fake.url), systemAccountId });
  channelId = (await createChannel(pool, { name: 'proj', repo: REPO })).id;
});
afterAll(async () => { await fake.close(); await stop(); });

const messages = async () =>
  (await pool.query(
    `select body, kind, thread_root_id as root, meta from message where channel_id = $1 order by seq`,
    [channelId],
  )).rows;

describe('projection', () => {
  it('intent creates system message + work_thread; ops merge into one thread message', async () => {
    fake.push(REPO, { oid: 'i1', type: 'intent', actorKeyId: 'k9', intentOid: 'i1', summary: 'fix bug' });
    fake.push(REPO, { oid: 'op1', type: 'operation', actorKeyId: 'k9', intentOid: 'i1', summary: 'put_file a' });
    fake.push(REPO, { oid: 'op2', type: 'operation', actorKeyId: 'k9', intentOid: 'i1', summary: 'put_file b' });
    const applied = await worker.runOnce(REPO, channelId);
    expect(applied).toBe(3);

    const rows = await messages();
    expect(rows).toHaveLength(2); // intent 1 + 병합된 operation 1
    expect(rows[0].body).toContain('fix bug');
    expect(rows[0].body).toContain('외부 작업자(k9)'); // 미등록 키 → 외부 작업자 분기
    expect(rows[1].body).toContain('2 operations');
    expect(rows[1].root).not.toBeNull(); // 작업 스레드에 붙음
    expect(rows[1].meta.oid).toBe('op2'); // 병합 메시지의 대표 oid = 배치 내 마지막 op

    const wt = await pool.query(`select 1 from work_thread where repo = $1 and intent_oid = 'i1'`, [REPO]);
    expect(wt.rowCount).toBe(1);
  });

  it('is idempotent: rerun from cursor 0 does not duplicate', async () => {
    await pool.query(`update projection_cursor set last_log_index = 0 where repo = $1`, [REPO]);
    await worker.runOnce(REPO, channelId);
    expect(await messages()).toHaveLength(2);
  });

  it('decision lands in the work thread; finalize lands at channel level', async () => {
    fake.push(REPO, { oid: 'd1', type: 'decision', actorKeyId: 'k9', intentOid: 'i1', summary: 'kept ours' });
    fake.push(REPO, { oid: 'f1', type: 'finalize', actorKeyId: 'k9', intentOid: null, summary: 'head advanced' });
    await worker.runOnce(REPO, channelId);
    const rows = await messages();
    expect(rows).toHaveLength(4);
    expect(rows[2].body).toContain('kept ours');
    expect(rows[2].root).not.toBeNull();
    expect(rows[3].root).toBeNull();
  });

  it('lease updates active_lease state instead of messages', async () => {
    fake.push(REPO, { oid: 'l1', type: 'lease', actorKeyId: 'k9', intentOid: null, summary: 'lease src/x',
      lease: { path: 'src/x.ts', expiresAt: new Date(Date.now() + 60_000).toISOString(), released: false } });
    await worker.runOnce(REPO, channelId);
    const leases = await pool.query(`select path from active_lease where repo = $1`, [REPO]);
    expect(leases.rows.map((r) => r.path)).toEqual(['src/x.ts']);
    expect(await messages()).toHaveLength(4); // 메시지 증가 없음

    fake.push(REPO, { oid: 'l2', type: 'lease', actorKeyId: 'k9', intentOid: null, summary: 'release src/x',
      lease: { path: 'src/x.ts', expiresAt: new Date().toISOString(), released: true } });
    await worker.runOnce(REPO, channelId);
    const after = await pool.query(`select 1 from active_lease where repo = $1`, [REPO]);
    expect(after.rowCount).toBe(0);
  });

  it('actor label resolves @handle for a registered account_key', async () => {
    const acct = await pool.query(
      `insert into account (handle, display_name, kind) values ('alice', 'Alice', 'human') returning id`,
    );
    await pool.query(
      `insert into account_key (key_id, account_id, public_key_pem) values ('k-alice', $1, 'PEM')`,
      [acct.rows[0].id],
    );
    fake.push(REPO, { oid: 'c1', type: 'checkpoint', actorKeyId: 'k-alice', intentOid: null, summary: 'checkpoint cut' });
    await worker.runOnce(REPO, channelId);
    const rows = await messages();
    expect(rows).toHaveLength(5);
    expect(rows[4].body).toContain('@alice');
  });
});

// 감사 ⑤·⑥: start() 루프 자체(runOnce 직접 호출이 아니라)의 복구·격리를 검증한다.
// 전용 DB + 전용 fake avcs 서버로, 위 describe의 다른 bound repo와 완전히 분리한다.
describe('projection start() loop', () => {
  let pool2: Pool;
  let stop2: () => Promise<void>;
  let fake2: Awaited<ReturnType<typeof startFakeAvcs>>;
  let systemAccountId2: string;
  let real: AvcsServerClient;

  beforeAll(async () => {
    ({ pool: pool2, stop: stop2 } = await startTestDb());
    fake2 = await startFakeAvcs();
    systemAccountId2 = await ensureSystemAccount(pool2);
    real = httpAvcsClient(fake2.url);
  });
  afterAll(async () => { await fake2.close(); await stop2(); });

  it('recovers status().connected after a transient avcs failure and catches up (감사 ⑤)', async () => {
    const repo = 'flaky-repo';
    const channelId2 = (await createChannel(pool2, { name: 'flaky', repo })).id;

    // deps.avcs 를 감싸는 가변 프록시 — worker 는 URL을 다시 물 필요 없이, 테스트가
    // `failing` 플래그로 avcs 다운/복구를 시뮬레이션한다.
    let failing = false;
    const flaky: AvcsServerClient = {
      waitForChange: (r, since, timeoutMs) =>
        failing ? Promise.reject(new Error('injected avcs failure')) : real.waitForChange(r, since, timeoutMs),
      fetchSince: (r, since) =>
        failing ? Promise.reject(new Error('injected avcs failure')) : real.fetchSince(r, since),
    };

    const worker2 = new ProjectionWorker({ pool: pool2, avcs: flaky, systemAccountId: systemAccountId2 });
    worker2.start(50);
    try {
      await waitFor(() => worker2.status().connected === true); // 최초 성공: true
      failing = true;
      await waitFor(() => worker2.status().connected === false); // 장애 주입 후 백오프: false

      fake2.push(repo, { oid: 'i1', type: 'intent', actorKeyId: 'k1', intentOid: 'i1', summary: 'queued while down' });
      failing = false;
      await waitFor(() => worker2.status().connected === true); // 복구: true

      await waitFor(async () => {
        const rows = await pool2.query(`select 1 from message where channel_id = $1`, [channelId2]);
        return (rows.rowCount ?? 0) > 0;
      }); // 백오프 이후 따라잡기 — 큐에 쌓인 intent가 투영된다
    } finally {
      await worker2.stop();
    }
  });

  it('one repo failing forever does not block other repos in the same cycle (감사 ⑥)', async () => {
    const badRepo = 'bad-repo';
    const goodRepo = 'good-repo';
    const badChannelId = (await createChannel(pool2, { name: 'bad-ch', repo: badRepo })).id;
    const goodChannelId = (await createChannel(pool2, { name: 'good-ch', repo: goodRepo })).id;

    const mixed: AvcsServerClient = {
      waitForChange: (r, since, timeoutMs) =>
        r === badRepo ? Promise.reject(new Error('always fails')) : real.waitForChange(r, since, timeoutMs),
      fetchSince: (r, since) =>
        r === badRepo ? Promise.reject(new Error('always fails')) : real.fetchSince(r, since),
    };

    fake2.push(goodRepo, { oid: 'gi1', type: 'intent', actorKeyId: 'k1', intentOid: 'gi1', summary: 'good repo works' });

    const worker3 = new ProjectionWorker({ pool: pool2, avcs: mixed, systemAccountId: systemAccountId2 });
    worker3.start(50);
    try {
      await waitFor(async () => {
        const rows = await pool2.query(`select 1 from message where channel_id = $1`, [goodChannelId]);
        return (rows.rowCount ?? 0) > 0;
      }); // bad-repo가 영원히 실패해도 good-repo는 계속 투영된다
      const badRows = await pool2.query(`select 1 from message where channel_id = $1`, [badChannelId]);
      expect(badRows.rowCount).toBe(0);
    } finally {
      await worker3.stop();
    }
  });
});

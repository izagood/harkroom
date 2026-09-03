import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { createFakeAvcs, type FakeAvcs } from './helpers/fakeAvcs.js';
import type { AvcsServerClient } from '../src/avcs/client.js';
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
let fake: FakeAvcs;
let worker: ProjectionWorker;
let channelId: string;
const REPO = 'proj-repo';

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  fake = createFakeAvcs();
  const systemAccountId = await ensureSystemAccount(pool);
  worker = new ProjectionWorker({ pool, avcs: fake.client, systemAccountId });
  channelId = (await createChannel(pool, { name: 'proj', repo: REPO })).id;
});
afterAll(async () => { await stop(); });

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

  // avcs 로그에는 투영하지 않는 객체(blob·session·view …)가 섞여 있다. 그것들만 담긴 배치에서
  // 커서가 전진하지 않으면 waitForChange가 계속 "변경됨"을 돌려주며 백오프 없이 폴이 돌아간다.
  it('advances the cursor for a batch that yields no projectable messages', async () => {
    const repo = 'empty-batch-repo';
    const channel = await createChannel(pool, { name: 'empty-batch', repo });
    const silent: AvcsServerClient = {
      waitForChange: async () => true,
      fetchSince: async (_r, since) => ({ entries: [], next: since + 3 }),
    };
    const w = new ProjectionWorker({
      pool, avcs: silent, systemAccountId: await ensureSystemAccount(pool),
    });

    await w.runOnce(repo, channel.id);

    const cur = await pool.query(`select last_log_index from projection_cursor where repo = $1`, [repo]);
    expect(Number(cur.rows[0]?.last_log_index)).toBe(3);
  });

  it('leaves the cursor alone when the log holds nothing new at all', async () => {
    const repo = 'nothing-new-repo';
    const channel = await createChannel(pool, { name: 'nothing-new', repo });
    const idle: AvcsServerClient = {
      waitForChange: async () => false,
      fetchSince: async (_r, since) => ({ entries: [], next: since }),
    };
    const w = new ProjectionWorker({
      pool, avcs: idle, systemAccountId: await ensureSystemAccount(pool),
    });

    await w.runOnce(repo, channel.id);

    const cur = await pool.query(`select 1 from projection_cursor where repo = $1`, [repo]);
    expect(cur.rowCount).toBe(0); // 쓸데없는 트랜잭션/행 생성 없음
  });

  // 복구 시나리오 A: murmur DB 를 더 오래된 스냅샷으로 되돌린 경우. 커서가 뒤로 가고 이미
  // 투영된 구간을 다시 읽는데, (repo, oid) UNIQUE 로 중복이 생기지 않는다 — 이게 "murmur 를
  // 되돌려도 안전하다"의 근거다. (아래 기존 테스트가 그 성질을 지킨다.)
  it('is idempotent: rerun from cursor 0 does not duplicate', async () => {
    await pool.query(`update projection_cursor set last_log_index = 0 where repo = $1`, [REPO]);
    await worker.runOnce(REPO, channelId);
    expect(await messages()).toHaveLength(2);
  });

  // 복구 시나리오 B(위험한 쪽): **avcs 서버**를 murmur 커서보다 오래된 상태로 되돌린 경우.
  // 커서가 로그보다 앞서면 fetchSince 가 줄 게 없고, 커서는 후퇴하지 않는다 — 크래시는 없지만
  // avcs 로그가 커서를 다시 넘어설 때까지 **그 사이 객체가 조용히 건너뛰어진다.** 복구 절차
  // (docs/operations.md)가 "avcs 를 murmur 커서 뒤로 되돌리지 말라"고 말하는 근거를 고정한다.
  it('stalls without crashing when the cursor is ahead of the avcs log', async () => {
    const repo = 'avcs-rollback-repo';
    const channel = await createChannel(pool, { name: 'avcs-rollback', repo });
    const rolled = createFakeAvcs();
    const w = new ProjectionWorker({
      pool, avcs: rolled.client, systemAccountId: await ensureSystemAccount(pool),
    });
    rolled.push(repo, { oid: 'r1', type: 'intent', actorKeyId: 'k1', intentOid: 'r1', summary: 'before rollback' });
    expect(await w.runOnce(repo, channel.id)).toBe(1);

    // 커서를 로그보다 앞세운다 = avcs 가 더 오래된 상태로 복구된 상황
    await pool.query(`update projection_cursor set last_log_index = 100 where repo = $1`, [repo]);
    rolled.push(repo, { oid: 'r2', type: 'intent', actorKeyId: 'k1', intentOid: 'r2', summary: 'after rollback' });

    expect(await w.runOnce(repo, channel.id)).toBe(0); // 조용히 건너뛴다
    const cur = await pool.query(`select last_log_index from projection_cursor where repo = $1`, [repo]);
    expect(Number(cur.rows[0].last_log_index)).toBe(100); // 커서는 후퇴하지 않는다
    const rows = await pool.query(
      `select body from message where channel_id = $1 order by seq`, [channel.id],
    );
    expect(rows.rows.map((r) => r.body).join(' ')).not.toContain('after rollback');
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
      // 사람 계정은 login_id 가 필수다(#271, 033) — 직접 넣는 자리도 그것을 적어야 한다.
      `insert into account (handle, login_id, display_name, kind) values ('alice', 'alice', 'Alice', 'human') returning id`,
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

  // 서명자가 없는 객체(checkpoint 등)와 모르는 키로 서명된 객체는 다르다. 둘 다 '외부 작업자'로
  // 뭉뚱그리면 "서명이 없다"는 사실이 "외부에서 왔다"는 주장으로 바뀐다.
  it('labels an unsigned entry as having no actor, not as an external one', async () => {
    fake.push(REPO, { oid: 'cp-unsigned', type: 'checkpoint', actorKeyId: null, intentOid: null, summary: '서명 없는 체크포인트' });
    await worker.runOnce(REPO, channelId);
    const rows = await messages();
    const body = rows.at(-1)!.body as string;
    expect(body).toContain('서명 없는 체크포인트');
    expect(body).not.toContain('외부 작업자');
  });
});

// 감사 ⑤·⑥: start() 루프 자체(runOnce 직접 호출이 아니라)의 복구·격리를 검증한다.
// 전용 DB + 전용 fake avcs 서버로, 위 describe의 다른 bound repo와 완전히 분리한다.
describe('projection start() loop', () => {
  let pool2: Pool;
  let stop2: () => Promise<void>;
  let fake2: FakeAvcs;
  let systemAccountId2: string;
  let real: AvcsServerClient;

  beforeAll(async () => {
    ({ pool: pool2, stop: stop2 } = await startTestDb());
    fake2 = createFakeAvcs();
    systemAccountId2 = await ensureSystemAccount(pool2);
    real = fake2.client;
  });
  afterAll(async () => { await stop2(); });

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

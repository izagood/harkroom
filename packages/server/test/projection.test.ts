import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { createFakeAvcs, type FakeAvcs } from './helpers/fakeAvcs.js';
import type { AvcsServerClient } from '../src/avcs/client.js';
import { ProjectionWorker } from '../src/avcs/projection.js';
import { createChannel } from '../src/services/channels.js';

/**
 * 스레드 투영을 걷어낸 뒤 남은 회귀선.
 *
 * **없어진 테스트와 그 이유** — 단언을 뒤집은 것이 아니라, 지키려던 성질 자체가 사라졌다:
 * - `intent creates system message + work_thread; ops merge into one thread message`
 *   intent 가 스레드 뿌리가 되고 배치 내 operation 이 한 메시지로 병합되는 규칙을 지켰다.
 *   메시지를 만들지 않으므로 병합할 것도, 붙일 뿌리도 없다.
 * - `decision lands in the work thread; finalize lands at channel level`
 *   "무엇은 스레드로, 무엇은 채널로"라는 분류를 지켰다. 두 목적지가 다 없어졌다.
 * - `actor label resolves @handle for a registered account_key` / `labels an unsigned entry
 *   as having no actor, not as an external one`
 *   둘 다 `actorLabel` 이 만드는 **메시지 본문 문구**를 지켰다("서명이 없다"를 "외부에서
 *   왔다"로 바꿔 쓰지 말 것). 문구를 쓰는 자리가 없어져 함수째 사라졌다. avcs 서명자를
 *   화면에 어떻게 표기할지는 협업 탭이 다시 정할 문제이고, 그때 그 자리에서 지켜야 한다.
 *
 * **살린 것**: 커서 전진 규칙(둘), avcs 롤백 시 무크래시, 멱등성, lease 투영, start()
 * 루프의 복구(감사 ⑤)와 repo 격리(감사 ⑥). 이것들은 lease 만 남아도 그대로 필요하다 —
 * 오히려 커서 전진 규칙은 lease 아닌 객체가 대다수가 된 지금 더 자주 걸리는 경로다.
 *
 * 관찰 지점이 메시지에서 `active_lease` 로 바뀌었다. "투영됐다"를 확인할 수 있는 유일한
 * 산출물이 그것이기 때문이고, 커서만 보면 "읽었다"까지만 알 수 있어 실제로 접었는지는
 * 지켜지지 않는다.
 */

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
// 이 파일의 모든 워커가 같은 서버를 본다고 가정한다 — `baseUrl` 이 필요해졌을 뿐,
// 여러 avcs 서버를 구별하는 것은 이 파일의 관심사가 아니다(그건 projectionServerScope.test.ts).
const BASE_URL = 'http://avcs.test';

/** 만료가 넉넉한 lease 엔트리 한 건. 시각 비교가 아니라 존재 여부를 보는 테스트들이 쓴다. */
const leaseEntry = (oid: string, path: string, released = false, actorKeyId: string | null = 'k9') => ({
  oid, type: 'lease' as const, actorKeyId, intentOid: null, summary: `lease ${path}`,
  lease: { path, expiresAt: new Date(Date.now() + 60_000).toISOString(), released },
});

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  fake = createFakeAvcs();
  worker = new ProjectionWorker({ pool, avcs: fake.client, baseUrl: BASE_URL });
  channelId = (await createChannel(pool, { name: 'proj', repo: REPO })).id;
});
afterAll(async () => { await stop(); });

const messages = async () =>
  (await pool.query(
    `select body, kind, thread_root_id as root, meta from message where channel_id = $1 order by seq`,
    [channelId],
  )).rows;

const leasePaths = async (repo: string) =>
  (await pool.query(`select path from active_lease where repo = $1 order by path`, [repo]))
    .rows.map((r) => r.path as string);

describe('projection', () => {
  // 걷어낸 것의 대조군. 위 세 테스트를 지운 자리에 이것을 둔다 — 지운 성질의 **반대**를
  // 고정해야 투영이 슬그머니 돌아오는 것을 회귀선이 잡는다. 이것이 없으면 "메시지를
  // 만들지 않는다"는 결정이 코드에만 있고 테스트에는 없다.
  it('avcs 거버넌스 객체는 메시지도 스레드도 만들지 않는다', async () => {
    fake.push(REPO, { oid: 'i1', type: 'intent', actorKeyId: 'k9', intentOid: 'i1', summary: 'fix bug' });
    fake.push(REPO, { oid: 'op1', type: 'operation', actorKeyId: 'k9', intentOid: 'i1', summary: 'put_file a' });
    fake.push(REPO, { oid: 'op2', type: 'operation', actorKeyId: 'k9', intentOid: 'i1', summary: 'put_file b' });
    fake.push(REPO, { oid: 'd1', type: 'decision', actorKeyId: 'k9', intentOid: 'i1', summary: 'kept ours' });
    fake.push(REPO, { oid: 'e1', type: 'evidence', actorKeyId: 'k9', intentOid: 'i1', summary: 'tests pass' });
    fake.push(REPO, { oid: 'f1', type: 'finalize', actorKeyId: 'k9', intentOid: null, summary: 'head advanced' });
    fake.push(REPO, { oid: 'c1', type: 'checkpoint', actorKeyId: null, intentOid: null, summary: 'checkpoint cut' });

    // 읽은 엔트리 수는 그대로 센다 — 남기는 것이 없어도 로그를 지나갔다는 사실은 다르다.
    expect(await worker.runOnce(REPO)).toBe(7);

    expect(await messages()).toHaveLength(0);
    // 커서는 전진했다. 즉 "조용히 실패해서 아무것도 안 생긴 것"이 아니라 **읽고 나서
    // 남기지 않기로 한 것**이다. 이 단언이 둘을 가른다.
    const cur = await pool.query(`select last_log_index from projection_cursor where repo = $1`, [REPO]);
    expect(Number(cur.rows[0].last_log_index)).toBe(7);
  });

  // avcs 로그에는 투영하지 않는 객체(blob·session·view …)가 섞여 있다. 그것들만 담긴 배치에서
  // 커서가 전진하지 않으면 waitForChange가 계속 "변경됨"을 돌려주며 백오프 없이 폴이 돌아간다.
  it('advances the cursor for a batch that yields no projectable messages', async () => {
    const repo = 'empty-batch-repo';
    await createChannel(pool, { name: 'empty-batch', repo });
    const silent: AvcsServerClient = {
      waitForChange: async () => true,
      fetchSince: async (_r, since) => ({ entries: [], next: since + 3 }),
    };
    const w = new ProjectionWorker({ pool, avcs: silent, baseUrl: BASE_URL });

    await w.runOnce(repo);

    const cur = await pool.query(`select last_log_index from projection_cursor where repo = $1`, [repo]);
    expect(Number(cur.rows[0]?.last_log_index)).toBe(3);
  });

  it('leaves the cursor alone when the log holds nothing new at all', async () => {
    const repo = 'nothing-new-repo';
    await createChannel(pool, { name: 'nothing-new', repo });
    const idle: AvcsServerClient = {
      waitForChange: async () => false,
      fetchSince: async (_r, since) => ({ entries: [], next: since }),
    };
    const w = new ProjectionWorker({ pool, avcs: idle, baseUrl: BASE_URL });

    await w.runOnce(repo);

    const cur = await pool.query(`select 1 from projection_cursor where repo = $1`, [repo]);
    expect(cur.rowCount).toBe(0); // 쓸데없는 트랜잭션/행 생성 없음
  });

  /**
   * 복구 시나리오 A: murmur DB 를 더 오래된 스냅샷으로 되돌린 경우. 커서가 뒤로 가고 이미
   * 투영된 구간을 다시 읽는데, 결과가 중복되지 않아야 한다 — 이게 "murmur 를 되돌려도
   * 안전하다"의 근거다.
   *
   * **멱등성의 근거가 바뀌었다.** 예전에는 `message_avcs_oid` 유니크 인덱스(투영 전용)가
   * 같은 oid 의 메시지를 두 번 넣지 못하게 막았다. 그 인덱스는 040 에서 사라졌고, 이제
   * 근거는 `active_lease` 의 upsert 다 — `(repo, avcs_base_url, path, actor_key_id)` 가
   * 기본키라서(042) 같은 구간을 몇 번 접어도 결과가 같다. 즉 멱등성은 **인덱스가 막아서**가
   * 아니라 **연산이 멱등해서** 성립한다. 인덱스 없이도 성립한다는 것을 확인하는 것이 이
   * 테스트다.
   */
  it('is idempotent: rerun from cursor 0 does not duplicate', async () => {
    fake.push(REPO, leaseEntry('l-idem', 'src/idem.ts'));
    await worker.runOnce(REPO);
    expect(await leasePaths(REPO)).toEqual(['src/idem.ts']);

    await pool.query(`update projection_cursor set last_log_index = 0 where repo = $1`, [REPO]);
    await worker.runOnce(REPO);

    expect(await leasePaths(REPO)).toEqual(['src/idem.ts']); // 행이 둘로 갈라지지 않는다
    expect(await messages()).toHaveLength(0); // 재적용이 메시지를 되살리지도 않는다
  });

  // 복구 시나리오 B(위험한 쪽): **avcs 서버**를 murmur 커서보다 오래된 상태로 되돌린 경우.
  // 커서가 로그보다 앞서면 fetchSince 가 줄 게 없고, 커서는 후퇴하지 않는다 — 크래시는 없지만
  // avcs 로그가 커서를 다시 넘어설 때까지 **그 사이 객체가 조용히 건너뛰어진다.** 복구 절차
  // (docs/operations.md)가 "avcs 를 murmur 커서 뒤로 되돌리지 말라"고 말하는 근거를 고정한다.
  it('stalls without crashing when the cursor is ahead of the avcs log', async () => {
    const repo = 'avcs-rollback-repo';
    await createChannel(pool, { name: 'avcs-rollback', repo });
    const rolled = createFakeAvcs();
    const w = new ProjectionWorker({ pool, avcs: rolled.client, baseUrl: BASE_URL });
    rolled.push(repo, leaseEntry('r1', 'src/before.ts'));
    expect(await w.runOnce(repo)).toBe(1);
    expect(await leasePaths(repo)).toEqual(['src/before.ts']);

    // 커서를 로그보다 앞세운다 = avcs 가 더 오래된 상태로 복구된 상황
    await pool.query(`update projection_cursor set last_log_index = 100 where repo = $1`, [repo]);
    rolled.push(repo, leaseEntry('r2', 'src/after.ts'));

    expect(await w.runOnce(repo)).toBe(0); // 조용히 건너뛴다
    const cur = await pool.query(`select last_log_index from projection_cursor where repo = $1`, [repo]);
    expect(Number(cur.rows[0].last_log_index)).toBe(100); // 커서는 후퇴하지 않는다
    // 건너뛴 구간의 lease 는 반영되지 않는다 — 이것이 "조용히 건너뛴다"의 실제 대가다.
    expect(await leasePaths(repo)).toEqual(['src/before.ts']);
  });

  it('lease updates active_lease state instead of messages', async () => {
    const repo = 'lease-repo';
    await createChannel(pool, { name: 'lease-ch', repo });
    const leases = createFakeAvcs();
    const w = new ProjectionWorker({ pool, avcs: leases.client, baseUrl: BASE_URL });

    leases.push(repo, leaseEntry('l1', 'src/x.ts'));
    await w.runOnce(repo);
    expect(await leasePaths(repo)).toEqual(['src/x.ts']);
    expect(await messages()).toHaveLength(0); // 메시지 증가 없음

    leases.push(repo, leaseEntry('l2', 'src/x.ts', true));
    await w.runOnce(repo);
    expect(await leasePaths(repo)).toEqual([]);
  });

  // 같은 경로를 서로 다른 작업자가 잡으면 **둘 다 남아야 한다** — 그것이 곧 충돌이고,
  // 협업 탭이 그 판정에 쓸 재료다. 한쪽이 다른 쪽을 덮으면 충돌 자체가 보이지 않는다.
  it('keeps one row per actor for the same path — that is the conflict', async () => {
    const repo = 'lease-conflict-repo';
    await createChannel(pool, { name: 'lease-conflict', repo });
    const conflict = createFakeAvcs();
    const w = new ProjectionWorker({ pool, avcs: conflict.client, baseUrl: BASE_URL });

    conflict.push(repo, leaseEntry('ca', 'src/hot.ts', false, 'key-a'));
    conflict.push(repo, leaseEntry('cb', 'src/hot.ts', false, 'key-b'));
    await w.runOnce(repo);

    const rows = await pool.query(
      `select actor_key_id from active_lease where repo = $1 and path = 'src/hot.ts' order by actor_key_id`,
      [repo],
    );
    expect(rows.rows.map((r) => r.actor_key_id)).toEqual(['key-a', 'key-b']);

    // 한쪽만 놓아도 다른 쪽은 남는다 — 해제가 경로 단위가 아니라 작업자 단위다.
    conflict.push(repo, leaseEntry('ca-rel', 'src/hot.ts', true, 'key-a'));
    await w.runOnce(repo);
    const after = await pool.query(
      `select actor_key_id from active_lease where repo = $1 and path = 'src/hot.ts'`, [repo],
    );
    expect(after.rows.map((r) => r.actor_key_id)).toEqual(['key-b']);
  });
});

// 감사 ⑤·⑥: start() 루프 자체(runOnce 직접 호출이 아니라)의 복구·격리를 검증한다.
// 전용 DB + 전용 fake avcs 서버로, 위 describe의 다른 bound repo와 완전히 분리한다.
//
// 관찰 대상이 메시지에서 lease 로 바뀌었다. 커서로 확인하지 않는 이유: 커서는 실패한
// 사이클에서도 "읽을 게 없었다"로 전진할 수 있어, 따라잡기가 실제로 일어났는지 가른다는
// 보장이 없다. lease 행은 접기가 끝까지 갔을 때만 생긴다.
describe('projection start() loop', () => {
  let pool2: Pool;
  let stop2: () => Promise<void>;
  let fake2: FakeAvcs;
  let real: AvcsServerClient;

  beforeAll(async () => {
    ({ pool: pool2, stop: stop2 } = await startTestDb());
    fake2 = createFakeAvcs();
    real = fake2.client;
  });
  afterAll(async () => { await stop2(); });

  const leaseCount = async (repo: string): Promise<number> =>
    (await pool2.query(`select count(*)::int as cnt from active_lease where repo = $1`, [repo]))
      .rows[0].cnt as number;

  it('recovers status().connected after a transient avcs failure and catches up (감사 ⑤)', async () => {
    const repo = 'flaky-repo';
    await createChannel(pool2, { name: 'flaky', repo });

    // deps.avcs 를 감싸는 가변 프록시 — worker 는 URL을 다시 물 필요 없이, 테스트가
    // `failing` 플래그로 avcs 다운/복구를 시뮬레이션한다.
    let failing = false;
    const flaky: AvcsServerClient = {
      waitForChange: (r, since, timeoutMs) =>
        failing ? Promise.reject(new Error('injected avcs failure')) : real.waitForChange(r, since, timeoutMs),
      fetchSince: (r, since) =>
        failing ? Promise.reject(new Error('injected avcs failure')) : real.fetchSince(r, since),
    };

    const worker2 = new ProjectionWorker({ pool: pool2, avcs: flaky, baseUrl: BASE_URL });
    worker2.start(50);
    try {
      await waitFor(() => worker2.status().connected === true); // 최초 성공: true
      failing = true;
      await waitFor(() => worker2.status().connected === false); // 장애 주입 후 백오프: false

      fake2.push(repo, leaseEntry('fl1', 'src/queued.ts'));
      failing = false;
      await waitFor(() => worker2.status().connected === true); // 복구: true

      // 백오프 이후 따라잡기 — 큐에 쌓인 lease 가 반영된다
      await waitFor(async () => (await leaseCount(repo)) > 0);
    } finally {
      await worker2.stop();
    }
  });

  it('one repo failing forever does not block other repos in the same cycle (감사 ⑥)', async () => {
    const badRepo = 'bad-repo';
    const goodRepo = 'good-repo';
    await createChannel(pool2, { name: 'bad-ch', repo: badRepo });
    await createChannel(pool2, { name: 'good-ch', repo: goodRepo });

    const mixed: AvcsServerClient = {
      waitForChange: (r, since, timeoutMs) =>
        r === badRepo ? Promise.reject(new Error('always fails')) : real.waitForChange(r, since, timeoutMs),
      fetchSince: (r, since) =>
        r === badRepo ? Promise.reject(new Error('always fails')) : real.fetchSince(r, since),
    };

    fake2.push(goodRepo, leaseEntry('gl1', 'src/good.ts'));
    fake2.push(badRepo, leaseEntry('bl1', 'src/bad.ts'));

    const worker3 = new ProjectionWorker({ pool: pool2, avcs: mixed, baseUrl: BASE_URL });
    worker3.start(50);
    try {
      // bad-repo가 영원히 실패해도 good-repo는 계속 투영된다
      await waitFor(async () => (await leaseCount(goodRepo)) > 0);
      expect(await leaseCount(badRepo)).toBe(0);
    } finally {
      await worker3.stop();
    }
  });
});

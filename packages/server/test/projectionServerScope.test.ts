/**
 * Task 8 회귀선 — 투영 상태(커서·리스)가 (repo, avcs 서버)로 키가 잡혀 있는가.
 *
 * `last_log_index` 는 **그 avcs 서버의** 로그 안 위치다. 같은 repo 이름이 여러 avcs 서버
 * 아래 있을 수 있으므로(로컬에도 izagood/murmur, VM 에도 izagood/murmur), 키에서
 * `avcs_base_url` 을 빼면 서버를 바꿔 탄 새 워커가 옛 서버의 커서를 그대로 물려받아
 * "5000 이후엔 없다"를 영원히 듣는다 — 커서는 얼어붙는데 `lastPolledAt` 은 계속
 * 갱신되어 상태는 `ok` 로 남고, 옛 서버의 낡은 리스가 현재 활성 작업으로 보인다.
 * (`042_projection_state_per_server.sql`, 설계 §4-1)
 *
 * **되돌리기 실험**: `projection.ts` 의 SQL 여섯 곳(또는 `directoryRoutes.ts`·
 * `buildServer.ts` 의 스코프)에서 `avcs_base_url` 조건을 하나라도 빼면 이 파일의 해당
 * 테스트가 죽는다 — 각 테스트 설명에 어떤 되돌리기가 무엇을 깨는지 적어 둔다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { resolveProjectionUrl } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { createFakeAvcs } from './helpers/fakeAvcs.js';
import type { AvcsServerClient } from '../src/avcs/client.js';
import { ProjectionWorker } from '../src/avcs/projection.js';
import { buildServer } from '../src/buildServer.js';
import { createChannel } from '../src/services/channels.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

const SERVER_A = 'http://avcs-a.test';
const SERVER_B = 'http://avcs-b.test';

/** `fetchSince` 에 실제로 넘어간 `since` 값을 기록하는 얇은 감시 래퍼. */
function recording(client: AvcsServerClient): { client: AvcsServerClient; sinceSeen: number[] } {
  const sinceSeen: number[] = [];
  return {
    sinceSeen,
    client: {
      waitForChange: (r, s, t) => client.waitForChange(r, s, t),
      fetchSince: (r, s) => { sinceSeen.push(s); return client.fetchSince(r, s); },
    },
  };
}

const lease = (oid: string, path: string, actorKeyId = 'k1') => ({
  oid, type: 'lease' as const, actorKeyId, intentOid: null, summary: `lease ${path}`,
  lease: { path, expiresAt: new Date(Date.now() + 60_000).toISOString(), released: false },
});

const release = (oid: string, path: string, actorKeyId = 'k1') => ({
  oid, type: 'lease' as const, actorKeyId, intentOid: null, summary: `release ${path}`,
  lease: { path, expiresAt: new Date(Date.now() + 60_000).toISOString(), released: true },
});

/**
 * `waitForChange` 에 실제로 넘어간 `(repo, since)` 를 기록하는 감시 래퍼(B-1 이 이걸로
 * 폴 루프를 본다). `start()` 루프는 **바인딩된 모든 repo** 를 도므로(이 파일의 다른 describe
 * 가 만든 채널도 포함) `repo` 별로 걸러야 대상 repo 의 호출만 볼 수 있다.
 */
function recordingWait(
  client: AvcsServerClient,
): { client: AvcsServerClient; calls: { repo: string; since: number }[] } {
  const calls: { repo: string; since: number }[] = [];
  return {
    calls,
    client: {
      waitForChange: (r, s, t) => { calls.push({ repo: r, since: s }); return client.waitForChange(r, s, t); },
      fetchSince: (r, s) => client.fetchSince(r, s),
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let pool: Pool;
let stop: () => Promise<void>;

beforeAll(async () => { ({ pool, stop } = await startTestDb()); });
afterAll(async () => { await stop(); });

describe('투영 상태는 (repo, avcs 서버) 로 키가 잡힌다', () => {
  it('다른 서버의 같은 repo 는 커서를 공유하지 않고, 새 서버의 커서는 얼어붙지 않는다', async () => {
    const repo = 'shared/repo';
    await createChannel(pool, { name: 'shared', repo });

    // 서버 A: 커서를 4까지 올린다.
    const fakeA = createFakeAvcs();
    fakeA.push(repo, lease('a1', 'src/a1.ts'));
    fakeA.push(repo, lease('a2', 'src/a2.ts'));
    fakeA.push(repo, lease('a3', 'src/a3.ts'));
    fakeA.push(repo, lease('a4', 'src/a4.ts'));
    const workerA = new ProjectionWorker({ pool, avcs: fakeA.client, baseUrl: SERVER_A });
    expect(await workerA.runOnce(repo)).toBe(4);
    const curA = await pool.query(
      `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2`,
      [repo, SERVER_A],
    );
    expect(Number(curA.rows[0]?.last_log_index)).toBe(4);

    // 같은 repo 이름, 다른 avcs 서버(B). B 의 로그는 A 와 무관하게 2개뿐이다.
    const fakeB = createFakeAvcs();
    fakeB.push(repo, lease('b1', 'src/b1.ts'));
    fakeB.push(repo, lease('b2', 'src/b2.ts'));
    const rec = recording(fakeB.client);
    const workerB = new ProjectionWorker({ pool, avcs: rec.client, baseUrl: SERVER_B });

    await workerB.runOnce(repo);

    // 되돌리기 실험: `runOnce` 의 커서 읽기에서 `avcs_base_url` 조건을 빼면 B 가 A 의
    // 커서(4)를 읽어 `since: 4` 로 fetchSince 를 부른다 — 이 단언이 그것을 잡는다.
    expect(rec.sinceSeen).toEqual([0]);

    // 얼어붙지 않는다 — B 의 커서가 B 의 로그 길이(2)만큼 실제로 전진했다.
    const curB = await pool.query(
      `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2`,
      [repo, SERVER_B],
    );
    expect(Number(curB.rows[0]?.last_log_index)).toBe(2);

    // A 의 커서는 B 가 지나가도 그대로다 — 서로 다른 행이라는 뜻이다.
    const curAAfter = await pool.query(
      `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2`,
      [repo, SERVER_A],
    );
    expect(Number(curAAfter.rows[0]?.last_log_index)).toBe(4);
  });

  it('레거시 행(avcs_base_url = \'\')은 실제 URL 과 일치하지 않아 첫 폴링이 0 에서 시작한다', async () => {
    const repo = 'legacy/repo';
    await createChannel(pool, { name: 'legacy', repo });
    // 042 이전에 쌓인 행을 흉내낸다 — 마이그레이션은 이 행을 지우지 않고 `''` 로 남긴다.
    await pool.query(
      `insert into projection_cursor (repo, avcs_base_url, last_log_index) values ($1, '', 9999)`,
      [repo],
    );

    const fake = createFakeAvcs();
    fake.push(repo, lease('l1', 'src/l1.ts'));
    const rec = recording(fake.client);
    const worker = new ProjectionWorker({ pool, avcs: rec.client, baseUrl: 'http://avcs-real.test' });

    await worker.runOnce(repo);

    // `''` 는 어떤 실제 URL 과도 다르므로 실제 서버 행이 없어 since=0 부터 다시 읽는다.
    expect(rec.sinceSeen).toEqual([0]);
    const cur = await pool.query(
      `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2`,
      [repo, 'http://avcs-real.test'],
    );
    expect(Number(cur.rows[0]?.last_log_index)).toBe(1);
    // 레거시 행 자체는 손대지 않는다 — 지우는 것은 이 마이그레이션의 결정이 아니다.
    const legacy = await pool.query(
      `select last_log_index from projection_cursor where repo = $1 and avcs_base_url = ''`,
      [repo],
    );
    expect(Number(legacy.rows[0]?.last_log_index)).toBe(9999);
  });

  /**
   * Minor 3 회귀선 — URL 표준형이 없으면 겉모습만 다른 두 문자열이 서로 다른 키가 된다.
   * `resolveProjectionUrl` 이 env·app 양쪽 값에 `canonicalAvcsBaseUrl` 을 적용하므로,
   * 서버가 `AVCS_BASE_URL=http://canon-avcs.test:80/` 로 부팅했다가 admin 이 나중에
   * `http://canon-avcs.test` 를 저장해도 같은 avcs 서버로 인식되어 커서를 공유한다.
   *
   * 되돌리기 실험: 표준화를 `resolveProjectionUrl` 이 아니라 PUT 스키마에만 넣으면(리뷰가
   * "절반만 닫힌다"고 잡은 지점), 아래 두 `resolveProjectionUrl` 호출이 서로 다른 문자열을
   * 돌려주고, `since` 가 1 이 아니라 0 으로 되돌아가 이 테스트가 죽는다.
   */
  it('같은 서버를 표기만 달리 저장해도 커서를 공유한다 (URL 표준형)', async () => {
    const repo = 'canon/repo';
    await createChannel(pool, { name: 'canon', repo });

    // 부팅 시 env: 후행 슬래시 + 기본 포트 80 명시.
    const bootUrl = resolveProjectionUrl('http://canon-avcs.test:80/', null).url;
    const fake = createFakeAvcs();
    fake.push(repo, lease('c1', 'src/c1.ts'));
    const worker1 = new ProjectionWorker({ pool, avcs: fake.client, baseUrl: bootUrl! });
    expect(await worker1.runOnce(repo)).toBe(1);

    // 나중에 admin 이 저장한 app 값: 겉보기만 다르다(슬래시·포트 없음).
    const savedUrl = resolveProjectionUrl(null, 'http://canon-avcs.test').url;
    expect(savedUrl).toBe(bootUrl); // 표준형이 같다 — 이것이 Minor 3 의 존재 이유다

    fake.push(repo, lease('c2', 'src/c2.ts'));
    const rec = recording(fake.client);
    const worker2 = new ProjectionWorker({ pool, avcs: rec.client, baseUrl: savedUrl! });
    await worker2.runOnce(repo);

    // since 가 이어진다(1) — 표준형이 같으므로 같은 행을 본다. 되돌리면 0 부터 다시 읽는다.
    expect(rec.sinceSeen).toEqual([1]);
  });

  /**
   * Important B-1. 위 테스트들은 전부 `runOnce` 를 **직접** 부르므로 `start()` 폴 루프 안의
   * `since` 읽기(버그 서사의 바로 그 쿼리)를 밟지 않는다 — 이 테스트가 그 자리를 밟는다.
   *
   * 되돌리기 실험: `projection.ts` `start()` 안 `select last_log_index ... where repo = $1`
   * 에서 `and avcs_base_url = $2` 를 빼면, B 가 A 의 커서(3)를 읽어 `waitForChange(repo, 3, …)`
   * 를 부른다 — 원래 결함(`waitForChange(repo, 5000)` → 영구 동결, `lastPolledAt` 은 계속
   * 갱신되어 `state: ok`)이 그대로 재현되는 지점이다.
   */
  it('start() 의 폴 루프도 현재 서버로 커서를 읽는다', async () => {
    const repo = 'poll-scope/repo';
    await createChannel(pool, { name: 'poll-scope', repo });

    // 서버 A: 커서를 3까지 올린다.
    const fakeA = createFakeAvcs();
    fakeA.push(repo, lease('pa1', 'src/pa1.ts'));
    fakeA.push(repo, lease('pa2', 'src/pa2.ts'));
    fakeA.push(repo, lease('pa3', 'src/pa3.ts'));
    const workerA = new ProjectionWorker({ pool, avcs: fakeA.client, baseUrl: SERVER_A });
    expect(await workerA.runOnce(repo)).toBe(3);

    // 서버 B: start() 루프로 같은 repo 를 본다. 기본 25초를 기다리지 않도록 짧은 pollMs.
    // (이 파일의 다른 describe 가 만든 채널도 같은 pool 에 바인딩돼 있어, start() 는 이
    // repo 만 도는 것이 아니다 — 그래서 repo 로 걸러 본다.)
    const fakeB = createFakeAvcs();
    const rec = recordingWait(fakeB.client);
    const workerB = new ProjectionWorker({ pool, avcs: rec.client, baseUrl: SERVER_B });

    workerB.start(20);
    try {
      await waitFor(() => rec.calls.some((c) => c.repo === repo));
    } finally {
      await workerB.stop();
    }

    const call = rec.calls.find((c) => c.repo === repo);
    expect(call?.since).toBe(0);
  });

  /**
   * Important B-2. `active_lease` 의 release(delete)도 `avcs_base_url` 로 좁혀야 한다.
   * `projection.test.ts` 의 release 테스트는 서버 하나만 다루므로 이 조건이 빠져도 통과한다.
   *
   * 되돌리기 실험: `delete from active_lease where repo = $1 and path = $2 and actor_key_id = $3`
   * 처럼 `avcs_base_url` 조건을 빼면, B 의 release 가 (repo, path, actor_key_id) 가 같은 A 의
   * 행까지 지운다 — 이 단언(A 의 행이 남아 있다)이 그것을 잡는다.
   */
  it('리스 해제(delete)도 현재 서버로만 지운다', async () => {
    const repo = 'release-scope/repo';
    await createChannel(pool, { name: 'release-scope', repo });

    const fakeA = createFakeAvcs();
    const workerA = new ProjectionWorker({ pool, avcs: fakeA.client, baseUrl: SERVER_A });
    fakeA.push(repo, lease('ra1', 'src/hot.ts'));
    await workerA.runOnce(repo);

    const fakeB = createFakeAvcs();
    const workerB = new ProjectionWorker({ pool, avcs: fakeB.client, baseUrl: SERVER_B });
    fakeB.push(repo, lease('rb1', 'src/hot.ts')); // 같은 (repo, path, actor_key_id), 다른 서버
    await workerB.runOnce(repo);

    const before = await pool.query(
      `select avcs_base_url from active_lease where repo = $1 and path = 'src/hot.ts' order by avcs_base_url`,
      [repo],
    );
    expect(before.rows.map((r) => r.avcs_base_url)).toEqual([SERVER_A, SERVER_B]);

    // B 에서만 release 를 투영한다.
    fakeB.push(repo, release('rb-rel', 'src/hot.ts'));
    await workerB.runOnce(repo);

    const after = await pool.query(
      `select avcs_base_url from active_lease where repo = $1 and path = 'src/hot.ts'`,
      [repo],
    );
    expect(after.rows.map((r) => r.avcs_base_url)).toEqual([SERVER_A]); // A 의 행은 그대로 남는다
  });
});

describe('/leases 가 현재 서버로 스코프된다', () => {
  let app: FastifyInstance;
  let appPool: Pool;
  let appStop: () => Promise<void>;
  let adminToken: string;
  let currentUrl: string | null;

  beforeAll(async () => {
    ({ pool: appPool, stop: appStop } = await startTestDb());
    app = await buildServer({
      pool: appPool,
      projection: {
        envBaseUrl: null,
        reconfigure: async () => {},
        // 테스트가 값을 바꿔 가며 "지금 보고 있는 서버"를 흉내낸다.
        currentUrl: () => currentUrl,
      },
    });
    ({ token: adminToken } = await bootstrapAdmin(app));
  });
  afterAll(async () => { await app.close(); await appStop(); });

  it('A 와 B 의 리스를 각각 심어도 현재 서버(B)의 것만 나온다', async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    currentUrl = SERVER_B;
    await appPool.query(
      `insert into active_lease (repo, avcs_base_url, path, actor_key_id, expires_at)
       values ('r1', $1, 'src/only-a.ts', 'k1', now() + interval '1 minute'),
              ('r1', $2, 'src/only-b.ts', 'k1', now() + interval '1 minute')`,
      [SERVER_A, SERVER_B],
    );

    const res = await app.inject({ method: 'GET', url: '/leases', headers: auth });
    const paths = (res.json().leases as { path: string }[]).map((l) => l.path);

    // 되돌리기 실험: 라우트의 `and avcs_base_url = $1` 을 빼면 A 의 리스도 섞여 나온다.
    expect(paths).toEqual(['src/only-b.ts']);
  });

  it('투영이 꺼져 있으면(currentUrl 이 null) 리스가 빈 목록이다', async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    currentUrl = null;
    const res = await app.inject({ method: 'GET', url: '/leases', headers: auth });
    // 위 테스트가 심은 리스가 DB 에 남아 있어도, 보고 있는 서버가 없으면 "지금 잡혀
    // 있는 리스"도 없다 — DISABLED_PROJECTION_STATUS 와 같은 논리다.
    expect(res.json().leases).toEqual([]);
  });
});

describe('커서 메트릭이 repo 라벨을 중복하지 않는다', () => {
  it('같은 repo 가 두 서버 아래 있어도 /metrics 의 murmur_projection_cursor 행은 하나뿐이다', async () => {
    const { pool: mPool, stop: mStop } = await startTestDb();
    try {
      await mPool.query(
        `insert into projection_cursor (repo, avcs_base_url, last_log_index) values
           ('dup/repo', $1, 10), ('dup/repo', $2, 30)`,
        [SERVER_A, SERVER_B],
      );
      const app = await buildServer({
        pool: mPool,
        projection: { envBaseUrl: null, reconfigure: async () => {}, currentUrl: () => SERVER_B },
      });
      try {
        const { token } = await bootstrapAdmin(app);
        const res = await app.inject({
          method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${token}` },
        });
        const lines = res.body.split('\n').filter((l) => l.startsWith('murmur_projection_cursor{'));
        // 되돌리기 실험: buildServer 의 게이지 쿼리에서 `where avcs_base_url = $1` 을 빼면
        // 이 repo 가 두 줄로 나와 Prometheus 텍스트가 깨진다.
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('repo="dup/repo"} 30'); // 현재 서버(B)의 값
      } finally {
        await app.close();
      }
    } finally {
      await mStop();
    }
  });
});

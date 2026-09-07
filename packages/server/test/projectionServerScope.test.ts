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

const lease = (oid: string, path: string) => ({
  oid, type: 'lease' as const, actorKeyId: 'k1', intentOid: null, summary: `lease ${path}`,
  lease: { path, expiresAt: new Date(Date.now() + 60_000).toISOString(), released: false },
});

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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ProjectionRuntime } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { createFakeAvcs } from './helpers/fakeAvcs.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import {
  ProjectionWorker, ensureSystemAccount, warnIfProjectionDisabled,
} from '../src/avcs/projection.js';
import { createChannel } from '../src/services/channels.js';
import type { AvcsServerClient } from '../src/avcs/client.js';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 원자료 픽스처. 라우트가 보는 것은 이 여섯 필드뿐이다. */
const runtime = (over: Partial<ProjectionRuntime> = {}): ProjectionRuntime => ({
  configured: true,
  repo: 'test/repo',
  lastLogIndex: 100,
  lastPolledAt: Date.now(),
  lastAdvancedAt: Date.now(),
  lastError: null,
  ...over,
});

describe('GET /projection/status (#267)', () => {
  let app: FastifyInstance;
  let stop: () => Promise<void>;
  let token: string;
  let dbPool: Pool;

  beforeAll(async () => {
    const db = await startTestDb();
    dbPool = db.pool;
    stop = db.stop;
    app = await buildServer({ pool: dbPool });
    const { token: adminToken } = await bootstrapAdmin(app);
    token = adminToken;
  });

  afterAll(async () => { await app.close(); await stop(); });

  /** 주어진 원자료로 서버를 세워 상태를 한 번 읽는다. */
  const read = async (
    getProjectionStatus?: () => ProjectionRuntime,
    auth = true,
  ): Promise<{ code: number; body: Record<string, unknown> }> => {
    const testApp = await buildServer({ pool: dbPool, ...(getProjectionStatus ? { getProjectionStatus } : {}) });
    try {
      const res = await testApp.inject({
        method: 'GET',
        url: '/projection/status',
        ...(auth ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });
      return { code: res.statusCode, body: res.json() as Record<string, unknown> };
    } finally {
      await testApp.close();
    }
  };

  // 회귀 1
  it('avcsBaseUrl 이 없으면(configured false) unconfigured 다', async () => {
    const { code, body } = await read(() => runtime({ configured: false, repo: null, lastPolledAt: null }));
    expect(code).toBe(200);
    expect(body.state).toBe('unconfigured');
  });

  // 워커를 아예 넘기지 않은 경우도 같은 자리로 온다 — 물어봤는데 답할 것이 없으면
  // 설정되지 않은 것이다. `ok` 로 떨어지면 꺼진 투영이 정상으로 보인다.
  it('투영 상태 제공자가 없으면 unconfigured 다 (ok 로 떨어지지 않는다)', async () => {
    const { body } = await read(undefined);
    expect(body.state).toBe('unconfigured');
  });

  // 회귀 2
  it('configured 이고 방금 폴링했고 에러가 없으면 ok 다', async () => {
    const { body } = await read(() => runtime());
    expect(body.state).toBe('ok');
  });

  // 회귀 3 — 경계를 양쪽에서 잡는다.
  it('폴링이 6분 전이면 stalled, 4분 전이면 ok 다 (5분 경계)', async () => {
    const six = await read(() => runtime({ lastPolledAt: Date.now() - 6 * 60 * 1000 }));
    expect(six.body.state).toBe('stalled');
    const four = await read(() => runtime({ lastPolledAt: Date.now() - 4 * 60 * 1000 }));
    expect(four.body.state).toBe('ok');
  });

  it('폴링을 한 번도 못 했으면 stalled 다', async () => {
    const { body } = await read(() => runtime({ lastPolledAt: null }));
    expect(body.state).toBe('stalled');
  });

  // 회귀 4 (라우트 쪽 절반 — 워커 쪽 "성공 폴링이 지운다"는 아래 describe 에 있다)
  it('lastError 가 있으면 방금 폴링했어도 stalled 다', async () => {
    const { body } = await read(() => runtime({ lastError: 'connection refused' }));
    expect(body.state).toBe('stalled');
    expect(body.lastError).toBe('connection refused');
  });

  it('원자료를 그대로 싣는다', async () => {
    const { body } = await read(() => runtime({ repo: 'org/repo', lastLogIndex: 42 }));
    expect(body.repo).toBe('org/repo');
    expect(body.lastLogIndex).toBe(42);
    expect(body.configured).toBe(true);
  });

  // 투영 상태는 저장소 이름과 에러 메시지를 담는다 — 로그인하지 않은 사람에게 줄 것이 아니다.
  it('requireAccount 다 — 토큰이 없으면 거절한다', async () => {
    const { code } = await read(() => runtime(), false);
    expect(code).toBe(401);
  });
});

/**
 * 상태가 **실제로 배선돼 있는가**(#267). 위 라우트 테스트는 원자료를 주입하므로,
 * 워커가 그 값을 아무도 갱신하지 않는 "죽은 상태"여도 전부 초록이다. 그래서 진짜
 * 워커를 돌려 `lastPolledAt` 이 움직이는지를 따로 본다.
 */
describe('#267 투영 워커가 상태를 실제로 갱신한다', () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let systemAccountId: string;

  beforeAll(async () => {
    ({ pool, stop } = await startTestDb());
    systemAccountId = await ensureSystemAccount(pool);
  });
  afterAll(async () => { await stop(); });

  it('폴링이 돌면 lastPolledAt 이 갱신된다', async () => {
    const fake = createFakeAvcs();
    const repo = 'wired-repo';
    const channelId = (await createChannel(pool, { name: 'wired', repo })).id;
    const worker = new ProjectionWorker({ pool, avcs: fake.client, systemAccountId });

    expect(worker.status().lastPolledAt).toBeNull();
    worker.start(50);
    try {
      await waitFor(() => worker.status().lastPolledAt !== null);
      const first = worker.status().lastPolledAt!;
      // 계속 돌아야 한다 — 한 번 찍고 멈추면 5분 뒤 stalled 로 보인다.
      await waitFor(() => (worker.status().lastPolledAt ?? 0) > first);
      expect(worker.status().configured).toBe(true);
      expect(worker.status().repo).toBe(repo);
      expect(channelId).toBeTruthy();
    } finally {
      await worker.stop();
    }
  });

  /**
   * **바인딩된 저장소가 하나도 없어도** 폴링은 돌고 있다. 여기서 `lastPolledAt` 이
   * 안 움직이면 멀쩡한 서버가 5분 뒤 `stalled` 로 보인다 — 정상을 장애로 부르는 것이고,
   * 그러면 사람은 이 표시를 곧 무시한다.
   */
  it('바인딩된 저장소가 없어도 lastPolledAt 이 갱신된다', async () => {
    const { pool: emptyPool, stop: stopEmpty } = await startTestDb();
    try {
      const fake = createFakeAvcs();
      const worker = new ProjectionWorker({
        pool: emptyPool, avcs: fake.client, systemAccountId: await ensureSystemAccount(emptyPool),
      });
      worker.start(50);
      try {
        await waitFor(() => worker.status().lastPolledAt !== null);
        const first = worker.status().lastPolledAt!;
        await waitFor(() => (worker.status().lastPolledAt ?? 0) > first);
      } finally {
        await worker.stop();
      }
    } finally {
      await stopEmpty();
    }
  });

  // 회귀 4 의 나머지 절반: 실패가 기록되고 **다음 성공 폴링이 지운다.**
  it('실패가 lastError 에 남고 다음 성공 폴링이 지운다', async () => {
    const fake = createFakeAvcs();
    const repo = 'flaky-status-repo';
    await createChannel(pool, { name: 'flaky-status', repo });

    let failing = true;
    const flaky: AvcsServerClient = {
      waitForChange: (r, since, timeoutMs) =>
        failing ? Promise.reject(new Error('injected avcs failure')) : fake.client.waitForChange(r, since, timeoutMs),
      fetchSince: (r, since) =>
        failing ? Promise.reject(new Error('injected avcs failure')) : fake.client.fetchSince(r, since),
    };
    const worker = new ProjectionWorker({ pool, avcs: flaky, systemAccountId });
    worker.start(50);
    try {
      await waitFor(() => worker.status().lastError !== null);
      expect(worker.status().lastError).toContain('injected avcs failure');
      failing = false;
      await waitFor(() => worker.status().lastError === null);
    } finally {
      await worker.stop();
    }
  });

  it('에러 메시지를 200자로 자른다', async () => {
    const fake = createFakeAvcs();
    const repo = 'long-error-repo';
    await createChannel(pool, { name: 'long-error', repo });
    const long = 'x'.repeat(500);
    const worker = new ProjectionWorker({
      pool,
      avcs: {
        waitForChange: () => Promise.reject(new Error(long)),
        fetchSince: () => Promise.reject(new Error(long)),
      },
      systemAccountId,
    });
    worker.start(50);
    try {
      await waitFor(() => worker.status().lastError !== null);
      expect(worker.status().lastError!.length).toBe(200);
    } finally {
      await worker.stop();
    }
    expect(fake).toBeTruthy();
  });
});

/**
 * 회귀 5: 기동 시 경고 한 줄.
 *
 * `main.ts` 를 임포트할 수 없어서(최상위 await 로 포트를 잡는다) 판정만 함수로 빼 뒀다.
 * 그 함수를 로거 spy 로 확인한다 — 인라인으로 남겨 두면 어떤 테스트도 이 한 줄이
 * 사라진 것을 알아채지 못한다.
 */
describe('#267 기동 경고', () => {
  it('AVCS_BASE_URL 이 없으면 경고를 한 번 남긴다', () => {
    const warn = vi.fn();
    expect(warnIfProjectionDisabled(null, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    // 무엇을 해야 하는지가 문구에 있어야 한다 — "비활성"만 적으면 켜는 방법이 없다.
    expect(warn.mock.calls[0]![0]).toContain('AVCS_BASE_URL');
  });

  it('AVCS_BASE_URL 이 있으면 아무것도 남기지 않는다', () => {
    const warn = vi.fn();
    expect(warnIfProjectionDisabled('http://localhost:7777', warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

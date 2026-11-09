import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { RUNNER_VERSION_CACHE_TTL_MS, recordRunnerVersion } from '../src/services/runnerVersion.js';

/** 폴마다 같은 버전이면 문장조차 보내지 않는다 — DB 쪽 동작(값이 바뀔 때만 행이 바뀜)은 runnerVersionLive 가 본다. */
function fakePool(fail = false) {
  const calls: unknown[][] = [];
  const pool = { query: async (_sql: string, params: unknown[]) => { calls.push(params); if (fail) throw new Error('db down'); return { rows: [] }; } };
  return { pool: pool as unknown as Pool, calls };
}

describe('recordRunnerVersion 프로세스 기억', () => {
  it('같은 버전은 시한 안에서 한 번만 보내고, 버전이 바뀌거나 시한이 지나면 다시 보낸다', async () => {
    const { pool, calls } = fakePool();
    let t = 1_000_000;
    const now = () => t;
    const id = '00000000-0000-0000-0000-00000000a001';
    await recordRunnerVersion(pool, id, 'v1', now);
    await recordRunnerVersion(pool, id, 'v1', now);
    expect(calls).toHaveLength(1);
    await recordRunnerVersion(pool, id, 'v2', now);
    expect(calls).toHaveLength(2);
    t += RUNNER_VERSION_CACHE_TTL_MS;
    await recordRunnerVersion(pool, id, 'v2', now);
    expect(calls).toHaveLength(3);
  });

  it('실패한 쓰기는 기억하지 않는다 — 다음 폴이 다시 쓴다', async () => {
    const down = fakePool(true);
    const id = '00000000-0000-0000-0000-00000000a002';
    await expect(recordRunnerVersion(down.pool, id, 'v1')).rejects.toThrow('db down');
    const up = fakePool();
    await recordRunnerVersion(up.pool, id, 'v1');
    expect(up.calls).toHaveLength(1);
  });
});

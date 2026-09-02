import type { Pool } from 'pg';

/**
 * 러너 버전을 기록한다. **값이 바뀔 때만 쓴다.**
 *
 * 이 함수는 `inbox.poll` 에서 불린다 — 에이전트가 최대 25초마다 부르는 핫 패스다.
 * 매번 UPSERT 하면 에이전트당 25초에 한 번 DB 쓰기가 영구히 돈다. 버전은 러너가
 * 재시작할 때까지 바뀌지 않는 값이므로 그 쓰기는 전부 낭비다.
 *
 * "지금 붙어 있나"는 이 테이블이 답하지 않는다 — `#124` 의 인메모리 presence 가 답한다
 * (`mcp/presence.ts`). 그래서 `seen_at` 은 **이 버전을 언제 봤나**이고, 매 폴마다
 * 갱신할 이유가 없다. 두 곳이 같은 사실을 담지 않게 하는 경계다.
 */
export async function recordRunnerVersion(pool: Pool, accountId: string, version: string): Promise<void> {
  await pool.query(
    `insert into agent_runner_version (account_id, version, seen_at)
     values ($1, $2, now())
     on conflict (account_id) do update set version = excluded.version, seen_at = excluded.seen_at
     where agent_runner_version.version <> excluded.version`,
    [accountId, version],
  );
}
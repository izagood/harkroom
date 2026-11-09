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
/**
 * 위 `where` 로 행은 안 바뀌어도 문장은 폴마다 DB 에 갔다(하루 ~136k 회 — 충돌 행 잠금까지 잡는다).
 * 이 프로세스가 같은 값을 최근에 기록했으면 문장 자체를 보내지 않는다. 시한(TTL)을 두는 까닭: 서버가 여럿이면
 * 다른 인스턴스가 그사이 다른 값을 썼을 수 있다 — 시한이 지나면 한 번 다시 보내 DB 와 맞춘다.
 * 실패한 쓰기는 기억하지 않는다(다음 폴이 다시 쓴다). 에이전트 수만큼만 자란다.
 */
export const RUNNER_VERSION_CACHE_TTL_MS = 10 * 60_000;
const recorded = new Map<string, { version: string; at: number }>();

export async function recordRunnerVersion(pool: Pool, accountId: string, version: string, now: () => number = Date.now): Promise<void> {
  const hit = recorded.get(accountId);
  if (hit && hit.version === version && now() - hit.at < RUNNER_VERSION_CACHE_TTL_MS) return;
  await pool.query(
    `insert into agent_runner_version (account_id, version, seen_at)
     values ($1, $2, now())
     on conflict (account_id) do update set version = excluded.version, seen_at = excluded.seen_at
     where agent_runner_version.version <> excluded.version`,
    [accountId, version],
  );
  recorded.set(accountId, { version, at: now() });
}

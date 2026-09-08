import type { Pool } from 'pg';

/** 러너가 기동 때 읽은 lane. `pool` 이 null 인 것과 `accounts` 가 빈 것은 다른 사실이다. */
export interface ClaudeLane {
  pool: string | null;
  accounts: string[];
}

/**
 * 러너의 claude lane 을 기록한다. **값이 바뀔 때만 쓴다.**
 *
 * `recordRunnerVersion` 과 같은 자리(inbox.poll)에서 같은 이유로 불린다 — 에이전트가
 * 최대 25초마다 부르는 핫 패스이고, lane 은 러너가 재시작할 때까지 바뀌지 않는다.
 * 매번 UPSERT 하면 그 쓰기는 전부 낭비다(services/runnerVersion.ts 주석).
 *
 * **버전과 한 테이블에 담지 않은 이유**: 두 값의 출처가 다르다. 버전은 빌드가 넣어 준
 * 문자열이고 lane 은 러너가 디스크에서 읽은 것이다 — 한 러너가 버전만 보내고 lane 을
 * 못 읽는 일이 실제로 있다(계정 뿌리가 없는 머신). 한 행에 두면 그때 어느 쪽이 비었는지
 * `null` 하나로는 말할 수 없다.
 *
 * 순서가 뜻이 있으므로 `accounts` 는 **정렬하지 않는다** — 페일오버가 그 순서로 돈다.
 */
export async function recordClaudeLane(pool: Pool, accountId: string, lane: ClaudeLane): Promise<void> {
  await pool.query(
    // **harness 게이트를 여기 SQL 에 둔다.** claude lane 은 claude 하네스에만 뜻이 있는데,
    // 러너는 자기 하네스를 정의에서 매 턴 읽고 폴 루프는 그것을 손에 들고 있지 않다 —
    // 그렇다고 폴마다 정의를 한 번 더 읽으면 25초 루프에 왕복이 하나 더 붙는다. 서버는
    // 그 값을 이미 갖고 있으므로(agent_config.harness) 여기서 한 번에 거른다: codex·gemini
    // 러너가 lane 을 실어 보내도 행이 생기지 않고, 화면은 그것을 **모른다**로 그린다
    // (남의 축의 계정 목록을 그 에이전트의 것으로 단언하지 않는다).
    `insert into agent_claude_lane (account_id, pool, accounts, seen_at)
     select $1, $2, $3::text[], now()
       from agent_config
      where account_id = $1 and coalesce(harness, 'claude-code') = 'claude-code'
     on conflict (account_id) do update
       set pool = excluded.pool, accounts = excluded.accounts, seen_at = excluded.seen_at
     where agent_claude_lane.pool is distinct from excluded.pool
        or agent_claude_lane.accounts <> excluded.accounts`,
    [accountId, lane.pool, lane.accounts],
  );
}

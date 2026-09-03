import type { Pool, PoolClient } from 'pg';
import type { AgentDefaults } from '@murmur/shared';

/**
 * 새 에이전트의 기본값(#171). 단일 행 테이블(`agent_defaults`, 마이그레이션 017)을 읽고 쓴다.
 *
 * 이 값은 **에이전트가 참조하는 것이 아니라 생성 시점에 복사되는 서식**이다.
 * `createAgentAccount` 가 요청에 없는 필드만 이 값으로 채우고, 그 뒤로 둘은 독립이다 —
 * 여기를 바꿔도 이미 만들어진 에이전트는 따라 바뀌지 않는다. 참조로 뒀다면 운영자가
 * 기본값을 고치는 순간 **돌고 있는 에이전트의 하네스가 중간에 바뀐다**(러너가 매 턴
 * `GET /agent/config` 로 자기 정의를 다시 읽는다).
 */
export async function getAgentDefaults(db: Pool | PoolClient): Promise<AgentDefaults> {
  const res = await db.query(`select harness, model, effort from agent_defaults where id = true`);
  return res.rows[0] as AgentDefaults;
}

/**
 * 지정된 필드만 갱신한다. 키 부재는 '손대지 않음', null 은 '지우기'(= harness 기본값 사용)다 —
 * `agent_config` 의 upsert 와 같은 규칙이다. `undefined` 로 지우기를 표현하지 않는 이유:
 * `JSON.stringify` 가 `undefined` 키를 통째로 버려서, 지우려는 조작이 조용히 무시된다.
 */
export async function updateAgentDefaults(
  pool: Pool, patch: Partial<AgentDefaults>,
): Promise<AgentDefaults> {
  const res = await pool.query(
    `update agent_defaults set
       harness = case when $1::bool then $2::text else harness end,
       model   = case when $3::bool then $4::text else model   end,
       effort  = case when $5::bool then $6::text else effort  end
     where id = true
     returning harness, model, effort`,
    [
      patch.harness !== undefined, patch.harness ?? null,
      patch.model !== undefined, patch.model ?? null,
      patch.effort !== undefined, patch.effort ?? null,
    ],
  );
  return res.rows[0] as AgentDefaults;
}

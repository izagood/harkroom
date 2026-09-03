import type { Pool, PoolClient } from 'pg';
import { AGENT_HARNESSES, type AgentConfig, type AgentHarness, type AgentView } from '@murmur/shared';
import { getAgentDefaults } from './agentDefaults.js';
import { getHandleGroupByHandle } from './handleGroups.js';

const COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  coalesce(c.instructions, '') as instructions,
  coalesce(c.harness, 'claude-code') as harness,
  c.model, c.effort, c.working_dir as "workingDir",
  coalesce(c.mention_permission, 'auto') as "mentionPermission",
  c.owner_account_id as "ownerAccountId",
  a.disabled_at is not null as disabled,
  -- 에이전트는 상태를 고를 수 없다(서버가 거절한다). 기본값 그대로지만 AccountView 의
  -- 필수 필드라 형태를 맞춰 준다 — 화면은 사람 계정에만 이 값을 그린다.
  a.status, a.status_text as "statusText",
  -- 에이전트는 스스로 아바타를 올리지 않는다(#159 범위 밖). AccountView 의 필수 필드라
  -- 형태를 맞춰 주고, 값은 그대로 null 로 남아 화면이 기존 폴백(글리프)을 그린다.
  a.avatar_attachment_id as "avatarAttachmentId",
  v.version as "runnerVersion",
  -- #129 종료 요청. 러너 자신(GET /agent/config)과 운영자 목록이 **같은 뷰**를 본다 —
  -- 두 곳에서 따로 읽으면 화면이 보여주는 값과 러너가 실제로 집어 가는 값이 갈릴 수 있다.
  c.stop_requested_at as "stopRequestedAt",
  c.stop_acked_at as "stopAckedAt",
  -- #176 마지막으로 턴을 마친 시각. presence(온라인 여부)와 **다른 사실**이라 여기 한 컬럼으로
  -- 오고, 화면은 둘을 나란히 그린다 — 합치면 #124 가 닫은 결함이 되살아난다.
  c.last_turn_at as "lastTurnAt"`;

const FROM = `from account a left join agent_config c on c.account_id = a.id
  left join agent_runner_version v on v.account_id = a.id`;

export function isHarness(value: unknown): value is AgentHarness {
  return typeof value === 'string' && (AGENT_HARNESSES as readonly string[]).includes(value);
}

/** 정의가 없는 에이전트도 목록에 나와야 한다(설정 없이 만들 수 있다) — 그래서 left join 이다. */
export async function listAgents(pool: Pool): Promise<AgentView[]> {
  const res = await pool.query(`select ${COLS} ${FROM} where a.kind = 'agent' order by a.handle`);
  return res.rows;
}

export async function getAgent(pool: Pool, id: string): Promise<AgentView | null> {
  const res = await pool.query(`select ${COLS} ${FROM} where a.id = $1 and a.kind = 'agent'`, [id]);
  return res.rowCount ? res.rows[0] : null;
}

async function upsertConfig(
  client: PoolClient | Pool, accountId: string,
  patch: Partial<AgentConfig> & { ownerAccountId?: string | null },
): Promise<void> {
  // 지정된 필드만 갱신한다. 키 부재는 '손대지 않음', null 은 'harness 기본값으로 되돌리기'다 —
  // 구분하지 못하면 지시문만 고치려다 모델 지정이 조용히 사라진다.
  await client.query(
    `insert into agent_config (account_id, instructions, harness, model, effort, working_dir, mention_permission, owner_account_id)
     values ($1, coalesce($3, ''), coalesce($5, 'claude-code'), $6, $8, $10, coalesce($13, 'auto'), $15)
     on conflict (account_id) do update set
       instructions       = case when $2::bool  then excluded.instructions       else agent_config.instructions       end,
       harness            = case when $4::bool  then excluded.harness            else agent_config.harness            end,
       model              = case when $7::bool  then excluded.model              else agent_config.model              end,
       effort             = case when $9::bool  then excluded.effort             else agent_config.effort             end,
       working_dir        = case when $11::bool then excluded.working_dir        else agent_config.working_dir        end,
       mention_permission = case when $12::bool then excluded.mention_permission else agent_config.mention_permission end,
       owner_account_id   = case when $14::bool then excluded.owner_account_id   else agent_config.owner_account_id   end,
       updated_at = now()`,
    [
      accountId,
      patch.instructions !== undefined, patch.instructions ?? null,
      patch.harness !== undefined, patch.harness ?? null,
      patch.model ?? null,
      patch.model !== undefined,
      patch.effort ?? null,
      patch.effort !== undefined,
      patch.workingDir ?? null,
      patch.workingDir !== undefined,
      patch.mentionPermission !== undefined, patch.mentionPermission ?? null,
      patch.ownerAccountId !== undefined, patch.ownerAccountId ?? null,
    ],
  );
}

/**
 * 생성 시점의 기본값(#171)을 **복사해서** 박는다. 참조가 아니다 — 나중에
 * `agent_defaults` 를 바꿔도 이미 만들어진 이 에이전트는 따라 바뀌지 않는다.
 * 참조로 뒀다면 운영자가 기본값을 고치는 순간 돌고 있는 러너의 harness 가 중간에 바뀐다
 * (러너는 매 턴 `GET /agent/config` 로 자기 정의를 다시 읽는다).
 *
 * **요청이 준 값이 이긴다.** 키 부재(`undefined`)만 기본값으로 채운다 — 명시적 null 은
 * '이 에이전트는 harness 기본값을 쓴다'는 선택이므로 덮으면 안 된다.
 *
 * harness 를 그대로 캐스팅하는 이유: 이 컬럼에 쓰는 곳은 `PUT /settings/agent-defaults`
 * 하나뿐이고 거기서 `RUNNABLE_HARNESSES` 로 검증한다. DB 가 값을 검증하지 않는 것은
 * 004_agent_config.sql 이 세운 선례다(harness 목록은 코드와 함께 늘어난다).
 */
async function withDefaults(
  client: PoolClient, input: Partial<AgentConfig>,
): Promise<Partial<AgentConfig>> {
  const defaults = await getAgentDefaults(client);
  return {
    ...input,
    harness: input.harness !== undefined ? input.harness : (defaults.harness as AgentHarness),
    model: input.model !== undefined ? input.model : defaults.model,
    effort: input.effort !== undefined ? input.effort : defaults.effort,
  };
}

export async function createAgentAccount(
  pool: Pool, input: { handle: string; displayName: string } & Partial<AgentConfig>, ownerId: string,
): Promise<AgentView> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    /**
     * 집합과 같은 이름의 계정은 만들 수 없다(#230 결정 3). 이쪽(계정 생성)을 빠뜨리기
     * 쉽다 — 집합 생성만 막으면 나중에 만든 계정이 같은 이름을 차지해 `@foo` 가 사람인지
     * 집합인지 갈린다.
     *
     * `pool` 이 아니라 `client` 로 읽는다: 트랜잭션 클라이언트를 쥔 채 풀에서 또 다른
     * 연결을 얻으면 풀이 포화된 순간 자기 자신을 기다리는 교착이 된다.
     */
    const group = await getHandleGroupByHandle(client, input.handle);
    if (group) {
      throw Object.assign(new Error('a group with this handle already exists'), { code: 'handle_taken' });
    }

    const created = await client.query(
      `insert into account (handle, display_name, kind) values ($1, $2, 'agent') returning id`,
      [input.handle, input.displayName],
    );
    const id = created.rows[0].id as string;
    await upsertConfig(client, id, { ...await withDefaults(client, input), ownerAccountId: ownerId });
    await client.query('commit');
    const view = await getAgent(pool, id);
    return view!;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 대상이 에이전트가 아니면 null — 사람 계정을 에이전트로 만들 수는 없다. */
export async function updateAgent(
  pool: Pool, id: string, patch: Partial<AgentConfig> & { displayName?: string },
): Promise<AgentView | null> {
  const existing = await getAgent(pool, id);
  if (!existing) return null;
  if (patch.displayName !== undefined) {
    await pool.query(`update account set display_name = $2 where id = $1`, [id, patch.displayName]);
  }
  await upsertConfig(pool, id, patch);
  return getAgent(pool, id);
}

/**
 * 러너에게 종료를 요청한다(#129). **재시작이 아니다** — murmur 는 러너를 다시 띄우지 못한다.
 *
 * `agent_config` 행이 없을 수도 있어 upsert 다: 에이전트는 정의 없이도 만들어질 수 있고
 * (`listAgents` 가 left join 인 이유가 그것이다), 그런 에이전트에도 러너는 붙는다.
 *
 * 다시 요청하면 `stop_acked_at` 을 null 로 되돌린다. 새 요청은 새 수령을 기다려야 한다 —
 * 옛 수령 기록을 남겨 두면 화면이 "러너가 이번 요청을 받아 갔다"고 거짓을 말한다.
 */
export async function requestAgentStop(
  pool: Pool, agentId: string, actorId: string,
): Promise<AgentView | null> {
  // 대상 확인이 **먼저**다. 없는 계정에 upsert 하면 agent_config 가 account 를 참조하므로
  // 외래키로 실패하지만, 사람 계정이면 조용히 성공해 사람에게 종료 요청이 달린다.
  const existing = await getAgent(pool, agentId);
  if (!existing) return null;
  await pool.query(
    `insert into agent_config (account_id, stop_requested_at, stop_requested_by)
     values ($1, now(), $2)
     on conflict (account_id) do update set
       stop_requested_at = now(),
       stop_requested_by = $2,
       stop_acked_at = null,
       updated_at = now()`,
    [agentId, actorId],
  );
  return getAgent(pool, agentId);
}

/**
 * 러너가 종료 요청을 읽어 갔다는 사실을 남긴다(#129).
 *
 * 러너가 실제로 종료했는지는 여기서 알 수 없다 — 종료하면 다음 요청 자체가 오지 않기
 * 때문이다. 그래서 이 값의 뜻은 '멈췄다'가 아니라 '요청이 러너에게 도달했다'뿐이다.
 *
 * 이미 수령한 요청은 다시 찍지 않는다(`stop_acked_at is null` 조건). 매 턴 덮어쓰면
 * "언제 도달했나"가 러너가 마지막으로 정의를 읽은 시각으로 밀려 의미를 잃는다.
 * 요청이 없으면 아무 행도 건드리지 않는다 — 수령은 요청에 대해서만 존재한다.
 */
export async function ackAgentStop(pool: Pool, agentId: string): Promise<string | null> {
  const res = await pool.query(
    `update agent_config set stop_acked_at = now()
      where account_id = $1 and stop_requested_at is not null and stop_acked_at is null
      returning stop_acked_at as "stopAckedAt"`,
    [agentId],
  );
  return res.rowCount ? (res.rows[0].stopAckedAt as string) : null;
}

/**
 * 이 에이전트가 턴을 마쳤다는 사실을 남긴다(#176).
 *
 * **시각은 여기서 찍는다.** 러너가 보낸 타임스탬프는 받지 않는다 — 러너 시계가 서버보다
 * 앞선 머신에서는 "3분 뒤에 활동함"이 화면에 뜨고, 그건 활동 시각이 아니라 시계 오차다.
 *
 * `agent_config` 행이 없을 수도 있어 upsert 다: 에이전트는 정의 없이도 만들어지고
 * (`listAgents` 가 left join 인 이유), 그런 에이전트에도 러너는 붙는다 —
 * `requestAgentStop` 이 같은 이유로 upsert 한다.
 *
 * 매 턴 덮어쓰는 것이 맞다. 이 컬럼은 이력이 아니라 **현재 상태 하나**이고(마이그레이션
 * 020 의 주석), 그래서 `recordRunnerVersion` 처럼 '값이 바뀔 때만' 쓸 이유가 없다 —
 * 여기서는 바뀐 값 자체가 담으려는 사실이다. 턴은 폴(25초)보다 훨씬 드물게 끝나므로
 * 그 쓰기가 핫 패스가 되지도 않는다.
 *
 * 호출 계정이 에이전트인지는 **라우트가** 확인한다 — 여기서 다시 확인하지 않는 이유는
 * 이 함수가 자기 행만 갱신하고, 존재하지 않는 계정이면 외래키가 막기 때문이다. 대신
 * 사람 계정을 조용히 성공시키지 않도록 라우트가 400 으로 먼저 거절한다.
 */
export async function recordAgentTurn(pool: Pool, accountId: string): Promise<string> {
  const res = await pool.query(
    `insert into agent_config (account_id, last_turn_at)
     values ($1, now())
     on conflict (account_id) do update set last_turn_at = now(), updated_at = now()
     returning last_turn_at as "lastTurnAt"`,
    [accountId],
  );
  return res.rows[0].lastTurnAt as string;
}

/**
 * 그 계정의 살아 있는 PAT 를 전부 폐기하고 폐기한 label 을 돌려준다.
 * `PoolClient` 도 받는 이유: 비활성화가 `disabled_at` 설정과 PAT 폐기를 한 트랜잭션에 묶는다
 * (`accountRoutes.ts`). Pool 로 부르면 다른 커넥션의 별개 자동커밋이 되어 둘이 갈린다.
 * 단일 label 폐기(`DELETE /accounts/:id/pats/:label`)와 조건절이 같아야 하므로 그 규칙을
 * 여기 한 곳에 둔다.
 */
export async function revokeAllPats(db: Pool | PoolClient, accountId: string): Promise<string[]> {
  const res = await db.query(
    `update pat set revoked_at = now() where account_id = $1 and revoked_at is null returning label`,
    [accountId],
  );
  return res.rows.map((r) => r.label as string);
}

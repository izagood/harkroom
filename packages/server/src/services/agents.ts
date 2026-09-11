import type { Pool, PoolClient } from 'pg';
import { AGENT_HARNESSES, type AgentConfig, type AgentHarness, type AgentView } from '@harkroom/shared';
import { getAgentDefaults } from './agentDefaults.js';
import { getHandleGroupByHandle } from './handleGroups.js';

const COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  coalesce(c.instructions, '') as instructions,
  coalesce(c.harness, 'claude-code') as harness,
  c.model, c.effort, c.working_dir as "workingDir",
  coalesce(c.mention_permission, 'auto') as "mentionPermission",
  -- null 이 기본이다 — '러너 기본값을 따른다'. coalesce 로 값을 지어내면 이설이 끝나
  -- 기본이 바뀌는 날 이 컬럼이 옛 값을 고집한다(shared 의 AGENT_EXECUTION_PATHS 주석).
  -- (이 문자열은 템플릿 리터럴 안이다 — 주석에 백틱을 쓰면 거기서 끊긴다.)
  c.execution_path as "executionPath",
  c.owner_account_id as "ownerAccountId",
  a.disabled_at is not null as disabled,
  -- 에이전트는 상태를 고를 수 없다(서버가 거절한다). 기본값 그대로지만 AccountView 의
  -- 필수 필드라 형태를 맞춰 준다 — 화면은 사람 계정에만 이 값을 그린다.
  a.status, a.status_text as "statusText",
  -- 에이전트는 스스로 올릴 손이 없지만 소유자·admin 이 대신 건다
  -- (Task 15-4, PUT /accounts/agents/:id/avatar). 그래서 이 값은 null 로 남지 않는다 —
  -- 화면은 사람과 **같은 규칙**으로 이 id 를 보고 사진을 받아 온다(Identity).
  a.avatar_attachment_id as "avatarAttachmentId",
  v.version as "runnerVersion",
  -- #129 종료 요청. 러너 자신(GET /agent/config)과 운영자 목록이 **같은 뷰**를 본다 —
  -- 두 곳에서 따로 읽으면 화면이 보여주는 값과 러너가 실제로 집어 가는 값이 갈릴 수 있다.
  c.stop_requested_at as "stopRequestedAt",
  c.stop_acked_at as "stopAckedAt",
  -- #176 마지막으로 턴을 마친 시각. presence(온라인 여부)와 **다른 사실**이라 여기 한 컬럼으로
  -- 오고, 화면은 둘을 나란히 그린다 — 합치면 #124 가 닫은 결함이 되살아난다.
  c.last_turn_at as "lastTurnAt",
  -- 러너가 기동 때 읽은 claude lane(5단계). 행이 없으면 **모른다** — 그래서 컬럼 둘을
  -- 그대로 쓰지 않고 json 하나로 접는다: 행이 없을 때 null 하나가 "모른다"를 말하고,
  -- 있을 때 빈 accounts 가 "풀이 비었다"를 말한다. 컬럼 둘로 보내면 화면이 그 둘을
  -- (pool is null && accounts is null) 같은 조합으로 다시 세워야 한다.
  case when l.account_id is null then null
       else json_build_object('pool', l.pool, 'accounts', l.accounts) end as "claudeLane"`;

const FROM = `from account a left join agent_config c on c.account_id = a.id
  left join agent_runner_version v on v.account_id = a.id
  left join agent_claude_lane l on l.account_id = a.id`;

export function isHarness(value: unknown): value is AgentHarness {
  return typeof value === 'string' && (AGENT_HARNESSES as readonly string[]).includes(value);
}

/** 정의가 없는 에이전트도 목록에 나와야 한다(설정 없이 만들 수 있다) — 그래서 left join 이다.
 *
 * #299: `ownerId` 로 소유자 필터를 받는다. admin 은 null 이라 전부를 보고, 비admin 은
 * 자기 id 로 필터한다. SQL 에서 필터하는 이유: 가져와서 걸러내면 남의 설정이 응답에
 * 실렸다가 지워지는 모양이 된다. */
export async function listAgents(pool: Pool, ownerId: string | null = null): Promise<AgentView[]> {
  const where = ownerId
    ? `where a.kind = 'agent' and c.owner_account_id = $1`
    : `where a.kind = 'agent'`;
  const res = await pool.query(
    `select ${COLS} ${FROM} ${where} order by a.handle`,
    ownerId ? [ownerId] : [],
  );
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
    `insert into agent_config (account_id, instructions, harness, model, effort, working_dir, mention_permission, owner_account_id, execution_path)
     values ($1, coalesce($3, ''), coalesce($5, 'claude-code'), $6, $8, $10, coalesce($13, 'auto'), $15, $16)
     on conflict (account_id) do update set
       instructions       = case when $2::bool  then excluded.instructions       else agent_config.instructions       end,
       harness            = case when $4::bool  then excluded.harness            else agent_config.harness            end,
       model              = case when $7::bool  then excluded.model              else agent_config.model              end,
       effort             = case when $9::bool  then excluded.effort             else agent_config.effort             end,
       working_dir        = case when $11::bool then excluded.working_dir        else agent_config.working_dir        end,
       mention_permission = case when $12::bool then excluded.mention_permission else agent_config.mention_permission end,
       owner_account_id   = case when $14::bool then excluded.owner_account_id   else agent_config.owner_account_id   end,
       execution_path     = case when $17::bool then excluded.execution_path     else agent_config.execution_path     end,
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
      // $16 값 / $17 '보냈는가'. 값이 먼저인 것은 insert 절이 값만 쓰고 update 절이
      // 플래그를 쓰기 때문이다 — 위 model·effort 와 같은 모양이다.
      patch.executionPath ?? null, patch.executionPath !== undefined,
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
 * 종료 요청을 **되돌린다**(#427). `requestAgentStop` 의 대칭이다.
 *
 * ## 왜 이 값이 서버에 남아 있나 — daemon 으로 옮기지 않는 이유
 *
 * `019` 마이그레이션 주석은 *"다시 띄우는 것은 운영자의 몫"* 이라 적었고 **그 원칙은 그대로**다.
 * 달라진 것은 그 운영자가 이제 daemon 이라는 것뿐이다(`#431` 2단계). 그러니 판정의 주인이
 * 바뀌었다고 해서 이 값까지 daemon 장부로 옮기면 안 된다:
 *
 * - `stop_requested_at` 은 **사람의 의도**다. daemon 장부는 **프로세스 사실**만 담는다
 *   (`kill(pid,0)` 으로 직접 아는 것). 성격이 다른 둘을 한 저장소에 섞으면, 장부가
 *   "무엇이 살아 있나"를 답하는 자리가 아니게 된다
 * - daemon 이 서버를 읽으면 **왕복 의존**이 생기고 `#431` D5 의 "단일 writer" 가 흐려진다.
 *   지금 daemon 은 자기가 spawn 한 것만 알면 되고, 그래서 남의 러너에 영향받지 않는다
 *
 * 그래서 되돌리기는 **서버 API + 앱 UI** 로 간다. 앱은 의도를 기록하고, daemon 은 그 의도가
 * 걸러 낸 목록(`runnerLauncher.startAll` 의 필터)대로 프로세스를 다룬다.
 *
 * ## `stop_acked_at` 도 함께 지우는 이유
 *
 * **수령 기록만 남으면 화면이 거짓을 말한다.** `requestAgentStop` 이 재요청 때 같은 이유로
 * 수령을 지운다 — 옛 수령을 남겨 두면 화면이 "러너가 이번 요청을 받아 갔다"고 말한다.
 * 되돌리기는 그보다 더 나쁘다: 요청이 없는데 수령만 있으면 어느 요청에 대한 수령인지
 * 가리킬 대상이 아예 사라지고, 세 상태(요청 없음 / 못 봄 / 받아 감)를 그리는 화면이
 * **어느 상태에도 속하지 않는 행**을 받는다. 요청과 수령은 짝이므로 함께 지운다.
 *
 * ## `stop_requested_by` 를 되돌린 사람으로 덮는 이유
 *
 * **누가 되돌렸는지도 사실이다.** `019` 주석이 이 컬럼을 둔 이유는 *"정의 옆에 행위자가
 * 있어야 '이 러너가 왜 서 있나'를 이 한 행만 보고 답할 수 있다"* 였다. 되돌린 뒤 그 행이
 * 답해야 하는 질문은 뒤집힌다 — **"이 러너가 왜 다시 뜨나"** 이고, 그 답은 되돌린 사람이다.
 * 요청자를 남겨 두면 행이 "이 사람이 세웠다"고 말하는데 실제로는 도는 상태가 되어, 이
 * 컬럼이 처음부터 없애려던 오독을 되살린다.
 *
 * null 로 비우지 않는 이유도 같다 — 비우면 그 한 행이 아무에게도 책임을 못 묻는다.
 * 시각(`stop_requested_at`)이 null 이라 "요청 없음"은 이미 명확하므로, 행위자만 남는 것이
 * 모호하지 않다. **되돌린 사건 자체의 이력은 `audit_log` 가 갖는다**(라우트가 남긴다) —
 * 이 컬럼은 이력이 아니라 '지금 이 행을 이렇게 만든 사람' 하나다.
 *
 * ## 요청이 없었으면 무엇을 돌려주나
 *
 * **`AgentView` 를 그대로 돌려준다 — null 이 아니다.** `requestAgentStop` 이 null 을 쓰는
 * 자리는 "그런 에이전트가 없다"(라우트가 404 로 옮긴다) 하나뿐이고, "요청이 아예 없었다"는
 * **다른 사건**이다. 부르는 쪽이 원한 상태(요청 없음)가 이미 성립해 있는 것이므로 실패가
 * 아니다 — 404 로 돌려주면 화면은 "그런 에이전트가 없다"고 말하게 되고, 그건 거짓이다.
 *
 * 그래서 행이 없을 때도 upsert 하지 않고 **아무것도 쓰지 않는다**: 요청이 없던 행에
 * `stop_requested_by` 만 찍으면 아무 요청도 없는 정의에 행위자가 매달린다. 조건절이
 * 그것을 막는다.
 */
export async function undoAgentStopRequest(
  pool: Pool, agentId: string, actorId: string,
): Promise<AgentView | null> {
  // `requestAgentStop` 과 같은 이유로 대상 확인이 **먼저**다 — 사람 계정에 조용히
  // 성공하면 안 된다. 되돌리기는 요청보다 느슨해서는 안 되므로 같은 관문을 통과시킨다.
  const existing = await getAgent(pool, agentId);
  if (!existing) return null;
  await pool.query(
    `update agent_config set
       stop_requested_at = null,
       stop_acked_at = null,
       stop_requested_by = $2,
       updated_at = now()
     where account_id = $1 and stop_requested_at is not null`,
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

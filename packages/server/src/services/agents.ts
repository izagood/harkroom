import type { Pool, PoolClient } from 'pg';
import { AGENT_HARNESSES, type AgentConfig, type AgentHarness, type AgentView } from '@murmur/shared';
import { getAgentDefaults } from './agentDefaults.js';

const COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  coalesce(c.instructions, '') as instructions,
  coalesce(c.harness, 'claude-code') as harness,
  c.model, c.effort, c.working_dir as "workingDir",
  coalesce(c.mention_permission, 'auto') as "mentionPermission",
  c.owner_account_id as "ownerAccountId",
  a.disabled_at is not null as disabled,
  v.version as "runnerVersion"`;

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

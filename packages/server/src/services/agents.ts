import type { Pool, PoolClient } from 'pg';
import { AGENT_HARNESSES, type AgentConfig, type AgentHarness, type AgentView } from '@murmur/shared';

const COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  coalesce(c.instructions, '') as instructions,
  coalesce(c.harness, 'claude-code') as harness,
  c.model, c.effort, c.working_dir as "workingDir"`;

const FROM = `from account a left join agent_config c on c.account_id = a.id`;

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
  client: PoolClient | Pool, accountId: string, patch: Partial<AgentConfig>,
): Promise<void> {
  // 지정된 필드만 갱신한다. 키 부재는 '손대지 않음', null 은 'harness 기본값으로 되돌리기'다 —
  // 구분하지 못하면 지시문만 고치려다 모델 지정이 조용히 사라진다.
  await client.query(
    `insert into agent_config (account_id, instructions, harness, model, effort, working_dir)
     values ($1, coalesce($3, ''), coalesce($5, 'claude-code'), $6, $8, $10)
     on conflict (account_id) do update set
       instructions = case when $2::bool then excluded.instructions else agent_config.instructions end,
       harness      = case when $4::bool then excluded.harness      else agent_config.harness      end,
       model        = case when $7::bool then excluded.model        else agent_config.model        end,
       effort       = case when $9::bool then excluded.effort       else agent_config.effort       end,
       working_dir  = case when $11::bool then excluded.working_dir else agent_config.working_dir  end,
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
    ],
  );
}

export async function createAgentAccount(
  pool: Pool, input: { handle: string; displayName: string } & Partial<AgentConfig>,
): Promise<AgentView> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const created = await client.query(
      `insert into account (handle, display_name, kind) values ($1, $2, 'agent') returning id`,
      [input.handle, input.displayName],
    );
    const id = created.rows[0].id as string;
    await upsertConfig(client, id, input);
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

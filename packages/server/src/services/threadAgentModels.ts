import type { Pool, PoolClient } from 'pg';
import { EFFORT_MAX, MODEL_ID_MAX, type EffectiveAgentModel, type ThreadAgentModelView } from '@harkroom/shared';

/**
 * 스레드 × 에이전트 모델 지정(마이그레이션 079).
 *
 * **무효 판정은 읽을 때 한다.** 행의 `harness` 가 에이전트의 지금 하네스와 다르면 `stale` 이고
 * 실효값 계산에서 빠진다(결정 9). 행을 지우지 않는 이유는 마이그레이션 머리 주석에 있다.
 *
 * 스레드 루트는 **채널 최상위 글**이다. 채널에서 바로 부른 멘션은 그 글 자체가 루트가 되므로
 * 작성창 칩(결정 1·C)으로 정한 값도 같은 행이다.
 */

const COLS = `t.thread_root_id as "threadRootId", t.agent_id as "agentId", t.harness, t.model, t.effort,
  t.set_by as "setBy", t.set_at as "setAt",
  coalesce(c.harness, 'claude-code') as "currentHarness",
  (t.harness is distinct from coalesce(c.harness, 'claude-code')) as stale`;
const FROM = `from thread_agent_model t left join agent_config c on c.account_id = t.agent_id`;

export async function listThreadAgentModels(
  db: Pool | PoolClient, threadRootId: string,
): Promise<ThreadAgentModelView[]> {
  const res = await db.query<ThreadAgentModelView>(
    `select ${COLS} ${FROM} where t.thread_root_id = $1 order by t.set_at`, [threadRootId],
  );
  return res.rows.map(normalize);
}

export async function getThreadAgentModel(
  db: Pool | PoolClient, threadRootId: string, agentId: string,
): Promise<ThreadAgentModelView | null> {
  const res = await db.query<ThreadAgentModelView>(
    `select ${COLS} ${FROM} where t.thread_root_id = $1 and t.agent_id = $2`, [threadRootId, agentId],
  );
  return res.rows[0] ? normalize(res.rows[0]) : null;
}

function normalize(r: ThreadAgentModelView): ThreadAgentModelView {
  return { ...r, setAt: new Date(r.setAt).toISOString() };
}

/** 값 하나를 다듬는다. 빈 문자열은 null("설정을 따른다")이다 — 화면의 빈 칸이 그 뜻이다. */
export function cleanAxis(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  return v.length === 0 ? null : v.slice(0, max);
}

export type SetThreadAgentModelResult =
  | { ok: true; row: ThreadAgentModelView | null }
  | { ok: false; reason: 'not_found' | 'not_an_agent' | 'not_a_root' };

/**
 * 정한다. 두 축이 다 비면 **푼다**(행이 없는 것이 "지정 없음"이다 — 둘 다 null 인 행은 표가
 * 막는다). 하네스는 지금 에이전트의 것을 적는다: 사람이 고른 이름은 그 하네스의 이름이다.
 *
 * 루트 판정: 같은 채널의 **최상위** 글이어야 한다. 스레드 답글을 루트로 받으면 러너가 그
 * 앵커로 찾지 못해 지정이 조용히 안 먹는다.
 */
export async function setThreadAgentModel(
  db: Pool | PoolClient,
  input: { channelId: string; threadRootId: string; agentId: string; model: string | null; effort: string | null; setBy: string },
): Promise<SetThreadAgentModelResult> {
  const root = await db.query(
    `select 1 from message where id = $1 and channel_id = $2 and thread_root_id is null and deleted_at is null`,
    [input.threadRootId, input.channelId],
  );
  if (!root.rowCount) return { ok: false, reason: 'not_a_root' };
  const agent = await db.query<{ kind: string; harness: string | null }>(
    `select a.kind, c.harness from account a left join agent_config c on c.account_id = a.id
      where a.id = $1 and a.deleted_at is null`, [input.agentId],
  );
  if (!agent.rowCount) return { ok: false, reason: 'not_found' };
  if (agent.rows[0]!.kind !== 'agent') return { ok: false, reason: 'not_an_agent' };

  const model = cleanAxis(input.model, MODEL_ID_MAX);
  const effort = cleanAxis(input.effort, EFFORT_MAX);
  if (model === null && effort === null) {
    await db.query(`delete from thread_agent_model where thread_root_id = $1 and agent_id = $2`,
      [input.threadRootId, input.agentId]);
    return { ok: true, row: null };
  }
  await db.query(
    `insert into thread_agent_model (thread_root_id, agent_id, harness, model, effort, set_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (thread_root_id, agent_id) do update set
       harness = excluded.harness, model = excluded.model, effort = excluded.effort,
       set_by = excluded.set_by, set_at = now()`,
    [input.threadRootId, input.agentId, agent.rows[0]!.harness ?? 'claude-code', model, effort, input.setBy],
  );
  return { ok: true, row: await getThreadAgentModel(db, input.threadRootId, input.agentId) };
}

/** 푼다. 없던 것을 풀면 false. */
export async function clearThreadAgentModel(
  db: Pool | PoolClient, threadRootId: string, agentId: string,
): Promise<boolean> {
  const res = await db.query(`delete from thread_agent_model where thread_root_id = $1 and agent_id = $2`,
    [threadRootId, agentId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * 메시지 하나가 속한 스레드의 루트. 루트 글이면 자기 자신이다. 없는 글이면 null.
 */
export async function threadRootOf(db: Pool | PoolClient, messageId: string): Promise<string | null> {
  const res = await db.query<{ root: string }>(
    `select coalesce(thread_root_id, id) as root from message where id = $1`, [messageId],
  );
  return res.rows[0]?.root ?? null;
}

/**
 * 이 에이전트가 이 스레드에서 **실제로 쓸** 모델·effort. 러너(`GET /agent/thread-model`)와
 * 발화의 어긋남 판정(`reportedModel.ts`)이 이 하나를 쓴다 — 둘이 다르게 계산하면 스레드에서
 * 지정한 모델로 답한 발화가 "설정과 어긋남" 으로 뜬다.
 *
 * 순서: 살아 있는(하네스가 같은) 스레드 지정 → `agent_config`. 에이전트 설정이 비면 null 이고
 * 러너는 플래그를 붙이지 않는다(하네스 기본값). `agent_defaults` 는 여기서 보지 않는다 —
 * 그 값은 생성 때 복사되는 기본값이고 러너도 보지 않는다(`shared` 의 AgentDefaults 주석).
 */
export async function effectiveAgentModel(
  db: Pool | PoolClient, agentId: string, threadRootId: string | null,
): Promise<EffectiveAgentModel> {
  const res = await db.query<{ cm: string | null; ce: string | null; tm: string | null; te: string | null }>(
    `select c.model as cm, c.effort as ce, t.model as tm, t.effort as te
       from account a
       left join agent_config c on c.account_id = a.id
       left join thread_agent_model t
         on t.agent_id = a.id and t.thread_root_id = $2
        and t.harness = coalesce(c.harness, 'claude-code')
      where a.id = $1`,
    [agentId, threadRootId],
  );
  const r = res.rows[0];
  const tm = r?.tm ?? null;
  const te = r?.te ?? null;
  return {
    model: tm ?? r?.cm ?? null,
    effort: te ?? r?.ce ?? null,
    source: { model: tm !== null ? 'thread' : 'agent', effort: te !== null ? 'thread' : 'agent' },
  };
}

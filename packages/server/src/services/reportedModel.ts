import type { Pool, PoolClient } from 'pg';
import { MODEL_ID_MAX, type ModelMeta, modelsDisagree } from '@harkroom/shared';

/**
 * 발화가 실어 온 모델 ID 를 `meta.model` 로 바꾼다(#600).
 *
 * **왜 서버가 판정까지 하는가.** 어긋남(`mismatch`)은 신고값과 **설정값**을 견주어야 알 수
 * 있는데, 설정값(`agent_config.model` → `agent_defaults.model`)은 admin·소유자만 보는
 * 값이다(`GET /accounts/agents`). 판정을 화면으로 넘기면 화면이 그 설정을 받아야 하고,
 * 그러면 채널을 보는 모두에게 남의 에이전트 설정이 새어 나간다. 여기서 한 번 판정해
 * **사실만** 싣는다.
 *
 * 발화하는 도구 다섯이 모두 이 함수를 통과한다 — 하나만 빠지면 그 도구로 답한 에이전트만
 * 모델을 알 수 없고, 사람은 그것을 '모델이 안 실렸다'가 아니라 '모델을 모르겠다'로 읽는다.
 */
export async function reportedModelMeta(
  db: Pool | PoolClient, authorId: string, reported: string | null | undefined,
  threadRootId: string | null = null,
): Promise<Partial<ModelMeta>> {
  if (!reported) return {};
  const id = reported.trim().slice(0, MODEL_ID_MAX);
  if (id.length === 0) return {};
  const configured = await effectiveModel(db, authorId, threadRootId);
  return { model: { id, ...(modelsDisagree(configured, id) ? { mismatch: true as const } : {}) } };
}

/**
 * 이 계정이 이 스레드에서 **쓰기로 된** 모델. 스레드 지정(079)이 살아 있으면 그것이고, 없으면
 * `agent_config.model` → `agent_defaults.model` 순으로 내려간다. 그것도 비면 `null`("하네스
 * 기본값")이다.
 *
 * 스레드 지정을 먼저 보는 이유: 사람이 이 스레드만 opus 로 올렸는데 설정이 sonnet 이면, 지정대로
 * 답한 발화가 "어긋남"으로 뜬다 — 맞게 돈 것을 틀렸다고 말하는 경고다. 러너가 쓰는 실효값
 * (`threadAgentModels.ts::effectiveAgentModel`)과 같은 스레드 지정을 본다. 스레드 답글의
 * `threadRootId` 가 아니라 최상위 글이면 그 글 자체가 루트일 수 있으나, 발화는 언제나 스레드
 * 안이나 채널 최상위라 루트 id 를 그대로 쓴다.
 *
 * `null` 이면 견줄 대상이 없으므로 어긋남도 없다: 하네스가 무엇을 골라도 그것이 설정이다.
 */
async function effectiveModel(
  db: Pool | PoolClient, accountId: string, threadRootId: string | null,
): Promise<string | null> {
  const found = await db.query(
    `select coalesce(nullif(t.model, ''), nullif(c.model, ''), nullif(d.model, '')) as model
       from agent_config c
       left join agent_defaults d on true
       left join thread_agent_model t
         on t.agent_id = c.account_id and t.thread_root_id = $2 and t.harness = c.harness
      where c.account_id = $1`,
    [accountId, threadRootId],
  );
  return (found.rows[0]?.model as string | null | undefined) ?? null;
}

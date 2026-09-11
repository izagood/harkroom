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
): Promise<Partial<ModelMeta>> {
  if (!reported) return {};
  const id = reported.trim().slice(0, MODEL_ID_MAX);
  if (id.length === 0) return {};
  const configured = await effectiveModel(db, authorId);
  return { model: { id, ...(modelsDisagree(configured, id) ? { mismatch: true as const } : {}) } };
}

/**
 * 이 계정에 **설정된** 모델. `agent_config.model` 이 비어 있으면 `agent_defaults.model` 로
 * 내려가고, 그것도 비면 `null`("하네스 기본값")이다 — 러너의 해석과 같은 순서다
 * (`agent/src/turn.ts` 가 `null` 일 때 `--model` 을 아예 붙이지 않는다).
 *
 * `null` 이면 견줄 대상이 없으므로 어긋남도 없다: 하네스가 무엇을 골라도 그것이 설정이다.
 */
async function effectiveModel(db: Pool | PoolClient, accountId: string): Promise<string | null> {
  const found = await db.query(
    `select coalesce(nullif(c.model, ''), nullif(d.model, '')) as model
       from agent_config c
       left join agent_defaults d on true
      where c.account_id = $1`,
    [accountId],
  );
  return (found.rows[0]?.model as string | null | undefined) ?? null;
}

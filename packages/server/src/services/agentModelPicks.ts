import type { PoolClient } from 'pg';
import { EFFORT_MAX, MODEL_ID_MAX, type ThreadAgentModelView } from '@harkroom/shared';
import { axisValid, cleanAxis, clearThreadAgentModel, getThreadAgentModel, setThreadAgentModel } from './threadAgentModels.js';

/**
 * 에이전트가 다른 에이전트를 부르며 그 스레드의 모델을 고른다(087, jaebin 승인 결정 1~9).
 *
 * 판정은 **이 함수 하나**다(`invokeGate` 와 같은 원칙 — 인가 판정이 두 곳에 살면 한쪽만 고치는 날
 * 조용히 열린다). 게시 트랜잭션 **안에서**, 팬아웃이 끝나 실제로 깨운 계정(`notified`)이 정해진 뒤에
 * 돈다. 거절이면 게시 전체가 롤백된다(결정 6 — 글은 남고 지정만 빠지면 고른 적 없는 기본값으로 턴이
 * 도는 조용한 폴백이다).
 *
 * 1. 대상은 이 글이 **실제로 깨운 다른** 에이전트다(결정 2). 자기 자신은 금지 — 에이전트가 스스로
 *    비싼 모델로 올리는 길은 막는다(사람만 바꾼다는 결정 3 의 원래 뜻).
 * 2. 대상 소유자가 켠 허용 목록(`agent_pickable_models`) 안에서만(결정 3·9). 비면 못 고른다.
 * 3. 사람이 정한 행은 덮지도 풀지도 못한다(결정 4·8, 409 `human_pinned`).
 * 4. 한 스레드에서 에이전트 지정 변경은 3번까지(결정 5, 429 `model_change_limit`).
 *
 * 값의 모양(`AXIS_PATTERN`)과 하네스가 밝힌 목록(`checkOffered`)은 사람 경로와 같은 함수를 부르는
 * 쪽(MCP 도구)이 먼저 본다.
 */

export const AGENT_PICK_LIMIT_PER_THREAD = 3;

export interface AgentModelPickInput {
  agentId: string;
  model?: string | null;
  effort?: string | null;
}

export interface PickRejection {
  status: number;
  code: 'self_pick' | 'not_called' | 'not_pickable' | 'bad_model_value' | 'human_pinned' | 'model_change_limit';
  message: string;
}

export interface PickChange {
  agentId: string;
  row: ThreadAgentModelView | null;
}

/** 허용 목록 한 줄(087, 결정 11). */
export interface PickableEntry {
  model: string;
  efforts: string[];
}

/** 저장된 jsonb 를 읽는다. 모양이 틀린 줄은 버린다 — 틀린 줄로 허용이 넓어지지 않게. */
export function readPickable(raw: unknown): PickableEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    if (!e || typeof e !== 'object') return [];
    const model = (e as { model?: unknown }).model;
    const efforts = (e as { efforts?: unknown }).efforts;
    if (typeof model !== 'string' || !model) return [];
    return [{ model, efforts: Array.isArray(efforts) ? efforts.filter((x): x is string => typeof x === 'string') : [] }];
  });
}

/**
 * 이 (모델·effort)가 허용 목록 안인가(결정 11). `applyAgentPicks` 의 판정과 같은 규칙이다 — 목록을
 * 좁힐 때 이미 저장된 에이전트 지정이 새 목록 밖인지 가르는 데 쓴다(③, security 참고 의견).
 * 모델 없는 지정(effort 만)은 목록 안일 수 없다 — 그 길이 애초에 막혀 있다.
 */
export function pickAllowed(pickable: readonly PickableEntry[], model: string | null, effort: string | null): boolean {
  if (model === null) return false;
  const entry = pickable.find((e) => e.model === model);
  if (!entry) return false;
  return effort === null || entry.efforts.includes(effort);
}

/** 다듬은 값. 두 축이 다 null 이면 "풀기" 다. */
export function cleanPicks(picks: readonly AgentModelPickInput[]): Array<{ agentId: string; model: string | null; effort: string | null }> {
  return picks.map((p) => ({
    agentId: p.agentId, model: cleanAxis(p.model, MODEL_ID_MAX), effort: cleanAxis(p.effort, EFFORT_MAX),
  }));
}

/**
 * 판정하고 쓴다. 거절이면 첫 거절을 돌려주고 **아무것도 쓰지 않는다**(호출자가 롤백한다 — 같은
 * 트랜잭션이다). 통과하면 바뀐 행들을 돌려준다: 시스템 줄·이벤트는 커밋 뒤에 호출자가 낸다.
 */
export async function applyAgentPicks(
  client: PoolClient,
  input: {
    channelId: string; threadRootId: string; actorId: string;
    picks: ReadonlyArray<{ agentId: string; model: string | null; effort: string | null }>;
    notified: ReadonlySet<string>;
  },
): Promise<{ ok: true; changes: PickChange[] } | { ok: false; rejection: PickRejection }> {
  const reject = (status: number, code: PickRejection['code'], message: string) =>
    ({ ok: false as const, rejection: { status, code, message } });

  // 먼저 전부 판정하고, 쓰기는 모두 통과한 뒤에 한다 — 둘째에서 거절하면 첫째가 반쯤 써진 채 남지
  // 않게(롤백이 지키지만, 판정과 쓰기를 섞으면 횟수 셈이 어긋난다).
  for (const p of input.picks) {
    if (p.agentId === input.actorId) return reject(403, 'self_pick', '자기 자신의 모델은 고를 수 없다 — 사람만 바꾼다');
    if (!input.notified.has(p.agentId)) {
      return reject(403, 'not_called', '이 글이 실제로 깨우는 에이전트의 모델만 고른다(멘션·호출 범위를 확인하라)');
    }
    if (!axisValid(p.model) || !axisValid(p.effort)) {
      return reject(400, 'bad_model_value', '모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다');
    }
    const clearing = p.model === null && p.effort === null;
    if (!clearing) {
      const cfg = await client.query<{ pickable: unknown }>(
        `select agent_pickable_models as pickable from agent_config where account_id = $1`, [p.agentId]);
      const pickable = readPickable(cfg.rows[0]?.pickable);
      if (pickable.length === 0) {
        return reject(403, 'not_pickable', '그 에이전트의 소유자가 다른 에이전트가 고를 수 있는 모델을 켜지 않았다');
      }
      // (모델·effort) 조합으로 본다(결정 11). 모델 없이 effort 만 올리는 길은 없다 — 그것이 모델만 묶을 때
      // 비용 상한을 비켜 가던 길이다. 하네스 목록을 몰라도(오퍼레이터 오프라인) 이 판정은 그대로다.
      if (p.model === null) {
        return reject(403, 'not_pickable', 'effort 만 고를 수는 없다 — 허용 목록의 모델을 함께 고른다');
      }
      const entry = pickable.find((e) => e.model === p.model);
      if (!entry) {
        return reject(403, 'not_pickable', `허용 목록에 없는 모델이다(${pickable.map((e) => e.model).join('·')})`);
      }
      if (p.effort !== null && !entry.efforts.includes(p.effort)) {
        return reject(403, 'not_pickable', entry.efforts.length
          ? `${p.model} 에 허용된 effort 가 아니다(${entry.efforts.join('·')})`
          : `${p.model} 은 effort 를 고를 수 없다(에이전트 설정 effort 그대로)`);
      }
    }
    const row = await getThreadAgentModel(client, input.threadRootId, p.agentId);
    if (row && row.setByKind === 'human') {
      return reject(409, 'human_pinned', '사람이 정한 지정이다 — 에이전트는 덮지도 풀지도 못한다');
    }
  }

  // 실제로 바뀌는 것만 센다 — 없던 지정을 "풀기"는 아무 일도 아니다.
  const effective = [];
  for (const p of input.picks) {
    const row = await getThreadAgentModel(client, input.threadRootId, p.agentId);
    const clearing = p.model === null && p.effort === null;
    if (clearing && !row) continue;
    if (!clearing && row && row.model === p.model && row.effort === p.effort) continue;
    effective.push(p);
  }
  if (effective.length === 0) return { ok: true, changes: [] };

  const counted = await client.query<{ n: number }>(
    `select n from thread_agent_pick_count where thread_root_id = $1 for update`, [input.threadRootId]);
  const used = counted.rows[0]?.n ?? 0;
  if (used + effective.length > AGENT_PICK_LIMIT_PER_THREAD) {
    return reject(429, 'model_change_limit',
      `이 스레드에서 에이전트가 모델을 바꾼 것이 이미 ${used}번이다(상한 ${AGENT_PICK_LIMIT_PER_THREAD}) — 사람에게 넘겨라`);
  }
  await client.query(
    `insert into thread_agent_pick_count (thread_root_id, n) values ($1, $2)
     on conflict (thread_root_id) do update set n = thread_agent_pick_count.n + excluded.n`,
    [input.threadRootId, effective.length],
  );

  const changes: PickChange[] = [];
  for (const p of effective) {
    if (p.model === null && p.effort === null) {
      // 판정 뒤에 사람이 정했으면 지워지지 않는다 — 그때는 거절하고 롤백한다(결정 4·8).
      if (!(await clearThreadAgentModel(client, input.threadRootId, p.agentId, { onlyAgentRows: true }))) {
        return reject(409, 'human_pinned', '사람이 정한 지정이다 — 에이전트는 덮지도 풀지도 못한다');
      }
      changes.push({ agentId: p.agentId, row: null });
      continue;
    }
    const set = await setThreadAgentModel(client, {
      channelId: input.channelId, threadRootId: input.threadRootId, agentId: p.agentId,
      model: p.model, effort: p.effort, setBy: input.actorId, setByKind: 'agent',
    });
    if (!set.ok && set.reason === 'human_pinned') {
      return reject(409, 'human_pinned', '사람이 정한 지정이다 — 에이전트는 덮지도 풀지도 못한다');
    }
    if (!set.ok) return reject(403, 'not_called', '그 대상에는 모델을 정할 수 없다');
    changes.push({ agentId: p.agentId, row: set.row });
  }
  return { ok: true, changes };
}

// 스레드 × 에이전트 모델 지정(079) — jaebin 승인 결정 1~13(2026-10-01).
//
// 사람만 바꾼다(결정 3): 에이전트가 스스로 비싼 모델로 올리는 길을 두지 않는다. 그래서 MCP
// 도구가 없고, REST 에서도 에이전트 계정은 403 이다. 채널을 볼 수 있는 사람이면 누구나다 —
// 허용 목록은 첫 판에 없다(결정 4).
//
// 바꾸면 **다음 턴부터** 먹는다(결정 11) — 러너가 턴 시작에 `GET /agent/thread-model` 로 읽기
// 때문이다. 도는 턴의 argv 는 이미 정해졌다.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { EFFORT_MAX, MODEL_ID_MAX, SYSTEM_ACCOUNT_PLACEHOLDER, type ThreadAgentModelView } from '@harkroom/shared';
import { recordAudit } from '../audit.js';
import { emitEvent, emitPosted } from '../events.js';
import { assignmentOf } from '../services/agents.js';
import { assertChannelVisible, audienceFor, channelPostGate } from '../services/channels.js';
import { postMessage } from '../services/messages.js';
import { readPickable } from '../services/agentModelPicks.js';
import {
  axisValid, clearThreadAgentModel, cleanAxis, effectiveAgentModel, isChannelRoot, listThreadAgentModels, setThreadAgentModel, threadRootOf,
} from '../services/threadAgentModels.js';
import type { OperatorHub } from '../ws/operatorHub.js';

const threadParam = z.object({ id: z.string().uuid(), rootId: z.string().uuid() });
const agentParam = threadParam.extend({ agentId: z.string().uuid() });
export const agentModelInput = z.object({
  model: z.string().max(MODEL_ID_MAX).nullable().optional(),
  effort: z.string().max(EFFORT_MAX).nullable().optional(),
});

export type OfferCheck = { ok: true } | { ok: false; code: 'model_not_offered' | 'effort_not_offered'; message: string };

/**
 * 하네스가 **받는다고 밝힌** 값인지 본다(결정 6 의 앞단). 그 에이전트가 배정된 오퍼레이터가
 * 붙어 있고 목록을 실었을 때만 거절한다 — 목록이 없으면(옛 오퍼레이터·오프라인·조회 실패)
 * "모른다"이므로 받는다. 모르는데 막으면 사람은 맞는 이름도 못 넣는다.
 *
 * 그래도 하네스가 거절하면 턴에서 크게 실패한다(러너 몫) — 여기는 그 일을 줄이는 자리다.
 */
export async function checkOffered(
  pool: Pool, hub: OperatorHub | undefined, agentId: string, model: string | null, effort: string | null,
): Promise<OfferCheck> {
  if (!hub || (model === null && effort === null)) return { ok: true };
  const assignment = await assignmentOf(pool, agentId);
  if (!assignment) return { ok: true };
  const caps = hub.capabilities(assignment.operatorId);
  const cfg = await pool.query<{ harness: string | null; model: string | null }>(
    `select harness, model from agent_config where account_id = $1`, [agentId]);
  const harness = cfg.rows[0]?.harness ?? 'claude-code';
  const models = caps?.harnesses[harness]?.models;
  if (!models) return { ok: true };
  if (model !== null && !models.some((m) => m.id === model)) {
    return { ok: false, code: 'model_not_offered', message: `${harness} 가 이 머신에서 밝힌 모델 목록에 ${model} 가 없다` };
  }
  // effort 는 **그 턴에 쓸 모델**의 목록으로 본다 — 모델을 안 정했으면 에이전트 설정 모델이다.
  const target = model ?? cfg.rows[0]?.model ?? null;
  const efforts = target ? models.find((m) => m.id === target)?.efforts : undefined;
  if (effort !== null && efforts && !efforts.includes(effort)) {
    return { ok: false, code: 'effort_not_offered', message: `${target} 는 effort ${effort} 를 받지 않는다(${efforts.join('·')})` };
  }
  return { ok: true };
}

/**
 * 지정이 바뀐 것을 스레드에 남긴다(결정: 누가 언제 바꿨는지). 본문에 `@` 를 쓰지 않는다 —
 * 시스템 줄이 그 에이전트를 부르면 안 된다. 화면은 `meta.threadAgentModel` 로 그리고 본문은
 * 옛 앱을 위한 대체 문구다. 바꾼 사람은 자리표시자 + `meta.accountId`(멤버 입·퇴장과 같은 관용구).
 */
export async function announceChange(
  pool: Pool, channelId: string, threadRootId: string, actorId: string, agentId: string,
  row: ThreadAgentModelView | null,
  /** 누가 정했나(087). 에이전트가 정한 것은 문구 끝에 밝히고 meta 에 실어 칩이 갈라 그린다. */
  byKind: 'human' | 'agent' = 'human',
): Promise<void> {
  const handle = (await pool.query<{ handle: string }>(`select handle from account where id = $1`, [agentId])).rows[0]?.handle ?? '';
  const tag = byKind === 'agent' ? ' (에이전트 지정)' : '';
  const value = row ? [row.model ?? '설정 모델', row.effort].filter(Boolean).join(' · ') : null;
  const body = value
    ? `${SYSTEM_ACCOUNT_PLACEHOLDER}님이 이 스레드에서 ${handle} 의 모델을 ${value} 로 정했습니다${tag}. 다음 턴부터 적용됩니다.`
    : `${SYSTEM_ACCOUNT_PLACEHOLDER}님이 이 스레드에서 ${handle} 의 모델 지정을 풀었습니다${tag}. 다음 턴부터 기본값으로 돕니다.`;
  const posted = await postMessage(pool, {
    channelId, authorId: actorId, body, threadRootId, kind: 'system',
    meta: { accountId: actorId, threadAgentModel: { agentId, model: row?.model ?? null, effort: row?.effort ?? null, byKind } },
  });
  if (!posted.failure && !posted.replayed) emitPosted(posted, await audienceFor(pool, channelId));
}

export async function emitChanged(
  pool: Pool, channelId: string, threadRootId: string, agentId: string, row: ThreadAgentModelView | null,
): Promise<void> {
  emitEvent({ type: 'thread.agent_model.changed', channelId, threadRootId, agentId, row, audience: await audienceFor(pool, channelId) });
}

/**
 * 고르개·에이전트 도구의 재료 하나. 하네스·설정값·하네스가 밝힌 목록(`models`, 모르면 없음)·
 * 다른 에이전트가 고를 수 있는 목록(`pickable`, 087). 지시문·MCP·소유자는 싣지 않는다.
 */
export async function agentModelOptions(pool: Pool, hub: OperatorHub | undefined, agentId: string) {
  const found = await pool.query<{ harness: string | null; model: string | null; effort: string | null; pickable: unknown }>(
    `select c.harness, c.model, c.effort, c.agent_pickable_models as pickable
       from account a left join agent_config c on c.account_id = a.id
      where a.id = $1 and a.kind = 'agent' and a.deleted_at is null`, [agentId]);
  if (!found.rowCount) return null;
  const row = found.rows[0]!;
  const harness = row.harness ?? 'claude-code';
  const assignment = await assignmentOf(pool, agentId);
  const caps = assignment && hub ? hub.capabilities(assignment.operatorId) : null;
  const models = caps?.harnesses[harness]?.models;
  return { harness, model: row.model, effort: row.effort, pickable: readPickable(row.pickable), ...(models ? { models } : {}) };
}

function refuse(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function registerThreadAgentModelRoutes(
  app: FastifyInstance, pool: Pool, deps: { operatorHub?: OperatorHub } = {},
): Promise<void> {
  /** 스레드의 지정 전부. 채널을 볼 수 있는 사람·에이전트 누구나 — 머리 칩이 그린다. */
  app.get('/channels/:id/threads/:rootId/agent-models', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, rootId } = threadParam.parse(req.params);
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return refuse(reply, 403, 'forbidden', 'not a member of this dm channel');
    }
    // **루트를 이 채널에 묶는다**(security 검토 ①). 채널 권한만 보면 볼 수 있는 채널 A 의 경로에
    // 비공개 채널 B 의 rootId 를 넣어 B 스레드의 지정을 읽을 수 있다.
    if (!(await isChannelRoot(pool, id, rootId))) return refuse(reply, 404, 'not_a_root', '그 채널의 최상위 글이 아니다');
    return { agentModels: await listThreadAgentModels(pool, rootId) };
  });

  /** 정한다. 두 축이 다 비면 푼다(200 + `row: null`). */
  app.put('/channels/:id/threads/:rootId/agent-models/:agentId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, rootId, agentId } = agentParam.parse(req.params);
    if (req.account!.kind !== 'human') return refuse(reply, 403, 'human_only', '모델 지정은 사람만 바꾼다');
    const parsed = agentModelInput.safeParse(req.body ?? {});
    if (!parsed.success) return refuse(reply, 400, 'bad_request', parsed.error.message);
    const gate = await channelPostGate(pool, id, req.account!.id);
    if (gate === 'forbidden') return refuse(reply, 403, 'forbidden', 'not a member of this dm channel');
    if (gate === 'archived') return refuse(reply, 403, 'channel_archived', 'archived channels are read-only');
    const model = cleanAxis(parsed.data.model, MODEL_ID_MAX);
    const effort = cleanAxis(parsed.data.effort, EFFORT_MAX);
    if (!axisValid(model) || !axisValid(effort)) {
      return refuse(reply, 400, 'bad_model_value', '모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다');
    }
    const offered = await checkOffered(pool, deps.operatorHub, agentId, model, effort);
    if (!offered.ok) return refuse(reply, 400, offered.code, offered.message);
    const result = await setThreadAgentModel(pool, { channelId: id, threadRootId: rootId, agentId, model, effort, setBy: req.account!.id });
    if (!result.ok) {
      if (result.reason === 'not_a_root') return refuse(reply, 404, 'not_a_root', '그 채널의 최상위 글이 아니다');
      if (result.reason === 'not_an_agent') return refuse(reply, 400, 'not_an_agent', '에이전트에게만 모델을 정한다');
      return refuse(reply, 404, 'not_found', 'no such account');
    }
    await announceChange(pool, id, rootId, req.account!.id, agentId, result.row);
    await emitChanged(pool, id, rootId, agentId, result.row);
    await recordAudit(pool, {
      action: 'thread.agent_model.set', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: rootId, detail: { agentId, model, effort },
    }, req);
    return { row: result.row };
  });

  /** 푼다. 없던 것을 풀면 404 — 조용한 204 는 있었다고 믿게 한다(자동 멘션과 같은 규칙). */
  app.delete('/channels/:id/threads/:rootId/agent-models/:agentId', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, rootId, agentId } = agentParam.parse(req.params);
    if (req.account!.kind !== 'human') return refuse(reply, 403, 'human_only', '모델 지정은 사람만 바꾼다');
    const gate = await channelPostGate(pool, id, req.account!.id);
    if (gate === 'forbidden') return refuse(reply, 403, 'forbidden', 'not a member of this dm channel');
    if (gate === 'archived') return refuse(reply, 403, 'channel_archived', 'archived channels are read-only');
    // 루트를 이 채널에 묶는다(security 검토 ①) — 남의 비공개 채널 스레드의 지정을 지우지 못하게.
    if (!(await isChannelRoot(pool, id, rootId))) return refuse(reply, 404, 'not_a_root', '그 채널의 최상위 글이 아니다');
    if (!(await clearThreadAgentModel(pool, rootId, agentId))) {
      return refuse(reply, 404, 'not_found', 'no model is set for that agent in this thread');
    }
    await announceChange(pool, id, rootId, req.account!.id, agentId, null);
    await emitChanged(pool, id, rootId, agentId, null);
    await recordAudit(pool, {
      action: 'thread.agent_model.clear', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: rootId, detail: { agentId },
    }, req);
    return reply.code(204).send();
  });

  /**
   * 스레드 칩 고르개의 재료 — 그 에이전트의 하네스·기본값·하네스가 밝힌 모델 목록(effort 포함).
   *
   * **사람이면 누구나** 읽는다. 결정 3 이 "채널의 사람 누구나 바꾼다" 이므로 고를 목록도 그만큼
   * 열려야 한다 — 오퍼레이터 능력(`/operators/:id/capabilities`)은 operator.manage 전용이라 그
   * 길로는 일반 멤버의 고르개가 늘 자유 입력으로 떨어진다. 여기서 내주는 것은 모델 이름과 기본값
   * 뿐이다(지시문·MCP·소유자는 싣지 않는다). `models` 가 없으면 "모른다"다(오프라인·옛 오퍼레이터).
   */
  app.get('/agents/:agentId/model-options', { preHandler: app.requireAccount }, async (req, reply) => {
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(req.params);
    if (req.account!.kind !== 'human') return refuse(reply, 403, 'human_only', '모델 지정은 사람만 바꾼다');
    const opts = await agentModelOptions(pool, deps.operatorHub, agentId);
    if (!opts) return refuse(reply, 404, 'not_found', 'no such agent');
    return opts;
  });

  /**
   * "다른 에이전트가 나를 부를 때 고를 수 있는 모델"(087, 결정 3·9) — **그 에이전트의 소유자만**
   * 정한다. 빈 목록은 "고르지 못하게"다(opt-in 기본값). 값은 argv 로 가므로 사람 지정과 같은 모양
   * 검사(`AXIS_PATTERN`)를 지난다.
   */
  app.put('/accounts/agents/:agentId/pickable-models', { preHandler: app.requireAccount }, async (req, reply) => {
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(req.params);
    // 사람이 켠다(결정 9). 에이전트가 소유자인 경우(agent.create grant, 소유자를 에이전트로 정한
    // 경우)에도 에이전트 PAT 은 이 목록을 못 연다(security #1010 권장 a).
    if (req.account!.kind !== 'human') return refuse(reply, 403, 'human_only', '허용 목록은 사람이 켠다');
    // (모델·effort) 조합(결정 11). `efforts` 가 비면 그 모델은 effort 를 고르지 못한다.
    const parsed = z.object({
      models: z.array(z.object({
        model: z.string().min(1).max(MODEL_ID_MAX),
        efforts: z.array(z.string().min(1).max(EFFORT_MAX)).max(8).default([]),
      })).max(20),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return refuse(reply, 400, 'bad_request', parsed.error.message);
    const byModel = new Map<string, string[]>();
    for (const e of parsed.data.models) {
      const model = e.model.trim();
      if (!model) continue;
      const efforts = [...new Set([...(byModel.get(model) ?? []), ...e.efforts.map((x) => x.trim()).filter(Boolean)])];
      byModel.set(model, efforts);
    }
    const models = [...byModel].map(([model, efforts]) => ({ model, efforts }));
    if (models.some((e) => !axisValid(e.model) || e.efforts.some((x) => !axisValid(x)))) {
      return refuse(reply, 400, 'bad_model_value', '모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다');
    }
    const owner = await pool.query<{ owner: string | null }>(
      `select c.owner_account_id as owner from account a join agent_config c on c.account_id = a.id
        where a.id = $1 and a.kind = 'agent' and a.deleted_at is null`, [agentId]);
    if (!owner.rowCount) return refuse(reply, 404, 'not_found', 'no such agent');
    if (owner.rows[0]!.owner !== req.account!.id) {
      return refuse(reply, 403, 'owner_only', '이 에이전트의 소유자만 정한다');
    }
    await pool.query(`update agent_config set agent_pickable_models = $2::jsonb where account_id = $1`, [agentId, JSON.stringify(models)]);
    await recordAudit(pool, {
      action: 'agent.pickable_models.set', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: agentId, detail: { models },
    }, req);
    return { models };
  });

  /**
   * 러너가 턴 시작에 읽는 실효값. PAT 의 주인(에이전트) 것만 준다 — 대상 id 를 받지 않는다
   * (`/agent/config` 와 같은 규칙). `messageId` 는 앵커 아무것이나 된다: 스레드 답글이면 그
   * 루트를, 최상위 글이면 그 글을 루트로 본다. 없으면(채널 최상위 턴의 옛 러너) 설정값이다.
   */
  app.get('/agent/thread-model', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent') return refuse(reply, 403, 'agent_only', 'agents only');
    const q = z.object({ messageId: z.string().uuid().optional() }).safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, 'bad_request', q.error.message);
    const root = q.data.messageId ? await threadRootOf(pool, q.data.messageId) : null;
    return effectiveAgentModel(pool, req.account!.id, root);
  });
}

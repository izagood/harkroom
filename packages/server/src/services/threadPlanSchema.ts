/**
 * 계획판 입력의 **꼴** 검사(N3·N4) — MCP 도구가 쓰고, 3차의 사람 쓰기(REST)도 같은 것을 쓴다.
 *
 * 나눈 몫: 여기는 타입·열거값·id 꼴·링크 모양과 크기의 바깥 울타리만 본다. 글자 수 상한·순환·참조는 shared
 * `validatePlan` 이 정본이다 — 글자 수는 거기서 코드 포인트로 세므로, 여기 `max` 는 UTF-16 길이로 넉넉히(두 배) 두어
 * 두 판정이 엇갈려 이모지 제목이 여기서 먼저 막히지 않게 한다.
 * `z.object` 는 모르는 키를 버린다(strip) — 저장되는 doc 에 아무 칸이나 실리지 않는다.
 */
import { z } from 'zod';
import { PLAN_GROUP_ID_RE, PLAN_LIMITS, PLAN_STEP_ID_RE } from '@harkroom/shared';

const text = (limit: number) => z.string().trim().min(1).max(limit * 2);
const optText = (limit: number) => z.string().max(limit * 2).nullable().optional();
const nodeId = z.string().regex(/^[sg][1-9][0-9]{0,3}$/);
const deps = z.array(nodeId).max(PLAN_LIMITS.dependsOn * 2);

export const planLinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr'), repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/), number: z.number().int().positive() }),
  z.object({ kind: z.literal('message'), id: z.string().uuid() }),
  z.object({ kind: z.literal('card'), messageId: z.string().uuid() }),
  z.object({ kind: z.literal('workitem'), id: z.string().uuid() }),
]);

export const planStateSchema = z.enum(['pending', 'active', 'blocked', 'done']);

export const planGroupSchema = z.object({
  id: z.string().regex(PLAN_GROUP_ID_RE),
  title: text(PLAN_LIMITS.title),
  assigneeId: z.string().uuid().nullable().optional(),
  linkedRootId: z.string().uuid().nullable().optional(),
  dependsOn: deps.default([]),
});

export const planStepSchema = z.object({
  id: z.string().regex(PLAN_STEP_ID_RE),
  groupId: z.string().regex(PLAN_GROUP_ID_RE).nullable().optional(),
  title: text(PLAN_LIMITS.title),
  state: planStateSchema,
  assigneeId: z.string().uuid().nullable().optional(),
  links: z.array(planLinkSchema).max(PLAN_LIMITS.links * 2).default([]),
  dependsOn: deps.default([]),
  blockedReason: optText(PLAN_LIMITS.blockedReason),
});

export const planDocSchema = z.object({
  goal: text(PLAN_LIMITS.goal),
  groups: z.array(planGroupSchema).max(PLAN_LIMITS.groups * 2).default([]),
  steps: z.array(planStepSchema).max(PLAN_LIMITS.steps * 2).default([]),
  next: optText(PLAN_LIMITS.next),
  blocked: optText(PLAN_LIMITS.blocked),
  managerId: z.string().uuid().nullable().optional(),
});

/** `thread.plan.item` 의 칸(threadRootId 빼고). */
export const planItemShape = {
  type: z.enum(['step', 'group', 'plan']).optional(),
  /** 자동 진행. `type: 'plan'` 과 함께, 다른 칸 없이 쓴다. null=끄기. 저장은 doc 이 아니라 열이다(`threadPlanAuto.ts`). */
  auto: z.object({ until: nodeId, sourceMessageId: z.string().uuid() }).nullable().optional(),
  id: nodeId.optional(),
  remove: z.boolean().optional(),
  after: nodeId.nullable().optional(),
  title: text(PLAN_LIMITS.title).optional(),
  groupId: z.string().regex(PLAN_GROUP_ID_RE).nullable().optional(),
  state: planStateSchema.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  linkedRootId: z.string().uuid().nullable().optional(),
  dependsOn: deps.optional(),
  addDependsOn: deps.optional(),
  removeDependsOn: deps.optional(),
  addLinks: z.array(planLinkSchema).max(PLAN_LIMITS.links * 2).optional(),
  removeLinks: z.array(planLinkSchema).max(PLAN_LIMITS.links * 2).optional(),
  blockedReason: optText(PLAN_LIMITS.blockedReason),
  managerId: z.string().uuid().nullable().optional(),
  ifRev: z.number().int().min(1).optional(),
};

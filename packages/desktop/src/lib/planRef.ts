import { findPlanRefs, parsePlanRef, planRefText, type PlanAskRecipient, type PlanRef, type PlanStep, type ThreadPlanView } from '@harkroom/shared';
import { stepGoTargets, stepKind, type PlanRowKind } from './threadPlan';

/** 단계에 대해 묻는 중인 작성칸의 상태. `mention` 은 작성칸 맨 앞에 넣은 글자 그대로다. */
export interface PlanAsk {
  stepId: string;
  to: string | null;
  mention: string;
  /** 왜 그 상대인가. 사람이 ▾로 고르면 `null` 이다. */
  reason: PlanAskRecipient['reason'] | null;
  /** 바뀔 때마다 작성칸에 포커스를 준다. */
  focus: number;
}

/** 글 하나가 판을 받아 칩으로 그릴 스레드 수. 나머지는 글자로 둔다 — 글 하나가 요청을 늘리지 못하게. */
export const PLAN_REF_ROOTS_MAX = 3;

/** 칩에 그리는 제목의 길이. 남이 쓴 글이라 그릴 때 자른다. */
const CHIP_TITLE_MAX = 80;

export function clipPlanTitle(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim());
  return chars.length > CHIP_TITLE_MAX ? `${chars.slice(0, CHIP_TITLE_MAX).join('')}…` : chars.join('');
}

/** 이 글에서 칩으로 그릴 스레드들(나온 순서로 앞의 몇 개). */
export function planRefRoots(body: string): Set<string> {
  const roots = new Set<string>();
  for (const ref of findPlanRefs(body)) {
    if (roots.size >= PLAN_REF_ROOTS_MAX) break;
    roots.add(ref.rootId);
  }
  return roots;
}

/** 칩이 그릴 것. 판을 아직 못 받았으면 글에 적힌 글자, 볼 수 없으면 제목 없음. */
export type PlanRefView =
  | { kind: 'hidden' }
  | { kind: 'gone'; noPlan: boolean; text: string }
  | { kind: 'pending'; text: string }
  | { kind: 'live'; step: PlanStep; text: string; row: PlanRowKind; pr: number | null; titleChanged: boolean };

export function planRefView(ref: PlanRef, plan: ThreadPlanView | null | undefined, denied: boolean, me: string | null): PlanRefView {
  if (denied) return { kind: 'hidden' };
  const written = clipPlanTitle(`${ref.stepId}${ref.title ? ` ${ref.title}` : ''}`);
  if (plan === undefined) return { kind: 'pending', text: written };
  if (plan === null) return { kind: 'gone', noPlan: true, text: written };
  const step = plan.doc.steps.find((s) => s.id === ref.stepId);
  if (!step) return { kind: 'gone', noPlan: false, text: written };
  const pr = stepGoTargets(step).find((x) => x.kind === 'pr');
  // 적힌 제목은 링크로 지을 때 다듬고 자른 글자다 — 지금 제목도 같은 길로 지어 견준다.
  const now = parsePlanRef(planRefText(ref.rootId, ref.stepId, step.title))?.title ?? null;
  return {
    kind: 'live',
    step,
    text: clipPlanTitle(`${ref.stepId} ${step.title}`),
    row: stepKind(plan, step, me),
    pr: pr?.kind === 'pr' ? pr.number : null,
    titleChanged: ref.title !== null && ref.title !== now,
  };
}

/** 작성칸 맨 앞의 받는 이 글자를 바꾼다. 사람이 앞 글자를 고쳤으면 그 글은 건드리지 않는다. */
export function swapAskMention(draft: string, prev: string, next: string): string {
  const rest = prev && draft.startsWith(prev) ? draft.slice(prev.length) : draft;
  return next && rest.startsWith(next) ? rest : `${next}${rest}`;
}

/** 보낼 글. 단계 링크는 맨 앞 멘션 바로 뒤에 넣는다 — 맨 앞 멘션이 받는 이를 정한다. */
export function withAskLink(body: string, rootId: string, stepId: string, title: string): string {
  const link = planRefText(rootId, stepId, title);
  const m = /^@\S+\s*/.exec(body);
  if (!m) return body ? `${link} ${body}` : link;
  const rest = body.slice(m[0].length);
  return `${m[0].trimEnd()} ${link}${rest ? ` ${rest}` : ''}`;
}

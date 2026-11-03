import { useEffect, useRef, useState } from 'react';
import type { PlanDerivedState, PlanGroup, PlanStep, ThreadPlanProgress, ThreadPlanView } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { isPlanStale, loadPlanOpen, planFlow, planPills, planTitleOf, savePlanOpen, stepsOf } from '../lib/threadPlan';
import { PlanChip } from './PlanChip';
import { useT } from '../i18n/useT';

/**
 * 스레드 계획판 띠 + 펼친 패널(P4, 시안 v2 D1·D3~D7).
 *
 * - **부를 길은 루트 행의 `planProgress` 뿐이다**(serverSurfaceGated) — 옛 서버나 계획 없는 스레드에서는 띠가 없고 GET 도 없다.
 * - 판은 rev 가 바뀔 때만 다시 받는다(architect D-b). 칩 값은 루트 행 것을 그대로 쓴다.
 * - 펼침은 띠 바로 아래로 내려오고 스레드 높이의 45% 까지, 넘치면 안에서 스크롤한다(D1). 스레드별로 기억하고 처음엔 접힘(D4).
 */
export function ThreadPlanBand({ rootId, progress }: { rootId: string; progress: ThreadPlanProgress | null | undefined }) {
  const t = useT();
  const plan = useActiveStore((s) => s.threadPlans[rootId]);
  const [open, setOpen] = useState(() => loadPlanOpen(rootId));
  useEffect(() => { setOpen(loadPlanOpen(rootId)); }, [rootId]);

  const rev = progress?.rev ?? null;
  useEffect(() => {
    if (rev === null) return;
    if (plan !== undefined && (plan?.rev ?? null) === rev) return;
    void getController().loadThreadPlan(rootId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rev 가 바뀔 때만 다시 받는다(D-b)
  }, [rootId, rev]);

  if (!progress || !plan) return null;
  const toggle = () => { const next = !open; setOpen(next); savePlanOpen(rootId, next); };
  const stale = isPlanStale(plan.updatedAt, Date.now());
  const { shown, more } = planPills(plan);

  return (
    <div data-testid="plan-band" className="border-b border-border bg-surface-raised">
      <button
        type="button"
        data-testid="plan-band-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-surface-sunken"
      >
        <span aria-hidden="true" className="text-fg-subtle">{open ? '▾' : '▸'}</span>
        <PlanChip progress={progress} />
        <span className="min-w-0 flex-1 truncate text-body">{plan.doc.goal}</span>
        {shown.map((p) => (
          <span key={p.id} data-testid="plan-pill" data-state={p.state}
            className={`hidden max-w-[10rem] truncate rounded-full px-2 text-meta md:inline ${PILL[p.state]}`}>
            {p.title}
          </span>
        ))}
        {more > 0 && <span className="text-meta text-fg-subtle">{t('plan.moreGroups', { n: more })}</span>}
        {stale && <span data-testid="plan-stale" className="text-meta text-fg-subtle">{t('plan.stale')}</span>}
      </button>
      {open && <PlanPanel plan={plan} />}
    </div>
  );
}

function PlanPanel({ plan }: { plan: ThreadPlanView }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const flow = planFlow(plan.doc);
  const loose = stepsOf(plan.doc, null);
  const jump = (id: string) => {
    const g = plan.doc.steps.find((s) => s.id === id)?.groupId;
    if (g) setCollapsed((c) => ({ ...c, [g]: false }));
    requestAnimationFrame(() => box.current?.querySelector(`[data-node="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div ref={box} data-testid="plan-panel" className="max-h-[45vh] overflow-y-auto px-4 pb-2 text-body">
      {flow && <div data-testid="plan-flow" className="truncate py-1 text-meta text-fg-muted">{flow}</div>}
      {plan.flagged && <div className="py-1 text-meta text-state-stuck">{t('plan.flagged')}</div>}
      {plan.doc.groups.map((g) => (
        <GroupRow key={g.id} plan={plan} group={g} collapsed={!!collapsed[g.id]}
          onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} onJump={jump} />
      ))}
      {loose.map((s) => <StepRow key={s.id} plan={plan} step={s} onJump={jump} />)}
      {plan.doc.next && <div className="pt-1 text-meta"><span className="text-fg-subtle">{t('plan.next')} </span>{plan.doc.next}</div>}
      {plan.doc.blocked && <div className="text-meta text-state-stuck">{t('plan.blocked')} {plan.doc.blocked}</div>}
    </div>
  );
}

function GroupRow({ plan, group, collapsed, onToggle, onJump }: {
  plan: ThreadPlanView; group: PlanGroup; collapsed: boolean; onToggle: () => void; onJump: (id: string) => void;
}) {
  const t = useT();
  const d = plan.derived[group.id];
  const state = d?.derived ?? 'waiting';
  const linked = plan.linked.find((l) => l.groupId === group.id);
  const steps = stepsOf(plan.doc, group);
  return (
    <div data-node={group.id} data-state={state} className="py-0.5">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex w-full items-center gap-1.5 text-left">
        <span aria-hidden="true" className="w-3 text-fg-subtle">{steps.length ? (collapsed ? '▸' : '▾') : ''}</span>
        <Dot state={state} />
        <span className="font-medium">{group.title}</span>
        {linked && (linked.hidden
          ? <span className="text-meta text-fg-subtle">{t('plan.linkedHidden')}</span>
          : <PlanChip progress={linked.progress} />)}
      </button>
      <Waiting plan={plan} ids={d?.waitingOn ?? []} onJump={onJump} indent />
      {!collapsed && steps.map((s) => <StepRow key={s.id} plan={plan} step={s} onJump={onJump} indent />)}
    </div>
  );
}

function StepRow({ plan, step, onJump, indent = false }: { plan: ThreadPlanView; step: PlanStep; onJump: (id: string) => void; indent?: boolean }) {
  const d = plan.derived[step.id];
  const state: PlanDerivedState = d?.derived ?? (step.state === 'pending' ? 'waiting' : step.state);
  return (
    <div data-node={step.id} data-state={state} className={`py-0.5 ${indent ? 'pl-5' : ''}`}>
      <div className="flex items-center gap-1.5">
        <Dot state={state} />
        <span className={state === 'done' ? 'text-fg-subtle line-through' : ''}>{step.title}</span>
      </div>
      {state === 'blocked' && step.blockedReason && <div className="pl-3 text-meta text-state-stuck">{step.blockedReason}</div>}
      <Waiting plan={plan} ids={d?.waitingOn ?? []} onJump={onJump} />
    </div>
  );
}

/** 「⏳ 앞: X」(D6) — 누르면 그 노드로 옮긴다. */
function Waiting({ plan, ids, onJump, indent = false }: { plan: ThreadPlanView; ids: string[]; onJump: (id: string) => void; indent?: boolean }) {
  const t = useT();
  if (!ids.length) return null;
  return (
    <div data-testid="plan-waiting" className={`text-meta text-fg-muted ${indent ? 'pl-5' : 'pl-3'}`}>
      ⏳ {t('plan.waitingOn')}{' '}
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <button type="button" className="underline decoration-dotted hover:text-fg" onClick={() => onJump(id)}>{planTitleOf(plan.doc, id)}</button>
        </span>
      ))}
    </div>
  );
}

function Dot({ state }: { state: PlanDerivedState }) {
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[state]}`} />;
}

/** 색은 스레드 상태 토큰을 빌린다 — 막힘=stuck(빨강), 진행=running, 끝=done, 대기·시작 가능=waiting. */
const DOT: Record<PlanDerivedState, string> = {
  blocked: 'bg-state-stuck',
  active: 'bg-state-running',
  done: 'bg-state-done',
  waiting: 'border border-state-waiting',
  ready: 'bg-state-waiting',
  hidden: 'border border-fg-subtle',
};
const PILL: Record<PlanDerivedState, string> = {
  blocked: 'bg-danger-surface text-state-stuck',
  active: 'bg-surface-sunken text-fg-agent',
  ready: 'bg-surface-sunken text-fg-muted',
  waiting: 'text-fg-muted',
  done: 'text-fg-subtle',
  hidden: 'text-fg-subtle',
};

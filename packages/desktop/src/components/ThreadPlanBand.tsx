import { useEffect, useRef, useState } from 'react';
import type { PlanDerivedState, PlanGroup, PlanStep, ThreadPlanProgress, ThreadPlanView } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import {
  crossGroupTitle, groupCount, isPlanStale, loadPlanOpen, planFlow, planPills, planTitleOf, savePlanOpen, stepsOf, type PlanPill,
} from '../lib/threadPlan';
import { agoLabel } from '../lib/time';
import { PlanChip } from './PlanChip';
import { useLocale, useT } from '../i18n/useT';

/**
 * 스레드 계획판 띠 + 펼친 패널(P4, 시안 v2 D1·D3~D7).
 *
 * - **부를 길은 루트 행의 `planProgress` 뿐이다**(serverSurfaceGated) — 옛 서버나 계획 없는 스레드에서는 띠가 없고 GET 도 없다.
 * - 판을 받는 곳은 이 띠 하나다(architect R1). 루트 행의 rev 가 들고 있는 판과 다르면 받는다(R3).
 * - 띠 칩은 판을 받은 뒤 **개인 진행률**(GET)을 쓴다(architect R2) — 펼친 패널과 같은 값이다. 채널 목록 칩은 청중 값 그대로다.
 * - 펼침은 띠 바로 아래로 내려오고 스레드 높이의 45% 까지, 넘치면 안에서 스크롤한다(D1). 스레드별로 기억하고 처음엔 접힘(D4).
 */
export function ThreadPlanBand({ rootId, progress }: { rootId: string; progress: ThreadPlanProgress | null | undefined }) {
  const t = useT();
  const locale = useLocale();
  const plan = useActiveStore((s) => s.threadPlans[rootId]);
  const [open, setOpen] = useState(() => loadPlanOpen(rootId));
  useEffect(() => { setOpen(loadPlanOpen(rootId)); }, [rootId]);

  const rev = progress?.rev ?? null;
  useEffect(() => {
    if (rev === null) return;
    // 다르면 받는다(architect R3) — rev 는 계획을 지웠다 다시 세우면 1로 돌아가므로 「크다」로 견주면 옛 판이 남는다.
    if (plan !== undefined && (plan?.rev ?? null) === rev) return;
    void getController().loadThreadPlan(rootId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rev 가 바뀔 때만 다시 받는다(D-b)
  }, [rootId, rev]);

  if (!progress || !plan) return null;
  const toggle = () => { const next = !open; setOpen(next); savePlanOpen(rootId, next); };
  const updated = Date.parse(plan.updatedAt);
  const stale = isPlanStale(plan.updatedAt, Date.now());
  const { pills, summary } = planPills(plan);
  const chip = { ...plan.progress, rev: plan.rev };

  return (
    <div data-testid="plan-band" className="border-b border-border bg-surface-raised">
      <button
        type="button"
        data-testid="plan-band-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full min-w-0 items-center gap-2 px-4 py-1.5 text-left hover:bg-surface-sunken"
      >
        <span aria-hidden="true" className="text-fg-subtle">{open ? '▾' : '▸'}</span>
        <PlanChip progress={chip} />
        {/* 좁을수록 목표 글자부터 줄이고 알약은 남긴다(designer 1). */}
        <span className="min-w-0 flex-1 truncate text-body">{plan.doc.goal}</span>
        {summary ? (
          <span data-testid="plan-summary" className="min-w-0 shrink truncate text-meta text-fg-muted">
            {summary.blocked > 0
              ? t('plan.summary', { groups: summary.groups, active: summary.active, blocked: summary.blocked })
              : t('plan.summaryNoBlocked', { groups: summary.groups, active: summary.active })}
            {summary.firstBlocked && <span className="text-state-stuck"> ({summary.firstBlocked})</span>}
          </span>
        ) : pills.map((p, i) => (
          <PillChip key={p.id} pill={p} className={i === 0 ? '' : 'hidden md:inline-flex'} />
        ))}
        {!summary && pills.length > 1 && (
          <span data-testid="plan-more-narrow" className="shrink-0 text-meta text-fg-muted md:hidden">
            {t('plan.moreGroups', { n: pills.length - 1 })}
          </span>
        )}
        {Number.isFinite(updated) && (
          <span className="hidden shrink-0 text-meta text-fg-subtle lg:inline">{agoLabel(updated, Date.now(), locale, t)}</span>
        )}
        {stale && <span data-testid="plan-stale" className="shrink-0 text-meta text-fg-subtle">{t('plan.stale')}</span>}
      </button>
      {open && <PlanPanel plan={plan} />}
    </div>
  );
}

/** 상태가 든 그룹 알약(D7) — 「도구 막힘 1/2」「서버 1/2」「서버✓」「화면 대기」. */
function PillChip({ pill, className = '' }: { pill: PlanPill; className?: string }) {
  const t = useT();
  const c = pill.count;
  const label = pill.state === 'done' ? t('plan.pill.done', { title: pill.title })
    : pill.state === 'blocked' && c ? t('plan.pill.blocked', { title: pill.title, done: c.done, total: c.total })
      : pill.state === 'waiting' ? t('plan.pill.waiting', { title: pill.title })
        : c && c.total > 0 && pill.state !== 'hidden' ? t('plan.pill.count', { title: pill.title, done: c.done, total: c.total })
          : pill.title;
  return (
    <span
      data-testid="plan-pill"
      data-state={pill.state}
      className={`max-w-[12rem] shrink-0 truncate rounded-full px-2 text-meta ${PILL[pill.state]} ${className}`}
    >
      {label}
    </span>
  );
}

function PlanPanel({ plan }: { plan: ThreadPlanView }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const flow = planFlow(plan.doc);
  const pillOf = new Map(planPills(plan).pills.map((p) => [p.id, p]));
  const loose = stepsOf(plan.doc, null);
  const jump = (id: string) => {
    const g = plan.doc.steps.find((s) => s.id === id)?.groupId;
    if (g) setCollapsed((c) => ({ ...c, [g]: false }));
    requestAnimationFrame(() => box.current?.querySelector(`[data-node="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div ref={box} data-testid="plan-panel" className="max-h-[45vh] overflow-y-auto px-4 pb-2 text-body">
      {flow && (
        <div data-testid="plan-flow" className="flex flex-wrap items-center gap-1 py-1 text-meta text-fg-muted">
          {flow.map((layer, li) => (
            <span key={li} data-testid="plan-flow-layer" className="inline-flex items-center gap-1">
              {li > 0 && <span aria-hidden="true" className="text-fg-subtle">⟶</span>}
              {layer.map((id, i) => {
                const p = pillOf.get(id);
                return (
                  <span key={id} className="inline-flex items-center gap-1">
                    {i > 0 && <span aria-hidden="true">·</span>}
                    {p && <PillChip pill={p} />}
                  </span>
                );
              })}
              {layer.length > 1 && <span>{t('plan.parallel')}</span>}
            </span>
          ))}
        </div>
      )}
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
  const count = groupCount(plan, group);
  return (
    <div data-node={group.id} data-state={state} className="py-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 items-center gap-1.5 text-left">
          <span aria-hidden="true" className="w-3 text-fg-subtle">{steps.length ? (collapsed ? '▸' : '▾') : ''}</span>
          <Dot state={state} />
          <span className="truncate font-medium">{group.title}</span>
          {!group.linkedRootId && count && count.total > 0 && (
            <span data-testid="plan-group-count" className="text-meta text-fg-muted">{count.done}/{count.total}</span>
          )}
          {linked && (linked.hidden
            ? <span className="text-meta text-fg-subtle">{t('plan.linkedHidden')}</span>
            : <PlanChip progress={linked.progress} />)}
        </button>
        {/* 연결 칩 오른쪽에 붙인다(designer nit) — 서버가 준 linked 로만, 볼 수 있을 때만 연다. */}
        {linked && !linked.hidden && linked.channelId && (
          <button type="button" data-testid="plan-open-linked" className="shrink-0 text-meta text-fg-muted underline decoration-dotted hover:text-fg"
            onClick={() => { void getController().openThread(linked.rootId, { channelId: linked.channelId! }).catch(() => {}); }}>
            {t('plan.openLinked')}
          </button>
        )}
      </div>
      <Waiting plan={plan} ids={d?.waitingOn ?? []} fromGroupId={group.id} onJump={onJump} indent />
      {!collapsed && steps.map((s) => <StepRow key={s.id} plan={plan} step={s} onJump={onJump} indent />)}
    </div>
  );
}

function StepRow({ plan, step, onJump, indent = false }: { plan: ThreadPlanView; step: PlanStep; onJump: (id: string) => void; indent?: boolean }) {
  const t = useT();
  const d = plan.derived[step.id];
  const state: PlanDerivedState = d?.derived ?? (step.state === 'pending' ? 'waiting' : step.state);
  const parent = step.groupId ? plan.doc.groups.find((g) => g.id === step.groupId) : undefined;
  const hasDeps = (step.dependsOn?.length ?? 0) > 0 || (parent?.dependsOn?.length ?? 0) > 0;
  return (
    <div data-node={step.id} data-state={state} className={`py-0.5 ${indent ? 'pl-5' : ''}`}>
      <div className="flex items-center gap-1.5">
        <Dot state={state} />
        {/* 끝난 단계는 취소선 대신 ✓ 와 흐린 색(designer nit). */}
        <span className={state === 'done' ? 'text-fg-subtle' : ''}>{state === 'done' && <span aria-hidden="true">✓ </span>}{step.title}</span>
      </div>
      {state === 'blocked' && step.blockedReason && <div className="pl-3 text-meta text-state-stuck">{step.blockedReason}</div>}
      {state === 'ready' && (
        <div data-testid="plan-ready" className="pl-3 text-meta text-fg-subtle">{hasDeps ? t('plan.readyAfter') : t('plan.ready')}</div>
      )}
      <Waiting plan={plan} ids={d?.waitingOn ?? []} fromGroupId={step.groupId ?? null} onJump={onJump} />
    </div>
  );
}

/** 「⏳ 앞: X」(D6) — 누르면 그 노드로 옮긴다. 그룹을 넘으면 「그룹 · 단계」로 쓴다. */
function Waiting({ plan, ids, fromGroupId, onJump, indent = false }: {
  plan: ThreadPlanView; ids: string[]; fromGroupId: string | null; onJump: (id: string) => void; indent?: boolean;
}) {
  const t = useT();
  if (!ids.length) return null;
  return (
    <div data-testid="plan-waiting" className={`text-meta text-fg-muted ${indent ? 'pl-5' : 'pl-3'}`}>
      ⏳ {t('plan.waitingOn')}{' '}
      {ids.map((id, i) => {
        const g = crossGroupTitle(plan.doc, id, fromGroupId);
        return (
          <span key={id}>
            {i > 0 && ', '}
            <button type="button" className="underline decoration-dotted hover:text-fg" onClick={() => onJump(id)}>
              {g ? `${g} · ` : ''}{planTitleOf(plan.doc, id)}
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** 상태 점 — 색만으로 가르지 않게 글자(title·sr-only)를 함께 단다(designer 5). */
function Dot({ state }: { state: PlanDerivedState }) {
  const t = useT();
  const label = t(STATE_LABEL[state]);
  return (
    <>
      <span aria-hidden="true" title={label} className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[state]}`} />
      <span className="sr-only">{label}</span>
    </>
  );
}

/** 키는 글자 그대로 적는다 — 「사전에 안 쓰는 키」 시험이 글자로 찾는다. */
const STATE_LABEL = {
  blocked: 'plan.state.blocked',
  active: 'plan.state.active',
  done: 'plan.state.done',
  waiting: 'plan.state.waiting',
  ready: 'plan.state.ready',
  hidden: 'plan.state.hidden',
} as const satisfies Record<PlanDerivedState, string>;

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
  done: 'text-fg-muted',
  hidden: 'text-fg-muted',
};

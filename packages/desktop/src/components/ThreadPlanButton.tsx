import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { PlanGroup, PlanStep, ThreadPlanProgress, ThreadPlanView } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { getExternalOpener } from '../lib/openExternal';
import type { PlanStartDone } from '../lib/api';
import {
  crossGroupTitle, groupFacts, isPlanStale, loadPlanOpen, nextCycleIndex, PLAN_CHIP_KINDS, planButtonKind, planFlow, planFlowVisible, planLists,
  clampPlanSize, loadPlanSize, PLAN_PANEL_DEFAULT, planReadyStepIds, planPills, planTitleOf, planTone, prUrl, savePlanOpen, savePlanSize, stepAssignee,
  stepGoTargets, stepKind, stepStartState, stepWaiters, stepWhy, stepsOf, widePlanSize,
  type PlanChipKind, type PlanPill, type PlanRowKind,
} from '../lib/threadPlan';
import { agoLabel } from '../lib/time';
import { PlanStartBox } from './PlanStartBox';
import { useLocale, useT } from '../i18n/useT';

/**
 * 스레드 계획판 — 오른쪽 아래 떠 있는 버튼과 그 자리에서 펼치는 패널(개선 시안 v3 W4~W8, V1~V4).
 *
 * - **부를 길은 루트 행의 `planProgress` 뿐이다**(serverSurfaceGated) — 옛 서버나 계획 없는 스레드에서는 버튼이 없고 GET 도 없다.
 * - 판을 받는 곳은 이 버튼 하나다(architect R1). 루트 행의 rev 가 들고 있는 판과 다르면 받는다(R3).
 * - 칩은 판을 받은 뒤 **개인 진행률**(GET)을 쓴다(R2). 채널 목록 칩은 청중 값 그대로다.
 * - 펼침은 모달이 아니다: 피드를 읽고 답을 쓸 수 있다. ✕·버튼·Esc 로 닫고 피드를 눌러도 닫히지 않는다. 스레드별로 기억한다(D4).
 * - 목표·제목·사유는 남이 쓴 글이라 **글자로만** 그린다. 앱 밖으로 나가는 주소는 꼴을 지난 PR 번호로만 짓는다(`stepFirstLinks`).
 */
export function ThreadPlanButton({ rootId, progress, onOpenChange }: {
  rootId: string;
  progress: ThreadPlanProgress | null | undefined;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT();
  const plan = useActiveStore((s) => s.threadPlans[rootId]);
  const [open, setOpenState] = useState(() => loadPlanOpen(rootId));
  useEffect(() => { setOpenState(loadPlanOpen(rootId)); }, [rootId]);

  const shown = planTone(progress) !== 'empty';
  const rev = shown ? progress?.rev ?? null : null;
  // 목록 행의 updatedAt(P6) — 앱이 꺼진 사이 지웠다 다시 세워 rev 가 우연히 같아도 시각은 다르다(#1739 낮음).
  // 실시간 이벤트에는 없으므로(목록 행에만) 없을 때는 rev 만 견준다.
  const rowUpdatedAt = progress?.updatedAt ?? null;
  useEffect(() => {
    if (rev === null) return;
    // 다르면 받는다(architect R3) — rev 는 계획을 지웠다 다시 세우면 1로 돌아가므로 「크다」로 견주면 옛 판이 남는다.
    const same = plan !== undefined && (plan?.rev ?? null) === rev
      && (rowUpdatedAt === null || !plan || Date.parse(plan.updatedAt) >= Date.parse(rowUpdatedAt));
    if (same) return;
    void getController().loadThreadPlan(rootId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rev·시각이 바뀔 때만 다시 받는다(D-b)
  }, [rootId, rev, rowUpdatedAt]);

  const setOpen = (next: boolean) => { setOpenState(next); savePlanOpen(rootId, next); };
  useEffect(() => { onOpenChange?.(shown && open && !!plan); }, [shown, open, plan, onOpenChange]);

  if (!shown || !progress) return null;
  const counts = plan && plan.progress.total > 0 ? plan.progress : progress;
  const isOpen = open && !!plan;

  return (
    <>
      {isOpen && plan && <PlanPanel plan={plan} onClose={() => setOpen(false)} />}
      <button
        type="button"
        data-testid="plan-button"
        aria-expanded={isOpen}
        aria-label={[t('plan.button.aria', { done: counts.done, total: counts.total }),
          ...(counts.blocked > 0 ? [t('plan.button.ariaBlocked', { n: counts.blocked })] : []),
          isOpen ? t('plan.button.close') : t('plan.button.open')].join(', ')}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'Escape' && isOpen) { e.stopPropagation(); setOpen(false); } }}
        className={`absolute bottom-3 right-4 inline-flex h-9 max-w-[calc(100%-32px)] items-center gap-2 whitespace-nowrap rounded-full border border-border pl-2 pr-3 text-meta font-semibold text-fg shadow-float ${isOpen ? 'bg-surface-sunken' : 'bg-surface-raised hover:bg-surface-sunken'}`}
      >
        <PlanMark kind={planButtonKind(counts)} />
        <span className="truncate">{t('plan.chip', { done: counts.done, total: counts.total })}</span>
        <ProgressBar done={counts.done} total={counts.total} />
        {counts.blocked > 0 && <span data-testid="plan-button-blocked" className="text-state-stuck">{t('plan.chip.blocked', { n: counts.blocked })}</span>}
        <span aria-hidden="true" className="text-fg-subtle">{isOpen ? '⌄' : '⌃'}</span>
      </button>
    </>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <span aria-hidden="true" className="relative h-1 w-9 shrink-0 overflow-hidden rounded-full bg-surface-sunken outline outline-1 outline-border">
      <span className="absolute inset-y-0 left-0 bg-success" style={{ width: `${pct}%` }} />
    </span>
  );
}

function PlanPanel({ plan, onClose }: { plan: ThreadPlanView; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const me = useActiveStore((s) => s.me?.id ?? null);
  const editor = useActiveStore((s) => (plan.updatedBy ? s.accounts[plan.updatedBy] : undefined));
  const list = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [whyOpen, setWhyOpen] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [cycle, setCycle] = useState<{ kind: PlanChipKind; index: number } | null>(null);
  const [flowAll, setFlowAll] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const human = useActiveStore((s) => s.me?.kind === 'human');
  const accounts = useActiveStore((s) => s.accounts);
  const myHandle = useActiveStore((s) => s.me?.handle ?? '');
  const [startFor, setStartFor] = useState<string | 'all' | null>(null);
  const [started, setStarted] = useState<Record<string, { who: string; messageId: string | null }>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => loadPlanSize() ?? PLAN_PANEL_DEFAULT);
  const [editingManager, setEditingManager] = useState(false);
  const [managerError, setManagerError] = useState(false);
  const readyIds = planReadyStepIds(plan);
  const manager = plan.doc.managerId ? accounts[plan.doc.managerId] : undefined;
  const agents = Object.values(accounts).filter((a) => a.kind === 'agent');
  /** 스레드 칸의 크기 — 최대 크기를 정한다. 저장값은 건드리지 않고 그릴 때만 줄인다(CSS max-w·max-h, X2). */
  const boxOf = () => {
    const el = panelRef.current?.parentElement;
    return { w: el?.clientWidth || window.innerWidth, h: el?.clientHeight || window.innerHeight };
  };
  /** 왼쪽·위로 끌수록 커진다 — 패널이 오른쪽 아래에 붙어 있다. */
  const beginResize = (e: ReactPointerEvent, axis: { w: boolean; h: boolean }) => {
    e.preventDefault();
    const from = { x: e.clientX, y: e.clientY, ...size };
    let last = size;
    const move = (ev: PointerEvent) => {
      last = clampPlanSize({ w: axis.w ? from.w + from.x - ev.clientX : from.w, h: axis.h ? from.h + from.y - ev.clientY : from.h }, boxOf());
      setSize(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      savePlanSize(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resetSize = () => { setSize(PLAN_PANEL_DEFAULT); savePlanSize(null); };
  const isWide = size.w !== PLAN_PANEL_DEFAULT.w || size.h !== PLAN_PANEL_DEFAULT.h;
  const toggleWide = () => {
    if (isWide) { resetSize(); return; }
    const next = widePlanSize(boxOf());
    setSize(next);
    savePlanSize(next);
  };
  const changeManager = (id: string) => {
    setEditingManager(false);
    setManagerError(false);
    void getController().setPlanManager(plan.rootId, id || null).catch(() => setManagerError(true));
  };
  const onStarted = (res: PlanStartDone) => {
    setStartFor(null);
    setStarted((m) => ({ ...m, ...Object.fromEntries(res.started.map((x) => [x.id, { who: myHandle, messageId: x.messageId }])) }));
    if (res.started[0]) goTo(res.started[0].id);
  };

  const lists = planLists(plan, me);
  const pills = planPills(plan, me);
  const pillOf = new Map(pills.map((p) => [p.id, p]));
  const layers = planFlow(plan.doc) ?? [];
  const flow = planFlowVisible(layers, flowAll ? Number.MAX_SAFE_INTEGER : 5);
  const updated = Date.parse(plan.updatedAt);

  /** 그 노드로 스크롤하고 깜빡인다(접힌 그룹이면 편다). [why] 면 「막힌 까닭」까지 편다. */
  const goTo = (id: string, why = false) => {
    const g = plan.doc.steps.find((s) => s.id === id)?.groupId;
    if (g) setCollapsed((c) => ({ ...c, [g]: false }));
    if (why) setWhyOpen((w) => ({ ...w, [id]: true }));
    setFlash(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2000);
    requestAnimationFrame(() => list.current?.querySelector(`[data-node="${id}"]`)?.scrollIntoView?.({ block: 'center' }));
  };
  const pressChip = (kind: PlanChipKind) => {
    const ids = lists[kind];
    const index = nextCycleIndex(ids.length, cycle?.kind === kind ? cycle.index : null);
    if (index < 0) return;
    setCycle({ kind, index });
    goTo(ids[index]!, kind === 'blocked');
  };
  const pressPill = (p: PlanPill) => {
    if (p.state === 'blocked') {
      const first = stepsOf(plan.doc, plan.doc.groups.find((g) => g.id === p.id) ?? null).find((s) => stepKind(plan, s, me) === 'blocked');
      if (first) { goTo(first.id, true); return; }
    }
    goTo(p.id);
  };
  /** 글로 간다 — 패널을 접어 그 글을 가리지 않게 한다(W7). */
  const goToMessage = (id: string) => { onClose(); void getController().openMessage(id).catch(() => {}); };
  const shared: RowActions = { plan, me, flash, whyOpen, goTo, goToMessage, human, started, startFor, setStartFor, onStarted,
    toggleWhy: (id) => setWhyOpen((w) => ({ ...w, [id]: !w[id] })) };
  const loose = stepsOf(plan.doc, null);

  return (
    <div
      ref={panelRef}
      data-testid="plan-panel"
      tabIndex={-1}
      style={{ width: size.w, height: size.h }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      className="absolute bottom-14 right-4 z-10 flex max-h-[calc(100%-72px)] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-card border border-border bg-surface-raised text-body shadow-float"
    >
      {/* 크기 조절(X1) — 패널이 오른쪽 아래에 붙어 있으니 왼쪽 위에서 끈다. 두 번 누르면 기본 크기. */}
      <div data-testid="plan-resize-corner" aria-hidden="true" title={t('plan.resize.hint')} onPointerDown={(e) => beginResize(e, { w: true, h: true })} onDoubleClick={resetSize}
        className="absolute left-0 top-0 z-10 flex h-[18px] w-[18px] cursor-nwse-resize items-center justify-center text-meta text-fg-subtle">↖</div>
      <div data-testid="plan-resize-left" aria-hidden="true" onPointerDown={(e) => beginResize(e, { w: true, h: false })} className="absolute bottom-[18px] left-0 top-[18px] z-10 w-[5px] cursor-ew-resize" />
      <div data-testid="plan-resize-top" aria-hidden="true" onPointerDown={(e) => beginResize(e, { w: false, h: true })} className="absolute left-[18px] right-[18px] top-0 z-10 h-[5px] cursor-ns-resize" />
      {/* 머리는 고정이다(W4) — 칩이 스크롤에 밀려 사라지면 차례로 가는 길도 사라진다. */}
      <div data-testid="plan-head" className="shrink-0 border-b border-border px-3.5 pb-1.5 pt-2.5">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{t('plan.panel.title')}</span>
          <span className="truncate text-meta text-fg-muted">
            {plan.progress.done}/{plan.progress.total}
            {plan.progress.blocked > 0 && <span className="text-state-stuck"> {t('plan.chip.blocked', { n: plan.progress.blocked })}</span>}
          </span>
          <button type="button" data-testid="plan-size-toggle" onClick={toggleWide} className="ml-auto shrink-0 rounded-row px-1 text-meta text-fg-muted hover:bg-surface-sunken">
            {isWide ? t('plan.size.default') : t('plan.size.wide')}
          </button>
          <button type="button" data-testid="plan-panel-close" aria-label={t('plan.panel.close')} onClick={onClose}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-fg-muted hover:text-fg">✕</button>
        </div>
        <div data-testid="plan-goal" className="mt-0.5">{plan.doc.goal}</div>
        <div className="text-meta text-fg-subtle">
          {[editor?.handle,
            ...(Number.isFinite(updated) ? [t('plan.meta.edited', { ago: agoLabel(updated, Date.now(), locale, t) })] : []),
            t('plan.meta.counts', { groups: plan.doc.groups.length, steps: plan.doc.steps.length })].filter(Boolean).join(' · ')}
          {isPlanStale(plan.updatedAt, Date.now()) && <span data-testid="plan-stale" className="text-warning"> · {t('plan.stale')}</span>}
        </div>
        {(manager || human) && (
          <div data-testid="plan-manager" className="flex items-center gap-1 text-meta text-fg-muted">
            <span>{t('plan.manager.label')}</span>
            {editingManager ? (
              <select data-testid="plan-manager-select" autoFocus value={plan.doc.managerId ?? ''} onChange={(e) => changeManager(e.target.value)} onBlur={() => setEditingManager(false)}
                className="min-w-0 rounded-row border border-border bg-surface-raised px-1">
                <option value="">{t('plan.manager.none')}</option>
                {agents.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
              </select>
            ) : <span className="truncate text-fg-agent">{manager ? `@${manager.handle}` : t('plan.manager.none')}</span>}
            {human && !editingManager && (
              <button type="button" data-testid="plan-manager-edit" aria-label={t('plan.manager.edit')} onClick={() => setEditingManager(true)} className="rounded-row px-1 hover:bg-surface-sunken">✎</button>
            )}
            {managerError && <span className="text-state-stuck">{t('plan.manager.failed')}</span>}
          </div>
        )}
        <div data-testid="plan-chips" className="flex flex-wrap gap-1.5 py-1.5">
          {PLAN_CHIP_KINDS.map((kind) => (
            <SummaryChip key={kind} kind={kind} n={lists[kind].length} visiting={cycle?.kind === kind ? cycle.index + 1 : null}
              onPress={() => pressChip(kind)} />
          ))}
          {human && readyIds.length >= 2 && (
            <button type="button" data-testid="plan-start-all" aria-expanded={startFor === 'all'} onClick={() => setStartFor(startFor === 'all' ? null : 'all')}
              className="inline-flex h-6 items-center rounded-full border border-state-active px-2.5 text-meta font-semibold text-state-active hover:bg-state-active-surface">
              {t('plan.start.all')}
            </button>
          )}
        </div>
        {layers.length > 0 && (
          <div data-testid="plan-flow" className="flex flex-wrap items-center gap-1 text-meta text-fg-muted">
            {flow.ids.map((id, i) => {
              const p = pillOf.get(id);
              const newLayer = i > 0 && !layers.some((l) => l.includes(id) && l.includes(flow.ids[i - 1]!));
              return (
                <span key={id} className="inline-flex items-center gap-1">
                  {i > 0 && <span aria-hidden="true" className="text-fg-subtle">{newLayer ? '⟶' : '·'}</span>}
                  {p && <PillChip pill={p} onPress={() => pressPill(p)} />}
                </span>
              );
            })}
            {flow.more > 0 && (
              <button type="button" data-testid="plan-flow-more" className="underline decoration-dotted hover:text-fg" onClick={() => setFlowAll(true)}>
                {t('plan.moreFlow', { n: flow.more })}
              </button>
            )}
          </div>
        )}
      </div>
      {/* 목록만 스크롤한다. 끝난 일도 접지 않고 문서 순서대로 쭉 둔다(W1·W2). */}
      <div ref={list} data-testid="plan-list" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 pt-1">
        {startFor === 'all' && <PlanStartBox plan={plan} stepIds={readyIds} bulk onClose={() => setStartFor(null)} onStarted={onStarted} />}
        {plan.flagged && <div className="py-1 text-meta text-state-stuck">{t('plan.flagged')}</div>}
        {plan.doc.groups.map((g) => (
          <GroupRow key={g.id} group={g} collapsed={!!collapsed[g.id]} actions={shared}
            onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} />
        ))}
        {loose.map((s) => <StepRow key={s.id} step={s} actions={shared} />)}
        {plan.doc.next && <div className="pt-1 text-meta"><span className="text-fg-subtle">{t('plan.next')} </span>{plan.doc.next}</div>}
        {plan.doc.blocked && (
          <button type="button" data-testid="plan-foot-blocked" disabled={lists.blocked.length === 0} onClick={() => pressChip('blocked')}
            className="block text-left text-meta text-state-stuck enabled:underline enabled:decoration-dotted">
            {t('plan.blocked')} {plan.doc.blocked}
          </button>
        )}
      </div>
    </div>
  );
}

interface RowActions {
  plan: ThreadPlanView;
  me: string | null;
  flash: string | null;
  whyOpen: Record<string, boolean>;
  goTo: (id: string, why?: boolean) => void;
  goToMessage: (id: string) => void;
  toggleWhy: (id: string) => void;
  human: boolean;
  started: Record<string, { who: string; messageId: string | null }>;
  startFor: string | 'all' | null;
  setStartFor: (id: string | 'all' | null) => void;
  onStarted: (res: PlanStartDone) => void;
}

function GroupRow({ group, collapsed, onToggle, actions }: { group: PlanGroup; collapsed: boolean; onToggle: () => void; actions: RowActions }) {
  const t = useT();
  const { plan, me, flash, goTo } = actions;
  const d = plan.derived[group.id];
  const linked = plan.linked.find((l) => l.groupId === group.id);
  const steps = stepsOf(plan.doc, group);
  const f = groupFacts(plan, group, me);
  return (
    <div data-node={group.id} data-kind={f.kind} className={`rounded-row py-0.5 ${flash === group.id ? 'bg-accent-surface' : ''}`}>
      <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-2 text-left font-semibold">
          <PlanMark kind={f.kind} />
          <span className="truncate">{group.title}</span>
          {!group.linkedRootId && f.total > 0 && (
            <span data-testid="plan-group-count" className="shrink-0 text-meta font-normal text-fg-muted">
              {f.done}/{f.total}{f.active > 0 && ` ${t('plan.group.active', { n: f.active })}`}
            </span>
          )}
          {f.kind === 'blocked' && <BlockedTag />}
          {linked && !linked.hidden && linked.progress && (
            <span data-testid="plan-linked-count" className="shrink-0 text-meta font-normal text-fg-muted">
              {t('plan.chip', { done: linked.progress.done, total: linked.progress.total })}
            </span>
          )}
          {steps.length > 0 && <span aria-hidden="true" className="ml-auto shrink-0 font-normal text-fg-subtle">{collapsed ? '⌃' : '⌄'}</span>}
        </button>
      </div>
      {linked && (linked.hidden || !linked.channelId
        ? <div data-testid="plan-linked-hidden" className="ml-8 mr-1 rounded-row border border-dashed border-border px-2.5 py-1.5 text-meta text-fg-subtle">{t('plan.linkedHidden')}</div>
        : (
          <button type="button" data-testid="plan-open-linked" className="ml-8 mr-1 block rounded-row border border-border px-2.5 py-1.5 text-meta font-semibold text-link hover:bg-surface-sunken"
            onClick={() => { void getController().openThread(linked.rootId, { channelId: linked.channelId! }).catch(() => {}); }}>
            {t('plan.openLinked')}
          </button>
        ))}
      <Waiting ids={d?.waitingOn ?? []} fromGroupId={group.id} actions={actions} goTo={goTo} indent />
      {!collapsed && steps.map((s) => <StepRow key={s.id} step={s} actions={actions} indent />)}
    </div>
  );
}

function StepRow({ step, actions, indent = false }: { step: PlanStep; actions: RowActions; indent?: boolean }) {
  const t = useT();
  const { plan, me, flash, whyOpen, goTo, goToMessage, toggleWhy, human, started, startFor, setStartFor, onStarted } = actions;
  const d = plan.derived[step.id];
  const kind = stepKind(plan, step, me);
  const parent = step.groupId ? plan.doc.groups.find((g) => g.id === step.groupId) : undefined;
  const hasDeps = (step.dependsOn?.length ?? 0) > 0 || (parent?.dependsOn?.length ?? 0) > 0;
  const waiters = kind === 'mine' ? stepWaiters(plan, step.id) : [];
  const assignee = stepAssignee(plan.doc, step);
  const accounts = useActiveStore((st) => st.accounts);
  const account = assignee ? accounts[assignee] : undefined;
  const open = !!whyOpen[step.id];
  const targets = stepGoTargets(step);
  const startState = human ? stepStartState(plan, step, me, (id) => accounts[id]?.kind === 'human') : 'none';
  const note = started[step.id];

  const go = (target: (typeof targets)[number]) => {
    if (target.kind === 'pr') void getExternalOpener().open(prUrl(target));
    else goToMessage(target.id);
  };
  // 막힌 줄은 까닭을 펴고, 연결이 있는 줄은 그리로 간다(R14). 연결이 없으면 누르는 모양을 주지 않는다(X10).
  const press = kind === 'blocked' ? () => toggleWhy(step.id) : targets[0] ? () => go(targets[0]!) : null;
  const onRowClick = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest('button,select,input,label,a')) return;
    press?.();
  };
  const label = (x: (typeof targets)[number]) => (x.kind === 'pr' ? t('plan.row.pr', { number: x.number }) : x.kind === 'card' ? t('plan.why.card') : t('plan.why.messageLink'));

  return (
    <div data-node={step.id} data-kind={kind}
      className={`rounded-row ${indent ? 'ml-5' : ''} ${flash === step.id ? 'ring-2 ring-accent' : ''} ${kind === 'blocked' ? 'bg-danger-surface' : ''}`}>
      <div data-testid="plan-row" role={press ? 'button' : undefined} tabIndex={press ? 0 : undefined} onClick={onRowClick}
        onKeyDown={(e) => { if (press && e.key === 'Enter' && e.target === e.currentTarget) press(); }}
        className={`group flex items-start gap-2 rounded-row px-1.5 py-1 ${press ? 'cursor-pointer hover:bg-surface-sunken' : ''}`}>
        <PlanMark kind={kind} />
        <div className="min-w-0 flex-1">
          <div>{step.title}</div>
          {kind === 'blocked' && (
            <div data-testid="plan-row-reason" className="flex min-w-0 gap-x-1 text-meta text-state-stuck">
              <span className="shrink-0 font-semibold">{t('plan.row.blocked')}</span>
              {step.blockedReason && <span aria-hidden="true">·</span>}
              {/* 한 줄로 줄인다 — 전문은 「막힌 까닭」 상자에 있다. */}
              {step.blockedReason && <span className="min-w-0 flex-1 truncate">{step.blockedReason}</span>}
            </div>
          )}
          <RowParts parts={[
            kind === 'done' && <span className="font-semibold text-success">{t('plan.row.done')}</span>,
            kind === 'active' && <span className="font-semibold text-state-active">{t('plan.state.active')}</span>,
            kind === 'mine' && <span className="font-semibold text-accent-text">{t('plan.row.mine')}</span>,
            kind === 'ready' && <span data-testid="plan-ready">{hasDeps ? t('plan.readyAfter') : t('plan.ready')}</span>,
            kind !== 'mine' && account && <Assignee account={account} me={me} />,
            waiters.length > 0 && (
              <button type="button" data-testid="plan-waiters" className="text-state-stuck underline decoration-dotted" onClick={() => goTo(waiters[0]!, true)}>
                {t('plan.row.waiters', { n: waiters.length })}
              </button>
            ),
            note && (
              <span data-testid="plan-started-note" className="inline-flex gap-x-1">
                {t('plan.start.justStarted', { who: note.who })}
                {note.messageId && (
                  <button type="button" data-testid="plan-started-link" className="text-link underline decoration-dotted" onClick={() => goToMessage(note.messageId!)}>
                    {t('plan.start.postLink')}
                  </button>
                )}
              </span>
            ),
            kind !== 'blocked' && targets.map((x, i) => (i < 2 && (
              <button key={i} type="button" data-testid={`plan-row-go-${x.kind}`} className="text-link underline decoration-dotted" onClick={() => go(x)}>
                {label(x)}{i === 1 && targets.length > 2 ? ` ${t('plan.row.more', { n: targets.length - 2 })}` : ''}
              </button>
            ))),
            kind === 'mine' && !targets.length && <span data-testid="plan-row-nolink" className="text-fg-subtle">{t('plan.row.noLink')}</span>,
            kind === 'blocked' && (
              <button type="button" data-testid="plan-why-toggle" aria-expanded={open} className="text-state-stuck underline decoration-dotted" onClick={() => toggleWhy(step.id)}>
                {open ? t('plan.why.collapse') : t('plan.why.toggle')}
              </button>
            ),
          ].flat()} />
          <Waiting ids={d?.waitingOn ?? []} fromGroupId={step.groupId ?? null} actions={actions} goTo={goTo} />
        </div>
        {startState !== 'none' && (
          <button type="button" data-testid="plan-start" disabled={startState === 'other_human'} title={startState === 'other_human' ? t('plan.start.otherHuman') : undefined}
            aria-expanded={startFor === step.id} onClick={() => setStartFor(startFor === step.id ? null : step.id)}
            className="shrink-0 self-center rounded-full border border-state-active px-2 text-meta font-semibold text-state-active enabled:hover:bg-state-active-surface disabled:border-border disabled:text-fg-subtle">
            {t('plan.start.button')}
          </button>
        )}
        {press && kind !== 'blocked' && <span aria-hidden="true" className="invisible shrink-0 self-center text-fg-subtle group-hover:visible">›</span>}
      </div>
      {startFor === step.id && <PlanStartBox plan={plan} stepIds={[step.id]} onClose={() => setStartFor(null)} onStarted={onStarted} />}
      {kind === 'blocked' && open && <WhyBox step={step} actions={actions} />}
    </div>
  );
}

/** 「막힌 까닭」 상자(V3) — 사유 전문, 앞 단계, 연결. 하나도 없으면 「연결된 것 없음」. */
function WhyBox({ step, actions }: { step: PlanStep; actions: RowActions }) {
  const t = useT();
  const { plan, me, goTo, goToMessage } = actions;
  const why = stepWhy(plan, step, me);
  const row = (key: string, label: string, body: ReactNode) => (
    <div key={key} className="flex min-h-7 items-center gap-1.5 py-0.5">
      <span className="w-14 shrink-0 text-fg-muted">{label}</span>
      {body}
    </div>
  );
  return (
    <div data-testid="plan-why" className="mb-1 ml-8 mr-1.5 rounded-r-row border-l-2 border-state-stuck bg-surface-raised px-2.5 py-1.5 text-meta">
      <div className="font-semibold text-state-stuck">{t('plan.why.title')}</div>
      {why.reason && <div data-testid="plan-why-reason" className="whitespace-pre-wrap break-words">{why.reason}</div>}
      {why.deps.map((dep) => row(dep.id, t('plan.why.dep'), (
        <button type="button" data-testid="plan-why-dep" className="min-w-0 truncate text-left underline decoration-dotted" onClick={() => goTo(dep.id)}>
          {dep.group ? `${dep.group} · ` : ''}{dep.title} ›
        </button>
      )))}
      {why.links.map((l) => {
        if (l.kind === 'pr') {
          return row(`pr:${l.repo}#${l.number}`, t('plan.why.pr'), (
            <button type="button" data-testid="plan-why-pr" className="text-link underline decoration-dotted"
              onClick={() => { void getExternalOpener().open(prUrl(l)); }}>{t('plan.row.pr', { number: l.number })}</button>
          ));
        }
        if (l.kind === 'workitem') return row(`w:${l.id}`, t('plan.why.workitem'), <span className="text-fg-subtle">{l.id}</span>);
        return row(`${l.kind}:${l.id}`, l.kind === 'card' ? t('plan.why.card') : t('plan.why.messageLink'), (
          <button type="button" data-testid="plan-why-goto" className="text-link underline decoration-dotted" onClick={() => goToMessage(l.id)}>{t('plan.why.goto')}</button>
        ));
      })}
      {why.deps.length === 0 && why.links.length === 0 && <div data-testid="plan-why-none" className="text-fg-subtle">{t('plan.why.none')}</div>}
    </div>
  );
}

/** 「⏳ 앞: X ›」(D6) — 누르면 그 노드로 옮긴다. 그룹을 넘으면 「그룹 · 단계」로 쓴다. 앞이 다른 스레드에 이어진 그룹이면 그 스레드를 연다. */
function Waiting({ ids, fromGroupId, actions, goTo, indent = false }: {
  ids: string[]; fromGroupId: string | null; actions: RowActions; goTo: (id: string) => void; indent?: boolean;
}) {
  const t = useT();
  const { plan } = actions;
  if (!ids.length) return null;
  const press = (id: string) => {
    const linked = plan.linked.find((l) => l.groupId === id);
    if (linked && linked.channelId && !linked.hidden) {
      void getController().openThread(linked.rootId, { channelId: linked.channelId }).catch(() => {});
      return;
    }
    goTo(id);
  };
  return (
    <div data-testid="plan-waiting" className={`text-meta text-fg-muted ${indent ? 'pl-8 pb-0.5' : ''}`}>
      ⏳ {t('plan.waitingOn')}{' '}
      {ids.map((id, i) => {
        const g = crossGroupTitle(plan.doc, id, fromGroupId);
        const hidden = plan.linked.some((l) => l.groupId === id && l.hidden);
        return (
          <span key={id}>
            {i > 0 && ', '}
            <button type="button" disabled={hidden} className="enabled:underline enabled:decoration-dotted enabled:hover:text-fg" onClick={() => press(id)}>
              {g ? `${g} · ` : ''}{planTitleOf(plan.doc, id)}{hidden ? '' : ' ›'}
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** 둘째 줄의 조각들. 구분점은 **조각 사이에만** 둔다 — 줄이 구분점으로 시작하거나 링크 밑줄에 섞이지 않게. */
function RowParts({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div data-testid="plan-row-sub" className="flex flex-wrap items-center gap-x-1 text-meta text-fg-muted">
      {shown.map((part, i) => (
        <span key={i} className="inline-flex min-w-0 items-center gap-x-1">
          {i > 0 && <span aria-hidden="true">·</span>}
          {part}
        </span>
      ))}
    </div>
  );
}

/**
 * 담당(P6, security 낮음) — 계정 id 로만 오므로 화면이 이름을 푼다. **이 커뮤니티에 있는 계정일 때만** 그린다:
 * 없는 계정·지워진 계정이면 부르는 쪽이 조각을 만들지 않는다(지어낸 이름을 보이지 않는다). 사람이고 내가 아니면 「사람」 꼬리표를 단다.
 */
function Assignee({ account, me }: { account: { id: string; handle: string; kind: string }; me: string | null }) {
  const t = useT();
  return (
    <span data-testid="plan-assignee" className="truncate text-fg-agent">
      {account.kind === 'human' && account.id !== me && <span data-testid="plan-person" className="mr-1 rounded-row border border-border px-1 text-fg-muted">{t('plan.row.person')}</span>}
      @{account.handle}
    </span>
  );
}

/** 빨강만으로 말하지 않는다 — 표지가 이미 읽히므로 화면 낭독기에는 겹쳐 읽히지 않게 한다. */
function BlockedTag() {
  const t = useT();
  return <span aria-hidden="true" className="shrink-0 rounded-row border border-state-stuck px-1 text-meta font-normal text-state-stuck">{t('plan.row.blocked')}</span>;
}

const CHIP_KEY = {
  done: 'plan.sum.done', active: 'plan.sum.active', blocked: 'plan.sum.blocked', mine: 'plan.sum.mine', ready: 'plan.sum.ready', waiting: 'plan.sum.waiting',
} as const satisfies Record<PlanChipKind, string>;
const CHIP_TONE: Record<PlanChipKind, string> = {
  done: 'bg-success-surface text-success',
  active: 'bg-state-active-surface text-state-active',
  blocked: 'bg-danger-surface text-state-stuck',
  mine: 'bg-accent-surface text-accent-text',
  ready: 'border border-border text-fg-muted font-medium',
  waiting: 'border border-dashed border-border text-fg-subtle font-medium',
};

/** 맨 위 상태 칩(V1·V3) — 누르면 그 상태 단계들을 문서 순서로 돌아가며 간다. 0 이면 흐리고 누를 수 없다. */
function SummaryChip({ kind, n, visiting, onPress }: { kind: PlanChipKind; n: number; visiting: number | null; onPress: () => void }) {
  const t = useT();
  return (
    <button type="button" data-testid={`plan-chip-${kind}`} disabled={n === 0} onClick={onPress}
      className={`inline-flex h-6 items-center gap-1 rounded-full pl-1 pr-2.5 text-meta font-semibold enabled:hover:brightness-95 disabled:opacity-45 ${CHIP_TONE[kind]}`}>
      <PlanMark kind={kind} size={14} />
      {t(CHIP_KEY[kind], { n })}
      {visiting !== null && n > 0 && <span data-testid={`plan-chip-${kind}-cycle`} className="font-normal"> · {t('plan.sum.cycle', { i: visiting, n })}</span>}
    </button>
  );
}

const PILL_TONE: Record<PlanPill['key'], string> = {
  blocked: 'bg-danger-surface text-state-stuck',
  mine: 'bg-accent-surface text-accent-text font-semibold',
  active: 'bg-state-active-surface text-state-active font-medium',
  count: 'border border-dashed border-border text-fg-muted',
  waiting: 'border border-dashed border-border text-fg-muted',
  waitingCount: 'border border-dashed border-border text-fg-muted',
  done: 'border border-border text-fg-muted',
  plain: 'text-fg-muted',
};

/** 흐름의 그룹 알약 — 누르면 그 그룹으로 간다. 막힌 그룹이면 첫 막힌 단계의 「막힌 까닭」까지 편다. */
function PillChip({ pill, onPress }: { pill: PlanPill; onPress: () => void }) {
  const t = useT();
  const { title, done, total, n } = pill;
  const label = pill.key === 'done' ? t('plan.pill.done', { title })
    : pill.key === 'blocked' ? t('plan.pill.blocked', { title, done, total })
      : pill.key === 'mine' ? t('plan.pill.mine', { title, n })
        : pill.key === 'active' ? t('plan.pill.active', { title, n, done, total })
          : pill.key === 'waitingCount' ? t('plan.pill.waitingCount', { title, done, total })
            : pill.key === 'waiting' ? t('plan.pill.waiting', { title })
              : pill.key === 'count' ? t('plan.pill.count', { title, done, total })
                : title;
  return (
    <button type="button" data-testid="plan-pill" data-key={pill.key} onClick={onPress}
      className={`max-w-[12rem] truncate rounded-full px-2 text-meta hover:brightness-95 ${PILL_TONE[pill.key]}`}>
      {label}{pill.key === 'blocked' ? ' ›' : ''}
    </button>
  );
}

/** 키는 글자 그대로 적는다 — 「사전에 안 쓰는 키」 시험이 글자로 찾는다. */
const MARK_LABEL = {
  blocked: 'plan.state.blocked', active: 'plan.state.active', done: 'plan.state.done', waiting: 'plan.state.waiting',
  ready: 'plan.state.ready', hidden: 'plan.state.hidden', mine: 'plan.row.mine',
} as const satisfies Record<PlanRowKind, string>;

const MARK_FILL: Partial<Record<PlanRowKind, string>> = {
  done: 'fill-success', active: 'fill-state-active', blocked: 'fill-state-stuck', mine: 'fill-accent',
};

/**
 * 상태 표지(V1·V2) — 채운 원 18px + 흰 기호: 끝 ✓ · 진행 ▶ · 막힘 ! · 내 차례 사람. 빈 원: 시작 가능 ▷ · 대기 점선 · 볼 수 없음 성긴 점선.
 * 채운 것과 빈 것이 크기·면만으로 두 무리로 갈리고, 기호로 다시 갈린다. 낭독기는 글자로 읽는다.
 */
export function PlanMark({ kind, size = 18 }: { kind: PlanRowKind; size?: number }) {
  const t = useT();
  const fill = MARK_FILL[kind];
  return (
    <svg data-testid="plan-mark" data-kind={kind} role="img" aria-label={t(MARK_LABEL[kind])} viewBox="0 0 18 18" width={size} height={size} className="shrink-0">
      {fill && <circle cx="9" cy="9" r="9" className={fill} />}
      {kind === 'done' && <path d="M5 9.3 8 12.2 13 6.5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'active' && <path d="M7 5.2v7.6L13 9z" fill="white" />}
      {kind === 'blocked' && <><path d="M9 4.5v5.6" stroke="white" strokeWidth="2.2" strokeLinecap="round" /><circle cx="9" cy="13.2" r="1.3" fill="white" /></>}
      {kind === 'mine' && <><circle cx="9" cy="6.6" r="2.6" fill="white" /><path d="M4.4 14.2a4.6 4.6 0 0 1 9.2 0z" fill="white" /></>}
      {kind === 'ready' && <><circle cx="9" cy="9" r="8" fill="none" className="stroke-state-waiting" strokeWidth="1.6" /><path d="M7.4 5.8v6.4L12.4 9z" className="fill-fg-muted" /></>}
      {kind === 'waiting' && <circle cx="9" cy="9" r="8" fill="none" className="stroke-state-waiting" strokeWidth="1.6" strokeDasharray="2.6 2.4" />}
      {kind === 'hidden' && <circle cx="9" cy="9" r="8" fill="none" className="stroke-fg-subtle" strokeWidth="1.4" strokeDasharray="1.2 4" />}
    </svg>
  );
}

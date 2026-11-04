import { useEffect, useRef, useState } from 'react';
import type { PlanRef } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { findAppWindow } from '../lib/appWindows';
import { planRefView } from '../lib/planRef';
import { savePlanOpen } from '../lib/threadPlan';
import { useT } from '../i18n/useT';
import { MARK_LABEL, PlanMark } from './PlanBody';

/** 칩이 가리키는 단계로 간다 — 계획 창이 있으면 그 창, 아니면 스레드의 패널을 연다. */
async function openPlanStep(ref: PlanRef): Promise<void> {
  const store = useActiveStore.getState();
  const go = () => useActiveStore.getState().set({ planFocus: { rootId: ref.rootId, stepId: ref.stepId, at: Date.now() } });
  const planWindow = findAppWindow({ kind: 'plan', channelId: '', rootId: ref.rootId });
  if (planWindow) {
    planWindow.win.focus();
    go();
    return;
  }
  savePlanOpen(ref.rootId, true);
  const threadWindow = findAppWindow({ kind: 'thread', channelId: '', rootId: ref.rootId });
  if (threadWindow) threadWindow.win.focus();
  else if (store.threadRootId !== ref.rootId) {
    const channelId = store.threadPlans[ref.rootId]?.channelId;
    await (channelId ? getController().openThread(ref.rootId, { channelId }) : getController().openMessage(ref.rootId));
  }
  go();
}

/**
 * 글 안의 단계 칩. 바탕은 중립이고 색은 앞 표지와 막힘 글자에만 쓴다.
 * 제목은 남이 쓴 글이라 **글자로만** 그린다. 볼 수 없는 스레드면 글에 적힌 제목까지 감춘다.
 */
export function PlanRefChip({ planRef, interactive = true }: { planRef: PlanRef; interactive?: boolean }) {
  const t = useT();
  const plan = useActiveStore((s) => s.threadPlans[planRef.rootId]);
  const denied = useActiveStore((s) => !!s.threadPlanDenied[planRef.rootId]);
  const me = useActiveStore((s) => s.me?.id ?? null);
  const unknown = plan === undefined && !denied;
  useEffect(() => {
    if (unknown) void getController().loadPlanForRef(planRef.rootId);
  }, [unknown, planRef.rootId]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const view = planRefView(planRef, plan, denied, me);
  const base = 'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-row border px-1.5 align-[1px] text-meta leading-5';
  if (view.kind === 'hidden') {
    return <span data-testid="plan-ref-hidden" className={`${base} border-dashed border-border text-fg-subtle`}>🔒 {t('plan.ref.hidden')}</span>;
  }
  if (view.kind === 'gone') {
    return (
      <span data-testid="plan-ref-gone" className={`${base} border-dashed border-border text-fg-subtle`}>
        <span className="min-w-0 truncate line-through">{view.text}</span>
        <span className="shrink-0">· {t(view.noPlan ? 'plan.ref.noPlan' : 'plan.ref.deleted')}</span>
      </span>
    );
  }
  if (view.kind === 'pending') {
    return <span data-testid="plan-ref-pending" className={`${base} border-border bg-surface-sunken text-fg-muted`}><span className="min-w-0 truncate">{view.text}</span></span>;
  }
  const inner = (
    <>
      <PlanMark kind={view.row} size={14} />
      <span className="min-w-0 truncate text-fg">{view.text}</span>
      <span className={`shrink-0 ${view.row === 'blocked' ? 'font-semibold text-state-stuck' : 'text-fg-muted'}`}>· {t(MARK_LABEL[view.row])}</span>
      {view.pr !== null && <span className="shrink-0 text-fg-muted">· #{view.pr}</span>}
      {view.titleChanged && <span data-testid="plan-ref-changed" className="shrink-0 font-semibold text-warning">· {t('plan.ref.titleChanged')}</span>}
    </>
  );
  if (!interactive) return <span data-testid="plan-ref-chip" className={`${base} border-border bg-surface-sunken`}>{inner}</span>;
  return (
    <button
      type="button"
      data-testid="plan-ref-chip"
      aria-busy={busy || undefined}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void openPlanStep(planRef).catch(() => {}).finally(() => { if (alive.current) setBusy(false); });
      }}
      className={`${base} border-border bg-surface-sunken hover:bg-surface-hover active:bg-surface-hover ${busy ? 'cursor-progress opacity-70' : ''}`}
    >
      {inner}
    </button>
  );
}

/** 작성칸 위 띠 — 무엇을 묻는지(칩 하나)와 받는 이, 왜 그 상대인지. */
export function PlanAskBar({ rootId }: { rootId: string }) {
  const t = useT();
  const ask = useActiveStore((s) => s.planAsks[rootId]);
  const accounts = useActiveStore((s) => s.accounts);
  if (!ask) return null;
  const agents = Object.values(accounts).filter((a) => a.kind === 'agent');
  // 고른 상대가 목록에 없으면(사람 담당을 직접 고른 일 등은 없지만 계정이 지워질 수 있다) 없음으로 보인다.
  const value = ask.to && agents.some((a) => a.id === ask.to) ? ask.to : '';
  return (
    <div data-testid="plan-ask-bar" className="mb-1.5 rounded-row border border-border bg-surface-sunken px-2 py-1 text-meta text-fg-muted">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">💬 {t('plan.ask.bar')}</span>
        <span className="min-w-0 flex-1 truncate">
          <PlanRefChip planRef={{ rootId, stepId: ask.stepId, title: null }} interactive={false} />
        </span>
        <button type="button" data-testid="plan-ask-close" aria-label={t('plan.ask.close')} title={t('plan.ask.close')}
          onClick={() => getController().cancelPlanAsk(rootId)}
          className="shrink-0 rounded-row px-1 hover:bg-surface-hover">✕</button>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <label className="flex shrink-0 items-center gap-1.5">
          <span>{t('plan.ask.to')}</span>
          <select data-testid="plan-ask-to" value={value}
            onChange={(e) => getController().setPlanAskRecipient(rootId, e.target.value || null)}
            className="max-w-48 rounded-row border border-border bg-surface-raised px-1 text-fg dark:[color-scheme:dark]">
            <option value="">{t('plan.ask.toNone')}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
          </select>
        </label>
        {ask.reason && <span data-testid="plan-ask-reason" className="min-w-0 truncate" title={t(`plan.ask.reason.${ask.reason}`)}>{t(`plan.ask.reason.${ask.reason}`)}</span>}
      </div>
    </div>
  );
}

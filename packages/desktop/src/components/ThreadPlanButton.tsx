import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ThreadPlanProgress, ThreadPlanView } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import {
  clampPlanSize, loadPlanOpen, loadPlanSize, PLAN_PANEL_DEFAULT, planButtonKind, planCanWiden, planTone, savePlanOpen, savePlanSize, widePlanSize, type PlanSizeScope,
} from '../lib/threadPlan';
import { PlanBody, PlanMark, usePlanSync } from './PlanBody';
import { appWindowKey, useAppWindows } from '../lib/appWindows';
import { openWindow } from '../lib/windowActions';
import { useHostDocument, viewOf } from '../lib/hostDocument';
import { useT } from '../i18n/useT';

/**
 * 스레드 계획판 — 오른쪽 아래 떠 있는 버튼과 그 자리에서 펼치는 패널(개선 시안 v3 W4~W8, V1~V4).
 *
 * - **부를 길은 루트 행의 `planProgress` 뿐이다**(serverSurfaceGated) — 옛 서버나 계획 없는 스레드에서는 버튼이 없고 GET 도 없다.
 * - 판을 받는 곳은 이 버튼 하나다(architect R1). 루트 행의 rev 가 들고 있는 판과 다르면 받는다(R3).
 * - 칩은 판을 받은 뒤 **개인 진행률**(GET)을 쓴다(R2). 채널 목록 칩은 청중 값 그대로다.
 * - 펼침은 모달이 아니다: 피드를 읽고 답을 쓸 수 있다. ✕·버튼·Esc 로 닫고 피드를 눌러도 닫히지 않는다. 스레드별로 기억한다(D4).
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
  usePlanSync(rootId, progress);
  const isMainWindow = useHostDocument() === document;
  const planKey = appWindowKey({ kind: 'plan', channelId: '', rootId });
  const popped = useAppWindows((s) => s.entries.some((e) => e.key === planKey));
  // 계획 창이 있는 동안 패널은 닫혀 있다. 창이 닫히면 메인 창은 저장값을 다시 읽는다 — 「되돌리기」는 편 채로 저장하고 닫는다.
  useEffect(() => {
    if (popped) setOpenState(false);
    else if (isMainWindow) setOpenState(loadPlanOpen(rootId));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 창이 열리고 닫힐 때만 맞춘다
  }, [popped]);

  const setOpen = (next: boolean) => { setOpenState(next); savePlanOpen(rootId, next); };
  useEffect(() => { onOpenChange?.(shown && open && !!plan && !popped); }, [shown, open, plan, popped, onOpenChange]);

  if (!shown || !progress) return null;
  const counts = plan && plan.progress.total > 0 ? plan.progress : progress;
  const isOpen = open && !!plan && !popped;

  return (
    <>
      {isOpen && plan && <PlanPanel plan={plan} onClose={() => setOpen(false)} />}
      <button
        type="button"
        data-testid="plan-button"
        aria-expanded={isOpen}
        aria-label={[t('plan.button.aria', { done: counts.done, total: counts.total }),
          ...(counts.blocked > 0 ? [t('plan.button.ariaBlocked', { n: counts.blocked })] : []),
          popped ? t('window.inWindow') : isOpen ? t('plan.button.close') : t('plan.button.open')].join(', ')}
        data-popped={popped ? 'true' : undefined}
        onClick={() => {
          if (popped) { useAppWindows.getState().entries.find((e) => e.key === planKey)?.win.focus(); return; }
          setOpen(!open);
        }}
        onKeyDown={(e) => { if (e.key === 'Escape' && isOpen) { e.stopPropagation(); setOpen(false); } }}
        className={`absolute bottom-3 right-4 inline-flex h-9 max-w-[calc(100%-32px)] items-center gap-2 whitespace-nowrap rounded-full border pl-2 pr-3 text-meta font-semibold text-fg shadow-float ${popped ? 'border-dashed border-state-active' : 'border-border'} ${isOpen ? 'bg-surface-sunken' : 'bg-surface-raised hover:bg-surface-sunken'}`}
      >
        <PlanMark kind={planButtonKind(counts)} />
        <span className="truncate">{t('plan.chip', { done: counts.done, total: counts.total })}</span>
        <ProgressBar done={counts.done} total={counts.total} />
        {counts.blocked > 0 && <span data-testid="plan-button-blocked" className="text-state-stuck">{t('plan.chip.blocked', { n: counts.blocked })}</span>}
        {popped
          ? <span data-testid="plan-button-popped" className="text-state-active">⧉ {t('window.inWindow')}</span>
          : <span aria-hidden="true" className="text-fg-subtle">{isOpen ? '⌄' : '⌃'}</span>}
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
  const panelRef = useRef<HTMLDivElement>(null);
  // 새 창은 메인의 React 트리가 포털로 그린다 — 전역 `window` 는 늘 메인 창이고, 새 창의 포인터 이벤트는 거기 오지 않는다.
  const hostDoc = useHostDocument();
  const hostView = viewOf(hostDoc);
  const sizeScope: PlanSizeScope = hostDoc === document ? 'main' : 'window';
  const [size, setSize] = useState(() => loadPlanSize(sizeScope) ?? PLAN_PANEL_DEFAULT);
  const [canWiden, setCanWiden] = useState(true);
  /** 스레드 칸의 크기 — 최대 크기를 정한다. 저장값은 건드리지 않고 그릴 때만 줄인다(CSS max-w·max-h, X2). */
  const boxOf = () => {
    const el = panelRef.current?.parentElement;
    return { w: el?.clientWidth || hostView.innerWidth, h: el?.clientHeight || hostView.innerHeight };
  };
  // 그 창의 생성자를 쓴다. 없는 환경(jsdom)이면 「넓게」를 그대로 둔다.
  useEffect(() => {
    const el = panelRef.current?.parentElement;
    const Observer = (hostView as Window & typeof globalThis).ResizeObserver as typeof ResizeObserver | undefined;
    if (!el || !Observer) return;
    const measure = () => { setCanWiden(planCanWiden({ w: el.clientWidth, h: el.clientHeight })); };
    const ro = new Observer(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 창은 이 패널이 사는 동안 바뀌지 않는다
  }, [hostView]);
  /** 왼쪽·위로 끌수록 커진다 — 패널이 오른쪽 아래에 붙어 있다. */
  const beginResize = (e: ReactPointerEvent, axis: { w: boolean; h: boolean }) => {
    e.preventDefault();
    // 저장값이 아니라 **보이는 크기**에서 시작한다. 저장값이 칸보다 크면 CSS 가 줄여 그리므로, 저장값에서 시작하면
    // 안쪽으로 끌어도 한참 동안 그대로다.
    const shown = panelRef.current?.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY, w: shown?.width || size.w, h: shown?.height || size.h };
    let last: { w: number; h: number } | null = null;
    const move = (ev: PointerEvent) => {
      // 뗀 것을 놓쳤다(창 밖에서 뗐다 등) — 버튼이 눌려 있지 않으면 끌기는 이미 끝났다. 끝내지 않으면 마우스를 계속 따라온다.
      if (ev.buttons === 0) { end(); return; }
      last = clampPlanSize({ w: axis.w ? from.w + from.x - ev.clientX : from.w, h: axis.h ? from.h + from.y - ev.clientY : from.h }, boxOf());
      setSize(last);
    };
    const end = () => {
      hostView.removeEventListener('pointermove', move);
      hostView.removeEventListener('pointerup', end);
      hostView.removeEventListener('pointercancel', end);
      hostView.removeEventListener('blur', end);
      if (last) savePlanSize(last, sizeScope);
    };
    hostView.addEventListener('pointermove', move);
    hostView.addEventListener('pointerup', end);
    hostView.addEventListener('pointercancel', end);
    hostView.addEventListener('blur', end);
    // 창 밖에서 움직이고 떼어도 이 창이 받게 한다. 잡지 못해도(시험 환경 등) 끌기는 돈다.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 위 buttons 검사가 끝을 잡는다 */ }
  };
  const resetSize = () => { setSize(PLAN_PANEL_DEFAULT); savePlanSize(null, sizeScope); };
  const isWide = size.w !== PLAN_PANEL_DEFAULT.w || size.h !== PLAN_PANEL_DEFAULT.h;
  const toggleWide = () => {
    if (isWide) { resetSize(); return; }
    const next = widePlanSize(boxOf());
    setSize(next);
    savePlanSize(next, sizeScope);
  };

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
      <PlanBody plan={plan} onLeave={onClose} headActions={(
        <>
          {(isWide || canWiden) && (
            <button type="button" data-testid="plan-size-toggle" onClick={toggleWide} className="shrink-0 rounded-row px-1 text-meta text-fg-muted hover:bg-surface-sunken">
              {isWide ? t('plan.size.default') : t('plan.size.wide')}
            </button>
          )}
          <button type="button" data-testid="plan-pop-out" title={t('plan.window.open')} aria-label={t('plan.window.open')}
            onClick={() => {
              const r = openWindow({ kind: 'plan', channelId: plan.channelId, rootId: plan.rootId });
              if (r.kind === 'opened' || r.kind === 'focused') onClose();
            }}
            className="shrink-0 rounded-row px-1 text-meta text-fg-muted hover:bg-surface-sunken">⧉</button>
          <button type="button" data-testid="plan-panel-close" aria-label={t('plan.panel.close')} onClick={onClose}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-fg-muted hover:text-fg">✕</button>
        </>
      )} />
    </div>
  );
}

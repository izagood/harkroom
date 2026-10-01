/**
 * 에이전트 모델 칩 + 고르개(스레드별 모델 지정, 서버 079 · jaebin 승인 결정 1~13).
 *
 * 두 자리에서 쓴다:
 * - **스레드 머리**(`mode: 'thread'`): 적용하면 곧바로 그 스레드의 지정이 바뀐다(다음 턴부터).
 * - **작성창 "부를 상대" 줄**(`mode: 'composer'`): 적용해도 아무것도 보내지 않는다 — 그 글과 함께
 *   간다(`agentModels[]`). 채널 작성창 값은 보낸 뒤 `기본` 으로 돌아간다(결정 12).
 *
 * 고르개의 재료는 `GET /agents/:id/model-options` 다. 오퍼레이터 능력은 operator.manage 전용이라
 * 그 길로는 일반 멤버의 고르개가 늘 자유 입력으로 떨어진다. 목록을 모르면(`models` 없음)
 * `ModelPicker` 가 직접 입력으로 물러선다 — "고를 것이 없다" 고 그리지 않는다.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentModelOptions } from '@harkroom/shared';
import { getController } from '../state/controller';
import { ModelPicker } from './settings/ModelPicker';
import { formatModelValue, type ModelValue } from '../lib/threadModels';
import { useT } from '../i18n/useT';

const FIELD = 'w-full rounded border border-border bg-surface px-2 py-1 text-meta';

export function AgentModelChip({
  agentId, handle, value, stale = false, inherited = false, highlight = false, mode, placement = 'below',
  open: openProp, onOpenChange, onApply, onReset, trigger,
}: {
  agentId: string;
  handle: string;
  /** 지금 값. null 이면 `기본`. 스레드 작성창은 스레드 지정을 이어받아 여기 넣는다. */
  value: ModelValue | null;
  /** 지정 뒤 하네스가 바뀌어 쓰지 않는 값(결정 9). 취소선으로 그린다. */
  stale?: boolean;
  /**
   * 스레드 작성창이 **스레드 지정을 이어받아** 보이는 값이다(designer 검토 2). 새로 고른 값과 같은
   * 모양이면 사람은 "이 글이 바꾼다" 로 읽는다 — 옅게 칠하고 `스레드` 꼬리를 붙인다. 이때 되돌리기는
   * "스레드 지정 풀기" 이고, 그 글이 실제로 지정을 푼다.
   */
  inherited?: boolean;
  /** 방금 부른 상대다 — 칩을 잠깐 강조해 고르는 길을 보인다(designer 검토 4). */
  highlight?: boolean;
  /** 칩 대신 다른 단추로 연다(실패 카드의 [모델 고르기]). */
  trigger?: string;
  mode: 'thread' | 'composer';
  placement?: 'below' | 'above';
  /** 바깥에서 열 수 있다(⌘⇧M). 없으면 칩이 스스로 연다. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onApply: (next: ModelValue) => void | Promise<unknown>;
  onReset: () => void | Promise<unknown>;
}) {
  const t = useT();
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const setOpen = (next: boolean) => { onOpenChange?.(next); if (openProp === undefined) setOpenSelf(next); };
  const label = formatModelValue(value);
  const set = label !== null;
  const style = trigger
    ? 'border border-border bg-surface-raised font-medium text-fg hover:bg-surface-hover'
    : stale
      // 무효는 실패가 아니다 — 빨강이 아니라 경고 색이다(designer 검토 3).
      ? 'border border-warning-border bg-warning-surface text-warning'
      : set && inherited
        ? 'bg-accent-surface/50 text-fg-muted'
        : set
          ? 'bg-accent-surface font-medium text-fg'
          : 'border border-dashed border-border text-fg-subtle';

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid={trigger ? `model-trigger-${handle}` : `model-chip-${handle}`}
        data-stale={stale || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-inherited={(inherited && set) || undefined}
        aria-label={trigger ?? t('threadModel.chipLabel', { handle, value: label ?? t('threadModel.default') })}
        // 단축키는 칩에 적는다 — 줄 끝의 힌트는 부른 직후에만 선다(designer 검토 4).
        title={mode === 'composer' ? t('threadModel.chipHint') : undefined}
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-meta ${style} ${
          highlight ? 'ring-2 ring-accent' : ''
        } hover:bg-surface-sunken`}
      >
        {trigger ? trigger : (
          <>
            {mode === 'thread' && <span className="text-fg-muted">@{handle} ·</span>}
            <span className={stale ? 'line-through' : undefined}>{label ?? t('threadModel.default')}</span>
            {set && (mode === 'thread' || inherited) && !stale && <span className="text-fg-subtle">{t('threadModel.threadSet')}</span>}
            <span aria-hidden className="text-fg-subtle">▾</span>
          </>
        )}
      </button>
      {open && (
        <AgentModelPicker
          agentId={agentId}
          handle={handle}
          value={value}
          mode={mode}
          placement={placement}
          clearsThread={inherited && set}
          onClose={() => setOpen(false)}
          onApply={onApply}
          onReset={onReset}
        />
      )}
    </span>
  );
}

type PickerOptions = Omit<AgentModelOptions, 'harness'> & { harness: AgentModelOptions['harness'] | null };

function AgentModelPicker({ agentId, handle, value, mode, placement, clearsThread, onClose, onApply, onReset }: {
  agentId: string; handle: string; value: ModelValue | null; mode: 'thread' | 'composer';
  placement: 'below' | 'above'; clearsThread: boolean; onClose: () => void;
  onApply: (next: ModelValue) => void | Promise<unknown>;
  onReset: () => void | Promise<unknown>;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<PickerOptions | null>(null);
  // 칩이 오른쪽에 있으면 왼쪽 맞춤으로는 패널 밖으로 넘친다 — 열 때 재서 오른쪽 맞춤으로 바꾼다.
  const [alignRight, setAlignRight] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const pane = el.closest('section') ?? document.body;
    const room = pane.getBoundingClientRect().right - parent.getBoundingClientRect().left;
    setAlignRight(room < el.offsetWidth);
  }, []);
  const [model, setModel] = useState(value?.model ?? '');
  const [effort, setEffort] = useState(value?.effort ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getController().agentModelOptions(agentId)
      .then((o) => { if (alive) setOptions(o); })
      // 못 받으면 "모른다" 로 둔다 — 직접 입력은 그대로 된다.
      .catch(() => { if (alive) setOptions({ harness: null, model: null, effort: null }); });
    return () => { alive = false; };
  }, [agentId]);

  // 바깥을 누르면 닫는다. 고르개 안의 select 가 띄운 목록은 이 상자 안의 클릭으로 온다.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const models = options === null ? null : options.models;
  // effort 목록은 **이 턴이 쓸 모델**의 것이다 — 모델을 안 골랐으면 에이전트 설정 모델.
  const target = model || options?.model || null;
  const efforts = target ? models?.find((m) => m.id === target)?.efforts : undefined;
  const agentDefault = formatModelValue({ model: options?.model ?? null, effort: options?.effort ?? null })
    ?? t('threadModel.picker.harnessDefault');

  const run = async (fn: () => void | Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : t('threadModel.picker.failed'));
    } finally {
      setBusy(false);
    }
  };
  const apply = () => run(() => onApply({ model: model.trim() || null, effort: effort.trim() || null }));

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t(mode === 'thread' ? 'threadModel.picker.title' : 'threadModel.picker.composerTitle', { handle })}
      data-testid="model-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        // select 안의 Enter 는 목록을 닫는 데 쓰인다 — 버튼·입력에서만 적용한다.
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'SELECT' && !busy) { e.preventDefault(); void apply(); }
      }}
      className={`absolute ${alignRight ? 'right-0' : 'left-0'} z-30 w-80 rounded-md border border-border bg-surface-raised p-3 shadow-lg ${
        placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'
      }`}
      style={{ maxHeight: 'min(26rem, 60vh)', overflowY: 'auto' }}
    >
      <p className="mb-2 font-medium">
        {t(mode === 'thread' ? 'threadModel.picker.title' : 'threadModel.picker.composerTitle', { handle })}
      </p>
      <p className="-mt-1 mb-2 text-meta text-fg-subtle" data-testid="model-agent-default">
        {t('threadModel.picker.agentDefault', { value: agentDefault })}
      </p>
      <label className="mb-1 block text-meta text-fg-muted">{t('threadModel.picker.model')}</label>
      <div className="mb-2 flex flex-col gap-1">
        <ModelPicker value={model} models={models} onChange={setModel} className={FIELD} />
      </div>
      <label className="mb-1 block text-meta text-fg-muted" htmlFor={`effort-${agentId}`}>{t('threadModel.picker.effort')}</label>
      {efforts ? (
        <select id={`effort-${agentId}`} data-testid="effort-select" className={`${FIELD} mb-2`} value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">{t('threadModel.picker.effortDefault')}</option>
          {efforts.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : (
        <input
          id={`effort-${agentId}`}
          data-testid="effort-input"
          className={`${FIELD} mb-2`}
          placeholder={t('threadModel.picker.effortDefault')}
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
        />
      )}
      <ul className="mb-2 list-disc pl-4 text-meta text-fg-subtle">
        <li>{t('threadModel.picker.costWeekly')}</li>
        <li>{t('threadModel.picker.costCache')}</li>
        <li>{t('threadModel.picker.costContext')}</li>
      </ul>
      {mode === 'thread' && <p className="mb-2 text-meta text-fg-muted">{t('threadModel.picker.nextTurn')}</p>}
      {error && <p role="alert" className="mb-2 text-meta text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" data-testid="model-reset" disabled={busy}
          className="rounded px-2 py-1 text-meta text-fg-muted hover:bg-surface-sunken"
          onClick={() => void run(onReset)}>
          {t(clearsThread ? 'threadModel.picker.clearThread' : 'threadModel.picker.reset')}
        </button>
        <button type="button" data-testid="model-apply" disabled={busy}
          className="rounded bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong hover:bg-accent-hover"
          onClick={() => void apply()}>
          {t('threadModel.picker.apply')}
        </button>
      </div>
    </div>
  );
}

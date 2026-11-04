import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadPlanView } from '@harkroom/shared';
import { ApiError, type PlanStartDone, type PlanStartPreview, type PlanStartSkipCode, type PlanStartStep } from '../lib/api';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { planStartClean, planTitleOf } from '../lib/threadPlan';
import { useT } from '../i18n/useT';

/** 판이 달라졌다는 응답 — 미리보기를 다시 받아 사람에게 새 내용을 보인 뒤에만 시작한다. */
const STALE_CODES = new Set(['plan_changed', 'if_rev_required']);

/** 키는 글자 그대로 적는다 — 「사전에 안 쓰는 키」 시험이 글자로 찾는다. */
const SKIP_KEY = {
  unknown_item: 'plan.start.skip.gone',
  plan_changed: 'plan.start.skip.gone',
  already_started: 'plan.start.skip.already',
  not_ready: 'plan.start.skip.notReady',
  no_assignee: 'plan.start.skip.noAssignee',
  invalid_assignee: 'plan.start.skip.notInvokable',
  not_invokable: 'plan.start.skip.notInvokable',
  other_human_assignee: 'plan.start.otherHuman',
} as const satisfies Record<PlanStartSkipCode, string>;

const MANAGER_KEY = {
  manager_off: 'plan.start.manager.off',
  manager_no_access: 'plan.start.manager.noAccess',
  manager_not_invokable: 'plan.start.manager.notInvokable',
} as const;

/**
 * 계획판 「시작」 확인 상자(시안 v4 X6·X8). 줄 바로 아래에 펴지고 모달이 아니다.
 *
 * - 누르기 전에 **이 스레드에 올라갈 글과 부를 상대**를 보인다. 글은 서버가 지은 미리보기를 글자로만 그린다.
 * - 시작 요청에는 미리보기의 `rev` 를 싣는다. 그 사이 판이 바뀌면 시작하지 않고 미리보기를 다시 받아 새 내용을 보인다.
 * - 관리 에이전트가 있으면 서버가 그쪽으로 보낸다. 못 거치면 그 까닭(`managerSkipped`)을 한 줄로 보인다.
 */
export function PlanStartBox({ plan, stepIds, bulk = false, onClose, onStarted }: {
  plan: ThreadPlanView;
  stepIds: string[];
  bulk?: boolean;
  onClose: () => void;
  onStarted: (res: PlanStartDone) => void;
}) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const members = useActiveStore((s) => s.channelMembers[plan.channelId]);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<string>('');
  // 미리보기는 그때 보낸 단계(key)와 함께 둔다 — 고른 것이 바뀌면 판 번호가 같아도 낡은 미리보기다.
  const [loaded, setLoaded] = useState<{ key: string; preview: PlanStartPreview } | null>(null);
  const [result, setResult] = useState<PlanStartDone | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const seq = useRef(0);

  const chosen = useMemo(() => stepIds.filter((id) => !off[id]), [stepIds, off]);
  const steps: PlanStartStep[] = useMemo(() => chosen.map((id) => (picked ? { id, assigneeId: picked } : { id })), [chosen, picked]);
  const stepsKey = JSON.stringify(steps);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!steps.length) { setLoaded(null); return; }
    try {
      const next = await getController().previewPlanStart(plan.rootId, steps);
      if (mine === seq.current) { setLoaded({ key: stepsKey, preview: next }); setError(null); }
    } catch (e) {
      if (mine === seq.current) { setLoaded(null); setError(reasonOf(e)); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stepsKey 가 steps 의 값이다
  }, [plan.rootId, stepsKey]);
  useEffect(() => { void load(); }, [load]);
  // 상자가 목록 아래쪽에서 펴져도 글과 버튼이 보이게 한다.
  const boxRef = useRef<HTMLDivElement>(null);
  const preview = loaded?.preview ?? null;
  /** 보이는 미리보기가 지금 고른 것의 것이 아니다 — 새 것이 올 때까지 시작하지 못한다. */
  const refreshing = !!loaded && loaded.key !== stepsKey;
  useEffect(() => { boxRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [preview]);

  /** 칩 줄의 「모두 시작」 상자에서 고를 수 없는 줄 — 처음 받은 미리보기의 사유를 남겨 둔다. */
  const skipOf = new Map(preview?.skipped.map((s) => [s.id, s.code]));
  const handleOf = (id: string) => accounts[id]?.handle ?? null;
  const agents = useMemo(() => {
    const inChannel = members ? new Set(members.map((m) => m.accountId)) : null;
    return Object.values(accounts).filter((a) => a.kind === 'agent' && (!inChannel || inChannel.has(a.id)));
  }, [accounts, members]);
  const needsPick = !bulk && preview?.skipped.some((s) => s.code === 'no_assignee') === true;
  const startable = preview ? preview.posts.reduce((n, p) => n + p.stepIds.length, 0) + preview.selfStepIds.length : 0;

  const start = async () => {
    if (!preview || refreshing || starting) return;
    setStarting(true);
    setError(null);
    setNotice(false);
    setResult(null);
    try {
      const res = await getController().startPlan(plan.rootId, steps, preview.rev);
      onStarted(res);
      if (!planStartClean(res)) {
        // 판이 바뀌었으니 이 상자에 남은 줄의 미리보기도 새로 받는다.
        setResult(res);
        await load();
      }
    } catch (e) {
      if (e instanceof ApiError && STALE_CODES.has(e.code)) {
        setNotice(true);
        await load();
      } else {
        setError(reasonOf(e));
      }
    } finally {
      setStarting(false);
    }
  };

  function reasonOf(e: unknown): string {
    const code = e instanceof ApiError ? (e.code as PlanStartSkipCode) : null;
    if (code && code in SKIP_KEY) return t(SKIP_KEY[code]);
    return t('plan.start.failed');
  }

  const first = preview?.posts[0];
  const toOf = new Map(preview?.posts.flatMap((p) => p.stepIds.map((id) => [id, p.to] as const)));
  const notes = result ? [...result.skipped.map((s) => ({ id: s.id, text: t(SKIP_KEY[s.code]) })), ...result.failed.map((f) => ({ id: f.id, text: t('plan.start.postFailed') }))] : [];
  return (
    <div ref={boxRef} data-testid="plan-start-box" className="mb-1 ml-8 mr-1.5 rounded-row border border-state-active bg-surface-raised px-2.5 py-2 text-meta">
      <div data-testid="plan-start-title" className="font-semibold">
        {bulk && t('plan.start.bulkTitle', { n: stepIds.length })}
        {!bulk && first && (first.via === 'manager'
          ? t('plan.start.viaManager', { handle: handleOf(first.to) ?? '' })
          : t('plan.start.toAssignee', { handle: handleOf(first.to) ?? '' }))}
        {!bulk && !first && preview && preview.selfStepIds.length > 0 && t('plan.start.self')}
        {!bulk && !preview && !error && t('plan.start.loading')}
        {!bulk && !first && needsPick && t('plan.start.pickTitle')}
      </div>
      {preview?.managerSkipped && <div data-testid="plan-start-manager-skipped" className="text-warning">{t(MANAGER_KEY[preview.managerSkipped])}</div>}
      {notice && <div data-testid="plan-start-changed" className="text-warning">{t('plan.start.changed')}</div>}
      {refreshing && <div data-testid="plan-start-refreshing" className="text-fg-muted">{t('plan.start.refreshing')}</div>}
      {bulk && preview && <div data-testid="plan-start-turns" className="text-fg-muted">{t('plan.start.bulkTurns', { n: preview.posts.length })}</div>}
      {bulk && (
        <ul data-testid="plan-start-list" className="py-1">
          {stepIds.map((id) => {
            const skip = skipOf.get(id);
            return (
              <li key={id} className="flex items-center gap-1.5 py-0.5">
                <label className="flex min-w-0 items-center gap-1.5">
                  <input type="checkbox" data-testid={`plan-start-check-${id}`} checked={!off[id] && !skip} disabled={!!skip || starting}
                    onChange={(e) => setOff((o) => ({ ...o, [id]: !e.target.checked }))} />
                  <span className="truncate">{planTitleOf(plan.doc, id)}</span>
                </label>
                {!skip && toOf.has(id) && <span data-testid={`plan-start-to-${id}`} className="shrink-0 text-fg-agent">{t('plan.start.rowTo', { handle: handleOf(toOf.get(id)!) ?? '' })}</span>}
                {skip && <span className="shrink-0 text-fg-subtle">{t(SKIP_KEY[skip])}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {needsPick && (
        <label className="flex items-center gap-1.5 py-1">
          <span className="text-fg-muted">{t('plan.start.pick')}</span>
          <select data-testid="plan-start-pick" value={picked} onChange={(e) => setPicked(e.target.value)} className="min-w-0 rounded-row border border-border bg-surface-raised px-1">
            <option value="">{t('plan.start.pickNone')}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
          </select>
        </label>
      )}
      {!bulk && preview?.skipped.filter((s) => s.code !== 'no_assignee').map((s) => (
        <div key={s.id} data-testid="plan-start-skipped" className="text-state-stuck">{t(SKIP_KEY[s.code])}</div>
      ))}
      {/* 남이 쓴 제목이 든 글이다 — 글자로만 그린다. */}
      {preview?.posts.map((p) => (
        <div key={p.to} className={`mt-1 rounded-row bg-surface-sunken px-2 py-1 ${refreshing ? 'opacity-50' : ''}`}>
          <div className="text-fg-muted">{bulk ? t('plan.start.bodyLabelTo', { handle: handleOf(p.to) ?? '' }) : t('plan.start.bodyLabel')}</div>
          <div data-testid="plan-start-body" className="whitespace-pre-wrap break-words">{p.body}</div>
        </div>
      ))}
      {error && <div data-testid="plan-start-error" className="mt-1 text-state-stuck">{error}</div>}
      {result && (result.failed.length > 0 || result.skipped.length > 0) && (
        <div data-testid="plan-start-result" className="mt-1 text-state-stuck">
          <div>{result.started.length > 0 ? t('plan.start.partial', { n: result.started.length, m: notes.length }) : t('plan.start.failed')}</div>
          {/* 제목은 남이 쓴 글이다 — 글자로만 그린다. */}
          {notes.map((x) => <div key={x.id} className="break-words">{planTitleOf(plan.doc, x.id)} · {x.text}</div>)}
        </div>
      )}
      {result && result.notNotified.length > 0 && (
        <div data-testid="plan-start-not-notified" className="mt-1 text-warning">
          {t('plan.start.notNotified', { handles: result.notNotified.map((id) => handleOf(id) ?? '').filter(Boolean).map((h) => `@${h}`).join(' ') })}
        </div>
      )}
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button type="button" data-testid="plan-start-cancel" onClick={onClose} className="rounded-row border border-border px-2 py-0.5 hover:bg-surface-sunken">{result ? t('plan.start.close') : t('plan.start.cancel')}</button>
        <button type="button" data-testid="plan-start-go" disabled={starting || refreshing || startable === 0} onClick={() => { void start(); }}
          className="rounded-row bg-state-active px-2 py-0.5 font-semibold text-fg-on-strong disabled:opacity-45">
          {starting ? t('plan.start.starting') : bulk ? t('plan.start.goN', { n: startable }) : t('plan.start.go')}
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AutomationGithubTrigger, AutomationIngressIssued, AutomationLastRun, AutomationRunView, AutomationTrigger, AutomationView } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Button, Field, Segmented, Select, SettingsGrid, SettingsPage, Switch, TextInput } from './primitives';
import { useLocale, useT } from '../../i18n/useT';
import {
  describeTrigger, localTimeZone, RERUN_CONFIRM_MS, runErrorText, runStatusText, runTime, runTriggerText,
  unfilledManualVars, weekdayName,
} from '../../lib/automation';
import { ApiError } from '../../lib/api';

/**
 * 자동화(064) — "무슨 일이 생기면 → **내 이름으로** 정한 채널/DM 에 이 글을 쓴다".
 *
 * 액션이 글 한 줄인 이유는 서버 마이그레이션 주석에 있다: 글이 `postMessage` 를 그대로
 * 지나야 멘션·턴·진행 표시가 사람이 친 것과 똑같이 따라온다. 그래서 이 화면이 받는 것도
 * 결국 **본문**이고, 에이전트를 부르려면 본문 맨 앞에 `@handle` 을 쓴다.
 *
 * 만든 사람만 본다(서버가 `owner_id` 로 거른다). 남의 자동화가 이 목록에 없는 것은 결함이 아니다.
 *
 * 목록은 **최신이 위**이고 카드는 **접힌 채** 선다 — 이름·켜기 토글·일정 한 줄만 보이고, 본문과
 * 버튼은 눌러 펼쳐야 보인다. 서버는 `created_at` 오름차순으로 주므로 정렬은 여기서 한다
 * (옛 서버에도 그대로 듣는다).
 */

type Kind = AutomationTrigger['kind'];

/**
 * [지금 한 번 돌리기] 한 번의 진행(A안, 스레드 314478b5). 서버는 202 로 대기 회차만 주고 글은
 * sweeper 가 15초 안쪽에 올린다 — 그래서 회차 id 로 다시 읽어 결과를 기다린다. 자동화마다
 * 따로 둔다(공용 busy 는 0.1초 켜졌다 꺼져 눌린 줄 몰랐다). 결과 줄은 저절로 사라지지 않는다.
 */
type RunState =
  | { phase: 'pending'; runId: string | null }
  | { phase: 'sent'; runId: string; at: string; messageId: string | null }
  | { phase: 'failed'; runId: string | null; code: string }
  | { phase: 'slow'; runId: string };

const POLL_MS = 2_000;
const POLL_LIMIT_MS = 30_000;
type Freq = 'daily' | 'weekly' | 'monthly';
type GhEvent = AutomationGithubTrigger['event'];
type GhChange = NonNullable<AutomationGithubTrigger['change']>;

interface Draft {
  name: string; channelId: string; body: string; kind: Kind;
  freq: Freq; weekdays: number[]; monthDay: string; time: string; tz: string;
  repo: string; event: GhEvent; branch: string; paths: string; change: GhChange;
  /** 초. 비우거나 0 이면 이벤트마다 한 번. */
  debounce: string;
}

const emptyDraft = (): Draft => ({
  name: '', channelId: '', body: '', kind: 'schedule',
  freq: 'weekly', weekdays: [1], monthDay: '1', time: '09:00', tz: localTimeZone(),
  repo: '', event: 'push', branch: 'main', paths: '', change: 'any', debounce: '',
});

function draftToTrigger(d: Draft): AutomationTrigger {
  if (d.kind === 'webhook') return { kind: 'webhook' };
  if (d.kind === 'github') {
    const paths = d.paths.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    return {
      kind: 'github', repo: d.repo.trim(), event: d.event,
      ...(d.branch.trim() ? { branch: d.branch.trim() } : {}),
      ...(paths.length ? { paths } : {}),
      ...(d.change !== 'any' ? { change: d.change } : {}),
    };
  }
  if (d.freq === 'daily') return { kind: 'schedule', freq: 'daily', time: d.time, tz: d.tz };
  if (d.freq === 'weekly') return { kind: 'schedule', freq: 'weekly', weekdays: d.weekdays, time: d.time, tz: d.tz };
  return { kind: 'schedule', freq: 'monthly', monthDay: Number(d.monthDay) || 1, time: d.time, tz: d.tz };
}

function triggerToDraft(a: AutomationView): Draft {
  const t = a.trigger;
  const base = { ...emptyDraft(), name: a.name, channelId: a.channelId, body: a.body, kind: t.kind, debounce: a.debounceSec ? String(a.debounceSec) : '' };
  if (t.kind === 'webhook') return base;
  if (t.kind === 'github') {
    return { ...base, repo: t.repo, event: t.event, branch: t.branch ?? '', paths: (t.paths ?? []).join('\n'), change: t.change ?? 'any' };
  }
  return {
    ...base, freq: t.freq,
    weekdays: t.freq === 'weekly' ? t.weekdays : [1],
    monthDay: t.freq === 'monthly' ? String(t.monthDay) : '1',
    time: t.time, tz: t.tz,
  };
}

export function AutomationsSettings({ onOpenMessage }: {
  /** 「글 열기」 — 설정을 닫고 그 글로 간다. 없으면 링크를 세우지 않는다. */
  onOpenMessage?(messageId: string): void;
} = {}) {
  const t = useT();
  const locale = useLocale();
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  const meId = useActiveStore((s) => s.me?.id ?? null);

  const [items, setItems] = useState<AutomationView[] | 'error' | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runsFor, setRunsFor] = useState<{ id: string; runs: AutomationRunView[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** 펼친 카드 id. 기본은 전부 접힘이고, 다시 불러와도(reload) 펼친 것은 그대로 둔다. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 방금 받은 수신 키. **이 화면을 떠나면 다시 볼 수 없다** — 서버가 원문을 남기지 않는다. */
  const [issued, setIssued] = useState<{ id: string; ingress: AutomationIngressIssued } | null>(null);
  const baseUrl = getController().api.baseUrl;
  const [runState, setRunState] = useState<Record<string, RunState>>({});
  /** 확인을 받는 중인 자동화 — 10분 안 재실행이거나 채울 수 없는 트리거 변수가 있을 때. */
  const [confirmRun, setConfirmRun] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const reload = useCallback(() => {
    void getController().api.listAutomations().then(setItems).catch(() => setItems('error'));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  /** 대상 후보: 보관되지 않은 채널 + DM. DM 은 상대 handle 로 부른다. */
  const targets = useMemo(() => {
    const ch = channels.filter((c) => c.kind !== 'dm' && !c.archivedAt)
      .map((c) => ({ value: c.id, label: `#${c.name ?? c.id}` }));
    const dm = dms.map((d) => {
      const others = d.memberIds.filter((id) => id !== meId).map((id) => `@${accounts[id]?.handle ?? '…'}`);
      return { value: d.id, label: t('automations.form.dmLabel', { who: others.join(', ') || t('automations.form.dmSelf') }) };
    });
    return [...ch, ...dm];
  }, [channels, dms, accounts, meId, t]);
  const targetLabel = (id: string) => targets.find((x) => x.value === id)?.label ?? t('automations.row.unknownTarget');

  const reason = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

  const act = async (fn: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setBusy(true);
    try { await fn(); reload(); return true; } catch (e) { setError(reason(e, fallback)); return false; } finally { setBusy(false); }
  };

  const save = async () => {
    if (!draft) return;
    const debounce = Number(draft.debounce);
    const input = {
      name: draft.name.trim(), channelId: draft.channelId, body: draft.body, trigger: draftToTrigger(draft),
      debounceSec: draft.kind !== 'schedule' && Number.isInteger(debounce) && debounce > 0 ? Math.min(debounce, 3600) : null,
    };
    const ok = await act(
      () => editingId ? getController().api.updateAutomation(editingId, input) : getController().api.createAutomation(input),
      t('automations.form.saveFailed'),
    );
    if (ok) { setDraft(null); setEditingId(null); }
  };

  const openRuns = async (id: string) => {
    if (runsFor?.id === id) { setRunsFor(null); return; }
    try {
      const { runs } = await getController().api.getAutomation(id);
      setRunsFor({ id, runs });
    } catch (e) { setError(reason(e, t('automations.runs.loadFailed'))); }
  };

  const setRun = (id: string, st: RunState | null) => setRunState((prev) => {
    const next = { ...prev };
    if (st) next[id] = st; else delete next[id];
    return next;
  });

  /** 회차 id 로 2초마다 다시 읽는다(최대 30초). 옛 서버(lastRun 없음)에도 runs 로 듣는다. */
  const waitForRun = async (id: string, runId: string) => {
    const started = Date.now();
    while (alive.current && Date.now() - started < POLL_LIMIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!alive.current) return;
      try {
        const { runs } = await getController().api.getAutomation(id);
        const r = runs.find((x) => x.id === runId);
        if (r && r.status !== 'pending') {
          setRun(id, r.status === 'sent'
            ? { phase: 'sent', runId, at: r.finishedAt ?? r.createdAt, messageId: r.messageId }
            : { phase: 'failed', runId, code: r.error ?? r.status });
          setRunsFor((prev) => (prev?.id === id ? { id, runs } : prev));
          reload();
          return;
        }
      } catch { /* 한 번 못 읽은 것은 다음 박자에 다시 본다 */ }
    }
    if (alive.current) { setRun(id, { phase: 'slow', runId }); reload(); }
  };

  const doRun = async (a: AutomationView) => {
    setConfirmRun(null);
    setError(null);
    setRun(a.id, { phase: 'pending', runId: null });
    let run: AutomationRunView;
    try {
      run = await getController().api.runAutomation(a.id);
    } catch (e) {
      // 429 는 서버가 자동화를 껐다는 뜻이다 — 사유 코드로 말하고 목록을 다시 읽어 꺼진 것을 보인다.
      if (e instanceof ApiError && e.code === 'rate_limited') { setRun(a.id, { phase: 'failed', runId: null, code: 'rate_limited' }); reload(); return; }
      setRun(a.id, null);
      setError(reason(e, t('automations.row.runFailed')));
      return;
    }
    if (!alive.current) return;
    setRun(a.id, { phase: 'pending', runId: run.id });
    reload();
    await waitForRun(a.id, run.id);
  };

  const startRun = (a: AutomationView) => {
    const recent = a.lastRun && Date.now() - Date.parse(a.lastRun.createdAt) < RERUN_CONFIRM_MS;
    if (recent || unfilledManualVars(a.body, a.trigger).length > 0) { setConfirmRun(a.id); return; }
    void doRun(a);
  };

  const openMessageLink = (messageId: string | null | undefined, label: string, testId: string) =>
    messageId && onOpenMessage ? (
      <button type="button" data-testid={testId} className="text-accent hover:underline"
        onClick={() => onOpenMessage(messageId)}>{label}</button>
    ) : null;

  const canSave = !!draft && draft.name.trim() !== '' && draft.channelId !== '' && draft.body.trim() !== ''
    && (draft.kind !== 'schedule' || (/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) && draft.tz.trim() !== ''
      && (draft.freq !== 'weekly' || draft.weekdays.length > 0)))
    && (draft.kind !== 'github' || /^[\w.-]+\/[\w.-]+$/.test(draft.repo.trim()));

  const issue = async (id: string) => {
    setError(null);
    try {
      setIssued({ id, ingress: await getController().api.issueAutomationIngress(id) });
      reload();
    } catch (e) { setError(reason(e, t('automations.ingress.issueFailed'))); }
  };

  /** 최신이 위. ISO 문자열이라 사전순 비교가 곧 시간순이다. 같으면 id 로 고정해 순서가 튀지 않게 한다. */
  const rows = useMemo(() => (Array.isArray(items) ? [...items] : [])
    .sort((x, y) => (y.createdAt > x.createdAt ? 1 : y.createdAt < x.createdAt ? -1 : y.id.localeCompare(x.id))), [items]);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale || undefined) : '—');

  /** 카드 머리 「마지막 실행」 줄. 방금 이 화면에서 돌린 회차가 있으면 그것이 더 새것이다. */
  const lastRunLine = (a: AutomationView) => {
    const last: AutomationLastRun | null | undefined = a.lastRun;
    const st = runState[a.id];
    if (st?.phase === 'pending' && !last) return null;
    if (last === undefined) return null; // 옛 서버 — 줄을 세우지 않는다
    if (last === null) {
      return <div data-testid="automation-last-run" className="mt-1 pl-5 text-meta text-fg-subtle">{t('automations.row.neverRun')}</div>;
    }
    const dot = last.status === 'sent' ? 'bg-success' : last.status === 'failed' ? 'bg-danger' : last.status === 'pending' ? 'bg-warning motion-safe:animate-pulse' : 'bg-fg-subtle';
    return (
      <div data-testid="automation-last-run" className={`mt-1 flex flex-wrap items-center gap-1.5 pl-5 text-meta ${last.status === 'failed' ? 'text-danger' : 'text-fg-subtle'}`}>
        <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <span>{t('automations.row.lastRun', {
          at: runTime(last.createdAt, locale), trigger: runTriggerText(last.triggerKind, t), status: runStatusText(last.status, t),
        })}</span>
        {last.status === 'sent' && last.messageId && onOpenMessage && <>
          <span aria-hidden>·</span>
          {openMessageLink(last.messageId, t('automations.row.openMessage'), 'automation-last-run-open')}
        </>}
      </div>
    );
  };

  /** 버튼 아래 결과 줄 — 이 화면에서 누른 회차일 때만. */
  const runResult = (a: AutomationView) => {
    const st = runState[a.id];
    if (!st) return null;
    const target = targetLabel(a.channelId);
    const dismiss = st.phase === 'pending' ? null : (
      <button type="button" className="text-fg-subtle hover:underline" onClick={() => setRun(a.id, null)}>{t('automations.run.dismiss')}</button>
    );
    const box = 'mt-2 flex flex-wrap items-start gap-2 rounded-row px-3 py-2 text-body';
    if (st.phase === 'pending') {
      return (
        <div role="status" data-testid="automation-run-result" data-phase="pending" className={`${box} bg-surface-sunken`}>
          <span aria-hidden className="font-bold text-fg-subtle">⋯</span>
          <span className="min-w-0 flex-1">{t('automations.run.pending', { target })}
            <span className="block text-meta text-fg-muted">{t('automations.run.pendingSub')}</span></span>
        </div>
      );
    }
    if (st.phase === 'sent') {
      return (
        <div role="status" data-testid="automation-run-result" data-phase="sent" className={`${box} bg-success-surface`}>
          <span aria-hidden className="font-bold text-success">✓</span>
          <span className="min-w-0 flex-1">{t('automations.run.sent', { at: runTime(st.at, locale), target })}
            {st.messageId && onOpenMessage && <> · {openMessageLink(st.messageId, `${t('automations.row.openMessage')} →`, 'automation-run-open')}</>}
            <span className="block text-meta text-fg-muted">{t('automations.run.sentSub')}</span></span>
          {dismiss}
        </div>
      );
    }
    if (st.phase === 'failed') {
      const limited = st.code === 'rate_limited';
      return (
        <div role="alert" data-testid="automation-run-result" data-phase="failed" className={`${box} bg-danger-surface`}>
          <span aria-hidden className="font-bold text-danger">!</span>
          <span className="min-w-0 flex-1">{limited ? runErrorText(st.code, t) : t('automations.run.failed', { reason: runErrorText(st.code, t) })}
            {!limited && <span className="block text-meta text-fg-muted">{t('automations.run.failedSub')}</span>}</span>
          {!limited && <button type="button" className="text-accent hover:underline" onClick={() => void doRun(a)}>{t('automations.run.retry')}</button>}
          {dismiss}
        </div>
      );
    }
    return (
      <div role="status" data-testid="automation-run-result" data-phase="slow" className={`${box} bg-warning-surface`}>
        <span aria-hidden className="font-bold text-warning">…</span>
        <span className="min-w-0 flex-1">{t('automations.run.slow')}
          <span className="block text-meta text-fg-muted">{t('automations.run.slowSub')}</span></span>
        <button type="button" className="text-accent hover:underline"
          onClick={() => { if (runsFor?.id !== a.id) void openRuns(a.id); }}>{t('automations.run.openHistory')}</button>
        {dismiss}
      </div>
    );
  };

  /** 10분 안 재실행·채울 수 없는 트리거 변수 — 둘 다면 한 장에 두 문장. */
  const runConfirm = (a: AutomationView) => {
    if (confirmRun !== a.id) return null;
    const last = a.lastRun;
    const recent = last && Date.now() - Date.parse(last.createdAt) < RERUN_CONFIRM_MS ? last : null;
    const vars = unfilledManualVars(a.body, a.trigger);
    return (
      <div role="dialog" aria-modal="false" data-testid="automation-run-confirm"
        className="mt-2 max-w-[420px] rounded-card border border-border bg-surface p-3 shadow-lg">
        {recent && <>
          <div className="font-semibold text-fg">{t('automations.confirm.recent', {
            ago: Math.max(1, Math.round((Date.now() - Date.parse(recent.createdAt)) / 60_000)), at: runTime(recent.createdAt, locale),
          })}</div>
          <div className="mb-2 text-meta text-fg-muted">{t('automations.confirm.recentSub')}
            {recent.messageId && onOpenMessage && <> {openMessageLink(recent.messageId, t('automations.confirm.openRecent', { at: runTime(recent.createdAt, locale) }), 'automation-confirm-open')}</>}
          </div>
        </>}
        {vars.length > 0 && <>
          <div className="font-semibold text-fg">{t('automations.confirm.vars')}</div>
          <div className="mb-2 text-meta text-fg-muted">{t('automations.confirm.varsSub', { vars: vars.map((v) => `{{${v}}}`).join(' · ') })}</div>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setConfirmRun(null)}>{t('automations.confirm.cancel')}</Button>
          <Button variant="primary" onClick={() => void doRun(a)}>
            {recent ? t('automations.confirm.again') : t('automations.confirm.sendAnyway')}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <SettingsPage section="automations" description={t('automations.subtitle')} layout="list">
      <div className="mb-6 flex items-center gap-2">
        <Button variant="primary" disabled={draft !== null}
          onClick={() => { setEditingId(null); setDraft({ ...emptyDraft(), channelId: targets[0]?.value ?? '' }); }}>
          {t('automations.list.new')}
        </Button>
        {items === null && <span className="text-fg-subtle">{t('automations.list.loading')}</span>}
      </div>

      {items === 'error' && (
        <p role="alert" className="mb-6 rounded-card border border-danger-border bg-danger-surface p-3 text-danger">
          {t('automations.list.loadFailed')}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-6 rounded-card border border-danger-border bg-danger-surface p-3 text-danger">{error}</p>
      )}

      {draft && (
        <section data-testid="automation-form" className="mb-8 max-w-[880px] space-y-4 rounded-compose border border-border bg-surface-raised p-4">
          <Field label={t('automations.form.name')}>
            <TextInput value={draft.name} onChange={(name) => setDraft({ ...draft, name })}
              placeholder={t('automations.form.namePlaceholder')} />
          </Field>
          <Field label={t('automations.form.target')} hint={t('automations.form.targetHint')}>
            <Select value={draft.channelId} onChange={(channelId) => setDraft({ ...draft, channelId })} options={targets} />
          </Field>
          <Field label={t('automations.form.body')} hint={t('automations.form.bodyHint')}>
            <textarea
              className="w-full rounded-row border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle"
              rows={3} value={draft.body} placeholder={t('automations.form.bodyPlaceholder')}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>
          <Segmented
            label={t('automations.form.kind')}
            value={draft.kind}
            onChange={(kind) => setDraft({ ...draft, kind: kind as Kind })}
            options={[
              { value: 'schedule', label: t('automations.kind.schedule') },
              { value: 'github', label: t('automations.kind.github') },
              { value: 'webhook', label: t('automations.kind.webhook') },
            ]}
          />
          {draft.kind === 'github' && (
            <>
              <Field label={t('automations.form.repo')}>
                <TextInput value={draft.repo} onChange={(repo) => setDraft({ ...draft, repo })} placeholder="izagood/harkroom" />
              </Field>
              <Field label={t('automations.form.event')}>
                <Select value={draft.event} onChange={(event) => setDraft({ ...draft, event: event as GhEvent })} options={[
                  { value: 'push', label: t('automations.event.push') },
                  { value: 'pull_request.merged', label: t('automations.event.prMerged') },
                  { value: 'release.published', label: t('automations.event.release') },
                  { value: 'workflow_run.completed', label: t('automations.event.workflow') },
                ]} />
              </Field>
              <Field label={t('automations.form.branch')}>
                <TextInput value={draft.branch} onChange={(branch) => setDraft({ ...draft, branch })} placeholder="main" />
              </Field>
              {draft.event === 'push' && (
                <>
                  <Field label={t('automations.form.paths')} hint={t('automations.form.pathsHint')}>
                    <textarea className="w-full rounded-row border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle"
                      rows={2} value={draft.paths} placeholder="packages/agent/src/adapters/*.ts"
                      onChange={(e) => setDraft({ ...draft, paths: e.target.value })} />
                  </Field>
                  <Field label={t('automations.form.change')}>
                    <Select value={draft.change} onChange={(change) => setDraft({ ...draft, change: change as GhChange })} options={[
                      { value: 'any', label: t('automations.change.any') },
                      { value: 'added', label: t('automations.change.added') },
                      { value: 'modified', label: t('automations.change.modified') },
                      { value: 'removed', label: t('automations.change.removed') },
                    ]} />
                  </Field>
                </>
              )}
            </>
          )}
          {draft.kind === 'webhook' && <p className="text-meta text-fg-subtle">{t('automations.form.webhookHint')}</p>}
          {draft.kind !== 'schedule' && (
            <Field label={t('automations.form.debounce')} hint={t('automations.form.debounceHint')}>
              <TextInput value={draft.debounce} onChange={(debounce) => setDraft({ ...draft, debounce })} placeholder="600" />
            </Field>
          )}
          {draft.kind === 'schedule' && <Segmented
            label={t('automations.form.freq')}
            value={draft.freq}
            onChange={(freq) => setDraft({ ...draft, freq: freq as Freq })}
            options={[
              { value: 'daily', label: t('automations.freq.daily') },
              { value: 'weekly', label: t('automations.freq.weekly') },
              { value: 'monthly', label: t('automations.freq.monthly') },
            ]}
          />}
          {draft.kind === 'schedule' && draft.freq === 'weekly' && (
            <div className="flex flex-wrap gap-1" role="group" aria-label={t('automations.form.weekdays')}>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const on = draft.weekdays.includes(d);
                return (
                  <button key={d} type="button" aria-pressed={on} data-testid={`weekday-${d}`}
                    className={`rounded-row border px-2 py-1 ${on ? 'border-accent bg-accent-surface text-accent' : 'border-border text-fg-muted'}`}
                    onClick={() => setDraft({
                      ...draft,
                      weekdays: on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d].sort(),
                    })}
                  >{weekdayName(d, locale)}</button>
                );
              })}
            </div>
          )}
          {draft.kind === 'schedule' && draft.freq === 'monthly' && (
            <Field label={t('automations.form.monthDay')} hint={t('automations.form.monthDayHint')}>
              <TextInput value={draft.monthDay} onChange={(monthDay) => setDraft({ ...draft, monthDay })} />
            </Field>
          )}
          {draft.kind === 'schedule' && <div className="grid grid-cols-2 gap-4">
            <Field label={t('automations.form.time')}>
              <TextInput value={draft.time} onChange={(time) => setDraft({ ...draft, time })} placeholder="09:00" />
            </Field>
            <Field label={t('automations.form.tz')}>
              <TextInput value={draft.tz} onChange={(tz) => setDraft({ ...draft, tz })} placeholder="Europe/Berlin" />
            </Field>
          </div>}
          <div className="flex gap-2">
            <Button variant="primary" disabled={!canSave || busy} onClick={() => void save()}>
              {editingId ? t('automations.form.update') : t('automations.form.create')}
            </Button>
            <Button onClick={() => { setDraft(null); setEditingId(null); }}>{t('automations.form.cancel')}</Button>
          </div>
        </section>
      )}

      {Array.isArray(items) && rows.length === 0 && !draft && (
        <p className="text-fg-subtle">{t('automations.list.empty')}</p>
      )}

      {/* 자동화 하나가 카드 하나 — 넓은 창에서 2·3단 격자(시안 v1 list). 만들기 폼은 form 상한 880 을 지킨다. */}
      <SettingsGrid as="ul" testId="automations-grid">
        {rows.map((a) => (
          <li key={a.id} data-testid="automation-row" className="rounded-compose border border-border bg-surface-raised p-4">
            <div className="flex items-start gap-3">
              <button type="button" data-testid="automation-toggle-details"
                aria-expanded={expanded.has(a.id)} aria-controls={`automation-details-${a.id}`}
                title={expanded.has(a.id) ? t('automations.row.collapse') : t('automations.row.expand')}
                className="flex min-w-0 flex-1 items-start gap-2 rounded-row text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => toggleExpanded(a.id)}>
                <span aria-hidden className={`mt-0.5 inline-block w-3 shrink-0 text-fg-subtle transition-transform ${expanded.has(a.id) ? 'rotate-90' : ''}`}>▸</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-fg">⚡ {a.name}</span>
                  <span data-testid="automation-summary" className="block truncate text-meta text-fg-muted">
                    {describeTrigger(a.trigger, locale, t)} → {targetLabel(a.channelId)}
                    <span className="text-fg-subtle"> · {a.enabled
                      ? t('automations.row.next', { at: fmt(a.nextAt) })
                      : a.pausedReason
                        ? t('automations.row.paused', { reason: runErrorText(a.pausedReason, t) })
                        : t('automations.row.off')}</span>
                  </span>
                  {!a.approvedAt && (
                    <span data-testid="automation-proposal" className="mt-1 block text-meta text-warning">
                      {t('automations.proposal.pending', { who: `@${accounts[a.proposedBy ?? '']?.handle ?? '…'}` })}
                    </span>
                  )}
                </span>
              </button>
              {!a.approvedAt ? (
                <Button variant="primary" disabled={busy}
                  onClick={() => void act(() => getController().api.approveAutomation(a.id), t('automations.proposal.approveFailed'))}>
                  {t('automations.proposal.approve')}
                </Button>
              ) : <label className="flex items-center gap-2 text-meta text-fg-muted">
                <Switch testId="automation-enabled" checked={a.enabled} disabled={busy}
                  onChange={(on) => void act(() => getController().api.updateAutomation(a.id, { enabled: on }), t('automations.form.saveFailed'))} />
                {t('automations.row.enabled')}
              </label>}
            </div>
            {lastRunLine(a)}
            {expanded.has(a.id) && <div id={`automation-details-${a.id}`} data-testid="automation-details">
              <pre className="mt-3 whitespace-pre-wrap rounded-row bg-surface p-2 text-meta text-fg-muted">{a.body}</pre>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button disabled={runState[a.id]?.phase === 'pending'} onClick={() => startRun(a)}>
                  {runState[a.id]?.phase === 'pending'
                    ? <span aria-busy="true" className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin" />{t('automations.row.running')}</span>
                    : t('automations.row.runNow')}
                </Button>
                <Button onClick={() => { setEditingId(a.id); setDraft(triggerToDraft(a)); }}>{t('automations.row.edit')}</Button>
                <Button onClick={() => void openRuns(a.id)}>{t('automations.row.history')}</Button>
                {confirmDelete === a.id ? (
                  <>
                    <Button variant="danger" disabled={busy}
                      onClick={() => void act(() => getController().api.deleteAutomation(a.id), t('automations.row.deleteFailed')).then(() => setConfirmDelete(null))}>
                      {t('automations.row.confirmDelete')}
                    </Button>
                    <Button onClick={() => setConfirmDelete(null)}>{t('automations.form.cancel')}</Button>
                  </>
                ) : (
                  <Button onClick={() => setConfirmDelete(a.id)}>{t('automations.row.delete')}</Button>
                )}
              </div>
              {a.trigger.kind !== 'schedule' && confirmRun !== a.id && unfilledManualVars(a.body, a.trigger).length === 0 && (
                <p data-testid="automation-manual-hint" className="mt-2 text-meta text-fg-muted">{t('automations.row.manualHint')}</p>
              )}
              {runConfirm(a)}
              {runResult(a)}
              {a.trigger.kind !== 'schedule' && (
                <div data-testid="automation-ingress" className="mt-3 rounded-row border border-border p-3 text-meta">
                  <div className="mb-2 text-fg-muted">
                    {a.ingressEnabledAt ? t('automations.ingress.on') : t('automations.ingress.off')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void issue(a.id)}>
                      {a.ingressEnabledAt ? t('automations.ingress.reissue') : t('automations.ingress.enable')}
                    </Button>
                    {a.ingressEnabledAt && (
                      <Button onClick={() => void act(async () => {
                        await getController().api.revokeAutomationIngress(a.id);
                        if (issued?.id === a.id) setIssued(null);
                      }, t('automations.ingress.issueFailed'))}>{t('automations.ingress.disable')}</Button>
                    )}
                  </div>
                  {issued?.id === a.id && (
                    <div data-testid="automation-ingress-key" className="mt-3 space-y-1">
                      <p className="text-warning">{t('automations.ingress.onceWarning')}</p>
                      <pre className="whitespace-pre-wrap break-all rounded-row bg-surface p-2 text-fg">{[
                        issued.ingress.githubPath ? `GitHub webhook URL: ${baseUrl}${issued.ingress.githubPath}` : null,
                        issued.ingress.githubPath ? `Secret: ${issued.ingress.key}` : null,
                        `curl -X POST ${baseUrl}${issued.ingress.genericPath} -H 'Authorization: Bearer ${issued.ingress.key}' -H 'Content-Type: application/json' -d '{}'`,
                      ].filter(Boolean).join('\n')}</pre>
                      {issued.ingress.githubPath && <p className="text-fg-subtle">{t('automations.ingress.githubHint')}</p>}
                    </div>
                  )}
                </div>
              )}
              {runsFor?.id === a.id && (
                <table data-testid="automation-runs" className="mt-3 w-full text-meta">
                  <tbody>
                    {runsFor.runs.length === 0 && (
                      <tr><td className="text-fg-subtle">{t('automations.runs.empty')}</td></tr>
                    )}
                    {runsFor.runs.map((r) => (
                      <tr key={r.id} data-testid="automation-run-row"
                        className={`border-t border-border${runState[a.id]?.runId === r.id ? ' bg-surface-sunken' : ''}`}>
                        <td className="py-1 pr-3 text-fg-muted">{fmt(r.createdAt)}</td>
                        <td className="py-1 pr-3">
                          {runTriggerText(r.triggerKind, t)}
                          {r.initiatedBy && (
                            // 에이전트가 돌린 회차(082). 원인 메시지는 링크 글자로 hover 에 둔다 —
                            // 설정 화면에서 채널로 건너가는 길은 이 화면에 아직 없다.
                            <span
                              data-testid="automation-run-initiator"
                              className="ml-1 text-fg-muted"
                              title={r.causeMessageId ? t('automations.runs.causeTooltip', { link: `harkroom://message/${r.causeMessageId}` }) : undefined}
                            >{t('automations.runs.byAgent', { who: `@${accounts[r.initiatedBy]?.handle ?? '…'}` })}</span>
                          )}
                        </td>
                        <td className={`py-1 pr-3 ${r.status === 'failed' ? 'text-danger' : r.status === 'sent' ? 'text-success' : 'text-fg'}`}>{runStatusText(r.status, t)}</td>
                        <td className="py-1 pr-3">{r.status === 'sent' ? openMessageLink(r.messageId, t('automations.row.openMessage'), 'automation-run-open-row') : null}</td>
                        <td className="py-1 text-fg-subtle">{r.error ? runErrorText(r.error, t) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>}
          </li>
        ))}
      </SettingsGrid>
    </SettingsPage>
  );
}

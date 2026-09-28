import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutomationGithubTrigger, AutomationRunView, AutomationTrigger, AutomationView } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Button, Field, Segmented, Select, SettingsPage, TextInput } from './primitives';
import { useLocale, useT } from '../../i18n/useT';
import { describeTrigger, localTimeZone, weekdayName } from '../../lib/automation';

/**
 * 자동화(064) — "무슨 일이 생기면 → **내 이름으로** 정한 채널/DM 에 이 글을 쓴다".
 *
 * 액션이 글 한 줄인 이유는 서버 마이그레이션 주석에 있다: 글이 `postMessage` 를 그대로
 * 지나야 멘션·턴·진행 표시가 사람이 친 것과 똑같이 따라온다. 그래서 이 화면이 받는 것도
 * 결국 **본문**이고, 에이전트를 부르려면 본문 맨 앞에 `@handle` 을 쓴다.
 *
 * 만든 사람만 본다(서버가 `owner_id` 로 거른다). 남의 자동화가 이 목록에 없는 것은 결함이 아니다.
 */

type Kind = AutomationTrigger['kind'];
type Freq = 'daily' | 'weekly' | 'monthly';
type GhEvent = AutomationGithubTrigger['event'];
type GhChange = NonNullable<AutomationGithubTrigger['change']>;

interface Draft {
  name: string; channelId: string; body: string; kind: Kind;
  freq: Freq; weekdays: number[]; monthDay: string; time: string; tz: string;
  repo: string; event: GhEvent; branch: string; paths: string; change: GhChange;
}

const emptyDraft = (): Draft => ({
  name: '', channelId: '', body: '', kind: 'schedule',
  freq: 'weekly', weekdays: [1], monthDay: '1', time: '09:00', tz: localTimeZone(),
  repo: '', event: 'push', branch: 'main', paths: '', change: 'any',
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
  const base = { ...emptyDraft(), name: a.name, channelId: a.channelId, body: a.body, kind: t.kind };
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

export function AutomationsSettings() {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const input = { name: draft.name.trim(), channelId: draft.channelId, body: draft.body, trigger: draftToTrigger(draft) };
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

  const canSave = !!draft && draft.name.trim() !== '' && draft.channelId !== '' && draft.body.trim() !== ''
    && (draft.kind !== 'schedule' || (/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) && draft.tz.trim() !== ''
      && (draft.freq !== 'weekly' || draft.weekdays.length > 0)))
    && (draft.kind !== 'github' || /^[\w.-]+\/[\w.-]+$/.test(draft.repo.trim()));


  const rows = Array.isArray(items) ? items : [];
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale || undefined) : '—');

  return (
    <SettingsPage title={t('automations.title')} description={t('automations.subtitle')}>
      <div className="mb-6 flex items-center gap-2">
        <Button variant="primary" disabled={draft !== null}
          onClick={() => { setEditingId(null); setDraft({ ...emptyDraft(), channelId: targets[0]?.value ?? '' }); }}>
          {t('automations.list.new')}
        </Button>
        {items === null && <span className="text-fg-subtle">{t('automations.list.loading')}</span>}
      </div>

      {items === 'error' && (
        <p role="alert" className="mb-6 rounded-lg border border-danger-border bg-danger-surface p-3 text-danger">
          {t('automations.list.loadFailed')}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-6 rounded-lg border border-danger-border bg-danger-surface p-3 text-danger">{error}</p>
      )}

      {draft && (
        <section data-testid="automation-form" className="mb-8 space-y-4 rounded-xl border border-border bg-surface-raised p-4">
          <Field label={t('automations.form.name')}>
            <TextInput value={draft.name} onChange={(name) => setDraft({ ...draft, name })}
              placeholder={t('automations.form.namePlaceholder')} />
          </Field>
          <Field label={t('automations.form.target')} hint={t('automations.form.targetHint')}>
            <Select value={draft.channelId} onChange={(channelId) => setDraft({ ...draft, channelId })} options={targets} />
          </Field>
          <Field label={t('automations.form.body')} hint={t('automations.form.bodyHint')}>
            <textarea
              className="w-full rounded border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle"
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
                    <textarea className="w-full rounded border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle"
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
                    className={`rounded border px-2 py-1 ${on ? 'border-accent bg-accent-surface text-accent' : 'border-border text-fg-muted'}`}
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
              <TextInput value={draft.tz} onChange={(tz) => setDraft({ ...draft, tz })} placeholder="Asia/Seoul" />
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

      <ul className="space-y-3">
        {rows.map((a) => (
          <li key={a.id} data-testid="automation-row" className="rounded-xl border border-border bg-surface-raised p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-fg">⚡ {a.name}</div>
                <div className="text-fg-muted">{describeTrigger(a.trigger, locale, t)} → {targetLabel(a.channelId)}</div>
                <div className="text-meta text-fg-subtle">
                  {a.enabled
                    ? t('automations.row.next', { at: fmt(a.nextAt) })
                    : a.pausedReason
                      ? t('automations.row.paused', { reason: a.pausedReason })
                      : t('automations.row.off')}
                </div>
              </div>
              <label className="flex items-center gap-2 text-meta text-fg-muted">
                <input type="checkbox" role="switch" data-testid="automation-enabled" checked={a.enabled} disabled={busy}
                  onChange={(e) => void act(() => getController().api.updateAutomation(a.id, { enabled: e.target.checked }), t('automations.form.saveFailed'))} />
                {t('automations.row.enabled')}
              </label>
            </div>
            <pre className="mt-2 whitespace-pre-wrap rounded bg-surface p-2 text-meta text-fg-muted">{a.body}</pre>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void act(() => getController().api.runAutomation(a.id), t('automations.row.runFailed'))}>
                {t('automations.row.runNow')}
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
            {runsFor?.id === a.id && (
              <table data-testid="automation-runs" className="mt-3 w-full text-meta">
                <tbody>
                  {runsFor.runs.length === 0 && (
                    <tr><td className="text-fg-subtle">{t('automations.runs.empty')}</td></tr>
                  )}
                  {runsFor.runs.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-1 pr-3 text-fg-muted">{fmt(r.createdAt)}</td>
                      <td className="py-1 pr-3">{r.triggerKind}</td>
                      <td className={`py-1 pr-3 ${r.status === 'failed' ? 'text-danger' : 'text-fg'}`}>{r.status}</td>
                      <td className="py-1 text-fg-subtle">{r.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ul>
    </SettingsPage>
  );
}

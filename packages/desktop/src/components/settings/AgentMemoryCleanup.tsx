import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { dayLabel } from '../../lib/day';
import { MAX_ARCHIVED_MEMORIES } from '../../lib/memoryList';
import {
  ARCHIVE_NEAR, pausedKinds, windowText,
  type AgentBackground, type AgentCleanup, type BackgroundChange, type BackgroundRun, type RevertResult,
} from '../../lib/memoryCleanupSettings';
import type { Locale, Translate } from '../../i18n';
import { useLocale, useT } from '../../i18n/useT';
import { Button, Emphasis, Switch } from './primitives';

type Data = { cleanup: AgentCleanup; bg: AgentBackground };

/** 정리 기록의 시각 — 늘 24시간제. 그제부터는 월·일, 해가 다르면 연도까지 적는다. */
function whenLabel(iso: string, locale: Locale): string {
  const now = new Date();
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = d >= yesterday ? dayLabel(iso, locale, now) : new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  }).format(d);
  return `${day} ${time}`;
}

/** 줄 머리에 설 때만 첫 글자를 대문자로(en 의 today·yesterday). */
const lineHead = (s: string, locale: Locale) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);

function reasonText(t: Translate, reason: string): string {
  switch (reason) {
    case 'changed_since': return t('memoryCleanup.rv.changed_since');
    case 'gone': return t('memoryCleanup.rv.gone');
    case 'too_many': return t('memoryCleanup.rv.too_many');
    default: return t('memoryCleanup.rv.error');
  }
}

function opText(t: Translate, op: BackgroundChange['ops'][number]): string {
  switch (op) {
    case 'create': return t('memoryCleanup.op.create');
    case 'update': return t('memoryCleanup.op.update');
    case 'archive': return t('memoryCleanup.op.archive');
    case 'merge': return t('memoryCleanup.op.merge');
  }
}

/** 회차 한 줄의 글. 서버 오류 글은 그대로 싣지 않는다. */
function runText(t: Translate, r: BackgroundRun): { text: string; warn: boolean } {
  if (r.status === 'queued') return { text: t('memoryCleanup.ag.queued'), warn: false };
  if (r.status === 'running') return { text: t('memoryCleanup.ag.running'), warn: false };
  const parts: string[] = [];
  if (r.status === 'failed') parts.push(t('memoryCleanup.ag.failed'));
  else if (r.status === 'skipped') parts.push(t(r.error === 'expired' ? 'memoryCleanup.ag.expired' : 'memoryCleanup.ag.skipped'));
  if (r.status === 'done' || r.changes > 0) parts.push(t('memoryCleanup.ag.changed', { n: r.changes }));
  if (r.summary) parts.push(r.summary);
  return { text: parts.join(' · '), warn: r.status === 'failed' || r.status === 'skipped' };
}

const CHIP = 'rounded-sm border border-border px-1 text-meta font-normal text-fg-muted';
const WARN_CHIP = 'rounded-sm border border-warning-border bg-warning-surface px-1 text-meta text-warning';
const SMALL = 'rounded-row border border-border bg-surface px-2 text-meta text-fg-muted disabled:opacity-50';

/**
 * 에이전트 › 기억의 「자동 정리」 카드 — 스위치 둘(매일 정리 / 증류·구조 정리)과 정리 기록·되돌리기.
 * 부르는 쪽이 `key={agentId}` 로 세워 다른 에이전트의 늦은 답이 섞이지 않게 한다.
 * 매일 정리 설정이 없는 옛 서버(404)에서는 카드를 그리지 않는다.
 */
export function AgentMemoryCleanup({ agentId, harness, apiKey, archived, onReverted }: {
  agentId: string; harness: string; apiKey: boolean; archived: number; onReverted(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const ids = useId();
  const [data, setData] = useState<Data | 'loading' | 'failed' | 'unsupported'>('loading');
  const [busy, setBusy] = useState<'daily' | 'bg' | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const read = useCallback((quiet: boolean) => {
    if (!quiet) setData('loading');
    void Promise.resolve()
      .then(async () => {
        const c = getController();
        const [cleanup, bg] = await Promise.all([c.agentMemoryCleanup(agentId), c.agentBackground(agentId)]);
        setData({ cleanup, bg });
      })
      .catch((e: unknown) => {
        if (!quiet) setData(e instanceof ApiError && e.status === 404 ? 'unsupported' : 'failed');
      });
  }, [agentId]);
  useEffect(() => read(false), [read]);

  if (data === 'unsupported') return null;
  const ready = typeof data === 'object' ? data : null;
  const ws = ready?.cleanup.workspace;

  const set = (which: 'daily' | 'bg', on: boolean) => {
    if (!ready) return;
    const apply = (v: boolean) => setData((d) => (typeof d !== 'object' ? d : which === 'daily'
      ? { ...d, cleanup: { ...d.cleanup, enabled: v } } : { ...d, bg: { ...d.bg, enabled: v } }));
    setBusy(which); setSaveFailed(false); apply(on);
    const c = getController();
    void (which === 'daily' ? c.setAgentMemoryCleanup(agentId, on) : c.setAgentBackground(agentId, on))
      .catch(() => { apply(!on); setSaveFailed(true); })
      .finally(() => setBusy(null));
  };

  let body: ReactNode;
  if (data === 'loading') {
    body = <p className="border-t border-border px-3 py-2 text-meta text-fg-subtle">{t('memoryCleanup.loading')}</p>;
  } else if (!ready) {
    body = (
      <div className="space-y-2 border-t border-border px-3 py-2">
        <p role="alert" className="text-meta text-danger">{t('memoryCleanup.ag.loadFailed')}</p>
        <button className={SMALL} onClick={() => read(false)}>{t('memoryCleanup.retry')}</button>
      </div>
    );
  } else {
    const { cleanup, bg } = ready;
    const blocked = harness !== 'claude-code' ? t('memoryCleanup.ag.notHarness', { harness })
      : apiKey ? t('memoryCleanup.ag.notApiKey') : null;
    const last = bg.runs.find((r) => r.kind === 'cleanup' && r.status === 'done');
    const paused = pausedKinds(bg.paused);
    const dailyWarn = blocked ?? (cleanup.enabled && ws?.enabled === false ? t('memoryCleanup.ag.wsOff') : null);
    body = (
      <>
        <div className="flex items-start gap-3 border-t border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-fg">{t('memoryCleanup.ag.daily')} <span className={CHIP}>{t('memoryCleanup.ag.dailyVerb')}</span></div>
            <div id={`${ids}d`} className="text-meta text-fg-subtle">
              <div>{t(cleanup.enabled ? 'memoryCleanup.ag.dailyDesc' : 'memoryCleanup.ag.offDesc')}</div>
              {dailyWarn && <div className="text-warning">{dailyWarn}</div>}
              {last && (
                <div>
                  {t('memoryCleanup.ag.dailyLast', {
                    when: whenLabel(last.finishedAt ?? last.createdAt, locale),
                    changes: t('memoryCleanup.ag.changed', { n: last.changes }),
                  })}
                </div>
              )}
            </div>
          </div>
          <Switch
            testId="agent-memory-cleanup"
            ariaLabel={t('memoryCleanup.ag.daily')}
            ariaDescribedBy={`${ids}d`}
            checked={cleanup.enabled}
            disabled={busy !== null || blocked !== null}
            onChange={(v) => set('daily', v)}
            className={blocked ? 'mt-0.5 opacity-50' : 'mt-0.5'}
          />
        </div>
        <div className="flex items-start gap-3 border-t border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-fg">{t('memoryCleanup.ag.bg')} <span className={CHIP}>{t('memoryCleanup.ag.bgVerb')}</span></div>
            <div id={`${ids}b`} className="text-meta text-fg-subtle">
              <div>{t('memoryCleanup.ag.bgDesc')}</div>
              {blocked && <div className="text-warning">{blocked}</div>}
              {!blocked && !bg.serverEnabled && (
                <>
                  <div className="text-warning">{t('memoryCleanup.ag.bgServerOff')}</div>
                  <div>{t('memoryCleanup.ag.bgServerOffDaily')}</div>
                </>
              )}
              {!blocked && bg.serverEnabled && paused.length > 0 && (
                <>
                  {paused.includes('distill') && <div className="text-warning">{t('memoryCleanup.ag.pausedDistill')}</div>}
                  {paused.includes('organize') && <div className="text-warning">{t('memoryCleanup.ag.pausedOrganize')}</div>}
                  <div>
                    {t(paused.length === 2 ? 'memoryCleanup.ag.pausedBothNote'
                      : paused[0] === 'distill' ? 'memoryCleanup.ag.pausedDistillNote' : 'memoryCleanup.ag.pausedOrganizeNote')}
                  </div>
                </>
              )}
            </div>
          </div>
          <Switch
            testId="agent-background"
            ariaLabel={t('memoryCleanup.ag.bg')}
            ariaDescribedBy={`${ids}b`}
            checked={bg.enabled}
            disabled={busy !== null || blocked !== null || !bg.serverEnabled}
            onChange={(v) => set('bg', v)}
            className={blocked || !bg.serverEnabled ? 'mt-0.5 opacity-50' : 'mt-0.5'}
          />
        </div>
        {saveFailed && <p role="alert" className="border-t border-border px-3 py-2 text-meta text-danger">{t('memoryCleanup.ag.saveFailed')}</p>}
        <div className="flex flex-wrap gap-2 border-t border-border bg-surface px-3 py-1 text-meta">
          <span className="font-medium text-fg-muted">{t('memoryCleanup.ag.history')}</span>
          <span className="text-fg-subtle">{t('memoryCleanup.ag.historyNote')}</span>
        </div>
        {bg.runs.length === 0 && <p className="border-t border-border px-3 py-2 text-meta text-fg-muted">{t('memoryCleanup.ag.noRuns')}</p>}
        <div className="max-h-80 overflow-y-auto">
          {bg.runs.map((r) => (
            <RunRow key={r.id} agentId={agentId} run={r} onReverted={() => { read(true); onReverted(); }} />
          ))}
        </div>
      </>
    );
  }

  return (
    <section data-testid="agent-memory-cleanup-card" aria-label={t('memoryCleanup.ag.title')} className="mt-2 rounded-row border border-border bg-surface-raised">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-meta">
        <span className="font-medium text-fg-muted">{t('memoryCleanup.ag.title')}</span>
        {ws?.enabled && (
          <span className="text-fg-subtle">{t('memoryCleanup.ag.wsLine', { window: windowText(ws.time), tz: ws.tz })}</span>
        )}
      </div>
      {archived > ARCHIVE_NEAR && (
        <p data-testid="memory-archive-near" className="border-t border-warning-border bg-warning-surface px-3 py-1.5 text-meta text-warning tabular-nums">
          <Emphasis text={t('memoryCleanup.ag.archiveNear', { n: archived, max: MAX_ARCHIVED_MEMORIES })} part={`${archived}/${MAX_ARCHIVED_MEMORIES}`} />
        </p>
      )}
      {body}
    </section>
  );
}

function RunRow({ agentId, run, onReverted }: { agentId: string; run: BackgroundRun; onReverted(): void }) {
  const t = useT();
  const locale = useLocale();
  const [changes, setChanges] = useState<BackgroundChange[] | 'loading' | 'failed' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RevertResult | null>(null);
  const [error, setError] = useState<'already_reverted' | 'not_finished' | 'failed' | null>(null);
  const line = runText(t, run);
  const finished = run.status !== 'queued' && run.status !== 'running';
  const reverted = run.revertedAt !== null || result !== null;

  const view = () => {
    if (changes !== null) { setChanges(null); return; }
    setChanges('loading');
    void getController().agentBackgroundRun(agentId, run.id).then(setChanges).catch(() => setChanges('failed'));
  };
  const revert = () => {
    setBusy(true); setError(null);
    void getController().revertAgentBackgroundRun(agentId, run.id)
      .then((r) => { setResult(r); setConfirming(false); onReverted(); })
      .catch((e: unknown) => {
        const code = e instanceof ApiError ? e.code : '';
        setError(code === 'already_reverted' || code === 'not_finished' ? code : 'failed');
        setConfirming(false);
      })
      .finally(() => setBusy(false));
  };
  const counts = result && t('memoryCleanup.rv.done', { n: result.reverted.length, m: result.skipped.length });

  return (
    <div data-testid={`memory-run-${run.id}`} className="border-t border-border px-3 py-1.5 text-meta">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-24 text-fg-subtle">{lineHead(whenLabel(run.finishedAt ?? run.createdAt, locale), locale)}</span>
        <span className="font-medium">{t(run.kind === 'cleanup' ? 'memoryCleanup.ag.daily' : 'memoryCleanup.ag.bg')}</span>
        <span className={`min-w-36 flex-1 break-words ${line.warn ? 'text-warning' : 'text-fg-muted'}`}>{line.text}</span>
        {(run.changes > 0 || reverted) && (
          <span className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-2">
            {run.changes > 0 && <button className={SMALL} aria-expanded={changes !== null} onClick={view}>{t('memoryCleanup.ag.view')}</button>}
            {reverted
              ? <span className="text-fg-subtle">{counts ? `${t('memoryCleanup.ag.reverted')} · ${counts}` : t('memoryCleanup.ag.reverted')}</span>
              : (
                <button className={SMALL} disabled={!finished || busy || confirming} onClick={() => setConfirming(true)}>
                  {t('memoryCleanup.ag.revert')}
                </button>
              )}
          </span>
        )}
      </div>
      {confirming && (
        <div className="mt-1 space-y-1.5 rounded-row border border-warning-border bg-warning-surface px-2 py-1.5 text-warning">
          <p>{t('memoryCleanup.rv.confirm', { n: run.changes })}</p>
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={revert}>{t('memoryCleanup.ag.revert')}</Button>
            <Button disabled={busy} onClick={() => setConfirming(false)}>{t('memoryCleanup.rv.cancel')}</Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-warning">
          {t(error === 'already_reverted' ? 'memoryCleanup.rv.already' : error === 'not_finished' ? 'memoryCleanup.rv.running' : 'memoryCleanup.rv.failed')}
        </p>
      )}
      {result && (result.skipped.length === 0
        ? <p role="status" className="mt-1 text-fg-muted">{t('memoryCleanup.rv.doneAll', { n: result.reverted.length })}</p>
        : (
          <div role="status" className="mt-1 space-y-0.5 text-fg-muted">
            {result.skipped.map((s) => (
              <div key={s.slug}><span className="font-mono">{s.slug}</span> <span className={WARN_CHIP}>{reasonText(t, s.reason)}</span></div>
            ))}
            <p className="text-fg-subtle">{t('memoryCleanup.rv.skipHelp')}</p>
          </div>
        ))}
      {changes === 'loading' && <p className="mt-1 text-fg-subtle">{t('memoryCleanup.loading')}</p>}
      {changes === 'failed' && <p role="alert" className="mt-1 text-danger">{t('memoryCleanup.viewFailed')}</p>}
      {Array.isArray(changes) && (
        <ul className="mt-1 space-y-0.5">
          {changes.map((c) => (
            <li key={c.slug}><span className="font-mono">{c.slug}</span> {c.ops.map((o, i) => <span key={i} className={`${CHIP} mr-1`}>{opText(t, o)}</span>)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

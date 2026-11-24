import { useCallback, useEffect, useId, useState } from 'react';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { nextWindow, timeZones, validTime, validTz, type CleanupSchedule } from '../../lib/memoryCleanupSettings';
import { useLocale, useT } from '../../i18n/useT';
import { Button, SettingsGroup, Switch } from './primitives';

type Load = CleanupSchedule | 'loading' | 'failed' | 'unsupported';

/**
 * 설정 › 일반 「매일 기억 정리」. 스위치는 바로 저장하고 시각·시간대는 [저장]으로만 나간다(잘못된 값이 바로 나가지 않게).
 * 스위치는 저장된 시각·시간대로 보낸다 — 적던 값이 함께 나가지 않는다.
 * 이 설정이 없는 옛 서버(404)에서는 묶음을 그리지 않는다.
 */
export function WorkspaceMemoryCleanup({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const locale = useLocale();
  const ids = useId();
  const [load, setLoad] = useState<Load>('loading');
  const [time, setTime] = useState('');
  const [tz, setTz] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<'bad_time' | 'bad_tz' | 'rejected' | 'failed' | null>(null);

  const read = useCallback(() => {
    if (!isAdmin) return;
    setLoad('loading');
    void Promise.resolve()
      .then(() => getController().memoryCleanupSchedule())
      .then((s) => { setLoad(s); setTime(s.time); setTz(s.tz); })
      .catch((e: unknown) => setLoad(e instanceof ApiError && e.status === 404 ? 'unsupported' : 'failed'));
  }, [isAdmin]);
  useEffect(read, [read]);

  if (load === 'unsupported') return null;
  const title = t('memoryCleanup.ws.title');
  if (!isAdmin) {
    return <SettingsGroup title={title}><p className="px-4 py-3 text-fg-muted">{t('memoryCleanup.ws.adminOnly')}</p></SettingsGroup>;
  }
  if (load === 'loading') {
    return <SettingsGroup title={title}><p className="px-4 py-3 text-fg-subtle">{t('memoryCleanup.loading')}</p></SettingsGroup>;
  }
  if (load === 'failed') {
    return (
      <SettingsGroup title={title}>
        <div className="space-y-2 px-4 py-3">
          <p role="alert" className="text-danger">{t('memoryCleanup.ws.loadFailed')}</p>
          <Button onClick={read}>{t('memoryCleanup.retry')}</Button>
        </div>
      </SettingsGroup>
    );
  }

  const put = (next: CleanupSchedule, fields: boolean) => {
    const before = load;
    setBusy(true); setSaved(false); setError(null);
    if (!fields) setLoad(next);
    void getController().setMemoryCleanupSchedule(next)
      .then((s) => {
        setLoad(s);
        setSaved(true);
        if (fields) { setTime(s.time); setTz(s.tz); }
      })
      .catch((e: unknown) => {
        setLoad(before);
        const code = e instanceof ApiError ? e.code : '';
        setError(!fields ? 'failed' : code === 'bad_time' || code === 'bad_tz' ? code
          : e instanceof ApiError && e.status === 400 ? 'rejected' : 'failed');
      })
      .finally(() => setBusy(false));
  };

  const timeBad = !validTime(time);
  const tzBad = tz !== load.tz && !validTz(tz);
  const dirty = time !== load.time || tz !== load.tz;
  const next = load.enabled ? nextWindow(load, Date.now()) : null;
  const when = next && `${new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(next.day)} ${next.text}`;
  const input = (bad: boolean) => `rounded-row border bg-surface px-2 py-1 text-body text-fg ${bad ? 'border-danger-border' : 'border-border'}`;
  const edited = () => { setSaved(false); setError(null); };
  const tzError = tzBad || error === 'bad_tz';
  const timeError = timeBad || error === 'bad_time';

  return (
    <SettingsGroup
      title={title}
      action={saved ? <span role="status" className="text-meta text-fg-muted">{t('memoryCleanup.saved')}</span> : undefined}
    >
      <label className="flex items-start gap-4 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-fg">{title}</span>
          <span id={`${ids}d`} className="mt-0.5 block text-fg-subtle">
            {t(load.enabled ? 'memoryCleanup.ws.toggleDesc' : 'memoryCleanup.ws.offDesc')}
          </span>
        </span>
        <Switch
          testId="ws-memory-cleanup"
          ariaLabel={title}
          ariaDescribedBy={`${ids}d`}
          checked={load.enabled}
          disabled={busy}
          onChange={(enabled) => put({ ...load, enabled }, false)}
          className="mt-0.5"
        />
      </label>
      <div className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-meta text-fg-muted">
            {t('memoryCleanup.ws.time')}
            <input
              className={`${input(timeError)} w-24`}
              value={time}
              aria-invalid={timeError}
              onChange={(e) => { edited(); setTime(e.target.value.trim()); }}
            />
          </label>
          <label className="flex min-w-44 flex-1 flex-col gap-1 text-meta text-fg-muted">
            {t('memoryCleanup.ws.tz')}
            <input
              className={input(tzError)}
              value={tz}
              list={`${ids}z`}
              aria-invalid={tzError}
              onChange={(e) => { edited(); setTz(e.target.value.trim()); }}
            />
            <span className="text-fg-subtle">{t('memoryCleanup.ws.tzHint')}</span>
          </label>
          <datalist id={`${ids}z`}>{timeZones().map((z) => <option key={z} value={z} />)}</datalist>
        </div>
        {timeBad && <p className="text-meta text-danger">{t('memoryCleanup.ws.timeBad')}</p>}
        {tzBad && <p className="text-meta text-danger">{t('memoryCleanup.ws.tzBad')}</p>}
        {error && (
          <p role="alert" className="text-meta text-danger">
            {t(error === 'failed' ? 'memoryCleanup.ag.saveFailed' : 'memoryCleanup.ws.saveRejected')}
          </p>
        )}
        {dirty && (
          <Button variant="primary" disabled={busy || timeBad || tzBad} onClick={() => put({ ...load, time, tz }, true)}>
            {t('memoryCleanup.save')}
          </Button>
        )}
        {!load.enabled && <p className="text-meta text-fg-subtle">{t('memoryCleanup.ws.offFields')}</p>}
      </div>
      {next && when && (
        <p data-testid="ws-memory-cleanup-next" className="px-4 py-2 text-meta text-fg-muted">
          {next.local
            ? t('memoryCleanup.ws.nextOther', { when, local: next.local })
            : t('memoryCleanup.ws.next', { when, tz: load.tz })}
        </p>
      )}
      <ul className="list-disc space-y-0.5 py-2 pr-4 pl-8 text-meta text-fg-muted">
        <li>{t('memoryCleanup.f.spread')}</li>
        <li>{t('memoryCleanup.f.offline')}</li>
        <li>{t('memoryCleanup.f.skip')}</li>
        <li>{t('memoryCleanup.f.scope')}</li>
        <li>{t('memoryCleanup.f.result')}</li>
      </ul>
      <p className="px-4 py-2 text-meta text-fg-subtle">{t('memoryCleanup.ws.perAgent')}</p>
    </SettingsGroup>
  );
}

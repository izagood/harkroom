/**
 * 설정 › 이 기기 › **작업 폴더 정리**(스레드 9e909150, designer 시안 v3 확정판).
 *
 * 원장은 이 기기 오퍼레이터의 것이다(`operator/src/workspaceCleanup.ts`). 이 화면은 읽고, 켜고 끄고, N일을 바꾸고, 보존·되돌리기·
 * 삭제 예정에 넣기만 한다. **누르는 즉시 지우는 버튼은 없다**(D3·D5) — 지우기는 청소기 회차가 지우기 직전 검사를 거쳐서만 한다.
 *
 * 보존·넣기는 확인 창 없이 바로 된다 — 되돌릴 수 있는 일이다. ⚠ 이유는 툴팁이 아니라 글로 쓴다. `turn-running` 은 ⚠ 가 아니라
 * 「미룸」이다(사람이 할 일이 없고 곧 풀린다 — 이것까지 세면 목차의 ⚠ 숫자가 늘 떠 있어 아무도 보지 않게 된다).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CleanupBlockReason, CleanupItem } from '@harkroom/shared/workspaceCleanup';
import { useActiveStore } from '../../state/communities';
import { getController } from '../../state/controller';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n';
import {
  actWorkspaceCleanup, getWorkspaceCleanup, hasOperatorLocalSurface, setWorkspaceCleanupSettings,
  type WorkspaceCleanupView,
} from '../../lib/operatorLocal';
import { buildCleanupModel, dueTodayIf, formatBytes, isWarn, nextSweepAt, type DeferReason, type ThreadRow } from '../../lib/workspaceCleanupView';
import { SettingsGroup, SettingsPage, Toggle } from './primitives';

const REASON_KEY: Record<CleanupBlockReason, MessageKey> = {
  uncommitted: 'cleanup.reason.uncommitted',
  unpushed: 'cleanup.reason.unpushed',
  'turn-running': 'cleanup.reason.turnRunning',
};
const DEFER_KEY: Record<DeferReason, MessageKey> = {
  'turn-running': 'cleanup.reason.turnRunning',
  'runner-off': 'cleanup.reason.runnerOff',
};

const DAY = 86_400_000;
const fmtTime = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** 화면에 보이는 경로는 홈을 `~` 로 줄인다(복사는 원래 경로). */
const shortPath = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
const fmtDay = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`; };

export function WorkspaceCleanupSettings({ onGoToThread, now: nowProp }: {
  /** 스레드로 간다 — 설정을 닫고 그 스레드를 연다. 없으면 링크 대신 글이다. */
  onGoToThread?: (channelId: string, threadRootId: string) => void;
  /** 시험용 시계. */
  now?: Date;
} = {}) {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const channels = useActiveStore((s) => s.channels);
  const accounts = useActiveStore((s) => s.accounts);
  const available = hasOperatorLocalSurface();
  const [view, setView] = useState<WorkspaceCleanupView | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const now = nowProp ?? new Date();

  const load = useCallback(async () => {
    try { setView(await getWorkspaceCleanup()); } catch { setView('error'); }
  }, []);
  useEffect(() => { if (available) void load(); }, [available, load]);

  const run = async (fn: () => Promise<WorkspaceCleanupView>) => {
    setBusy(true); setError(null);
    try { setView(await fn()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const act = (path: string, action: 'keep' | 'unkeep' | 'list') => {
    if (!me) return;
    void run(() => actWorkspaceCleanup(path, action, me.id));
  };

  const model = useMemo(() => (typeof view === 'object' ? buildCleanupModel(view.ledger, now, view.live ?? null) : null), [view, now]);

  // 스레드 첫 줄 — 줄의 제목. 목록에 보이는 스레드만, 한 번씩 읽는다.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const rootIds = useMemo(() => [...new Set([
    ...[...(model?.listed ?? []), ...(model?.kept ?? [])].flatMap((r) => (r.thread ? [r.thread.threadRootId] : [])),
    ...(model?.events.slice(0, 10) ?? []).flatMap((e) => (e.thread ? [e.thread.threadRootId] : [])),
  ])], [model]);
  useEffect(() => {
    const api = getController().api;
    if (!api) return;
    let alive = true;
    for (const id of rootIds) {
      if (titles[id] !== undefined) continue;
      void api.message(id).then((m) => {
        const line = (m.body ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 80);
        if (alive && line) setTitles((prev) => ({ ...prev, [id]: line }));
      }, () => {});
    }
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootIds]);

  if (!available) {
    return <SettingsPage section="workspace-cleanup" description={t('settings.desc.workspace-cleanup')}>
      <p className="text-meta text-fg-muted" data-testid="cleanup-unavailable">{t('cleanup.unavailable')}</p>
    </SettingsPage>;
  }
  if (view === 'loading' || view === 'error' || !model) {
    return <SettingsPage section="workspace-cleanup" description={t('settings.desc.workspace-cleanup')}>
      {view === 'error'
        ? <p role="alert" className="text-meta text-danger" data-testid="cleanup-load-error">{t('cleanup.loadFailed')}</p>
        : <p className="text-meta text-fg-subtle" data-testid="cleanup-loading">{t('cleanup.loading')}</p>}
    </SettingsPage>;
  }

  const { settings, ledger } = view;
  // 꺼져 있으면 청소기가 아무것도 지우지 않는다 — 기한·다음 정리·N일 경고로 "지운다"고 말하지 않는다(designer 수정 1).
  const off = !settings.enabled;
  const next = nextSweepAt(ledger);
  /** 계정 id → 보일 이름. 모르면 null(id 를 화면에 내지 않는다). */
  const whoOf = (id: string | null) => (id ? (id === me?.id ? me?.handle : accounts[id]?.handle) ?? null : null);
  const threadTitle = (rootId: string) => titles[rootId] ?? t('cleanup.threadTitle', { id: rootId.slice(0, 8) });
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? null;
  const daysLeft = (iso: string | null): { text: string; today: boolean } => {
    if (!iso) return { text: '', today: false };
    const ms = Date.parse(iso) - now.getTime();
    if (ms <= 0) return { text: t('cleanup.dueNow'), today: true };
    const d = new Date(iso);
    if (d.toDateString() === now.toDateString()) return { text: t('cleanup.dueToday', { time: fmtTime(next && next > d ? next : d) }), today: true };
    return { text: t('cleanup.dueIn', { n: Math.ceil(ms / DAY), date: fmtDay(iso) }), today: false };
  };
  const setDays = (n: number) => { void run(() => setWorkspaceCleanupSettings({ graceDays: n })); };
  const dueIfLower = (n: number) => (n < settings.graceDays ? dueTodayIf(ledger, n, now) : 0);

  const partLabel = (p: CleanupItem) => t(p.kind === 'worktree' ? 'cleanup.part.worktree' : 'cleanup.part.threadDir');

  const Row = ({ row, kept }: { row: ThreadRow; kept?: boolean }) => {
    const isOpen = open.has(row.key);
    const first = row.parts[0]!;
    const due = daysLeft(row.deleteAfter);
    const chan = row.thread ? channelName(row.thread.channelId) : null;
    // 제목은 스레드 첫 줄이다 — 사람은 경로로 일을 기억하지 않는다. 못 읽었으면(지워진 글·권한) 짧은 id 로.
    const title = row.thread ? threadTitle(row.thread.threadRootId) : shortPath(first.path);
    return (
      <div className={`px-4 py-3 ${row.tone === 'warn' ? 'bg-warning-surface first:rounded-t-compose last:rounded-b-compose' : ''}`} data-testid="cleanup-row" data-tone={row.tone}>
        <div className="flex items-start gap-3">
          <button className="min-w-0 flex-1 text-left" aria-expanded={isOpen}
            onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(row.key)) n.delete(row.key); else n.add(row.key); return n; })}>
            <span className="flex min-w-0 font-medium text-fg">
              <span className="truncate">{title}</span>
              {chan ? <span className="shrink-0 whitespace-pre font-normal text-fg-subtle"> · #{chan}</span> : null}
            </span>
            <span className="mt-0.5 block text-meta text-fg-subtle">
              {row.prNumber !== null ? t(`cleanup.pr.${row.prState ?? 'open'}` as MessageKey, { n: row.prNumber }) : t('cleanup.pr.none')}
              {' · '}{row.parts.map(partLabel).join(' · ')}{' · '}{formatBytes(row.sizeNow)}
              {kept && row.actedAt ? <> {' · '}<span data-testid="cleanup-kept-by">{whoOf(row.actedBy) ? t('cleanup.keptBy', { who: whoOf(row.actedBy)!, date: fmtDay(row.actedAt) }) : t('cleanup.keptAuto', { date: fmtDay(row.actedAt) })}</span></> : null}
            </span>
          </button>
          {!kept && (
            <span className={`shrink-0 text-meta ${row.tone === 'warn' ? 'text-warning' : off ? 'text-fg-subtle' : due.today ? 'font-medium text-accent' : 'text-fg-muted'}`} data-testid="cleanup-due">
              {row.tone === 'warn' ? t('cleanup.stopped') : off ? t('cleanup.offNoDelete') : row.tone === 'deferred' ? t('cleanup.deferred') : row.tone === 'deleting' ? t('cleanup.deleting') : due.text}
            </span>
          )}
          <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
            disabled={busy || !me} data-testid={kept ? 'cleanup-unkeep' : 'cleanup-keep'}
            onClick={() => { for (const p of row.parts) act(p.path, kept ? 'unkeep' : 'keep'); }}>
            {t(kept ? 'cleanup.unkeep' : 'cleanup.keep')}
          </button>
        </div>
        {/* 꺼져 있으면 「미룸」의 이유("다음 정리 때 다시 본다"·"러너가 다시 붙으면 지운다")도 사실이 아니다 — ⚠ 만 남긴다. */}
        {/* 오른쪽 칸은 짧게 두고(제목이 잘리지 않게, designer n1) 긴 설명은 이유 줄 자리로. */}
        {row.tone === 'deleting' && !off && (
          <p className="mt-2 text-meta text-fg-muted" data-testid="cleanup-deleting-note">{t('cleanup.deletingNote')}</p>
        )}
        {row.deferReason && !off && (
          <p className="mt-2 text-meta text-fg-muted" data-testid="cleanup-reason">{t(DEFER_KEY[row.deferReason])}</p>
        )}
        {row.blockReason && !(off && !isWarn(row.blockReason)) && (
          <p className={`mt-2 text-meta ${isWarn(row.blockReason) ? 'text-warning' : 'text-fg-muted'}`} data-testid="cleanup-reason">
            {isWarn(row.blockReason) ? '⚠ ' : ''}{t(REASON_KEY[row.blockReason])}
            {isWarn(row.blockReason) && (
              <span className="ml-2">
                {/* Finder 로 여는 것은 새 프로세스 실행 자리라(#431 회귀선) 이번에는 경로 복사로 둔다 — 후속 후보. */}
                <button className="underline" onClick={() => void navigator.clipboard?.writeText(first.path)}>{t('cleanup.copyPath')}</button>
                {row.thread && onGoToThread && <> · <button className="underline" onClick={() => onGoToThread(row.thread!.channelId, row.thread!.threadRootId)}>{t('cleanup.goToThread')}</button></>}
              </span>
            )}
          </p>
        )}
        {isOpen && (
          <ul className="mt-2 space-y-1 text-meta text-fg-muted" data-testid="cleanup-parts">
            {row.parts.map((p) => (
              <li key={p.path} className="flex gap-2">
                <span className="w-24 shrink-0 text-fg-subtle">{partLabel(p)}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{shortPath(p.path)}</span>
                <span>{formatBytes(p.sizeNow)}</span>
              </li>
            ))}
            {row.parts.filter((p) => p.branch).map((p) => (
              <li key={`b:${p.path}`} className="flex gap-2">
                <span className="w-24 shrink-0 text-fg-subtle">{t('cleanup.part.branch')}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{p.branch}</span>
              </li>
            ))}
            {row.parts.some((p) => p.kind === 'threadDir') && <li className="text-fg-subtle">{t('cleanup.memoryKept')}</li>}
            {row.thread && onGoToThread && (
              <li><button className="underline" onClick={() => onGoToThread(row.thread!.channelId, row.thread!.threadRootId)}>{t('cleanup.goToThread')}</button></li>
            )}
          </ul>
        )}
      </div>
    );
  };

  const firstRun = !settings.enabled && ledger.lastSweepAt === null;
  // 0 인 칸은 소음이라 뺀다(designer n7).
  const { totals } = model;
  const summary = [
    totals.listedCount > 0 ? t('cleanup.summary.listed', { n: totals.listedCount, size: formatBytes(totals.listedBytes) }) : null,
    totals.keptCount > 0 ? t('cleanup.summary.kept', { n: totals.keptCount }) : null,
    totals.unownedCount > 0 ? t('cleanup.summary.unowned', { n: totals.unownedCount, size: formatBytes(totals.unownedBytes) }) : null,
    model.freedLast7Days > 0 ? t('cleanup.summary.freed', { size: formatBytes(model.freedLast7Days) }) : null,
  ].filter((x): x is string => x !== null);
  const graceWarnN = off ? 0 : dueIfLower(settings.graceDays - 1);

  return (
    <SettingsPage section="workspace-cleanup" description={t('settings.desc.workspace-cleanup')}>
      {/* 한국어 설명이 낱말 중간에서 끊기지 않게(designer n3). 경로·제목은 truncate 라 영향 없다. */}
      <div className="break-keep">
      <div className="mb-6 text-meta text-fg-muted" data-testid="cleanup-summary">
        {summary.length > 0 && <p data-testid="cleanup-summary-line">{summary.join(' · ')}</p>}
        <p className={`${summary.length > 0 ? 'mt-1 ' : ''}text-fg-subtle`} data-testid="cleanup-next">
          {off ? t('cleanup.nextOff') : next ? t('cleanup.next', { time: fmtTime(next) }) : t('cleanup.nextUnknown')}
        </p>
      </div>

      <SettingsGroup title={t('cleanup.rules')}>
        <Toggle label={t('cleanup.enabled')} description={t(settings.enabled ? 'cleanup.enabledOn' : 'cleanup.enabledOff')}
          checked={settings.enabled} disabled={busy} onChange={(v) => void run(() => setWorkspaceCleanupSettings({ enabled: v }))} />
        <div className="px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-fg">{t('cleanup.graceDays')}</span>
              <span className="mt-0.5 block text-fg-subtle">{t('cleanup.graceDaysHint')}</span>
            </span>
            <div className="flex items-center gap-1" data-testid="cleanup-grace">
              <button className="h-6 w-6 rounded-row border border-border disabled:opacity-50" aria-label={t('cleanup.graceLess')}
                disabled={busy || settings.graceDays <= 1} onClick={() => setDays(settings.graceDays - 1)}>−</button>
              <span className="w-12 text-center tabular-nums" data-testid="cleanup-grace-value">{t('cleanup.days', { n: settings.graceDays })}</span>
              <button className="h-6 w-6 rounded-row border border-border disabled:opacity-50" aria-label={t('cleanup.graceMore')}
                disabled={busy || settings.graceDays >= 30} onClick={() => setDays(settings.graceDays + 1)}>+</button>
            </div>
          </div>
          {graceWarnN > 0 && (
            <p className="mt-2 text-meta text-fg-subtle" data-testid="cleanup-grace-warn">{t('cleanup.graceWarn', { n: graceWarnN })}</p>
          )}
        </div>
      </SettingsGroup>
      {firstRun && <p className="-mt-6 mb-8 text-meta text-fg-subtle" data-testid="cleanup-first-run">{t('cleanup.firstRun', { n: model.totals.unownedCount })}</p>}

      {error && <p role="alert" className="mb-4 text-meta text-danger" data-testid="cleanup-error">{error}</p>}

      <SettingsGroup title={t('cleanup.listedTitle', { n: model.totals.listedCount, warn: model.warnCount })}>
        {model.listed.length === 0
          ? <p className="px-4 py-6 text-center text-fg-subtle" data-testid="cleanup-empty">{t('cleanup.empty')}</p>
          : model.listed.map((r) => <Row key={r.key} row={r} />)}
      </SettingsGroup>

      {model.kept.length > 0 && (
        <SettingsGroup title={t('cleanup.keptTitle', { n: model.kept.length })}>
          {model.kept.map((r) => <Row key={r.key} row={r} kept />)}
        </SettingsGroup>
      )}

      {model.unowned.length > 0 && (
        <SettingsGroup title={t('cleanup.unownedTitle', { n: model.unowned.length })}>
          {model.ownersPending && <p className="px-4 pt-2 text-meta text-fg-muted" data-testid="cleanup-owners-pending">{t('cleanup.ownersPending')}</p>}
          <p className="px-4 py-2 text-meta text-fg-subtle">{t('cleanup.unownedHint')}</p>
          {model.unowned.map((u) => (
            <div key={u.path} className="px-4 py-3" data-testid="cleanup-unowned">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-fg">{shortPath(u.path)}</span>
                  <span className="mt-0.5 block text-meta text-fg-subtle">
                    {u.branch ? t('cleanup.branch', { name: u.branch }) : t('cleanup.detached', { sha: (u.headSha ?? '').slice(0, 7) })}
                    {' · '}{u.pr ? t(`cleanup.pr.${u.pr.state}` as MessageKey, { n: u.pr.number }) : t('cleanup.pr.unknown')}
                    {u.lastModifiedAt ? <>{' · '}{t('cleanup.lastModified', { date: fmtDay(u.lastModifiedAt) })}</> : null}
                    {' · '}{formatBytes(u.sizeNow)}
                  </span>
                </span>
                <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
                  disabled={busy || !me} data-testid="cleanup-unowned-keep" onClick={() => act(u.path, 'keep')}>{t('cleanup.keep')}</button>
                <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
                  disabled={busy || !me} data-testid="cleanup-unowned-list" onClick={() => act(u.path, 'list')}>{t('cleanup.list')}</button>
              </div>
              {u.blockReason && isWarn(u.blockReason) && (
                <p className="mt-2 text-meta text-warning" data-testid="cleanup-unowned-warn">⚠ {t('cleanup.unownedWarn')}</p>
              )}
            </div>
          ))}
        </SettingsGroup>
      )}

      {model.events.length > 0 && (
        <SettingsGroup title={t('cleanup.recent')}>
          {model.events.slice(0, 10).map((e, i) => (
            <p key={`${e.at}-${i}`} className="px-4 py-2 text-meta text-fg-muted" data-testid="cleanup-event">
              <span className="mr-2 text-fg-subtle">{fmtDay(e.at)} {fmtTime(new Date(e.at))}</span>
              {t(`cleanup.event.${e.action}` as MessageKey, { name: e.thread ? threadTitle(e.thread.threadRootId) : shortPath(e.path), size: formatBytes(e.bytes) })}
            </p>
          ))}
        </SettingsGroup>
      )}
      </div>
    </SettingsPage>
  );
}

/** 목차의 ⚠ n — 경고(`uncommitted`·`unpushed`)만 센다. 오퍼레이터 표면이 없거나 못 읽으면 0. */
export function useCleanupWarnCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!hasOperatorLocalSurface()) return;
    let alive = true;
    void getWorkspaceCleanup().then((v) => { if (alive) setN(buildCleanupModel(v.ledger, new Date()).warnCount); }, () => {});
    return () => { alive = false; };
  }, []);
  return n;
}

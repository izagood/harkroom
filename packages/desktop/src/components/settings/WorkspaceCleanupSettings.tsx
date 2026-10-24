/**
 * 설정 › 이 기기 › **작업 폴더 정리**(스레드 9e909150, designer 시안 v3 확정판).
 *
 * 원장은 이 기기 오퍼레이터의 것이다(`operator/src/workspaceCleanup.ts`). 이 화면은 읽고, 켜고 끄고, N일을 바꾸고, 보존·되돌리기·
 * 삭제 예정에 넣기(하나씩·골라서 여러 개)를 한다. 지우기는 언제나 지우기 직전 검사(`check`)를 거친다 — 회차가 기한에 지우거나,
 * 사람이 확인 창을 지나 「지금 정리」로 삭제 예정인 것만 당겨 지운다(jaebin 10-24, 처음 시안 D3 의 「바로 지우기 없음」을 바꿈).
 * 주인 모름은 지금 정리할 수 없다 — 먼저 삭제 예정에 넣어야 한다.
 *
 * 줄이 칸을 옮겨 가도 스크롤 자리를 지킨다(`rowAnchor.ts`) — WKWebView 에는 스크롤 앵커링이 없다.
 *
 * 보존·넣기는 확인 창 없이 바로 된다 — 되돌릴 수 있는 일이다. ⚠ 이유는 툴팁이 아니라 글로 쓴다. `turn-running` 은 ⚠ 가 아니라
 * 「미룸」이다(사람이 할 일이 없고 곧 풀린다 — 이것까지 세면 목차의 ⚠ 숫자가 늘 떠 있어 아무도 보지 않게 된다).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { captureRowAnchor, restoreRowAnchor, ROW_ANCHOR_ATTR, type RowAnchor } from '../../lib/rowAnchor';
import { ConfirmDialog } from '../ConfirmDialog';
import { SettingsColumns, SettingsGroup, SettingsPage, Toggle } from './primitives';
import { errorText } from '../../lib/errorText';

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

  // 누른 순간 붙잡은 줄 — 새 원장을 그린 뒤 그 줄이 누른 줄 자리에 오게 한다(WKWebView 에는 스크롤 앵커링이 없다).
  const anchor = useRef<RowAnchor | null>(null);
  useLayoutEffect(() => { restoreRowAnchor(anchor.current); anchor.current = null; }, [view]);

  const run = async (fn: () => Promise<WorkspaceCleanupView>) => {
    setBusy(true); setError(null);
    try { setView(await fn()); } catch (e) { anchor.current = null; setError(errorText(e, t)); } finally { setBusy(false); }
  };
  /** `from` = 누른 버튼. 그 줄(`data-anchor-key`)의 바로 아래 줄이 누른 줄 자리로 오게 붙잡는다. */
  const act = (path: string, action: 'keep' | 'unkeep' | 'list', from?: Element | null) => {
    if (!me) return;
    setNowResult(null); // 다른 손을 대면 지난 「지금 지우기」 결과는 옛 것이다(designer n4)
    anchor.current = captureRowAnchor(from?.closest(`[${ROW_ANCHOR_ATTR}]`) ?? null);
    void run(() => actWorkspaceCleanup(path, action, me.id));
  };

  // 주인 모름 골라 넣기 — 넣는 길은 하나씩 넣기와 같다(같은 act 'list', 누른 사람 id). 차례로 보내 원장 쓰기가 겹치지 않는다.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastPick = useRef<number | null>(null);
  const listSelected = (from: Element | null) => {
    if (!me || selected.size === 0) return;
    const paths = [...selected];
    setNowResult(null);
    anchor.current = captureRowAnchor(from, 'self');
    void run(async () => {
      let v: WorkspaceCleanupView | null = null;
      try {
        for (const p of paths) v = await actWorkspaceCleanup(p, 'list', me.id);
      } catch (e) {
        // 도중에 실패하면 거기까지 넣은 원장을 그리고 까닭을 보인다. 넣지 못한 것은 골라 둔 채 남는다(다시 누르면 된다).
        if (!v) throw e;
        setError(errorText(e, t));
        return v;
      }
      setSelected(new Set());
      return v!;
    });
  };

  // 「지금 정리」 — 삭제 예정인 것을 기한 전에 지운다. 한 줄씩 지우기 직전 검사를 거치고, 막힌 것은 남긴다.
  const [nowConfirm, setNowConfirm] = useState(false);
  const [nowResult, setNowResult] = useState<{ deleted: number; blocked: number; handed: number; failed: number } | null>(null);
  const cleanNow = () => {
    if (!me || typeof view !== 'object') return;
    const paths = view.ledger.items.filter((i) => i.state === 'listed' || i.state === 'blocked').map((i) => i.path);
    void run(async () => {
      const r = { deleted: 0, blocked: 0, handed: 0, failed: 0 };
      let v: WorkspaceCleanupView = view;
      for (const p of paths) {
        try { v = await actWorkspaceCleanup(p, 'deleteNow', me.id); } catch { r.failed++; continue; }
        const it = v.ledger.items.find((i) => i.path === p);
        if (!it) r.deleted++;
        else if (it.state === 'blocked') r.blocked++;
        else r.handed++; // 스레드 폴더 — 그 에이전트의 러너가 다음 보고 때 지운다
      }
      setNowResult(r); setNowConfirm(false);
      return v;
    });
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
      <div className={`px-4 py-3 ${row.tone === 'warn' ? 'bg-warning-surface first:rounded-t-compose last:rounded-b-compose' : ''}`} data-testid="cleanup-row" data-tone={row.tone} data-anchor-key={row.key}>
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
              {/* 주인 모름을 청소기가 넣은 줄 — 사람이 넣은 것(actedBy)과 스레드 줄과 구별한다. */}
              {!kept && !row.thread && row.actedBy === null ? <>{' · '}<span data-testid="cleanup-unowned-auto">{t('cleanup.part.unownedAuto')}</span></> : null}
              {kept && row.actedAt ? <> {' · '}<span data-testid="cleanup-kept-by">{whoOf(row.actedBy) ? t('cleanup.keptBy', { who: whoOf(row.actedBy)!, date: fmtDay(row.actedAt) }) : t('cleanup.keptAuto', { date: fmtDay(row.actedAt) })}</span></> : null}
            </span>
          </button>
          {!kept && (
            <span className={`shrink-0 text-meta ${row.tone === 'warn' ? 'text-warning' : off ? 'text-fg-subtle' : row.tone === 'deferred' ? 'text-fg-muted' : due.today ? 'font-medium text-accent' : 'text-fg-muted'}`} data-testid="cleanup-due">
              {row.tone === 'warn' ? t('cleanup.stopped') : off ? t('cleanup.offNoDelete') : row.tone === 'deferred' ? t(row.deferReason === 'runner-off' ? 'cleanup.runnerOffWaiting' : 'cleanup.deferred') : row.tone === 'deleting' ? t('cleanup.deleting') : due.text}
            </span>
          )}
          <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
            disabled={busy || !me} data-testid={kept ? 'cleanup-unkeep' : 'cleanup-keep'}
            onClick={(e) => { const from = e.currentTarget; for (const p of row.parts) act(p.path, kept ? 'unkeep' : 'keep', from); }}>
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
  // 고른 것은 지금도 주인 모름인 것만 센다(그 사이 회차가 넣었거나 지웠을 수 있다).
  const unownedPaths = model.unowned.map((u) => u.path);
  const picked = unownedPaths.filter((p) => selected.has(p));
  const allPicked = picked.length > 0 && picked.length === unownedPaths.length;
  /** i 번째 주인 모름을 고르거나 푼다. shift 면 앞서 누른 줄부터 여기까지를 누른 줄이 될 상태로 맞춘다. */
  const pick = (i: number, shift: boolean) => {
    const p = unownedPaths[i];
    if (!p) return;
    const on = !selected.has(p);
    const from = shift && lastPick.current !== null && lastPick.current < unownedPaths.length ? lastPick.current : i;
    const range = unownedPaths.slice(Math.min(from, i), Math.max(from, i) + 1);
    setSelected((s) => { const n = new Set(s); for (const r of range) { if (on) n.add(r); else n.delete(r); } return n; });
    lastPick.current = i;
  };
  const nowItems = ledger.items.filter((i) => i.state === 'listed' || i.state === 'blocked');
  const nowBytes = nowItems.reduce((a, i) => a + (i.sizeNow ?? 0), 0);

  return (
    <SettingsPage section="workspace-cleanup" description={t('settings.desc.workspace-cleanup')} layout="list">
      {/* 한국어 설명이 낱말 중간에서 끊기지 않게(designer n3). 경로·제목은 truncate 라 영향 없다. */}
      <div className="break-keep">
      <div className="mb-6 text-meta text-fg-muted" data-testid="cleanup-summary">
        {summary.length > 0 && <p data-testid="cleanup-summary-line">{summary.join(' · ')}</p>}
        <p className={`${summary.length > 0 ? 'mt-1 ' : ''}text-fg-subtle`} data-testid="cleanup-next">
          {off ? t('cleanup.nextOff') : next ? t('cleanup.next', { time: fmtTime(next) }) : t('cleanup.nextUnknown')}
        </p>
      </div>

      {error && <p role="alert" className="mb-4 text-meta text-danger" data-testid="cleanup-error">{error}</p>}

      {/* 정리할 목록이 주 칸, 규칙·최근 기록이 곁 칸(시안 v1 list). 900 미만에서는 목록 → 규칙 → 기록 순으로 쌓인다. */}
      <SettingsColumns
        testId="cleanup-columns"
        main={(
          <>
      {nowConfirm && (
        <ConfirmDialog
          title={t('cleanup.now.title', { n: nowItems.length })}
          detail={t('cleanup.now.detail', { n: nowItems.length, size: formatBytes(nowBytes) })}
          detailKind="note"
          confirmLabel={t('cleanup.now.confirm')} cancelLabel={t('cleanup.now.cancel')} danger busy={busy} error={error}
          onConfirm={cleanNow} onCancel={() => setNowConfirm(false)} />
      )}
      {/* 「지금 지우기」는 이 칸(삭제 예정)만 지운다 — 칸 제목 줄에 둬 무엇을 지우는지 보이게(designer s1). 0개·꺼짐이면 없다. */}
      <SettingsGroup title={t('cleanup.listedTitle', { n: model.totals.listedCount, warn: model.warnCount })}
        action={(!off && nowItems.length > 0) || nowResult ? (
          <span className="flex shrink-0 items-center gap-3">
            {nowResult && (
              <span className="text-meta text-fg-muted" role="status" data-testid="cleanup-now-result">
                {t('cleanup.now.result', { deleted: nowResult.deleted, blocked: nowResult.blocked })}
                {nowResult.handed > 0 ? t('cleanup.now.handed', { n: nowResult.handed }) : ''}
                {nowResult.failed > 0 ? t('cleanup.now.failed', { n: nowResult.failed }) : ''}
              </span>
            )}
            {!off && nowItems.length > 0 && (
              <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
                disabled={busy || !me} data-testid="cleanup-now" onClick={() => { setNowResult(null); setNowConfirm(true); }}>{t('cleanup.now')}</button>
            )}
          </span>
        ) : undefined}>
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
          <p className="px-4 py-2 text-meta text-fg-subtle">{t('cleanup.unownedHint', { days: settings.graceDays })}</p>
          {/* 38개를 굴리며 고른 뒤 다시 맨 위로 올라가지 않게 칸 안에서 붙는다(designer s2). */}
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-surface-raised px-4 py-2" data-testid="cleanup-unowned-bulk" data-anchor-key="unowned-bulk">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-meta text-fg-muted">
              <input type="checkbox" className="accent-accent" data-testid="cleanup-unowned-select-all" checked={allPicked}
                ref={(el) => { if (el) el.indeterminate = picked.length > 0 && !allPicked; }}
                disabled={busy} onChange={() => setSelected(allPicked ? new Set() : new Set(unownedPaths))} />
              {t('cleanup.select.all')}
            </label>
            <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
              disabled={busy || !me || picked.length === 0} data-testid="cleanup-unowned-list-selected"
              onClick={(e) => listSelected(e.currentTarget.closest(`[${ROW_ANCHOR_ATTR}]`))}>{t('cleanup.bulkList', { n: picked.length })}</button>
          </div>
          {model.unowned.map((u, i) => (
            <div key={u.path} className="px-4 py-3" data-testid="cleanup-unowned" data-anchor-key={u.path}>
              <div className="flex items-start gap-3">
                {/* shift 를 누른 채 누르면 앞서 누른 줄부터 여기까지(designer n2). onChange 는 shift 를 모른다 — onClick 으로 받는다. */}
                <input type="checkbox" className="mt-1 shrink-0 accent-accent" data-testid="cleanup-unowned-select" aria-label={t('cleanup.select.row', { path: shortPath(u.path) })}
                  checked={selected.has(u.path)} disabled={busy} onChange={() => {}} onClick={(e) => pick(i, e.shiftKey)} />
                {/* 경로·메타를 눌러도 고른다 — 체크박스만 노리지 않게. 버튼(보존·넣기)은 따로다. */}
                <span className={`min-w-0 flex-1 select-none ${busy ? '' : 'cursor-pointer'}`} data-testid="cleanup-unowned-pick" onClick={(e) => { if (!busy) pick(i, e.shiftKey); }}>
                  <span className="block truncate font-mono text-fg">{shortPath(u.path)}</span>
                  <span className="mt-0.5 block text-meta text-fg-subtle">
                    {u.branch ? t('cleanup.branch', { name: u.branch }) : t('cleanup.detached', { sha: (u.headSha ?? '').slice(0, 7) })}
                    {' · '}{u.pr ? t(`cleanup.pr.${u.pr.state}` as MessageKey, { n: u.pr.number }) : t('cleanup.pr.unknown')}
                    {u.lastModifiedAt ? <>{' · '}{t('cleanup.lastModified', { date: fmtDay(u.lastModifiedAt) })}</> : null}
                    {' · '}{formatBytes(u.sizeNow)}
                  </span>
                </span>
                <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
                  disabled={busy || !me} data-testid="cleanup-unowned-keep" onClick={(e) => act(u.path, 'keep', e.currentTarget)}>{t('cleanup.keep')}</button>
                <button className="shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
                  disabled={busy || !me} data-testid="cleanup-unowned-list" onClick={(e) => act(u.path, 'list', e.currentTarget)}>{t('cleanup.list')}</button>
              </div>
              {u.blockReason && isWarn(u.blockReason) && (
                <p className="mt-2 text-meta text-warning" data-testid="cleanup-unowned-warn">⚠ {t('cleanup.unownedWarn')}</p>
              )}
            </div>
          ))}
        </SettingsGroup>
      )}

          </>
        )}
        side={(
          <>
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
          </>
        )}
      />
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

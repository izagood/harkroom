/**
 * 작업 폴더 정리 화면의 모양 — 원장(`CleanupLedger`)을 화면의 묶음으로 바꾼다. 순수 함수라 화면 없이 잰다.
 *
 * 시안 v3(스레드 9e909150 확정판)의 규칙:
 * - **줄 하나 = 스레드 하나.** 보존·자동 되살리기가 스레드 단위로 걸리기 때문이다. 그 스레드의 worktree·스레드 폴더는 줄을
 *   펼친 `parts` 로 보인다.
 * - 정렬: ⚠(지우지 못함)이 맨 위, 그다음 미룸(`turn-running`), 그다음 기한이 가까운 순.
 * - `turn-running` 은 ⚠ 가 아니다 — 사람이 할 일이 없고 곧 풀린다. ⚠ 숫자에 세지 않는다.
 * - 주인 모름은 스레드가 없으니 줄 하나 = 경로 하나다. 마지막 수정이 오래된 순.
 */
import type { CleanupBlockReason, CleanupEvent, CleanupItem, CleanupLedger, CleanupThreadRef } from '@harkroom/shared/workspaceCleanup';

export type RowTone = 'warn' | 'deferred' | 'due' | 'listed';

export interface ThreadRow {
  key: string;
  thread: CleanupThreadRef | null;
  parts: CleanupItem[];
  tone: RowTone;
  /** 줄에 보일 이유 — ⚠·미룸일 때. */
  blockReason: CleanupBlockReason | null;
  /** 가장 이른 기한(ISO). */
  deleteAfter: string | null;
  /** 지금 디스크에 남은 크기(바이트, 모르면 null). */
  sizeNow: number | null;
  prNumber: number | null;
  prState: 'open' | 'merged' | 'closed' | null;
  /** 보존한 사람·시각(보존 묶음일 때). */
  actedBy: string | null;
  actedAt: string | null;
}

export interface CleanupScreenModel {
  listed: ThreadRow[];
  kept: ThreadRow[];
  unowned: CleanupItem[];
  /** 목차의 ⚠ n — `uncommitted`·`unpushed` 만 센다. */
  warnCount: number;
  deferredCount: number;
  dueTodayCount: number;
  totals: { listedBytes: number; keptBytes: number; unownedBytes: number; listedCount: number; keptCount: number; unownedCount: number };
  /** 지난 7일 동안 비운 바이트(지움 + 의존성 지움). */
  freedLast7Days: number;
  events: CleanupEvent[];
}

const WARN: ReadonlySet<CleanupBlockReason> = new Set(['uncommitted', 'unpushed']);

export function isWarn(reason: CleanupBlockReason | null | undefined): boolean {
  return !!reason && WARN.has(reason);
}

const threadKeyOf = (t: CleanupThreadRef) => `${t.channelId}/${t.threadRootId}`;
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function rowOf(key: string, parts: CleanupItem[], now: Date): ThreadRow {
  const warn = parts.find((p) => p.state === 'blocked' && isWarn(p.blockReason));
  const deferred = parts.find((p) => p.state === 'blocked' && p.blockReason === 'turn-running');
  const dates = parts.map((p) => p.deleteAfter).filter((d): d is string => !!d).sort();
  const deleteAfter = dates[0] ?? null;
  const due = deleteAfter !== null && (Date.parse(deleteAfter) <= now.getTime() || sameDay(new Date(deleteAfter), now));
  const pr = parts.find((p) => p.pr)?.pr ?? null;
  const acted = parts.find((p) => p.actedAt) ?? null;
  return {
    key, thread: parts[0]?.thread ?? null, parts,
    tone: warn ? 'warn' : deferred ? 'deferred' : due ? 'due' : 'listed',
    blockReason: warn?.blockReason ?? deferred?.blockReason ?? null,
    deleteAfter,
    sizeNow: parts.some((p) => p.sizeNow !== null) ? sum(parts.map((p) => p.sizeNow)) : null,
    prNumber: pr?.number ?? null, prState: pr?.state ?? null,
    actedBy: acted?.actedBy ?? null, actedAt: acted?.actedAt ?? null,
  };
}

const TONE_ORDER: Record<RowTone, number> = { warn: 0, deferred: 1, due: 2, listed: 3 };

function group(items: CleanupItem[], now: Date): ThreadRow[] {
  const byKey = new Map<string, CleanupItem[]>();
  for (const i of items) {
    // 주인 모름에서 사람이 넣은 것은 스레드가 없다 — 경로가 곧 줄이다.
    const k = i.thread ? threadKeyOf(i.thread) : `path:${i.path}`;
    byKey.set(k, [...(byKey.get(k) ?? []), i]);
  }
  return [...byKey.entries()].map(([k, parts]) => rowOf(k, parts, now));
}

export function buildCleanupModel(ledger: CleanupLedger, now: Date): CleanupScreenModel {
  const listedItems = ledger.items.filter((i) => i.state === 'listed' || i.state === 'blocked');
  const keptItems = ledger.items.filter((i) => i.state === 'kept');
  const unowned = ledger.items.filter((i) => i.state === 'unowned')
    .sort((a, b) => (a.lastModifiedAt ?? '').localeCompare(b.lastModifiedAt ?? ''));
  const listed = group(listedItems, now).sort((a, b) =>
    TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || (a.deleteAfter ?? '').localeCompare(b.deleteAfter ?? ''));
  const kept = group(keptItems, now).sort((a, b) => (b.actedAt ?? '').localeCompare(a.actedAt ?? ''));
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const freedLast7Days = sum(ledger.events
    .filter((e) => (e.action === 'deleted' || e.action === 'deps-removed') && Date.parse(e.at) >= weekAgo)
    .map((e) => e.bytes));
  return {
    listed, kept, unowned,
    warnCount: listed.filter((r) => r.tone === 'warn').length,
    deferredCount: listed.filter((r) => r.tone === 'deferred').length,
    dueTodayCount: listed.filter((r) => r.tone === 'due').length,
    totals: {
      listedBytes: sum(listedItems.map((i) => i.sizeNow)), keptBytes: sum(keptItems.map((i) => i.sizeNow)),
      unownedBytes: sum(unowned.map((i) => i.sizeNow)),
      listedCount: listed.length, keptCount: kept.length, unownedCount: unowned.length,
    },
    freedLast7Days,
    events: [...ledger.events].reverse(),
  };
}

/**
 * N 을 바꾸면 기한이 `listedAt + N일` 로 다시 잡힌다(오퍼레이터가 한다). 바꾸기 **전에** 화면이 "n개가 오늘 기한이 됩니다"를
 * 말하려고 같은 셈을 여기서 한다.
 */
export function dueTodayIf(ledger: CleanupLedger, graceDays: number, now: Date): number {
  const keys = new Set<string>();
  for (const i of ledger.items) {
    if ((i.state !== 'listed' && i.state !== 'blocked') || !i.listedAt) continue;
    const d = new Date(Date.parse(i.listedAt) + graceDays * 86_400_000);
    if (d.getTime() <= now.getTime() || sameDay(d, now)) keys.add(i.thread ? threadKeyOf(i.thread) : `path:${i.path}`);
  }
  return keys.size;
}

/** 다음 정리 시각 — 마지막 회차 + 1시간(앱이 켜져 있을 때). 회차가 없었으면 null. */
export function nextSweepAt(ledger: CleanupLedger): Date | null {
  return ledger.lastSweepAt ? new Date(Date.parse(ledger.lastSweepAt) + 60 * 60_000) : null;
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

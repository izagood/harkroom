import { describe, expect, it } from 'vitest';
import type { CleanupItem, CleanupLedger } from '@harkroom/shared/workspaceCleanup';
import { buildCleanupModel, dueTodayIf, formatBytes, nextSweepAt } from '../src/lib/workspaceCleanupView';

const NOW = new Date('2026-10-06T07:00:00Z');
const T = (r: string) => ({ channelId: 'c', threadRootId: r });
const item = (o: Partial<CleanupItem>): CleanupItem => ({
  path: '/p', kind: 'worktree', state: 'listed', repo: '/repo', branch: 'b', headSha: 'h', thread: T('r1'), pr: null,
  lastModifiedAt: null, listedAt: '2026-10-01T00:00:00Z', deleteAfter: '2026-10-08T00:00:00Z', blockReason: null,
  actedBy: null, actedAt: null, sizeBefore: 100, sizeNow: 10, ...o,
});
const ledger = (items: CleanupItem[], events: CleanupLedger['events'] = []): CleanupLedger => ({ version: 1, items, events, lastSweepAt: '2026-10-06T06:30:00Z' });

describe('buildCleanupModel', () => {
  it('줄 하나 = 스레드 하나, ⚠ → 미룸 → 기한 가까운 순', () => {
    const m = buildCleanupModel(ledger([
      item({ path: '/a', thread: T('r1'), deleteAfter: '2026-10-09T00:00:00Z' }),
      item({ path: '/a2', kind: 'threadDir', thread: T('r1'), deleteAfter: '2026-10-10T00:00:00Z' }),
      item({ path: '/b', thread: T('r2'), state: 'blocked', blockReason: 'turn-running' }),
      item({ path: '/c', thread: T('r3'), state: 'blocked', blockReason: 'unpushed' }),
      item({ path: '/d', thread: T('r4'), deleteAfter: '2026-10-06T08:00:00Z' }),
    ]), NOW);
    expect(m.listed.map((r) => [r.thread?.threadRootId, r.tone])).toEqual([['r3', 'warn'], ['r2', 'deferred'], ['r4', 'due'], ['r1', 'listed']]);
    expect(m.listed[3]!.parts.map((p) => p.path)).toEqual(['/a', '/a2']);
    expect(m.listed[3]!.deleteAfter).toBe('2026-10-09T00:00:00Z');
  });
  it('⚠ 숫자는 uncommitted·unpushed 만 — turn-running 은 세지 않는다', () => {
    const m = buildCleanupModel(ledger([
      item({ path: '/b', thread: T('r2'), state: 'blocked', blockReason: 'turn-running' }),
      item({ path: '/c', thread: T('r3'), state: 'blocked', blockReason: 'uncommitted' }),
    ]), NOW);
    expect(m.warnCount).toBe(1);
    expect(m.deferredCount).toBe(1);
  });
  it('보존·주인 모름은 따로, 주인 모름은 마지막 수정이 오래된 순', () => {
    const m = buildCleanupModel(ledger([
      item({ path: '/k', state: 'kept', actedBy: 'acct', actedAt: '2026-10-04T00:00:00Z' }),
      item({ path: '/u1', state: 'unowned', thread: null, lastModifiedAt: '2026-09-22T00:00:00Z' }),
      item({ path: '/u2', state: 'unowned', thread: null, lastModifiedAt: '2026-09-18T00:00:00Z' }),
    ]), NOW);
    expect(m.kept[0]).toMatchObject({ actedBy: 'acct', actedAt: '2026-10-04T00:00:00Z' });
    expect(m.unowned.map((u) => u.path)).toEqual(['/u2', '/u1']);
    expect(m.listed).toEqual([]);
  });
  it('지난 7일 비운 양 = 지움 + 의존성 지움', () => {
    const m = buildCleanupModel(ledger([], [
      { at: '2026-10-05T00:00:00Z', path: '/x', thread: null, action: 'deps-removed', by: null, bytes: 200, reason: null },
      { at: '2026-10-05T01:00:00Z', path: '/x', thread: null, action: 'deleted', by: null, bytes: 50, reason: null },
      { at: '2026-09-01T00:00:00Z', path: '/y', thread: null, action: 'deleted', by: null, bytes: 999, reason: null },
    ]), NOW);
    expect(m.freedLast7Days).toBe(250);
    expect(m.events[0]!.action).toBe('deleted');
  });
});

describe('dueTodayIf · nextSweepAt · formatBytes', () => {
  it('N 을 줄이면 오늘 기한이 되는 스레드 수', () => {
    const l = ledger([item({ path: '/a', listedAt: '2026-10-01T00:00:00Z' }), item({ path: '/b', thread: T('r2'), listedAt: '2026-10-05T00:00:00Z' })]);
    expect(dueTodayIf(l, 7, NOW)).toBe(0);
    expect(dueTodayIf(l, 5, NOW)).toBe(1);
    expect(dueTodayIf(l, 1, NOW)).toBe(2);
  });
  it('다음 정리는 마지막 회차 + 1시간', () => {
    expect(nextSweepAt(ledger([]))!.toISOString()).toBe('2026-10-06T07:30:00.000Z');
    expect(nextSweepAt({ ...ledger([]), lastSweepAt: null })).toBeNull();
  });
  it('크기', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(312 * 1024 ** 2)).toBe('312 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});

describe('live — 스레드 폴더의 「지우는 중」·「러너 꺼짐 미룸」·주인 보고 전', () => {
  const dir = (r: string, o: Partial<CleanupItem> = {}) => item({ path: `/s/${r}`, kind: 'threadDir', thread: T(r), repo: null, branch: null, headSha: null, deleteAfter: '2026-10-06T06:00:00Z', ...o });
  const live = (threads: Record<string, { deleteRequestedAt: string | null; runnerConnected: boolean }>, ownersReported = true) => ({ threads, ownersReported });
  it('요청을 보냈고 러너가 붙어 있으면 「지우는 중」 — ⚠ 도 미룸도 아니다', () => {
    const m = buildCleanupModel(ledger([dir('r1')]), NOW, live({ 'c/r1': { deleteRequestedAt: '2026-10-06T06:30:00Z', runnerConnected: true } }));
    expect(m.listed[0]).toMatchObject({ tone: 'deleting', deferReason: null, blockReason: null });
    expect(m.warnCount).toBe(0);
    expect(m.deferredCount).toBe(0);
  });
  it('기한이 지났는데 러너가 꺼져 있으면 「미룸 · runner-off」 — ⚠ 숫자에 세지 않는다', () => {
    const m = buildCleanupModel(ledger([dir('r1')]), NOW, live({ 'c/r1': { deleteRequestedAt: null, runnerConnected: false } }));
    expect(m.listed[0]).toMatchObject({ tone: 'deferred', deferReason: 'runner-off' });
    expect(m.warnCount).toBe(0);
    expect(m.deferredCount).toBe(1);
  });
  it('기한 전이면 러너가 꺼져 있어도 그냥 기한을 보인다(할 일이 없다)', () => {
    const m = buildCleanupModel(ledger([dir('r1', { deleteAfter: '2026-10-09T00:00:00Z' })]), NOW, live({ 'c/r1': { deleteRequestedAt: null, runnerConnected: false } }));
    expect(m.listed[0]!.tone).toBe('listed');
  });
  it('worktree 만 있는 줄은 live 를 보지 않는다 · live 가 없으면(옛 오퍼레이터) 원장대로', () => {
    const wt = buildCleanupModel(ledger([item({ path: '/w', thread: T('r1'), deleteAfter: '2026-10-06T06:00:00Z' })]), NOW, live({ 'c/r1': { deleteRequestedAt: '2026-10-06T06:30:00Z', runnerConnected: false } }));
    expect(wt.listed[0]!.tone).toBe('due');
    const old = buildCleanupModel(ledger([dir('r1')]), NOW);
    expect(old.listed[0]!.tone).toBe('due');
    expect(old.ownersPending).toBe(false);
  });
  it('정렬: ⚠ → 미룸 → 지우는 중 → 기한', () => {
    const m = buildCleanupModel(ledger([
      item({ path: '/d', thread: T('r4'), deleteAfter: '2026-10-06T08:00:00Z' }),
      dir('r1'),
      dir('r2'),
      item({ path: '/c', thread: T('r3'), state: 'blocked', blockReason: 'uncommitted' }),
    ]), NOW, live({ 'c/r1': { deleteRequestedAt: '2026-10-06T06:30:00Z', runnerConnected: true }, 'c/r2': { deleteRequestedAt: null, runnerConnected: false } }));
    expect(m.listed.map((r) => r.tone)).toEqual(['warn', 'deferred', 'deleting', 'due']);
  });
  it('주인 보고가 아직 없으면 ownersPending', () => {
    expect(buildCleanupModel(ledger([]), NOW, live({}, false)).ownersPending).toBe(true);
    expect(buildCleanupModel(ledger([]), NOW, live({}, true)).ownersPending).toBe(false);
  });
});

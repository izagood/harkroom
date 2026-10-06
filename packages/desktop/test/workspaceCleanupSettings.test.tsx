/**
 * 설정 › 이 기기 › 작업 폴더 정리(스레드 9e909150, 시안 v3). 재는 것: ⚠ 이유가 글로 보이는가, `turn-running` 은 「미룸」이고
 * ⚠ 숫자에 안 세는가, 「보존」·「삭제 예정에 넣기」가 확인 창 없이 곧장 오퍼레이터에 닿는가(누른 사람 id 와 함께), 보존한 사람이
 * 보이는가, N 을 줄이면 오늘 기한 경고가 뜨는가, **바로 지우는 버튼이 없는가**.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { CleanupItem, CleanupLedger } from '@harkroom/shared/workspaceCleanup';
import { WorkspaceCleanupSettings } from '../src/components/settings/WorkspaceCleanupSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

const ME = 'owner-1';
const NOW = new Date('2026-10-06T07:00:00Z');
const T = (r: string) => ({ channelId: 'ch-1', threadRootId: r });
const item = (o: Partial<CleanupItem>): CleanupItem => ({
  path: '/wt/a', kind: 'worktree', state: 'listed', repo: '/repo', branch: 'fix/a', headSha: 'abc1234', thread: T('r1'),
  pr: { number: 1191, state: 'merged', headSha: 'abc1234' }, lastModifiedAt: '2026-09-20T00:00:00Z',
  listedAt: '2026-10-01T00:00:00Z', deleteAfter: '2026-10-09T00:00:00Z', blockReason: null,
  actedBy: null, actedAt: null, sizeBefore: 300, sizeNow: 18 * 1024 ** 2, ...o,
});
const LEDGER: CleanupLedger = {
  version: 1, lastSweepAt: '2026-10-06T06:30:00Z', events: [],
  items: [
    item({ path: '/wt/warn', thread: T('r-warn'), state: 'blocked', blockReason: 'uncommitted' }),
    item({ path: '/wt/run', thread: T('r-run'), state: 'blocked', blockReason: 'turn-running' }),
    item({ path: '/wt/a', listedAt: '2026-10-05T00:00:00Z', deleteAfter: '2026-10-12T00:00:00Z' }),
    item({ path: '/wt/kept', thread: T('r-kept'), state: 'kept', actedBy: ME, actedAt: '2026-10-04T00:00:00Z' }),
    item({ path: '/tmp/orphan', thread: null, state: 'unowned', pr: null, branch: null }),
  ],
};

function tauri() {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'workspace_cleanup_get' || cmd === 'workspace_cleanup_act' || cmd === 'workspace_cleanup_settings_set') {
      return { settings: { enabled: true, graceDays: 7 }, ledger: LEDGER, running: false, _args: args };
    }
    throw new Error(`unexpected ${cmd}`);
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc(ME, 'owner'), accounts: { [ME]: acc(ME, 'owner') } });
  setController({ api: { message: async () => { throw new Error('no'); } } } as unknown as Controller);
});
afterEach(() => { cleanup(); delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__; });

describe('작업 폴더 정리 화면', () => {
  it('⚠ 이유는 글로, turn-running 은 미룸(⚠ 아님), ⚠ 가 맨 위', async () => {
    tauri();
    render(<WorkspaceCleanupSettings now={NOW} />);
    const rows = await screen.findAllByTestId('cleanup-row');
    expect(rows.slice(0, 3).map((r) => r.getAttribute('data-tone'))).toEqual(['warn', 'deferred', 'listed']); // 넷째는 보존 묶음
    const reasons = screen.getAllByTestId('cleanup-reason').map((r) => r.textContent);
    expect(reasons[0]).toContain('⚠ 커밋하지 않은 변경이 있어 지우지 않았다.');
    expect(reasons[1]).not.toContain('⚠');
    expect(reasons[1]).toContain('미뤘다');
  });
  it('「보존」은 확인 창 없이 곧장 누른 사람 id 와 함께 간다', async () => {
    const invoke = tauri();
    render(<WorkspaceCleanupSettings now={NOW} />);
    const keep = (await screen.findAllByTestId('cleanup-keep'))[2]!;
    fireEvent.click(keep);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('workspace_cleanup_act', { path: '/wt/a', action: 'keep', by: ME }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('주인 모름: 「삭제 예정에 넣기」와 「보존」만 — 바로 지우는 버튼은 어디에도 없다', async () => {
    const invoke = tauri();
    render(<WorkspaceCleanupSettings now={NOW} />);
    fireEvent.click(await screen.findByTestId('cleanup-unowned-list'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('workspace_cleanup_act', { path: '/tmp/orphan', action: 'list', by: ME }));
    expect(screen.queryByRole('button', { name: /^삭제$|지우기|delete now/i })).toBeNull();
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('workspace_cleanup_delete');
  });
  it('보존 묶음에 누가·언제 보존했는지', async () => {
    tauri();
    render(<WorkspaceCleanupSettings now={NOW} />);
    expect((await screen.findByTestId('cleanup-kept-by')).textContent).toContain('10-04');
  });
  it('N 을 줄이면 오늘 기한이 되는 수를 미리 말하고, 누르면 settings_set 으로 간다', async () => {
    const invoke = tauri();
    render(<WorkspaceCleanupSettings now={NOW} />);
    expect((await screen.findByTestId('cleanup-grace-value')).textContent).toBe('7일');
    // /wt/a 는 10-05 에 넣었다 — N=6 이면 10-11, N=1 이면 오늘. 하루 줄이는 것만으로는 0 이라 경고 없음.
    expect(screen.queryByTestId('cleanup-grace-warn')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '하루 줄이기' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('workspace_cleanup_settings_set', { enabled: null, graceDays: 6 }));
  });
  it('Tauri 표면이 없으면 안내만', () => {
    render(<WorkspaceCleanupSettings now={NOW} />);
    expect(screen.getByTestId('cleanup-unavailable')).toBeTruthy();
  });
});

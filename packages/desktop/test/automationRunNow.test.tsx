/**
 * 설정 › 자동화 [지금 한 번 돌리기] A안(스레드 314478b5) — 누르면 잠기고, 회차 id 로 결과를
 * 기다려 버튼 아래에 남기고, 10분 안에 또 누르면 한 번 묻는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { AutomationRunView, AutomationView } from '@harkroom/shared';
import { setController, type Controller } from '../src/state/controller';
import { AutomationsSettings } from '../src/components/settings/AutomationsSettings';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { translator } from '../src/i18n';
import { ApiError } from '../src/lib/api';
import { runErrorText, unfilledManualVars } from '../src/lib/automation';
import { acc } from './helpers/fakeApi';

const ko = translator('ko');

const base = (extra: Partial<AutomationView> = {}): AutomationView => ({
  id: 'a1', ownerId: 'u1', channelId: 'c1', name: '판올림', body: '@task_manager 올려라',
  trigger: { kind: 'schedule', freq: 'daily', time: '09:00', tz: 'Asia/Seoul' },
  enabled: true, nextAt: null, pausedReason: null, consecutiveFailures: 0, ingressEnabledAt: null,
  debounceSec: null, proposedBy: null, approvedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastRun: null, ...extra,
} as AutomationView);
const run = (status: AutomationRunView['status'], extra: Partial<AutomationRunView> = {}): AutomationRunView => ({
  id: 'r1', automationId: 'a1', eventKey: 'manual:r1', triggerKind: 'manual', status,
  messageId: null, error: null, createdAt: new Date().toISOString(), finishedAt: null, ...extra,
});

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'alice'), accounts: { u1: acc('u1', 'alice') } });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePrefsStore.getState().setLocale('system');
});

async function openCard() {
  fireEvent.click(await screen.findByTestId('automation-toggle-details'));
}

describe('지금 한 번 돌리기 — 잠금과 결과 줄', () => {
  it('누르면 「보내는 중…」으로 잠기고, 회차가 글 올림이 되면 결과 줄과 「글 열기」가 선다', async () => {
    const runAutomation = vi.fn(async () => run('pending'));
    let status: AutomationRunView['status'] = 'pending';
    const getAutomation = vi.fn(async () => ({ automation: base(), runs: [run(status, status === 'sent' ? { messageId: 'm7' } : {})] }));
    setController({ api: { listAutomations: vi.fn(async () => [base()]), runAutomation, getAutomation } } as unknown as Controller);
    const onOpenMessage = vi.fn();
    render(<AutomationsSettings onOpenMessage={onOpenMessage} />);
    await openCard();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    await waitFor(() => expect(runAutomation).toHaveBeenCalledTimes(1));
    const busyBtn = (await screen.findByText(ko('automations.row.running'))).closest('button')!;
    expect(busyBtn.disabled).toBe(true);
    expect(screen.getByTestId('automation-run-result').getAttribute('data-phase')).toBe('pending');

    // 잠긴 동안 또 눌러도 두 번 가지 않는다
    fireEvent.click(busyBtn);
    expect(runAutomation).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    status = 'sent';
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    await waitFor(() => expect(screen.getByTestId('automation-run-result').getAttribute('data-phase')).toBe('sent'));
    expect(screen.getByText(ko('automations.row.runNow')).closest('button')!.disabled).toBe(false);
    fireEvent.click(screen.getByTestId('automation-run-open'));
    expect(onOpenMessage).toHaveBeenCalledWith('m7');
  });

  it('실패 회차는 코드값을 사람 말로만 보인다 — 서버 글자를 그대로 그리지 않는다', async () => {
    const getAutomation = vi.fn(async () => ({ automation: base(), runs: [run('failed', { error: 'forbidden' })] }));
    setController({ api: { listAutomations: vi.fn(async () => [base()]), runAutomation: vi.fn(async () => run('pending')), getAutomation } } as unknown as Controller);
    render(<AutomationsSettings />);
    await openCard();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    const row = await screen.findByTestId('automation-run-result');
    await waitFor(() => expect(row.getAttribute('data-phase')).toBe('failed'));
    expect(row.textContent).toContain(ko('automations.err.forbidden'));
    expect(row.textContent).not.toContain('forbidden');
    expect(screen.getByText(ko('automations.run.retry'))).toBeTruthy();
  });

  it('30초가 지나도 대기면 기다림을 끝내고 이력을 가리킨다', async () => {
    const getAutomation = vi.fn(async () => ({ automation: base(), runs: [run('pending')] }));
    setController({ api: { listAutomations: vi.fn(async () => [base()]), runAutomation: vi.fn(async () => run('pending')), getAutomation } } as unknown as Controller);
    render(<AutomationsSettings />);
    await openCard();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    await act(async () => { await vi.advanceTimersByTimeAsync(32_000); });
    await waitFor(() => expect(screen.getByTestId('automation-run-result').getAttribute('data-phase')).toBe('slow'));
  });

  it('429(시간당 상한)는 자동화를 껐다는 말로 끝난다', async () => {
    const runAutomation = vi.fn(async () => { throw new ApiError(429, 'rate_limited', 'too many'); });
    setController({ api: { listAutomations: vi.fn(async () => [base()]), runAutomation } } as unknown as Controller);
    render(<AutomationsSettings />);
    await openCard();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    const row = await screen.findByTestId('automation-run-result');
    expect(row.textContent).toContain(ko('automations.err.rateLimited'));
  });
});

describe('지금 한 번 돌리기 — 확인', () => {
  it('마지막 실행이 10분 안이면 한 번 묻고, [한 번 더 보내기]를 눌러야 보낸다', async () => {
    const recent = base({ lastRun: { id: 'r0', status: 'sent', triggerKind: 'manual', createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), messageId: 'm0', error: null } });
    const runAutomation = vi.fn(async () => run('pending'));
    setController({ api: { listAutomations: vi.fn(async () => [recent]), runAutomation, getAutomation: vi.fn(async () => ({ automation: recent, runs: [] })) } } as unknown as Controller);
    render(<AutomationsSettings />);
    await openCard();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    const dlg = screen.getByTestId('automation-run-confirm');
    expect(dlg.textContent).toContain('4분 전');
    expect(runAutomation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(ko('automations.confirm.cancel')));
    expect(screen.queryByTestId('automation-run-confirm')).toBeNull();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    fireEvent.click(screen.getByText(ko('automations.confirm.again')));
    await waitFor(() => expect(runAutomation).toHaveBeenCalledTimes(1));
  });

  it('11분 전이면 묻지 않고 바로 보낸다', async () => {
    const old = base({ lastRun: { id: 'r0', status: 'sent', triggerKind: 'manual', createdAt: new Date(Date.now() - 11 * 60_000).toISOString(), messageId: 'm0', error: null } });
    const runAutomation = vi.fn(async () => run('pending'));
    setController({ api: { listAutomations: vi.fn(async () => [old]), runAutomation, getAutomation: vi.fn(async () => ({ automation: old, runs: [] })) } } as unknown as Controller);
    render(<AutomationsSettings />);
    await openCard();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    await waitFor(() => expect(runAutomation).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('automation-run-confirm')).toBeNull();
  });

  it('이벤트 트리거 본문에 채울 수 없는 변수가 있으면 묻고, 없으면 한 줄 안내만 둔다', async () => {
    const gh = base({ trigger: { kind: 'github', repo: 'o/r', event: 'release.published' }, body: '@x {{release.tag}} 나왔다 {{events}}' });
    const runAutomation = vi.fn(async () => run('pending'));
    setController({ api: { listAutomations: vi.fn(async () => [gh]), runAutomation, getAutomation: vi.fn(async () => ({ automation: gh, runs: [] })) } } as unknown as Controller);
    render(<AutomationsSettings />);
    await openCard();
    expect(screen.queryByTestId('automation-manual-hint')).toBeNull();
    fireEvent.click(screen.getByText(ko('automations.row.runNow')));
    const dlg = screen.getByTestId('automation-run-confirm');
    expect(dlg.textContent).toContain('{{release.tag}}');
    expect(dlg.textContent).not.toContain('{{events}}');
    expect(runAutomation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(ko('automations.confirm.sendAnyway')));
    await waitFor(() => expect(runAutomation).toHaveBeenCalledTimes(1));
  });
});

describe('마지막 실행 줄 · 이력 표', () => {
  it('접힌 카드에서도 마지막 실행이 한글로 서고, 옛 서버(lastRun 없음)면 줄이 없다', async () => {
    const withRun = base({ lastRun: { id: 'r0', status: 'sent', triggerKind: 'manual', createdAt: '2026-10-24T07:05:00.000Z', messageId: 'm0', error: null } });
    setController({ api: { listAutomations: vi.fn(async () => [withRun]) } } as unknown as Controller);
    const onOpenMessage = vi.fn();
    const { unmount } = render(<AutomationsSettings onOpenMessage={onOpenMessage} />);
    const line = await screen.findByTestId('automation-last-run');
    expect(line.textContent).toContain('수동');
    expect(line.textContent).toContain('글 올림');
    fireEvent.click(screen.getByTestId('automation-last-run-open'));
    expect(onOpenMessage).toHaveBeenCalledWith('m0');
    unmount();

    const old = base();
    delete (old as { lastRun?: unknown }).lastRun;
    setController({ api: { listAutomations: vi.fn(async () => [old]) } } as unknown as Controller);
    render(<AutomationsSettings />);
    await screen.findByTestId('automation-row');
    expect(screen.queryByTestId('automation-last-run')).toBeNull();
  });

  it('이력 표는 상태·트리거를 한글로, 올라간 글엔 「글 열기」를 둔다', async () => {
    const runs = [run('sent', { id: 'r2', messageId: 'm2' }), run('failed', { id: 'r3', triggerKind: 'github', error: 'channel_archived' })];
    setController({ api: { listAutomations: vi.fn(async () => [base()]), getAutomation: vi.fn(async () => ({ automation: base(), runs })) } } as unknown as Controller);
    const onOpenMessage = vi.fn();
    render(<AutomationsSettings onOpenMessage={onOpenMessage} />);
    await openCard();
    fireEvent.click(screen.getByText(ko('automations.row.history')));
    const rows = await screen.findAllByTestId('automation-run-row');
    expect(rows[0]!.textContent).toContain('글 올림');
    expect(rows[1]!.textContent).toContain('GitHub');
    expect(rows[1]!.textContent).toContain(ko('automations.err.channelArchived'));
    expect(rows[1]!.textContent).not.toMatch(/sent|failed|channel_archived/);
    fireEvent.click(screen.getByTestId('automation-run-open-row'));
    expect(onOpenMessage).toHaveBeenCalledWith('m2');
  });
});

describe('lib', () => {
  it('unfilledManualVars — 일정은 빈 목록, events 는 늘 채워진다', () => {
    expect(unfilledManualVars('{{date}}', { kind: 'schedule', freq: 'daily', time: '09:00', tz: 'UTC' })).toEqual([]);
    expect(unfilledManualVars('{{ pr.title }} {{events.count}} {{pr.title}}', { kind: 'webhook' })).toEqual(['pr.title']);
  });
  it('runErrorText — post_refused 접두와 모르는 코드', () => {
    expect(runErrorText('post_refused:forbidden', ko)).toBe(ko('automations.err.forbidden'));
    expect(runErrorText('<script>', ko)).toBe(ko('automations.err.unknown'));
  });
});

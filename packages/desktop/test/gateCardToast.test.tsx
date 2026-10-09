import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Notice, NOTICE_TTL_MS } from '../src/components/Notice';
import { GateCard } from '../src/components/GateCard';

/**
 * 상단 띠를 걷어 낸 자리(2026-10-09 A안) — 관문은 오른쪽 위 카드, 실패는 아래 토스트.
 */
beforeEach(() => useAppStore.getState().reset());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const 관문 = {
  sessionId: 's1', agentAccountId: 'agent-1', agentHandle: 'murmur', accountLabel: 'max',
  channelId: 'c1', threadRootId: 't1',
};

describe('관문 카드', () => {
  it('누가·어느 계정인지 말하고, [터미널 열기]가 그 터미널을 열며 카드를 내린다', () => {
    useAppStore.getState().raiseGate(관문);
    render(<GateCard />);
    expect(screen.getByTestId('gate-card').textContent).toContain('murmur');
    expect(screen.getByTestId('gate-card').textContent).toContain('max');

    fireEvent.click(screen.getByTestId('gate-card-open'));
    expect(useAppStore.getState().terminalTarget).toEqual({ agentAccountId: 'agent-1', channelId: 'c1', threadRootId: 't1' });
    expect(screen.queryByTestId('gate-card')).toBeNull();
  });

  it('[나중에]는 카드를 접는다', () => {
    useAppStore.getState().raiseGate(관문);
    render(<GateCard />);
    fireEvent.click(screen.getByTestId('gate-card-later'));
    expect(screen.queryByTestId('gate-card')).toBeNull();
    expect(useAppStore.getState().gates).toHaveLength(1);
  });

  it('여럿이면 가장 최근 것을 그리고 나머지를 센다', () => {
    useAppStore.getState().raiseGate(관문);
    useAppStore.getState().raiseGate({ ...관문, sessionId: 's2', agentHandle: 'designer' });
    render(<GateCard />);
    expect(screen.getByTestId('gate-card').textContent).toContain('designer');
    expect(screen.getByTestId('gate-card').textContent).toMatch(/1/);
  });
});

describe('실패 토스트', () => {
  it('창이 앞에 있으면 8초 뒤 내려간다', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAppStore.getState().pushNotice('복사 실패');
    render(<Notice />);
    expect(screen.getByRole('alert').textContent).toContain('복사 실패');
    act(() => { vi.advanceTimersByTime(NOTICE_TTL_MS + 500); });
    expect(useAppStore.getState().notices).toEqual([]);
  });

  it('창이 뒤에 있는 동안에는 시계가 멈춘다 — 자리를 비운 사이 사라지지 않는다', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useAppStore.getState().pushNotice('복사 실패');
    render(<Notice />);
    act(() => { vi.advanceTimersByTime(NOTICE_TTL_MS * 3); });
    expect(useAppStore.getState().notices).toHaveLength(1);
  });

  it('손을 올려 두면 멈춘다', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useAppStore.getState().pushNotice('복사 실패');
    render(<Notice />);
    fireEvent.mouseEnter(screen.getByTestId('notice'));
    act(() => { vi.advanceTimersByTime(NOTICE_TTL_MS * 3); });
    expect(useAppStore.getState().notices).toHaveLength(1);
  });
});

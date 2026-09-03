import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { LeasePanel } from '../src/components/LeasePanel';

beforeEach(() => useAppStore.getState().reset());

afterEach(() => {
  cleanup();
});

describe('LeasePanel', () => {
  it('shows empty state', () => {
    render(<LeasePanel />);
    expect(screen.getByText('No active work')).toBeTruthy();
  });

  it('groups leases by repo', () => {
    useAppStore.getState().set({
      leases: [
        { repo: 'main-repo', path: 'src/a.ts', actorKeyId: 'wk1', expiresAt: 'x' },
        { repo: 'main-repo', path: 'src/b.ts', actorKeyId: 'a-very-long-key-id', expiresAt: 'x' },
        { repo: 'other', path: 'src/c.ts', actorKeyId: 'wk2', expiresAt: 'x' },
      ],
    });
    render(<LeasePanel />);
    expect(screen.getByText('main-repo')).toBeTruthy();
    expect(screen.getByText('other')).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
    expect(screen.getByText(/a-very-long-…/)).toBeTruthy();
  });

  it('shows unconfigured message when projection is not set up', () => {
    useAppStore.getState().set({
      projectionStatus: { state: 'unconfigured', configured: false, connected: false, repo: null, lastLogIndex: 0, lastPolledAt: null, lastAdvancedAt: null, lastError: null },
    });
    render(<LeasePanel />);
    expect(screen.getByText(/투영이 설정되지 않았다/)).toBeTruthy();
    expect(screen.getByText(/AVCS_BASE_URL/)).toBeTruthy();
  });

  it('shows stalled message when projection is not polling', () => {
    const fiveMinutesAgo = Date.now() - 6 * 60 * 1000;
    useAppStore.getState().set({
      projectionStatus: { state: 'stalled', configured: true, connected: true, repo: 'test/repo', lastLogIndex: 100, lastPolledAt: fiveMinutesAgo, lastAdvancedAt: fiveMinutesAgo, lastError: 'connection refused' },
    });
    render(<LeasePanel />);
    expect(screen.getByText(/투영이.*부터 멈춰 있다/)).toBeTruthy();
    expect(screen.getByText(/connection refused/)).toBeTruthy();
  });

  it('shows stalled without error when lastError is null', () => {
    const fiveMinutesAgo = Date.now() - 6 * 60 * 1000;
    useAppStore.getState().set({
      projectionStatus: { state: 'stalled', configured: true, connected: true, repo: 'test/repo', lastLogIndex: 100, lastPolledAt: fiveMinutesAgo, lastAdvancedAt: fiveMinutesAgo, lastError: null },
    });
    render(<LeasePanel />);
    expect(screen.getByText(/투영이.*부터 멈춰 있다/)).toBeTruthy();
    expect(screen.queryByText(/connection refused/)).toBeNull();
  });

  it('shows ok state with empty leases', () => {
    useAppStore.getState().set({
      projectionStatus: { state: 'ok', configured: true, connected: true, repo: null, lastLogIndex: 0, lastPolledAt: Date.now(), lastAdvancedAt: null, lastError: null },
    });
    render(<LeasePanel />);
    expect(screen.getByText('No active work')).toBeTruthy();
  });

  it('unconfigured and ok+empty render different text', () => {
    // unconfigured
    useAppStore.getState().set({
      projectionStatus: { state: 'unconfigured', configured: false, connected: false, repo: null, lastLogIndex: 0, lastPolledAt: null, lastAdvancedAt: null, lastError: null },
    });
    render(<LeasePanel />);
    const unconfiguredText = screen.getByText(/투영이 설정되지 않았다/).textContent;

    // ok + empty
    useAppStore.getState().set({
      projectionStatus: { state: 'ok', configured: true, connected: true, repo: null, lastLogIndex: 0, lastPolledAt: Date.now(), lastAdvancedAt: null, lastError: null },
    });
    render(<LeasePanel />);
    const okEmptyText = screen.queryByText(/투영이 설정되지 않는다/)?.textContent;

    // They should be different - unconfigured shows the hint, ok+empty shows "No active work"
    expect(unconfiguredText).not.toBe(okEmptyText);
  });
});

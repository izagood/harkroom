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
});

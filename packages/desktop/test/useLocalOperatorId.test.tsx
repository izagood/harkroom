/** 지금 커뮤니티가 바뀌면 「이 맥」 오퍼레이터 id 를 다시 읽는다(security #1455 n1). */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';

let baseUrl = 'https://a.example.com';
vi.mock('../src/state/controller', () => ({ getController: () => ({ api: { baseUrl } }) }));

import { useCommunityRegistry } from '../src/state/communities';
import { useLocalOperatorId } from '../src/lib/useLocalOperatorId';

function Probe() {
  return <span data-testid="op">{String(useLocalOperatorId())}</span>;
}

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('useLocalOperatorId', () => {
  it('커뮤니티를 바꾸면 그 커뮤니티의 오퍼레이터 id 로 다시 읽는다 — 다시 마운트하지 않아도', async () => {
    (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => cmd === 'operator_agents_list'
        ? { communities: [
          { baseUrl: 'https://a.example.com', registered: true, operatorId: 'op-a' },
          { baseUrl: 'https://b.example.com', registered: true, operatorId: 'op-b' },
        ] }
        : {},
    };
    const before = useCommunityRegistry.getState();
    useCommunityRegistry.setState({
      entries: [{ ...before.entries[0]!, id: 'c-a', baseUrl: 'https://a.example.com' }, { ...before.entries[0]!, id: 'c-b', baseUrl: 'https://b.example.com' }],
      activeId: 'c-a',
    });
    try {
      render(<Probe />);
      await waitFor(() => expect(screen.getByTestId('op').textContent).toBe('op-a'));
      baseUrl = 'https://b.example.com';
      act(() => { useCommunityRegistry.setState({ activeId: 'c-b' }); });
      await waitFor(() => expect(screen.getByTestId('op').textContent).toBe('op-b'));
    } finally {
      useCommunityRegistry.setState(before, true);
    }
  });
});

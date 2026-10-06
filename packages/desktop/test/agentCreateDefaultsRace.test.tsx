/**
 * **기본값이 막 온 찰나에 「새 에이전트」를 눌러도 폼이 뜬다.** `agentDefaults` 응답이 풀린 뒤
 * React 가 다시 그리기 전에 누르면, 버튼의 클로저는 아직 `defaults === null` 인 렌더의 것이다.
 * 그 `startNew` 가 초안을 `null` 로 덮어 「Loading the defaults…」 상자가 영영 남았다 — CI 의
 * `agentCreatedToast` 「× 로 바로 닫힌다」 플레이크(10-01·10-06 세 번)가 이 모양이었다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { AgentDefaults } from '@harkroom/shared';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

vi.mock('../src/lib/operatorLocal', () => ({
  hasOperatorLocalSurface: () => false,
  listLocalAgents: async () => ({ communities: [] }),
  setLocalAgent: async () => undefined,
  removeLocalAgent: async () => undefined,
  registerLocalOperator: async () => ({ operatorId: 'op-1', name: 'n', baseUrl: 'http://x' }),
}));

beforeEach(() => {
  usePrefsStore.getState().setLocale('en');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc('admin-1', 'admin', 'human', true), connected: true, online: [] });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('새 에이전트 — 기본값 응답과 누름이 엇갈릴 때', () => {
  it('응답이 풀리고 다시 그리기 전에 눌러도 초안이 채워진다', async () => {
    let resolveDefaults!: (d: AgentDefaults) => void;
    setController({
      api: { baseUrl: 'http://x' },
      listAgents: vi.fn(async () => []),
      listPats: vi.fn(async () => []),
      agentMemory: vi.fn(async () => []),
      agentDefaults: vi.fn(() => new Promise<AgentDefaults>((r) => { resolveDefaults = r; })),
      operators: vi.fn(async () => []),
    } as unknown as ControllerType);
    render(<AgentsSettings />);
    const create = await screen.findByTestId('agent-create');
    // 응답이 풀리고 `.then` 까지 돈다 — 그러나 act 밖이라 React 는 아직 다시 그리지 않았다.
    resolveDefaults({ harness: 'claude-code', model: null, effort: null } as AgentDefaults);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    act(() => { create.click(); });
    await act(async () => {});
    expect(screen.queryByTestId('agent-defaults-box')).toBeNull();
    expect(screen.getByLabelText('Agent name')).toBeTruthy();
  });
});

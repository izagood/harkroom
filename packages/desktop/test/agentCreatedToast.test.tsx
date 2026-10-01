/**
 * **만들었다는 것이 보인다.** 만들기 화면은 만든 뒤에도 그대로 서 있어서, 성공해도 바뀌는
 * 것이 없었다 — 사람은 격자로 돌아가 카드를 찾아봐야 만들어졌는지 알았다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import { AgentsSettings, CREATED_TOAST_MS } from '../src/components/settings/AgentsSettings';
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
afterEach(() => { cleanup(); vi.useRealTimers(); usePrefsStore.getState().setLocale('system'); });

function setupUi(createAgent: (...a: unknown[]) => Promise<unknown>) {
  setController({
    api: { baseUrl: 'http://x' },
    listAgents: vi.fn(async () => []),
    listPats: vi.fn(async () => []),
    agentMemory: vi.fn(async () => []),
    agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
    operators: vi.fn(async () => []),
    createAgent: vi.fn(createAgent),
  } as unknown as ControllerType);
}

async function create(name: string) {
  render(<AgentsSettings />);
  (await screen.findByTestId('agent-create')).click();
  await waitFor(() => expect(screen.queryByTestId('agent-defaults-box')).toBeNull(), { timeout: 5000 });
  fireEvent.change(await screen.findByLabelText('Agent name', {}, { timeout: 5000 }), { target: { value: name } });
  // 기존 만들기 테스트와 같이 접근성 이름으로 집는다 — `Button` 프리미티브는 testid 를 넘기지 않는다.
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
}

describe('만들기 성공 팝업', () => {
  it('만들면 이름을 담은 팝업이 뜨고, 시간이 지나면 걷힌다', async () => {
    // 팝업의 타이머가 걸리기 **전에** 가짜 시계를 깐다. 시간은 흐르게 둔다 — findBy 가 그 시계로 기다린다.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupUi(async () => ({ agent: { id: 'a-1', handle: 'newbie' } as AgentView, poolError: null, attachError: null }));
    await create('newbie');
    const toast = await screen.findByTestId('agent-created-toast', {}, { timeout: 5000 });
    expect(toast.textContent).toContain('@newbie');
    expect(toast.getAttribute('role')).toBe('status');
    // 팝업이 그려진 것과 타이머가 걸린 것은 다른 시점이다(effect 는 그린 뒤에 돈다) — 먼저 비운다.
    await act(async () => {});
    act(() => { vi.advanceTimersByTime(CREATED_TOAST_MS - 100); });
    expect(screen.queryByTestId('agent-created-toast')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId('agent-created-toast')).toBeNull();
  });

  it('× 로 바로 닫힌다', async () => {
    setupUi(async () => ({ agent: { id: 'a-1', handle: 'newbie' } as AgentView, poolError: null, attachError: null }));
    await create('newbie');
    const toast = await screen.findByTestId('agent-created-toast', {}, { timeout: 5000 });
    fireEvent.click(toast.querySelector('button')!);
    expect(screen.queryByTestId('agent-created-toast')).toBeNull();
  });

  it('실패하면 뜨지 않는다', async () => {
    setupUi(async () => { throw new Error('taken'); });
    await create('newbie');
    await screen.findByText(/was not created/, {}, { timeout: 5000 });
    expect(screen.queryByTestId('agent-created-toast')).toBeNull();
  });
});

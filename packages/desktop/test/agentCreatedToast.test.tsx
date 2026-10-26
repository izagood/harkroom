/**
 * **만들었다는 것이 보인다.** 만들기 화면은 만든 뒤에도 그대로 서 있어서, 성공해도 바뀌는
 * 것이 없었다 — 사람은 격자로 돌아가 카드를 찾아봐야 만들어졌는지 알았다.
 *
 * 그래서 만들면 **팝업이 뜨고 격자(목록)로 넘어가며, 방금 만든 카드가 팝업 동안 강조된다**
 * (스레드 fe5505ea).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import { AgentsSettings, CREATED_TOAST_MS } from '../src/components/settings/AgentsSettings';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';
import { ApiError } from '../src/lib/api';

vi.mock('../src/lib/operatorLocal', () => ({
  hasOperatorLocalSurface: () => false,
  listLocalAgents: async () => ({ communities: [] }),
  setLocalAgent: async () => undefined,
  removeLocalAgent: async () => undefined,
  onLocalAgentsChanged: () => () => {},
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
  // 서버처럼 — 만든 뒤의 다시 읽기는 만든 것을 돌려준다.
  const made: AgentView[] = [];
  setController({
    api: { baseUrl: 'http://x' },
    listAgents: vi.fn(async () => [...made]),
    listPats: vi.fn(async () => []),
    agentMemory: vi.fn(async () => []),
    agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
    operators: vi.fn(async () => []),
    createAgent: vi.fn(async (...a: unknown[]) => {
      const r = await createAgent(...a) as { agent: AgentView };
      made.push(r.agent);
      return r;
    }),
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

  it('만들면 목록으로 넘어가고, 방금 만든 카드가 팝업 동안만 강조된다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupUi(async () => ({ agent: { id: 'a-1', handle: 'newbie' } as AgentView, poolError: null, attachError: null }));
    await create('newbie');
    await screen.findByTestId('agent-created-toast', {}, { timeout: 5000 });
    // 상세(만들기)가 아니라 격자다 — 돌아가는 길이 없고 「만들기」 카드가 선다.
    expect(screen.queryByTestId('agent-back')).toBeNull();
    expect(screen.getByTestId('agent-create')).toBeTruthy();
    const card = await screen.findByTestId('agent-card-newbie', {}, { timeout: 5000 });
    expect(card.getAttribute('data-selected')).toBe('true');
    await act(async () => {});
    act(() => { vi.advanceTimersByTime(CREATED_TOAST_MS + 100); });
    expect(screen.queryByTestId('agent-created-toast')).toBeNull();
    expect(screen.getByTestId('agent-card-newbie').getAttribute('data-selected')).toBe('false');
  });

  it('풀 배정이 실패해도 목록으로 넘어가고, 그 이유는 목록 위에 남는다', async () => {
    setupUi(async () => ({ agent: { id: 'a-1', handle: 'newbie' } as AgentView, poolError: 'disk full', attachError: null }));
    await create('newbie');
    await screen.findByTestId('agent-created-toast', {}, { timeout: 5000 });
    expect(screen.queryByTestId('agent-back')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('disk full');
  });

  it('실패하면 뜨지 않는다', async () => {
    setupUi(async () => { throw new Error('taken'); });
    await create('newbie');
    await screen.findByText(/was not created/, {}, { timeout: 5000 });
    expect(screen.queryByTestId('agent-created-toast')).toBeNull();
    // 만들기 화면에 그대로 남는다 — 고쳐서 다시 누를 자리다.
    expect(screen.getByTestId('agent-back')).toBeTruthy();
  });

  it('이름이 겹치면(409 handle_taken) 그 이름을 짚어 말하고, 서버 원문은 싣지 않는다', async () => {
    setupUi(async () => { throw new ApiError(409, 'handle_taken', 'this handle is already taken'); });
    await create('newbie');
    const alert = await screen.findByText(/@newbie is already taken/, {}, { timeout: 5000 });
    expect(alert.textContent).not.toContain('this handle is already taken');
    expect(screen.queryByText(/was not created/)).toBeNull();
    expect(screen.getByTestId('agent-back')).toBeTruthy();
  });
});

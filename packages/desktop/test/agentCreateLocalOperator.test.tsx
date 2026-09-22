/**
 * **만들면 곧바로 돈다** — 새 에이전트의 기본 배정처는 이 기기의 오퍼레이터다(#856).
 *
 * 앞 판본은 계정만 만들고 끝났다: 러너를 띄우는 것은 오퍼레이터이고 오퍼레이터는 배정받은
 * 것만 띄우는데, 만들기 화면에는 로컬 설정도 배정도 없었다. 그래서 만든 에이전트는 화면에
 * 서 있는 채로 아무 멘션에도 답하지 않았고, 왜 그런지는 어디에도 적혀 있지 않았다.
 *
 * 여기서 재는 것 둘:
 *  1. 화면이 **기본으로 켜진 채** 이 기기를 만들기 호출에 싣는가(끄면 싣지 않는가)
 *  2. 컨트롤러가 **능력 → 배정** 순서로 쓰고, 그 사이 경합(`not_capable`)을 기다리는가
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError } from '../src/lib/api';
import { acc, fakeApi } from './helpers/fakeApi';

const setLocalAgent = vi.fn(async () => undefined);
vi.mock('../src/lib/operatorLocal', () => ({
  hasOperatorLocalSurface: () => true,
  listLocalAgents: async () => ({
    communities: [{ baseUrl: 'http://x', registered: true, operatorId: 'op-1', agents: {} }],
  }),
  setLocalAgent: (...args: unknown[]) => setLocalAgent(...(args as [])),
  removeLocalAgent: async () => undefined,
  registerLocalOperator: async () => ({ operatorId: 'op-1', name: 'n', baseUrl: 'http://x' }),
}));

const ME_ID = 'admin-1';
const made = { id: 'agent-new' } as unknown as AgentView;

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc(ME_ID, 'admin', 'human', true), connected: true, online: [] });
  setLocalAgent.mockClear();
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

function setupUi() {
  const createAgent = vi.fn(async (_input: unknown, _opts?: unknown) => ({ agent: made, poolError: null, attachError: null }));
  setController({
    api: { baseUrl: 'http://x' },
    listAgents: vi.fn(async () => []),
    listPats: vi.fn(async () => []),
    agentMemory: vi.fn(async () => []),
    agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
    operators: vi.fn(async () => []),
    createAgent,
  } as unknown as ControllerType);
  return createAgent;
}

async function openCreate() {
  render(<AgentsSettings />);
  (await screen.findByTestId('agent-create')).click();
  // 기본값이 온 뒤에야 폼이 있다 — `AgentsSettings.test.tsx` 의 `openCreate` 와 같은 이유다.
  await waitFor(() => expect(screen.queryByTestId('agent-defaults-box')).toBeNull());
}

describe('만들기 — 이 기기가 기본 배정처', () => {
  it('체크박스가 기본으로 켜져 있고, 만들기에 이 기기의 오퍼레이터가 실린다', async () => {
    const createAgent = setupUi();
    await openCreate();
    const box = await screen.findByLabelText('이 기기에서 돌린다');
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'newbie' } });
    screen.getByRole('button', { name: '에이전트 만들기' }).click();
    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0]![1]).toMatchObject({ localOperator: { baseUrl: 'http://x', operatorId: 'op-1' } });
  });

  it('끄면 싣지 않는다 — 다른 기기에서 돌릴 에이전트는 여기에 먼저 뜨면 안 된다', async () => {
    const createAgent = setupUi();
    await openCreate();
    fireEvent.click(await screen.findByLabelText('이 기기에서 돌린다'));
    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'newbie' } });
    screen.getByRole('button', { name: '에이전트 만들기' }).click();
    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0]![1]).toBeUndefined();
  });
});

describe('controller.createAgent — 능력 → 배정', () => {
  it('로컬 설정을 먼저 쓰고 그 다음 배정한다', async () => {
    const order: string[] = [];
    setLocalAgent.mockImplementation(async () => { order.push('local'); });
    const api = fakeApi({
      createAgent: vi.fn(async () => made),
      assignAgent: vi.fn(async () => { order.push('assign'); return {} as never; }),
    });
    const c = new Controller(api, (() => ({ close: () => {} })) as never);
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, {
      localOperator: { baseUrl: 'http://x', operatorId: 'op-1', workingDir: '~/dev/x' },
    });
    expect(out.attachError).toBeNull();
    expect(order).toEqual(['local', 'assign']);
    expect(setLocalAgent).toHaveBeenCalledWith('http://x', 'agent-new', { workingDir: '~/dev/x' });
  });

  it('배정이 not_capable 이면 기다렸다 다시 부른다 — 능력 프레임이 아직 서버에 안 닿은 것이다', async () => {
    let calls = 0;
    const assignAgent = vi.fn(async () => {
      if (++calls < 3) throw new ApiError(409, 'not_capable', 'nope');
      return {} as never;
    });
    const c = new Controller(fakeApi({ createAgent: vi.fn(async () => made), assignAgent }), (() => ({ close: () => {} })) as never);
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, {
      localOperator: { baseUrl: 'http://x', operatorId: 'op-1' },
    });
    expect(calls).toBe(3);
    expect(out.attachError).toBeNull();
  });

  it('끝내 실패해도 에이전트는 만들어진 것이다 — 사유만 돌려준다', async () => {
    const assignAgent = vi.fn(async () => { throw new ApiError(403, 'forbidden', '권한이 없다'); });
    const c = new Controller(fakeApi({ createAgent: vi.fn(async () => made), assignAgent }), (() => ({ close: () => {} })) as never);
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, {
      localOperator: { baseUrl: 'http://x', operatorId: 'op-1' },
    });
    expect(out.agent).toBe(made);
    expect(out.attachError).toContain('권한이 없다');
    expect(assignAgent).toHaveBeenCalledTimes(1);
  });
});

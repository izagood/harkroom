/**
 * **만들기 문은 역할이 아니라 능력을 본다.** 서버 `POST /accounts/agents` 는 `requireCap('agent.create')` 라
 * member 도 grant 를 받으면 만든다. 그런데 화면이 `isAdmin` 으로 문을 그려서, grant 를 받은 member 에게도
 * [+ 만들기]가 끝내 안 섰다 — 권한이 없는 member 에게는 왜 없는지도 안 말했다.
 *
 * 그리고 권한이 바뀌면(`grant.changed`) 내 `/auth/me` 를 다시 읽는다 — 앱을 껐다 켜지 않아도 문이 선다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import type { MeView } from '@harkroom/shared';
import { acc, accountsResult, fakeApi, fakeWsFactory } from './helpers/fakeApi';

vi.mock('../src/lib/operatorLocal', () => ({
  hasOperatorLocalSurface: () => false,
  listLocalAgents: async () => ({ communities: [] }),
  setLocalAgent: async () => undefined,
  removeLocalAgent: async () => undefined,
  onLocalAgentsChanged: () => () => {},
  registerLocalOperator: async () => ({ operatorId: 'op-1', name: 'n', baseUrl: 'http://x' }),
}));

const owner = { ...acc('o-1', 'boss', 'human', true), role: 'owner' as const };

function seed(me: ReturnType<typeof acc>) {
  useActiveStore.getState().set({
    me, connected: true, online: [],
    accounts: { [owner.id]: owner, [me.id]: me },
  });
  setController({
    api: { baseUrl: 'http://x' },
    listAgents: vi.fn(async () => []),
    listPats: vi.fn(async () => []),
    agentMemory: vi.fn(async () => []),
    agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
    operators: vi.fn(async () => []),
  } as unknown as ControllerType);
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('en');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('에이전트 만들기 문', () => {
  it('agent.create 를 받은 member 에게 [+ 만들기]가 선다', async () => {
    seed(acc('m-1', 'dev', 'human', false, { capabilities: ['operator.register', 'agent.create'] }));
    render(<AgentsSettings />);
    expect(await screen.findByTestId('agent-create')).toBeTruthy();
    expect(screen.queryByTestId('agent-create-blocked')).toBeNull();
  });

  it('권한이 없는 member 에게는 문 대신 이유와 청할 사람(owner)을 보인다', async () => {
    seed(acc('m-1', 'dev'));
    render(<AgentsSettings />);
    const blocked = await screen.findByTestId('agent-create-blocked');
    expect(blocked.textContent).toContain('You can’t create agents');
    expect(blocked.textContent).toContain('@boss');
    expect(screen.queryByTestId('agent-create')).toBeNull();
  });

  it('guest 에게는 문도 안내도 없다', async () => {
    seed(acc('g-1', 'visitor', 'human', false, { role: 'guest', capabilities: [] }));
    render(<AgentsSettings />);
    await screen.findByTestId('agent-grid');
    expect(screen.queryByTestId('agent-create')).toBeNull();
    expect(screen.queryByTestId('agent-create-blocked')).toBeNull();
  });
});

describe('grant.changed', () => {
  it('내 권한이 바뀌면 /auth/me 를 다시 읽어 capabilities 를 갈아 끼운다', async () => {
    const before = acc('u1', 'dev');
    const after = acc('u1', 'dev', 'human', false, { capabilities: ['operator.register', 'agent.create'] });
    const me = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi({ me, accounts: vi.fn(async () => accountsResult([before])) }), makeWs);
    await c.start();
    expect((useActiveStore.getState().me as MeView | null)?.capabilities).not.toContain('agent.create');
    callbacks.current!.onEvent({ type: 'grant.changed', accountId: 'u1', audience: 'all' });
    await waitFor(() => expect((useActiveStore.getState().me as MeView | null)?.capabilities).toContain('agent.create'));
    expect(me).toHaveBeenCalledTimes(2);
  });

  it('남의 에이전트 grant 로는 내 정보를 다시 읽지 않는다', async () => {
    const me = vi.fn(async () => acc('u1', 'dev'));
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi({ me }), makeWs);
    await c.start();
    callbacks.current!.onEvent({ type: 'grant.changed', accountId: 'u2', audience: 'all' });
    await new Promise((r) => setTimeout(r, 0));
    expect(me).toHaveBeenCalledTimes(1);
  });
});

/**
 * 호출 범위·자격증명 절(스펙 2026-09-20 §6). 판정은 전부 서버가 한다 — 여기서 재는 것은
 * 고른 값이 그 자리에서 컨트롤러 표면(`updateAgent`·`addInvoker`·`removeInvoker`)에 닿는가,
 * 서버의 거절 코드가 사람 말로 보이는가, 명단과 레지스트리 체크가 응답을 그대로 앉히는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import { AgentScopeSection } from '../src/components/settings/AgentScopeSection';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError } from '../src/lib/api';
import { acc } from './helpers/fakeApi';

const ME_ID = 'owner-1';
const agent = (overrides: Partial<AgentView> = {}): AgentView => ({
  ...(acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME_ID }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, claudeLane: null, assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], mcpServers: [], ...overrides,
});

function setup(over: Partial<Record<string, unknown>> = {}) {
  const c = {
    updateAgent: vi.fn(async (_id: string, patch: Record<string, unknown>) => agent(patch as Partial<AgentView>)),
    addInvoker: vi.fn(async (_id: string, accountId: string) => agent({ invokeScope: 'list', invokers: [accountId] })),
    removeInvoker: vi.fn(async () => agent({ invokeScope: 'list', invokers: [] })),
    mcpServers: vi.fn(async () => [
      { name: 'github', credentialKind: 'community', createdBy: null, createdAt: '' },
      { name: 'slack', credentialKind: 'personal', createdBy: null, createdAt: '' },
    ]),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({
    me: acc(ME_ID, 'owner'),
    accounts: { [ME_ID]: acc(ME_ID, 'owner'), 'u-2': acc('u-2', 'bob'), 'agent-1': acc('agent-1', 'alpha', 'agent') },
  });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('AgentScopeSection', () => {
  it('호출 범위를 고르면 그 자리에서 updateAgent 에 닿고 응답이 앉는다', async () => {
    const c = setup();
    const onUpdated = vi.fn();
    render(<AgentScopeSection agent={agent()} onUpdated={onUpdated} />);
    fireEvent.change(screen.getByLabelText('이 에이전트를 부를 수 있는 사람'), { target: { value: 'owner' } });
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { invokeScope: 'owner' }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ invokeScope: 'owner' }));
  });

  it('서버의 거절 코드를 사람 말로 옮긴다 — scope_widening', async () => {
    setup({ updateAgent: vi.fn(async () => { throw new ApiError(400, 'scope_widening', 'x'); }) });
    render(<AgentScopeSection agent={agent({ invokeScope: 'owner' })} onUpdated={() => {}} />);
    fireEvent.change(screen.getByLabelText('이 에이전트를 부를 수 있는 사람'), { target: { value: 'community' } });
    const err = await screen.findByTestId('agent-scope-error');
    expect(err.textContent).toContain('넓힐 수 없다');
  });

  it('list 스코프면 명단이 보이고, 넣기·빼기가 컨트롤러에 닿는다', async () => {
    const c = setup();
    const onUpdated = vi.fn();
    render(<AgentScopeSection agent={agent({ invokeScope: 'list', invokers: [] })} onUpdated={onUpdated} />);
    expect(screen.getByTestId('agent-invokers')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('넣기'), { target: { value: 'u-2' } });
    fireEvent.click(screen.getByText('넣기'));
    await waitFor(() => expect(c.addInvoker).toHaveBeenCalledWith('agent-1', 'u-2'));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ invokers: ['u-2'] }));
    cleanup();
    render(<AgentScopeSection agent={agent({ invokeScope: 'list', invokers: ['u-2'] })} onUpdated={onUpdated} />);
    fireEvent.click(screen.getByLabelText('@bob 빼기'));
    await waitFor(() => expect(c.removeInvoker).toHaveBeenCalledWith('agent-1', 'u-2'));
  });

  it('community 스코프면 명단이 없다', () => {
    setup();
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    expect(screen.queryByTestId('agent-invokers')).toBeNull();
  });

  it('MCP 체크는 레지스트리에서 오고, 켜고 끄면 mcpServers 전체를 보낸다', async () => {
    const c = setup();
    render(<AgentScopeSection agent={agent({ mcpServers: ['github'] })} onUpdated={() => {}} />);
    const github = await screen.findByLabelText('github') as HTMLInputElement;
    expect(github.checked).toBe(true);
    fireEvent.click(screen.getByLabelText('slack'));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['github', 'slack'] }));
    fireEvent.click(github);
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: [] }));
  });
});

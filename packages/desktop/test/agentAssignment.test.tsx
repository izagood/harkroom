/**
 * 에이전트 상세의 **배정** — 스펙 2026-09-20 §3.
 *
 * 앱이 러너를 띄우지 않으므로 "이 에이전트를 어디서 돌릴까"는 앱이 서버에 **배정**으로
 * 말한다. 여기서 재는 것은 그 조작이 컨트롤러 표면(`assignAgent`·`unassignAgent`)에
 * 닿는가와, 지금 배정이 화면에 보이는가다. 실제로 러너가 뜨는지는 오퍼레이터의 일이라
 * 여기서 재지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView, OperatorView } from '@harkroom/shared';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

const ME_ID = 'admin-1';
const AGENT_ID = 'agent-alpha';

const agent = (overrides: Partial<AgentView> = {}): AgentView => ({
  ...(acc(AGENT_ID, 'alpha', 'agent', false, { ownerAccountId: ME_ID }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, claudeLane: null, assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], mcpServers: [], ...overrides,
});

const op = (id: string, name: string): OperatorView => ({
  id, name, ownerAccountId: ME_ID, createdAt: '2026-09-21T00:00:00Z', lastSeenAt: null, revokedAt: null, online: true,
});

function setup(a: AgentView, operators: OperatorView[]) {
  const assigned = { agentId: AGENT_ID, operatorId: 'op-1', assignedBy: ME_ID, assignedAt: '2026-09-21T00:00:00Z' };
  const c = {
    listAgents: vi.fn(async () => [a]),
    listPats: vi.fn(async () => []),
    agentMemory: vi.fn(async () => []),
    agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
    operators: vi.fn(async () => operators),
    assignAgent: vi.fn(async () => assigned),
    unassignAgent: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc(ME_ID, 'admin', 'human', true), connected: true, online: [] });
});
afterEach(() => cleanup());

describe('에이전트 배정', () => {
  it('배정이 없으면 오퍼레이터 고르개가 뜨고, 고르면 assignAgent 에 닿는다', async () => {
    const c = setup(agent(), [op('op-1', 'jaebin-mbp'), op('op-2', 'gpu-box')]);
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    const select = await screen.findByLabelText('오퍼레이터 배정');
    fireEvent.change(select, { target: { value: 'op-1' } });
    await waitFor(() => expect(c.assignAgent).toHaveBeenCalledWith(AGENT_ID, 'op-1'));
    // 응답의 배정이 화면에 선다 — 목록을 다시 읽지 않아도.
    await waitFor(() => expect(screen.getByTestId('agent-assignment-current').textContent).toContain('jaebin-mbp'));
  });

  it('배정이 있으면 어느 오퍼레이터인지 보이고, 해제는 unassignAgent 에 닿는다', async () => {
    const a = agent({ assignment: { agentId: AGENT_ID, operatorId: 'op-2', assignedBy: ME_ID, assignedAt: '2026-09-21T00:00:00Z' } });
    const c = setup(a, [op('op-1', 'jaebin-mbp'), op('op-2', 'gpu-box')]);
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    await waitFor(() => expect(screen.getByTestId('agent-assignment-current').textContent).toContain('gpu-box'));
    fireEvent.click(screen.getByRole('button', { name: '배정 해제' }));
    await waitFor(() => expect(c.unassignAgent).toHaveBeenCalledWith(AGENT_ID));
  });

  it('등록된 오퍼레이터가 없으면 고르개 대신 Operators 로 가라고 말한다', async () => {
    setup(agent(), []);
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    await screen.findByText(/등록된 오퍼레이터가 없다/);
    expect(screen.queryByLabelText('오퍼레이터 배정')).toBeNull();
  });
});

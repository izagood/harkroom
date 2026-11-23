/**
 * 에이전트 상세의 **배정** — 스펙 2026-09-20 §3.
 *
 * 앱이 러너를 띄우지 않으므로 "이 에이전트를 어디서 돌릴까"는 앱이 서버에 **배정**으로
 * 말한다. 여기서 재는 것은 그 조작이 컨트롤러 표면(`assignAgent`·`unassignAgent`)에
 * 닿는가와, 지금 배정이 화면에 보이는가다. 실제로 러너가 뜨는지는 오퍼레이터의 일이라
 * 여기서 재지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AgentView, OperatorView } from '@harkroom/shared';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';
import { ApiError } from '../src/lib/api';

beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

const ME_ID = 'admin-1';
const AGENT_ID = 'agent-alpha';

const agent = (overrides: Partial<AgentView> = {}): AgentView => ({
  ...(acc(AGENT_ID, 'alpha', 'agent', false, { ownerAccountId: ME_ID }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [], ...overrides,
});

const op = (id: string, name: string): OperatorView => ({
  id, name, ownerAccountId: ME_ID, createdAt: '2026-09-21T00:00:00Z', lastSeenAt: null, revokedAt: null, online: true, version: null,
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
    const c = setup(agent(), [op('op-1', 'alice-mbp'), op('op-2', 'gpu-box')]);
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    const select = await screen.findByLabelText('오퍼레이터 배정');
    fireEvent.change(select, { target: { value: 'op-1' } });
    await waitFor(() => expect(c.assignAgent).toHaveBeenCalledWith(AGENT_ID, 'op-1'));
    // 응답의 배정이 화면에 선다 — 목록을 다시 읽지 않아도.
    await waitFor(() => expect(screen.getByTestId('agent-assignment-current').textContent).toContain('alice-mbp'));
  });

  it('배정이 있으면 어느 오퍼레이터인지 보이고, 해제는 unassignAgent 에 닿는다', async () => {
    const a = agent({ assignment: { agentId: AGENT_ID, operatorId: 'op-2', assignedBy: ME_ID, assignedAt: '2026-09-21T00:00:00Z' } });
    const c = setup(a, [op('op-1', 'alice-mbp'), op('op-2', 'gpu-box')]);
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    fireEvent.click(await screen.findByTestId('agent-tab-run'));
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

  it('서버가 not_capable 로 거절하면 문장 아래 칸에 그 기기에서 칠 등록 명령(agent add)을 따로 보이고 복사한다', async () => {
    const c = setup(agent(), [op('op-1', 'linux-box')]);
    c.assignAgent.mockRejectedValue(new ApiError(409, 'not_capable', 'nope'));
    (c as unknown as { api: { baseUrl: string } }).api = { baseUrl: 'https://chat.example.com' };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    fireEvent.change(await screen.findByLabelText('오퍼레이터 배정'), { target: { value: 'op-1' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('로컬 설정에 이 에이전트가 없어 거절했다');
    // 명령은 문장에 섞지 않는다 — 따로 선 칸에 한 덩어리로 있어야 그대로 복사된다.
    expect(alert.textContent).not.toContain('--base-url');
    const command = `harkroom-operator-rs agent add ${AGENT_ID} --base-url https://chat.example.com`;
    const box = screen.getByTestId('error-command');
    expect(box.querySelector('code')?.textContent).toBe(command);
    fireEvent.click(within(box).getByRole('button', { name: '복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    await within(box).findByText('복사됨');
  });

  it('커뮤니티 주소를 모르면 명령 칸을 빼고 문장만 보인다 — 자리표시 글자가 든 명령을 붙여 넣게 하지 않는다', async () => {
    const c = setup(agent(), [op('op-1', 'linux-box')]);
    c.assignAgent.mockRejectedValue(new ApiError(409, 'not_capable', 'nope'));
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    fireEvent.change(await screen.findByLabelText('오퍼레이터 배정'), { target: { value: 'op-1' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('로컬 설정에 이 에이전트가 없어 거절했다');
    expect(screen.queryByTestId('error-command')).toBeNull();
    expect(document.body.textContent).not.toContain('<url>');
  });
});

describe('오퍼레이터의 배정 거절 사유', () => {
  it('서버가 붙여 준 runnerRefusal 을 배정 절에 사람 말로 보인다', async () => {
    setup(agent({ assignment: { agentId: AGENT_ID, operatorId: 'op-1', assignedBy: ME_ID, assignedAt: '2026-09-21T00:00:00Z' },
      runnerRefusal: { reason: 'mcp_server_missing:ghost', at: '2026-09-21T00:00:00Z' } }), [op('op-1', 'alice-mbp')]);
    render(<AgentsSettings />);
    (await screen.findByRole('button', { name: /alpha/ })).click();
    const line = await screen.findByTestId('agent-assignment-refused');
    expect(line.textContent).toContain('ghost');
    expect(line.textContent).toContain('거절했다');
  });
});

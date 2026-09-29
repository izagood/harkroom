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
  lastTurnAt: null, claudeLane: null, assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [], ...overrides,
});

function setup(over: Partial<Record<string, unknown>> = {}) {
  const c = {
    updateAgent: vi.fn(async (_id: string, patch: Record<string, unknown>) => agent(patch as Partial<AgentView>)),
    addInvoker: vi.fn(async (_id: string, accountId: string) => agent({ invokeScope: 'list', invokers: [accountId] })),
    removeInvoker: vi.fn(async () => agent({ invokeScope: 'list', invokers: [], delegates: [] })),
    addDelegate: vi.fn(async (_id: string, delegateId: string) => agent({ invokeScope: 'owner', delegates: [delegateId] })),
    removeDelegate: vi.fn(async () => agent({ invokeScope: 'owner', delegates: [] })),
    putMcpServer: vi.fn(async (name: string, credentialKind: string) => ({ name, credentialKind, createdBy: null, createdAt: '' })),
    restartAgent: vi.fn(async () => ({ operatorId: 'op-1' })),
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
    render(<AgentScopeSection agent={agent({ invokeScope: 'list', invokers: [], delegates: [] })} onUpdated={onUpdated} />);
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
    render(<AgentScopeSection agent={agent({ mcpServers: ['github'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    const github = await screen.findByLabelText('github') as HTMLInputElement;
    expect(github.checked).toBe(true);
    fireEvent.click(screen.getByLabelText('slack'));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['github', 'slack'] }));
    fireEvent.click(github);
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: [] }));
  });
});

/** 이 머신의 오퍼레이터 표면 — Tauri invoke 를 가짜로 건다. */
function fakeLocal(servers: { name: string; source?: 'operator' | 'claude' }[]) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'operator_mcp_list') {
        return { servers: servers.map((x) => ({ name: x.name, source: x.source ?? 'operator', transport: 'http', target: 'https://x', args: [], envKeys: [], headerKeys: [], oauth: false })) };
      }
      return {};
    },
  };
  return calls;
}

describe('AgentMcpSection — 한 절에서 끝낸다', () => {
  afterEach(() => { delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

  it('이 머신에 정의가 없는 이름은 켜지 못한다 — 켜면 오퍼레이터가 에이전트를 안 띄운다', async () => {
    fakeLocal([{ name: 'slack' }]);
    const c = setup();
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    expect(await screen.findByTestId('agent-mcp-missing-github')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('github'));
    expect((await screen.findByTestId('agent-mcp-error')).textContent).toContain('github');
    expect(c.updateAgent).not.toHaveBeenCalled();
  });

  it('personal 서버를 켜면 확인을 받고 scope 를 같은 PATCH 로 바꾼다', async () => {
    fakeLocal([{ name: 'slack' }, { name: 'github' }]);
    const c = setup();
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByLabelText('slack'));
    expect(await screen.findByTestId('agent-mcp-confirm-personal')).toBeTruthy();
    expect(c.updateAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('agent-mcp-confirm-yes'));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1',
      { mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' }));
    expect(await screen.findByTestId('agent-mcp-notice')).toBeTruthy();
  });

  it('확인창이 이 에이전트가 든 팀을 말한다 — owner 로 좁히면 남의 팀 부름에서 빠진다(068)', async () => {
    fakeLocal([{ name: 'slack' }, { name: 'github' }]);
    setup({
      listTeams: vi.fn(async () => [{ id: 't1', name: 'udc-team' }, { id: 't2', name: 'other' }]),
      getTeam: vi.fn(async (id: string) => ({
        team: { id },
        members: id === 't1' ? [{ accountId: 'agent-1', handle: 'alpha', disabled: false }] : [],
      })),
    });
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByLabelText('slack'));
    const line = await screen.findByTestId('agent-mcp-confirm-teams');
    expect(line.textContent).toContain('@udc-team');
    expect(line.textContent).not.toContain('@other');
  });

  it('[추가] 는 레지스트리 이름 → 이 머신 정의 → 붙이기 순서다(프리셋 Jira)', async () => {
    const calls = fakeLocal([]);
    const order: string[] = [];
    const c = setup({
      mcpServers: vi.fn(async () => (order.includes('put')
        ? [{ name: 'jira', credentialKind: 'personal', createdBy: null, createdAt: '' }] : [])),
      putMcpServer: vi.fn(async () => { order.push('put'); return { name: 'jira', credentialKind: 'personal', createdBy: null, createdAt: '' }; }),
    });
    render(<AgentScopeSection agent={agent({ credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-add-open'));
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'jira' } });
    fireEvent.click(screen.getByTestId('agent-mcp-add-submit'));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['jira'] }));
    expect(c.putMcpServer).toHaveBeenCalledWith('jira', 'personal');
    const set = calls.find((x) => x.cmd === 'operator_mcp_set');
    expect(set?.args).toEqual({ name: 'jira', definition: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' } });
  });

  it('저장 뒤 [지금 재시작] 이 그 자리에서 agent.restart 를 부른다 — 멈춰 둔 에이전트에는 없다', async () => {
    fakeLocal([{ name: 'github' }, { name: 'slack' }]);
    const c = setup({ restartAgent: vi.fn(async () => ({ operatorId: 'op-1' })) });
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByLabelText('github'));
    fireEvent.click(await screen.findByTestId('agent-mcp-restart'));
    await waitFor(() => expect(c.restartAgent).toHaveBeenCalledWith('agent-1'));
    expect(screen.queryByTestId('agent-mcp-restart')).toBeNull();
    cleanup();
    setup();
    render(<AgentScopeSection agent={agent({ stopRequestedAt: '2026-09-28T00:00:00.000Z' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByLabelText('github'));
    await screen.findByTestId('agent-mcp-notice');
    expect(screen.queryByTestId('agent-mcp-restart')).toBeNull();
  });

  it('레지스트리 등록 권한이 없으면 막는다 — 정의도 붙이기도 하지 않는다', async () => {
    const calls = fakeLocal([]);
    const c = setup({
      mcpServers: vi.fn(async () => []),
      putMcpServer: vi.fn(async () => { throw new ApiError(403, 'forbidden', 'no'); }),
    });
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-add-open'));
    fireEvent.click(screen.getByTestId('agent-mcp-add-submit'));
    expect((await screen.findByTestId('agent-mcp-error')).textContent).toContain('agent.privileged');
    expect(calls.some((x) => x.cmd === 'operator_mcp_set')).toBe(false);
    expect(c.updateAgent).not.toHaveBeenCalled();
  });

  // 대리 호출자(서버 073). 후보는 서버와 같은 조건(같은 소유자·owner 범위)으로 걸러지고,
  // 고르면 addDelegate 에 닿는다. 조건 밖 줄은 애초에 보이지 않는다.
  it('owner 범위에서 대리 호출자 후보는 같은 소유자의 owner 에이전트만 보이고, 고르면 addDelegate 에 닿는다', async () => {
    const lead = agent({ id: 'agent-2', handle: 'lead', invokeScope: 'owner' } as Partial<AgentView>);
    const open = agent({ id: 'agent-3', handle: 'open', invokeScope: 'community' } as Partial<AgentView>);
    const foreign = agent({ id: 'agent-4', handle: 'foreign', invokeScope: 'owner', ownerAccountId: 'someone-else' } as Partial<AgentView>);
    const c = setup({ addDelegate: vi.fn(async (_id: string, d: string) => agent({ invokeScope: 'owner', delegates: [d] })) });
    const onUpdated = vi.fn();
    render(<AgentScopeSection agent={agent({ invokeScope: 'owner' })} agents={[agent({ invokeScope: 'owner' }), lead, open, foreign]} onUpdated={onUpdated} />);
    const box = screen.getByTestId('agent-delegates');
    const picker = box.querySelector('select')!;
    const values = [...picker.querySelectorAll('option')].map((o) => o.value).filter(Boolean);
    expect(values).toEqual(['agent-2']);
    fireEvent.change(picker, { target: { value: 'agent-2' } });
    fireEvent.click(box.querySelector('button:not([aria-label])') ?? box.querySelectorAll('button')[0]!);
    await waitFor(() => expect(c.addDelegate).toHaveBeenCalledWith('agent-1', 'agent-2'));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ delegates: ['agent-2'] }));
  });

  it('owner 가 아니면 대리 호출자 절을 그리지 않는다', () => {
    setup();
    render(<AgentScopeSection agent={agent({ invokeScope: 'list' })} agents={[]} onUpdated={vi.fn()} />);
    expect(screen.queryByTestId('agent-delegates')).toBeNull();
  });

  it('delegate_not_eligible 거절을 사람 말로 보인다', async () => {
    const lead = agent({ id: 'agent-2', handle: 'lead', invokeScope: 'owner' } as Partial<AgentView>);
    setup({ addDelegate: vi.fn(async () => { throw new ApiError(400, 'delegate_not_eligible', 'x'); }) });
    render(<AgentScopeSection agent={agent({ invokeScope: 'owner' })} agents={[lead]} onUpdated={vi.fn()} />);
    const box = screen.getByTestId('agent-delegates');
    fireEvent.change(box.querySelector('select')!, { target: { value: 'agent-2' } });
    fireEvent.click(box.querySelectorAll('button')[0]!);
    expect((await screen.findByTestId('agent-scope-error')).textContent).toContain('소유자 전용');
  });
});

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
import { takeMcpFocus } from '../src/lib/mcpFocus';

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
  it('펼친 채 시작한다(jaebin, 설정 폭 승인) — 요약 줄은 그대로 지금 값을 말한다 (UX ⑨b)', () => {
    setup();
    render(<AgentScopeSection agent={agent({ invokeScope: 'list', credentialScope: 'community', invokers: ['u-2'], delegates: ['a-9'] })} onUpdated={vi.fn()} />);
    expect(screen.getByTestId('agent-scope-details').hasAttribute('open')).toBe(true);
    expect(screen.getByTestId('agent-scope-summary').textContent)
      .toBe('아래 명단의 사람만 · 커뮤니티 공용 자격증명 · 명단 1명 · 대리 호출자 1');
  });

  it('MCP 가 붙어 있으면 요약에 그 수가 붙는다 — 접힌 채로도 보인다', () => {
    setup();
    render(<AgentScopeSection agent={agent({ mcpServers: ['github', 'slack'] })} onUpdated={vi.fn()} />);
    expect(screen.getByTestId('agent-scope-summary').textContent).toBe('커뮤니티의 누구나 · 자격증명 없음 · MCP 2');
  });

  it('명단·대리 호출자가 없으면 요약은 두 값만', () => {
    setup();
    render(<AgentScopeSection agent={agent()} onUpdated={vi.fn()} />);
    expect(screen.getByTestId('agent-scope-summary').textContent).toBe('커뮤니티의 누구나 · 자격증명 없음');
  });

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

/** 이 머신의 오퍼레이터 표면 — Tauri invoke 를 가짜로 건다. 이 기기 오퍼레이터는 `op-mac`(커뮤니티 BASE). */
const BASE = 'https://c.test';
type FakeServer = { name: string; source?: 'operator' | 'claude'; oauth?: boolean; auth?: Record<string, unknown> };
function fakeLocal(servers: FakeServer[], opts: { operatorId?: string | null } = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const operatorId = opts.operatorId === undefined ? 'op-mac' : opts.operatorId;
  (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'operator_mcp_list') {
        return { servers: servers.map((x) => ({ name: x.name, source: x.source ?? 'operator', transport: 'http', target: 'https://x', args: [], envKeys: [], headerKeys: [], oauth: x.oauth ?? false, ...(x.auth ? { auth: x.auth } : {}) })) };
      }
      if (cmd === 'operator_agents_list') {
        return { communities: operatorId ? [{ baseUrl: BASE, registered: true, operatorId, agents: {} }] : [] };
      }
      return {};
    },
  };
  return calls;
}

const HERE = { agentId: 'agent-1', operatorId: 'op-mac', assignedBy: ME_ID, assignedAt: '2026-10-21T00:00:00Z' };
const ON_VM = { ...HERE, operatorId: 'op-vm' };
/** 컨트롤러에 이 커뮤니티 주소와 오퍼레이터 목록을 더한다 — 「이 맥」 판정과 원격 이름의 재료. */
function setupOps(over: Partial<Record<string, unknown>> = {}) {
  return setup({
    api: { baseUrl: BASE },
    operators: vi.fn(async () => [{ id: 'op-vm', ownerAccountId: ME_ID, name: 'dev-vm-01', label: null, createdAt: '', lastSeenAt: null, revokedAt: null, online: true, version: null }]),
    ...over,
  });
}

describe('AgentMcpSection — 배정된 오퍼레이터 기준(MCP 설정 시안 v2 §7)', () => {
  afterEach(() => {
    delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    takeMcpFocus();
  });

  it('머리에 어디서 도는지 적는다 — 이 맥 / 원격(이름·태그) / 배정 전', async () => {
    fakeLocal([{ name: 'github' }]);
    setupOps();
    render(<AgentScopeSection agent={agent({ assignment: HERE })} onUpdated={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('agent-mcp-where').textContent).toContain('이 맥에서 돈다'));
    cleanup();
    fakeLocal([{ name: 'github' }]);
    setupOps();
    render(<AgentScopeSection agent={agent({ assignment: ON_VM, mcpServers: ['github'] })} onUpdated={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('agent-mcp-where').textContent).toContain('dev-vm-01 에서 돈다'));
    expect(screen.getByTestId('agent-mcp-where').textContent).toContain('원격');
    // 원격은 이 맥 목록으로 판정하지 않는다 — 켠 줄은 「상태 모름」, 정의 없음이라고 단언하지 않는다.
    expect(screen.getByTestId('agent-mcp-unknown-github').textContent).toBe('상태 모름');
    expect(screen.queryByTestId('agent-mcp-missing-github')).toBeNull();
    expect(screen.getByTestId('agent-mcp-remote-hint').textContent).toContain('그 호스트에서 고친다');
    cleanup();
    fakeLocal([]);
    setupOps();
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    expect((await screen.findByTestId('agent-mcp-where')).textContent).toContain('아직 오퍼레이터에 배정되지 않았다');
  });

  it('정의가 없어도 켜기는 막지 않는다 — 켜고 나서 「뜨지 않는다」를 경고한다', async () => {
    fakeLocal([{ name: 'slack' }]);
    const c = setupOps();
    render(<AgentScopeSection agent={agent({ assignment: HERE })} onUpdated={() => {}} />);
    const missing = await screen.findByTestId('agent-mcp-missing-github');
    expect(missing.textContent).toBe('이 맥에 정의 없음');
    expect(missing.className).toContain('text-fg-subtle');
    fireEvent.click(screen.getByLabelText('github'));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['github'] }));
    expect((await screen.findByTestId('agent-mcp-warn')).textContent).toContain('뜨지 않는다');
    expect(screen.queryByTestId('agent-mcp-error')).toBeNull();
  });

  it('켜 둔 줄에 정의가 없으면 빨갛게, 「연동에서 추가 →」 는 연동의 그 줄로 간다', async () => {
    fakeLocal([{ name: 'slack' }]);
    setupOps();
    const onOpenSection = vi.fn();
    render(<AgentScopeSection agent={agent({ assignment: HERE, mcpServers: ['github'] })} onUpdated={() => {}} onOpenSection={onOpenSection} />);
    const missing = await screen.findByTestId('agent-mcp-missing-github');
    expect(missing.className).toContain('text-danger');
    fireEvent.click(screen.getByTestId('agent-mcp-link-github'));
    expect(onOpenSection).toHaveBeenCalledWith('integrations');
    expect(takeMcpFocus()).toBe('github');
  });

  it('인증이 사람 손을 기다리면 한 낱말 + 「연동에서 다시 인증 →」 — 이 화면에는 인증 버튼이 없다', async () => {
    fakeLocal([{ name: 'slack', oauth: true, auth: { state: 'rejected', at: Date.now(), agentId: 'agent-tm' } }, { name: 'github', auth: { state: 'ok' } }]);
    setupOps();
    render(<AgentScopeSection agent={agent({ assignment: HERE, mcpServers: ['slack', 'github'], credentialScope: 'personal', invokeScope: 'owner' })}
      onUpdated={() => {}} onOpenSection={vi.fn()} />);
    const word = await screen.findByTestId('agent-mcp-auth-slack');
    expect(word.textContent).toBe('인증 거부됨');
    expect(word.className).toContain('text-danger');
    expect(screen.getByTestId('agent-mcp-link-slack').textContent).toBe('연동에서 다시 인증 →');
    expect(screen.queryByTestId('agent-mcp-auth-start-slack')).toBeNull();
    // 정상은 말하지 않는다.
    expect(screen.queryByTestId('agent-mcp-auth-github')).toBeNull();
    expect(screen.queryByTestId('agent-mcp-link-github')).toBeNull();
  });

  it('onOpenSection 이 없으면 링크를 그리지 않는다', async () => {
    fakeLocal([]);
    setupOps();
    render(<AgentScopeSection agent={agent({ assignment: HERE, mcpServers: ['github'] })} onUpdated={() => {}} />);
    await screen.findByTestId('agent-mcp-missing-github');
    expect(screen.queryByTestId('agent-mcp-link-github')).toBeNull();
    expect(screen.queryByTestId('agent-mcp-link-integrations')).toBeNull();
  });

  it('personal 서버를 켜면 확인을 받고 scope 를 같은 PATCH 로 바꾼다', async () => {
    fakeLocal([{ name: 'slack' }, { name: 'github' }]);
    const c = setupOps();
    render(<AgentScopeSection agent={agent({ assignment: HERE })} onUpdated={() => {}} />);
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
    setupOps({
      listTeams: vi.fn(async () => [{ id: 't1', name: 'ops-team' }, { id: 't2', name: 'other' }]),
      getTeam: vi.fn(async (id: string) => ({
        team: { id },
        members: id === 't1' ? [{ accountId: 'agent-1', handle: 'alpha', disabled: false }] : [],
      })),
    });
    render(<AgentScopeSection agent={agent({ assignment: HERE })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByLabelText('slack'));
    const line = await screen.findByTestId('agent-mcp-confirm-teams');
    expect(line.textContent).toContain('@ops-team');
    expect(line.textContent).not.toContain('@other');
  });

  it('[+ 추가] 는 연동과 같은 창 — 이 맥 배정이면 「켜기」가 켜진 채, 이름 → 이 맥 정의 → 붙이기 순서다', async () => {
    const calls = fakeLocal([]);
    const order: string[] = [];
    const c = setupOps({
      mcpServers: vi.fn(async () => (order.includes('put')
        ? [{ name: 'jira', credentialKind: 'personal', createdBy: null, createdAt: '' }] : [])),
      putMcpServer: vi.fn(async () => { order.push('put'); return { name: 'jira', credentialKind: 'personal', createdBy: null, createdAt: '' }; }),
    });
    useActiveStore.getState().set({ me: { ...acc(ME_ID, 'owner'), capabilities: ['agent.privileged'] } as never });
    render(<AgentScopeSection agent={agent({ assignment: HERE, credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    await screen.findByTestId('agent-mcp-where');
    fireEvent.click(await screen.findByTestId('agent-mcp-add-open'));
    expect(await screen.findByTestId('mcp-server-dialog')).toBeTruthy();
    expect((screen.getByTestId('mcp-dialog-attach') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'jira' } });
    expect(screen.getByTestId('mcp-dialog-submit').textContent).toBe('추가하고 켜기');
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['jira'] }));
    expect(c.putMcpServer).toHaveBeenCalledWith('jira', 'personal');
    const set = calls.find((x) => x.cmd === 'operator_mcp_set');
    expect(set?.args).toEqual({ name: 'jira', definition: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' } });
  });

  it('원격 배정 에이전트의 [+ 추가] — URL·Client ID 칸 없이 그 호스트 안내, 「켜기」는 꺼진 채 시작하고 이 맥 정의는 넣지 않는다(D12)', async () => {
    const calls = fakeLocal([]);
    const c = setupOps({ mcpServers: vi.fn(async () => []) });
    useActiveStore.getState().set({ me: { ...acc(ME_ID, 'owner'), capabilities: ['agent.privileged'] } as never });
    render(<AgentScopeSection agent={agent({ assignment: ON_VM, credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('agent-mcp-where').textContent).toContain('dev-vm-01'));
    fireEvent.click(screen.getByTestId('agent-mcp-add-open'));
    await screen.findByTestId('mcp-server-dialog');
    expect(screen.queryByTestId('mcp-dialog-url')).toBeNull();
    expect(screen.queryByTestId('mcp-dialog-client-id')).toBeNull();
    expect(screen.getByTestId('mcp-dialog-remote-note').textContent).toContain('dev-vm-01');
    expect((screen.getByTestId('mcp-dialog-attach') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('mcp-dialog-submit').textContent).toBe('이름 등록');
    fireEvent.click(screen.getByTestId('mcp-dialog-attach'));
    expect(screen.getByTestId('mcp-dialog-submit').textContent).toBe('등록하고 켜기');
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'jira' } });
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['jira'] }));
    expect(c.putMcpServer).toHaveBeenCalledWith('jira', 'personal');
    expect(calls.some((x) => x.cmd === 'operator_mcp_set')).toBe(false);
    expect((await screen.findByTestId('agent-mcp-warn')).textContent).toContain('dev-vm-01');
  });

  it('저장 뒤 [지금 재시작] 이 그 자리에서 agent.restart 를 부른다 — 멈춰 둔 에이전트에는 없다', async () => {
    fakeLocal([{ name: 'github' }, { name: 'slack' }]);
    const c = setupOps({ restartAgent: vi.fn(async () => ({ operatorId: 'op-1' })) });
    render(<AgentScopeSection agent={agent({ assignment: HERE })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByLabelText('github'));
    fireEvent.click(await screen.findByTestId('agent-mcp-restart'));
    await waitFor(() => expect(c.restartAgent).toHaveBeenCalledWith('agent-1'));
    expect(screen.queryByTestId('agent-mcp-restart')).toBeNull();
    cleanup();
    setupOps();
    render(<AgentScopeSection agent={agent({ assignment: HERE, stopRequestedAt: '2026-09-28T00:00:00.000Z' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByLabelText('github'));
    await screen.findByTestId('agent-mcp-notice');
    expect(screen.queryByTestId('agent-mcp-restart')).toBeNull();
  });

  it('레지스트리 등록 권한이 없으면 새 이름은 막는다 — 정의도 붙이기도 하지 않는다', async () => {
    const calls = fakeLocal([]);
    const c = setupOps({ mcpServers: vi.fn(async () => []) });
    render(<AgentScopeSection agent={agent({ assignment: HERE })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-add-open'));
    await screen.findByTestId('mcp-server-dialog');
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(c.putMcpServer).not.toHaveBeenCalled();
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

  // 형제 기본 신뢰(서버 083). 켜져 있으면 명단이 필요 없으므로 명단을 숨기고, 끄면 명단이 돌아온다.
  // 옛 서버는 필드를 주지 않는다 — 그때는 스위치 없이 예전 명단만 그린다(PATCH 가 조용히 버려지므로).
  it('형제 신뢰가 켜져 있으면 스위치만 보이고 명단은 숨는다; 끄면 updateAgent 에 trustSiblings:false 가 간다', async () => {
    const c = setup();
    const onUpdated = vi.fn();
    render(<AgentScopeSection agent={agent({ invokeScope: 'owner', trustSiblings: true })} agents={[]} onUpdated={onUpdated} />);
    expect(screen.queryByTestId('agent-delegates')).toBeNull();
    const sw = screen.getByRole('switch', { name: '내 다른 소유자 전용 에이전트가 부를 수 있다' }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalledWith('agent-1', { trustSiblings: false }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ trustSiblings: false }));
  });

  it('형제 신뢰가 꺼져 있으면 스위치와 명단이 함께 보인다', () => {
    setup();
    render(<AgentScopeSection agent={agent({ invokeScope: 'owner', trustSiblings: false })} agents={[]} onUpdated={vi.fn()} />);
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('agent-delegates')).toBeTruthy();
  });

  it('옛 서버(trustSiblings 없음)에는 스위치를 그리지 않고 명단을 그린다', () => {
    setup();
    render(<AgentScopeSection agent={agent({ invokeScope: 'owner' })} agents={[]} onUpdated={vi.fn()} />);
    expect(screen.queryByTestId('agent-trust-siblings')).toBeNull();
    expect(screen.getByTestId('agent-delegates')).toBeTruthy();
  });
});

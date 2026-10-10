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
import { setExternalOpener } from '../src/lib/openExternal';

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

  it('Slack 프리셋은 Client ID·secret 칸을 싣는다 — secret 은 적었을 때만 보내고 칸은 비운다(2026-10-07 전용 앱)', async () => {
    const calls = fakeLocal([]);
    setup({
      mcpServers: vi.fn(async () => [{ name: 'slack', credentialKind: 'personal', createdBy: null, createdAt: '' }]),
    });
    render(<AgentScopeSection agent={agent({ credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-add-open'));
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'slack' } });
    expect((screen.getByTestId('agent-mcp-client-id') as HTMLInputElement).value).toBe('1601185624273.8899143856786');
    expect((screen.getByTestId('agent-mcp-client-secret') as HTMLInputElement).type).toBe('password');
    fireEvent.change(screen.getByTestId('agent-mcp-client-id'), { target: { value: ' 111.222 ' } });
    fireEvent.change(screen.getByTestId('agent-mcp-client-secret'), { target: { value: 'S-x' } });
    fireEvent.click(screen.getByTestId('agent-mcp-add-submit'));
    await waitFor(() => expect(calls.some((x) => x.cmd === 'operator_mcp_set')).toBe(true));
    expect(calls.find((x) => x.cmd === 'operator_mcp_set')?.args).toEqual({
      name: 'slack',
      definition: { type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: '111.222', callbackPort: 3118, clientSecret: 'S-x' } },
    });
  });

  it('Client ID 없이 secret 만 적으면 막는다 — 정의를 보내지 않는다', async () => {
    const calls = fakeLocal([]);
    setup({ mcpServers: vi.fn(async () => [{ name: 'slack', credentialKind: 'personal', createdBy: null, createdAt: '' }]) });
    render(<AgentScopeSection agent={agent({ credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-add-open'));
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'slack' } });
    fireEvent.change(screen.getByTestId('agent-mcp-client-id'), { target: { value: ' ' } });
    fireEvent.change(screen.getByTestId('agent-mcp-client-secret'), { target: { value: 'S-x' } });
    fireEvent.click(screen.getByTestId('agent-mcp-add-submit'));
    expect((await screen.findByTestId('agent-mcp-error')).textContent).toContain('Client secret 은 Client ID 와 함께');
    expect(calls.some((x) => x.cmd === 'operator_mcp_set')).toBe(false);
  });

  it('secret 칸이 비어 있으면 clientSecret 을 싣지 않는다 — 들고 있던 것을 지우지 않는다', async () => {
    const calls = fakeLocal([]);
    setup({ mcpServers: vi.fn(async () => [{ name: 'slack', credentialKind: 'personal', createdBy: null, createdAt: '' }]) });
    render(<AgentScopeSection agent={agent({ credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-add-open'));
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'slack' } });
    fireEvent.click(screen.getByTestId('agent-mcp-add-submit'));
    await waitFor(() => expect(calls.some((x) => x.cmd === 'operator_mcp_set')).toBe(true));
    const def = (calls.find((x) => x.cmd === 'operator_mcp_set')?.args as { definition: { oauth?: Record<string, unknown> } }).definition;
    expect(def.oauth).toEqual({ clientId: '1601185624273.8899143856786', callbackPort: 3118 });
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

// 원격 MCP 인증(2026-09-30, harkroom 스레드 ebb97c7b). 토큰은 오퍼레이터가 든다 — 앱은 인가 url 을
// 브라우저로 열고 상태를 물을 뿐이다. 계정 디렉터리마다 따로 인증하던 것을 여기 한 번으로 바꾼 자리다.
describe('AgentMcpSection — 원격 MCP 인증', () => {
  afterEach(() => {
    delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setExternalOpener(null);
  });

  function fakeAuth(initial: Record<string, unknown>, opts: { oauth?: boolean; startError?: string } = {}) {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    let auth = initial;
    (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'operator_mcp_list') {
          return { servers: [{ name: 'slack', source: 'operator', transport: 'http', target: 'https://mcp.example.com/mcp', args: [], envKeys: [], headerKeys: [], oauth: opts.oauth ?? true, auth }] };
        }
        if (cmd === 'operator_mcp_auth' && args?.action === 'start' && opts.startError) throw new Error(opts.startError);
        if (cmd === 'operator_mcp_auth' && args?.action === 'start') { auth = { state: 'pending' }; return { authUrl: 'https://auth.example.com/authorize?x=1' }; }
        if (cmd === 'operator_mcp_auth' && args?.action === 'status') return auth;
        if (cmd === 'operator_mcp_auth' && args?.action === 'forget') { auth = { state: 'none' }; return {}; }
        return {};
      },
    };
    return { calls, set: (next: Record<string, unknown>) => { auth = next; } };
  }

  it('정의에 oauth 가 있고 토큰이 없으면 "인증 필요" — 켠 줄이면 경고다', async () => {
    fakeAuth({ state: 'none' });
    setup();
    render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    const badge = await screen.findByTestId('agent-mcp-auth-slack');
    expect(badge.textContent).toContain('인증 필요');
    expect(badge.querySelector('.text-danger')).toBeTruthy();
    expect(screen.getByTestId('agent-mcp-auth-start-slack').textContent).toBe('인증');
  });

  it('[인증] 은 오퍼레이터가 만든 인가 url 을 브라우저로 열고, 끝날 때까지 상태를 묻는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const f = fakeAuth({ state: 'none' });
      const opened: string[] = [];
      setExternalOpener({ open: async (u) => { opened.push(u); } });
      setup();
      render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
      fireEvent.click(await screen.findByTestId('agent-mcp-auth-start-slack'));
      await waitFor(() => expect(opened).toEqual(['https://auth.example.com/authorize?x=1']));
      expect((await screen.findByTestId('agent-mcp-auth-slack')).textContent).toContain('기다리는 중');
      // 사람이 브라우저에서 끝냈다 — 오퍼레이터가 콜백을 받아 토큰을 들었다.
      f.set({ state: 'ok', expiresAt: Date.now() + 3600_000 });
      await vi.advanceTimersByTimeAsync(1600);
      await waitFor(() => expect(screen.getByTestId('agent-mcp-auth-slack').textContent).toContain('인증됨'));
      expect(f.calls.some((c) => c.cmd === 'operator_mcp_auth' && c.args?.action === 'status' && c.args?.name === 'slack')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('MCP 서버가 거절했으면 "거부됨 · 시각 · 에이전트" 를 빨갛게, [다시 인증] 과 함께 보인다', async () => {
    const at = new Date(2026, 9, 1, 14, 51).getTime();
    fakeAuth({ state: 'rejected', at, agentId: 'agent-tm' });
    setup();
    const prev = useActiveStore.getState().accounts;
    useActiveStore.getState().set({ accounts: { ...prev, 'agent-tm': { id: 'agent-tm', handle: 'task_manager', displayName: 'task_manager', kind: 'agent', isAdmin: false, avatarUrl: null, createdAt: '2026-09-01T00:00:00.000Z' } } as never });
    render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    const badge = await screen.findByTestId('agent-mcp-auth-slack');
    expect(badge.textContent).toContain('거부됨');
    expect(badge.textContent).toContain('task_manager');
    expect(badge.textContent).toMatch(/2:51/);
    expect(badge.querySelector('.text-danger')).toBeTruthy();
    expect(screen.getByTestId('agent-mcp-auth-start-slack').textContent).toBe('다시 인증');
  });

  it('거부를 본 에이전트를 모르면 이름 없이 시각만 보인다', async () => {
    fakeAuth({ state: 'rejected', at: Date.now(), agentId: 'unknown-agent' });
    setup();
    render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    const badge = await screen.findByTestId('agent-mcp-auth-slack');
    expect(badge.textContent).toContain('거부됨');
    expect(badge.textContent).not.toContain('unknown-agent');
  });

  it('인증됨에도 [다시 인증] 이 있다 — 화면이 맞다고 해도 실제 실패를 본 사람이 곧바로 다시 인증한다', async () => {
    const opened: string[] = [];
    setExternalOpener({ open: async (u) => { opened.push(u); } });
    fakeAuth({ state: 'ok' });
    setup();
    render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    expect((await screen.findByTestId('agent-mcp-auth-slack')).textContent).toContain('인증됨');
    expect(screen.getByTestId('agent-mcp-auth-forget-slack').textContent).toBe('인증 해제');
    fireEvent.click(screen.getByTestId('agent-mcp-auth-start-slack'));
    await waitFor(() => expect(opened).toEqual(['https://auth.example.com/authorize?x=1']));
  });

  it('만료면 "다시 인증", 인증됨이면 [인증 해제] 가 forget 에 닿는다', async () => {
    const f = fakeAuth({ state: 'expired' });
    setup();
    const { unmount } = render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    expect((await screen.findByTestId('agent-mcp-auth-slack')).textContent).toContain('인증 만료');
    expect(screen.getByTestId('agent-mcp-auth-start-slack').textContent).toBe('다시 인증');
    unmount();
    f.set({ state: 'ok' });
    render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-auth-forget-slack'));
    await waitFor(() => expect(f.calls.some((c) => c.cmd === 'operator_mcp_auth' && c.args?.action === 'forget')).toBe(true));
  });

  it('시작이 실패하면 오퍼레이터의 이유를 그대로 보인다 — 포트 3118 이 쓰이고 있다', async () => {
    fakeAuth({ state: 'none' }, { startError: '콜백 포트 3118 를 다른 프로그램이 쓰고 있다' });
    const opened: string[] = [];
    setExternalOpener({ open: async (u) => { opened.push(u); } });
    setup();
    render(<AgentScopeSection agent={agent({ mcpServers: ['slack'], credentialScope: 'personal', invokeScope: 'owner' })} onUpdated={() => {}} />);
    fireEvent.click(await screen.findByTestId('agent-mcp-auth-start-slack'));
    expect((await screen.findByTestId('agent-mcp-error')).textContent).toContain('3118');
    expect(opened).toEqual([]);
  });

  it('옛 오퍼레이터(auth 없음)에는 인증 줄을 그리지 않는다 — 모르는 것을 단언하지 않는다', async () => {
    fakeLocal([{ name: 'slack' }]);
    setup();
    render(<AgentScopeSection agent={agent()} onUpdated={() => {}} />);
    await screen.findByTestId('agent-mcp-row-slack');
    expect(screen.queryByTestId('agent-mcp-auth-slack')).toBeNull();
  });
});

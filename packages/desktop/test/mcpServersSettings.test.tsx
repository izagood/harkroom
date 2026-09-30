/**
 * MCP 레지스트리 화면(스펙 2026-09-20 §6). 목록은 누구나 보고, 넣고 빼는 것은 `agent.privileged`
 * 뿐이다 — 서버가 403 으로 지키지만 화면도 그 버튼을 그리지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { McpServersSettings } from '../src/components/settings/McpServersSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';
import { setExternalOpener } from '../src/lib/openExternal';

function fake(rows: { name: string; credentialKind: 'community' | 'personal' }[] = []) {
  const c = {
    mcpServers: vi.fn(async () => rows.map((r) => ({ ...r, createdBy: null, createdAt: '' }))),
    putMcpServer: vi.fn(async (name: string, credentialKind: string) => ({ name, credentialKind, createdBy: null, createdAt: '' })),
    deleteMcpServer: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
}
const me = (caps: string[]) => ({ ...acc('me', 'me'), capabilities: caps });

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); resetCommunityRegistry(); useActiveStore.getState().reset(); });
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('McpServersSettings', () => {
  it('agent.privileged 는 이름을 넣고 뺀다', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    const c = fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSettings />);
    expect(await screen.findByTestId('mcp-server-github')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'slack' } });
    fireEvent.change(screen.getByLabelText('자격증명 종류'), { target: { value: 'personal' } });
    fireEvent.click(screen.getByText('넣기'));
    await waitFor(() => expect(c.putMcpServer).toHaveBeenCalledWith('slack', 'personal'));
    fireEvent.click(screen.getByLabelText('github 빼기'));
    await waitFor(() => expect(c.deleteMcpServer).toHaveBeenCalledWith('github'));
  });
  it('이름 문법이 틀리면 서버에 보내지 않고 말한다', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    const c = fake();
    render(<McpServersSettings />);
    fireEvent.change(await screen.findByLabelText('이름'), { target: { value: 'Bad_Name' } });
    fireEvent.click(screen.getByText('넣기'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(c.putMcpServer).not.toHaveBeenCalled();
  });
  it('능력이 없으면 목록만 본다 — 넣기·빼기 버튼이 없다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSettings />);
    expect(await screen.findByTestId('mcp-server-github')).toBeTruthy();
    expect(screen.queryByLabelText('github 빼기')).toBeNull();
    expect(screen.queryByLabelText('이름')).toBeNull();
  });
});

// 2026-09-30: jaebin 이 v0.3.76 에서 이 페이지를 열고 "인증이 없는데?" — [인증] 이 에이전트 상세에만 있었다.
// 사람이 인증하러 먼저 찾는 곳이 여기다. 인증은 이 머신의 토큰이라 권한(agent.privileged)과 무관하다.
describe('McpServersSettings — 이 머신의 인증', () => {
  afterEach(() => {
    delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setExternalOpener(null);
  });

  function local(servers: Record<string, unknown>[]) {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'operator_mcp_list') return { servers };
        if (cmd === 'operator_mcp_auth' && args?.action === 'start') return { authUrl: 'https://auth.example.com/authorize' };
        if (cmd === 'operator_mcp_auth' && args?.action === 'status') return { state: 'ok' };
        return {};
      },
    };
    return calls;
  }
  const remote = (name: string, auth: Record<string, unknown>, oauth = true) => ({
    name, source: 'operator', transport: 'http', target: `https://${name}.example.com/mcp`, args: [], envKeys: [], headerKeys: [], oauth, auth,
  });

  it('능력이 없는 사람도 줄마다 [인증] 을 본다 — 인증은 이 머신의 토큰이다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    local([remote('slack', { state: 'none' }), remote('jira', { state: 'ok' }, false)]);
    fake([{ name: 'slack', credentialKind: 'personal' }, { name: 'jira', credentialKind: 'personal' }]);
    render(<McpServersSettings />);
    expect((await screen.findByTestId('agent-mcp-auth-slack')).textContent).toContain('인증 필요');
    expect(screen.getByTestId('agent-mcp-auth-start-slack').textContent).toBe('인증');
    expect(screen.getByTestId('agent-mcp-auth-jira').textContent).toContain('인증됨');
  });

  it('[인증] 은 오퍼레이터가 만든 인가 url 을 브라우저로 연다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const calls = local([remote('slack', { state: 'none' })]);
    const opened: string[] = [];
    setExternalOpener({ open: async (u) => { opened.push(u); } });
    fake([{ name: 'slack', credentialKind: 'personal' }]);
    render(<McpServersSettings />);
    fireEvent.click(await screen.findByTestId('agent-mcp-auth-start-slack'));
    await waitFor(() => expect(opened).toEqual(['https://auth.example.com/authorize']));
    expect(calls).toContainEqual({ cmd: 'operator_mcp_auth', args: { action: 'start', name: 'slack' } });
    expect(screen.getByTestId('agent-mcp-auth-slack').textContent).toContain('기다리는 중');
  });

  it('이 머신에 정의가 없는 이름은 그렇다고 말한다 — 인증할 것이 없다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    local([]);
    fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSettings />);
    expect((await screen.findByTestId('mcp-server-local-github')).textContent).toContain('이 머신에 정의 없음');
    expect(screen.queryByTestId('agent-mcp-auth-start-github')).toBeNull();
  });

  it('Tauri 표면이 없으면(웹) 줄에 덧붙이지 않는다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    fake([{ name: 'slack', credentialKind: 'personal' }]);
    render(<McpServersSettings />);
    await screen.findByTestId('mcp-server-slack');
    expect(screen.queryByTestId('mcp-server-local-slack')).toBeNull();
  });
});

/**
 * 설정 › 연동 › MCP 서버(스펙 2026-09-20 §6 + MCP 설정 시안 v2, 2026-10-21).
 *
 * 한 줄 = 머리(커뮤니티: 이름·종류) + operator 칸(지금은 이 맥 하나 → 두 줄로 접힘). 재는 것:
 * - 커뮤니티 이름 등록·삭제는 `agent.privileged` 뿐이다 — 서버가 403 으로 지키지만 화면도 그리지 않는다.
 * - 이 맥 칸(정의·인증)은 권한과 무관하다 — 내 기계의 일이다(2026-09-30 「인증이 없는데?」).
 * - 칸의 주 버튼은 상태를 따른다: 정의 없음 → [이 맥에 추가], 인증이 손을 기다림 → [인증]/[다시 인증], 정상 → [편집].
 * - 편집에서 Client ID 를 비우면 **지금 값 유지**(security n1) — 공용 앱으로 돌아가지 않는다.
 * - 지우기 두 갈래: 「이 맥에서 지우기」(operator_mcp_remove) / 「커뮤니티에서 삭제」(+ 이 맥 것도 지우기 체크).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { McpServersSection } from '../src/components/settings/McpServersSettings';
import { buildMcpDefinition } from '../src/components/settings/McpServerDialog';
import { MCP_PRESETS } from '../src/lib/mcpPresets';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';
import { setExternalOpener } from '../src/lib/openExternal';
import { requestMcpFocus, takeMcpFocus } from '../src/lib/mcpFocus';

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
const SLACK_PRESET_ID = MCP_PRESETS.find((p) => p.name === 'slack')!.definition.oauth!.clientId!;

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
const remote = (name: string, auth: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  name, source: 'operator', transport: 'http', target: `https://${name}.example.com/mcp`, args: [], envKeys: [], headerKeys: [], oauth: true, auth, ...over,
});

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); resetCommunityRegistry(); useActiveStore.getState().reset(); });
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  setExternalOpener(null);
});

describe('McpServersSettings — 커뮤니티 이름', () => {
  it('agent.privileged 는 [+ 추가] 로 새 이름을 등록하고 이 맥 정의를 넣는다', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    const calls = local([]);
    const c = fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('mcp-server-add-open'));
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('mcp-dialog-name'), { target: { value: 'linear' } });
    fireEvent.change(screen.getByTestId('mcp-dialog-url'), { target: { value: 'https://mcp.linear.example.com/mcp' } });
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    await waitFor(() => expect(c.putMcpServer).toHaveBeenCalledWith('linear', 'personal'));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'operator_mcp_set', args: { name: 'linear', definition: { type: 'http', url: 'https://mcp.linear.example.com/mcp' } } }));
  });

  it('이름 문법이 틀리면 서버에 보내지 않고 창 안에서 말한다', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    local([]);
    const c = fake();
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('mcp-server-add-open'));
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('mcp-dialog-name'), { target: { value: 'Bad_Name' } });
    fireEvent.change(screen.getByTestId('mcp-dialog-url'), { target: { value: 'https://x.example.com/mcp' } });
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    expect((await screen.findByRole('alert')).textContent).toContain('[a-z0-9-]');
    expect(c.putMcpServer).not.toHaveBeenCalled();
  });

  it('커뮤니티에서 삭제는 (접힌 줄이면) 칸 ⋯ 맨 끝에 있고 한 번 묻는다 — 체크(기본 꺼짐)를 켜면 이 맥 정의도 지운다', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    const calls = local([remote('github', { state: 'ok' }, { oauth: false })]);
    const c = fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    await screen.findByTestId('mcp-cell-primary-github');
    fireEvent.click(screen.getByTestId('mcp-cell-menu-github'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '커뮤니티에서 삭제' }));
    expect(c.deleteMcpServer).not.toHaveBeenCalled();
    // 기본은 꺼짐 — 이 맥의 정의는 다른 커뮤니티도 같이 쓴다(security #1453 n3). 켜면 이 맥 정의도 지운다.
    expect((screen.getByTestId('mcp-confirm-also-local') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('mcp-confirm-also-local-note').textContent).toContain('다른 커뮤니티');
    fireEvent.click(screen.getByTestId('mcp-confirm-also-local'));
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(c.deleteMcpServer).toHaveBeenCalledWith('github'));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'operator_mcp_remove', args: { name: 'github' } }));
  });

  it('접힌 줄의 ⋯ 는 하나다 — 이 맥 항목 뒤 맨 끝에 「커뮤니티에서 삭제」, 정의 없는 줄은 삭제 하나만(designer #1453-1)', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    local([remote('github', { state: 'ok' }, { oauth: false })]);
    fake([{ name: 'github', credentialKind: 'community' }, { name: 'jira', credentialKind: 'personal' }]);
    render(<McpServersSection />);
    await screen.findByTestId('mcp-cell-primary-github');
    for (const name of ['github', 'jira']) {
      const row = screen.getByTestId(`mcp-server-${name}`);
      expect(row.querySelectorAll('[data-testid^="mcp-server-menu-"], [data-testid^="mcp-cell-menu-"]')).toHaveLength(1);
    }
    fireEvent.click(screen.getByTestId('mcp-cell-menu-github'));
    const items = (await screen.findAllByRole('menuitem')).map((x) => x.textContent ?? '');
    expect(items.at(-1)).toBe('커뮤니티에서 삭제');
    expect(items.some((x) => x.includes('이 맥에서 지우기'))).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('mcp-cell-menu-jira'));
    await waitFor(() => expect(screen.getAllByRole('menuitem').map((x) => x.textContent)).toEqual(['커뮤니티에서 삭제']));
  });

  it('체크를 그대로(꺼짐) 두면 커뮤니티 이름만 지우고 이 맥 정의는 둔다', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    const calls = local([remote('github', { state: 'ok' }, { oauth: false })]);
    const c = fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    await screen.findByTestId('mcp-cell-primary-github');
    fireEvent.click(screen.getByTestId('mcp-cell-menu-github'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '커뮤니티에서 삭제' }));
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(c.deleteMcpServer).toHaveBeenCalledWith('github'));
    expect(calls.some((x) => x.cmd === 'operator_mcp_remove')).toBe(false);
  });

  it('능력이 없으면 커뮤니티 삭제 ⋯ 가 없다 — 이 맥 칸은 그대로 쓴다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    local([remote('github', { state: 'ok' }, { oauth: false })]);
    fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    expect(await screen.findByTestId('mcp-cell-primary-github')).toBeTruthy();
    expect(screen.queryByTestId('mcp-server-menu-github')).toBeNull();
    expect(screen.getByTestId('mcp-cell-menu-github')).toBeTruthy();
  });

  it('능력이 없으면 커뮤니티에 없는 새 이름은 막고 이유를 말한다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const calls = local([]);
    const c = fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('mcp-server-add-open'));
    fireEvent.change(screen.getByLabelText('서버'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('mcp-dialog-name'), { target: { value: 'linear' } });
    fireEvent.change(screen.getByTestId('mcp-dialog-url'), { target: { value: 'https://mcp.linear.example.com/mcp' } });
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    expect((await screen.findByRole('alert')).textContent).toContain('MCP 관리 권한');
    expect(c.putMcpServer).not.toHaveBeenCalled();
    expect(calls.some((x) => x.cmd === 'operator_mcp_set')).toBe(false);
  });
});

describe('McpServersSettings — 이 맥 칸', () => {
  it('주 버튼은 상태를 따른다 — 정의 없음 [이 맥에 추가] · 인증 필요 [인증] · 거부 [다시 인증] · 정상 [편집]', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    local([
      remote('slack', { state: 'none' }),
      remote('jira', { state: 'rejected', at: Date.UTC(2026, 9, 21, 5, 0) }),
      remote('github', { state: 'ok' }, { oauth: false }),
    ]);
    fake([
      { name: 'slack', credentialKind: 'personal' }, { name: 'jira', credentialKind: 'personal' },
      { name: 'github', credentialKind: 'community' }, { name: 'linear', credentialKind: 'personal' },
    ]);
    render(<McpServersSection />);
    expect((await screen.findByTestId('agent-mcp-auth-start-slack')).textContent).toBe('인증');
    expect(screen.getByTestId('agent-mcp-auth-slack').textContent).toContain('인증 필요');
    expect(screen.getByTestId('agent-mcp-auth-start-jira').textContent).toBe('다시 인증');
    expect(screen.getByTestId('agent-mcp-auth-jira').textContent).toContain('거부됨');
    expect(screen.getByTestId('mcp-cell-primary-github').textContent).toBe('편집');
    expect(screen.getByTestId('agent-mcp-auth-github').textContent).toContain('인증됨');
    expect(screen.getByTestId('mcp-server-local-linear').textContent).toContain('없음');
    expect(screen.getByTestId('mcp-cell-primary-linear').textContent).toBe('이 맥에 추가');
  });

  it('「인증됨」 옆에 받은 때를 적는다 — 시각이 없으면(옛 오퍼레이터) 낱말만(designer #1453 n3)', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const at = Date.UTC(2026, 9, 21, 8, 55);
    local([remote('slack', { state: 'ok', at }), remote('github', { state: 'ok' }, { oauth: false })]);
    fake([{ name: 'slack', credentialKind: 'personal' }, { name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    const slack = (await screen.findByTestId('agent-mcp-auth-slack')).textContent ?? '';
    expect(slack).toMatch(/인증됨 · \S/);
    expect(screen.getByTestId('agent-mcp-auth-github').textContent).not.toContain('·');
  });

  it('[인증] 은 오퍼레이터가 만든 인가 url 을 브라우저로 연다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const calls = local([remote('slack', { state: 'none' })]);
    const opened: string[] = [];
    setExternalOpener({ open: async (u) => { opened.push(u); } });
    fake([{ name: 'slack', credentialKind: 'personal' }]);
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('agent-mcp-auth-start-slack'));
    await waitFor(() => expect(opened).toEqual(['https://auth.example.com/authorize']));
    expect(calls).toContainEqual({ cmd: 'operator_mcp_auth', args: { action: 'start', name: 'slack' } });
    expect(screen.getByTestId('agent-mcp-auth-slack').textContent).toContain('기다리는 중');
  });

  it('⋯ › 인증 해제는 이 맥의 토큰만 지운다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const calls = local([remote('github', { state: 'ok' }, { oauth: false })]);
    fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('mcp-cell-menu-github'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '인증 해제 (이 맥의 토큰만)' }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'operator_mcp_auth', args: { action: 'forget', name: 'github' } }));
  });

  it('⋯ › 이 맥에서 지우기는 한 번 묻고 operator_mcp_remove 를 부른다 — 커뮤니티 이름은 그대로', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    const calls = local([remote('github', { state: 'ok' }, { oauth: false })]);
    const c = fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('mcp-cell-menu-github'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '이 맥에서 지우기' }));
    expect(calls.some((x) => x.cmd === 'operator_mcp_remove')).toBe(false);
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'operator_mcp_remove', args: { name: 'github' } }));
    expect(c.deleteMcpServer).not.toHaveBeenCalled();
  });

  it('~/.claude.json 정의는 고칠 수 없다고 말하고 편집·지우기를 내지 않는다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    local([remote('context7', { state: 'ok' }, { source: 'claude', oauth: false })]);
    fake([{ name: 'context7', credentialKind: 'community' }]);
    render(<McpServersSection />);
    expect((await screen.findByTestId('mcp-server-local-context7')).textContent).toContain('여기서 고칠 수 없음');
    expect(screen.queryByTestId('mcp-cell-primary-context7')).toBeNull();
    fireEvent.click(screen.getByTestId('mcp-cell-menu-context7'));
    expect(screen.queryByRole('menuitem', { name: '이 맥에서 지우기' })).toBeNull();
  });

  it('[이 맥에 추가] 는 이름·종류를 잠근 창을 열고 프리셋 정의를 넣는다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const calls = local([]);
    const c = fake([{ name: 'slack', credentialKind: 'personal' }]);
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('mcp-cell-primary-slack'));
    expect((screen.getByTestId('mcp-dialog-name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('mcp-dialog-client-id') as HTMLInputElement).placeholder).toContain('공용 Slack 앱');
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'operator_mcp_set', args: { name: 'slack', definition: MCP_PRESETS[0]!.definition } }));
    expect(c.putMcpServer).not.toHaveBeenCalled();
  });

  it('전용 앱이면 칩에 끝 4자리만 — 편집에서 Client ID 를 비우면 지금 값을 그대로 보낸다(security n1)', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const calls = local([remote('slack', { state: 'ok' }, { target: 'https://mcp.slack.com/mcp', oauthClientId: '999.own-app-abcd' })]);
    fake([{ name: 'slack', credentialKind: 'personal' }]);
    render(<McpServersSection />);
    const chip = await screen.findByTestId('mcp-cell-own-app-slack');
    expect(chip.textContent).toContain('…abcd');
    expect(chip.textContent).not.toContain('999.own');
    fireEvent.click(screen.getByTestId('mcp-cell-primary-slack'));
    expect((screen.getByTestId('mcp-dialog-client-id') as HTMLInputElement).placeholder).toBe('비우면 지금 값 유지');
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    await waitFor(() => expect(calls.find((x) => x.cmd === 'operator_mcp_set')?.args).toEqual({
      name: 'slack',
      definition: { type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: '999.own-app-abcd', callbackPort: 3118 } },
    }));
  });

  it('「기본 앱으로 되돌리기」를 누르면 프리셋 Client ID 로 저장한다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    const calls = local([remote('slack', { state: 'ok' }, { target: 'https://mcp.slack.com/mcp', oauthClientId: '999.own-app-abcd' })]);
    fake([{ name: 'slack', credentialKind: 'personal' }]);
    render(<McpServersSection />);
    fireEvent.click(await screen.findByTestId('mcp-cell-primary-slack'));
    fireEvent.click(screen.getByTestId('mcp-dialog-revert'));
    expect(screen.getByTestId('mcp-dialog-client-current').textContent).toContain('기본 앱으로 돌아간다');
    fireEvent.click(screen.getByTestId('mcp-dialog-submit'));
    await waitFor(() => expect((calls.find((x) => x.cmd === 'operator_mcp_set')?.args as { definition: { oauth: { clientId: string } } }).definition.oauth.clientId)
      .toBe(SLACK_PRESET_ID));
  });

  it('이 머신에 정의가 없는 이름은 「없음」 — 인증 버튼이 없다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    local([]);
    fake([{ name: 'github', credentialKind: 'community' }]);
    render(<McpServersSection />);
    expect((await screen.findByTestId('mcp-server-local-github')).textContent).toContain('없음');
    expect(screen.queryByTestId('agent-mcp-auth-start-github')).toBeNull();
  });

  it('Tauri 표면이 없으면(웹) 칸을 그리지 않는다', async () => {
    useActiveStore.getState().set({ me: me([]) as never });
    fake([{ name: 'slack', credentialKind: 'personal' }]);
    render(<McpServersSection />);
    await screen.findByTestId('mcp-server-slack');
    expect(screen.queryByTestId('mcp-server-local-slack')).toBeNull();
    expect(screen.queryByTestId('mcp-server-add-open')).toBeNull();
  });
});

describe('buildMcpDefinition', () => {
  const entry = (over: Record<string, unknown>) => ({ name: 'x', source: 'operator', transport: 'http', target: 'https://x.example.com/mcp', args: [], envKeys: [], headerKeys: [], oauth: true, ...over }) as never;
  it('입력한 Client ID 가 지금 값을 이긴다', () => {
    expect(buildMcpDefinition({ name: 'x', url: 'https://x.example.com/mcp', clientId: ' new-1 ', revert: false, entry: entry({ oauthClientId: 'old-1' }) }))
      .toEqual({ type: 'http', url: 'https://x.example.com/mcp', oauth: { clientId: 'new-1' } });
  });
  it('프리셋이 아닌 정의를 되돌리면 clientId 없이 oauth 만 남긴다', () => {
    expect(buildMcpDefinition({ name: 'x', url: 'https://x.example.com/mcp', clientId: '', revert: true, entry: entry({ oauthClientId: 'old-1' }) }))
      .toEqual({ type: 'http', url: 'https://x.example.com/mcp', oauth: {} });
  });
  it('칸을 비우면 같은 URL 일 때만 지금 Client ID 를 싣는다 — URL 이 바뀌면 싣지 않는다(security #1453 n4)', () => {
    expect(buildMcpDefinition({ name: 'x', url: 'https://x.example.com/mcp', clientId: '', revert: false, entry: entry({ oauthClientId: 'old-1' }) }))
      .toEqual({ type: 'http', url: 'https://x.example.com/mcp', oauth: { clientId: 'old-1' } });
    expect(buildMcpDefinition({ name: 'x', url: 'https://y.example.com/mcp', clientId: '', revert: false, entry: entry({ oauthClientId: 'old-1' }) }))
      .toEqual({ type: 'http', url: 'https://y.example.com/mcp', oauth: {} });
  });
  it('프리셋이 아닌 정의는 목록의 callbackPort 를 지킨다', () => {
    expect(buildMcpDefinition({ name: 'x', url: 'https://x.example.com/mcp', clientId: '', revert: false, entry: entry({ oauthCallbackPort: 4555 }) }))
      .toEqual({ type: 'http', url: 'https://x.example.com/mcp', oauth: { callbackPort: 4555 } });
  });
  it('slack 을 되돌리면 URL 을 바꿨어도 프리셋 Client ID 를 명시해 보낸다', () => {
    const slack = (over: Record<string, unknown>) => entry({ name: 'slack', target: 'https://mcp.slack.com/mcp', oauthClientId: 'own-1', ...over });
    const out = buildMcpDefinition({ name: 'slack', url: 'https://mcp.slack.com/mcp', clientId: '', revert: true, entry: slack({}) });
    expect(out.oauth?.clientId).toBeTruthy();
    expect(out.oauth?.clientId).not.toBe('own-1');
  });
  it('oauth 없는 새 정의는 type·url 만', () => {
    expect(buildMcpDefinition({ name: 'x', url: 'https://x.example.com/mcp', clientId: '', revert: false }))
      .toEqual({ type: 'http', url: 'https://x.example.com/mcp' });
  });
});

/**
 * PR2(시안 v2 §2·§4·§7): 이 맥 오퍼레이터에 배정된 에이전트가 무엇을 켰나 — [이 맥에 추가] 의 색, 지우기 확인창의
 * 「영향받는 에이전트」, 에이전트 화면 링크로 왔을 때의 강조.
 */
describe('McpServersSettings — 이 맥에 배정된 에이전트', () => {
  const BASE = 'https://c.test';
  const ag = (id: string, handle: string, operatorId: string, mcpServers: string[]) => ({
    ...acc(id, handle, 'agent'), assignment: { agentId: id, operatorId, assignedBy: 'me', assignedAt: '' }, mcpServers,
  });
  function withAgents(rows: { name: string; credentialKind: 'community' | 'personal' }[], servers: Record<string, unknown>[]) {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'operator_mcp_list') return { servers };
        if (cmd === 'operator_agents_list') return { communities: [{ baseUrl: BASE, registered: true, operatorId: 'op-mac', agents: {} }] };
        return {};
      },
    };
    const c = {
      api: { baseUrl: BASE },
      mcpServers: vi.fn(async () => rows.map((r) => ({ ...r, createdBy: null, createdAt: '' }))),
      putMcpServer: vi.fn(async () => undefined),
      deleteMcpServer: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => [
        ag('a-tm', 'task_manager', 'op-mac', ['jira', 'github']),
        ag('a-hk', 'harkroom', 'op-mac', ['github']),
        ag('a-infra', 'infra_bot', 'op-vm', ['jira', 'github']),
      ]),
    };
    setController(c as unknown as Controller);
    return { calls, c };
  }

  it('정의가 없는데 이 맥 에이전트가 켜 두었으면 그 이름을 빨갛게, [이 맥에 추가] 는 채운 색 — 원격 에이전트는 세지 않는다', async () => {
    withAgents([{ name: 'jira', credentialKind: 'personal' }], []);
    render(<McpServersSection />);
    const line = await screen.findByTestId('mcp-cell-missing-on-jira');
    expect(line.textContent).toContain('task_manager');
    expect(line.textContent).not.toContain('infra_bot');
    expect(screen.getByTestId('mcp-cell-primary-jira').className).toContain('bg-accent');
  });

  it('「이 맥에서 지우기」 확인창은 이 맥에서 켠 에이전트만, 「커뮤니티에서 삭제」 는 어디서든 켠 에이전트를 보인다', async () => {
    useActiveStore.getState().set({ me: me(['agent.privileged']) as never });
    withAgents([{ name: 'github', credentialKind: 'community' }], [remote('github', { state: 'ok' }, { oauth: false })]);
    render(<McpServersSection />);
    await screen.findByTestId('mcp-cell-primary-github');
    fireEvent.click(screen.getByTestId('mcp-cell-menu-github'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /이 맥에서 지우기/ }));
    const here = await screen.findByTestId('mcp-remove-here-affected');
    expect(here.textContent).toContain('task_manager');
    expect(here.textContent).toContain('harkroom');
    expect(here.textContent).not.toContain('infra_bot');
    fireEvent.click(screen.getByText('취소'));
    fireEvent.click(screen.getByTestId('mcp-cell-menu-github'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '커뮤니티에서 삭제' }));
    const all = await screen.findByTestId('mcp-confirm-affected');
    expect(all.textContent).toContain('3');
    expect(all.textContent).toContain('infra_bot');
  });

  it('에이전트 화면의 링크로 왔으면 그 줄을 강조한다(mcpFocus 를 한 번 꺼낸다)', async () => {
    withAgents([{ name: 'github', credentialKind: 'community' }, { name: 'jira', credentialKind: 'personal' }], []);
    requestMcpFocus('jira');
    render(<McpServersSection />);
    await waitFor(() => expect(screen.getByTestId('mcp-server-jira').getAttribute('data-flash')).toBe('true'));
    expect(screen.getByTestId('mcp-server-github').getAttribute('data-flash')).toBeNull();
    expect(takeMcpFocus()).toBeNull();
  });
});

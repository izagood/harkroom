/**
 * MCP 설정 v2 PR5 — 원격 operator 칸(박동 `status.mcp`, #1451)·D11 토큰 칸 상한 경고·에이전트 절의 원격 상태.
 *
 * 재는 것:
 * - 내가 주인인 원격 operator 만 칸이 된다(D8). 원격 칸은 상태만 — 정의 있음/없음(켠 에이전트면 빨강)/상태 모름/오프라인.
 * - 지문은 오퍼레이터와 같은 식이다(`sha256("harkroom-mcp-client:" + 서버 + "\n" + clientId)` 앞 16 hex).
 * - D11: tokenSlots 프리셋 + 같은 지문 + 그쪽 인증됨/만료 → [인증] 전에 묻는다. 다른 지문·상한 없는 서버는 묻지 않고,
 *   지문을 모르면 창 대신 회색 한 줄.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import type { AgentView, OperatorView } from '@harkroom/shared';
import { McpServersSection } from '../src/components/settings/McpServersSettings';
import { AgentMcpSection } from '../src/components/settings/AgentMcpSection';
import { clientIdFingerprint } from '../src/lib/mcpRemote';
import { MCP_PRESETS } from '../src/lib/mcpPresets';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';
import { setExternalOpener } from '../src/lib/openExternal';
import { takeMcpFocus } from '../src/lib/mcpFocus';

const BASE = 'https://c.example.com';
const ME = 'me';
const OWN_ID = 'own-app-0001';

function fp(clientId: string): string {
  return createHash('sha256').update(`harkroom-mcp-client:${BASE}\n${clientId}`).digest('hex').slice(0, 16);
}

const op = (id: string, name: string, over: Partial<OperatorView> = {}): OperatorView => ({
  id, ownerAccountId: ME, name, createdAt: '', lastSeenAt: '2026-10-21T03:30:00Z', revokedAt: null, online: true, version: '0.4.154',
  ...over,
});
const ag = (id: string, handle: string, operatorId: string, mcpServers: string[]) => ({
  ...acc(id, handle, 'agent'), assignment: { agentId: id, operatorId, assignedBy: ME, assignedAt: '' }, mcpServers,
});
const slackLocal = (auth: Record<string, unknown>, clientId: string = OWN_ID) => ({
  name: 'slack', source: 'operator', transport: 'http', target: 'https://mcp.slack.com/mcp', args: [], envKeys: [], headerKeys: [],
  oauth: true, oauthClientId: clientId, auth,
});

function setup(opts: {
  rows?: { name: string; credentialKind: 'community' | 'personal' }[];
  local?: Record<string, unknown>[];
  operators?: OperatorView[];
  agents?: unknown[];
}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'operator_mcp_list') return { servers: opts.local ?? [] };
      if (cmd === 'operator_agents_list') return { communities: [{ baseUrl: BASE, registered: true, operatorId: 'op-mac', agents: {} }] };
      if (cmd === 'operator_mcp_auth' && args?.action === 'start') return { authUrl: 'https://auth.example.com/authorize' };
      return {};
    },
  };
  const c = {
    api: { baseUrl: BASE },
    mcpServers: vi.fn(async () => (opts.rows ?? [{ name: 'slack', credentialKind: 'personal' }]).map((r) => ({ ...r, createdBy: null, createdAt: '' }))),
    putMcpServer: vi.fn(async () => undefined),
    deleteMcpServer: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => opts.agents ?? []),
    operators: vi.fn(async () => opts.operators ?? []),
    updateAgent: vi.fn(),
    restartAgent: vi.fn(),
  };
  setController(c as unknown as Controller);
  return { calls, c };
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: { ...acc(ME, 'me'), capabilities: [] } as never });
  setExternalOpener({ open: async () => {} });
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  setExternalOpener(null);
  takeMcpFocus();
});

describe('지문 — 오퍼레이터와 같은 값', () => {
  it('같은 입력에 오퍼레이터 식(node crypto)과 같은 16 hex', async () => {
    expect(await clientIdFingerprint(BASE, OWN_ID)).toBe(fp(OWN_ID));
    expect(await clientIdFingerprint(BASE, OWN_ID)).toMatch(/^[0-9a-f]{16}$/);
    expect(await clientIdFingerprint('https://other.example.com', OWN_ID)).not.toBe(fp(OWN_ID));
  });
  it('slack 프리셋만 tokenSlots 를 가진다', () => {
    expect(MCP_PRESETS.filter((p) => p.tokenSlots).map((p) => p.name)).toEqual(['slack']);
  });
});

describe('연동 — 원격 operator 칸', () => {
  it('내가 주인인 원격 operator 만 칸이 된다 — 남의 것·거둔 것·이 맥은 원격 칸이 아니다', async () => {
    setup({
      local: [slackLocal({ state: 'ok' })],
      operators: [
        op('op-mac', 'mac'), op('op-vm', 'dev-vm-01', { status: { turns: { running: 0, max: null }, mcp: [{ name: 'slack', defined: true, source: 'operator', transport: 'http', oauth: true, auth: 'ok', authAt: '2026-10-20T00:12:00Z' }], receivedAt: '' } }),
        op('op-other', 'someone-vm', { ownerAccountId: 'u-2' }), op('op-old', 'old-vm', { revokedAt: '2026-10-01T00:00:00Z' }),
      ],
    });
    render(<McpServersSection />);
    expect(await screen.findByTestId('mcp-cell-slack-op-vm')).toBeTruthy();
    expect(screen.getByTestId('mcp-cell-slack-local')).toBeTruthy();
    expect(screen.queryByTestId('mcp-cell-slack-op-other')).toBeNull();
    expect(screen.queryByTestId('mcp-cell-slack-op-old')).toBeNull();
    expect(screen.queryByTestId('mcp-cell-slack-op-mac')).toBeNull();
    expect(screen.getByTestId('mcp-remote-state-slack').textContent).toBe('있음');
    expect(screen.getByTestId('mcp-remote-auth-slack').textContent).toContain('인증됨');
    // 펼쳐지면 머리 ⋯ 가 따로 서고, 안내는 한 번.
    expect(screen.getAllByTestId('mcp-remote-hint')).toHaveLength(1);
  });

  it('원격 칸 상태별 — 정의 없음+켠 에이전트(빨강) / 상태 모름 / 오프라인', async () => {
    setup({
      rows: [{ name: 'jira', credentialKind: 'personal' }, { name: 'github', credentialKind: 'community' }, { name: 'linear', credentialKind: 'community' }],
      local: [],
      agents: [ag('a-infra', 'infra_bot', 'op-vm', ['jira'])],
      operators: [
        op('op-mac', 'mac'),
        op('op-vm', 'dev-vm-01', { status: { turns: { running: 0, max: null }, mcp: [{ name: 'jira', defined: false }], receivedAt: '' } }),
        op('op-off', 'dev-vm-02', { online: false }),
      ],
    });
    render(<McpServersSection />);
    const jira = await screen.findByTestId('mcp-cell-jira-op-vm');
    expect(jira.textContent).toContain('infra_bot');
    expect(jira.querySelector('.text-danger')).not.toBeNull();
    expect(screen.getByTestId('mcp-cell-github-op-vm').textContent).toContain('상태 모름');
    expect(screen.getByTestId('mcp-cell-linear-op-off').textContent).toContain('오프라인');
    // 원격 칸엔 버튼이 없고 「보기만」.
    expect(jira.querySelector('button')).toBeNull();
    expect(jira.textContent).toContain('보기만');
  });
});

describe('D11 — 토큰 칸 상한 경고', () => {
  const vm = (mcp: unknown[]) => op('op-vm', 'dev-vm-01', { status: { turns: { running: 0, max: null }, mcp: mcp as never, receivedAt: '' } });

  it('같은 지문으로 다른 operator 가 인증돼 있으면 [인증] 전에 묻는다 — [그래도 인증] 이면 연다', async () => {
    const { calls } = setup({
      local: [slackLocal({ state: 'rejected', at: Date.parse('2026-10-21T08:00:00Z') })],
      operators: [op('op-mac', 'mac'), vm([{ name: 'slack', defined: true, oauth: true, auth: 'ok', clientIdFp: fp(OWN_ID) }])],
    });
    render(<McpServersSection />);
    await screen.findByTestId('mcp-cell-slack-op-vm');
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('agent-mcp-auth-start-slack'));
    expect(await screen.findByTestId('mcp-slot-clash-slack')).toBeTruthy();
    expect(calls.some((x) => x.cmd === 'operator_mcp_auth' && x.args?.action === 'start')).toBe(false);
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => expect(calls.some((x) => x.cmd === 'operator_mcp_auth' && x.args?.action === 'start')).toBe(true));
  });

  it('다른 지문이면 묻지 않고 바로 연다', async () => {
    const { calls } = setup({
      local: [slackLocal({ state: 'rejected', at: Date.parse('2026-10-21T08:00:00Z') })],
      operators: [op('op-mac', 'mac'), vm([{ name: 'slack', defined: true, oauth: true, auth: 'ok', clientIdFp: fp('another-app') }])],
    });
    render(<McpServersSection />);
    await screen.findByTestId('mcp-cell-slack-op-vm');
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('agent-mcp-auth-start-slack'));
    await waitFor(() => expect(calls.some((x) => x.cmd === 'operator_mcp_auth' && x.args?.action === 'start')).toBe(true));
    expect(screen.queryByTestId('mcp-slot-clash-slack')).toBeNull();
  });

  it('tokenSlots 가 없는 서버는 같은 지문이어도 묻지 않는다', async () => {
    const gh = { ...slackLocal({ state: 'rejected', at: Date.parse('2026-10-21T08:00:00Z') }), name: 'github', target: 'https://api.example.com/mcp' };
    const { calls } = setup({
      rows: [{ name: 'github', credentialKind: 'community' }],
      local: [gh],
      operators: [op('op-mac', 'mac'), vm([{ name: 'github', defined: true, oauth: true, auth: 'ok', clientIdFp: fp(OWN_ID) }])],
    });
    render(<McpServersSection />);
    await screen.findByTestId('mcp-cell-github-op-vm');
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('agent-mcp-auth-start-github'));
    await waitFor(() => expect(calls.some((x) => x.cmd === 'operator_mcp_auth' && x.args?.action === 'start')).toBe(true));
    expect(screen.queryByTestId('mcp-slot-clash-github')).toBeNull();
  });

  it('다른 operator 의 지문을 모르면 창 대신 칸 아래 회색 한 줄', async () => {
    setup({
      local: [slackLocal({ state: 'ok' })],
      operators: [op('op-mac', 'mac'), op('op-vm', 'dev-vm-01')],
    });
    render(<McpServersSection />);
    const note = await screen.findByTestId('mcp-cell-slot-note-slack');
    expect(note.textContent).toContain('dev-vm-01');
  });
});

describe('에이전트 절 — 원격 배정은 그 호스트 박동으로', () => {
  const agent = (over: Partial<AgentView> = {}): AgentView => ({
    ...(acc('a-infra', 'infra_bot', 'agent', false, { ownerAccountId: ME }) as unknown as AgentView),
    instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
    mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
    lastTurnAt: null, claudeLane: null, invokeScope: 'owner', credentialScope: 'personal', invokers: [], delegates: [],
    assignment: { agentId: 'a-infra', operatorId: 'op-vm', assignedBy: ME, assignedAt: '' } as never,
    mcpServers: ['jira', 'github'], ...over,
  });

  it('켠 이름에 그 호스트 정의가 없으면 단언하고, 링크는 그 호스트 칸으로 간다', async () => {
    setup({
      rows: [{ name: 'jira', credentialKind: 'personal' }, { name: 'github', credentialKind: 'community' }],
      operators: [op('op-mac', 'mac'), op('op-vm', 'dev-vm-01', { status: { turns: { running: 0, max: null }, mcp: [{ name: 'jira', defined: false }, { name: 'github', defined: true, transport: 'http', oauth: true, auth: 'ok' }], receivedAt: '' } })],
    });
    const onOpenSection = vi.fn();
    render(<AgentMcpSection agent={agent()} onUpdated={() => {}} onOpenSection={onOpenSection} />);
    const missing = await screen.findByTestId('agent-mcp-missing-jira');
    expect(missing.textContent).toContain('dev-vm-01');
    expect(missing.className).toContain('text-danger');
    expect(screen.queryByTestId('agent-mcp-unknown-github')).toBeNull();
    // n4: 빨간 글 옆 링크는 강조색이 아니다.
    const linkBtn = screen.getByTestId('agent-mcp-link-jira');
    expect(linkBtn.className).toContain('text-fg-muted');
    expect(linkBtn.className).not.toContain('text-accent');
    fireEvent.click(linkBtn);
    expect(onOpenSection).toHaveBeenCalledWith('integrations');
    expect(takeMcpFocus()).toEqual({ name: 'jira', operatorId: 'op-vm' });
  });

  it('박동이 없으면 켠 줄은 「상태 모름」', async () => {
    setup({ rows: [{ name: 'jira', credentialKind: 'personal' }], operators: [op('op-mac', 'mac'), op('op-vm', 'dev-vm-01')] });
    render(<AgentMcpSection agent={agent({ mcpServers: ['jira'] })} onUpdated={() => {}} />);
    expect((await screen.findByTestId('agent-mcp-unknown-jira')).textContent).toBe('상태 모름');
  });

  it('원격 [+ 추가]: 이미 등록된 이름·켜기 꺼짐이면 비활성 버튼 곁에 이유(n1), 그 호스트에 정의가 있으면 「정의가 없으면」 안내를 띄우지 않는다(n2)', async () => {
    setup({
      rows: [{ name: 'slack', credentialKind: 'personal' }],
      operators: [op('op-mac', 'mac'), op('op-vm', 'dev-vm-01', { status: { turns: { running: 0, max: null }, mcp: [{ name: 'slack', defined: true }], receivedAt: '' } })],
    });
    render(<AgentMcpSection agent={agent({ mcpServers: [] })} onUpdated={() => {}} />);
    await screen.findByTestId('agent-mcp-row-slack');
    await waitFor(() => expect(screen.getByTestId('agent-mcp-where').textContent).toContain('dev-vm-01'));
    fireEvent.click(screen.getByTestId('agent-mcp-add-open'));
    const submit = await screen.findByTestId('mcp-dialog-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('mcp-dialog-foot-note').textContent).toContain('켜려면 위 칸을 고른다');
    expect(screen.queryByTestId('mcp-dialog-attach-remote-note')).toBeNull();
  });
});

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

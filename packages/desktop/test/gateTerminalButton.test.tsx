// 계정 관문 [터미널 열기] 옆에 이 기기에서 순번으로 찾은 계정 이름을 보인다(designer #1978-1) — 누르기 전에 어느
// 계정이 열리는지 사람이 안다. 이름은 이 기기의 오퍼레이터 스냅숏에서만 온다(서버 meta 에는 순번뿐).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { usePrefsStore } from '../src/state/prefsStore';

vi.mock('../src/lib/operatorLocal', () => ({
  hasOperatorLocalSurface: () => true,
  listLocalAgents: async () => ({ communities: [{ baseUrl: 'https://h', agents: { ag: { claudePool: null } } }] }),
}));
vi.mock('../src/lib/claudeAccounts', async (orig) => ({
  ...(await orig<typeof import('../src/lib/claudeAccounts')>()),
  listClaudeAccounts: async () => ({
    root: '/r', mode: 'pools', defaultPool: 'work', agents: {}, strays: [],
    pools: [{ name: 'work', accounts: [{ name: 'acct-1', status: { loggedIn: true } }, { name: 'plum', status: { loggedIn: true } }] }],
  }),
  openClaudeAccountTerminal: vi.fn(async () => {}),
}));
vi.mock('../src/state/controller', () => ({ getController: () => ({ api: { baseUrl: 'https://h' } }) }));

const { GateTerminalButton } = await import('../src/components/GateTerminalButton');

afterEach(() => cleanup());

describe('GateTerminalButton', () => {
  it('열 수 있으면 버튼 옆에 찾은 계정 이름(mono·muted)', async () => {
    usePrefsStore.getState().setLocale('ko');
    render(<GateTerminalButton accountRank={2} agentId="ag" />);
    const name = await screen.findByTestId('gate-terminal-account');
    expect(name.textContent).toBe('plum');
    expect(name.className).toContain('font-mono');
    expect(screen.getByTestId('gate-terminal-open').hasAttribute('disabled')).toBe(false);
  });
  it('목록 밖 순번이면 꺼진 버튼만 — 이름은 없다', async () => {
    usePrefsStore.getState().setLocale('ko');
    render(<GateTerminalButton accountRank={9} agentId="ag" />);
    const btn = await screen.findByTestId('gate-terminal-open');
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.getAttribute('title')).toBe('이 맥의 풀 순서에서 그 계정을 찾지 못했습니다');
    expect(screen.queryByTestId('gate-terminal-account')).toBeNull();
  });
});

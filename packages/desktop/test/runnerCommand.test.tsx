import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

type CreateInput = { handle: string; displayName: string } & Partial<AgentConfig>;
type PatchInput = Partial<AgentConfig> & { displayName?: string };

const fakeController = (agents: AgentView[] = [], pats: PatView[] = []) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    createAgent: vi.fn(async (_input: CreateInput) => ({ agent: agent('fizz'), pat: 'murp_secret' })),
    updateAgent: vi.fn(async (_id: string, _patch: PatchInput) => agent('fizz')),
    listPats: vi.fn(async (): Promise<PatView[]> => pats),
    revokePat: vi.fn(async (): Promise<{ revoked: number }> => ({ revoked: 1 })),
    mintPat: vi.fn(async (): Promise<string> => 'murp_new_token_12345'),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    updateAgentDefaults: vi.fn(async (patch: Partial<AgentDefaults>): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null, ...patch }
    )),
    requestAgentStop: vi.fn(async (id: string): Promise<AgentView> => (
      agent('rusalka', { id, stopRequestedAt: '2026-09-03T10:00:00.000Z', stopAckedAt: null })
    )),
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    deleteAgentMemory: vi.fn(async (): Promise<void> => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
});
afterEach(() => cleanup());

describe('러너 실행 명령 (#177)', () => {
  it('1. 기존 에이전트를 열면(PAT 발급 없이) 명령 틀 보인다', async () => {
    const existingAgent = agent('test-agent');
    fakeController([existingAgent], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);

    await screen.findByText('test-agent');
    fireEvent.click(screen.getByText('test-agent'));

    await screen.findByText('러너 실행');
    expect(screen.getByText(/MURMUR_PAT=<토큰>/)).toBeTruthy();
  });

  it('2. 틀에 실제 토큰 없이 자리표시 문구만 있다', async () => {
    const existingAgent = agent('test-agent');
    fakeController([existingAgent], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);

    await screen.findByText('test-agent');
    fireEvent.click(screen.getByText('test-agent'));

    await screen.findByText('러너 실행');
    const commandEl = screen.getByText(/MURMUR_PAT=<토큰>/);
    const commandText = commandEl.textContent;
    expect(commandText).toContain('<토큰>');
    expect(commandText).not.toContain('murp_');
  });

  it('3. 템플릿에 복사 버튼이 있다', async () => {
    const existingAgent = agent('test-agent');
    fakeController([existingAgent], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);

    await screen.findByText('test-agent');
    fireEvent.click(screen.getByText('test-agent'));

    await screen.findByText('러너 실행');
    const copyBtn = screen.getByRole('button', { name: '명령 복사' });
    expect(copyBtn).toBeTruthy();
    expect(copyBtn.textContent).toBe('복사');
  });

  it('4. 발급 직후 전체 토큰 명령이 복사 버튼과 함께 보인다', async () => {
    fakeController([], []);
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'newagent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(screen.getByText(/이 토큰은 지금만 보인다/)));

    expect(screen.getByText(/MURMUR_PAT=murp_secret/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '명령 복사' })).toBeTruthy();
  });

  it('5. PAT 가 없으면 명령 틀도 복사 버튼도 안 보인다', async () => {
    const existingAgent = agent('test-agent');
    fakeController([existingAgent], []);
    render(<AgentsSettings />);

    await screen.findByText('test-agent');
    fireEvent.click(screen.getByText('test-agent'));

    await screen.findByText('PAT (Personal Access Token)');
    expect(screen.queryByText('러너 실행')).toBeNull();
  });
});
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
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

// 발급 직후 화면과 상시 틀은 둘 다 `aria-label="명령 복사"` 버튼을 갖는다(설계상 같은 이름이다).
// 그래서 테스트는 어느 절의 버튼인지 절 제목으로 좁혀서 집는다.
const sectionOf = (heading: string | RegExp): HTMLElement => {
  const el = screen.getByText(heading).parentElement;
  if (!el) throw new Error(`절을 못 찾았다: ${String(heading)}`);
  return el;
};
const RUNNER_SECTION = '러너 실행';
const MINTED_SECTION = /이 토큰은 지금만 보인다/;

/** 상세를 열어 상시 "러너 실행" 절이 그려질 때까지 기다린다. */
const openAgent = async (handle: string) => {
  await screen.findByText(handle);
  fireEvent.click(screen.getByText(handle));
  await screen.findByText(RUNNER_SECTION);
};

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('러너 실행 명령 (#177)', () => {
  it('1. 기존 에이전트를 열면(PAT 발급 없이) 명령 틀이 보인다', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    expect(screen.getByText(/MURMUR_PAT=<발급한 토큰>/)).toBeTruthy();
  });

  it('1b. PAT 가 0 개인 에이전트에서도 틀은 보인다 — 발급 직후만이 아니다', async () => {
    fakeController([agent('test-agent')], []);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    expect(screen.getByText(/MURMUR_PAT=<발급한 토큰>/)).toBeTruthy();
  });

  it('2. 틀에는 토큰이 없고 자리표시 문구가 있다', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    const commandText = screen.getByText(/MURMUR_PAT=<발급한 토큰>/).textContent ?? '';
    expect(commandText).toContain('<발급한 토큰>');
    expect(commandText).not.toContain('murp_');
  });

  it('3. 복사 버튼이 clipboard.writeText 를 명령 전체로 호출한다 — 잘리지 않는다(#125)', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    fireEvent.click(within(sectionOf(RUNNER_SECTION)).getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // 명령 전체다: 앞의 환경변수 지정부터 뒤의 `start` 까지. 말줄임표가 있으면 잘린 것이다.
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toBe('MURMUR_PAT=<발급한 토큰> pnpm --filter @murmur/agent start');
    expect(copied).not.toContain('…');
    expect(copied).not.toContain('...');
  });

  it('4. 발급 직후 화면에서는 전체 토큰이 든 명령이 복사된다', async () => {
    fakeController([], []);
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'newagent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await screen.findByText(MINTED_SECTION);

    fireEvent.click(within(sectionOf(MINTED_SECTION)).getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // 토큰이 통째로 실린다 — 접두사만 맞는지가 아니라 정확히 같은지를 본다.
    expect(String(writeText.mock.calls[0]?.[0])).toBe('MURMUR_PAT=murp_secret pnpm --filter @murmur/agent start');
    // 버튼 문구가 잠깐 "복사됨"으로 바뀐다.
    await screen.findByText('복사됨');
  });

  it('4b. 발급 직후가 아닌 화면에서는 어떤 버튼도 전체 토큰을 클립보드에 넣지 못한다', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    // 발급 직후 절 자체가 없다 — 전체 토큰이 든 명령도, 그것을 복사할 버튼도 없다.
    expect(screen.queryByText(MINTED_SECTION)).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('murp_');
    // 이 화면의 복사 버튼은 하나뿐이고, 그것은 자리표시 틀을 복사한다.
    const copyButtons = screen.getAllByRole('button', { name: '명령 복사' });
    expect(copyButtons).toHaveLength(1);
    fireEvent.click(within(sectionOf(RUNNER_SECTION)).getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0])).not.toContain('murp_');
  });

  it('5. clipboard 가 없으면 텍스트가 선택되고 오류가 화면에 보인다 — 조용히 실패하지 않는다', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    const command = screen.getByText(/MURMUR_PAT=<발급한 토큰>/);
    fireEvent.click(within(sectionOf(RUNNER_SECTION)).getByRole('button', { name: '명령 복사' }));

    // 오류가 보이는 자리에 있다 — `sr-only` 나 콘솔이 아니라 사람이 읽는 텍스트다.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('⌘C');
    expect(alert.className).not.toContain('sr-only');
    // "복사됨" 을 거짓으로 띄우지 않는다.
    expect(screen.queryByText('복사됨')).toBeNull();
    // 그리고 화면의 그 명령 텍스트가 실제로 선택 상태다.
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(command.contains(selection!.getRangeAt(0).startContainer)).toBe(true);
    expect(selection?.toString()).toContain('MURMUR_PAT');
  });
});

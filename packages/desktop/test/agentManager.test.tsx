import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentManager } from '../src/components/AgentManager';
import { acc } from './helpers/fakeApi';

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null, ...extra,
});

type CreateInput = { handle: string; displayName: string } & Partial<AgentConfig>;
type PatchInput = Partial<AgentConfig> & { displayName?: string };

const fakeController = (agents: AgentView[] = []) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    createAgent: vi.fn(async (_input: CreateInput) => ({ agent: agent('fizz'), pat: 'murp_secret' })),
    updateAgent: vi.fn(async (_id: string, _patch: PatchInput) => agent('fizz')),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin') });
});
afterEach(() => cleanup());

describe('AgentManager', () => {
  it('creates an agent from the name and instructions the operator typed', async () => {
    const c = fakeController();
    render(<AgentManager onClose={() => {}} />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.change(screen.getByLabelText('Agent instructions'), {
      target: { value: '느린 쿼리를 찾아 원인을 설명한다.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(c.createAgent).toHaveBeenCalled());
    expect(c.createAgent.mock.calls[0]![0]).toMatchObject({
      handle: 'fizz', instructions: '느린 쿼리를 찾아 원인을 설명한다.', harness: 'claude-code',
    });
  });

  // PAT 는 생성 직후 한 번만 보여줄 수 있다(서버가 해시만 보관한다). 놓치면 러너를 띄울 수 없다.
  it('shows the new PAT once so the operator can start the runner', async () => {
    fakeController();
    render(<AgentManager onClose={() => {}} />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    // 토큰은 코드 블록과 실행 힌트 두 곳에 나온다 — 보이는지만 확인한다.
    expect((await screen.findAllByText(/murp_secret/)).length).toBeGreaterThan(0);
  });

  it('refuses to submit without a name', async () => {
    const c = fakeController();
    render(<AgentManager onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create agent' }));

    expect(c.createAgent).not.toHaveBeenCalled();
  });

  // murmur 가 실행할 수 없는 harness 를 고를 수 있으면 안 된다. 없는 것은 사용자의 CLI 가
  // 아니라 murmur 의 구현이므로 '지원 예정'이라고 적는다.
  it('offers only the harness murmur can actually run', async () => {
    fakeController();
    render(<AgentManager onClose={() => {}} />);

    const options = (await screen.findByLabelText('Agent harness')).querySelectorAll('option');
    const enabled = [...options].filter((o) => !(o as HTMLOptionElement).disabled);

    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.textContent).toContain('claude-code');
    expect([...options].some((o) => o.textContent?.includes('지원 예정'))).toBe(true);
  });

  it('lists the agents that already exist', async () => {
    fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentManager onClose={() => {}} />);

    expect(await screen.findByText('rusalka')).toBeTruthy();
  });

  it('loads an existing agent into the form for editing', async () => {
    fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentManager onClose={() => {}} />);

    fireEvent.click(await screen.findByText('rusalka'));

    expect((screen.getByLabelText('Agent instructions') as HTMLTextAreaElement).value).toBe('기존 지시문');
  });

  // 저장은 폼 전체를 보낸다 — 바뀐 필드만 보내면 'harness 기본값으로 되돌리기'를 표현할 수 없다.
  it('saves the whole definition when an edit is submitted', async () => {
    const c = fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentManager onClose={() => {}} />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.change(screen.getByLabelText('Agent instructions'), { target: { value: '고친 지시문' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    const [id, patch] = c.updateAgent.mock.calls[0]!;
    expect(id).toBe('id-rusalka');
    expect(patch).toMatchObject({ instructions: '고친 지시문', harness: 'claude-code' });
  });

  // 'Use harness defaults' 로 되돌리는 조작은 model/effort 를 null 로 비우는 것이다 —
  // 필드를 그냥 안 보내면 서버가 기존 값을 유지해 되돌리기가 되지 않는다.
  it('clears model and effort when the operator returns to harness defaults', async () => {
    const c = fakeController([agent('rusalka', { model: 'claude-opus-5', effort: 'high' })]);
    render(<AgentManager onClose={() => {}} />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.click(screen.getByRole('button', { name: 'Use harness defaults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    expect(c.updateAgent.mock.calls[0]![1]).toMatchObject({ model: null, effort: null });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, ...extra,
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

describe('AgentsSettings', () => {
  it('creates an agent from the name and instructions the operator typed', async () => {
    const c = fakeController();
    render(<AgentsSettings />);

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
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    // 토큰은 코드 블록과 실행 힌트 두 곳에 나온다 — 보이는지만 확인한다.
    expect((await screen.findAllByText(/murp_secret/)).length).toBeGreaterThan(0);
  });

  it('refuses to submit without a name', async () => {
    const c = fakeController();
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create agent' }));

    expect(c.createAgent).not.toHaveBeenCalled();
  });

  // murmur 가 실행할 수 없는 harness 를 고를 수 있으면 안 된다. 없는 것은 사용자의 CLI 가
  // 아니라 murmur 의 구현이므로 '지원 예정'이라고 적는다.
  it('offers only the harness murmur can actually run', async () => {
    fakeController();
    render(<AgentsSettings />);

    const options = (await screen.findByLabelText('Agent harness')).querySelectorAll('option');
    const enabled = [...options].filter((o) => !(o as HTMLOptionElement).disabled);

    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.textContent).toContain('claude-code');
    expect([...options].some((o) => o.textContent?.includes('지원 예정'))).toBe(true);
  });

  // AGENT_HARNESSES(타입이 아는 이름)와 RUNNABLE_HARNESSES(러너가 실제로 돌릴 수 있는 부분집합)가
  // 갈라질 수 있다 — codex 가 타입 목록에는 들어왔지만 아직 러너가 못 돌린다. 옵션 자체는 보이되
  // disabled 여야 한다. 다음 harness 가 타입에 먼저 들어오고 UI 가 안 따라가는 재발을 막는 회귀 테스트.
  it('shows a harness the type list knows but the runner cannot yet run — as a disabled option', async () => {
    fakeController();
    render(<AgentsSettings />);

    const options = [...(await screen.findByLabelText('Agent harness')).querySelectorAll('option')];
    const codex = options.find((o) => o.textContent?.includes('codex'));

    expect(codex).toBeTruthy();
    expect((codex as HTMLOptionElement).disabled).toBe(true);
  });

  it('lists the agents that already exist', async () => {
    fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentsSettings />);

    expect(await screen.findByText('rusalka')).toBeTruthy();
  });

  it('loads an existing agent into the form for editing', async () => {
    fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByText('rusalka'));

    expect((screen.getByLabelText('Agent instructions') as HTMLTextAreaElement).value).toBe('기존 지시문');
  });

  // 저장은 폼 전체를 보낸다 — 바뀐 필드만 보내면 'harness 기본값으로 되돌리기'를 표현할 수 없다.
  it('saves the whole definition when an edit is submitted', async () => {
    const c = fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentsSettings />);
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
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.click(screen.getByRole('button', { name: 'Use harness defaults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    expect(c.updateAgent.mock.calls[0]![1]).toMatchObject({ model: null, effort: null });
  });

  // mentionPermission 은 화면 앞에 사람이 없는 턴의 권한이다. 기본값은 auto — 설정을
  // 건드린 적 없는 에이전트도 도구를 쓸 수 있어야 한다.
  it('renders mention permission as auto by default and sends readonly when chosen', async () => {
    const c = fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect((screen.getByLabelText('Mention permission') as HTMLSelectElement).value).toBe('auto');

    fireEvent.change(screen.getByLabelText('Mention permission'), { target: { value: 'readonly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    expect(c.updateAgent.mock.calls[0]![1]).toMatchObject({ mentionPermission: 'readonly' });
  });

  // fromView 매핑에서 빠지기 쉬운 지점 — 이미 readonly 로 저장된 에이전트를 다시 열었을 때
  // select 가 저장된 값을 보여줘야지 auto 로 되돌아가면 안 된다.
  it('shows readonly when reopening an agent already set to readonly', async () => {
    fakeController([agent('rusalka', { mentionPermission: 'readonly' })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect((screen.getByLabelText('Mention permission') as HTMLSelectElement).value).toBe('readonly');
  });
});

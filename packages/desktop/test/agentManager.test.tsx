import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentView, PatView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, ...extra,
});

type CreateInput = { handle: string; displayName: string } & Partial<AgentConfig>;
type PatchInput = Partial<AgentConfig> & { displayName?: string };

const fakeController = (agents: AgentView[] = []) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    createAgent: vi.fn(async (_input: CreateInput) => ({ agent: agent('fizz'), pat: 'murp_secret' })),
    updateAgent: vi.fn(async (_id: string, _patch: PatchInput) => agent('fizz')),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    revokePat: vi.fn(async (): Promise<{ revoked: number }> => ({ revoked: 1 })),
    mintPat: vi.fn(async (): Promise<string> => 'murp_new'),
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

  // … 가 토큰 조각 뒤에 붙은 형태는 복사하면 인증이 실패한다. 그런 문자열이 화면에 있으면 안 된다.
  it('does not show broken token hint with ellipsis after partial token', async () => {
    fakeController();
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    // "토큰 조각 + 말줄임표" 형태가 화면에 있으면 안 된다 — 복사하면 인증이 실패한다.
    const panel = await screen.findByText(/이 토큰은 지금만 보인다/);
    const panelContent = panel.parentElement?.textContent ?? '';
    expect(panelContent).not.toMatch(/murp_secre[A-Za-z0-9+/=]*…/);
  });

  // 명령 힌트에 전체 토큰이 들어가 있어야 복사해서 바로 쓸 수 있다.
  it('shows the full token in the command hint so it can be copy-pasted', async () => {
    fakeController();
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    // 명령 힌트에 토큰이 **잘리지 않은 채** 들어 있어야 복사해서 바로 쓸 수 있다.
    const panel = await screen.findByText(/이 토큰은 지금만 보인다/);
    const panelContent = panel.parentElement?.textContent ?? '';
    expect(panelContent).toMatch(/MURMUR_PAT=murp_secret/);
  });

  // 에이전트는 러너 프로세스가 붙어야 멘션에 답할 수 있다 — 그 사실을 알려주어야 한다.
  it('shows a hint that runner is required for the agent to respond', async () => {
    fakeController();
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    // 문구를 느슨한 정규식으로 잡으면 관계없는 문장에 우연히 걸린다 — 이 안내가 반드시
    // 말해야 하는 두 가지를 각각 확인한다: murmur 가 러너를 띄우지 않는다는 것과,
    // 붙이기 전까지 답하지 않는다는 것.
    expect(await screen.findByText(/murmur 는 러너를 띄우지 않는다/)).toBeTruthy();
    expect(screen.getByText(/멘션에 답하지 않는다/)).toBeTruthy();
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

  describe('PAT management', () => {
    const pats: PatView[] = [
      { label: 'runner', createdAt: '2024-01-01T00:00:00Z', revokedAt: null },
      { label: 'backup', createdAt: '2024-01-02T00:00:00Z', revokedAt: '2024-01-03T00:00:00Z' },
    ];

    it('shows PAT section when editing an agent and user is admin', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue(pats);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      expect(await screen.findByText('PAT (Personal Access Token)')).toBeTruthy();
    });

    it('does not show PAT section when user is not admin', async () => {
      useAppStore.getState().set({ me: acc('u1', 'user', 'human', false) });
      fakeController([agent('rusalka')]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      expect(screen.queryByText('PAT (Personal Access Token)')).toBeNull();
    });

    it('lists PATs when editing an agent', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue(pats);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      expect(await screen.findByText('runner')).toBeTruthy();
      expect(await screen.findByText('backup')).toBeTruthy();
    });

    it('shows revoked PATs with indicator', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue(pats);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      expect(await screen.findByText('(폐기됨)')).toBeTruthy();
    });

    it('calls revokePat when confirming revoke', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue(pats);
      (c.revokePat as ReturnType<typeof vi.fn>).mockResolvedValue({ revoked: 1 });
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      const revokeBtn = await screen.findByText('Revoke');
      fireEvent.click(revokeBtn);
      const confirmBtn = await screen.findByText('Really revoke');
      fireEvent.click(confirmBtn);

      await waitFor(() => expect(c.revokePat).toHaveBeenCalledWith('id-rusalka', 'runner'));
    });

    it('shows newly minted PAT once', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (c.mintPat as ReturnType<typeof vi.fn>).mockResolvedValue('murp_new_token');
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      const newPatBtn = await screen.findByRole('button', { name: '+ New PAT' });
      fireEvent.click(newPatBtn);

      expect((await screen.findAllByText(/murp_new_token/)).length).toBeGreaterThan(0);
      expect(await screen.findByText(/이 토큰은 지금만 보인다/)).toBeTruthy();
    });
  });

  describe('owner management', () => {
    const accounts = {
      u1: acc('u1', 'admin', 'human', true),
      u2: acc('u2', 'alice', 'human', false),
      u3: acc('u3', 'botty', 'agent', false),
    };

    beforeEach(() => {
      useAppStore.getState().set({ accounts });
    });

    it('shows owner as handle, not id', async () => {
      fakeController([agent('rusalka', { ownerAccountId: 'u2' })]);
      render(<AgentsSettings />);

      expect(await screen.findByText('alice')).toBeTruthy();
      expect(screen.queryByText('u2')).toBeNull();
    });

    it('shows "없음" when owner is null', async () => {
      fakeController([agent('rusalka', { ownerAccountId: null })]);
      render(<AgentsSettings />);

      expect(await screen.findByText('없음')).toBeTruthy();
    });

    // 소유자 id 는 있는데 디렉터리에 그 계정이 없으면 "모른다" 다. 빈 칸으로 그리면
    // "없다"와 구분되지 않는다 — 워커 초안이 그 경우에 아무것도 렌더하지 않았다.
    it('소유자 id 가 디렉터리에 없으면 빈 칸이 아니라 명시적으로 표시한다', async () => {
      fakeController([agent('rusalka', { ownerAccountId: 'ghost-account' })]);
      render(<AgentsSettings />);

      expect(await screen.findByText('알 수 없는 계정')).toBeTruthy();
      expect(screen.queryByText('없음')).toBeNull();
    });

    it('does not show owner control for non-admin', async () => {
      useAppStore.getState().set({ me: acc('u2', 'alice', 'human', false) });
      fakeController([agent('rusalka', { ownerAccountId: 'u2' })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      expect(screen.queryByLabelText('Owner')).toBeNull();
      expect(await screen.findByText(/소유자: @alice/)).toBeTruthy();
    });

    it('shows owner control for admin', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      fakeController([agent('rusalka', { ownerAccountId: 'u2' })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      expect(await screen.findByLabelText('Owner')).toBeTruthy();
    });

    it('sends ownerAccountId when admin selects an owner', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka', { ownerAccountId: null })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'u2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
      expect(c.updateAgent.mock.calls[0]![1].ownerAccountId).toBe('u2');
    });

    it('sends ownerAccountId: null when admin clears the owner (not undefined)', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka', { ownerAccountId: 'u2' })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      fireEvent.change(screen.getByLabelText('Owner'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
      expect(c.updateAgent.mock.calls[0]![1].ownerAccountId).toBeNull();
    });

    it('filters candidate list to exclude agent accounts', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      fakeController([agent('rusalka', { ownerAccountId: null })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));

      const ownerSelect = await screen.findByLabelText('Owner');
      const options = ownerSelect.querySelectorAll('option');
      const optionTexts = [...options].map((o) => o.textContent);

      expect(optionTexts.some((t) => t.includes('botty'))).toBe(false);
      expect(optionTexts.some((t) => t.includes('alice'))).toBe(true);
    });
  });
});

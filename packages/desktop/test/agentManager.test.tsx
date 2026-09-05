import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  // #129: 종료 요청은 읽기 전용 사실이다 — 기본은 '요청 없음'이고, 필요한 테스트가 덮는다.
  stopRequestedAt: null, stopAckedAt: null,
  // #176: 기본은 '아직 한 번도 턴을 돌린 적 없음'이다 — 화면은 그것을 '활동 없음'으로만 그린다.
  lastTurnAt: null,
  // #186: 에이전트는 상태를 고를 수 없지만 AccountView 의 필수 필드다.
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
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
    // #171: 기본은 "읽었다". 실패가 필요한 테스트가 갈아끼운다.
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    updateAgentDefaults: vi.fn(async (patch: Partial<AgentDefaults>): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null, ...patch }
    )),
    // #129: 기본은 "요청이 갔다". 응답으로 온 정의가 화면의 상태를 정한다.
    requestAgentStop: vi.fn(async (id: string): Promise<AgentView> => (
      agent('rusalka', { id, stopRequestedAt: '2026-09-03T10:00:00.000Z', stopAckedAt: null })
    )),
    // #139: 기본은 "읽었고 비어 있다". 실패나 목록이 필요한 테스트가 갈아끼운다.
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    deleteAgentMemory: vi.fn(async (): Promise<void> => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  // 에이전트 설정은 admin 화면이다 — 생성도 기본값 조회도 서버가 admin 만 받는다.
  // 기본값이 admin 이 아니면 이 파일의 생성 테스트들이 실제로는 서버가 거절할 흐름을
  // 검증하게 된다. admin 이 아닌 경우는 그것을 확인하는 테스트가 따로 덮어쓴다.
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
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

    expect(enabled).toHaveLength(2);
    expect(enabled.some((o) => o.textContent?.includes('claude-code'))).toBe(true);
    expect(enabled.some((o) => o.textContent?.includes('codex'))).toBe(true);
    expect([...options].some((o) => o.textContent?.includes('지원 예정'))).toBe(true);
  });

  // AGENT_HARNESSES(타입이 아는 이름)와 RUNNABLE_HARNESSES(러너가 실제로 돌릴 수 있는 부분집합)가
  // 갈라질 수 있다 — gemini 는 타입 목록에는 들어왔지만 아직 러너가 못 돌린다. 옵션 자체는 보이되
  // disabled 여야 한다. 다음 harness 가 타입에 먼저 들어오고 UI 가 안 따라가는 재발을 막는 회귀 테스트.
  it('shows a harness the type list knows but the runner cannot yet run — as a disabled option', async () => {
    fakeController();
    render(<AgentsSettings />);

    const options = [...(await screen.findByLabelText('Agent harness')).querySelectorAll('option')];
    const gemini = options.find((o) => o.textContent?.includes('gemini'));

    expect(gemini).toBeTruthy();
    expect((gemini as HTMLOptionElement).disabled).toBe(true);
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

describe('에이전트 기억 (#139 3단계)', () => {
  const mem = (slug: string, value: string) => ({ slug, value, updatedAt: '2026-09-03T00:00:00.000Z' });

  it('기억 목록이 slug 와 값으로 그려진다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockResolvedValue([mem('core', '재빈은 러너를 담당한다')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect(await screen.findByText('core')).toBeTruthy();
    expect(screen.getByText('재빈은 러너를 담당한다')).toBeTruthy();
  });

  // 빈 목록을 그대로 두면 "기억이 없다" 와 "못 읽었다" 가 구분되지 않는다.
  it('기억이 없으면 "없다" 가 보인다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockResolvedValue([]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect(await screen.findByText('기억이 없다')).toBeTruthy();
  });

  // 실패를 빈 배열로 삼키면 위 "없다" 와 같은 화면이 된다 — 이게 이 절의 핵심 구분이다.
  it('조회가 실패하면 오류가 보인다 — "없다" 가 아니다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockRejectedValue(new Error('boom'));
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('기억이 없다')).toBeNull();
  });

  it('삭제에 확인이 한 번 더 있고 확인해야 실제로 지운다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockResolvedValue([mem('mem/deploy', '배포는 redeploy.sh')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.click(await screen.findByRole('button', { name: 'mem/deploy 기억 지우기' }));
    expect(c.deleteAgentMemory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('정말 지운다'));
    await waitFor(() => expect(c.deleteAgentMemory).toHaveBeenCalledWith('id-rusalka', 'mem/deploy'));
  });

  // 편집을 넣지 않은 것이 결정이다 — 사람이 고쳐도 에이전트가 다음 턴에 덮어쓰면
  // 사람은 자기 수정이 왜 사라졌는지 알 수 없다.
  it('기억을 편집하는 입력이 없다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockResolvedValue([mem('core', '값')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));
    await screen.findByText('core');

    expect(screen.queryByLabelText(/기억.*편집|edit.*memory/i)).toBeNull();
    // 값은 pre 로 그린다 — 입력 필드가 아니다.
    expect(screen.getByText('값').tagName).toBe('PRE');
  });
});

// #171: 새 에이전트의 기본값.
describe('새 에이전트 기본값', () => {
  it('새 에이전트 초안을 서버가 준 기본값으로 채운다 — 컴포넌트가 지어내지 않는다', async () => {
    const c = fakeController();
    c.agentDefaults.mockResolvedValue({ harness: 'claude-code', model: 'sonnet-x', effort: 'high' });
    render(<AgentsSettings />);

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(c.createAgent).toHaveBeenCalled());
    expect(c.createAgent.mock.calls[0]![0]).toMatchObject({
      harness: 'claude-code', model: 'sonnet-x', effort: 'high',
    });
  });

  /**
   * 조회 실패를 조용한 기본값으로 삼키면, 화면에 보이는 harness 가 운영자가 정한 것인지
   * 컴포넌트가 지어낸 것인지 사람이 구분할 수 없다. 같은 파일의 PAT 로더가
   * `.catch(() => setPats([]))` 로 그렇게 하고 있는데, 그것을 따라 하지 않는다.
   */
  it('기본값 조회가 실패하면 오류가 보이고, 초안을 지어내지 않는다', async () => {
    const c = fakeController();
    c.agentDefaults.mockRejectedValue(new Error('boom'));
    render(<AgentsSettings />);

    expect((await screen.findByRole('alert')).textContent).toContain('기본값을 불러오지 못했다');
    // 조용한 기본값이 아니다 — 초안 자체가 없으므로 harness 를 고르는 자리도 없다.
    expect(screen.queryByLabelText('Agent harness')).toBeNull();
    expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(true);
  });


  // 복사본이므로 만들어진 뒤에는 '물려받았다'가 더 이상 참이 아니다 — 표시하면 거짓말이 된다.
  it('좌측 목록은 실제 harness 만 보여준다 — 물려받았다는 표시를 두지 않는다', async () => {
    fakeController([agent('rusalka', { harness: 'claude-code' })]);
    render(<AgentsSettings />);

    const row = await screen.findByText('rusalka');
    expect(row.textContent).toContain('claude-code');
    expect(row.textContent).not.toMatch(/기본값|inherit/i);
  });
});

/**
 * 러너 종료 요청(#129). 화면이 말할 수 있는 것은 **세 가지**뿐이다:
 * 요청 없음 / 요청했고 러너가 아직 못 봄 / 러너가 읽어 감.
 * 넷째("멈췄다")는 murmur 가 알 수 없는 사실이라 절대 쓰지 않는다 — 러너가 종료하면
 * 다음 GET /agent/config 자체가 오지 않으므로 서버는 프로세스의 생사를 관측하지 못한다.
 */
describe('러너 종료 요청 (#129)', () => {
  /** 종료 요청 절만 떼어 본다 — 다른 절의 문구가 단언에 섞이지 않게 한다. */
  const stopPanel = async () => (await screen.findByText('러너 종료 요청')).parentElement!;

  beforeEach(() => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
  });

  it('요청 전에는 요청이 없다고만 말하고, 누르면 아직 읽어 가지 않았음을 보여준다', async () => {
    const c = fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect((await stopPanel()).textContent).toContain('종료를 요청한 적이 없다');

    fireEvent.click(screen.getByRole('button', { name: '러너 종료 요청' }));
    await waitFor(() => expect(c.requestAgentStop).toHaveBeenCalledWith('id-rusalka'));

    const panel = await stopPanel();
    await waitFor(() => expect(panel.textContent).toContain('아직 읽어 가지 않았다'));
    expect(panel.textContent).not.toContain('종료를 요청한 적이 없다');
  });

  it('러너가 읽어 간 상태는 요청만 한 상태와 다르게 보인다', async () => {
    fakeController([agent('rusalka', {
      stopRequestedAt: '2026-09-03T10:00:00.000Z',
      stopAckedAt: '2026-09-03T10:00:20.000Z',
    })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    const panel = await stopPanel();
    expect(panel.textContent).toContain('러너가 요청을 읽어 갔다');
    expect(panel.textContent).not.toContain('아직 읽어 가지 않았다');
    expect(panel.textContent).not.toContain('종료를 요청한 적이 없다');
  });

  it('어느 상태에서도 멈췄다고 단정하지 않는다', async () => {
    // 세 상태를 모두 그려 보고, 셋 다 murmur 가 관측할 수 없는 사실을 주장하지 않는지 본다.
    const states: Partial<AgentView>[] = [
      {},
      { stopRequestedAt: '2026-09-03T10:00:00.000Z', stopAckedAt: null },
      { stopRequestedAt: '2026-09-03T10:00:00.000Z', stopAckedAt: '2026-09-03T10:00:20.000Z' },
    ];
    for (const state of states) {
      fakeController([agent('rusalka', state)]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByText('rusalka'));
      const text = (await stopPanel()).textContent ?? '';

      // 프로세스의 생사를 단정하는 문구, 그리고 murmur 가 하지 않는 일(재시작)의 약속.
      expect(text).not.toMatch(/멈췄|멈춤|중지됨|종료됨|정지됨|재시작/);
      // 대신 반드시 있어야 하는 것: 다시 띄우는 것은 사람의 몫이라는 사실.
      expect(text).toContain('다시 띄우는 것은 사람');
      cleanup();
    }
  });

  it('러너가 읽어 갔다는 표시가 종료를 뜻하지 않음을 화면이 직접 말한다', async () => {
    fakeController([agent('rusalka', {
      stopRequestedAt: '2026-09-03T10:00:00.000Z',
      stopAckedAt: '2026-09-03T10:00:20.000Z',
    })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect((await stopPanel()).textContent).toContain('실제로 종료했는지는 murmur 가 알 수 없다');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { translator } from '../src/i18n';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';
import { ApiError } from '../src/lib/api';

/** 문구가 아니라 **사실**을 잰다 — 어투가 바뀌어도(`~습니다` → `~다`) 이 축은 산다. */
const ko = translator('ko');

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  claudeLane: null,
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
    // 사진을 건 에이전트를 그리면 `Identity` 가 바이트를 받으러 온다 — 없으면 화면이
    // 아니라 스텁이 터진다. 이 화면은 사진을 건 에이전트를 정상적으로 그린다.
    fetchAvatar: vi.fn(async (): Promise<Blob> => new Blob(['png-bytes'])),
  };
  setController(c as unknown as Controller);
  return c;
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(`#619`·사이드바 PR 이
// 세운 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면
// 한국어라고 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  // 에이전트 설정은 admin 화면이다 — 생성도 기본값 조회도 서버가 admin 만 받는다.
  // 기본값이 admin 이 아니면 이 파일의 생성 테스트들이 실제로는 서버가 거절할 흐름을
  // 검증하게 된다. admin 이 아닌 경우는 그것을 확인하는 테스트가 따로 덮어쓴다.
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('AgentsSettings', () => {
  it('creates an agent from the name and instructions the operator typed', async () => {
    const c = fakeController();
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.change(screen.getByLabelText('Agent instructions'), {
      target: { value: '느린 쿼리를 찾아 원인을 설명한다.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));

    await waitFor(() => expect(c.createAgent).toHaveBeenCalled());
    expect(c.createAgent.mock.calls[0]![0]).toMatchObject({
      handle: 'fizz', instructions: '느린 쿼리를 찾아 원인을 설명한다.', harness: 'claude-code',
    });
  });

  // PAT 는 생성 직후 한 번만 보여줄 수 있다(서버가 해시만 보관한다). 놓치면 러너를 띄울 수 없다.
  it('shows the new PAT once so the operator can start the runner', async () => {
    fakeController();
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));

    // 토큰은 코드 블록과 실행 힌트 두 곳에 나온다 — 보이는지만 확인한다.
    expect((await screen.findAllByText(/murp_secret/)).length).toBeGreaterThan(0);
  });

  // … 가 토큰 조각 뒤에 붙은 형태는 복사하면 인증이 실패한다. 그런 문자열이 화면에 있으면 안 된다.
  it('does not show broken token hint with ellipsis after partial token', async () => {
    fakeController();
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));

    // "토큰 조각 + 말줄임표" 형태가 화면에 있으면 안 된다 — 복사하면 인증이 실패한다.
    const panel = await screen.findByText(/이 토큰은 지금만 보인다/);
    const panelContent = panel.parentElement?.textContent ?? '';
    expect(panelContent).not.toMatch(/murp_secre[A-Za-z0-9+/=]*…/);
  });

  // 명령 힌트에 전체 토큰이 들어가 있어야 복사해서 바로 쓸 수 있다.
  it('shows the full token in the command hint so it can be copy-pasted', async () => {
    fakeController();
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));

    // 명령 힌트에 토큰이 **잘리지 않은 채** 들어 있어야 복사해서 바로 쓸 수 있다.
    const panel = await screen.findByText(/이 토큰은 지금만 보인다/);
    const panelContent = panel.parentElement?.textContent ?? '';
    expect(panelContent).toMatch(/MURMUR_PAT=murp_secret/);
  });

  // 에이전트는 러너 프로세스가 붙어야 멘션에 답할 수 있다 — 그 사실을 알려주어야 한다.
  it('shows a hint that runner is required for the agent to respond', async () => {
    fakeController();
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));

    // 문구를 느슨한 정규식으로 잡으면 관계없는 문장에 우연히 걸린다 — 이 안내가 반드시
    // 말해야 하는 두 가지를 각각 확인한다: murmur 가 러너를 띄우지 않는다는 것과,
    // 붙이기 전까지 답하지 않는다는 것.
    expect(await screen.findByText(/harkroom 는 러너를 띄우지 않는다/)).toBeTruthy();
    expect(screen.getByText(/멘션에 답하지 않는다/)).toBeTruthy();
  });

  it('refuses to submit without a name', async () => {
    const c = fakeController();
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.click(await screen.findByRole('button', { name: '에이전트 만들기' }));

    expect(c.createAgent).not.toHaveBeenCalled();
  });

  // murmur 가 실행할 수 없는 harness 를 고를 수 있으면 안 된다. 없는 것은 사용자의 CLI 가
  // 아니라 murmur 의 구현이므로 '지원 예정'이라고 적는다.
  it('offers only the harness murmur can actually run', async () => {
    fakeController();
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

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
    // Task 15: 그리드가 먼저 뜬다 — 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    const options = [...(await screen.findByLabelText('Agent harness')).querySelectorAll('option')];
    const gemini = options.find((o) => o.textContent?.includes('gemini'));

    expect(gemini).toBeTruthy();
    expect((gemini as HTMLOptionElement).disabled).toBe(true);
  });

  it('lists the agents that already exist', async () => {
    fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentsSettings />);

    expect(await screen.findByTestId('agent-card-rusalka')).toBeTruthy();
  });

  it('loads an existing agent into the form for editing', async () => {
    fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect((screen.getByLabelText('Agent instructions') as HTMLTextAreaElement).value).toBe('기존 지시문');
  });

  // 저장은 폼 전체를 보낸다 — 바뀐 필드만 보내면 'harness 기본값으로 되돌리기'를 표현할 수 없다.
  it('saves the whole definition when an edit is submitted', async () => {
    const c = fakeController([agent('rusalka', { instructions: '기존 지시문' })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    fireEvent.change(screen.getByLabelText('Agent instructions'), { target: { value: '고친 지시문' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

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
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    fireEvent.click(screen.getByRole('button', { name: 'Use harness defaults' }));
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    expect(c.updateAgent.mock.calls[0]![1]).toMatchObject({ model: null, effort: null });
  });

  // mentionPermission 은 화면 앞에 사람이 없는 턴의 권한이다. 기본값은 auto — 설정을
  // 건드린 적 없는 에이전트도 도구를 쓸 수 있어야 한다.
  it('renders mention permission as auto by default and sends readonly when chosen', async () => {
    const c = fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect((screen.getByLabelText('Mention permission') as HTMLSelectElement).value).toBe('auto');

    fireEvent.change(screen.getByLabelText('Mention permission'), { target: { value: 'readonly' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    expect(c.updateAgent.mock.calls[0]![1]).toMatchObject({ mentionPermission: 'readonly' });
  });

  // fromView 매핑에서 빠지기 쉬운 지점 — 이미 readonly 로 저장된 에이전트를 다시 열었을 때
  // select 가 저장된 값을 보여줘야지 auto 로 되돌아가면 안 된다.
  it('shows readonly when reopening an agent already set to readonly', async () => {
    fakeController([agent('rusalka', { mentionPermission: 'readonly' })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

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
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      expect(await screen.findByText('PAT (Personal Access Token)')).toBeTruthy();
    });

    it('does not show PAT section when user is not admin', async () => {
      useAppStore.getState().set({ me: acc('u1', 'user', 'human', false) });
      fakeController([agent('rusalka')]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      expect(screen.queryByText('PAT (Personal Access Token)')).toBeNull();
    });

    it('lists PATs when editing an agent', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue(pats);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      expect(await screen.findByText('runner')).toBeTruthy();
      expect(await screen.findByText('backup')).toBeTruthy();
    });

    it('shows revoked PATs with indicator', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue(pats);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      expect(await screen.findByText('(폐기됨)')).toBeTruthy();
    });

    it('calls revokePat when confirming revoke', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka')]);
      (c.listPats as ReturnType<typeof vi.fn>).mockResolvedValue(pats);
      (c.revokePat as ReturnType<typeof vi.fn>).mockResolvedValue({ revoked: 1 });
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

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
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

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

      // Task 15-2: 소유자는 카드가 아니라 **상세**가 말한다 — 먼저 고른다.
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
      // 소유자는 **핸들**로 그린다 — id 가 새면 사람이 읽을 수 없는 값이 화면에 남는다.
      expect((await screen.findAllByText('alice')).length).toBeGreaterThan(0);
      expect(screen.queryByText('u2')).toBeNull();
    });

    it('shows "없음" when owner is null', async () => {
      fakeController([agent('rusalka', { ownerAccountId: null })]);
      render(<AgentsSettings />);

      // Task 15-2: 소유자는 카드가 아니라 **상세**가 말한다 — 먼저 고른다.
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
      expect(await screen.findByText('없음')).toBeTruthy();
    });

    // 소유자 id 는 있는데 디렉터리에 그 계정이 없으면 "모른다" 다. 빈 칸으로 그리면
    // "없다"와 구분되지 않는다 — 워커 초안이 그 경우에 아무것도 렌더하지 않았다.
    it('소유자 id 가 디렉터리에 없으면 빈 칸이 아니라 명시적으로 표시한다', async () => {
      fakeController([agent('rusalka', { ownerAccountId: 'ghost-account' })]);
      render(<AgentsSettings />);

      // Task 15-2: 소유자는 카드가 아니라 **상세**가 말한다 — 먼저 고른다.
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
      expect(await screen.findByText('알 수 없는 계정')).toBeTruthy();
      expect(screen.queryByText('없음')).toBeNull();
    });

    it('does not show owner control for non-admin', async () => {
      useAppStore.getState().set({ me: acc('u2', 'alice', 'human', false) });
      fakeController([agent('rusalka', { ownerAccountId: 'u2' })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      expect(screen.queryByLabelText('Owner')).toBeNull();
      expect(await screen.findByText(/소유자: @alice/)).toBeTruthy();
    });

    it('shows owner control for admin', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      fakeController([agent('rusalka', { ownerAccountId: 'u2' })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      expect(await screen.findByLabelText('Owner')).toBeTruthy();
    });

    it('sends ownerAccountId when admin selects an owner', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka', { ownerAccountId: null })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'u2' } });
      fireEvent.click(screen.getByRole('button', { name: '저장' }));

      await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
      expect(c.updateAgent.mock.calls[0]![1].ownerAccountId).toBe('u2');
    });

    it('sends ownerAccountId: null when admin clears the owner (not undefined)', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      const c = fakeController([agent('rusalka', { ownerAccountId: 'u2' })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

      fireEvent.change(screen.getByLabelText('Owner'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: '저장' }));

      await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
      expect(c.updateAgent.mock.calls[0]![1].ownerAccountId).toBeNull();
    });

    it('filters candidate list to exclude agent accounts', async () => {
      useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
      fakeController([agent('rusalka', { ownerAccountId: null })]);
      render(<AgentsSettings />);
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

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
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect(await screen.findByText('core')).toBeTruthy();
    expect(screen.getByText('재빈은 러너를 담당한다')).toBeTruthy();
  });

  // 빈 목록을 그대로 두면 "기억이 없다" 와 "못 읽었다" 가 구분되지 않는다.
  it('기억이 없으면 "없다" 가 보인다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockResolvedValue([]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect(await screen.findByText('기억이 없다')).toBeTruthy();
  });

  // 실패를 빈 배열로 삼키면 위 "없다" 와 같은 화면이 된다 — 이게 이 절의 핵심 구분이다.
  it('조회가 실패하면 오류가 보인다 — "없다" 가 아니다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockRejectedValue(new Error('boom'));
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('기억이 없다')).toBeNull();
  });

  it('삭제에 확인이 한 번 더 있고 확인해야 실제로 지운다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    const c = fakeController([agent('rusalka')]);
    c.agentMemory.mockResolvedValue([mem('mem/deploy', '배포는 redeploy.sh')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

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
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
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
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'fizz' } });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));

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
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    expect((await screen.findByRole('alert')).textContent).toContain('기본값을 불러오지 못했다');
    // 조용한 기본값이 아니다 — 초안 자체가 없으므로 harness 를 고르는 자리도 없다.
    expect(screen.queryByLabelText('Agent harness')).toBeNull();
    expect((screen.getByRole('button', { name: '에이전트 만들기' }) as HTMLButtonElement).disabled).toBe(true);
  });


  // 복사본이므로 만들어진 뒤에는 '물려받았다'가 더 이상 참이 아니다 — 표시하면 거짓말이 된다.
  it('실제 harness 만 보여준다 — 물려받았다는 표시를 두지 않는다', async () => {
    fakeController([agent('rusalka', { harness: 'claude-code' })]);
    render(<AgentsSettings />);

    /**
     * **Task 15-2 로 자리가 바뀌었다**: harness 는 카드가 아니라 상세가 말한다
     * (문서: "카드에 남는 것은 아바타와 이름 둘뿐"). 이 테스트가 지키는 것은 자리가 아니라
     * **'물려받았다' 표시를 두지 않는다**이다 — 기본값은 복사본이므로 만들어진 뒤에는
     * 더 이상 참이 아니고, 표시하면 거짓말이 된다.
     */
    const card = await screen.findByTestId('agent-card-rusalka');
    expect(card.textContent).not.toMatch(/기본값|inherit/i);

    fireEvent.click(card);
    const harness = await screen.findByLabelText('Agent harness');
    expect((harness as HTMLSelectElement).value).toBe('claude-code');
    expect(harness.closest('label')?.textContent).not.toMatch(/기본값|inherit/i);
  });
});

/**
 * 러너 실행·중지(#129, 어휘는 #493). 화면이 말할 수 있는 것은 **세 가지**뿐이다:
 * 중지 없음 / 중지했고 러너가 아직 못 봄 / 러너가 읽어 감.
 * 넷째("멈췄다")는 murmur 가 알 수 없는 사실이라 절대 쓰지 않는다 — 러너가 종료하면
 * 다음 GET /agent/config 자체가 오지 않으므로 서버는 프로세스의 생사를 관측하지 못한다.
 *
 * `#493` 이 버튼 자리를 하나로 접었어도 **이 세 상태는 그대로 그린다** — 접힌 것은 버튼이지
 * 상태가 아니다. 그래서 아래 단언들도 이름만 갈고 그대로 둔다.
 */
describe('러너 실행·중지 (#129, #493)', () => {
  /** 이 절만 떼어 본다 — 다른 절의 문구가 단언에 섞이지 않게 한다. */
  const stopPanel = async () => (await screen.findByText('러너 실행 · 중지')).parentElement!;

  beforeEach(() => {
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
  });

  it('중지 전에는 자동 기동 대상이라고만 말하고, 누르면 아직 읽어 가지 않았음을 보여준다', async () => {
    const c = fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect((await stopPanel()).textContent).toContain('중지를 걸어 둔 적이 없다');

    fireEvent.click(screen.getByRole('button', { name: '러너 중지' }));
    await waitFor(() => expect(c.requestAgentStop).toHaveBeenCalledWith('id-rusalka'));

    const panel = await stopPanel();
    await waitFor(() => expect(panel.textContent).toContain('아직 읽어 가지 않았다'));
    expect(panel.textContent).not.toContain('중지를 걸어 둔 적이 없다');
  });

  it('러너가 읽어 간 상태는 요청만 한 상태와 다르게 보인다', async () => {
    fakeController([agent('rusalka', {
      stopRequestedAt: '2026-09-03T10:00:00.000Z',
      stopAckedAt: '2026-09-03T10:00:20.000Z',
    })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    const panel = await stopPanel();
    expect(panel.textContent).toContain('러너가 요청을 읽어 갔다');
    expect(panel.textContent).not.toContain('아직 읽어 가지 않았다');
    expect(panel.textContent).not.toContain('중지를 걸어 둔 적이 없다');
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
      fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
      const text = (await stopPanel()).textContent ?? '';

      /**
       * 프로세스의 생사를 단정하는 문구를 막는다. **이 가드는 `#493` 뒤에도 그대로다** —
       * 버튼이 "중지"가 되어도 murmur 는 여전히 프로세스의 생사를 모른다(러너가 종료하면
       * 다음 GET /agent/config 자체가 오지 않는다).
       *
       * `재시작` 은 계속 막는다. `#493` 이 허용한 것은 **"실행"** 이지 "재시작"이 아니다 —
       * 실행은 "자동 기동 대상에 넣는다 → 다음 기동에서 뜬다"라는, 이 앱이 daemon 을 통해
       * 실제로 하는 일의 이름이다(#431 2단계·#482). "재시작"은 여전히 지금 이 자리에서
       * 프로세스를 다시 세운다는 약속이고, 그건 `startAll` 이 앱 기동 시 한 번만 도는 지금
       * 참이 아니다. `중지됨`·`종료됨` 같은 **완료형**도 그대로 막는다 — 진행형("중지")은
       * 사람의 의도이지만 완료형은 관측 못 한 사실의 단정이다.
       */
      expect(text).not.toMatch(/멈췄|멈춤|중지됨|종료됨|정지됨|재시작/);
      /**
       * #427 → #493: 반드시 있어야 하는 **사실**이 두 번 바뀌었다. 그 이력을 여기 남긴다.
       *
       * 첫 판본(#129)은 `'다시 띄우는 것은 사람'` 을 요구했다. 그때는 참이었다 — 앱이 러너를
       * 다시 띄우는 길이 없었다. `#431` 2단계에서 **앱이 daemon 을 통해 그 감독이 됐고**,
       * `#427` 이 그 자리를 `'되돌리'` 로 갈았다.
       *
       * `#493` 은 한 걸음 더 간다. `'되돌리'` 는 **서버 API 의 어휘**(stop ↔ stop/undo)라,
       * 그것만 요구하면 화면이 "내가 보낸 요청을 취소한다"고 말해도 초록이 된다. 사람이
       * 알아야 하는 사실은 그게 아니라 **"이 에이전트를 다시 켤 수 있다"** 이다. 그래서
       * 세 상태 어디서 봐도 `실행` 이라는 조작이 있다는 것이 보여야 한다.
       *
       * 그리고 **버튼 이름이 짧아지며 잃을 뻔한 사실**을 함께 못박는다: 중지는 즉시 끊는 것이
       * 아니라 **진행 중인 턴을 마친 뒤** 스스로 물러나는 것이다. 버튼만 보면 "중지 = 지금
       * 끊긴다"로 읽히므로 이 뉘앙스는 반드시 글로 남아 있어야 한다 — 사라지면 사람이
       * 턴 중간에 답을 잃는다고 오해하고 누르기를 주저한다.
       *
       * 단언을 지우지 않고 바꾸는 이유(세 번 다 같다): 지우면 이 자리가 아무 사실도 요구하지
       * 않게 되어, 문구가 통째로 사라져도 초록이 된다.
       */
      expect(text).toContain('실행');
      expect(text).toContain('진행 중인 턴을 마친 뒤');
      cleanup();
    }
  });

  it('러너가 읽어 갔다는 표시가 종료를 뜻하지 않음을 화면이 직접 말한다', async () => {
    fakeController([agent('rusalka', {
      stopRequestedAt: '2026-09-03T10:00:00.000Z',
      stopAckedAt: '2026-09-03T10:00:20.000Z',
    })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect((await stopPanel()).textContent).toContain('실제로 종료했는지는 harkroom 가 알 수 없다');
  });
});

/**
 * Task 15-3(identity 문서) — 상세는 세 묶음, 저장은 한 쌍.
 *
 * 전에는 아홉 필드가 한 줄로 흘러 무엇이 무엇과 묶이는지 알 수 없었고, 저장 버튼이 카드 안
 * 회색 하나와 화면 아래 파란 하나로 갈려 있었다.
 */
describe('상세는 세 묶음, 저장은 한 쌍 (Task 15-3)', () => {
  it('프로필 · 실행 · 권한 세 묶음으로 선다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    for (const title of ['프로필', '실행', '권한']) {
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    }
  });

  it('고치기 전에는 되돌리기가 없다 — 누를 것이 없는 버튼을 그리지 않는다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    await screen.findByRole('button', { name: '저장' });
    expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
  });

  it('고치면 되돌리기가 서고, 누르면 서버 값으로 돌아간다', async () => {
    fakeController([agent('rusalka', { workingDir: '/repo' })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    const dir = await screen.findByLabelText('Working directory');
    fireEvent.change(dir, { target: { value: '/other' } });
    expect((dir as HTMLInputElement).value).toBe('/other');

    fireEvent.click(await screen.findByRole('button', { name: '되돌리기' }));
    expect((screen.getByLabelText('Working directory') as HTMLInputElement).value).toBe('/repo');
    // 되돌린 뒤에는 다시 사라진다 — 고친 것이 없으므로.
    expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
  });

  it('새 에이전트 화면에는 되돌리기가 없다 — 돌아갈 서버 값이 없다', async () => {
    fakeController([]);
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));
    await screen.findByRole('button', { name: '에이전트 만들기' });
    expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
  });
});

/**
 * Task 15-4(identity 문서) — 에이전트 사진.
 *
 * **에이전트는 자기 사진을 올릴 손이 없다** — 소유자가 대신 올려 주지 않으면 영원히 색
 * 하나로 남는다. 문서가 이 화면의 성패를 여기에 걸었다.
 */
describe('에이전트 사진 (Task 15-4)', () => {
  it('고른 에이전트에만 사진 자리가 있다 — 새 에이전트는 걸 대상이 없다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);

    // 처음 화면은 '새 에이전트'다 — 아직 계정이 없다.
    expect(screen.queryByTestId('agent-avatar-file')).toBeNull();

    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    expect(await screen.findByTestId('agent-avatar-file')).toBeTruthy();
  });

  it('파일을 고르면 그 에이전트에 건다', async () => {
    const c = fakeController([agent('rusalka')]);
    (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar =
      vi.fn(async () => undefined);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    const file = new File([new Uint8Array([1, 2, 3])], 'bot.png', { type: 'image/png' });
    fireEvent.change(await screen.findByTestId('agent-avatar-file'), { target: { files: [file] } });

    await waitFor(() => expect(
      (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar,
    ).toHaveBeenCalledWith('id-rusalka', file, expect.any(Function)));
  });

  it('사진이 없으면 지우기가 없다 — 지울 것이 없는 버튼을 그리지 않는다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    await screen.findByTestId('agent-avatar-file');
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull();
  });

  it('사진이 있으면 지울 수 있다 — 확인을 거친다', async () => {
    const c = fakeController([agent('rusalka', { avatarAttachmentId: 'att-1' })]);
    (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar =
      vi.fn(async () => undefined);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    fireEvent.click(await screen.findByRole('button', { name: '지우기' }));
    // 첫 클릭은 묻기만 한다 — 되돌릴 수 없는 조작이 스친 클릭 하나로 일어나지 않는다.
    expect(
      (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar,
    ).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: '정말 지우기' }));
    await waitFor(() => expect(
      (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar,
    ).toHaveBeenCalledWith('id-rusalka', null, undefined));
    // 지운 것을 말한다. 아무 말이 없으면 눌린 것인지조차 알 수 없다 — 그것이 원래 문제였다.
    expect((await screen.findByTestId('avatar-done')).textContent).toBe(ko('avatarEdit.result.removed'));
  });

  /** 확인을 취소하면 아무 일도 없어야 하고, 확인 버튼도 남아 있지 않아야 한다. */
  it('지우기를 취소하면 사진이 그대로다', async () => {
    const c = fakeController([agent('rusalka', { avatarAttachmentId: 'att-1' })]);
    (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar =
      vi.fn(async () => undefined);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    fireEvent.click(await screen.findByRole('button', { name: '지우기' }));
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));

    expect(screen.queryByRole('button', { name: '정말 지우기' })).toBeNull();
    expect(
      (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar,
    ).not.toHaveBeenCalled();
  });

  it('거절되면 조용히 실패하지 않는다 — 무엇을 고를 수 있는지까지 말한다', async () => {
    const c = fakeController([agent('rusalka')]);
    (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar =
      vi.fn(async () => { throw new ApiError(400, 'not_an_image', 'nope'); });
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    const file = new File([new Uint8Array([1])], 'evil.png', { type: 'image/png' });
    fireEvent.change(await screen.findByTestId('agent-avatar-file'), { target: { files: [file] } });

    // 목록을 함께 낸다 — "안 된다"만 말하면 사람은 다음에 무엇을 고를지 모른다.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('PNG');
    expect(alert.textContent).toContain('SVG');
  });

  it('SVG 도 고를 수 있다 — 화면이 서버보다 좁으면 오류조차 못 낸다', async () => {
    const c = fakeController([agent('rusalka')]);
    (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar =
      vi.fn(async () => undefined);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    const input = await screen.findByTestId('agent-avatar-file');
    expect(input.getAttribute('accept')).toContain('image/svg+xml');

    const file = new File(['<svg/>'], 'face.svg', { type: 'image/svg+xml' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(
      (c as unknown as { setAgentAvatar: ReturnType<typeof vi.fn> }).setAgentAvatar,
    ).toHaveBeenCalledWith('id-rusalka', file, expect.any(Function)));
  });
});

/**
 * **한 번에 한 화면이다**(identity 문서). 문서의 목업이 그리드에는 곁창을 그리지 않았고,
 * 상세에는 `← 에이전트` 로 돌아가는 길을 그렸다 — 나란히 두면 상세의 폭이 좁아져 문서가
 * 세운 세 묶음이 다시 한 줄로 흐른다.
 */
describe('그리드와 상세는 한 번에 하나만 (Task 15)', () => {
  it('처음에는 그리드만 보인다 — 곁창이 없다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);

    expect(await screen.findByTestId('agent-grid')).toBeTruthy();
    // 아무도 안 골랐으므로 상세가 없다.
    expect(screen.queryByLabelText('Agent instructions')).toBeNull();
    expect(screen.queryByTestId('agent-back')).toBeNull();
  });

  it('카드를 누르면 상세로 가고 그리드는 덮인다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect(await screen.findByLabelText('Agent instructions')).toBeTruthy();
    expect(screen.queryByTestId('agent-grid')).toBeNull();
  });

  it('← 에이전트 로 돌아온다 — 없으면 나올 방법이 없다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    fireEvent.click(await screen.findByTestId('agent-back'));
    expect(await screen.findByTestId('agent-grid')).toBeTruthy();
    expect(screen.queryByLabelText('Agent instructions')).toBeNull();
  });

  it('+ 도 상세(새 에이전트)로 간다', async () => {
    fakeController([]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-create'));

    expect(await screen.findByRole('button', { name: '에이전트 만들기' })).toBeTruthy();
    expect(screen.queryByTestId('agent-grid')).toBeNull();
  });
});

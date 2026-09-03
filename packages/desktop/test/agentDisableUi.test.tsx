import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { Composer } from '../src/components/Composer';
import { Directory } from '../src/components/Directory';
import type { ApiClient } from '../src/lib/api';
import { acc, fakeApi } from './helpers/fakeApi';

/**
 * #251 비활성화·재활성화 UI. 요청 본문과 타입 경계는 `agentDisabled.test.ts` 와
 * `agentDisabled.typeCheck.ts` 가 지키고, 이 파일은 **화면**을 지킨다: 누가 컨트롤을
 * 보는가, 확인 단계 전에 요청이 나가는가, 끈 결과가 스토어를 거쳐 다른 화면에 닿는가.
 */

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

const fakeController = (agents: AgentView[], pats: PatView[] = []) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    listPats: vi.fn(async (): Promise<PatView[]> => pats),
    revokePat: vi.fn(async (): Promise<{ revoked: number }> => ({ revoked: 1 })),
    mintPat: vi.fn(async (): Promise<string> => 'murp_new'),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    // 스토어 갱신은 **컨트롤러의 책임**이다(controller.ts::setAgentDisabled). 여기서는
    // 그 책임을 흉내 내지 않고, 배선을 보는 테스트만 진짜 컨트롤러를 쓴다.
    setAgentDisabled: vi.fn(async (id: string, disabled: boolean): Promise<AgentView> => (
      agent('rusalka', { id, disabled })
    )),
    refreshAccounts: vi.fn(async (): Promise<void> => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
});
afterEach(() => cleanup());

describe('#251 비활성화 컨트롤은 admin 에게만 보인다', () => {
  // 회귀선 3. `disabled` 는 `requireAdmin` 이라(#253) 소유자에게도 열지 않는다.
  // **비활성 버튼이 아니라 부재**여야 한다 — 눌러도 403 인 버튼은 거짓 신호다
  // (docs/design.md 4절). 그래서 `toBeDisabled` 가 아니라 `queryBy…` 가 null 임을 본다.
  it('admin 이 아니면 컨트롤이 아예 렌더되지 않는다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'someone', 'human', false) });
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByText('rusalka'));

    expect(screen.queryByRole('button', { name: '에이전트 비활성화' })).toBeNull();
    expect(screen.queryByRole('button', { name: '에이전트 활성화' })).toBeNull();
    expect(screen.queryByRole('button', { name: '정말 비활성화' })).toBeNull();
  });

  it('admin 이면 컨트롤이 보인다', async () => {
    fakeController([agent('rusalka')]);
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByText('rusalka'));

    expect(screen.getByRole('button', { name: '에이전트 비활성화' })).toBeTruthy();
  });
});

describe('#251 끄기는 확인 단계를 거친다', () => {
  // 회귀선 4. 확인 문구는 **두 사실**을 다 말해야 한다: PAT 가 전부 폐기된다,
  // 다시 켜도 돌아오지 않아 새로 발급해야 한다. 하나만 있으면 운영자는 되돌릴 수 있다고
  // 믿고 끈다. 그리고 확인 **전에는 요청이 나가지 않는다** — 나가면 확인 단계가 장식이다.
  it('첫 클릭은 요청을 보내지 않고 확인 문구를 띄운다', async () => {
    const c = fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.click(screen.getByRole('button', { name: '에이전트 비활성화' }));

    expect(c.setAgentDisabled).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: '정말 비활성화' });
    const box = confirm.closest('div')!.parentElement!;
    // 두 사실이 확인 단계의 문구 안에 있어야 한다.
    expect(box.textContent).toContain('PAT');
    expect(box.textContent).toContain('폐기');
    expect(box.textContent).toContain('새로 발급');
  });

  it('확인을 누르면 그때 비활성화 요청이 나간다', async () => {
    const c = fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.click(screen.getByRole('button', { name: '에이전트 비활성화' }));
    fireEvent.click(screen.getByRole('button', { name: '정말 비활성화' }));

    await waitFor(() => expect(c.setAgentDisabled).toHaveBeenCalledWith('id-rusalka', true));
  });

  it('취소하면 요청이 나가지 않고 확인 단계가 닫힌다', async () => {
    const c = fakeController([agent('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.click(screen.getByRole('button', { name: '에이전트 비활성화' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(c.setAgentDisabled).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '정말 비활성화' })).toBeNull();
    expect(screen.getByRole('button', { name: '에이전트 비활성화' })).toBeTruthy();
  });

  // 켜기는 되돌릴 수 있는 방향이라 확인 단계가 없다. 그것이 결정이라는 것을 적어 둔다 —
  // 없는 것을 실수로 보고 붙이는 사람이 없게.
  it('다시 켜기는 확인 없이 바로 요청한다', async () => {
    const c = fakeController([agent('rusalka', { disabled: true })]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    fireEvent.click(screen.getByRole('button', { name: '에이전트 활성화' }));

    await waitFor(() => expect(c.setAgentDisabled).toHaveBeenCalledWith('id-rusalka', false));
  });
});

describe('#251 다시 켠 직후 PAT 가 0개임이 드러난다', () => {
  // 회귀선 6. 비활성화는 PAT 를 전부 폐기하고 다시 켜도 되살리지 않는다(서버가 해시만
  // 보관한다). 그래서 켠 직후 화면은 "지금 이 에이전트로는 러너가 뜰 수 없다"를 말해야
  // 한다 — 안 말하면 운영자는 켰으니 돌아갈 것이라 믿고 기다린다.
  it('켠 뒤 PAT 목록이 비어 있으면 재발급이 필요하다고 안내한다', async () => {
    const c = fakeController([agent('rusalka', { disabled: true })], []);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    // 꺼진 동안에는 0개가 정상이라 권하지 않는다.
    await waitFor(() => expect(screen.getByText('PAT 가 없다')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '에이전트 활성화' }));
    await waitFor(() => expect(c.setAgentDisabled).toHaveBeenCalled());

    const notice = await screen.findByText(/새로 발급해야 한다/);
    expect(notice.textContent).toContain('PAT 가 없다');
  });

  // 실패를 0개로 그리면 살아 있는 PAT 를 없다고 하고, 그 위에서 필요 없는 재발급까지
  // 권한다 — '없다' 와 '못 읽었다' 가 한 화면이 되는 그 결함이다(docs/design.md 4절).
  it('PAT 조회 실패는 "없다"가 아니라 오류로 보인다', async () => {
    const c = fakeController([agent('rusalka')]);
    c.listPats.mockImplementation(async () => { throw new Error('끊겼다'); });
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect((await screen.findByRole('alert')).textContent).toContain('PAT 목록을 읽지 못했다');
    expect(screen.queryByText(/새로 발급해야 한다/)).toBeNull();
    expect(screen.queryByText('PAT 가 없다')).toBeNull();
  });
});

describe('#251 끈 결과가 스토어를 거쳐 다른 화면에 닿는다', () => {
  /**
   * 회귀선 5. 이것이 이 기능의 **배선** 테스트다. 설정 화면의 지역 상태(`selected`,
   * `agents`)만 고치면 이 파일의 다른 테스트는 전부 초록인데도, 끈 직후 그 에이전트가
   * 여전히 멘션 자동완성에 뜨고 디렉터리에 `비활성` 배지가 없다 — 부른 사람은 답이 올
   * 것이라 믿는다. 그 사실을 읽는 곳은 스토어의 `accounts` 다.
   *
   * 그래서 여기서는 컨트롤러를 흉내 내지 않고 **진짜 `Controller`** 를 쓰고, 설정 화면과
   * 소비자 화면(`Composer`·`Directory`)을 한 트리에 함께 띄운다.
   */
  it('설정에서 끄면 멘션 후보에서 빠지고 디렉터리에 비활성 배지가 붙는다', async () => {
    const rusalka = agent('rusalka');
    const admin = acc('u1', 'admin', 'human', true);
    useAppStore.getState().set({
      me: admin,
      accounts: { u1: admin, 'id-rusalka': rusalka },
    });
    // 흉내 낸 컨트롤러가 아니라 **진짜 Controller** 를 쓴다 — 스토어를 갱신하는 한 줄이
    // 컨트롤러에 있는지가 이 테스트의 대상이므로, 그 자리를 가짜로 덮으면 무엇도 지키지
    // 못한다. 화면이 필요한 나머지 표면은 fakeApi 로 채운다.
    const setAgentDisabled = vi.fn(
      async (id: string, disabled: boolean) => agent('rusalka', { id, disabled }),
    );
    const real = new Controller(fakeApi({
      // `Directory` 는 뜰 때 `refreshAccounts({ force: true })` 로 계정 표를 서버에서
      // 다시 받는다 — fakeApi 의 기본 목록을 그대로 두면 그 응답이 위에서 심은 스토어를
      // 덮어써 rusalka 가 사라진다. 서버가 아는 것과 스토어가 아는 것을 같게 맞춘다.
      accounts: vi.fn(async () => [admin, rusalka]),
      listAgents: vi.fn(async () => [rusalka]),
      listPats: vi.fn(async () => []),
      setAgentDisabled,
    } as unknown as Partial<ApiClient>));
    setController(real);

    render(
      <>
        <div data-testid="settings-host"><AgentsSettings /></div>
        <div data-testid="composer-host"><Composer onSend={vi.fn()} /></div>
        <Directory open onClose={vi.fn()} />
      </>,
    );

    // 세 화면을 한 트리에 띄우면 같은 이름이 여러 곳에 뜬다 — 각 화면의 자리로 좁혀 집는다.
    const settings = within(screen.getByTestId('settings-host'));
    const composer = within(screen.getByTestId('composer-host'));
    const box = composer.getByRole('textbox');

    // 끄기 전: 후보에 있고 배지가 없다.
    fireEvent.change(box, { target: { value: '@rus', selectionStart: 4 } });
    expect(composer.queryAllByRole('option').map((o) => o.getAttribute('data-handle')))
      .toContain('rusalka');
    expect(screen.queryByTestId('directory-disabled-id-rusalka')).toBeNull();

    fireEvent.change(box, { target: { value: '', selectionStart: 0 } });
    fireEvent.click(await settings.findByText('rusalka'));
    fireEvent.click(settings.getByRole('button', { name: '에이전트 비활성화' }));
    fireEvent.click(settings.getByRole('button', { name: '정말 비활성화' }));

    await waitFor(() => expect(setAgentDisabled).toHaveBeenCalledWith('id-rusalka', true));
    await waitFor(() =>
      expect(useAppStore.getState().accounts['id-rusalka']!.disabled).toBe(true));

    // 끈 뒤: 후보에서 빠지고 배지가 붙는다. 디렉터리에서 **사라지지는 않는다** —
    // 같은 표가 과거 메시지의 작성자 이름을 푼다(shared 의 AccountView.disabled 주석).
    fireEvent.change(box, { target: { value: '@rus', selectionStart: 4 } });
    expect(composer.queryAllByRole('option').map((o) => o.getAttribute('data-handle')))
      .not.toContain('rusalka');
    expect(await screen.findByTestId('directory-disabled-id-rusalka')).toBeTruthy();
    expect(screen.getByTestId('directory-row-id-rusalka')).toBeTruthy();
  });
});

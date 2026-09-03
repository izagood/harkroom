import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgentTeamMemberRow, AgentTeamRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { TeamsSettings } from '../src/components/settings/TeamsSettings';
import { Sidebar } from '../src/components/Sidebar';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { acc, chan, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/**
 * 에이전트 팀(#172)의 데스크탑 회귀선.
 *
 * 이 화면들이 지켜야 하는 것은 "팀을 그리는 것"만이 아니다. **서버가 정한 것보다 넓은
 * 것도 좁은 것도 내주지 않는 것**이 같은 무게다(docs/design.md §4):
 *
 * - 팀 관리는 admin 이다 → 비-admin 에게 만들기·빼기를 내주면 눌렀을 때 403 이 나고,
 *   그건 "할 수 있다"는 거짓 신호다.
 * - 채널에 팀을 넣는 것은 **admin 이 아니라 그 채널의 멤버**다(`#156` 의 초대와 같은
 *   게이트). 화면만 admin 으로 좁히면 할 수 있는 조작이 사라진다 — 그것도 거짓이다.
 * - public 채널에는 멤버십이 없다(`#156`) → 진입점 자체를 만들지 않는다.
 * - 비활성 팀원은 팀에 **남고** 채널에 넣을 때 걸러진다 → 화면이 그 둘을 다 말해야 한다.
 */

const team = (id: string, name: string): AgentTeamRow =>
  ({ id, name, createdBy: 'u1', createdAt: '2024-01-01T00:00:00.000Z' });

const member = (accountId: string, handle: string, disabled = false): AgentTeamMemberRow =>
  ({ accountId, handle, disabled });

const seed = (isAdmin: boolean) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', isAdmin),
    accounts: {
      u1: acc('u1', 'me', 'human', isAdmin),
      a1: acc('a1', 'bot', 'agent'),
      a2: acc('a2', 'helper', 'agent'),
      u2: acc('u2', 'alice', 'human'),
    },
    channels: [chan('c1', 'general'), chan('c2', 'secret', null, 'private')],
    dms: [], connected: true,
  });
};

afterEach(() => { cleanup(); setController(null as unknown as Controller); });

type Api = ReturnType<typeof fakeApi> & Record<string, ReturnType<typeof vi.fn>>;

function mountSettings(overrides: Partial<Parameters<typeof fakeApi>[0]> = {}): Api {
  const api = fakeApi({
    teams: vi.fn(async () => [team('t1', 'ops')]),
    team: vi.fn(async () => ({ team: team('t1', 'ops'), members: [member('a1', 'bot')] })),
    ...overrides,
  });
  setController(new Controller(api, fakeWsFactory().makeWs));
  render(<TeamsSettings />);
  return api as Api;
}

const openTeam = async (name = 'ops') => {
  await waitFor(() => expect(screen.getByTestId(`team-row-${name}`)).toBeTruthy());
  fireEvent.click(screen.getByTestId(`team-row-${name}`));
  await waitFor(() => expect(screen.getByRole('heading', { name: `Edit ${name}` })).toBeTruthy());
};

describe('팀 설정 화면 (#172)', () => {
  beforeEach(() => seed(true));

  it('1. 목록이 서버에서 오고, 만들기가 생성 라우트를 부른 뒤 목록을 다시 읽는다', async () => {
    const api = mountSettings({
      createTeam: vi.fn(async () => team('t2', 'release')),
      teams: vi.fn()
        .mockResolvedValueOnce([team('t1', 'ops')])
        .mockResolvedValue([team('t1', 'ops'), team('t2', 'release')]),
    });

    await waitFor(() => expect(screen.getByTestId('team-row-ops')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('팀 이름'), { target: { value: 'release' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() => expect(api.createTeam).toHaveBeenCalledWith('release'));
    // 만든 뒤 목록을 **다시 읽는다** — 지역 상태에만 밀어 넣으면 다른 화면과 갈라진다.
    await waitFor(() => expect(screen.getByTestId('team-row-release')).toBeTruthy());
  });

  it('2. 팀원 추가·빼기가 라우트를 부르고 응답이 준 명단을 그린다', async () => {
    const api = mountSettings({
      addTeamMember: vi.fn(async () => ({ members: [member('a1', 'bot'), member('a2', 'helper')] })),
      removeTeamMember: vi.fn(async () => ({ members: [member('a2', 'helper')] })),
    });
    await openTeam();

    fireEvent.change(screen.getByLabelText('팀원 추가'), { target: { value: 'a2' } });
    await waitFor(() => expect(api.addTeamMember).toHaveBeenCalledWith('t1', 'a2'));
    // 명단은 **응답이 준 것**이다 — 낙관적으로 손으로 더하면 서버가 거절해도 화면에 남는다.
    await waitFor(() => expect(screen.getByText('@helper')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('팀원 빼기: bot'));
    await waitFor(() => expect(api.removeTeamMember).toHaveBeenCalledWith('t1', 'a1'));
    // 명단에서만 사라진다 — 후보 select 에는 다시 나타나는 것이 맞다. 화면 전체로
    // 찾으면 그 option 을 명단으로 잘못 읽는다.
    await waitFor(() => expect(screen.queryByLabelText('팀원 빼기: bot')).toBeNull());
  });

  it('3. 사람 계정은 팀원 후보에 없다 — 서버가 400 으로 거절하는 조작이다', async () => {
    mountSettings();
    await openTeam();

    const select = screen.getByLabelText('팀원 추가');
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('a2');
    expect(values).not.toContain('u2');
  });

  it('4. 비활성 팀원은 팀에 남고 그렇게 표시된다', async () => {
    mountSettings({
      team: vi.fn(async () => ({ team: team('t1', 'ops'), members: [member('a1', 'bot', true)] })),
    });
    await openTeam();

    const row = screen.getByText('@bot').closest('div')!;
    expect(within(row).getByText('(비활성)')).toBeTruthy();
  });

  /**
   * 삭제는 되돌릴 수 없다. 초판은 한 번 누름으로 지웠다 — 이 저장소는 그 수단을
   * 거절했고(`window.confirm` 도, 한 번 누름도), 선례는 인라인 확인이다.
   */
  it('5. 삭제는 한 번 더 물은 뒤에만 라우트를 부른다', async () => {
    const api = mountSettings({ deleteTeam: vi.fn(async () => undefined) });
    await openTeam();

    fireEvent.click(screen.getByRole('button', { name: 'Delete team' }));
    expect(api.deleteTeam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '정말 삭제' }));
    await waitFor(() => expect(api.deleteTeam).toHaveBeenCalledWith('t1'));
  });

  it('5b. 확인을 취소하면 지우지 않는다', async () => {
    const api = mountSettings({ deleteTeam: vi.fn(async () => undefined) });
    await openTeam();

    fireEvent.click(screen.getByRole('button', { name: 'Delete team' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete team' }));
    expect(api.deleteTeam).not.toHaveBeenCalled();
  });

  it('6. 이름 변경이 라우트를 부르고, 문법에 맞지 않으면 왕복 없이 막는다', async () => {
    const api = mountSettings({ updateTeam: vi.fn(async () => team('t1', 'ops2')) });
    await openTeam();

    fireEvent.change(screen.getByLabelText('팀 이름 수정'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(api.updateTeam).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('2~32');

    fireEvent.change(screen.getByLabelText('팀 이름 수정'), { target: { value: 'ops2' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.updateTeam).toHaveBeenCalledWith('t1', 'ops2'));
  });

  it('7. 서버가 거절한 이유를 그대로 보여 준다 — 조용히 성공으로 보이지 않는다', async () => {
    mountSettings({
      createTeam: vi.fn(async () => { throw new Error('name_taken'); }),
    });
    fireEvent.change(screen.getByLabelText('팀 이름'), { target: { value: 'agent1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('name_taken'));
  });
});

describe('팀 설정 화면 — 비-admin (#172)', () => {
  beforeEach(() => seed(false));

  it('8. 비-admin 에게는 만들기·빼기·삭제가 없다', async () => {
    mountSettings();
    expect((screen.getByLabelText('팀 이름') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Create team' }) as HTMLButtonElement).disabled).toBe(true);

    await openTeam();
    expect(screen.queryByLabelText('팀원 빼기: bot')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete team' })).toBeNull();
    expect(screen.queryByLabelText('팀원 추가')).toBeNull();
  });
});

describe('설정 목차에 팀 절이 있다 (#172)', () => {
  beforeEach(() => seed(true));

  it('9. 목차에서 Teams 를 고르면 팀 화면이 그려진다', async () => {
    const api = fakeApi({ teams: vi.fn(async () => [team('t1', 'ops')]) });
    setController(new Controller(api, fakeWsFactory().makeWs));
    render(<SettingsScreen onBack={vi.fn()} onSignOut={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Teams' }));

    // 목차에 한 줄만 있고 렌더 분기를 잊으면 이 화면이 빈 칸이 된다.
    await waitFor(() => expect(screen.getByTestId('team-row-ops')).toBeTruthy());
  });
});

/**
 * 멤버 패널의 "팀 추가"(#172). 여기서 확인하는 것은 결과 세 갈래를 사람에게 **보이는가**다.
 * 초판은 결과를 상태에만 담고 멤버 목록을 새로 읽지 않아, 방금 들어온 에이전트가
 * 바로 아래 목록에서 빠져 있었다.
 */
describe('멤버 패널 팀 추가 (#172)', () => {
  const controllerFor = (overrides: Partial<Parameters<typeof fakeApi>[0]> = {}) => {
    const api = fakeApi({
      teams: vi.fn(async () => [team('t1', 'ops')]),
      channelMembers: vi.fn(async () => [{ accountId: 'u1', handle: 'me' }]),
      ...overrides,
    });
    setController(new Controller(api, fakeWsFactory().makeWs));
    return api as Api;
  };

  const sidebar = () => render(
    <Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} onOpenDirectory={vi.fn()}
      onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()} onOpenSaved={vi.fn()}
      collapsed={false} onToggleCollapse={vi.fn()} />,
  );

  const openMembers = async (name: RegExp, channelId: string): Promise<HTMLElement> => {
    const row = screen.getByRole('button', { name }).closest('div')!;
    fireEvent.click(within(row).getByRole('button', { name: '⋯' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '멤버 보기' }));
    return await screen.findByTestId(`members-${channelId}`);
  };

  beforeEach(() => seed(true));

  it('10. private 채널에서 팀을 넣으면 결과 세 갈래가 보이고 멤버 목록을 다시 읽는다', async () => {
    const api = controllerFor({
      addTeamToChannel: vi.fn(async () => ({
        added: ['bot'], skipped: ['helper'], alreadyMember: ['me'],
      })),
      channelMembers: vi.fn()
        .mockResolvedValueOnce([{ accountId: 'u1', handle: 'me' }])
        .mockResolvedValue([{ accountId: 'u1', handle: 'me' }, { accountId: 'a1', handle: 'bot' }]),
    });
    sidebar();

    const panel = await openMembers(/비공개 채널 secret\b/, 'c2');
    await waitFor(() => expect(within(panel).getByLabelText('추가할 팀')).toBeTruthy());

    fireEvent.change(within(panel).getByLabelText('추가할 팀'), { target: { value: 't1' } });
    fireEvent.click(within(panel).getByRole('button', { name: '추가' }));

    await waitFor(() => expect(api.addTeamToChannel).toHaveBeenCalledWith('c2', 't1'));

    // 세 갈래를 **다** 말한다. 하나라도 삼키면 "넣었는데 왜 없지"를 설명할 수 없다.
    await waitFor(() => expect(within(panel).getByText(/추가: bot/)).toBeTruthy());
    expect(within(panel).getByText(/건너뜀: helper/)).toBeTruthy();
    expect(within(panel).getByText(/이미 있음: me/)).toBeTruthy();

    // 그리고 **멤버 목록**이 실제로 갱신된다 — 결과 문구만 바꾸면 바로 아래 목록이
    // 방금 들어온 에이전트를 빼고 그린다. `li` 로 좁히는 것이 중요하다: 같은 패널의
    // '초대할 계정' select 에도 `@bot` 이 option 으로 있어서, 패널 전체에서 찾으면
    // 목록에 없는 것을 있다고 읽는다.
    await waitFor(() => expect(
      within(panel).getAllByRole('listitem').map((li) => li.textContent ?? ''),
    ).toEqual(expect.arrayContaining([expect.stringContaining('@bot')])));
  });

  /**
   * public 채널에는 자리가 없다. 막는 곳이 **둘**이다: 팀 목록을 애초에 받지 않고
   * (`openMembers`), 받았더라도 그리지 않는다(`ch.visibility === 'private'`).
   * 실제로 깨질 수 있는 것은 앞의 것이라 그것을 단언한다 — 뒤의 조건 하나만 지워도
   * 목록이 비어 있어 자리는 여전히 안 뜨므로, 그 조건만 겨냥한 회귀선은 화면을 통해
   * 만들 수 없다(그래서 두 겹을 다 남긴다).
   */
  it('11. public 채널에서는 팀 목록을 받지도 않고 자리도 없다', async () => {
    const api = controllerFor();
    sidebar();

    const panel = await openMembers(/# general\b/, 'c1');
    expect(within(panel).queryByLabelText('추가할 팀')).toBeNull();
    // 뜻이 없는 조작을 위해 왕복을 걸지 않는다 — 서버는 이 채널에 400 으로 답한다.
    expect(api.teams).not.toHaveBeenCalled();
  });

  it('11b. private 채널에서는 팀 목록을 받는다', async () => {
    const api = controllerFor();
    sidebar();

    await openMembers(/비공개 채널 secret\b/, 'c2');
    await waitFor(() => expect(api.teams).toHaveBeenCalled());
  });

  it('12. 팀 목록을 못 받으면 그 사실만 말한다 — 멤버 목록 실패로 바꿔 말하지 않는다', async () => {
    controllerFor({ teams: vi.fn(async () => { throw new Error('boom'); }) });
    sidebar();

    const panel = await openMembers(/비공개 채널 secret\b/, 'c2');
    // 멤버 목록은 받았으므로 그려져 있다.
    await waitFor(() => expect(within(panel).getByText('@me')).toBeTruthy());
    await waitFor(() => expect(within(panel).getByRole('alert').textContent).toContain('팀 목록'));
  });

  it('13. 팀 추가가 실패하면 그 사실을 말하고 목록은 건드리지 않는다', async () => {
    const api = controllerFor({
      addTeamToChannel: vi.fn(async () => { throw new Error('channel_is_public'); }),
    });
    sidebar();

    const panel = await openMembers(/비공개 채널 secret\b/, 'c2');
    await waitFor(() => expect(within(panel).getByLabelText('추가할 팀')).toBeTruthy());
    fireEvent.change(within(panel).getByLabelText('추가할 팀'), { target: { value: 't1' } });
    fireEvent.click(within(panel).getByRole('button', { name: '추가' }));

    await waitFor(() => expect(api.addTeamToChannel).toHaveBeenCalled());
    await waitFor(() => expect(within(panel).getByRole('alert').textContent).toContain('channel_is_public'));
    // "추가: …" 문구가 뜨면 실패를 성공으로 그린 것이다.
    expect(within(panel).queryByText(/추가: /)).toBeNull();
  });
});

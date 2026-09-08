import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgentTeamMemberRow, AgentTeamRow, AgentView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { Sidebar } from '../src/components/Sidebar';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { SETTINGS_GROUPS, isSectionId } from '../src/components/settings/sections';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, accountsResult, chan, fakeApi, fakeWsFactory } from './helpers/fakeApi';

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
 *
 * ## 화면이 옮겨 갔다 (`docs/desktop-agent-cards.html` 4단계)
 *
 * 앞 판은 `TeamsSettings`(설정 › Teams, 왼쪽 목록 + 오른쪽 상세)를 세웠다. 4단계가 그
 * 화면을 없애고 팀을 **설정 › 에이전트 안의 묶음**으로 옮겼으므로, 이 파일이 세우는
 * 화면도 `AgentsSettings` 다. 위 네 규율은 **한 글자도 안 바뀐다** — 옮긴 것은 자리이고,
 * 서버가 정한 경계는 그대로다. 그래서 각 시험의 번호와 뜻을 유지하고 손잡이만 바꿨다.
 */

// `memberCount` 는 이 파일이 재는 사실이 아니지만 **필수 필드**다(#172 의 멘션이 그렇게
// 정했다 — 그 수가 조용한 실패 판정의 유일한 출처다). 인자로 받아 기본값을 두면 이 파일의
// 모든 호출부가 그것을 적어야 하므로, 여기서는 0 으로 고정한다. **다만 카드가 그 수를
// 그리므로**(`팀 · N명`) 그것을 재는 시험만 인자로 받는다.
const team = (id: string, name: string, memberCount = 0): AgentTeamRow =>
  ({ id, name, createdBy: 'u1', createdAt: '2024-01-01T00:00:00.000Z', memberCount });

const member = (accountId: string, handle: string, disabled = false): AgentTeamMemberRow =>
  ({ accountId, handle, disabled });

/** 후보 격자가 그리는 에이전트. `listAgents()` 가 주는 모양이다. */
const agentView = (id: string, handle: string, over: Partial<AgentView> = {}): AgentView => ({
  id, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...over,
});

/**
 * 스토어를 채운다. **팀 목록도 스토어에서 온다** — `AgentsSettings` 가 `GET /teams`(admin
 * 전용)를 부르지 않고 `GET /accounts` 가 함께 준 것을 읽는 이유가 그 파일 주석에 있다
 * (비-admin 이 목록을 보는 유일한 경로다).
 */
const seed = (isAdmin: boolean, teams: AgentTeamRow[] | null = [team('t1', 'ops')]) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', isAdmin),
    accounts: {
      u1: acc('u1', 'me', 'human', isAdmin),
      a1: acc('a1', 'bot', 'agent'),
      a2: acc('a2', 'helper', 'agent'),
      u2: acc('u2', 'alice', 'human'),
    },
    teams,
    channels: [chan('c1', 'general'), chan('c2', 'secret', null, 'private')],
    dms: [], connected: true,
  });
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 사이드바의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(#619 가 대기 사슬에서
// 세운 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면
// 한국어라고 말해야 한다 — 그리고 그렇게 적어 두면 이 축들이 무엇을 재는지가 오히려
// 또렷해진다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); setController(null as unknown as Controller); usePrefsStore.getState().setLocale('system'); });

type Api = ReturnType<typeof fakeApi> & Record<string, ReturnType<typeof vi.fn>>;

/**
 * 설정 › 에이전트를 세우고 **팀 묶음으로 넘어간다.**
 *
 * 탭을 실제로 누르는 것이 요점이다 — 기본 묶음이 에이전트이고(그것이 이 화면의 오늘
 * 모양이다), 팀이 기본이 되면 에이전트 격자를 보러 온 사람이 매번 탭을 눌러야 한다.
 */
function mountTeams(overrides: Partial<Parameters<typeof fakeApi>[0]> = {}): Api {
  const api = fakeApi({
    listAgents: vi.fn(async () => [agentView('a1', 'bot'), agentView('a2', 'helper')]),
    team: vi.fn(async () => ({ team: team('t1', 'ops'), members: [member('a1', 'bot')] })),
    ...overrides,
  });
  setController(new Controller(api, fakeWsFactory().makeWs));
  render(<AgentsSettings />);
  fireEvent.click(screen.getByTestId('agent-group-teams'));
  return api as Api;
}

const openTeam = async (name = 'ops') => {
  await waitFor(() => expect(screen.getByTestId(`team-card-${name}`)).toBeTruthy());
  fireEvent.click(screen.getByTestId(`team-card-${name}`));
  await waitFor(() => expect(screen.getByRole('heading', { name: `@${name}` })).toBeTruthy());
};

describe('팀 설정 화면 (#172)', () => {
  beforeEach(() => seed(true));

  it('1. 목록이 스토어에서 오고, 만들기가 생성 라우트를 부른 뒤 스토어를 다시 읽는다', async () => {
    const api = mountTeams({
      createTeam: vi.fn(async () => team('t2', 'release')),
      accounts: vi.fn(async () => accountsResult(
        [acc('u1', 'me', 'human', true)], [], [team('t1', 'ops'), team('t2', 'release')],
      )),
    });

    await waitFor(() => expect(screen.getByTestId('team-card-ops')).toBeTruthy());

    fireEvent.click(screen.getByTestId('team-create'));
    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: 'release' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));

    await waitFor(() => expect(api.createTeam).toHaveBeenCalledWith('release'));
    /*
      **스토어를 다시 읽는다** — 지역 상태에만 밀어 넣으면 다른 화면과 갈라진다. 앞 판은
      `listTeams()` 를 다시 부르는 것을 이 자리에서 쟀는데, 지금은 목록이 스토어에서
      오므로 재는 대상이 `GET /accounts` 다(`AgentsSettings` 의 `reloadTeams` 주석: 그
      라우트 하나가 계정·집합·팀을 함께 주므로 팀만 따로 받는 경로를 만들지 않는다).

      **`force` 를 함께 잰다.** 그 함수에 5초 스로틀이 걸려 있어서(`refreshAccounts`),
      안 주면 방금 만든 팀이 격자에 안 나타난다 — 사람이 누른 조작은 그 스로틀이 막으려던
      "미지의 작성자 폭주"가 아니다.
    */
    await waitFor(() => expect(api.accounts).toHaveBeenCalled());

    // 만든 뒤 **그 팀의 상세로 간다** — 만드는 이유가 팀원을 넣는 것이다.
    await waitFor(() => expect(screen.getByRole('heading', { name: '@release' })).toBeTruthy());
  });

  /**
   * **1b. 목록을 못 받은 서버에서 격자가 거짓말하지 않는다.**
   *
   * 스토어의 `null` 이 이 화면까지 그대로 와야 성립한다(`appStore.ts::teams` 의 그 표).
   * 중간의 어느 자리에서든 `?? []` 로 옮기면 격자는 다시 *"아직 팀이 없다"* 를 그리고,
   * 그것이 이 화면에서 실제로 겪은 결함이다 — 팀을 만들었는데 격자가 비어 있고 다시
   * 만들면 서버가 `name_taken` 으로 거절했다. 판정 자체는 `teamGrid.test.tsx` 가 재고,
   * 여기서는 **그 값이 화면까지 닿는가**를 잡는다.
   */
  it('1b. 서버가 팀 목록을 안 주면 격자가 그 사실을 말한다', async () => {
    seed(true, null);
    mountTeams();

    await waitFor(() => expect(screen.getByTestId('team-list-unavailable')).toBeTruthy());
    expect(screen.getByTestId('team-grid').textContent).not.toContain('아직 팀이 없다');
    // 만들기는 그 서버에서도 되므로 `+` 는 남는다.
    expect(screen.getByTestId('team-create')).toBeTruthy();
  });

  it('2. 팀원 추가·빼기가 라우트를 부르고 응답이 준 명단을 그린다', async () => {
    const api = mountTeams({
      addTeamMember: vi.fn(async () => ({ members: [member('a1', 'bot'), member('a2', 'helper')] })),
      removeTeamMember: vi.fn(async () => ({ members: [member('a2', 'helper')] })),
    });
    await openTeam();

    // **얼굴을 누른다.** 네이티브 `select` 가 없어진 자리다(문서 4단계 · B3).
    await waitFor(() => expect(screen.getByTestId('team-candidate-helper')).toBeTruthy());
    fireEvent.click(screen.getByTestId('team-candidate-helper'));
    await waitFor(() => expect(api.addTeamMember).toHaveBeenCalledWith('t1', 'a2'));
    // 명단은 **응답이 준 것**이다 — 낙관적으로 손으로 더하면 서버가 거절해도 화면에 남는다.
    await waitFor(() => expect(screen.getByTestId('team-member-helper')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('팀원 빼기: bot'));
    await waitFor(() => expect(api.removeTeamMember).toHaveBeenCalledWith('t1', 'a1'));
    // 명단에서만 사라진다 — 후보 격자에는 다시 나타나는 것이 맞다.
    await waitFor(() => expect(screen.queryByTestId('team-member-bot')).toBeNull());
    expect(screen.getByTestId('team-candidate-bot')).toBeTruthy();
  });

  /**
   * ## 네이티브 `select` 가 **정말** 사라졌는가 (문서 4단계 · B3)
   *
   * 문서의 진단: *"추가가 네이티브 `select` — B3 에서 없애기로 한 바로 그것이고, 고르면서
   * 얼굴을 볼 수 없다."*
   *
   * 되돌려 RED: `TeamDetail` 에서 `TeamMemberPicker` 를 앞 판의 `<select aria-label="팀원
   * 추가">` 로 바꾸면 세 단언이 함께 빨개진다. `option` 을 세는 것이 요점이다 — 격자를
   * 남겨 둔 채 `select` 를 하나 더 두면 앞 두 단언만으로는 안 잡힌다.
   */
  it('2b. 팀원 고르기에 네이티브 select 가 없다 — 얼굴로 고른다', async () => {
    mountTeams();
    await openTeam();
    await waitFor(() => expect(screen.getByTestId('team-member-picker')).toBeTruthy());

    const picker = screen.getByTestId('team-member-picker');
    expect(picker.querySelector('select')).toBeNull();
    expect(picker.querySelectorAll('option').length).toBe(0);
    expect(screen.queryByLabelText('팀원 추가')).toBeNull();

    // 그리고 후보가 **얼굴을 갖는다** — 옆 격자의 그 얼굴이다(`Identity` 의 avatar variant).
    // 앞 화면의 결함이 정확히 *"같은 에이전트가 여기서는 얼굴이 없다"* 였다.
    const candidate = screen.getByTestId('team-candidate-helper');
    expect(candidate.querySelector('.rounded-full')).toBeTruthy();
    expect(candidate.textContent).toContain('helper');
  });

  /**
   * **후보는 `listAgents()` 하나에서 온다 — 등록된 전부** (문서 「무엇부터」1번).
   *
   * 앞 화면은 스토어의 `accounts` 에서 뽑았고, 그것이 담는 것은 *말을 걸어 본 적 있는
   * 계정*이라 등록만 된 에이전트가 후보에서 조용히 빠졌다(*"왜 forge 만 보이나"*).
   *
   * 되돌려 RED: `AgentsSettings` 가 `TeamDetail` 에 넘기는 `agents` 를
   * `Object.values(accounts).filter((a) => a.kind === 'agent')` 로 바꾸면 `zeta` 가 사라진다.
   */
  it('2c. 후보가 listAgents() 의 전부다 — 스토어에 없는 에이전트도 뜬다', async () => {
    mountTeams({
      listAgents: vi.fn(async () => [
        agentView('a1', 'bot'), agentView('a2', 'helper'),
        // **스토어의 `accounts` 에 없는** 에이전트. 등록은 됐지만 아직 아무 채널에도 없다.
        agentView('a9', 'zeta'),
      ]),
    });
    await openTeam();
    await waitFor(() => expect(screen.getByTestId('team-candidate-zeta')).toBeTruthy());
    expect(screen.getByTestId('team-candidate-helper')).toBeTruthy();
    // 이미 팀원인 것은 후보에서 빠진다 — 누르면 서버가 거절한다(거짓 신호).
    expect(screen.queryByTestId('team-candidate-bot')).toBeNull();
  });

  /**
   * **멈춘 에이전트도 고를 수 있다** (문서: *"팀에 넣는 것과 지금 도는 것은 다른 일이다"*).
   *
   * 되돌려 RED: `TeamMemberPicker` 의 카드에 `disabled={face !== 'ok'}` 를 걸면 빨개진다.
   */
  it('2d. 멈춘 에이전트도 후보다 — 얼굴은 회색이지만 눌린다', async () => {
    const api = mountTeams({
      addTeamMember: vi.fn(async () => ({ members: [member('a1', 'bot'), member('a2', 'helper')] })),
    });
    await openTeam();
    await waitFor(() => expect(screen.getByTestId('team-candidate-helper')).toBeTruthy());

    // 아무 러너도 안 돌고 presence 에도 없다 — `faceState` 가 `stopped` 를 낸다.
    const candidate = screen.getByTestId('team-candidate-helper') as HTMLButtonElement;
    expect(candidate.dataset.face).toBe('stopped');
    expect(candidate.disabled).toBe(false);
    // 얼굴은 상태를 그대로 지닌다 — 색이 빠진다(`isFaceGreyed` 의 그 필터).
    expect(candidate.querySelector('.grayscale')).toBeTruthy();

    fireEvent.click(candidate);
    await waitFor(() => expect(api.addTeamMember).toHaveBeenCalledWith('t1', 'a2'));
  });

  /** 검색이 **에이전트 격자와 같은 검색**이다(문서) — 이름과 설명을 함께 훑는다. */
  it('2e. 후보 검색이 이름과 설명을 함께 훑는다', async () => {
    mountTeams({
      listAgents: vi.fn(async () => [
        agentView('a2', 'helper'),
        agentView('a9', 'zeta', { instructions: '릴리스 배포를 맡는다' }),
      ]),
    });
    await openTeam();
    await waitFor(() => expect(screen.getByTestId('team-candidate-zeta')).toBeTruthy());

    fireEvent.change(screen.getByTestId('team-candidate-search'), { target: { value: '배포' } });
    expect(screen.getByTestId('team-candidate-zeta')).toBeTruthy();
    expect(screen.queryByTestId('team-candidate-helper')).toBeNull();
  });

  it('3. 사람 계정은 팀원 후보에 없다 — 서버가 400 으로 거절하는 조작이다', async () => {
    mountTeams({
      // `listAgents()` 는 에이전트만 준다. 그래도 사람이 후보 격자에 서지 않는 것을
      // 재는 이유: 후보의 출처를 스토어의 `accounts` 로 되돌리면 `alice` 가 새어 든다.
      listAgents: vi.fn(async () => [agentView('a2', 'helper')]),
    });
    await openTeam();
    await waitFor(() => expect(screen.getByTestId('team-candidate-helper')).toBeTruthy());
    expect(screen.queryByTestId('team-candidate-alice')).toBeNull();
    expect(screen.getByTestId('team-candidate-grid').textContent).not.toContain('alice');
  });

  it('4. 비활성 팀원은 팀에 남고 그렇게 표시된다', async () => {
    mountTeams({
      team: vi.fn(async () => ({ team: team('t1', 'ops'), members: [member('a1', 'bot', false), member('a2', 'helper', true)] })),
    });
    await openTeam();

    await waitFor(() => expect(screen.getByTestId('team-member-bot')).toBeTruthy());
    const botRow = screen.getByTestId('team-member-bot');
    const helperRow = screen.getByTestId('team-member-helper');

    expect(botRow.textContent).toContain('@bot');
    expect(botRow.textContent).not.toContain('비활성');
    // **얼굴이 남는다**(문서: *"지우면 왜 안 불렸는지를 알 수 없으므로 얼굴은 남긴다"*).
    expect(helperRow.querySelector('.rounded-full')).toBeTruthy();
    expect(helperRow.textContent).toContain('@helper');
    expect(helperRow.textContent).toContain('비활성');
  });

  /**
   * 삭제는 되돌릴 수 없다. 초판은 한 번 누름으로 지웠다 — 이 저장소는 그 수단을
   * 거절했고(`window.confirm` 도, 한 번 누름도), 선례는 인라인 확인이다.
   *
   * **문서가 이 방식을 그대로 두라고 적었다**(*"인라인 확인은 Tauri 웹뷰에서
   * `window.confirm` 이 막힐 수 있어서 택한 방식이고 선례도 있다. 그대로 둔다 — 다만
   * 버튼 모양만 프리미티브를 통과한다"*). 그래서 이 시험은 손잡이 이름만 바뀌었다.
   */
  it('5. 삭제는 한 번 더 물은 뒤에만 라우트를 부른다', async () => {
    const api = mountTeams({ deleteTeam: vi.fn(async () => undefined) });
    await openTeam();

    fireEvent.click(screen.getByRole('button', { name: '팀 지우기' }));
    expect(api.deleteTeam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '정말 삭제' }));
    await waitFor(() => expect(api.deleteTeam).toHaveBeenCalledWith('t1'));
    // 지운 팀의 상세에 남아 있을 수 없다 — 격자로 되돌아간다.
    await waitFor(() => expect(screen.getByTestId('team-grid')).toBeTruthy());
  });

  it('5b. 확인을 취소하면 지우지 않는다', async () => {
    const api = mountTeams({ deleteTeam: vi.fn(async () => undefined) });
    await openTeam();

    fireEvent.click(screen.getByRole('button', { name: '팀 지우기' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: '팀 지우기' }));
    expect(api.deleteTeam).not.toHaveBeenCalled();
  });

  it('6. 이름 변경이 라우트를 부르고, 문법에 맞지 않으면 왕복 없이 막는다', async () => {
    const api = mountTeams({ updateTeam: vi.fn(async () => team('t1', 'ops2')) });
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
    mountTeams({ createTeam: vi.fn(async () => { throw new Error('name_taken'); }) });
    fireEvent.click(screen.getByTestId('team-create'));
    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: 'agent1' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('name_taken'));
  });

  /**
   * ## **이름의 뜻을 말한다** (문서 4단계)
   *
   * > *"팀 이름은 `HANDLE_PATTERN` 을 써 계정과 같은 네임스페이스다. 즉 `@release` 로
   * > 부르면 팀 전체가 깬다. 화면은 그 사실을 한 글자도 말하지 않는다."*
   *
   * `#570` 이 팀 멘션을 실제로 열었으므로 이것은 앞으로 될 일의 예고가 아니라 **지금 되는
   * 일**이다. 두 자리에서 말한다: 격자 머리와 이름 칸 아래.
   *
   * 되돌려 RED: `team-mention-note` 를 지우거나 격자 머리의 문구를 앞 판(`Teams`)처럼
   * 아무 말 없이 두면 빨개진다.
   */
  it('7b. @팀이름 으로 부를 수 있다는 것을 화면이 말한다', async () => {
    mountTeams();
    // ① 격자 머리 — *"이 격자에 있는 것이 무엇인가"* 에 답한다.
    await waitFor(() => expect(screen.getByTestId('team-grid')).toBeTruthy());
    expect(screen.getByRole('heading', { name: '팀' }).parentElement!.textContent)
      .toContain('부르면 팀원 전원이 깬다');

    // ② 이름을 **정하는** 칸 아래 — *"이 이름을 지으면 무슨 일이 일어나는가"*.
    await openTeam();
    const note = screen.getByTestId('team-mention-note');
    expect(note.textContent).toContain('@ops');
    expect(note.textContent).toContain('팀원 전원이 깬다');
    // 계정과 같은 이름 자리라는 것까지 말한다 — 그것이 `@release` 를 못 쓰게 되는 이유다.
    expect(note.textContent).toContain('같은 이름 자리');
  });

  /**
   * ## 팀원 명단은 팀마다 받는다 — **N+1 이고 그것이 지금 맞다**
   *
   * 문서: *"카드 격자가 팀마다 그것을 부르면 팀 열이면 왕복 열하나다 — N+1 로 시작해도
   * 된다(화면은 그려진다)."* 이 시험이 재는 것은 왕복 수가 아니라 그 결정의 **전제**다:
   *
   * 1. 팀마다 **한 번씩** 부른다(`GET /teams/:id` 가 명단을 주는 유일한 라우트다)
   * 2. 한 팀이 실패해도 **다른 카드는 채워진다** — `Promise.all` 로 묶지 않은 이유
   * 3. 명단을 못 받은 카드도 **비지 않는다** — 이름과 수는 목록에 실려 온다
   *
   * 되돌려 RED: `AgentsSettings` 의 그 효과를 `Promise.all` 로 묶고 실패 시 전체를
   * 버리면 2·3 이 빨개진다.
   */
  it('7d. 팀마다 명단을 한 번 부르고, 하나가 실패해도 나머지는 채워진다', async () => {
    seed(true, [team('t-ops', 'ops', 2), team('t-release', 'release', 5)]);
    const api = mountTeams({
      team: vi.fn(async (id: string) => {
        // `release` 의 명단만 실패한다.
        if (id === 't-release') throw new Error('nope');
        return { team: team('t-ops', 'ops', 2), members: [member('a1', 'bot'), member('a2', 'helper', true)] };
      }),
    });

    // ① 팀마다 한 번씩 — 둘이면 두 번이다.
    await waitFor(() => expect(api.team).toHaveBeenCalledTimes(2));
    expect(api.team).toHaveBeenCalledWith('t-ops');
    expect(api.team).toHaveBeenCalledWith('t-release');

    // ② 받은 카드는 얼굴이 채워지고 예외 줄까지 선다.
    await waitFor(() => expect(screen.getByTestId('team-face-ops-bot')).toBeTruthy());
    expect(screen.getByTestId('team-disabled-ops')).toBeTruthy();

    // ③ 못 받은 카드도 **비지 않는다** — 이름과 수는 목록에 실려 온다(`memberCount`).
    expect(screen.getByTestId('team-faces-release').dataset.members).toBe('unknown');
    expect(screen.getByTestId('team-box-release').textContent).toContain('@release');
    expect(screen.getByTestId('team-box-release').textContent).toContain('팀 · 5명');
    // 그리고 그 카드에 "비활성 없음"을 단정하지 않는다 — 명단을 모른다.
    expect(screen.queryByTestId('team-disabled-release')).toBeNull();
  });

  /**
   * **두 화면이 서로를 가리킨다** (문서가 적어 둔 열린 결정의 선택지 중 하나).
   *
   * `Handle Groups` 는 목차에 남았으므로(`sections.ts` 의 근거) 남는 일이 이것이다:
   * `@release` 를 만들려는 사람이 어느 쪽으로 가야 하는지 화면이 말해야 한다.
   *
   * 되돌려 RED: 두 문구 중 하나를 지우면 그 단언이 빨개진다.
   */
  it('7c. 팀과 Handle Groups 가 서로를 가리킨다', async () => {
    mountTeams();
    await openTeam();
    // 팀 → 집합
    expect(screen.getByTestId('team-mention-note').textContent).toContain('Handle Groups');
    cleanup();

    // 집합 → 팀
    const api = fakeApi({});
    setController(new Controller(api, fakeWsFactory().makeWs));
    const { HandleGroupsSettings } = await import('../src/components/settings/HandleGroupsSettings');
    render(<HandleGroupsSettings />);
    expect(screen.getByText(/에이전트를 묶으려면 설정 › Agents/)).toBeTruthy();
  });
});

describe('팀 설정 화면 — 비-admin (#172)', () => {
  beforeEach(() => seed(false));

  it('8. 비-admin 에게는 만들기·빼기·삭제가 없다', async () => {
    mountTeams();
    // `+` 카드 자체가 없다 — 눌렀을 때 403 이 나는 문을 그리지 않는다.
    await waitFor(() => expect(screen.getByTestId('team-grid')).toBeTruthy());
    expect(screen.queryByTestId('team-create')).toBeNull();

    await openTeam();
    expect(screen.queryByLabelText('팀원 빼기: bot')).toBeNull();
    expect(screen.queryByRole('button', { name: '팀 지우기' })).toBeNull();
    // 팀원 고르기 자체가 없다 — `select` 도 격자도.
    expect(screen.queryByTestId('team-member-picker')).toBeNull();
    expect(screen.queryByLabelText('팀원 추가')).toBeNull();
    // 그래도 **목록은 본다**(비-admin 이 목록을 보는 경로가 스토어인 이유).
    expect(screen.getByTestId('team-member-bot')).toBeTruthy();
  });
});

/**
 * ## 설정 목차에서 `Teams` 가 **사라졌다** (문서 4단계)
 *
 * 앞 판의 시험 9 는 *"목차에서 Teams 를 고르면 팀 화면이 그려진다"* 였다. 그 항목이
 * 없어졌으므로 이 자리가 재는 것이 뒤집힌다 — **없어진 것과 대신 어디에 있는지** 둘이다.
 *
 * 목차 상수와 `isSectionId` 를 **함께** 재는 이유: `SETTINGS_GROUPS` 에서만 빼고 유니온에
 * 남겨 두면 저장된 설정의 `'teams'` 가 타입을 통과하면서 아무 화면도 안 그린다
 * (`sections.ts` 의 그 주석). 유니온에서 지운 것은 컴파일이 잡지만, 그 판정이 실제로
 * 거절하는지는 여기서 잰다.
 */
describe('설정 목차에서 Teams 가 사라졌다 (문서 4단계)', () => {
  beforeEach(() => seed(true));

  it('9. 목차에 Teams 항목이 없고 그 이름이 섹션으로 통과하지 않는다', () => {
    const labels = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).not.toContain('Teams');
    // `Handle Groups` 는 **남는다** — 갈라 두기로 한 결정(`sections.ts` 의 근거).
    expect(labels).toContain('Handle Groups');
    // 옛 배선이 들고 오는 `'teams'` 는 섹션이 아니다.
    expect(isSectionId('teams')).toBe(false);
    expect(isSectionId('agents')).toBe(true);
  });

  it('9b. Agents 화면 안에서 팀을 다룬다', async () => {
    const api = fakeApi({
      listAgents: vi.fn(async () => [agentView('a1', 'bot')]),
      team: vi.fn(async () => ({ team: team('t1', 'ops'), members: [member('a1', 'bot')] })),
    });
    setController(new Controller(api, fakeWsFactory().makeWs));
    render(<SettingsScreen onBack={vi.fn()} onSignOut={vi.fn()} onCommunitiesEmpty={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    // 기본 묶음은 **에이전트**다 — 그것이 이 화면의 오늘 모양이고, 팀이 기본이 되면
    // 에이전트를 보러 온 사람이 매번 탭을 눌러야 한다.
    await waitFor(() => expect(screen.getByTestId('agent-grid')).toBeTruthy());
    expect(screen.queryByTestId('team-grid')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-group-teams'));
    await waitFor(() => expect(screen.getByTestId('team-card-ops')).toBeTruthy());
    // 묶음을 옮기면 **그 묶음의 격자**다 — 에이전트 격자가 함께 서 있지 않다.
    expect(screen.queryByTestId('agent-grid')).toBeNull();
  });

  /**
   * ## 상세에는 탭이 없다 — **`← 팀` 이 유일한 길이다**
   *
   * *"한 번에 한 화면"* 이라는 규칙(identity 문서)이 팀에도 그대로 적용된다. 에이전트
   * 상세도 같은 모양이고(`agent-back` 이 유일한 길이다), 상세에 탭을 함께 두면 지금
   * 무엇을 고치고 있는지가 흐려진다 — 탭은 *"무엇의 격자냐"* 를 가르는 것이라 격자에만
   * 뜻이 있다.
   *
   * **그래도 `group` 축은 따로 필요하다**: 격자로 되돌아왔을 때 팀 묶음이 그대로 남아야
   * 하고(`view` 만 되돌린다), 그것이 두 축을 합치지 않은 이유다(`group` 상태 주석).
   *
   * 되돌려 RED: 탭 핸들러에서 `setSelectedTeam(null)`·`setView('grid')` 를 지우면 마지막
   * 두 단언이 빨개진다 — 에이전트 탭을 눌렀는데 팀 상세가 남는다.
   */
  it('9c. 상세에는 탭이 없고, 격자로 나오면 묶음이 그대로다', async () => {
    mountTeams();
    await openTeam();
    // 상세에는 탭이 없다 — 나가는 길은 `← 팀` 하나다.
    expect(screen.queryByTestId('agent-group-agents')).toBeNull();
    expect(screen.queryByTestId('agent-group-teams')).toBeNull();

    fireEvent.click(screen.getByTestId('team-back'));
    // **팀 묶음이 그대로다** — `view` 만 되돌아왔다.
    await waitFor(() => expect(screen.getByTestId('team-grid')).toBeTruthy());
    expect(screen.queryByTestId('agent-grid')).toBeNull();

    // 여기서 탭이 다시 선다. 에이전트로 옮기면 팀 상세가 남지 않는다.
    fireEvent.click(screen.getByTestId('agent-group-agents'));
    await waitFor(() => expect(screen.getByTestId('agent-grid')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: '@ops' })).toBeNull();
  });
});

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
    <Sidebar panel="home" onOpenDirectory={vi.fn()}
      onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()}
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import {
  useActiveStore as useAppStore, useCommunityRegistry, resetCommunityRegistry,
} from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Rail, type RailPanel } from '../src/components/Rail';
import { Sidebar } from '../src/components/Sidebar';
import type { SectionId } from '../src/components/settings/sections';
import { acc, chan } from './helpers/fakeApi';
import type { InboxEntry } from '@murmur/shared';

/**
 * 레일 — 정본 문서 [`docs/desktop-rail.html`](../../../docs/desktop-rail.html) **1단계**.
 *
 * 문서의 진단: 커뮤니티 · 채널 · 이동 · DM · 에이전트 · 기다리는 것 · 나 일곱 가지가 한 열에
 * 세로로 쌓여, 채널이 서른이면 *"밀려나는 쪽이 하필 DM 과 에이전트"* 다. 그래서 축을 하나 더
 * 만든다 — 가로 62px 레일 네 칸.
 *
 * **이 파일이 재는 것은 껍데기다.** 각 패널의 내용은 지금 사이드바의 묶음을 그대로 옮긴 것이고
 * (2·3단계가 그것을 바꾼다), 그 내용의 계약은 `sidebar.test.tsx` 가 계속 잰다. 여기서 잠그는
 * 것은 **레일이 실제로 축을 만들었는가**다: 칸을 고르면 그 목록만 서는가, 밀려나던 둘이
 * 이제 세로를 다 쓰는가, 그리고 문서가 요구한 배지·단축키·접근성이 참인가.
 *
 * 계정 메뉴 테스트(#113)가 `sidebar.test.tsx` 에서 여기로 왔다 — 그 메뉴가 사이드바 맨
 * 아래에서 레일 맨 아래로 옮겨졌고, 계약을 재는 자리는 그것이 사는 자리를 따라간다.
 */

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
    setStatus: vi.fn().mockResolvedValue(undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

/** 나를 막는 말 하나 — 안 읽은 멘션. 홈 배지가 세는 것이 이것이다. */
const blocking = (id: number, channelId: string): InboxEntry => ({
  id, messageId: `m${id}`, reason: 'mention', readAt: null, channelId,
  authorId: 'u2', body: '', meta: {}, createdAt: '2026-09-05T00:00:00.000Z', threadRootId: null,
});

const mountRail = (props: Partial<{
  panel: RailPanel;
  onPanelChange: (p: RailPanel) => void;
  onOpenSaved: () => void;
  onOpenSettings: (section?: SectionId) => void;
  onOpenCommunityMark: () => void;
  onLogout: () => void;
}> = {}) =>
  render(
    <Rail
      panel={props.panel ?? 'home'}
      onPanelChange={props.onPanelChange ?? vi.fn()}
      onOpenSaved={props.onOpenSaved ?? vi.fn()}
      onOpenSettings={props.onOpenSettings ?? vi.fn()}
      onOpenCommunityMark={props.onOpenCommunityMark ?? vi.fn()}
      onLogout={props.onLogout ?? vi.fn()}
    />,
  );

const mountSidebar = (panel: 'home' | 'dm' | 'agents') =>
  render(
    <Sidebar
      panel={panel}
      onOpenDirectory={vi.fn()}
      onOpenChannelDirectory={vi.fn()}
      onOpenInbox={vi.fn()}
      collapsed={false}
      onToggleCollapse={vi.fn()}
    />,
  );

beforeEach(() => {
  resetCommunityRegistry();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: { ...acc('u1', 'jaebin'), isAdmin: true },
    accounts: {
      u1: acc('u1', 'jaebin'),
      u2: acc('u2', 'bot', 'agent'),
      u3: acc('u3', 'codex', 'agent'),
    },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'], lastMessageAt: null }],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(() => { cleanup(); });

describe('레일 네 칸', () => {
  it('칸이 넷이고 순서가 홈 · DM · 에이전트 · 북마크다', () => {
    /*
      문서: *"칸은 넷 — 홈 · DM · 에이전트 · 북마크."* 순서가 계약인 이유는 **숫자 단축키가
      그 순서를 그대로 따르기** 때문이다 — 순서가 바뀌면 `⌘2` 가 다른 곳을 연다.
    */
    fakeController();
    mountRail();

    const scroller = screen.getByTestId('rail-home').parentElement!;
    const order = within(scroller).getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'));
    expect(order).toEqual(['rail-home', 'rail-dm', 'rail-agents', 'rail-saved']);
  });

  it('첫 칸이 `채널` 이 아니라 `홈` 이다', () => {
    /*
      문서가 이유를 길게 적었다: *"그 자리에는 채널이 아닌 것도 들어간다 — 디렉터리가
      그렇고 앞으로 생길 것들도 그렇다. 칸 이름을 `채널` 로 못 박으면 그때마다 갈 곳이
      없어져서 다시 아래로 매다는 짓을 반복하게 된다."*
    */
    fakeController();
    mountRail();

    const home = screen.getByTestId('rail-home');
    expect(home.textContent).toContain('Home');
    expect(home.textContent).not.toContain('Channel');
  });

  it('아이콘에 글자를 붙인다 — 그림만 두지 않는다', () => {
    /*
      문서: *"Slack 도 아이콘만 두지 않는다 — 하물며 `에이전트` 는 이 앱이 처음 쓰는 말이라
      그림만으로는 배울 수 없다."* 글자가 없으면 사람은 `🤖` 를 눌러 봐야 안다.
    */
    fakeController();
    mountRail();

    for (const [testId, label] of [
      ['rail-home', 'Home'], ['rail-dm', 'DM'], ['rail-agents', 'Agents'], ['rail-saved', 'Saved'],
    ] as const) {
      expect(screen.getByTestId(testId).textContent).toContain(label);
    }
  });

  it('지금 어느 칸인지 스크린리더에 전달된다 — 색이 아니라 `aria-current` 로', () => {
    // 색과 굵기만으로 표시하면 그 구분이 색을 못 보는 사람에게는 없는 것과 같다.
    fakeController();
    mountRail({ panel: 'dm' });

    expect(screen.getByTestId('rail-dm').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('rail-home').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('rail-agents').getAttribute('aria-current')).toBeNull();
  });

  it('칸을 누르면 그 칸으로 바뀐다', () => {
    fakeController();
    const onPanelChange = vi.fn();
    mountRail({ onPanelChange });

    fireEvent.click(screen.getByTestId('rail-agents'));
    expect(onPanelChange).toHaveBeenCalledWith('agents');
  });

  it('북마크 칸은 패널이 아니라 오버레이를 연다', () => {
    /*
      문서: *"북마크는 레일에만 둔다 — 자기 칸이 있는데 홈에도 한 줄을 세우면 같은 것으로
      가는 길이 둘이 되고, 그때부터 사람은 어느 쪽이 맞는지 매번 고른다."* 그 칸이 여는 것은
      기존 `SavedMessages` 오버레이라, 칸을 골라 둔 상태가 따로 생기지 않는다.
    */
    fakeController();
    const onOpenSaved = vi.fn();
    const onPanelChange = vi.fn();
    mountRail({ onOpenSaved, onPanelChange });

    fireEvent.click(screen.getByTestId('rail-saved'));
    expect(onOpenSaved).toHaveBeenCalled();
    // 칸이 바뀌지 않는다 — 오버레이를 닫으면 원래 보던 목록으로 돌아온다.
    expect(onPanelChange).not.toHaveBeenCalled();
  });

  it('키보드로 칸에 갈 수 있고 포커스 링이 앱 강조색이다', () => {
    /*
      `Menu.tsx` 가 적어 둔 함정: Tailwind v4 에서 `outline-none` + `outline-2` 만 쓰면
      `--tw-outline-style: none` 이 남아 **링이 그려지지 않는다.** `outline-solid` 로
      변수를 되돌리는 클래스가 함께 있어야 참이다. 색은 하드코딩이 아니라 토큰이다.
    */
    fakeController();
    mountRail();

    const home = screen.getByTestId('rail-home');
    home.focus();
    expect(document.activeElement).toBe(home);
    expect(home.className).toContain('focus-visible:outline-solid');
    expect(home.className).toContain('focus-visible:outline-accent');
    // `focus` 가 아니라 `focus-visible` 이어야 한다 — 마우스 클릭 뒤에 사각형이 남지 않는다.
    expect(home.className).not.toMatch(/(^|\s)focus:outline/);
  });
});

describe('홈 칸이 배지를 대신 받는다', () => {
  it('나를 막는 개수를 홈 칸이 센다 — 어느 칸에 있든 보인다', () => {
    /*
      문서: *"Inbox 는 목록이 아니라 하나의 화면이라 레일 한 칸을 통째로 쓸 만큼 크지 않다.
      홈 패널 맨 위 한 줄로 두고, 배지는 홈 칸이 대신 받는다 — 어느 칸에 있든 '나를 기다리는
      것 2개'가 계속 보인다."*
    */
    fakeController();
    useAppStore.getState().set({ unread: [blocking(1, 'c1'), blocking(2, 'c2')] });
    mountRail({ panel: 'agents' });

    expect(screen.getByTestId('rail-home-badge').textContent).toBe('2');
    // 수치가 접근 가능한 이름에도 실린다 — 주황 원 하나는 스크린리더에 아무 말도 안 한다.
    expect(screen.getByTestId('rail-home').getAttribute('aria-label')).toContain('2');
  });

  it('막는 것이 없으면 배지를 그리지 않는다', () => {
    // 문서: *"안 읽음까지 세면 배지가 늘 켜져 있어서 아무 말도 하지 않게 된다."*
    fakeController();
    mountRail();

    expect(screen.queryByTestId('rail-home-badge')).toBeNull();
  });

  it('배지는 홈 칸에만 붙는다', () => {
    fakeController();
    useAppStore.getState().set({ unread: [blocking(1, 'c1')] });
    mountRail();

    expect(screen.queryByTestId('rail-dm-badge')).toBeNull();
    expect(screen.queryByTestId('rail-agents-badge')).toBeNull();
    expect(screen.queryByTestId('rail-saved-badge')).toBeNull();
  });
});

describe('숫자 단축키가 레일 순서를 그대로 따른다', () => {
  it('⌘1~⌘3 이 세 패널을, ⌘4 가 북마크를 연다', () => {
    fakeController();
    const onPanelChange = vi.fn();
    const onOpenSaved = vi.fn();
    mountRail({ onPanelChange, onOpenSaved });

    fireEvent.keyDown(document, { key: '1', metaKey: true });
    fireEvent.keyDown(document, { key: '2', metaKey: true });
    fireEvent.keyDown(document, { key: '3', metaKey: true });
    fireEvent.keyDown(document, { key: '4', metaKey: true });

    expect(onPanelChange.mock.calls.map((c) => c[0])).toEqual(['home', 'dm', 'agents']);
    expect(onOpenSaved).toHaveBeenCalledTimes(1);
  });

  it('없는 칸의 숫자는 아무 일도 하지 않는다', () => {
    // `⌘5` 로 다섯 번째 칸을 여는 척하지 않는다 — 칸은 넷이다.
    fakeController();
    const onPanelChange = vi.fn();
    mountRail({ onPanelChange });

    fireEvent.keyDown(document, { key: '5', metaKey: true });
    fireEvent.keyDown(document, { key: '0', metaKey: true });
    expect(onPanelChange).not.toHaveBeenCalled();
  });

  it('입력 중에는 숫자를 가로채지 않는다', () => {
    // 숫자는 사람이 실제로 타이핑하는 글자다 — 컴포저에서 `⌘2` 가 칸을 바꾸면
    // 쓰던 말이 화면 뒤로 사라진다.
    fakeController();
    const onPanelChange = vi.fn();
    mountRail({ onPanelChange });

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '2', metaKey: true });
    expect(onPanelChange).not.toHaveBeenCalled();
    input.remove();
  });

  it('modifier 없는 숫자는 무시한다', () => {
    fakeController();
    const onPanelChange = vi.fn();
    mountRail({ onPanelChange });

    fireEvent.keyDown(document, { key: '2' });
    expect(onPanelChange).not.toHaveBeenCalled();
  });
});

describe('레일 위아래 — 커뮤니티 마크와 내 얼굴', () => {
  it('커뮤니티 마크가 맨 위에 서서 지금 어디인지 말한다', () => {
    /*
      문서의 진단: *"설정 목차에 Communities 가 이미 있는데, 앱 화면 어디에도 지금 어느
      커뮤니티에 있는지 나오지 않는다 — 타이틀바의 murmur 는 앱 이름이지 커뮤니티가 아니다."*
      실측(2026-09-07)으로는 한 곳 있었다 — 계정 메뉴 **머리**(#488 A1)가 워크스페이스를
      적는다. 다만 그것은 메뉴를 열어야 보이므로 "화면에 늘 있는가"에는 여전히 아니다.
    */
    fakeController();
    const entry = useCommunityRegistry.getState().entries[0]!;
    useCommunityRegistry.getState().setLabel(entry.id, 'rebellions');
    mountRail();

    const mark = screen.getByTestId('rail-community-mark');
    // 이름 전체가 접근 가능한 이름에 실린다 — 타일에는 이니셜 한 글자뿐이다.
    expect(mark.getAttribute('aria-label')).toContain('rebellions');
    expect(mark.getAttribute('aria-label')).toContain('연결됨');
    expect(mark.textContent).toBe('R');
  });

  it('마크와 얼굴은 스크롤 밖이다 — 세로를 쓰는 것은 네 칸뿐이다', () => {
    /*
      문서: *"레일에서 세로를 쓰는 것은 네 칸뿐이어야 한다"* 그리고 *"커뮤니티와 나는 패널이
      무엇을 보여주든 자리가 안 변한다 — 레일에서 그 둘만 고정이다."* 스크롤 컨테이너 안에
      들어가면 칸이 늘어날 때 마크나 얼굴이 밀려 사라진다.
    */
    fakeController();
    mountRail();

    const scroller = screen.getByTestId('rail-home').parentElement!;
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.contains(screen.getByTestId('rail-community-mark'))).toBe(false);
    expect(scroller.contains(screen.getByTestId('me-row'))).toBe(false);
  });

  it('커뮤니티가 여럿이면 마크를 그리지 않는다 — 전환기가 그 일을 한다', () => {
    /*
      `CommunityRail`(#165)이 이미 여럿일 때의 전환을 한다. 마크를 함께 세우면 지금 있는
      곳이 두 곳에 표시되고, 어느 쪽이 정본인지 알 수 없다. 목록을 만드는 것은 문서의 4단계다.
    */
    fakeController();
    useCommunityRegistry.getState().register({ baseUrl: 'http://second.test', label: 'second' });
    mountRail();

    expect(screen.queryByTestId('rail-community-mark')).toBeNull();
  });
});

describe('계정 메뉴 (#113) — 자리만 레일로 옮겼다', () => {
  it('계정 행이 클릭 가능한 트리거다', () => {
    fakeController();
    mountRail();

    const trigger = screen.getByTestId('me-row');
    // ARIA 1.1 의 값은 'menu' 다 — 'true' 는 레거시 별칭이라 어느 종류의 팝업인지 말하지 못한다.
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('계정 행을 클릭하면 메뉴가 열린다', () => {
    fakeController();
    mountRail();

    const trigger = screen.getByTestId('me-row');
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('메뉴 안의 Settings 를 누르면 onOpenSettings 가 불린다 — 섹션을 지목하지 않고', () => {
    fakeController();
    const onOpenSettings = vi.fn();
    mountRail({ onOpenSettings });

    fireEvent.click(screen.getByTestId('me-row'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    // 섹션을 지목하지 않고 연다 — 설정 화면이 기본 섹션을 고른다.
    expect(onOpenSettings).toHaveBeenCalledWith();
  });

  it('메뉴 안의 Sign out 을 누르면 controller.logout 과 onLogout 이 불린다', () => {
    const c = fakeController();
    const onLogout = vi.fn();
    mountRail({ onLogout });

    fireEvent.click(screen.getByTestId('me-row'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(c.logout).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape 로 닫히고 포커스가 트리거로 돌아온다', () => {
    fakeController();
    mountRail();

    const trigger = screen.getByTestId('me-row');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('바깥을 클릭하면 닫힌다', () => {
    fakeController();
    mountRail();

    const trigger = screen.getByTestId('me-row');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('화살표 키로 항목 사이를 이동한다', async () => {
    fakeController();
    mountRail();

    fireEvent.click(screen.getByTestId('me-row'));

    // 첫 항목은 **내 프로필**이다(#488 A1) — 아바타를 눌러도 이 메뉴가 열리므로,
    // "아바타를 누르면 프로필"이라는 앱의 다른 규칙이 여기서는 메뉴의 첫 항목으로 산다.
    const profile = screen.getByRole('menuitem', { name: '내 프로필' });
    const status = screen.getByRole('menuitem', { name: '상태 바꾸기' });

    await waitFor(() => expect(document.activeElement).toBe(profile));
    fireEvent.keyDown(profile, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(status);
    fireEvent.keyDown(status, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(profile);
  });

  it('메뉴가 닫혀 있을 때는 role="menu" 가 문서에 없다', () => {
    fakeController();
    mountRail();

    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('축이 실제로 하나 늘었다 — 밀려나던 둘이 세로를 다 쓴다', () => {
  /**
   * **문서의 진단을 여기서 잠근다.** 채널이 서른일 때 DM 과 에이전트가 사라지던 것이 이
   * 작업의 이유고, 그것이 다시 생기면 이 테스트가 깨진다.
   *
   * jsdom 에는 레이아웃 엔진이 없어 "스크롤 밖으로 밀렸다"를 픽셀로 잴 수 없다. 그래서
   * **한 열에 함께 그려지지 않는다**로 잰다 — 밀려남의 원인 자체를 재는 것이고,
   * `Sidebar` 의 `collapsed` 테스트가 같은 이유로 "내용이 그려지지 않는다"로 재고 있다.
   */
  const thirtyChannels = () =>
    Array.from({ length: 30 }, (_, i) => chan(`c${i}`, `ch-${String(i).padStart(2, '0')}`));

  it('채널이 서른이어도 DM 칸은 DM 만 그린다', () => {
    fakeController();
    useAppStore.getState().set({ channels: thirtyChannels() });
    mountSidebar('dm');

    // DM 이 선다.
    expect(screen.getByTestId('add-dm')).toBeTruthy();
    // 채널 서른은 이 칸에 없다 — 그것이 DM 을 밀어내던 원인이었다.
    expect(screen.queryByText('ch-00')).toBeNull();
    expect(screen.queryByTestId('add-channel')).toBeNull();
  });

  /**
   * **재는 것은 그대로고 찾는 방법만 바뀌었다**(`docs/desktop-rail.html` 3단계).
   *
   * 앞 판본은 `getByText('@codex')` 였다 — 그 칸이 `@handle` 목록이던 때의 모양이다.
   * 3단계가 그것을 얼굴 그리드로 바꾸면서 카드의 이름줄은 `@` 없는 핸들이 됐고(설정 ›
   * 에이전트의 카드와 같은 컴포넌트다), 그래서 카드의 `data-testid` 로 찾는다.
   *
   * 앞 판본 주석의 *"DM 이 없는 에이전트(codex)"* 라는 한정도 지웠다: 3단계가
   * `dmAgentIds` 필터를 없애서 **DM 이 있는 bot 도 이 칸에 선다.** 그 비대칭을 없애는 것이
   * 3단계의 핵이고, 그것 자체는 `agentsPanelGrid.test.tsx` 가 잠근다. 여기가 재는 것은
   * 문서의 1단계 — *"채널이 서른이어도 에이전트가 밀려나지 않는다"* — 하나다.
   */
  it('채널이 서른이어도 에이전트 칸은 에이전트만 그린다', () => {
    fakeController();
    useAppStore.getState().set({ channels: thirtyChannels() });
    mountSidebar('agents');

    expect(screen.getByTestId('agent-card-codex')).toBeTruthy();
    expect(screen.queryByText('ch-00')).toBeNull();
  });

  it('홈 칸은 채널을 그리고 DM·에이전트를 그리지 않는다', () => {
    fakeController();
    mountSidebar('home');

    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.queryByTestId('add-dm')).toBeNull();
    // 위와 같은 이유로 카드 이름으로 찾는다 — `@codex` 는 이제 어느 칸에도 없어서
    // 이 단언이 **무엇을 봐도 통과하는** 단언이 된다.
    expect(screen.queryByTestId('agent-card-codex')).toBeNull();
  });
});

describe('즐겨찾기가 채널 위에 선다', () => {
  const starred = (channelId: string) => ({
    accountId: 'u1', channelId,
    mutedAt: null, starredAt: '2026-09-05T00:00:00.000Z', hiddenAt: null,
    notifyLevel: 'all' as const, section: null, sortOrder: null,
  });

  it('별표를 켠 채널이 섹션과 무관하게 맨 위 묶음에 모인다', () => {
    /*
      **문서보다 코드가 앞서 있던 자리다.** 별표는 이미 있었고(`toggleChannelStar`),
      `sortChannelsBySection` 이 그것을 "섹션 안에서 먼저"로 정렬했다(#152) — 그래서 섹션이
      여럿이면 즐겨찾기가 목록 곳곳에 흩어졌다. 문서가 요구한 *"자주 보는 것이 늘 같은
      자리에 고정된다"* 는 그때 성립하지 않았다. 이 묶음이 그것을 고친다.
    */
    fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'alpha'), chan('c2', 'beta'), chan('c3', 'zulu')],
      channelPrefs: {
        // beta 는 `work` 섹션에 있고 zulu 는 섹션이 없다. 별표는 zulu 에만.
        c2: { ...starred('c2'), starredAt: null, section: 'work' },
        c3: starred('c3'),
      },
    });
    mountSidebar('home');

    const names = screen.getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => t.startsWith('#'));
    // 섹션이 있는 beta 보다 **위**에 선다 — 섹션 정렬이 별표를 이기지 못한다.
    expect(names.findIndex((t) => t.startsWith('#zulu'))).toBe(0);
    expect(screen.getByText('Favorites')).toBeTruthy();
  });

  it('한 채널이 두 묶음에 동시에 서지 않는다', () => {
    // 두 줄이 되면 어느 줄의 배지가 최신인지 화면이 답하지 못한다(숨김 묶음과 같은 규칙).
    fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'alpha')],
      channelPrefs: { c1: starred('c1') },
    });
    mountSidebar('home');

    const rows = screen.getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => t.startsWith('#alpha'));
    expect(rows).toHaveLength(1);
  });

  it('별표가 없으면 묶음 자체를 그리지 않는다', () => {
    // 문서: *"비어 있으면 묶음 자체를 그리지 않는다."* 빈 머리글은 거짓 신호다.
    fakeController();
    mountSidebar('home');

    expect(screen.queryByText('Favorites')).toBeNull();
  });
});

describe('Inbox 는 홈 맨 위, 북마크는 레일에만', () => {
  it('Inbox 가 홈 패널의 첫 줄이다', () => {
    /*
      문서: *"Inbox 는 목록이 아니라 하나의 화면이라 레일 한 칸을 통째로 쓸 만큼 크지 않다.
      홈 패널 맨 위 한 줄로 두고…"* 예전에는 채널·보관·숨김 **다음**이라 채널이 몇 개만
      늘어도 아래로 밀렸다.
    */
    fakeController();
    useAppStore.getState().set({ channels: [chan('c1', 'general')] });
    mountSidebar('home');

    const inbox = screen.getByText('Inbox');
    const channel = screen.getByRole('button', { name: /# general/ });
    expect(inbox.compareDocumentPosition(channel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('홈에 `Saved` 한 줄을 세우지 않는다 — 같은 것으로 가는 길을 둘로 만들지 않는다', () => {
    fakeController();
    mountSidebar('home');

    expect(screen.queryByText('Saved')).toBeNull();
  });
});

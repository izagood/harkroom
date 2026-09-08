import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import {
  useActiveStore as useAppStore, useCommunityRegistry, resetCommunityRegistry,
} from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { Rail } from '../src/components/Rail';
import type { SectionId } from '../src/components/settings/sections';
import { acc, chan } from './helpers/fakeApi';

/**
 * #488 문서(남는 여덟 곳) A1·A2 — 내 자리와 `+`.
 *
 * 문서가 둘을 **한 번에** 고치라고 적었다: 설정 입구가 없어서 nav 한복판에
 * `+ Add or edit agents` 가 있었고, 그 줄이 있어서 `+` 가 셋으로 갈렸다. 맨 아래 내 자리가
 * 눌리면 둘 다 풀린다 — 그래서 두 계약을 한 파일에 둔다.
 *
 * **내 자리가 레일로 갔다**(레일 문서 1단계 — 「레일 맨 아래 · 나」). A1 의 계약은 한 글자도
 * 바뀌지 않았고 자리만 옮겼으므로, 이 파일은 **레일과 사이드바를 함께 세워** 그 계약을
 * 계속 잰다 — `Workspace` 가 실제로 그 둘을 나란히 그린다. 계약을 지우는 것이 아니라
 * 자리를 따라가는 것이 요점이다: 이 테스트들이 사라지면 "행 전체가 트리거"·"톱니 없음"·
 * "`⌘,` 가 참이다" 같은 결정이 아무 곳에서도 지켜지지 않는다.
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

const mount = (props: Partial<{ onOpenSettings: (section?: SectionId) => void; onLogout: () => void }> = {}) =>
  render(
    <>
      <Rail
        panel="home"
        onPanelChange={vi.fn()}
        onOpenSaved={vi.fn()}
        onOpenSettings={props.onOpenSettings ?? (() => {})}
        onOpenCommunityMark={vi.fn()}
        onLogout={props.onLogout ?? (() => {})}
      />
      <Sidebar panel="home"
        onOpenDirectory={() => {}}
        onOpenChannelDirectory={() => {}}
        onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />
    </>,
  );

/**
 * 한 화면에 **두 칸을 동시에** 세운다. `+` 의 모양·자리 규칙(A2)은 채널의 것과 DM 의 것을
 * 나란히 놓고 비교해야 재어지는데, 레일이 생긴 뒤로 그 둘은 서로 다른 칸에 산다.
 *
 * 앱에서는 이렇게 보이지 않는다 — 그래서 **여기서만** 두 칸을 함께 세운다. 규칙 자체는
 * 칸이 갈렸다고 사라지지 않는다: 두 `+` 가 여전히 같은 `addRow` 를 통과해야 사람이
 * 칸을 옮겨 다닐 때 같은 것을 같은 모양으로 만난다.
 */
const mountBothPanels = () =>
  render(
    <>
      <Sidebar panel="home"
        onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
        collapsed={false} onToggleCollapse={vi.fn()}
      />
      <Sidebar panel="dm"
        onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
        collapsed={false} onToggleCollapse={vi.fn()}
      />
    </>,
  );

beforeEach(() => {
  resetCommunityRegistry();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: { ...acc('u1', 'jaebin'), isAdmin: true },
    accounts: { u1: acc('u1', 'jaebin'), u2: acc('u2', 'nari') },
    channels: [chan('c1', 'general')],
    dms: [],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(() => { cleanup(); });

describe('A1 · 내 자리가 얼굴을 갖고 눌린다', () => {
  it('얼굴이 서고, 그 자리에 `@` 를 붙이지 않는다', () => {
    /*
      원래 단언은 "아바타 + **이름**" 이었다. 레일 문서가 그 줄을 **얼굴만**으로 줄였다 —
      "내 얼굴이 레일 맨 아래로 내려온다." 62px 에 핸들을 함께 세우면 이름이 잘리고,
      잘린 이름은 없는 것보다 나쁘다(무엇으로 잘렸는지 사람이 알 수 없다).

      이름을 **잃지는 않았다**: 아래 「메뉴 머리」 테스트가 이름·`@handle`·워크스페이스를
      계속 잰다. `@` 를 붙이지 않는다는 규칙은 이 자리에서도 그대로다 — 내 자리는 남을
      지목하는 자리가 아니다.
    */
    fakeController();
    mount();

    const meRow = screen.getByTestId('me-row');
    expect(meRow.textContent).not.toContain('@');
    // 얼굴이 실제로 선다 — `Identity` 의 avatar 자리가 이니셜을 그린다.
    expect(within(meRow).getByText('J')).toBeTruthy();
    // 접근성 이름은 여전히 누구인지 말한다. 글자를 뗀 대가를 여기서 갚는다 —
    // 스크린리더 사용자에게 "버튼" 하나만 남기지 않는다.
    expect(meRow.getAttribute('aria-label')).toContain('jaebin');
  });

  it('행 전체가 하나의 트리거다 — 미니 톱니도 `⌄` 화살표도 없다', () => {
    /*
      문서가 앞 그림의 12px 톱니를 스스로 물렀다: "행 전체가 버튼이라고 해 놓고 미니 톱니를
      또 그린 것이라 앞뒤가 안 맞았다." 화살표도 같은 이유로 뺐다 — 눌린다는 신호는 hover
      면과 커서로 충분하고, 그게 위의 `#general` 줄이 이미 쓰는 방식이다.

      **푸터 안에 버튼이 하나뿐인 것**으로 이것을 잠근다: 톱니든 화살표든 따로 그리면
      그 자리에 두 번째 트리거가 생긴다.
    */
    fakeController();
    mount();

    const meRow = screen.getByTestId('me-row');
    const footer = meRow.parentElement!;
    expect(footer.querySelectorAll('button')).toHaveLength(1);
    expect(meRow.textContent).not.toContain('⌄');
    expect(meRow.textContent).not.toContain('⚙');
  });

  it('정상 상태에서는 `대화 가능` 이 행에 서지 않는다', () => {
    /*
      이 앱의 **네 번째 상태 어휘**였고, "정상 상태에는 표시를 붙이지 않는다"는
      `Identity.tsx::STATUS_MARKS` 의 규칙에도 어긋났다. 그 규칙을 여기서 복제하지 않고
      `StatusMark` 를 통과시키므로, 판정이 한 곳에 남는다.
    */
    fakeController();
    mount();

    expect(screen.getByTestId('me-row').textContent).not.toContain('대화 가능');
    expect(screen.queryByTestId('status-u1')).toBeNull();
  });

  it('자리를 비웠을 때만 행에 글자가 선다', () => {
    // 문서: "자리를 비웠을 때만 행에 글자가 선다." 없어지는 것과 안 나오는 것은 다르다 —
    // 정상에서 사라졌다고 해서 비정상에서도 사라지면 상태를 아예 말하지 못하게 된다.
    fakeController();
    useAppStore.getState().set({
      me: { ...acc('u1', 'jaebin'), isAdmin: true, status: 'away', statusText: '점심' },
    });
    mount();

    const mark = within(screen.getByTestId('me-row')).getByTestId('status-u1');
    expect(mark.getAttribute('data-status')).toBe('away');
    expect(mark.textContent).toContain('점심');
  });

  it('메뉴 머리가 이름 · @handle · 어느 워크스페이스인지를 말한다', () => {
    /*
      문서: "지금 앱은 내가 어느 워크스페이스에 있는지 어디서도 말하지 않는다 — 타이틀바의
      `murmur` 는 앱 이름이지 워크스페이스가 아니다." 이 단언이 그 사실을 처음으로 화면에
      세운다.
    */
    fakeController();
    const { activeId } = useCommunityRegistry.getState();
    useCommunityRegistry.getState().setLabel(activeId, 'Rebellions');
    mount();

    fireEvent.click(screen.getByTestId('me-row'));
    const menu = screen.getByRole('menu');
    expect(menu.textContent).toContain('@jaebin');
    expect(menu.textContent).toContain('Rebellions');
  });

  it('메뉴 머리는 항목이 아니다 — 눌리지도 화살표에 걸리지도 않는다', () => {
    // 머리는 읽는 것이지 고르는 것이 아니다. `role="menuitem"` 이 되면 ↑/↓ 가 거기서
    // 한 번 멈추고, 사람은 눌러 볼 이유가 없는 곳에서 Enter 를 시험하게 된다.
    fakeController();
    mount();

    fireEvent.click(screen.getByTestId('me-row'));
    const names = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(names).toEqual(['내 프로필', '상태 바꾸기', 'Settings⌘,', 'Sign out']);
  });

  it('메뉴에 아이콘을 두지 않는다 — 오른쪽 `⌘,` 만 남는다', () => {
    /*
      문서: "한 줄짜리 항목들에 붙는 12px 글리프는 정보가 아니라 장식이다. 오른쪽 `⌘,` 만
      남는데 그건 가르치는 정보다."

      `aria-hidden` 인 요소를 세어 잠근다 — 장식은 접근성 트리에서 빠지므로, 항목 안에
      숨겨진 요소가 하나(그 `⌘,`)를 넘으면 장식이 다시 들어온 것이다.
    */
    fakeController();
    mount();

    fireEvent.click(screen.getByTestId('me-row'));
    const hidden = screen.getAllByRole('menuitem')
      .flatMap((el) => [...el.querySelectorAll('[aria-hidden="true"]')].map((h) => h.textContent));
    expect(hidden).toEqual(['⌘,']);
  });

  it('`설정` 옆의 `⌘,` 가 참이다 — 그 단축키가 실제로 설정을 연다', () => {
    /*
      메뉴는 단축키를 가르치는 자리다. 가르치는 정보가 거짓이면 장식보다 나쁘다 —
      한 번 속으면 다음부터 메뉴의 오른쪽 글자를 아무도 안 믿는다.
      **이 단축키는 이번에 새로 생겼다**: 이전에는 `⌘K`·`⌘[`·`⌘]`·`⌘\` 넷뿐이었다.
    */
    fakeController();
    const onOpenSettings = vi.fn();
    mount({ onOpenSettings });

    fireEvent.keyDown(document, { key: ',', metaKey: true });
    expect(onOpenSettings).toHaveBeenCalledWith();
  });

  it('입력 중에는 `⌘,` 를 가로채지 않는다', () => {
    // 쉼표는 사람이 실제로 타이핑하는 글자다. 컴포저에서 `⌘,` 가 설정을 열면 쓰던 말이
    // 화면 뒤로 사라진다.
    fakeController();
    const onOpenSettings = vi.fn();
    mount({ onOpenSettings });

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: ',', metaKey: true });
    expect(onOpenSettings).not.toHaveBeenCalled();
    input.remove();
  });

  it('내 프로필이 메뉴의 첫 항목이다 — 아바타를 눌러도 여기로 온다', () => {
    /*
      문서: "다른 곳에서는 아바타를 누르면 프로필이 열리지만 여기서만 예외다. 내 프로필은
      메뉴의 첫 항목이다." 아바타가 트리거 버튼 **안**이라 아바타 클릭도 같은 메뉴를 연다 —
      같은 줄의 왼쪽·오른쪽이 서로 다른 곳으로 가면 어느 쪽을 눌렀는지 매번 신경 써야 한다.
    */
    fakeController();
    const onOpenSettings = vi.fn();
    mount({ onOpenSettings });

    const avatar = within(screen.getByTestId('me-row')).getByText('J');
    fireEvent.click(avatar);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: '내 프로필' }));
    expect(onOpenSettings).toHaveBeenCalledWith('profile');
  });

  it('상태는 메뉴 안의 **동작**이다 — 실제로 바꿀 수 있다', () => {
    /*
      문서: "지금은 바꿀 수 없는 글자인데, 메뉴로 옮기면 실제로 바꿀 수 있는 것이 된다."
      그러므로 이 테스트는 패널이 뜨는 것에서 멈추지 않고 **서버 호출까지** 간다.
    */
    const c = fakeController();
    mount();

    fireEvent.click(screen.getByTestId('me-row'));
    expect(screen.queryByTestId('status-picker')).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: '상태 바꾸기' }));
    expect(screen.getByTestId('status-picker')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('status-picker')).getByText('자리 비움'));
    expect(c.setStatus).toHaveBeenCalledWith('away', undefined);
  });

  it('상태 패널은 아무것도 안 바꾸고 나올 수 있다', () => {
    /*
      여는 손잡이를 메뉴로 옮기면서 **닫는 손잡이를 같이 옮겨야** 한다 — 예전에는 트리거를
      다시 눌러 닫았는데 그 트리거가 없어졌다. 나갈 길이 "상태를 하나 고르는 것"뿐이면
      들여다보기만 하려던 사람이 상태를 바꾸게 된다.
    */
    const c = fakeController();
    mount();

    fireEvent.click(screen.getByTestId('me-row'));
    fireEvent.click(screen.getByRole('menuitem', { name: '상태 바꾸기' }));

    fireEvent.keyDown(screen.getByTestId('status-picker'), { key: 'Escape' });
    expect(screen.queryByTestId('status-picker')).toBeNull();
    expect(c.setStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('me-row'));
    fireEvent.click(screen.getByRole('menuitem', { name: '상태 바꾸기' }));
    fireEvent.click(within(screen.getByTestId('status-picker')).getByText('닫기'));
    expect(screen.queryByTestId('status-picker')).toBeNull();
    expect(c.setStatus).not.toHaveBeenCalled();
  });
});

describe('A2 · `+` 는 그 목록의 첫 칸에 산다', () => {
  it('`+ Add or edit agents` 가 nav 에서 사라졌다', () => {
    /*
      문서: "이동 사이에 설정이 끼어 있었다. 설정으로 가는 길은 A1 의 메뉴가 갖는다."
      Inbox·Saved·Directory 는 *이동*이고 그 한 줄만 *설정*이었다.
    */
    fakeController();
    mount();

    expect(screen.queryByText(/Add or edit agents/)).toBeNull();
    /*
      이동 묶음은 그대로 있다 — 설정 한 줄을 뺀 것이지 묶음을 지운 것이 아니다.

      **`Saved` 는 이제 여기 없다**(레일 문서): *"북마크는 레일에만 둔다 — 자기 칸이 있는데
      홈에도 한 줄을 세우면 같은 것으로 가는 길이 둘이 되고, 그때부터 사람은 어느 쪽이
      맞는지 매번 고른다."* 그래서 `nav` 안에서 찾아 없음을 확인하고, 레일에 그 칸이
      **있다**는 것을 함께 잰다 — 뺀 것과 잃은 것을 구별하는 단언이다.
    */
    const nav = screen.getByRole('navigation', { name: '주 목록' });
    const sidebarNav = document.querySelector('aside nav')!;
    expect(within(sidebarNav as HTMLElement).getByText('Inbox')).toBeTruthy();
    expect(within(sidebarNav as HTMLElement).getByText('Directory')).toBeTruthy();
    expect(within(sidebarNav as HTMLElement).queryByText('Saved')).toBeNull();
    expect(within(nav).getByTestId('rail-saved')).toBeTruthy();
  });

  it('채널의 `+` 가 목록의 **첫 칸**이다 — 끝이 아니라', () => {
    /*
      예전에는 채널 목록 끝이라 채널이 스무 개면 스크롤 끝까지 내려가야 닿았고, 보관·숨김
      묶음이 그 아래 또 붙어 자리가 계속 밀렸다. `AgentGrid` 의 `+` 카드가 이미 세운 규칙이다.
    */
    fakeController();
    useAppStore.getState().set({ channels: [chan('c1', 'ay'), chan('c2', 'zed')] });
    mount();

    const add = screen.getByTestId('add-channel');
    const first = screen.getAllByRole('button').find((b) => (b.textContent ?? '').startsWith('#'))!;
    // DOM 순서로 `+` 가 첫 채널보다 앞이다.
    expect(add.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('DM 의 `+` 도 같은 모양·같은 자리다', () => {
    /*
      예전에는 섹션 머리 오른쪽 끝의 작은 버튼이라 채널의 `+` 와 모양도 자리도 달랐다.
      **같은 클래스**를 쓰는 것으로 "같은 모양"을 잠근다 — 한쪽만 손대면 여기서 갈라진다.
    */
    fakeController();
    useAppStore.getState().set({ dms: [{ id: 'd1', memberIds: ['u1', 'u2'], lastMessageAt: null }] });
    // 두 `+` 가 서로 다른 칸에 살게 됐다 — 비교하려면 두 칸을 함께 세운다(위 주석).
    mountBothPanels();

    const addChannel = screen.getByTestId('add-channel');
    const addDm = screen.getByTestId('add-dm');
    expect(addDm.className).toBe(addChannel.className);
  });

  it('`+` 는 접근성 이름에 들어가지 않는다', () => {
    // 스크린리더가 "플러스 새 채널"로 읽으면 글리프가 이름의 일부가 된다. 이름은 `label` 이
    // 지고, `+` 는 눈에만 보인다.
    fakeController();
    mountBothPanels();

    expect(screen.getByRole('button', { name: 'Create channel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
  });

  it('admin 이 아니면 채널 `+` 는 없고 DM `+` 는 남는다', () => {
    // POST /channels 는 admin 전용이라 없는 것을 있다고 표시하지 않는다(#97). DM 은
    // 누구나 열 수 있으므로 그 `+` 는 자리를 지킨다 — 자리를 옮겼다고 권한이 바뀌지 않는다.
    fakeController();
    useAppStore.getState().set({ me: { ...acc('u1', 'jaebin'), isAdmin: false } });
    mountBothPanels();

    expect(screen.queryByTestId('add-channel')).toBeNull();
    expect(screen.getByTestId('add-dm')).toBeTruthy();
  });
});

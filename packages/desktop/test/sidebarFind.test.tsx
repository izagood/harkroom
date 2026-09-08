import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { Workspace } from '../src/components/Workspace';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan, fakeApi } from './helpers/fakeApi';

/**
 * 찾기가 사이드바 맨 위로 온다(정본 문서 `docs/desktop-remaining-gaps.html` 「A · 찾기가
 * 맨 위로」).
 *
 * 문서의 요구는 두 문장이고 **둘 다 재야 한다**:
 *
 * 1. *"사이드바에서도 찾기가 먼저다"* — 자리. 목록보다 **위**이고, 목록이 길어져도
 *    스크롤 밖으로 나가지 않는다(에이전트 설정의 `sticky` 검색줄과 같은 근거, #479).
 * 2. *"채널·사람·에이전트가 한 입력으로 걸린다"* — 범위. 세 종류가 **한 입력**에
 *    걸려야 하고, 그래서 이 줄은 레일이 고른 칸과 **무관하게** 서 있어야 한다.
 *    한 칸에만 있으면 DM 칸에서 채널을 찾으려고 홈으로 돌아가야 하고, 그 순간
 *    "한 입력으로" 가 깨진다.
 *
 * 그리고 문서가 결함으로 적은 것이 사라져야 한다 — *"지금은 `CHANNELS` 라벨 옆 10px
 * 돋보기 하나다."* 그 돋보기가 남아 있으면 사이드바에서 찾기를 시작하는 자리가 둘이 되고,
 * 문서가 북마크에서 이미 판정한 결함(*"같은 것으로 가는 길이 둘이 되고, 그때부터 사람은
 * 어느 쪽이 맞는지 매번 고른다"*)을 찾기에서 되풀이한다.
 */

const fakeController = () => {
  const c = {
    api: fakeApi(),
    openChannel: vi.fn().mockResolvedValue(undefined),
    openThread: vi.fn(),
    closeThread: vi.fn(),
    startDm: vi.fn(),
    logout: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(),
    toggleChannelStar: vi.fn(),
    archiveChannel: vi.fn(),
    notifyTyping: vi.fn(),
    refreshAccounts: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    loadOlder: vi.fn(),
    goBack: vi.fn().mockResolvedValue(false),
    goForward: vi.fn().mockResolvedValue(false),
  };
  setController(c as unknown as Controller);
  return c;
};

const sidebarProps = {
  onOpenDirectory: () => {},
  /* 이 prop 은 남는다 — 옮겨진 것은 그것을 **부르는 자리**뿐이다(10px 돋보기 → 찾기 줄). */
  onOpenChannelDirectory: () => {},
  onOpenInbox: () => {},
  collapsed: false,
  onToggleCollapse: () => {},
};

/**
 * 사람·에이전트가 **둘 다** 있고 채널도 둘 있는 상태. 세 종류를 한 입력으로 거는지 보려면
 * 세 종류가 실제로 있어야 한다.
 */
const setup = () => {
  useAppStore.getState().set({
    me: acc('u1', 'admin', 'human', true),
    accounts: {
      u1: acc('u1', 'admin', 'human', true),
      u2: acc('u2', 'deploybot', 'agent'),
      u3: acc('u3', 'deborah'),
    },
    channels: [chan('c1', 'general'), chan('c2', 'deploy-notes')],
    dms: [],
    unread: [],
    online: [],
    connected: true,
    activeChannelId: 'c1',
  });
};

const typeFind = (value: string) => {
  fireEvent.change(screen.getByTestId('sidebar-find'), { target: { value } });
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 사이드바의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(#619 가 대기 사슬에서
// 세운 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면
// 한국어라고 말해야 한다 — 그리고 그렇게 적어 두면 이 축들이 무엇을 재는지가 오히려
// 또렷해진다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  usePrefsStore.getState().setLocale('ko');
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('찾기가 사이드바 맨 위로 (A · 찾기가 맨 위로)', () => {
  describe('1. 자리 — 목록보다 위, 칸과 무관', () => {
    it('접근 가능한 이름이 있는 입력이다 — 키보드로 닿고 스크린리더가 읽는다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      // 이름이 없는 입력은 스크린리더에게 "빈 텍스트 상자" 다.
      expect(screen.getByLabelText('찾기')).toBe(screen.getByTestId('sidebar-find'));
    });

    it('세 칸 모두에 있다 — 한 칸에만 있으면 다른 칸에서 찾으려고 홈으로 돌아가야 한다', () => {
      fakeController();
      setup();
      for (const panel of ['home', 'dm', 'agents'] as const) {
        cleanup();
        render(<Sidebar panel={panel} {...sidebarProps} />);
        expect(
          screen.queryByTestId('sidebar-find'),
          `${panel} 칸에 찾기가 없다 — 문서의 "한 입력으로" 가 깨진다`,
        ).toBeTruthy();
      }
    });

    it('스크롤하는 목록 밖에 있다 — 목록이 길어져도 찾기가 밀려나지 않는다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      const nav = screen.getByRole('navigation', { name: '채널 목록' });
      // `nav` 가 `overflow-y-auto` 인 그 상자다(`Sidebar` 의 주석). 그 안에 있으면
      // 채널이 서른일 때 찾기가 스크롤 위로 사라진다 — #479 가 에이전트 설정에서
      // 고친 것과 같은 결함이다.
      expect(
        nav.contains(screen.getByTestId('sidebar-find')),
        '찾기가 스크롤 상자 안에 있다',
      ).toBe(false);
    });

    it('목록보다 앞에 선다 — DOM 순서가 곧 위아래다(jsdom 에 레이아웃이 없다)', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      const find = screen.getByTestId('sidebar-find');
      const nav = screen.getByRole('navigation', { name: '채널 목록' });
      expect(
        find.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
        '찾기가 목록보다 뒤에 있다',
      ).toBeTruthy();
    });
  });

  describe('2. 범위 — 채널·사람·에이전트가 한 입력으로', () => {
    it('한 번 친 글자가 채널·사람·에이전트 셋을 동시에 건다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);

      // `deploy` 는 채널 `deploy-notes` 와 에이전트 `@deploybot` 에 걸린다.
      typeFind('de');
      const results = screen.getByTestId('sidebar-find-results');
      const text = results.textContent ?? '';
      expect(text, '채널이 안 걸렸다').toContain('deploy-notes');
      expect(text, '에이전트가 안 걸렸다').toContain('deploybot');
      expect(text, '사람이 안 걸렸다').toContain('deborah');
    });

    it('결과가 종류를 말한다 — 같은 글자로 걸린 셋을 구별할 수 있어야 한다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      typeFind('de');
      const results = screen.getByTestId('sidebar-find-results');
      expect(within(results).getByText('채널')).toBeTruthy();
      expect(within(results).getByText('에이전트')).toBeTruthy();
      expect(within(results).getByText('사람')).toBeTruthy();
    });

    it('나 자신은 결과에 없다 — 나에게 DM 을 걸 일이 없다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      typeFind('admin');
      expect(screen.getByTestId('sidebar-find-results').textContent ?? '').not.toContain('admin');
    });

    it('비어 있으면 결과를 그리지 않는다 — 평소에는 한 줄뿐이다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      expect(screen.queryByTestId('sidebar-find-results')).toBeNull();
    });

    it('아무것도 안 걸리면 비었다고 말한다 — 빈 상자와 구별된다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      typeFind('zzzzz');
      expect(screen.getByTestId('sidebar-find-results').textContent ?? '')
        .toContain('찾는 것이 없다');
    });

    it('DM 칸에서 쳐도 채널이 걸린다 — 칸을 옮기지 않고 찾는 것이 이 줄의 값이다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="dm" {...sidebarProps} />);
      typeFind('general');
      expect(screen.getByTestId('sidebar-find-results').textContent ?? '').toContain('general');
    });
  });

  describe('3. 고르면 그것이 열린다', () => {
    it('채널을 고르면 그 채널이 열린다', () => {
      const c = fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      typeFind('deploy-notes');
      fireEvent.click(screen.getByTestId('sidebar-find-channel-c2'));
      expect(c.openChannel).toHaveBeenCalledWith('c2');
    });

    it('사람·에이전트를 고르면 DM 이 열린다 — DM 목록이 사람과 에이전트를 안 가르는 것과 같은 규칙이다', () => {
      const c = fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);

      typeFind('deborah');
      fireEvent.click(screen.getByTestId('sidebar-find-account-u3'));
      expect(c.startDm).toHaveBeenCalledWith('u3');

      typeFind('deploybot');
      fireEvent.click(screen.getByTestId('sidebar-find-account-u2'));
      expect(c.startDm).toHaveBeenCalledWith('u2');
    });

    it('고르면 검색어가 비워진다 — 다음에 열었을 때 지난 결과가 남아 있지 않다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      typeFind('deploy-notes');
      fireEvent.click(screen.getByTestId('sidebar-find-channel-c2'));
      expect((screen.getByTestId('sidebar-find') as HTMLInputElement).value).toBe('');
      expect(screen.queryByTestId('sidebar-find-results')).toBeNull();
    });

    it('Escape 가 검색어를 비운다 — 결과를 걷는 유일한 길이 마우스여선 안 된다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      typeFind('de');
      fireEvent.keyDown(screen.getByTestId('sidebar-find'), { key: 'Escape' });
      expect((screen.getByTestId('sidebar-find') as HTMLInputElement).value).toBe('');
      expect(screen.queryByTestId('sidebar-find-results')).toBeNull();
    });
  });

  describe('4. 10px 돋보기가 사라진다 — 길이 둘이 되지 않는다', () => {
    it('`CHANNELS` 라벨 옆 돋보기 버튼이 없다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);
      // 문서가 결함으로 적은 그 버튼이다. 남겨 두면 사이드바에서 찾기를 시작하는
      // 자리가 둘이 된다.
      expect(screen.queryByRole('button', { name: '채널 찾기' })).toBeNull();
    });

    it('채널 디렉터리로 가는 길은 찾기 줄 안에 하나 있다 — 그리고 찾아본 뒤에만 선다', () => {
      fakeController();
      setup();
      render(<Sidebar panel="home" {...sidebarProps} />);

      // 평소에는 **없다.** 늘 세워 두면 그것이 사이드바의 두 번째 상시 찾기 컨트롤이 되어,
      // 방금 없앤 10px 돋보기를 이름만 바꿔 되살리는 셈이다.
      expect(
        screen.queryByTestId('sidebar-find-all-channels'),
        '찾아보기 전에도 디렉터리 문이 서 있다 — 상시 컨트롤이 둘이 된다',
      ).toBeNull();

      // 찾아본 **다음**에 선다: 디렉터리가 필요한 것은 이 줄에서 못 찾았을 때뿐이고,
      // 그때 이것은 두 번째 길이 아니라 **한 길 안의 다음 걸음**이다.
      typeFind('de');
      const find = screen.getByTestId('sidebar-find').closest('[data-testid="sidebar-find-row"]');
      expect(find).toBeTruthy();
      expect(within(find as HTMLElement).getByTestId('sidebar-find-all-channels')).toBeTruthy();
    });

    it('그 길이 채널 디렉터리를 실제로 연다 — Workspace 까지 배선돼 있다', async () => {
      fakeController();
      setup();
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      expect(screen.queryByRole('dialog', { name: '채널 디렉터리' })).toBeNull();
      typeFind('de');
      fireEvent.click(screen.getByTestId('sidebar-find-all-channels'));
      expect(await screen.findByRole('dialog', { name: '채널 디렉터리' })).toBeTruthy();
    });
  });

  describe('5. ⌘K 와 어긋나지 않는다', () => {
    it('이 줄은 ⌘K 팔레트를 열지 않는다 — 두 줄은 서로 다른 물음에 답한다', () => {
      fakeController();
      setup();
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      typeFind('de');
      // `SearchPalette` 는 **메시지 본문**을 서버에 물어보는 모달이고(`api.search`),
      // 이 줄은 스토어에 이미 있는 채널·사람·에이전트를 고르는 자리다. 이 줄에 글자를
      // 쳤다고 모달이 뜨면 사이드바가 가려져 방금 좁힌 목록을 못 본다.
      expect(screen.queryByRole('dialog', { name: '메시지 검색' })).toBeNull();
    });

    it('⌘K 는 그대로 메시지 팔레트를 연다 — 이 작업이 그 단축키를 빼앗지 않는다', () => {
      fakeController();
      setup();
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      fireEvent.keyDown(document, { key: 'k', metaKey: true });
      expect(screen.getByRole('dialog', { name: '메시지 검색' })).toBeTruthy();
    });

    it('찾기 줄에 포커스가 있으면 ⌘1 이 칸을 바꾸지 않는다 — 입력 예외가 이 줄에도 걸린다', () => {
      fakeController();
      setup();
      render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      fireEvent.click(screen.getByTestId('rail-dm'));
      expect(screen.getByTestId('rail-dm').getAttribute('aria-current')).toBe('page');

      const input = screen.getByTestId('sidebar-find');
      input.focus();
      // `Rail` 의 숫자 단축키는 입력 요소에 포커스가 있으면 가로채지 않는다. 이 줄은
      // `<input>` 이므로 그 예외가 그대로 걸린다 — 그렇지 않으면 채널 이름에 든 숫자를
      // 칠 때마다 칸이 튄다.
      fireEvent.keyDown(input, { key: '1', metaKey: true });
      expect(
        screen.getByTestId('rail-dm').getAttribute('aria-current'),
        '찾기에 숫자를 치다가 칸이 바뀌었다',
      ).toBe('page');
    });
  });
});

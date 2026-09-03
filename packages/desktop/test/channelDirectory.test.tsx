import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { ChannelRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { ChannelDirectory } from '../src/components/ChannelDirectory';
import { Sidebar } from '../src/components/Sidebar';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    openChannel: vi.fn().mockResolvedValue(undefined),
    startDm: vi.fn(),
    logout: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(),
    toggleChannelStar: vi.fn(),
    archiveChannel: vi.fn(),
  };
  setController(c as unknown as ControllerType);
  return c;
};

const sidebarProps = {
  onOpenDirectory: () => {},
  onOpenChannelDirectory: () => {},
  onOpenInbox: () => {},
  onOpenSaved: () => {},
  onLogout: () => {},
  onOpenSettings: () => {},
  collapsed: false,
  onToggleCollapse: () => {},
};

/** 목록에 그려진 채널 이름을 **DOM 순서 그대로** 읽는다. jsdom 에는 레이아웃이 없으니 이것이 순서다. */
const renderedNames = (scope: HTMLElement = document.body) =>
  within(scope).getAllByRole('listitem').map((li) => li.textContent ?? '');

beforeEach(() => {
  useAppStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('ChannelDirectory (#180)', () => {
  const setup = (channels: ChannelRow[]) => {
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin') },
      channels,
      dms: [],
      unread: [],
      online: [],
      connected: true,
    });
  };

  describe('1. 사이드바에 채널 찾기 버튼이 있고 누르면 모달이 뜬다', () => {
    it('사이드바 헤더에 채널 찾기 버튼이 있다', () => {
      fakeController();
      setup([chan('c1', 'general')]);
      render(<Sidebar {...sidebarProps} />);
      expect(screen.getByLabelText('채널 찾기')).toBeTruthy();
    });

    it('채널 찾기 버튼이 넘겨받은 콜백을 부른다', () => {
      const onOpenChannelDirectory = vi.fn();
      fakeController();
      setup([chan('c1', 'general')]);
      render(<Sidebar {...sidebarProps} onOpenChannelDirectory={onOpenChannelDirectory} />);
      fireEvent.click(screen.getByLabelText('채널 찾기'));
      expect(onOpenChannelDirectory).toHaveBeenCalled();
    });

    it('모달이 열리면 채널 목록이 보인다', () => {
      fakeController();
      setup([chan('c1', 'general'), chan('c2', 'dev')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);
      expect(screen.getByText('general')).toBeTruthy();
      expect(screen.getByText('dev')).toBeTruthy();
    });

    it('open 이 false 면 아무 것도 그리지 않는다', () => {
      fakeController();
      setup([chan('c1', 'general')]);
      render(<ChannelDirectory open={false} onClose={() => {}} />);
      expect(screen.queryByRole('dialog', { name: '채널 디렉터리' })).toBeNull();
    });
  });

  describe('2. 모달에 보이는 표준 채널이 전부 나열되고 DM 은 없다', () => {
    it('표준 채널만 표시되고 DM 은 표시되지 않는다', () => {
      fakeController();
      setup([
        chan('c1', 'general'),
        chan('c2', 'dev'),
        { ...chan('d1', 'dm-channel'), kind: 'dm' },
      ]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);
      expect(renderedNames().length).toBe(2);
      expect(screen.getByText('general')).toBeTruthy();
      expect(screen.getByText('dev')).toBeTruthy();
      expect(screen.queryByText('dm-channel')).toBeNull();
    });
  });

  describe('3. 이름 필터가 목록을 좁힌다', () => {
    it('검색어를 입력하면 해당 채널만 표시된다', () => {
      fakeController();
      setup([chan('c1', 'general'), chan('c2', 'development'), chan('c3', 'design')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      fireEvent.change(screen.getByPlaceholderText('채널 이름'), { target: { value: 'gen' } });

      expect(screen.getByText('general')).toBeTruthy();
      expect(screen.queryByText('development')).toBeNull();
      expect(screen.queryByText('design')).toBeNull();
    });

    it('검색어를 지우면 전체 목록이 다시 표시된다', () => {
      fakeController();
      setup([chan('c1', 'general'), chan('c2', 'development')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      const input = screen.getByPlaceholderText('채널 이름');
      fireEvent.change(input, { target: { value: 'gen' } });
      expect(screen.queryByText('development')).toBeNull();

      fireEvent.change(input, { target: { value: '' } });
      expect(screen.getByText('general')).toBeTruthy();
      expect(screen.getByText('development')).toBeTruthy();
    });

    it('필터는 보관 그룹에도 걸린다', () => {
      fakeController();
      setup([
        chan('c1', 'general'),
        { ...chan('c2', 'general-old'), archivedAt: '2024-06-01T00:00:00.000Z' },
        { ...chan('c3', 'design-old'), archivedAt: '2024-06-01T00:00:00.000Z' },
      ]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      fireEvent.change(screen.getByPlaceholderText('채널 이름'), { target: { value: 'general' } });
      // 보관 두 개 중 이름이 맞는 하나만 센다.
      expect(screen.getByText(/보관됨 \(1\)/)).toBeTruthy();
      fireEvent.click(screen.getByText(/보관됨 \(1\)/));
      expect(screen.getByText('general-old')).toBeTruthy();
      expect(screen.queryByText('design-old')).toBeNull();
    });
  });

  /**
   * 정렬. **두 모드 다 DOM 순서로 단언한다.** "생성순은 서버가 준 순서를 그대로 둔다" 로
   * 넘기면 안 된다: `listChannels` 가 `order by name` 이라 그 순서는 이미 이름순이고,
   * 그러면 토글이 죽어 있어도 아무 테스트가 실패하지 않는다. 그래서 fixture 는 이름 순서와
   * 생성 순서가 **정반대**가 되도록 짠다 — 어느 한 모드가 동작을 안 하면 즉시 빨강이다.
   */
  describe('4. 정렬 토글이 이름순 ↔ 생성순으로 바뀐다', () => {
    const reversed = () => [
      { ...chan('c1', 'zulu'), createdAt: '2024-01-01T00:00:00.000Z' },
      { ...chan('c2', 'alpha'), createdAt: '2024-03-01T00:00:00.000Z' },
      { ...chan('c3', 'mike'), createdAt: '2024-02-01T00:00:00.000Z' },
    ];

    it('기본은 이름순이다', () => {
      fakeController();
      setup(reversed());
      render(<ChannelDirectory open={true} onClose={() => {}} />);
      expect(renderedNames().map((t) => t.replace('#', ''))).toEqual(['alpha', 'mike', 'zulu']);
      expect(screen.getByRole('button', { name: '이름순' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('생성순을 누르면 오래된 것부터 세운다 — 이름순과 다른 순서다', () => {
      fakeController();
      setup(reversed());
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      fireEvent.click(screen.getByRole('button', { name: '생성순' }));

      expect(renderedNames().map((t) => t.replace('#', ''))).toEqual(['zulu', 'mike', 'alpha']);
      expect(screen.getByRole('button', { name: '생성순' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('이름순으로 되돌리면 순서가 되돌아온다', () => {
      fakeController();
      setup(reversed());
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      fireEvent.click(screen.getByRole('button', { name: '생성순' }));
      expect(renderedNames().map((t) => t.replace('#', ''))).toEqual(['zulu', 'mike', 'alpha']);

      fireEvent.click(screen.getByRole('button', { name: '이름순' }));
      expect(renderedNames().map((t) => t.replace('#', ''))).toEqual(['alpha', 'mike', 'zulu']);
    });

    it('스토어가 준 순서에 기대지 않는다 — 이름순은 스토어 순서를 뒤집어도 같다', () => {
      fakeController();
      setup([...reversed()].reverse());
      render(<ChannelDirectory open={true} onClose={() => {}} />);
      expect(renderedNames().map((t) => t.replace('#', ''))).toEqual(['alpha', 'mike', 'zulu']);
    });
  });

  describe('5. 보관 채널은 기본으로 접혀 있고 펼치면 보인다', () => {
    const withArchived = () => [
      chan('c1', 'general'),
      { ...chan('c2', 'archived-channel'), archivedAt: '2024-01-01T00:00:00.000Z' },
    ];

    it('보관된 채널은 본 목록에 섞이지 않고 기본으로 접혀 있다', () => {
      fakeController();
      setup(withArchived());
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      // 접혀 있으니 이름은 아직 없고, 본 목록에는 살아 있는 채널 하나만 있다.
      expect(screen.queryByText('archived-channel')).toBeNull();
      expect(renderedNames().map((t) => t.replace('#', ''))).toEqual(['general']);
      expect(screen.getByText(/보관됨 \(1\)/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /보관됨/ }).getAttribute('aria-expanded')).toBe('false');
    });

    it('보관됨 버튼을 누르면 보관 채널이 표시된다', () => {
      fakeController();
      setup(withArchived());
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      fireEvent.click(screen.getByText(/보관됨 \(1\)/));

      expect(screen.getByText('archived-channel')).toBeTruthy();
      expect(screen.getByRole('button', { name: /보관됨/ }).getAttribute('aria-expanded')).toBe('true');
    });

    it('보관된 채널이 없으면 그룹 자체가 없다', () => {
      fakeController();
      setup([chan('c1', 'general')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);
      expect(screen.queryByText(/보관됨/)).toBeNull();
    });
  });

  describe('6. 행 클릭이 그 채널을 열고 모달을 닫는다', () => {
    it('채널 행을 클릭하면 openChannel 이 불리고 모달이 닫힌다', async () => {
      const c = fakeController();
      const onClose = vi.fn();
      setup([chan('c1', 'general')]);

      render(<ChannelDirectory open={true} onClose={onClose} />);
      fireEvent.click(screen.getByTestId('channel-row-c1'));

      await waitFor(() => expect(c.openChannel).toHaveBeenCalledWith('c1'));
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('비공개 채널 표시', () => {
    it('비공개 채널에는 자물쇠가, 공개 채널에는 없다', () => {
      fakeController();
      setup([chan('c1', 'general', null, 'public'), chan('c2', 'secret', null, 'private')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      expect(screen.getByTestId('channel-row-c2').innerHTML).toContain('🔒');
      expect(screen.getByTestId('channel-row-c1').innerHTML).not.toContain('🔒');
    });
  });

  describe('생성 진입점은 모달에 없다', () => {
    it('모달 안에 채널 만들기 수단이 없다 — 사이드바에만 둔다', () => {
      fakeController();
      setup([chan('c1', 'general')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);
      const dialog = screen.getByRole('dialog', { name: '채널 디렉터리' });
      expect(within(dialog).queryByText(/Create channel/i)).toBeNull();
    });
  });
});

/**
 * 배선. 위의 것들은 `ChannelDirectory` 와 `Sidebar` 를 따로 띄우고 prop 을 **손으로** 넘긴다 —
 * 그 상태로는 `Workspace` 가 두 조각을 잇는 것을 잊어도 전부 초록이다(눌러도 아무 일이 없는
 * 버튼이 앱에 남는다). 그래서 여기서는 `Workspace` 를 통째로 띄우고 진짜 `Controller` 를 쓴다:
 * 사이드바 버튼 → 모달 → 행 클릭 → 채널이 실제로 열리고 모달이 닫히는 한 줄을 끝까지 본다.
 */
describe('채널 디렉터리 — Workspace 배선 (#180)', () => {
  const realController = () => {
    const api = fakeApi({
      channels: vi.fn(async () => [chan('c1', 'general'), chan('c2', 'design')]),
      messages: vi.fn(async () => ({ messages: [msg('m1', 'c2', 1, '디자인 채널 본문')], hasMore: false })),
    });
    const c = new Controller(api);
    setController(c);
    return { c, api };
  };

  beforeEach(() => {
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin') },
      channels: [chan('c1', 'general'), chan('c2', 'design')],
      dms: [],
      unread: [],
      online: [],
      connected: true,
      activeChannelId: 'c1',
    });
  });

  it('사이드바 버튼이 모달을 열고, 행을 누르면 그 채널이 열리며 모달이 닫힌다', async () => {
    const { api } = realController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    // 처음에는 모달이 없다.
    expect(screen.queryByRole('dialog', { name: '채널 디렉터리' })).toBeNull();

    fireEvent.click(screen.getByLabelText('채널 찾기'));
    const dialog = await screen.findByRole('dialog', { name: '채널 디렉터리' });

    fireEvent.click(within(dialog).getByTestId('channel-row-c2'));

    // 배선이 끊겨 있으면 여기서 실패한다 — 요청이 나가고, 스토어의 활성 채널이 바뀌고,
    // 모달이 사라지는 세 가지를 모두 본다.
    await waitFor(() => expect(api.messages).toHaveBeenCalledWith('c2', { since: 0 }));
    await waitFor(() => expect(useAppStore.getState().activeChannelId).toBe('c2'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '채널 디렉터리' })).toBeNull());
  });

  it('닫기 버튼으로도 닫힌다 — 채널은 그대로다', async () => {
    realController();
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('채널 찾기'));
    await screen.findByRole('dialog', { name: '채널 디렉터리' });

    fireEvent.click(screen.getByLabelText('채널 디렉터리 닫기'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '채널 디렉터리' })).toBeNull());
    expect(useAppStore.getState().activeChannelId).toBe('c1');
  });
});

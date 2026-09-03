import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelDirectory } from '../src/components/ChannelDirectory';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan } from './helpers/fakeApi';

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
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('ChannelDirectory', () => {
  const setup = (channels: ReturnType<typeof chan>[]) => {
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
      render(
        <Sidebar
          onOpenDirectory={() => {}}
          onOpenChannelDirectory={() => {}}
          onOpenInbox={() => {}}
          onLogout={() => {}}
          onOpenSettings={() => {}}
          collapsed={false}
          onToggleCollapse={() => {}}
        />,
      );
      expect(screen.getByLabelText('채널 찾기')).toBeTruthy();
    });

    it('채널 찾기 버튼을 누르면 모달이 열린다', () => {
      const onOpenChannelDirectory = vi.fn();
      fakeController();
      setup([chan('c1', 'general')]);
      render(
        <Sidebar
          onOpenDirectory={() => {}}
          onOpenChannelDirectory={onOpenChannelDirectory}
          onOpenInbox={() => {}}
          onLogout={() => {}}
          onOpenSettings={() => {}}
          collapsed={false}
          onToggleCollapse={() => {}}
        />,
      );
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
  });

  describe('2. 모달에 보이는 표준 채널이 전부 나열되고 DM 은 없다', () => {
    it('표준 채널만 표시되고 DM 은 표시되지 않는다', () => {
      fakeController();
      useAppStore.getState().set({
        me: acc('u1', 'admin'),
        accounts: { u1: acc('u1', 'admin') },
        channels: [
          chan('c1', 'general'),
          chan('c2', 'dev'),
          { id: 'd1', name: 'dm-channel', topic: '', kind: 'dm' as const, repo: null, archivedAt: null, visibility: 'public' as const },
        ],
        dms: [],
        unread: [],
        online: [],
        connected: true,
      });
      render(<ChannelDirectory open={true} onClose={() => {}} />);
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

      const input = screen.getByPlaceholderText('채널 이름');
      fireEvent.change(input, { target: { value: 'gen' } });

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
  });

  describe('4. 정렬 토글이 이름순 ↔ 생성순으로 바뀐다', () => {
    it('이름순 정렬 시 알파벳 순으로 정렬된다', () => {
      fakeController();
      setup([chan('c1', 'zulu'), chan('c2', 'alpha'), chan('c3', 'mike')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      const buttons = screen.getAllByRole('button', { name: /이름순|생성순/ });
      const nameSortBtn = buttons.find(b => b.textContent === '이름순');
      fireEvent.click(nameSortBtn!);

      const list = screen.getAllByRole('listitem');
      const names = list.map(li => li.textContent);
      expect(names.join('')).toContain('alpha');
      expect(names.join('')).toContain('mike');
      expect(names.join('')).toContain('zulu');
      const alphaIdx = names.findIndex(n => n.includes('alpha'));
      const mikeIdx = names.findIndex(n => n.includes('mike'));
      const zuluIdx = names.findIndex(n => n.includes('zulu'));
      expect(alphaIdx).toBeLessThan(mikeIdx);
      expect(mikeIdx).toBeLessThan(zuluIdx);
    });

    it('생성순 정렬 시 서버에서 온 순서대로 표시된다', () => {
      fakeController();
      setup([chan('c1', 'zulu'), chan('c2', 'alpha'), chan('c3', 'mike')]);
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      const buttons = screen.getAllByRole('button', { name: /이름순|생성순/ });
      const creationSortBtn = buttons.find(b => b.textContent === '생성순');
      fireEvent.click(creationSortBtn!);

      const listItems = screen.getAllByRole('listitem');
      expect(listItems.length).toBe(3);
    });
  });

  describe('5. 보관 채널은 기본으로 접혀 있고 펼치면 보인다', () => {
    it('보관된 채널은 기본으로 접혀 있다', () => {
      fakeController();
      useAppStore.getState().set({
        me: acc('u1', 'admin'),
        accounts: { u1: acc('u1', 'admin') },
        channels: [
          chan('c1', 'general'),
          { id: 'c2', name: 'archived-channel', topic: '', kind: 'standard', repo: null, archivedAt: '2024-01-01', visibility: 'public' },
        ],
        dms: [],
        unread: [],
        online: [],
        connected: true,
      });
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      expect(screen.queryByText('archived-channel')).toBeNull();
      expect(screen.getByText(/보관됨 \(1\)/)).toBeTruthy();
    });

    it('보관됨 버튼을 누르면 보관 채널이 표시된다', () => {
      fakeController();
      useAppStore.getState().set({
        me: acc('u1', 'admin'),
        accounts: { u1: acc('u1', 'admin') },
        channels: [
          chan('c1', 'general'),
          { id: 'c2', name: 'archived-channel', topic: '', kind: 'standard', repo: null, archivedAt: '2024-01-01', visibility: 'public' },
        ],
        dms: [],
        unread: [],
        online: [],
        connected: true,
      });
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      const archivedButton = screen.getByText(/보관됨 \(1\)/);
      fireEvent.click(archivedButton);

      expect(screen.getByText('archived-channel')).toBeTruthy();
    });
  });

  describe('6. 행 클릭이 그 채널을 열고 모달을 닫는다', () => {
    it('채널 행을 클릭하면 openChannel 이 불리고 모달이 닫힌다', async () => {
      const c = fakeController();
      const onClose = vi.fn();
      setup([chan('c1', 'general')]);

      render(<ChannelDirectory open={true} onClose={onClose} />);

      const channelButton = screen.getByTestId('channel-row-c1');
      fireEvent.click(channelButton);

      await waitFor(() => {
        expect(c.openChannel).toHaveBeenCalledWith('c1');
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('비공개 채널 표시', () => {
    it('비공개 채널에는 자물쇠 아이콘이 표시된다', () => {
      fakeController();
      useAppStore.getState().set({
        me: acc('u1', 'admin'),
        accounts: { u1: acc('u1', 'admin') },
        channels: [
          chan('c1', 'general', null, 'public'),
          chan('c2', 'secret', null, 'private'),
        ],
        dms: [],
        unread: [],
        online: [],
        connected: true,
      });
      render(<ChannelDirectory open={true} onClose={() => {}} />);

      const privateChannel = screen.getByTestId('channel-row-c2');
      expect(privateChannel.innerHTML).toContain('🔒');
    });
  });
});
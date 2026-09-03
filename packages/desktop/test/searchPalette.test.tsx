import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, getController, type Controller } from '../src/state/controller';
import { SearchPalette } from '../src/components/SearchPalette';
import { acc, chan, msg, fakeApi } from './helpers/fakeApi';

let mockController: ReturnType<typeof vi.fn> & { openChannel: ReturnType<typeof vi.fn>; openThread: ReturnType<typeof vi.fn>; api: ReturnType<typeof fakeApi> };

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    dms: [],
  });

  const api = fakeApi();
  mockController = {
    openChannel: vi.fn(),
    openThread: vi.fn(),
    api,
    logout: vi.fn(),
    startDm: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(),
    toggleChannelStar: vi.fn(),
    closeThread: vi.fn(),
    notifyTyping: vi.fn(),
    refreshAccounts: vi.fn(),
    upload: vi.fn(),
    send: vi.fn(),
    reply: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    toggleReaction: vi.fn(),
    fetchAttachment: vi.fn(),
    saveAttachment: vi.fn(),
    listAgents: vi.fn(),
    listPats: vi.fn(),
    updateAgent: vi.fn(),
    createAgent: vi.fn(),
    revokePat: vi.fn(),
    mintPat: vi.fn(),
    createInvite: vi.fn(),
    loadOlder: vi.fn(),
  } as unknown as typeof mockController & { openChannel: ReturnType<typeof vi.fn>; openThread: ReturnType<typeof vi.fn>; api: ReturnType<typeof fakeApi> };
  setController(mockController as unknown as Controller);
});

afterEach(() => {
  cleanup();
});

describe('SearchPalette', () => {
  it('단축키(외부)로 열고 Escape 로 닫는다', () => {
    const onClose = vi.fn();
    render(<SearchPalette open={true} onClose={onClose} />);

    expect(screen.getByLabelText('검색어 입력')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('질문을 넣으면 api.search 가 그 질문으로 불린다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'hello' } });

    await waitFor(() => {
      expect(mockController.api.search).toHaveBeenCalledWith('hello');
    }, { timeout: 1000 });
  });

  it('결과가 그려진다(작성자·본문·채널을 알 수 있다)', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      msg('m1', 'c1', 1, 'Hello world', 'u2'),
    ]);

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'hello' } });

    await waitFor(() => {
      expect(screen.getByText('@bot')).toBeTruthy();
      expect(screen.getByText('Hello world')).toBeTruthy();
      expect(screen.getByText('general')).toBeTruthy();
    }, { timeout: 1000 });
  });

  it('결과가 0건이면 "없다"가 보인다 — 빈 화면이 아니다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'nonexistent' } });

    await waitFor(() => {
      expect(screen.getByText('검색 결과가 없습니다')).toBeTruthy();
    }, { timeout: 1000 });
  });

  it('검색이 실패하면 사용자에게 오류가 보인다 — 조용히 삼키지 않는다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('서버 오류'));

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'error' } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText('서버 오류')).toBeTruthy();
    }, { timeout: 1000 });
  });

  it('결과를 누르면 openChannel 이 그 채널로 불린다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      msg('m1', 'c2', 1, 'Hello', 'u1'),
    ]);

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'hello' } });

    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeTruthy();
    }, { timeout: 1000 });

    const result = screen.getByText('Hello');
    fireEvent.click(result);

    await waitFor(() => {
      expect(mockController.openChannel).toHaveBeenCalledWith('c2');
    }, { timeout: 1000 });
  });

  it('스레드 답글 결과를 누르면 openThread 도 불린다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      msg('m2', 'c1', 2, 'reply', 'u1', { threadRootId: 'm1' }),
    ]);

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'reply' } });

    await waitFor(() => {
      expect(screen.getByText('스레드')).toBeTruthy();
    }, { timeout: 1000 });

    const result = screen.getByText('reply');
    fireEvent.click(result);

    await waitFor(() => {
      expect(mockController.openChannel).toHaveBeenCalledWith('c1');
      expect(mockController.openThread).toHaveBeenCalledWith('m1');
    }, { timeout: 1000 });
  });

  it('키보드로 결과를 이동·선택할 수 있다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      msg('m1', 'c1', 1, 'First', 'u1'),
      msg('m2', 'c1', 2, 'Second', 'u2'),
    ]);

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('First')).toBeTruthy();
      expect(screen.getByText('Second')).toBeTruthy();
    }, { timeout: 1000 });

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => {
      expect(mockController.openChannel).toHaveBeenCalledWith('c1');
    });
  });

  it('입력마다 서버를 때리지 않는다(디바운스)', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    vi.useFakeTimers();

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');

    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    await vi.runAllTimersAsync();

    vi.useRealTimers();

    expect(mockController.api.search).toHaveBeenCalledTimes(1);
    expect(mockController.api.search).toHaveBeenCalledWith('abc');
  });
});
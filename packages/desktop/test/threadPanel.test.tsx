import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

const fakeController = () => {
  const c = {
    reply: vi.fn(async () => undefined),
    closeThread: vi.fn(),
    openThread: vi.fn(),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  // 이 파일이 검증하는 것은 보냄 취소 창이 아니다(#223) — 창을 끄고 즉시 전송 경로를 본다.
  // 창 자체는 undoSend.test.tsx 가 단독으로 지킨다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    activeChannelId: 'c1',
    threadRootId: 'm1',
    messages: {
      c1: [
        msg('m1', 'c1', 1, 'root message', 'u1'),
        msg('m2', 'c1', 2, 'a reply', 'u2', { threadRootId: 'm1' }),
        msg('m3', 'c1', 3, 'unrelated', 'u1'),
      ],
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('ThreadPanel', () => {
  it('shows root and replies only, in seq order', () => {
    fakeController();
    render(<ThreadPanel />);
    expect(screen.getByText('root message')).toBeTruthy();
    expect(screen.getByText('a reply')).toBeTruthy();
    expect(screen.queryByText('unrelated')).toBeNull();
  });

  it('replies on Enter and closes on ×', () => {
    const c = fakeController();
    render(<ThreadPanel />);
    const box = screen.getByPlaceholderText('Reply…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'on it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.reply).toHaveBeenCalledWith('on it', [], 'c1', 'm1', false);
    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(c.closeThread).toHaveBeenCalled();
  });

  it('ignores whitespace-only input and keeps draft', () => {
    const c = fakeController();
    render(<ThreadPanel />);
    const box = screen.getByPlaceholderText('Reply…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.reply).not.toHaveBeenCalled();
    expect(box.value).toBe('   ');
  });

  it('restores draft when reply fails', async () => {
    const c = fakeController();
    c.reply.mockRejectedValueOnce(new Error('reply failed'));
    render(<ThreadPanel />);
    const box = screen.getByPlaceholderText('Reply…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'help me' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.reply).toHaveBeenCalledWith('help me', [], 'c1', 'm1', false);
    await waitFor(() => expect(box.value).toBe('help me'));
  });
});

describe('ThreadPanel sticky mentions', () => {
  const chips = () =>
    screen.queryAllByTestId('sticky-mention').map((el) => el.getAttribute('data-handle'));

  // 스레드도 각자의 대화다 — 앞 스레드에서 부른 상대가 다음 스레드에 따라오면 안 된다.
  it('does not carry the kept mentions into another thread', async () => {
    fakeController();
    render(<ThreadPanel />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '@bot 봐줘', selectionStart: 8 } });
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(chips()).toEqual(['bot']);

    useAppStore.getState().set({ threadRootId: 'm3' });

    await waitFor(() => expect(chips()).toEqual([]));
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';

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
    expect(c.reply).toHaveBeenCalledWith('on it');
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
    expect(c.reply).toHaveBeenCalledWith('help me');
    await waitFor(() => expect(box.value).toBe('help me'));
  });
});

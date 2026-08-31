import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = { send: vi.fn(), openThread: vi.fn() };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general', 'main-repo')],
    activeChannelId: 'c1',
    messages: {
      c1: [
        msg('m1', 'c1', 1, 'hello world', 'u2'),
        msg('m2', 'c1', 2, 'thread reply hidden', 'u1', { threadRootId: 'm1' }),
        msg('m3', 'c1', 3, 'system message text', 'u2', {
          kind: 'system', meta: { repo: 'main-repo', oid: 'i1', avcsType: 'intent' },
        }),
      ],
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('ChannelPane', () => {
  it('renders root messages only, resolves author handles', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.queryByText('thread reply hidden')).toBeNull();
    expect(screen.getAllByText('bot').length).toBeGreaterThan(0);
  });

  it('marks system messages with avcsType chip', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.getByText('intent')).toBeTruthy();
  });

  it('sends on Enter and clears composer', () => {
    const c = fakeController();
    render(<ChannelPane />);
    const box = screen.getByPlaceholderText('Message #general') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hi there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.send).toHaveBeenCalledWith('hi there');
    expect(box.value).toBe('');
  });

  it('opens a thread from a message', () => {
    const c = fakeController();
    render(<ChannelPane />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply in thread' })[0]!);
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });
});

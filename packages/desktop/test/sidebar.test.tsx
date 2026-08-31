import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan } from './helpers/fakeApi';

const fakeController = () => {
  const c = { openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn() };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'dev', 'main-repo')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'] }],
    unread: [
      { id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c2' },
      { id: 2, messageId: 'm2', reason: 'dm', readAt: null, channelId: 'd1' },
    ],
    online: ['u2'],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(() => {
  cleanup();
});

describe('Sidebar', () => {
  it('lists channels with unread badge and opens on click', () => {
    const c = fakeController();
    render(<Sidebar onLogout={vi.fn()} />);
    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.getByTestId('unread-c2').textContent).toBe('1');
    fireEvent.click(screen.getByText('dev'));
    expect(c.openChannel).toHaveBeenCalledWith('c2');
  });

  it('shows dm with peer handle, presence dot, unread badge', () => {
    fakeController();
    render(<Sidebar onLogout={vi.fn()} />);
    expect(screen.getByText('bot')).toBeTruthy();
    expect(screen.getByTestId('presence-d1').dataset.online).toBe('true');
    expect(screen.getByTestId('unread-d1').textContent).toBe('1');
  });

  it('starts a new dm from account picker', () => {
    const c = fakeController();
    render(<Sidebar onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    fireEvent.click(screen.getByRole('button', { name: /bot/ }));
    expect(c.startDm).toHaveBeenCalledWith('u2');
  });
});

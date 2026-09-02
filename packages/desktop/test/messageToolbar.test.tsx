import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

const withReplies = (count: number, rootId = 'm1'): MessageRow[] => {
  const messages: MessageRow[] = [msg('m1', 'c1', 1, 'root message', 'u2')];
  for (let i = 0; i < count; i++) {
    messages.push(msg(`r${i + 1}`, 'c1', i + 2, `reply ${i + 1}`, 'u1', { threadRootId: rootId }));
  }
  return messages;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    messages: { c1: [] },
  });
});
afterEach(() => cleanup());

describe('message toolbar', () => {
  it('shows reaction trigger in toolbar on hover for own message', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: /Add reaction|＋/ })).toBeTruthy();
  });

  it('shows thread trigger in toolbar on hover', () => {
    const c = fakeController();
    useAppStore.getState().set({ messages: { c1: withReplies(0) } });
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2')} />);

    const message = screen.getByText('root').closest('.group') as HTMLElement;
    fireEvent.mouseEnter(message);

    expect(within(message).getByRole('button', { name: 'Reply in thread' })).toBeTruthy();
  });

  it('shows overflow menu trigger on hover', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: 'More actions' })).toBeTruthy();
  });
});

describe('overflow menu permissions', () => {
  it('shows Edit and Delete in overflow menu for own message', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));

    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('shows only Delete in overflow menu for admin', () => {
    const c = fakeController();
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), u2: acc('u2', 'someone') },
    });
    render(<MessageItem message={msg('m1', 'c1', 1, '남의 메시지', 'u2')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));

    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('shows no Edit/Delete for non-admin on others message', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '남의 메시지', 'u2')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));

    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('shows no Edit/Delete for system message', () => {
    const c = fakeController();
    render(<MessageItem message={{ ...msg('m1', 'c1', 1, '시스템', 'u1'), kind: 'system' }} />);

    const moreActions = screen.queryByRole('button', { name: 'More actions' });
    expect(moreActions).toBeNull();
  });
});

describe('overflow menu actions', () => {
  it('opens edit mode when Edit is clicked', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '원문', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    expect(screen.getByDisplayValue('원문')).toBeTruthy();
  });

  it('shows confirmation state when Delete is clicked', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(screen.getByRole('button', { name: 'Really delete' })).toBeTruthy();
    expect(c.deleteMessage).not.toHaveBeenCalled();
  });

  it('requires second confirmation to delete', async () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Really delete' }));

    await waitFor(() => expect(c.deleteMessage).toHaveBeenCalledWith('m1'));
  });
});

describe('reply count visibility', () => {
  it('shows reply count without hover when replies exist', () => {
    const c = fakeController();
    useAppStore.getState().set({ messages: { c1: withReplies(2) } });
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2')} />);

    expect(screen.getByRole('button', { name: '2 replies' })).toBeTruthy();
  });

  it('shows Reply in thread on hover when no replies', () => {
    const c = fakeController();
    useAppStore.getState().set({ messages: { c1: [msg('m1', 'c1', 1, 'root', 'u2')] } });
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2')} />);

    const message = screen.getByText('root').closest('.group')!;
    fireEvent.mouseEnter(message);

    expect(screen.getByRole('button', { name: 'Reply in thread' })).toBeTruthy();
  });
});

describe('edit mode hides toolbar', () => {
  it('hides toolbar while editing', () => {
    const c = fakeController();
    useAppStore.getState().set({
      messages: { c1: [msg('m1', 'c1', 1, '원문', 'u1')] },
    });
    render(<MessageItem message={msg('m1', 'c1', 1, '원문', 'u1')} />);

    const toolbarBefore = screen.getByRole('group', { name: 'message toolbar' });
    expect(toolbarBefore).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    const toolbarAfter = screen.queryByRole('group', { name: 'message toolbar' });
    expect(toolbarAfter).toBeNull();
  });
});

describe('toolbar accessibility', () => {
  it('hides toolbar with opacity, not display:none or visibility:hidden', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    expect(toolbar.className).toMatch(/opacity-0/);
    expect(toolbar.className).not.toMatch(/hidden|visibility/);
  });
});
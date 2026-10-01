import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg, grp, scheduledApiStub } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 메시지 수정창의 멘션 추천(2026-10-01). 수정창에서 `@` 를 쳐도 목록이 뜨지 않았다 —
 * 작성창과 **같은 후보·같은 키보드**여야 하고, 목록이 열려 있는 동안에는 Enter/Esc 가
 * 저장/취소보다 먼저 목록의 것이어야 한다(`MessageEditBox` 주석).
 */
const fakeController = () => {
  const c = {
    send: vi.fn(async () => undefined),
    openThread: vi.fn(),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => undefined),
    refreshAccounts: vi.fn(async () => undefined),
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: {
      u1: acc('u1', 'admin'),
      u2: acc('u2', 'bot', 'agent'),
      u3: acc('u3', 'bob'),
      u4: acc('u4', 'bolt', 'agent', false, { disabled: true }),
    },
    groups: [grp('g1', 'backend', 'Backend team', 2)],
    channels: [chan('c1', 'general', 'main-repo')],
    activeChannelId: 'c1',
    messages: { c1: [msg('m1', 'c1', 1, 'hi', 'u1')] },
  });
});

afterEach(cleanup);

/** 내 메시지의 수정창을 열고 그 textarea 를 돌려준다. */
const openEdit = (): HTMLTextAreaElement => {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  return screen.getByDisplayValue('hi') as HTMLTextAreaElement;
};

const type = (box: HTMLTextAreaElement, value: string) => {
  fireEvent.change(box, { target: { value } });
};

const suggestions = () => screen.queryByRole('listbox', { name: 'Mention suggestions' });
const handles = () => within(suggestions()!).getAllByRole('option').map((o) => o.getAttribute('data-handle'));

describe('message edit — mention suggestions', () => {
  it('opens the same candidates as the composer when @ is typed', () => {
    fakeController();
    render(<ChannelPane />);
    const box = openEdit();
    expect(suggestions()).toBeNull();

    type(box, 'hi @b');

    // 에이전트가 먼저, 사람이 뒤, 집합이 맨 뒤 — 비활성 계정(bolt)과 나 자신은 없다.
    expect(handles()).toEqual(['bot', 'bob', 'backend']);
    expect(box.getAttribute('aria-expanded')).toBe('true');
  });

  it('Enter picks the suggestion instead of saving while the list is open', () => {
    const c = fakeController();
    render(<ChannelPane />);
    const box = openEdit();

    type(box, 'hi @bo');
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(c.editMessage).not.toHaveBeenCalled();
    expect(box.value).toBe('hi @bot ');
    expect(suggestions()).toBeNull();

    // 목록이 닫힌 뒤의 Enter 는 예전처럼 저장이다.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.editMessage).toHaveBeenCalledWith('m1', 'hi @bot ');
  });

  it('arrow keys move the highlight and Tab picks it', () => {
    fakeController();
    render(<ChannelPane />);
    const box = openEdit();

    type(box, 'hi @bo');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(within(suggestions()!).getByRole('option', { selected: true }).getAttribute('data-handle')).toBe('bob');
    fireEvent.keyDown(box, { key: 'Tab' });

    expect(box.value).toBe('hi @bob ');
  });

  it('Escape closes the list first and only a second Escape cancels the edit', () => {
    const c = fakeController();
    render(<ChannelPane />);
    const box = openEdit();

    type(box, 'hi @b');
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(suggestions()).toBeNull();
    // 수정창은 그대로 있고, 고친 글도 남아 있다.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(box.value).toBe('hi @b');

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(c.editMessage).not.toHaveBeenCalled();
  });

  it('clicking a suggestion inserts it', () => {
    fakeController();
    render(<ChannelPane />);
    const box = openEdit();

    type(box, 'hi @back');
    fireEvent.click(within(suggestions()!).getByRole('option'));

    expect(box.value).toBe('hi @backend ');
  });

  it('Enter still saves when nothing matches', () => {
    const c = fakeController();
    render(<ChannelPane />);
    const box = openEdit();

    type(box, 'hi @zzz');
    expect(suggestions()).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(c.editMessage).toHaveBeenCalledWith('m1', 'hi @zzz');
  });
});

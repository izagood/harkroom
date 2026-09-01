import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { MessageRow, ReactionRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const withReactions = (reactions: ReactionRow[]): MessageRow =>
  ({ ...msg('m1', 'c1', 1, '본문', 'u2'), reactions });

const fakeController = () => {
  const c = { toggleReaction: vi.fn(async () => undefined) };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone'), u3: acc('u3', 'third') },
  });
});
afterEach(() => cleanup());

describe('showing reactions', () => {
  it('shows the emoji with how many pressed it', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3'] }])} />);

    const chip = screen.getByRole('button', { name: /👀/ });
    expect(chip.textContent).toContain('2');
  });

  // 칩은 없어야 하지만 '추가' 버튼은 트리에 남아야 한다 — 리액션을 시작하는 유일한 경로다.
  // 호버로 숨기더라도 opacity 로 숨겨 키보드·스크린리더가 도달할 수 있어야 한다.
  it('shows no chips when nobody reacted, but keeps a way to add one', () => {
    fakeController();
    render(<MessageItem message={withReactions([])} />);

    expect(screen.queryAllByRole('button', { name: /👀|💬/ })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeTruthy();
  });

  // 내가 누른 것과 남만 누른 것이 같아 보이면, 또 누를지 뗄지 알 수 없다.
  it('marks the chips I pressed', () => {
    fakeController();
    render(<MessageItem message={withReactions([
      { emoji: '👀', accountIds: ['u1'] },
      { emoji: '💬', accountIds: ['u2'] },
    ])} />);

    expect(screen.getByRole('button', { name: /👀/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /💬/ }).getAttribute('aria-pressed')).toBe('false');
  });

  // 스크린리더에는 이모지 문자만으로 부족하다 — 몇 명이 눌렀는지 읽혀야 한다.
  it('names who reacted for a screen reader', () => {
    fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2', 'u3'] }])} />);

    expect(screen.getByRole('button', { name: /👀/ }).getAttribute('aria-label'))
      .toMatch(/someone|third/);
  });

  it('keeps the order the server sent', () => {
    fakeController();
    render(<MessageItem message={withReactions([
      { emoji: '💬', accountIds: ['u2'] },
      { emoji: '👀', accountIds: ['u3'] },
    ])} />);

    const chips = screen.getAllByRole('button', { name: /👀|💬/ });
    expect(chips[0]!.textContent).toContain('💬');
  });
});

describe('pressing a reaction', () => {
  it('adds the emoji I clicked from the picker', async () => {
    const c = fakeController();
    render(<MessageItem message={withReactions([])} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    fireEvent.click(screen.getByRole('button', { name: '👀' }));

    await waitFor(() => expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👀', true));
  });

  it('takes a click on a chip I already pressed as removing it', async () => {
    const c = fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u1'] }])} />);

    fireEvent.click(screen.getByRole('button', { name: /👀/ }));

    await waitFor(() => expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👀', false));
  });

  it('takes a click on someone else’s chip as joining it', async () => {
    const c = fakeController();
    render(<MessageItem message={withReactions([{ emoji: '👀', accountIds: ['u2'] }])} />);

    fireEvent.click(screen.getByRole('button', { name: /👀/ }));

    await waitFor(() => expect(c.toggleReaction).toHaveBeenCalledWith('c1', 'm1', '👀', true));
  });

  it('closes the picker after a pick', async () => {
    fakeController();
    render(<MessageItem message={withReactions([])} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    fireEvent.click(screen.getByRole('button', { name: '👀' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '💬' })).toBeNull());
  });

  // 시스템 메시지는 avcs 투영의 산물이다. 리액션 자체는 무해하지만 UI 가 조작 가능한 것처럼
  // 보이면 안 된다 — 여기서는 허용한다(사람이 avcs 이벤트에 반응하는 것은 자연스럽다).
  it('lets me react to a system message', () => {
    fakeController();
    render(<MessageItem message={{ ...withReactions([]), kind: 'system' }} />);

    expect(screen.getByRole('button', { name: 'Add reaction' })).toBeTruthy();
  });
});

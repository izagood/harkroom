import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      u2: acc('u2', 'someone'),
      a1: acc('a1', 'fizz', 'agent'),
    },
  });
});
afterEach(() => cleanup());

describe('mention highlighting', () => {
  it('marks a known handle so it stands out from the sentence', () => {
    show('@fizz 이거 봐줘');

    const mention = screen.getByTestId('mention-fizz');
    expect(mention.textContent).toBe('@fizz');
    // 색만으로 구분하면 색각 이상 사용자가 놓친다 — 배경과 굵기를 함께 쓴다.
    expect(mention.className).toMatch(/font-medium/);
  });

  it('leaves the surrounding text alone', () => {
    show('@fizz 이거 봐줘');

    expect(screen.getByTestId('message-body').textContent).toBe('@fizz 이거 봐줘');
  });

  it('does not highlight a handle nobody has', () => {
    show('@nobody 안녕');

    expect(screen.queryByTestId('mention-nobody')).toBeNull();
    expect(screen.getByTestId('message-body').textContent).toBe('@nobody 안녕');
  });

  // 나를 부른 메시지는 남을 부른 메시지와 한눈에 달라야 한다 — 목록을 훑을 때 그게 신호다.
  it('marks a mention of me more strongly than a mention of someone else', () => {
    show('@me 랑 @fizz');

    const mine = screen.getByTestId('mention-me');
    const other = screen.getByTestId('mention-fizz');
    expect(mine.className).not.toBe(other.className);
    expect(mine.getAttribute('data-self')).toBe('true');
    expect(other.getAttribute('data-self')).toBe('false');
  });

  it('keeps line breaks in the body', () => {
    show('첫 줄\n@fizz 둘째 줄');

    expect(screen.getByTestId('message-body').textContent).toBe('첫 줄\n@fizz 둘째 줄');
    expect(screen.getByTestId('mention-fizz')).toBeTruthy();
  });
});

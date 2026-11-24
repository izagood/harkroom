import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThreadProgressStrip } from '../src/components/ThreadProgressStrip';
import type { ThreadProgress } from '../src/lib/threadProgress';

const ZERO: ThreadProgress = { myTurn: 0, blocked: 0, running: 0, waiting: 0, doneToday: 0 };
afterEach(cleanup);

describe('ThreadProgressStrip', () => {
  it('0 인 칸은 그리지 않고, 순서는 내 차례 → 막힘 → 도는 중 → 기다림 → 오늘 끝이다', () => {
    render(<ThreadProgressStrip progress={{ myTurn: 1, blocked: 0, running: 2, waiting: 3, doneToday: 4 }} plan={null} />);
    const ids = Array.from(screen.getByTestId('thread-progress').children).map((c) => c.getAttribute('data-testid'));
    expect(ids).toEqual(['thread-progress-myTurn', 'thread-progress-running', 'thread-progress-waiting', 'thread-progress-doneToday']);
    expect(screen.getByTestId('thread-progress-running').getAttribute('data-count')).toBe('2');
  });

  it('도는 중을 모르면 0 이 아니라 모름 칸이다', () => {
    render(<ThreadProgressStrip progress={{ ...ZERO, running: null }} plan={null} />);
    expect(screen.getByTestId('thread-progress-running').hasAttribute('data-unknown')).toBe(true);
    expect(screen.queryByTestId('thread-progress-idle')).toBeNull();
  });

  it('설 칸이 없으면 한 줄로 줄이고, 계획이 있으면 끝에 진척을 붙인다', () => {
    render(<ThreadProgressStrip progress={ZERO} plan={{ done: 2, total: 5 }} />);
    expect(screen.getByTestId('thread-progress-idle')).toBeTruthy();
    expect(screen.getByTestId('thread-progress-plan').textContent).toContain('2/5');
  });
});

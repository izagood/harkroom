import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThreadProgressStrip } from '../src/components/ThreadProgressStrip';
import type { ThreadProgress } from '../src/lib/threadProgress';

const ZERO: ThreadProgress = {
  myTurn: 0, blocked: 0, running: 0, waiting: 0, waitingUnknown: false, doneToday: 0, lastDoneAt: null, lastReplyAt: null,
};
afterEach(cleanup);

describe('ThreadProgressStrip', () => {
  it('0 인 칸은 그리지 않고, 순서는 내 차례 → 막힘 → 도는 중 → 기다림 → 오늘 끝이다', () => {
    render(<ThreadProgressStrip progress={{ ...ZERO, myTurn: 1, running: 2, waiting: 3, doneToday: 4 }} plan={null} />);
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

  it('예약을 못 읽었으면 0 이 아니라 점선 「기다림 모름」 칸이 서고, 빈 띠로 줄지 않는다', () => {
    render(<ThreadProgressStrip progress={{ ...ZERO, waitingUnknown: true }} plan={null} />);
    expect(screen.getByTestId('thread-progress-waitingUnknown').hasAttribute('data-unknown')).toBe(true);
    expect(screen.queryByTestId('thread-progress-waiting')).toBeNull();
    expect(screen.queryByTestId('thread-progress-idle')).toBeNull();
  });

  it('읽힌 기다림이 있으면 그 수와 「모름」이 함께 선다', () => {
    render(<ThreadProgressStrip progress={{ ...ZERO, waiting: 2, waitingUnknown: true }} plan={null} />);
    expect(screen.getByTestId('thread-progress-waiting').getAttribute('data-count')).toBe('2');
    expect(screen.getByTestId('thread-progress-waitingUnknown')).toBeTruthy();
    cleanup();
    // 「모름」은 기다림 바로 옆이다 — 오늘 끝 뒤로 밀리지 않는다.
    render(<ThreadProgressStrip progress={{ ...ZERO, waiting: 2, waitingUnknown: true, doneToday: 1 }} plan={null} />);
    const ids = Array.from(screen.getByTestId('thread-progress').children).map((c) => c.getAttribute('data-testid'));
    expect(ids).toEqual(['thread-progress-waiting', 'thread-progress-waitingUnknown', 'thread-progress-doneToday']);
  });

  it('빈 띠는 마지막 끝의 시각을 말하고, 완료 보고가 없으면 마지막 답의 시각을 말한다', () => {
    const at = new Date();
    at.setHours(9, 12, 0, 0);
    const { unmount } = render(<ThreadProgressStrip progress={{ ...ZERO, lastDoneAt: at.toISOString(), lastReplyAt: new Date().toISOString() }} plan={null} />);
    const done = screen.getByTestId('thread-progress-idle').textContent ?? '';
    expect(done).toMatch(/Last done|마지막 끝/);
    expect(done).toContain('12');
    unmount();
    render(<ThreadProgressStrip progress={{ ...ZERO, lastReplyAt: at.toISOString() }} plan={null} />);
    expect(screen.getByTestId('thread-progress-idle').textContent).toMatch(/Last reply|마지막 답/);
  });

  it('낭독은 끈다 — 수가 바뀔 때마다 읽어 주지 않는다', () => {
    render(<ThreadProgressStrip progress={{ ...ZERO, running: 1 }} plan={null} />);
    expect(screen.getByTestId('thread-progress').getAttribute('aria-live')).toBe('off');
  });

  it('내 차례 칸은 갈 곳이 있을 때만 누를 수 있다', () => {
    const go = vi.fn();
    const { unmount } = render(<ThreadProgressStrip progress={{ ...ZERO, myTurn: 1 }} plan={null} onMyTurn={go} />);
    fireEvent.click(screen.getByTestId('thread-progress-myTurn'));
    expect(go).toHaveBeenCalledTimes(1);
    unmount();
    render(<ThreadProgressStrip progress={{ ...ZERO, myTurn: 1 }} plan={null} />);
    expect(screen.getByTestId('thread-progress-myTurn').tagName).toBe('SPAN');
  });

  it('서랍 여닫이는 받았을 때만 서고, 빈 띠에는 서지 않는다', () => {
    const onToggle = vi.fn();
    const { unmount } = render(<ThreadProgressStrip progress={{ ...ZERO, running: 1 }} plan={null} drawer={{ open: true, onToggle }} />);
    const btn = screen.getByTestId('thread-work-toggle');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    unmount();
    render(<ThreadProgressStrip progress={ZERO} plan={null} drawer={{ open: true, onToggle }} />);
    expect(screen.queryByTestId('thread-work-toggle')).toBeNull();
  });
});

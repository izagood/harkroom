// R2 — 스레드 머리의 진행 띠. 띠가 서는 동안 머리 배지는 물러난다(한 화면에 판정이 둘이면 서로 다른 말을 한다).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';

const root = msg('m1', 'c1', 1, 'root message', 'u1');
const reply = msg('m2', 'c1', 2, 'a reply', 'u2', { threadRootId: 'm1' });
const openAsk = msg('m3', 'c1', 3, 'which one?', 'u2', {
  threadRootId: 'm1',
  meta: { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], to: { kind: 'human' } } },
} as never);

beforeEach(() => {
  setController({ reply: vi.fn(async () => undefined), closeThread: vi.fn(), openThread: vi.fn(), retryThread: vi.fn(async () => undefined) } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    activeChannelId: 'c1', threadRootId: 'm1', connected: true,
    messages: { c1: [root, reply] },
  });
});
afterEach(() => cleanup());

describe('스레드 머리의 진행 띠 (R2)', () => {
  it('일이 없으면 「진행 중인 일 없음」 한 줄이고 머리 배지는 없다', () => {
    render(<ThreadPanel />);
    expect(screen.getByTestId('thread-progress').getAttribute('data-idle')).toBe('true');
    expect(screen.getByTestId('thread-progress-idle')).toBeTruthy();
    expect(screen.queryByTestId('thread-state')).toBeNull();
  });

  it('나에게 열린 카드는 「내 차례」 칸으로 선다 — 0 인 칸은 그리지 않는다', () => {
    useAppStore.getState().set({ messages: { c1: [root, reply, openAsk] } });
    render(<ThreadPanel />);
    expect(screen.getByTestId('thread-progress-myTurn').getAttribute('data-count')).toBe('1');
    expect(screen.queryByTestId('thread-progress-blocked')).toBeNull();
    expect(screen.queryByTestId('thread-progress-running')).toBeNull();
    expect(screen.queryByTestId('thread-progress-idle')).toBeNull();
    expect(screen.queryByTestId('thread-state')).toBeNull();
  });

  it('끊기면 띠를 걷고 머리 배지가 받아 둔 줄의 판정을 말한다', () => {
    useAppStore.getState().set({
      messages: { c1: [root, reply, openAsk] },
      connected: false, link: 'offline', offlineSince: Date.parse('2026-10-12T10:00:00Z'),
    });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-progress')).toBeNull();
    expect(screen.getByTestId('thread-state').getAttribute('data-state')).toBe('my-turn');
  });
});

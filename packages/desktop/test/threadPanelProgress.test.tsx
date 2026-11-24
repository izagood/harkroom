// R2 — 스레드 머리의 진행 띠. 띠가 서는 동안 머리 배지는 물러난다(한 화면에 판정이 둘이면 서로 다른 말을 한다).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

const openMessage = vi.fn(async () => undefined);
let api: { threadTurns: ReturnType<typeof vi.fn>; agentWakes: ReturnType<typeof vi.fn>; threadWork: ReturnType<typeof vi.fn> };

beforeEach(() => {
  openMessage.mockClear();
  api = {
    threadTurns: vi.fn(async () => []),
    agentWakes: vi.fn(async () => []),
    threadWork: vi.fn(async () => []),
  };
  setController({
    api, openMessage,
    reply: vi.fn(async () => undefined), closeThread: vi.fn(), openThread: vi.fn(), retryThread: vi.fn(async () => undefined),
  } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    activeChannelId: 'c1', threadRootId: 'm1', connected: true,
    messages: { c1: [root, reply] },
  });
});
afterEach(() => { cleanup(); localStorage.clear(); });

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

  it('에이전트가 낀 적 없는 스레드에는 띠를 세우지 않고 머리 배지가 선다', () => {
    const human = msg('m2', 'c1', 2, 'a reply', 'u1', { threadRootId: 'm1' });
    useAppStore.getState().set({ messages: { c1: [root, human] } });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-progress')).toBeNull();
    expect(screen.getByTestId('thread-state')).toBeTruthy();
  });

  it('띠가 서는 동안 「…의 답을 기다린다」 줄은 없고, 내 차례 칸을 누르면 그 카드로 간다', () => {
    useAppStore.getState().set({ messages: { c1: [root, reply, openAsk] } });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('wait-chain')).toBeNull();
    fireEvent.click(screen.getByTestId('thread-progress-myTurn'));
    expect(openMessage).toHaveBeenCalledWith('m3');
  });

  it('작업 서랍은 띠와 같은 묶음으로 줄을 세우고, 줄을 누르면 그 글로 간다', () => {
    useAppStore.getState().set({ messages: { c1: [root, reply, openAsk] } });
    render(<ThreadPanel />);
    const group = screen.getByTestId('thread-work-group-myTurn');
    expect(group.getAttribute('data-count')).toBe('1');
    fireEvent.click(screen.getByTestId('thread-work-row'));
    expect(openMessage).toHaveBeenCalledWith('m3');
  });

  it('서랍을 닫으면 줄이 걷히고 그 선택이 남는다 — 일이 없으면 서랍도 여닫이도 없다', () => {
    useAppStore.getState().set({ messages: { c1: [root, reply, openAsk] } });
    const { unmount } = render(<ThreadPanel />);
    fireEvent.click(screen.getByTestId('thread-work-close'));
    expect(screen.queryByTestId('thread-work-drawer')).toBeNull();
    expect(screen.getByTestId('thread-work-toggle').getAttribute('aria-expanded')).toBe('false');
    unmount();
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-work-drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('thread-work-toggle'));
    expect(screen.getByTestId('thread-work-drawer')).toBeTruthy();
    cleanup();
    useAppStore.getState().set({ messages: { c1: [root, reply] } });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-work-drawer')).toBeNull();
    expect(screen.queryByTestId('thread-work-toggle')).toBeNull();
  });

  it('「오늘 끝」만 남으면 서랍은 물러나고 여닫이는 남는다 — 사람이 직접 열면 그대로 둔다', () => {
    const done = msg('m4', 'c1', 4, 'done', 'u2', {
      threadRootId: 'm1', createdAt: new Date().toISOString(), meta: { kind: 'report', report: { checks: ['ok'] } },
    } as never);
    useAppStore.getState().set({ messages: { c1: [root, reply, done] } });
    render(<ThreadPanel />);
    expect(screen.getByTestId('thread-progress-doneToday')).toBeTruthy();
    expect(screen.queryByTestId('thread-work-drawer')).toBeNull();
    const toggle = screen.getByTestId('thread-work-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('thread-work-drawer')).toBeTruthy();
    expect(screen.getByTestId('thread-work-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('예약을 못 읽으면 띠에 「기다림 모름」이 서고 서랍에도 모름 줄이 선다', async () => {
    api.agentWakes.mockRejectedValue(new Error('net'));
    render(<ThreadPanel />);
    await waitFor(() => expect(screen.getByTestId('thread-progress-waitingUnknown')).toBeTruthy());
    expect(screen.getByTestId('thread-work-group-waiting').getAttribute('data-count')).toBe('0');
    expect(screen.getByTestId('thread-work-row').getAttribute('data-kind')).toBe('wakeUnknown');
  });

  it('작업 기록이 꺼진 서버(404)면 서랍 맨 위에 한 줄로 말하고 나머지로 계속 그린다', async () => {
    api.threadWork.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    useAppStore.getState().set({ messages: { c1: [root, reply, openAsk] } });
    render(<ThreadPanel />);
    await waitFor(() => expect(screen.getByTestId('thread-work-notice').getAttribute('data-reason')).toBe('off'));
    expect(screen.getByTestId('thread-work-group-myTurn')).toBeTruthy();
    expect(api.threadWork).toHaveBeenCalledTimes(1);
  });

  it('도는 턴과 기다리는 작업 행이 서랍과 띠에 같은 수로 선다', async () => {
    api.threadTurns.mockResolvedValue([{ agentAccountId: 'u2', startedAt: null }]);
    api.threadWork.mockResolvedValue([{ id: 'w1', state: 'waiting', title: 'wait for review', assigneeId: 'u2' }]);
    render(<ThreadPanel />);
    await waitFor(() => expect(screen.getByTestId('thread-progress-running').getAttribute('data-count')).toBe('1'));
    await waitFor(() => expect(screen.getByTestId('thread-progress-waiting').getAttribute('data-count')).toBe('1'));
    expect(screen.getByTestId('thread-work-group-running').getAttribute('data-count')).toBe('1');
    expect(screen.getByTestId('thread-work-group-waiting').textContent).toContain('wait for review');
  });
});

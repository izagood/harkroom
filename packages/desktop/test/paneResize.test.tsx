// 스레드·터미널 패널의 세로 구분선을 끌어 폭을 바꾼다.
//
// 사이드바(`sidebarHistory.test.tsx`)와 같은 기능이지만 **계산이 다르다**: 사이드바는
// 창 왼쪽 가장자리에 붙어 있어 `clientX` 가 곧 폭이다. 스레드·터미널은 오른쪽에 붙어
// 있어서 그 식이 통하지 않는다 — 시작 폭에 이동량을 더하는 **델타** 방식이어야 하고,
// 이 파일이 그 방향(왼쪽으로 끌면 넓어진다)을 지킨다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { AgentSessionView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { TerminalPanel } from '../src/components/TerminalPanel';
import { setTerminalSinkFactory } from '../src/lib/terminalSink';
import {
  paneStorage,
  DEFAULT_THREAD_WIDTH, MIN_THREAD_WIDTH, MAX_THREAD_WIDTH,
  DEFAULT_TERMINAL_WIDTH, MIN_TERMINAL_WIDTH, MAX_TERMINAL_WIDTH,
  MIN_ROOM_LEFT,
} from '../src/lib/prefs';
import { acc, msg } from './helpers/fakeApi';

/** 구분선의 부모가 폭을 지는 패널이다 — 손잡이는 그 안쪽 왼쪽 가장자리에 선다. */
const paneOf = (label: string): HTMLElement =>
  screen.getByRole('separator', { name: label }).parentElement as HTMLElement;

/** `mouseDown` 은 원점을 세우므로 `clientX` 가 반드시 있어야 한다. */
const drag = (label: string, from: number, to: number): void => {
  const sep = screen.getByRole('separator', { name: label });
  fireEvent.mouseDown(sep, { clientX: from });
  fireEvent.mouseMove(document, { clientX: to });
  fireEvent.mouseUp(document);
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
});

afterEach(() => {
  cleanup();
  setController(null as unknown as Controller);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('스레드 패널 너비 조절', () => {
  beforeEach(() => {
    setController({ reply: vi.fn(), closeThread: vi.fn(), openThread: vi.fn() } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'me'),
      accounts: { u1: acc('u1', 'me') },
      activeChannelId: 'c1',
      threadRootId: 'm1',
      messages: { c1: [msg('m1', 'c1', 1, '뿌리', 'u1')] },
    });
  });

  it('기본 폭으로 시작한다', () => {
    render(<ThreadPanel />);
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${DEFAULT_THREAD_WIDTH}px`);
  });

  it('왼쪽으로 끌면 넓어진다', () => {
    render(<ThreadPanel />);
    drag('스레드 너비 조절', 800, 700);
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${DEFAULT_THREAD_WIDTH + 100}px`);
  });

  it('오른쪽으로 끌면 좁아진다', () => {
    render(<ThreadPanel />);
    drag('스레드 너비 조절', 800, 860);
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${DEFAULT_THREAD_WIDTH - 60}px`);
  });

  it('최소·최대를 넘겨 끌어도 clamp 된다', () => {
    render(<ThreadPanel />);
    drag('스레드 너비 조절', 800, 4000);
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${MIN_THREAD_WIDTH}px`);
    drag('스레드 너비 조절', 800, -4000);
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${MAX_THREAD_WIDTH}px`);
  });

  it('끌고 난 폭이 저장되고 다시 열 때 그 폭으로 선다', () => {
    const first = render(<ThreadPanel />);
    drag('스레드 너비 조절', 800, 760);
    expect(paneStorage.loadThreadWidth()).toBe(DEFAULT_THREAD_WIDTH + 40);
    first.unmount();

    render(<ThreadPanel />);
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${DEFAULT_THREAD_WIDTH + 40}px`);
  });

  it('키보드 화살표로도 구분선이 움직인다', () => {
    render(<ThreadPanel />);
    const sep = screen.getByRole('separator', { name: '스레드 너비 조절' });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${DEFAULT_THREAD_WIDTH + 10}px`);
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${DEFAULT_THREAD_WIDTH - 10}px`);
  });

  it('드래그 도중 언마운트돼도 cursor 와 userSelect 가 남지 않는다', () => {
    const view = render(<ThreadPanel />);
    fireEvent.mouseDown(screen.getByRole('separator', { name: '스레드 너비 조절' }), { clientX: 800 });
    view.unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  /*
   * 상한이 상수뿐이면 좁은 창에서 스레드+터미널이 대화를 폭 0 으로 밀어낼 수 있다 —
   * 사람은 "채널이 사라졌다"로 읽고, 되돌릴 손잡이는 사라진 그 자리에 있다.
   * jsdom 에는 레이아웃 엔진이 없어 모든 사각형이 0 이므로, 이 제약이 실제로 걸리는지는
   * 사각형을 손으로 세워서만 볼 수 있다.
   */
  it('왼쪽 이웃을 0 으로 밀지 못한다', () => {
    render(<ThreadPanel />);
    const pane = paneOf('스레드 너비 조절');
    const row = pane.parentElement as HTMLElement;
    // 줄 전체 1000px, 스레드는 오른쪽 끝 480px → 대화가 쓰는 자리는 520px.
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 1000, right: 1000 } as DOMRect);
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ left: 520, width: 480, right: 1000 } as DOMRect);

    drag('스레드 너비 조절', 520, 0);
    // 480 + 520 - MIN_ROOM_LEFT = 대화에 MIN_ROOM_LEFT 를 남기는 최대 폭.
    expect(paneOf('스레드 너비 조절').style.width).toBe(`${480 + 520 - MIN_ROOM_LEFT}px`);
  });
});

describe('터미널 패널 너비 조절', () => {
  const session = (): AgentSessionView => ({
    sessionId: 'sess-1',
    acceptsInput: true,
    agentAccountId: 'a1',
    channelId: 'c1',
    threadRootId: 'm1',
    harness: 'claude-code',
    startedAt: '2026-09-04T00:00:00.000Z',
  });

  const mount = async () => {
    setTerminalSinkFactory(() => ({ write: () => {}, dispose: () => {} }));
    setController({
      api: {
        baseUrl: 'http://localhost:8080',
        agentSessions: vi.fn(async () => [session()]),
        attachAgentSession: vi.fn(async () => ({ ticket: 'murt_x', session: session() })),
      },
    } as unknown as Controller);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { a1: { ...acc('a1', 'forge', 'agent'), ownerAccountId: 'u1' } },
      terminalTarget: { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1' },
    });
    const view = render(<TerminalPanel />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return view;
  };

  it('기본 폭으로 시작하고 왼쪽으로 끌면 넓어진다', async () => {
    await mount();
    expect(paneOf('터미널 너비 조절').style.width).toBe(`${DEFAULT_TERMINAL_WIDTH}px`);
    drag('터미널 너비 조절', 900, 800);
    expect(paneOf('터미널 너비 조절').style.width).toBe(`${DEFAULT_TERMINAL_WIDTH + 100}px`);
    expect(paneStorage.loadTerminalWidth()).toBe(DEFAULT_TERMINAL_WIDTH + 100);
  });

  it('최소·최대를 넘겨 끌어도 clamp 된다', async () => {
    await mount();
    drag('터미널 너비 조절', 900, 5000);
    expect(paneOf('터미널 너비 조절').style.width).toBe(`${MIN_TERMINAL_WIDTH}px`);
    drag('터미널 너비 조절', 900, -5000);
    expect(paneOf('터미널 너비 조절').style.width).toBe(`${MAX_TERMINAL_WIDTH}px`);
  });
});

describe('paneStorage', () => {
  it('저장값이 없으면 기본값이다', () => {
    expect(paneStorage.loadThreadWidth()).toBe(DEFAULT_THREAD_WIDTH);
    expect(paneStorage.loadTerminalWidth()).toBe(DEFAULT_TERMINAL_WIDTH);
  });

  it('범위를 벗어난 저장값은 읽을 때 clamp 된다', () => {
    localStorage.setItem('murmur.threadWidth', '99999');
    localStorage.setItem('murmur.terminalWidth', '1');
    expect(paneStorage.loadThreadWidth()).toBe(MAX_THREAD_WIDTH);
    expect(paneStorage.loadTerminalWidth()).toBe(MIN_TERMINAL_WIDTH);
  });

  it('깨진 저장값은 기본값으로 되돌린다', () => {
    localStorage.setItem('murmur.threadWidth', 'wide');
    expect(paneStorage.loadThreadWidth()).toBe(DEFAULT_THREAD_WIDTH);
  });
});

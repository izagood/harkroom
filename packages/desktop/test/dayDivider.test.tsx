import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller as C } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg } from './helpers/fakeApi';

// 로컬 자정으로 만든 시각. **로컬로 만들어야** 이 테스트가 어떤 시간대의 기계에서도
// 같은 "날"을 뜻한다 — ISO 문자열을 손으로 적으면 UTC 기준이라 UTC+9 에서 하루가 밀린다.
const at = (y: number, m: number, d: number, h = 9): string => new Date(y, m - 1, d, h).toISOString();

const NOW = new Date(2026, 8, 3, 12, 0); // 2026-09-03 정오(로컬)

afterEach(() => { cleanup(); vi.useRealTimers(); });

beforeEach(() => {
  // Date 만 고정한다. 타이머 전체를 가짜로 바꾸면 React 의 스케줄러까지 멈춘다.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
  });
  setController({ openChannel: vi.fn(), openThread: vi.fn(), startDm: vi.fn(), logout: vi.fn() } as unknown as C);
});

const seedMessages = (rows: ReturnType<typeof msg>[]) =>
  useAppStore.getState().set({ messages: { c1: rows }, dividerSeq: { c1: 999 } });

describe('날짜 구분선', () => {
  it('draws a divider where the day changes', () => {
    seedMessages([
      msg('m1', 'c1', 1, 'yesterday talk', 'u2', { createdAt: at(2026, 9, 2) }),
      msg('m2', 'c1', 2, 'today talk', 'u2', { createdAt: at(2026, 9, 3) }),
    ]);

    render(<ChannelPane />);

    const rendered = document.body.textContent ?? '';
    // 구분선은 어제 발화 **뒤**, 오늘 발화 **앞**에 온다.
    expect(rendered.indexOf('yesterday talk')).toBeLessThan(rendered.indexOf('오늘'));
    expect(rendered.indexOf('오늘')).toBeLessThan(rendered.indexOf('today talk'));
  });

  it('draws no divider between messages of the same day', () => {
    seedMessages([
      msg('m1', 'c1', 1, 'morning', 'u2', { createdAt: at(2026, 9, 3, 9) }),
      msg('m2', 'c1', 2, 'evening', 'u2', { createdAt: at(2026, 9, 3, 21) }),
    ]);

    render(<ChannelPane />);

    // 첫 메시지 앞의 하나가 전부여야 한다 — 같은 날 사이에 또 그으면 2개가 된다.
    expect(screen.getAllByText('오늘')).toHaveLength(1);
  });

  it('labels today and yesterday in words and older days as a date', () => {
    seedMessages([
      msg('m1', 'c1', 1, 'old', 'u2', { createdAt: at(2026, 8, 20) }),
      msg('m2', 'c1', 2, 'yest', 'u2', { createdAt: at(2026, 9, 2) }),
      msg('m3', 'c1', 3, 'now', 'u2', { createdAt: at(2026, 9, 3) }),
    ]);

    render(<ChannelPane />);

    expect(screen.getByText('오늘')).toBeTruthy();
    expect(screen.getByText('어제')).toBeTruthy();
    // 그 이전은 사용자 로캘의 절대 날짜다. 표기를 하드코딩하지 않고 같은 규칙으로 만든다.
    expect(screen.getByText(new Date(2026, 7, 20).toLocaleDateString([]))).toBeTruthy();
  });

  // 두 구분선은 다른 두 사실을 말한다. 한 지점에 겹쳐도 하나를 감추면 안 된다.
  it('shows both the day divider and the New messages divider at the same spot', () => {
    useAppStore.getState().set({
      messages: { c1: [
        msg('m1', 'c1', 1, 'yesterday talk', 'u2', { createdAt: at(2026, 9, 2) }),
        msg('m2', 'c1', 2, 'unread today', 'u2', { createdAt: at(2026, 9, 3) }),
      ] },
      dividerSeq: { c1: 1 },
    });

    render(<ChannelPane />);

    const rendered = document.body.textContent ?? '';
    expect(screen.getByText('오늘')).toBeTruthy();
    expect(screen.getByText(/new messages/i)).toBeTruthy();
    // 둘 다 m2 앞에, 날짜가 먼저 온다.
    expect(rendered.indexOf('yesterday talk')).toBeLessThan(rendered.indexOf('오늘'));
    expect(rendered.indexOf('오늘')).toBeLessThan(rendered.indexOf('New messages'));
    expect(rendered.indexOf('New messages')).toBeLessThan(rendered.indexOf('unread today'));
  });

  it('draws a divider before the very first message too', () => {
    seedMessages([msg('m1', 'c1', 1, 'first ever', 'u2', { createdAt: at(2026, 8, 20) })]);

    render(<ChannelPane />);

    const label = new Date(2026, 7, 20).toLocaleDateString([]);
    const rendered = document.body.textContent ?? '';
    expect(rendered.indexOf(label)).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf(label)).toBeLessThan(rendered.indexOf('first ever'));
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller as C } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

// 로컬 자정으로 만든 시각. **로컬로 만들어야** 이 테스트가 어떤 시간대의 기계에서도
// 같은 "날"을 뜻한다 — ISO 문자열을 손으로 적으면 UTC 기준이라 UTC+9 에서 하루가 밀린다.
const at = (y: number, m: number, d: number, h = 9): string => new Date(y, m - 1, d, h).toISOString();

const NOW = new Date(2026, 8, 3, 12, 0); // 2026-09-03 정오(로컬)

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePrefsStore.getState().setLocale('system');
});

beforeEach(() => {
  /**
   * **언어를 고정한다.** 이 축들이 재는 것은 *"날이 바뀌는 자리에 구분선이 서는가"*
   * 이지 그 구분선의 언어가 아니다(`#619` 후속으로 `dayLabel` 이 앱 언어를 따르게 됐다).
   * 안 고정하면 시험이 **기계의 브라우저 로캘**에 매달려, 한국어가 아닌 기계에서
   * 빨개지면서도 그 빨강이 코드의 결함을 뜻하지 않는다 — `i18n.test.tsx` 가 세운 규약과
   * 같다(*"`'system'` 을 안 쓰는 이유: 시험이 브라우저 설정에 매달리면 안 된다"*).
   *
   * 언어가 실제로 문구를 바꾸는지는 아래 마지막 축이 따로 잰다.
   */
  usePrefsStore.getState().setLocale('ko');
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
  // #222: 컴포저가 채널에 붙으면 예약 목록을 읽는다 — 그 표면이 목에 없으면 화면이 뜨지 않는다.
  setController({ openChannel: vi.fn(), openThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(), api: scheduledApiStub() } as unknown as C);
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
    expect(screen.getByText(new Date(2026, 7, 20).toLocaleDateString('ko'))).toBeTruthy();
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

    const label = new Date(2026, 7, 20).toLocaleDateString('ko');
    const rendered = document.body.textContent ?? '';
    expect(rendered.indexOf(label)).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf(label)).toBeLessThan(rendered.indexOf('first ever'));
  });

  /**
   * **앱 언어를 바꾸면 구분선도 바뀐다**(`#619` 후속의 판단 3).
   *
   * `dayLabel` 은 로캘을 비워(`[]`) 브라우저 것을 따르고 있었다. 그러면 앱 언어를 영어로
   * 바꾼 사람의 화면이 **한 줄 안에서 두 언어**가 된다 — 구분선만 시스템 로캘로 남는다.
   * 그 파일 주석이 근거를 적어 뒀고, 이 축이 그 판단을 잠근다.
   *
   * `오늘`·`어제` 가 사전에 **없는데도** 바뀌는 것이 이 PR 의 요점이다 —
   * `Intl.RelativeTimeFormat(locale, { numeric: 'auto' })` 이 그 둘을 낸다.
   */
  it('언어를 영어로 바꾸면 구분선이 영어로 뜬다 — 사전에 그 말이 없는데도', () => {
    usePrefsStore.getState().setLocale('en');
    seedMessages([
      msg('m1', 'c1', 1, 'old', 'u2', { createdAt: at(2026, 8, 20) }),
      msg('m2', 'c1', 2, 'yest', 'u2', { createdAt: at(2026, 9, 2) }),
      msg('m3', 'c1', 3, 'now', 'u2', { createdAt: at(2026, 9, 3) }),
    ]);

    render(<ChannelPane />);

    expect(screen.getByText('today')).toBeTruthy();
    expect(screen.getByText('yesterday')).toBeTruthy();
    // 한국어 말이 남아 있으면 안 된다 — 한 화면이 두 언어가 되는 것이 이 변경이 막는 것이다.
    expect(screen.queryByText('오늘')).toBeNull();
    expect(screen.queryByText('어제')).toBeNull();
    // 절대 날짜도 앱 언어를 따른다(`2026. 8. 20.` 이 아니라 `8/20/2026`).
    expect(screen.getByText(new Date(2026, 7, 20).toLocaleDateString('en'))).toBeTruthy();
  });
});

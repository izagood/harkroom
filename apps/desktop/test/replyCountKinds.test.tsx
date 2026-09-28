import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    messages: { c1: [] },
  });
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

/**
 * **세는 것과 그리는 것이 같아야 한다**(2026-09-09).
 *
 * 사용자가 채널의 `답글 2개` 를 눌러 스레드를 열었더니 말풍선이 **하나**였다. 나머지
 * 하나는 `kind='progress'` 였고, 스레드는 그것을 말풍선이 아니라 상태 한 줄
 * (`ProgressRow`)로 그린다 — `#144` 이후로 그렇다. 서버는 그 사실을 모른 채 전부 세고
 * 있었다(`THREAD_STATS` 의 옛 주석이 "진행도 포함한다"고 적어 두었다).
 *
 * 여기서 재는 것은 화면 쪽 규약 둘이다:
 * - 수는 `replyCount` 가 정한다 — 그 값이 이제 진행·대기를 빼고 온다.
 * - **자리는 `activityCount` 가 세운다** — 진행만 있는 스레드에서 요약 줄이 사라지면
 *   그 줄에 얹힌 `작업 중` 배지도 함께 사라져, 열어 보지 않은 스레드가 도는지 끝났는지
 *   화면이 답하지 못한다.
 */
describe('답글 수는 화면이 답글로 그리는 것만 센다', () => {
  it('진행 하나 + 결과 하나인 스레드는 "답글 1개" 다 (서버가 1 을 준다)', () => {
    fakeController();
    // 서버 셈: 진행은 빠지고 결과 하나만 남는다. 활동은 둘이다.
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', {
      replyCount: 1, activityCount: 2, participantIds: ['u2'],
      openAskHumanCount: 0, openAskAccountIds: [], failureCount: 0, unresolvedFailureCount: 0,
    })} />);

    expect(screen.getByTestId('reply-summary-count').textContent).toContain('1');
    expect(screen.queryByText(/답글 2개/)).toBeNull();
  });

  it('진행만 있는 스레드: 요약 줄은 서되 "답글 0개" 는 그리지 않는다', () => {
    fakeController();
    // 러너가 진행만 남긴 상태 — 읽을 답은 아직 없지만 스레드에 무언가는 달렸다.
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', {
      replyCount: 0, activityCount: 1, participantIds: ['u2'],
      openAskHumanCount: 0, openAskAccountIds: [], failureCount: 0, unresolvedFailureCount: 0,
      lastKind: 'progress', lastAuthorId: 'u2',
    })} />);

    // 자리는 선다 — 이 줄이 사라지면 상태 배지도 함께 사라진다.
    expect(screen.getByTestId('thread-state')).toBeTruthy();
    // 그러나 `0` 은 글자로도 접근 이름으로도 새어 나가지 않는다(규칙 06 · `#489`).
    expect(screen.queryByTestId('reply-summary-count')).toBeNull();
    expect(screen.queryByText(/답글 0개/)).toBeNull();
    expect(screen.queryByRole('button', { name: /답글 0개/ })).toBeNull();
  });

  it('아무것도 안 달린 루트는 요약 줄이 아예 없다 (`#489` 가 세운 규약 그대로)', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', {
      replyCount: 0, activityCount: 0,
      openAskHumanCount: 0, openAskAccountIds: [], failureCount: 0, unresolvedFailureCount: 0,
    })} />);

    expect(screen.queryByTestId('thread-state')).toBeNull();
    expect(screen.queryByTestId('reply-summary-count')).toBeNull();
    // 진입점은 호버 툴바에 남는다 — 스레드로 갈 길이 없어지면 안 된다.
    expect(screen.getByRole('button', { name: '스레드에 답글 달기' })).toBeTruthy();
  });
});

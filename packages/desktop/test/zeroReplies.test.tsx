import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
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
// **언어를 고정한다**(이 묶음의 문구가 사전을 지나면서 기본이 영어가 됐다). 이 파일이
// 재는 것은 언어가 아니라 **그 언어로 표현된 규율**이다 — 언어를 재는 자리는
// `i18n.test.tsx` 하나이고, 두 곳에서 재면 문구를 고칠 때 한쪽만 고쳐진다
// (`gallery.test.tsx`·`skillsSettings.test.tsx`·`agentGrid.test.tsx` 와 같은 규약).
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

/**
 * **`0` 은 그리지 않는다**(`docs/desktop-design-directions.pdf` 5쪽, *위생 — 자리를 비운다*):
 * *"`0 replies`, 빈 리액션 줄, 권한 없는 동작 — 규칙 06 을 화면 전체에 적용한 것이다."*
 * 문서의 "지금 화면" 캡처에도 `0 replies` 가 **위반 예시**로 실려 있다.
 *
 * **이 결함이 왜 테스트를 통과해 왔는가 — fixture 가 서버를 흉내 내지 않았다.**
 * `replyCount` 는 서버에서 두 가지 뜻을 갖는다(`packages/server/src/services/messages.ts:216`,
 * `case when m.thread_root_id is null then thread_stats.reply_count end`):
 *
 * | 값 | 뜻 |
 * |---|---|
 * | `null` | 이 메시지는 **답글이다**(스레드 루트가 아니다) — 답글 수를 셀 대상이 아니다 |
 * | `0` | **스레드 루트인데 답글이 아직 없다** |
 *
 * 그리고 `0` 은 **실측으로 반드시 온다**: 같은 파일 `:196` 의 `thread_stats` 는
 * `LEFT JOIN LATERAL (SELECT COUNT(*)::int ...) ON true` 라서 답글이 없어도 행이 하나
 * 나오고 `COUNT(*)` 는 `0` 이다 — 루트의 `replyCount` 가 `null` 이 되는 경우는 없다.
 *
 * 그런데 기존 테스트는 `null` 아니면 `>= 1` 만 넣었다(`replyControlPosition`,
 * `messageToolbar`, `chatAvatars` 전부). 그래서 **답글 0개 루트라는 실제 상태를 아무도
 * 재현하지 않았고**, 화면은 `0 replies` 를 그려 왔다. 이 파일이 그 자리를 메운다.
 */
describe('#489 답글 0개 루트: 0 은 그리지 않고, 스레드로 가는 길은 남는다', () => {
  // 회귀선 1 — 숫자가 사라진다.
  //
  // 문자열을 **직접** 찾는다. 역할+이름(`/repl(y|ies)/`)으로만 물으면 툴바의 진입점
  // 아이콘(`스레드에 답글 달기`)과 이름이 달라 서로를 가리지 못해, 숫자가 남아 있어도
  // 다른 이유로 초록이 될 수 있다. 문서가 지목한 것은 **화면에 보이는 그 글자**다.
  it('답글 0개 루트에 "0 replies" 가 보이지 않는다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 0 })} />);

    // 어느 언어로도 `0` 을 세지 않는다 — 문서가 금지한 것은 그 숫자이지 그 낱말이 아니다.
    expect(screen.queryByText(/0 replies/)).toBeNull();
    expect(screen.queryByText(/0 reply/)).toBeNull();
    expect(screen.queryByText(/답글 0개/)).toBeNull();
    // 접근성 이름으로도 새어 나가지 않는다 — 눈으로 읽든 귀로 듣든 같은 결함이다.
    expect(screen.queryByRole('button', { name: /0 repl(y|ies)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /답글 0개/ })).toBeNull();
    // 답글 요약 자체가 그려지지 않는다(`> 0` 일 때만 그린다).
    expect(screen.queryByRole('button', { name: /^\d+ repl(y|ies)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^답글 \d+개/ })).toBeNull();
  });

  // 회귀선 2 — **진입점은 남는다.** 이것이 없으면 회귀선 1 은 기능을 없앤 것이다.
  //
  // 지금 화면에서 답글 0개 루트의 **유일한** 스레드 진입점이 그 `0 replies` 였다:
  // 툴바 아이콘의 조건이 `replyCount === null` 이라 `0` 에서는 그려지지 않았기 때문이다.
  // 숫자만 지우면 답글 0개 루트에서 스레드를 열 방법이 사라진다.
  it('답글 0개 루트에도 툴바의 스레드 진입점이 있고, 누르면 스레드가 열린다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 0 })} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    const threadBtn = within(toolbar).getByRole('button', { name: '스레드에 답글 달기' });

    fireEvent.click(threadBtn);
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });

  /**
   * 진입점이 **키보드·스크린리더에도 닿는다.** 툴바는 호버에서만 보이지만 숨김이
   * `opacity` 라 접근성 트리에 남는다 — `visibility:hidden`/`display:none` 이면
   * 포커스 순서에서 지워져 마우스 없는 사용자에게는 진입점이 없는 것과 같다
   * (`Reactions.tsx` 주석이 그 비용을 기록한다). 회귀선 2 가 "보인다"고 말할 수 있는
   * 근거가 이 성질이므로 함께 못 박는다.
   */
  it('0개 루트의 진입점은 opacity 로 숨는 툴바 안에 있어 키보드로 닿는다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 0 })} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    expect(toolbar.className).toMatch(/\bopacity-0\b/);
    expect(toolbar.className).toMatch(/group-hover:opacity-100/);
    expect(toolbar.className).not.toMatch(/\binvisible\b/);
    expect(toolbar.className).not.toMatch(/\bhidden\b/);

    // 포커스가 실제로 들어간다 — 클래스가 아니라 동작으로 한 번 더 잰다.
    const threadBtn = within(toolbar).getByRole('button', { name: '스레드에 답글 달기' });
    threadBtn.focus();
    expect(document.activeElement).toBe(threadBtn);
  });

  /**
   * **두 자리의 조건이 서로 배타다** — `#143` 이 되살아나지 않는 근거.
   *
   * `MessageItem.tsx` 의 답글 요약 주석이 경고한다: 답글 요약과 툴바 진입점이 **겹치면**
   * "호버 툴바가 답글 pill 을 덮어 스레드 진입이 막힌다"(`#143`)가 되살아난다. `#396` 은
   * 그것을 *"같은 조건끼리는 서로 덮을 대상이 없으므로"* 로 풀었는데, 그 전제가
   * `null` 기준이라 `0` 에서 깨져 있었다 — `0` 은 **양쪽 어디에도** 맞지 않아 요약만
   * 그려지고 진입점은 사라졌다.
   *
   * **2026-09-09 에 이 셈이 뒤집혔다.** 진입점을 하나로 유지하는 규율이 실제로 지킨 것은
   * *한 개*였고, 지키지 못한 것은 **같은 자리**였다 — 값에 따라 진입점이 툴바와 본문 열을
   * 오갔으므로 사람은 손이 갈 자리를 배울 수 없었다("채팅만 있는 경우 스레드에 답글을 못
   * 달아"). 그래서 역할을 자리로 갈랐다: 툴바의 스레드 칸은 **행동**이라 늘 있고, 본문 열의
   * 요약 줄은 **상태**라 답글이 있을 때만 선다.
   *
   * `#143`(툴바가 답글 pill 을 덮는다)이 되살아나지 않는 근거는 그대로다: 둘은 **다른
   * 컨테이너**에 있고(`replyControlPosition.test.tsx` 가 그것을 잰다), 툴바는 행 위쪽
   * 경계에 걸쳐 본문 열을 침범하지 않는다.
   */
  it('null·0·2 모든 값에서 툴바의 스레드 칸이 있고, 요약 줄은 답글이 있을 때만 선다', () => {
    fakeController();

    for (const replyCount of [null, 0, 2] as const) {
      const { unmount } = render(
        <MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount })} />,
      );

      const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
      const inToolbar = within(toolbar).queryByRole('button', { name: '스레드에 답글 달기' });
      // 이 파일은 한국어로 고정돼 있다(위 `beforeEach`) — 요약 줄의 이름은 `답글 N개` 다.
      const summary = screen.queryByRole('button', { name: /답글 \d+개/ });

      // **행동은 늘 같은 자리에 있다** — 값 셋 전부에서 툴바의 스레드 칸이 하나 있다.
      expect(inToolbar, `replyCount=${String(replyCount)} 에서 툴바의 스레드 칸`).not.toBeNull();
      expect(within(toolbar).queryAllByRole('button', { name: '스레드에 답글 달기' })).toHaveLength(1);

      // **상태는 있을 때만 말한다** — 요약 줄은 답글이 하나라도 있을 때만 선다(`0` 은 글자로
      // 쓰지 않는다: 이 파일 첫 테스트가 그것을 잰다).
      if (replyCount !== null && replyCount > 0) expect(summary).not.toBeNull();
      else expect(summary).toBeNull();

      unmount();
    }
  });

  /**
   * **빈 리액션 줄** — 문서가 같은 문장에서 지목한 둘째 항목. `Reactions.tsx` 는
   * `if (!message.reactions.length) return null` 로 이미 자리를 비운다. 실측으로 확인한
   * 사실을 회귀선으로 굳혀 둔다 — 이 가드가 빠지면 문서가 금지한 빈 줄이 돌아온다.
   */
  it('리액션이 없으면 리액션 줄이 자리를 차지하지 않는다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { reactions: [] })} />);

    expect(screen.queryByTestId('reactions')).toBeNull();
  });
});

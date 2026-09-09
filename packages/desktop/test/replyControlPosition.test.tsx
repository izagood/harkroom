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

describe('#254 답글 컨트롤 위치 변경', () => {
  // 회귀선 1: 답글 컨트롤이 본문 열 안, 리액션 다음에 온다.
  //
  // 리액션 칩을 **실제로 달아 둔다** — `Reactions` 는 리액션이 없으면 null 을 반환하므로
  // (Reactions.tsx 의 `if (!message.reactions.length) return null`), 빈 fixture 로는
  // [data-testid="reactions"] 가 아예 없어 순서를 물을 대상이 사라진다. 초판이 그것을
  // `if (reactions)` 로 감싸 두어, 답글 컨트롤을 오른쪽 열로 되돌려도 초록이었다.
  it('답글 컨트롤이 본문 열 안에서 리액션 칩 다음에 온다', () => {
    fakeController();
    render(
      <MessageItem
        message={msg('m1', 'c1', 1, 'root', 'u2', {
          replyCount: 2,
          reactions: [{ emoji: '👍', accountIds: ['u1'] }],
        })}
      />,
    );

    const replyBtn = screen.getByRole('button', { name: '답글 2개' });
    // 가드 없이 찾는다 — 없으면 그 자체가 실패여야 한다.
    const reactions = screen.getByTestId('reactions');

    // ① 리액션 칩과 답글 컨트롤이 **같은 열**(본문 열) 안에 있다.
    const mainColumn = document.querySelector('.min-w-0.flex-1')!;
    expect(mainColumn.contains(reactions)).toBe(true);
    expect(mainColumn.contains(replyBtn)).toBe(true);

    // ② 그 안에서 답글 컨트롤이 리액션 칩 **뒤에** 온다.
    expect(
      reactions.compareDocumentPosition(replyBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // 회귀선 2: 답글 컨트롤과 호버 툴바가 다른 컨테이너에 있다 (구조적 비겹침)
  it('답글 컨트롤과 툴바가 다른 컨테이너에 있어 겹칠 수 없다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    const replyBtn = screen.getByRole('button', { name: '답글 2개' });

    // 답글 버튼과 툴바가 다른 부모를 갖는다 (다른 컨테이너)
    expect(toolbar.parentElement).not.toBe(replyBtn.parentElement);

    // 답글 버튼은 본문 열(	min-w-0 flex-1) 안에, 툴바는 오른쪽 열(relative) 안에
    const mainColumn = document.querySelector('.min-w-0.flex-1');
    const rightColumn = document.querySelector('.relative.flex.shrink-0.items-start.gap-1');

    expect(mainColumn?.contains(replyBtn)).toBe(true);
    expect(rightColumn?.contains(toolbar)).toBe(true);
  });

  // 회귀선 3: 답글이 있으면 호버 없이 pill 이 보인다(#161). jsdom 에는 레이아웃이 없으니
  // "보인다"를 픽셀로 재지 못한다 — 호버로만 드러나게 하는 클래스가 **붙지 않았음**을
  // 단언한다. 존재만 확인하면 pill 에 hoverOnly 를 붙여도 초록으로 남는다.
  it('답글이 있으면 호버 없이 답글 pill 이 보인다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const replyBtn = screen.getByRole('button', { name: '답글 2개' });
    expect(replyBtn.className).not.toMatch(/\bopacity-0\b/);
    expect(replyBtn.className).not.toMatch(/\binvisible\b/);
    expect(replyBtn.className).not.toMatch(/\bhidden\b/);
  });

  // 회귀선 4 (#396 갱신): 답글이 없으면 본문 아래 "Reply in thread" 버튼 자체가 없다 —
  // 진입점은 호버 툴바의 아이콘으로 옮겨졌고, 툴바를 숨기는 방식(opacity, visibility 아님)은
  // 툴바 컨테이너 하나가 책임진다("toolbar accessibility" 테스트가 그것을 잰다). 이 아이콘도
  // 같은 hoverOnly 툴바 안에 있으므로 조건이 같다.
  it('답글이 없으면 본문 아래 버튼은 없고, 스레드 아이콘은 opacity 로 숨는 툴바 안에 있다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: null })} />);

    // 본문 아래에는 더 이상 그려지지 않는다.
    expect(screen.queryByRole('button', { name: 'Reply in thread' })).toBeNull();

    // 진입점은 툴바 안의 아이콘 버튼이다.
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    const threadBtn = within(toolbar).getByRole('button', { name: '스레드에 답글 달기' });
    expect(threadBtn).toBeTruthy();

    // opacity-0 로 숨어야 하고, visibility 계열로 숨어서는 안 된다. Tailwind 에서
    // visibility:hidden 은 `invisible` 이다 — `/visibility/` 로 찾으면 클래스 문자열에
    // 그 낱말이 없어 무엇도 걸리지 않는다(초판이 그랬다). 숨김은 툴바 컨테이너가 진다.
    expect(toolbar.className).toMatch(/\bopacity-0\b/);
    expect(toolbar.className).not.toMatch(/\binvisible\b/);
    expect(toolbar.className).not.toMatch(/\bcollapse\b/);

    // 호버 후에는 opacity-100 이 되어 보여야 함
    fireEvent.mouseEnter(toolbar);
    expect(toolbar.className).toMatch(/group-hover:opacity-100/);

    // 누르면 스레드가 열린다.
    fireEvent.click(threadBtn);
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });

  // 회귀선 5: 툴바의 기존 동작(리액션 피커, ⋯ 메뉴, 인라인 리액션)이 그대로다
  it('툴바에 리액션 피커, 메뉴, 인라인 리액션이 모두 있다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    // 인라인 이모지 버튼 3개
    expect(within(toolbar).getByRole('button', { name: 'React with 👍' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with 👀' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with ✅' })).toBeTruthy();

    // 피커
    expect(within(toolbar).getByRole('button', { name: /Add reaction|＋/ })).toBeTruthy();

    // 메뉴
    expect(within(toolbar).getByRole('button', { name: 'More actions' })).toBeTruthy();
  });

  // 회귀선 6: 스레드 패널(inThread) 안에서는 답글 컨트롤이 없다 (pill 도, 툴바 아이콘도)
  it('inThread=true 이면 답글 컨트롤이 없다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'reply', 'u2', { replyCount: 2 })} inThread />);

    // 답글 버튼이 없어야 함
    expect(screen.queryByRole('button', { name: /repl(y|ies)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply in thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: '스레드에 답글 달기' })).toBeNull();
  });
});

describe('#254 툴바 앵커 변경 (#145 관련)', () => {
  it('툴바가 right-full 이 아니라 right-2 top-1 로 앵커된다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });

    // right-full 이 아니어야 함
    expect(toolbar.className).not.toMatch(/\bright-full\b/);
    // 2026-09-09: 세로 앵커가 `top-1` → `-top-3` 으로 갔다. 여덟 칸이 되면서 폭이 200px 을
    // 넘었고, 행 안쪽에 앉으면 한 줄 긴 말의 오른쪽 끝을 덮는다 — 행의 **위쪽 경계에
    // 걸치면** 덮는 것이 본문이 아니라 행간이다. 가로 앵커(`right-2`)는 그대로다.
    expect(toolbar.className).toMatch(/\bright-2\b/);
    expect(toolbar.className).toMatch(/-top-3/);
  });
});
describe('#424 답글 요약은 상자가 아니라 텍스트 링크다', () => {
  // 회귀선: 채널을 스크롤하면 답글이 달린 메시지마다 파란 상자(테두리 + 옅은 강조 면)가
  // 줄줄이 서서 본문보다 먼저 눈에 띄었다. 상자를 벗기고 강조색 텍스트로만 둔다.
  //
  // 클래스 이름을 직접 묻는다 — 이 회귀는 "무엇이 보이는가"가 아니라 "어떻게 칠했는가"라서
  // 역할·이름만 보는 질문으로는 상자가 되돌아와도 초록이 된다. 대신 채움/테두리 유틸리티만
  // 좁게 묻고 여백·정렬은 묻지 않아, 배치를 손볼 자유는 남긴다.
  it('답글 요약에 테두리도 강조 면도 없다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const replyBtn = screen.getByRole('button', { name: '답글 2개' });

    // 상시 노출되는 면이 없다. hover 에서만 깔리는 hover:bg-* 는 살아 있어야 하므로
    // 접두사 없는 bg-/border- 만 걸리도록 경계를 둔다.
    expect(replyBtn.className).not.toMatch(/(^|\s)bg-/);
    expect(replyBtn.className).not.toMatch(/(^|\s)border(\s|-)/);
  });

  /**
   * **#488 B2 로 뒤집혔다.** 초판은 이 자리를 `text-accent` 로 못 박았고 그 근거는
   * "링크임을 알려 주는 단서가 색뿐"이라는 것이었다. 근거는 맞았지만 **해법이
   * 틀렸다** — 강조색은 나를 막는 말에만 쓰는 색이고(규칙 04), 답장 수는
   * "현재 상태"이지 "급한 것"이 아니다(문서 B2).
   *
   * 그래서 색을 빼되 **링크라는 단서는 남긴다** — 점선 밑줄이 그 일을 한다.
   * 단서를 통째로 없애면 초판이 걱정한 "그냥 회색 잡음"이 실제로 된다.
   */
  it('답글 개수는 강조색 대신 밑줄로 링크임을 말한다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const count = screen.getByText(/답글 2개/);
    expect(count.className).not.toMatch(/\btext-accent\b/);
    expect(count.className).toMatch(/\bunderline\b/);
  });

  it('클릭하면 여전히 스레드가 열린다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    fireEvent.click(screen.getByRole('button', { name: '답글 2개' }));
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });
});

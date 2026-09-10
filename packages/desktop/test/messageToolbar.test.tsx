import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { MessageRow } from '@murmur/shared';
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

const withReplies = (count: number, rootId = 'm1'): MessageRow[] => {
  const messages: MessageRow[] = [msg('m1', 'c1', 1, 'root message', 'u2')];
  for (let i = 0; i < count; i++) {
    messages.push(msg(`r${i + 1}`, 'c1', i + 2, `reply ${i + 1}`, 'u1', { threadRootId: rootId }));
  }
  return messages;
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
  // 클립보드를 갈아 끼운 테스트가 있다 — 다음 테스트가 그 자리를 물려받지 않게 되돌린다.
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
});

describe('message toolbar', () => {
  it('shows reaction trigger in toolbar on hover for own message', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: /Add reaction|＋/ })).toBeTruthy();
  });

  // #396: 답글이 없는 메시지의 스레드 진입점은 본문 아래 버튼이 아니라 호버 툴바의
  // 아이콘이다 — 접근 가능한 이름은 aria-label(그리고 같은 문구의 title)로 남는다.
  it('shows thread trigger in toolbar on hover', () => {
    const c = fakeController();
    useAppStore.getState().set({ messages: { c1: withReplies(0) } });
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: '스레드에 답글 달기' })).toBeTruthy();
  });

  it('shows overflow menu trigger on hover', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: 'More actions' })).toBeTruthy();
  });
});

describe('overflow menu permissions', () => {
  it('shows Edit and Delete in overflow menu for own message', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));

    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('shows only Delete in overflow menu for admin', () => {
    const c = fakeController();
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), u2: acc('u2', 'someone') },
    });
    render(<MessageItem message={msg('m1', 'c1', 1, '남의 메시지', 'u2')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));

    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  // 항목이 하나도 없으면 트리거를 아예 만들지 않는다 — 열어도 비어 있는 메뉴는
  // "할 수 있는 게 있다"는 거짓 신호다(design.md §4).
  // #178: 그 가드는 코드에 그대로 남아 있지만 실제로 걸리지는 않는다 — "Copy link" 는
  // 어떤 메시지에도 있어 메뉴가 비지 않는다. 그래서 여기서 세는 것은 **항목의 내용**이다.
  it('남의 메시지에는 고치기·지우기가 없다 (본문 복사만 남는다)', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '남의 메시지', 'u2')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    // 링크 복사는 2026-09-09 에 **툴바**로 올라갔다 — 메뉴에 남은 것은 본문 복사다.
    expect(screen.queryByRole('menuitem', { name: 'Copy link' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Copy text' })).toBeTruthy();
    expect(within(toolbar).getByTestId('toolbar-copy-link')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    // 리액션은 남의 메시지에도 달 수 있다.
    expect(within(toolbar).getByRole('button', { name: 'Add reaction' })).toBeTruthy();
  });

  /**
   * 복사 **성공**에는 아무것도 띄우지 않는다. `Notice` 는 실패를 세우는 자리다 —
   * 경고색이고 저절로 사라지지 않아 사람이 ×를 눌러야 한다. 'Link copied.' 를 거기에
   * 태웠더니 잘 된 일이 창 제일 위를 노랗게 덮고, 그것을 사람이 손으로 치워야 했다.
   * 실패는 그대로 남는다 — 링크는 화면 어디에도 안 보이므로 조용히 삼키면 사람은
   * 붙여넣기를 해 보고 나서야 안 됐다는 것을 안다.
   */
  it('링크 복사가 되면 알림을 띄우지 않는다', async () => {
    fakeController();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);

    fireEvent.click(screen.getByTestId('toolbar-copy-link'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().notice).toBeNull();
  });

  it('링크 복사가 실패하면 링크를 실어 알린다', async () => {
    fakeController();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);

    fireEvent.click(screen.getByTestId('toolbar-copy-link'));

    await waitFor(() => expect(useAppStore.getState().notice).toMatch(/Could not copy the link/));
    expect(useAppStore.getState().notice).toContain('m1');
  });

  it('shows no Edit/Delete for system message', () => {
    fakeController();
    render(<MessageItem message={{ ...msg('m1', 'c1', 1, '시스템', 'u1'), kind: 'system' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});

describe('overflow menu actions', () => {
  it('opens edit mode when Edit is clicked', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '원문', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    expect(screen.getByDisplayValue('원문')).toBeTruthy();
  });

  /**
   * 확인은 **겹창**이다. 앞 판은 호버 툴바 안에 'Really delete' / 'Keep' 을 끼워 넣었고,
   * 그 배치는 (1) 툴바 폭을 바꿔 방금 누른 자리에 다른 버튼을 앉히고 (2) 툴바가
   * `opacity-0 group-hover` 라 커서가 행을 벗어나면 질문을 조용히 지웠다.
   *
   * 그래서 재는 것을 "확인 버튼이 어딘가 있다"가 아니라 **"툴바 밖 `dialog` 안에 있다"**로
   * 적는다. 이 단언이 없으면 다음 사람이 확인을 툴바로 되돌려도 테스트가 통과한다.
   */
  it('opens a confirm dialog — not an inline toolbar state — when Delete is clicked', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = screen.getByRole('dialog', { name: 'Delete message?' });
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeTruthy();
    // 무엇을 지우는지 창이 말한다 — 겹창은 행에서 떨어져 있어서 이것이 없으면
    // 목록을 훑던 사람이 어느 메시지에 확인을 준 것인지 모른다.
    expect(within(dialog).getByText('지울 메시지')).toBeTruthy();
    // 툴바는 그대로다. 확인이 툴바 안에 있으면 이 단언이 깨진다.
    expect(within(toolbar).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(c.deleteMessage).not.toHaveBeenCalled();
  });

  it('requires second confirmation to delete', async () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete message?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(c.deleteMessage).toHaveBeenCalledWith('m1'));
  });

  it('cancels without deleting — 취소 버튼', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Delete message?' })).toBeNull();
    expect(c.deleteMessage).not.toHaveBeenCalled();
  });

  /**
   * Esc 로 닫힌다 — `Overlay` 가 document 리스너로 준다. 여기서 재는 이유는, 확인창이
   * `Overlay` 를 벗고 자체 마크업으로 돌아가는 순간 이 경로가 조용히 없어지기 때문이다.
   */
  it('cancels on Escape', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Delete message?' })).toBeNull();
    expect(c.deleteMessage).not.toHaveBeenCalled();
  });

  /**
   * 열리자마자 손가락은 **취소** 위에 있다. 확인창을 띄운 줄 모르고 Enter 를 친 사람이
   * 그대로 지우면 확인 단계를 둔 이유가 사라진다.
   */
  it('focuses the safe choice when it opens', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });
});

describe('reply count visibility', () => {
  // #161 2단계: 서버의 replyCount 를 쓴다 — 스토어에 답글을 넣지 않고 replyCount 만 준 루트가
  // 그 수를 보여준다. 클라이언트 계산 제거를 지키는 선이다.
  it('shows reply count from server without hover when replies exist', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    expect(screen.getByRole('button', { name: '답글 2개' })).toBeTruthy();
  });

  // replyCount 가 null 이면(루트가 아니거나 답글 없는 루트) 본문 아래 pill 은 안 나오고,
  // 대신 호버 툴바에 스레드 진입 아이콘이 뜬다(#396).
  it('shows thread entry icon in toolbar on hover when replyCount is null', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: null })} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: '스레드에 답글 달기' })).toBeTruthy();
  });

  // #396 회귀선: 답글이 없는 메시지는 본문 아래에 'Reply in thread' 테두리 버튼이 없다 —
  // 답글이 달린 뒤의 pill 과 같은 자리·같은 모양으로 보이던 문제를 없앤 것이 이 이슈의 핵심이다.
  it('does not show a below-body Reply in thread button when replyCount is null', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: null })} />);

    expect(screen.queryByRole('button', { name: 'Reply in thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^\d+ repl(y|ies)/ })).toBeNull();
  });

  // #396 회귀선: 답글이 있는 메시지의 pill 은 손대지 않는다 — 툴바로 올라가지 않고
  // 본문 아래에 그대로 상시 노출된다(#161 2단계).
  /**
   * 2026-09-09: 요약 줄은 **그대로 본문 열**에 있고(그 자리를 옮기면 `#143` 이 되살아난다),
   * 툴바의 스레드 칸은 이제 **답글이 있어도 함께 선다.** 두 자리는 다른 질문에 답한다 —
   * 툴바는 "답한다"(행동), 요약 줄은 "답글 3개가 달렸다"(상태). 앞 판은 값에 따라 둘 중
   * 하나만 세워서, 사람이 손 갈 자리를 배울 수 없었다(`zeroReplies.test.tsx` 가 그 셈을
   * 뒤집은 자리다).
   */
  it('답글이 있는 메시지: 요약 줄은 본문 열에, 스레드 칸은 툴바에 — 둘 다 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 3 })} />);

    const pillBtn = screen.getByRole('button', { name: /답글 3개/ });
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    expect(toolbar.contains(pillBtn)).toBe(false);
    expect(within(toolbar).getByTestId('toolbar-thread')).toBeTruthy();
  });

  // #396: inThread 에서는 스레드 안에서 또 스레드를 열 수 없으므로 pill 도, 툴바 아이콘도
  // 둘 다 그려지지 않는다.
  it('shows neither the pill nor the toolbar thread icon when inThread', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '답글', 'u1', { replyCount: null })} inThread />);

    expect(screen.queryByRole('button', { name: 'Reply in thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: '스레드에 답글 달기' })).toBeNull();

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    expect(within(toolbar).queryByRole('button', { name: '스레드에 답글 달기' })).toBeNull();
  });
});

describe('edit mode hides toolbar', () => {
  it('hides toolbar while editing', () => {
    const c = fakeController();
    useAppStore.getState().set({
      messages: { c1: [msg('m1', 'c1', 1, '원문', 'u1')] },
    });
    render(<MessageItem message={msg('m1', 'c1', 1, '원문', 'u1')} />);

    const toolbarBefore = screen.getByRole('toolbar', { name: 'message toolbar' });
    expect(toolbarBefore).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    const toolbarAfter = screen.queryByRole('toolbar', { name: 'message toolbar' });
    expect(toolbarAfter).toBeNull();
  });
});

describe('toolbar accessibility', () => {
  it('hides toolbar with opacity, not display:none or visibility:hidden', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    expect(toolbar.className).toMatch(/opacity-0/);
    expect(toolbar.className).not.toMatch(/hidden|visibility/);
  });
});
describe('#143/#254 답글 컨트롤과 툴바가 다른 컨테이너에 있다', () => {
  // #254 이후 답글 컨트롤이 본문 열(	flex-1)로 이동하고 툴바는 오른쪽 열(relative)에
  // 별도로 놓인다. 둘이 다른 컨테이너에 있어 구조적으로 겹칠 수 없으므로, #143 의
  // "호버 툴바가 답글 컨트롤을 덮는다"는 문제가 더 이상 발생하지 않는다.
  //
  // jsdom 에는 레이아웃 엔진이 없다 — rect 는 전부 0이고 Tailwind 도 로드되지 않아 겹침을
  // 픽셀로 볼 수 없다. 그래서 DOM 구조로 단언한다: 답글 버튼은 본문 열 안에, 툴바는
  // 오른쪽 열 안에. 하나라도 되돌리면(예: 답글 버튼을 다시 오른쪽 열로 복귀) 이 테스트가 빨개진다.
  it('답글 버튼은 본문 열 안에, 툴바는 오른쪽 열 안에 있다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    const replyBtn = screen.getByRole('button', { name: '답글 2개' });

    // 답글 버튼과 툴바가 다른 부모를 갖는다 (다른 컨테이너)
    expect(toolbar.parentElement).not.toBe(replyBtn.parentElement);

    // 답글 버튼은 본문 열(	min-w-0 flex-1) 안에
    const mainColumn = document.querySelector('.min-w-0.flex-1');
    expect(mainColumn?.contains(replyBtn)).toBe(true);

    // 툴바는 오른쪽 열(relative flex shrink-0 items-start gap-1) 안에
    const rightColumn = document.querySelector('.relative.flex.shrink-0.items-start.gap-1');
    expect(rightColumn?.contains(toolbar)).toBe(true);
  });

  it('inThread=true 이면 답글 버튼이 없고 툴바만 오른쪽 열에 있다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '답글', 'u1')} inThread />);

    // 답글 버튼이 없어야 함
    expect(screen.queryByRole('button', { name: /repl(y|ies)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply in thread' })).toBeNull();

    // 툴바는 여전히 오른쪽 열에 있다
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    const rightColumn = document.querySelector('.relative.flex.shrink-0.items-start.gap-1');
    expect(rightColumn?.contains(toolbar)).toBe(true);
  });
});

describe('#145 인라인 이모지 버튼', () => {
  it('툴바에 인라인 이모지 버튼이 3개 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    // 셋이 무엇인지는 `Reactions.INLINE` 한 곳이 정한다(2026-09-09 에 요청받은 순서).
    expect(within(toolbar).getByRole('button', { name: 'React with ✅' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with 👀' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with 👍' })).toBeTruthy();
  });

  it('💬 는 인라인에 없다 — 창에만 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    // 👀 는 2026-09-09 에 요청으로 인라인에 올라갔다(사람이 "보고 있다"를 말하는 가장
    // 자연스러운 그림이다). **💬 는 올리지 않는다** — 상태 신호이면서 바로 옆 스레드
    // 칸과 뜻이 겹친다. 그것이 #144 규칙의 남은 절반이다.
    const inlineEmojis = within(toolbar).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(inlineEmojis).toContain('React with 👀');
    expect(inlineEmojis.some((l) => l === 'React with 💬')).toBe(false);

    // 창에는 둘 다 있다.
    fireEvent.click(within(toolbar).getByRole('button', { name: /Add reaction/ }));
    expect(within(toolbar).getByRole('button', { name: '👀' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '💬' })).toBeTruthy();
  });

  it('＋ 피커는 그대로 있고, 그 안에는 👀💬 가 남아 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    // ＋ 버튼이 있다
    expect(within(toolbar).getByRole('button', { name: /＋|Add reaction/ })).toBeTruthy();

    // 피커를 열면 👀💬 가 있다
    fireEvent.click(within(toolbar).getByRole('button', { name: /＋|Add reaction/ }));
    const pickerButtons = within(toolbar).getAllByRole('button');
    expect(pickerButtons.some((b) => b.textContent === '👀')).toBe(true);
    expect(pickerButtons.some((b) => b.textContent === '💬')).toBe(true);
  });
});

/**
 * **여덟 칸의 순서**(요청 2026-09-09 — 순서를 글로 지정받았다).
 *
 * 자리를 요청받았으므로 **자리를 잰다.** 이름이나 개수만 재면 순서가 바뀌어도 초록이고,
 * 순서가 곧 이 요청의 내용이었다: 리액션 셋 → 이모지 고르기 → (구분선) → 스레드 →
 * 링크 복사 → 담기 → (구분선) → 더 보기.
 *
 * DOM 순서로 재는 이유: `data-slot` 은 툴바가 화살표 이동에 쓰는 목록과 **같은 것**이라
 * (`MessageToolbar` 의 `onArrow`), 여기서 순서를 지키면 키보드 순서도 함께 지켜진다.
 */
describe('툴바 여덟 칸 (2026-09-09)', () => {
  const slots = (): (string | null)[] => {
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });
    return Array.from(toolbar.querySelectorAll<HTMLElement>('[data-slot]'))
      .map((el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label'));
  };

  it('채널에서는 여덟 칸이 요청받은 순서로 선다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);

    expect(slots()).toEqual([
      'toolbar-react-✅', 'toolbar-react-👀', 'toolbar-react-👍', 'toolbar-react-pick',
      'toolbar-thread', 'toolbar-copy-link', 'toolbar-save', 'More actions',
    ]);
  });

  it('스레드 안에서는 스레드 칸만 빠지고 나머지 일곱의 순서는 그대로다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} inThread />);

    expect(slots()).toEqual([
      'toolbar-react-✅', 'toolbar-react-👀', 'toolbar-react-👍', 'toolbar-react-pick',
      'toolbar-copy-link', 'toolbar-save', 'More actions',
    ]);
  });

  /**
   * 앞 판은 `＋` 를 누르면 피커가 **자기 자리에서** 이모지 줄로 바뀌어, 툴바의 다른 칸들이
   * 커서 아래에서 좌우로 밀려났다. 창이 위로 뜨는 것의 요점이 이것이라 **자리 여덟이
   * 흔들리지 않는지**를 잰다 — 창이 열렸다는 사실만 재면 그 결함이 돌아와도 초록이다.
   */
  it('창을 열어도 여덟 칸의 순서가 흔들리지 않는다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);
    const before = slots();

    fireEvent.click(screen.getByTestId('toolbar-react-pick'));

    expect(screen.getByTestId('reaction-picker-panel')).toBeTruthy();
    expect(slots()).toEqual(before);
  });

  /**
   * 창이 열려 있는 동안 툴바는 **붙잡혀 있어야** 한다. 툴바는 호버로만 보이고 창은 그
   * 자식이라, 창을 향해 마우스를 옮기다 행을 벗어나면 창째 사라진다 — jsdom 은 호버를
   * 재현하지 않으므로 무엇을 잰다는 것을 분명히 해 둔다: **불투명도를 잠그는 표식**이다.
   */
  it('창이 열려 있으면 툴바가 고정 노출된다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });

    expect(toolbar.getAttribute('data-open')).toBe('false');
    expect(toolbar.className).toMatch(/data-\[open=true\]:opacity-100/);

    fireEvent.click(screen.getByTestId('toolbar-react-pick'));
    expect(toolbar.getAttribute('data-open')).toBe('true');
  });

  /**
   * **키보드로 툴바가 보인다.** 앞 판은 `focus-visible:opacity-100` 을 컨테이너에 걸어
   * 두었는데 그 컨테이너는 포커스를 받을 수 없어서 규칙이 한 번도 켜지지 않았다 — 버튼은
   * 접근성 트리에 있고 눌리는데 **보이지 않는** 상태였다. 고친 것은 `group-focus-within` 이고,
   * 그 변형은 행(`group`)에 달린 자손 포커스를 받는다.
   */
  it('툴바는 행의 자손 포커스로도 드러난다 (group-focus-within)', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });

    expect(toolbar.className).toMatch(/\bopacity-0\b/);
    expect(toolbar.className).toMatch(/group-focus-within:opacity-100/);
    // 포커스를 지우는 방식(`invisible`·`hidden`)으로 숨기지 않는다 — 접근성 트리에서
    // 요소가 사라지면 키보드 경로가 없어진다.
    expect(toolbar.className).not.toMatch(/\binvisible\b/);
    expect(toolbar.className).not.toMatch(/\bhidden\b/);
  });

  it('좌우 화살표로 칸을 옮긴다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });

    const first = screen.getByTestId('toolbar-react-✅');
    first.focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('toolbar-react-👀'));

    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });

  it('담긴 메시지는 같은 칸이 눌린 상태로 그려진다', () => {
    fakeController();
    useAppStore.getState().set({ savedIds: ['m1'] });
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);

    const save = screen.getByTestId('toolbar-save');
    expect(save.getAttribute('aria-pressed')).toBe('true');
    expect(save.getAttribute('aria-label')).toBe('담은 것 빼기');
  });

  /**
   * **칸이 서로 붙어 있지 않다**(신고 2026-09-10: "너무 따닥따닥 붙어있어").
   *
   * jsdom 은 레이아웃을 재지 않으므로 픽셀을 잴 수는 없다. 그래서 재는 것은 **값**이다 —
   * 되돌아가면 안 되는 두 가지: 칸 사이가 1px(`gap-px`)로 돌아가는 것과, 과녁이 24px
   * (`h-6 w-6`)로 줄어드는 것. 이 둘이 함께 있었을 때 그림 사이가 9px 이라 겨눈 칸을
   * 지나치면 옆 칸이 눌렸고, 옆 칸은 '담기'와 '⋯' 였다.
   */
  it('툴바 칸은 4px 씩 벌어지고 과녁은 28px 이다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'hello', 'u2')} />);
    const toolbar = screen.getByRole('toolbar', { name: 'message toolbar' });

    expect(toolbar.className).toMatch(/\bgap-1\b/);
    expect(toolbar.className).not.toMatch(/\bgap-px\b/);

    for (const id of ['toolbar-react-✅', 'toolbar-react-pick', 'toolbar-copy-link', 'toolbar-save']) {
      const cls = screen.getByTestId(id).className;
      expect(cls).toMatch(/\bh-7\b/);
      expect(cls).toMatch(/\bw-7\b/);
    }
  });
});

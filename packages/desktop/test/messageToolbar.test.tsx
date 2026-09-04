import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
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
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    messages: { c1: [] },
  });
});
afterEach(() => cleanup());

describe('message toolbar', () => {
  it('shows reaction trigger in toolbar on hover for own message', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: /Add reaction|＋/ })).toBeTruthy();
  });

  // #396: 답글이 없는 메시지의 스레드 진입점은 본문 아래 버튼이 아니라 호버 툴바의
  // 아이콘이다 — 접근 가능한 이름은 aria-label(그리고 같은 문구의 title)로 남는다.
  it('shows thread trigger in toolbar on hover', () => {
    const c = fakeController();
    useAppStore.getState().set({ messages: { c1: withReplies(0) } });
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: '스레드에 답글 달기' })).toBeTruthy();
  });

  it('shows overflow menu trigger on hover', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: 'More actions' })).toBeTruthy();
  });
});

describe('overflow menu permissions', () => {
  it('shows Edit and Delete in overflow menu for own message', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '내 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
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

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));

    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  // 항목이 하나도 없으면 트리거를 아예 만들지 않는다 — 열어도 비어 있는 메뉴는
  // "할 수 있는 게 있다"는 거짓 신호다(design.md §4).
  // #178: 그 가드는 코드에 그대로 남아 있지만 실제로 걸리지는 않는다 — "Copy link" 는
  // 어떤 메시지에도 있어 메뉴가 비지 않는다. 그래서 여기서 세는 것은 **항목의 내용**이다.
  it('남의 메시지에는 고치기·지우기가 없다 (링크 복사만 남는다)', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '남의 메시지', 'u2')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    // 리액션은 남의 메시지에도 달 수 있다.
    expect(within(toolbar).getByRole('button', { name: 'Add reaction' })).toBeTruthy();
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

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    expect(screen.getByDisplayValue('원문')).toBeTruthy();
  });

  it('shows confirmation state when Delete is clicked', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(screen.getByRole('button', { name: 'Really delete' })).toBeTruthy();
    expect(c.deleteMessage).not.toHaveBeenCalled();
  });

  it('requires second confirmation to delete', async () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '지울 메시지', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Really delete' }));

    await waitFor(() => expect(c.deleteMessage).toHaveBeenCalledWith('m1'));
  });
});

describe('reply count visibility', () => {
  // #161 2단계: 서버의 replyCount 를 쓴다 — 스토어에 답글을 넣지 않고 replyCount 만 준 루트가
  // 그 수를 보여준다. 클라이언트 계산 제거를 지키는 선이다.
  it('shows reply count from server without hover when replies exist', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    expect(screen.getByRole('button', { name: '2 replies' })).toBeTruthy();
  });

  // replyCount 가 null 이면(루트가 아니거나 답글 없는 루트) 본문 아래 pill 은 안 나오고,
  // 대신 호버 툴바에 스레드 진입 아이콘이 뜬다(#396).
  it('shows thread entry icon in toolbar on hover when replyCount is null', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: null })} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
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
  it('keeps the below-body pill for messages with replies (unchanged, not moved to toolbar)', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 3 })} />);

    const pillBtn = screen.getByRole('button', { name: /3 replies/ });
    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    expect(toolbar.contains(pillBtn)).toBe(false);
    expect(within(toolbar).queryByRole('button', { name: '스레드에 답글 달기' })).toBeNull();
  });

  // #396: inThread 에서는 스레드 안에서 또 스레드를 열 수 없으므로 pill 도, 툴바 아이콘도
  // 둘 다 그려지지 않는다.
  it('shows neither the pill nor the toolbar thread icon when inThread', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '답글', 'u1', { replyCount: null })} inThread />);

    expect(screen.queryByRole('button', { name: 'Reply in thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: '스레드에 답글 달기' })).toBeNull();

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
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

    const toolbarBefore = screen.getByRole('group', { name: 'message toolbar' });
    expect(toolbarBefore).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    const toolbarAfter = screen.queryByRole('group', { name: 'message toolbar' });
    expect(toolbarAfter).toBeNull();
  });
});

describe('toolbar accessibility', () => {
  it('hides toolbar with opacity, not display:none or visibility:hidden', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
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

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    const replyBtn = screen.getByRole('button', { name: '2 replies' });

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
    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    const rightColumn = document.querySelector('.relative.flex.shrink-0.items-start.gap-1');
    expect(rightColumn?.contains(toolbar)).toBe(true);
  });
});

describe('#145 인라인 이모지 버튼', () => {
  it('툴바에 인라인 이모지 버튼이 3개 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    expect(within(toolbar).getByRole('button', { name: 'React with 👍' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with 🎉' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with ✅' })).toBeTruthy();
  });

  it('👀 와 💬 는 인라인에 없다 — 피커에만 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    // 피커를 열기 전에 인라인 버튼들을 확인 - 👀💬 가 없어야 한다
    const inlineButtons = within(toolbar).getAllByRole('button');
    const inlineEmojis = inlineButtons.map((b) => b.getAttribute('aria-label'));
    expect(inlineEmojis.some((l) => l === 'React with 👀' || l === 'React with 💬')).toBe(false);

    // 이제 피커를 열고 👀💬 가 있는지 확인
    fireEvent.click(within(toolbar).getByRole('button', { name: /Add reaction/ }));

    expect(within(toolbar).getByRole('button', { name: /👀/ })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: /💬/ })).toBeTruthy();
  });

  it('＋ 피커는 그대로 있고, 그 안에는 👀💬 가 남아 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
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

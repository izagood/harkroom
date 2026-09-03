import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
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

  it('shows thread trigger in toolbar on hover', () => {
    const c = fakeController();
    useAppStore.getState().set({ messages: { c1: withReplies(0) } });
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2')} />);

    const message = screen.getByText('root').closest('.group') as HTMLElement;
    fireEvent.mouseEnter(message);

    expect(within(message).getByRole('button', { name: 'Reply in thread' })).toBeTruthy();
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
  it('권한이 없으면 ⋯ 트리거 자체가 없다 (빈 메뉴를 열지 않는다)', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '남의 메시지', 'u2')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    expect(within(toolbar).queryByRole('button', { name: 'More actions' })).toBeNull();
    // 리액션은 남의 메시지에도 달 수 있다.
    expect(within(toolbar).getByRole('button', { name: 'Add reaction' })).toBeTruthy();
  });

  it('shows no Edit/Delete for system message', () => {
    const c = fakeController();
    render(<MessageItem message={{ ...msg('m1', 'c1', 1, '시스템', 'u1'), kind: 'system' }} />);

    const moreActions = screen.queryByRole('button', { name: 'More actions' });
    expect(moreActions).toBeNull();
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

  // replyCount 가 null 이면(루트가 아니거나 답글 없는 루트) 답글 컨트롤이 안 나온다.
  it('shows Reply in thread on hover when replyCount is null', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: null })} />);

    const message = screen.getByText('root').closest('.group')!;
    fireEvent.mouseEnter(message);

    expect(screen.getByRole('button', { name: 'Reply in thread' })).toBeTruthy();
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
describe('#143 호버 툴바가 답글 컨트롤을 덮지 않는다', () => {
  // 답글 pill 은 답글이 있으면 **상시** 보여야 해서 흐름 안 우상단에 있고(MessageItem 주석이
  // 그 이유를 적어 뒀다), 툴바는 절대 배치다. 둘이 같은 기준(행)에 앵커되면 같은 자리를
  // 다투고, 호버하는 순간 툴바가 pill 을 덮어 **스레드 진입 경로가 사라진다**.
  //
  // jsdom 에는 레이아웃 엔진이 없다 — rect 는 전부 0이고 Tailwind 도 로드되지 않아 겹침을
  // 픽셀로 볼 수 없다. 그래서 아래 셋을 함께 고정한다: ① 툴바의 containing block 이 답글
  // 컨트롤이고 ② 그 컨테이너가 positioned 이며 ③ 툴바가 `right-full` 로 푼다. 하나만
  // 되돌려도(예: 행 기준 `right-3` 복귀) 이 테스트가 빨개진다.
  it('툴바의 기준은 행이 아니라 답글 컨트롤 컨테이너다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    const replyBtn = screen.getByRole('button', { name: '2 replies' });

    // ① 같은 부모 = 같은 containing block. 행에 앵커돼 있으면 부모가 다르다.
    expect(toolbar.parentElement).toBe(replyBtn.parentElement);
    // ② 그 부모가 positioned 여야 `right-full` 이 pill 기준으로 풀린다.
    expect(toolbar.parentElement!.className).toMatch(/\brelative\b/);
    // ③ 우측 끝을 pill 의 좌측에 맞춘다. pill 텍스트 폭이 변해도 비겹침이 유지되는 이유다.
    expect(toolbar.className).toMatch(/\bright-full\b/);
  });

  it('스레드 안에서도 툴바는 같은 컨테이너 안에 남는다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '답글', 'u1')} inThread />);

    // inThread 면 답글 pill 자체가 없다. 컨테이너는 폭 0으로 남고 툴바는 그 좌측에
    // 붙어 행 우측 끝에 놓인다 — 덮을 pill 이 없으니 이전 동작과 같다.
    expect(screen.queryByRole('button', { name: /repl/i })).toBeNull();
    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    expect(toolbar.parentElement!.className).toMatch(/\brelative\b/);
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

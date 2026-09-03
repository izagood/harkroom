import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
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

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    messages: { c1: [] },
  });
});
afterEach(() => cleanup());

describe('#254 답글 컨트롤 위치 변경', () => {
  // 회귀선 1: 답글 컨트롤이 본문 열 안, 리액션 다음에 온다
  it('답글 컨트롤이 본문 열(Reactions 다음)에 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const replyBtn = screen.getByRole('button', { name: '2 replies' });
    const reactions = document.querySelector('[data-testid="reactions"]');

    // 답글 버튼이 reactions 다음에 DOM 에 있다
    if (reactions) {
      expect(reactions.compareDocumentPosition(replyBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  // 회귀선 2: 답글 컨트롤과 호버 툴바가 다른 컨테이너에 있다 (구조적 비겹침)
  it('답글 컨트롤과 툴바가 다른 컨테이너에 있어 겹칠 수 없다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    const replyBtn = screen.getByRole('button', { name: '2 replies' });

    // 답글 버튼과 툴바가 다른 부모를 갖는다 (다른 컨테이너)
    expect(toolbar.parentElement).not.toBe(replyBtn.parentElement);

    // 답글 버튼은 본문 열(	min-w-0 flex-1) 안에, 툴바는 오른쪽 열(relative) 안에
    const mainColumn = document.querySelector('.min-w-0.flex-1');
    const rightColumn = document.querySelector('.relative.flex.shrink-0.items-start.gap-1');

    expect(mainColumn?.contains(replyBtn)).toBe(true);
    expect(rightColumn?.contains(toolbar)).toBe(true);
  });

  // 회귀선 3: 답글이 있으면 호버 없이 pill 이 보인다
  it('답글이 있으면 호버 없이 답글 pill 이 보인다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    // 호버 없이 답글 버튼이 보여야 함
    expect(screen.getByRole('button', { name: '2 replies' })).toBeTruthy();
  });

  // 회귀선 4: 답글이 없으면 "Reply in thread" 가 opacity 로 숨고 visibility 로 숨지 않는다
  it('"Reply in thread" 가 opacity 로 숨고 visibility:hidden 이 아니다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: null })} />);

    // 버튼이 DOM 에 있지만 opacity-0 으로 숨겨져 있다
    const replyBtn = screen.getByRole('button', { name: 'Reply in thread' });
    expect(replyBtn).toBeTruthy();

    // opacity-0 클래스가 있어야 하고, visibility 가 없어야 함
    expect(replyBtn.className).toMatch(/\bopacity-0\b/);
    expect(replyBtn.className).not.toMatch(/visibility/);

    // 호버 후에는 opacity-100 이 되어 보여야 함
    const message = screen.getByText('root').closest('.group')!;
    fireEvent.mouseEnter(message);
    expect(replyBtn.className).toMatch(/group-hover:opacity-100/);
  });

  // 회귀선 5: 툴바의 기존 동작(리액션 피커, ⋯ 메뉴, 인라인 리액션)이 그대로다
  it('툴바에 리액션 피커, 메뉴, 인라인 리액션이 모두 있다', () => {
    const c = fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '테스트', 'u1')} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });
    fireEvent.mouseEnter(toolbar);

    // 인라인 이모지 버튼 3개
    expect(within(toolbar).getByRole('button', { name: 'React with 👍' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with 🎉' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'React with ✅' })).toBeTruthy();

    // 피커
    expect(within(toolbar).getByRole('button', { name: /Add reaction|＋/ })).toBeTruthy();

    // 메뉴
    expect(within(toolbar).getByRole('button', { name: 'More actions' })).toBeTruthy();
  });

  // 회귀선 6: 스레드 패널(inThread) 안에서는 답글 컨트롤이 없다
  it('inThread=true 이면 답글 컨트롤이 없다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'reply', 'u2', { replyCount: 2 })} inThread />);

    // 답글 버튼이 없어야 함
    expect(screen.queryByRole('button', { name: /repl(y|ies)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply in thread' })).toBeNull();
  });
});

describe('#254 툴바 앵커 변경 (#145 관련)', () => {
  it('툴바가 right-full 이 아니라 right-2 top-1 로 앵커된다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 2 })} />);

    const toolbar = screen.getByRole('group', { name: 'message toolbar' });

    // right-full 이 아니어야 함
    expect(toolbar.className).not.toMatch(/\bright-full\b/);
    // right-2 top-1 이어야 함
    expect(toolbar.className).toMatch(/\bright-2\b/);
    expect(toolbar.className).toMatch(/\btop-1\b/);
  });
});
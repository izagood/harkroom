import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { Identity } from '../src/components/Identity';
import { acc, msg } from './helpers/fakeApi';

// #277: 에이전트 메시지의 소유자 @핸들이 아바타 거터를 넘치는 문제를 고친다.
// Identity 에 variant prop 을 추가해 avatar(거터)와 badge(이름 옆) 자리를 명시한다.

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

const agent = (id: string, handle: string, ownerAccountId: string | null) =>
  ({ ...acc(id, handle, 'agent'), ownerAccountId });

beforeEach(() => {
  useAppStore.getState().reset();
});
afterEach(() => cleanup());

describe('#277 에이전트 거터 넘침 방지', () => {
  // 회귀 테스트 1: 에이전트 작성자의 거터 Identity 에 소유자 핸들 텍스트가 없다
  it('에이전트 거터에 소유자 핸들이 없다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 거터의 Identity (variant=avatar) 를 찾는다 — 첫 번째 에이전트 표시의 부모
    const agentGlyphs = screen.getAllByText('에이전트');
    const gutterGlyph = agentGlyphs[0]!; // 첫 번째는 거터

    // 거터의 부모 span 을 찾고 그 안에 @owner 가 없는지 확인
    const gutterParent = gutterGlyph.parentElement!;
    expect(gutterParent.textContent).not.toContain('@owner');
  });

  // 회귀 테스트 2: 사람 작성자의 거터는 지금과 같다(둥근 아바타, 이미지 있으면 이미지)
  it('사람 거터는 둥근 아바타가 그대로 보인다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'alice') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    // 거터 컨테이너를 className으로 직접 찾는다
    const gutterContainer = document.querySelector('.flex.h-8.w-8');
    expect(gutterContainer).toBeTruthy();

    // 거터 안의 Identity span을 찾고 rounded 클래스가 있는지 확인
    const gutterIdentity = gutterContainer?.querySelector('span[class*="inline-flex"]');
    expect(gutterIdentity).toBeTruthy();
    // avatar variant는 overflow-hidden이 있다
    expect(gutterIdentity?.classList.contains('overflow-hidden')).toBe(true);
  });

  // 회귀 테스트 3: 이름 옆 배지에는 여전히 @소유자가 있다 (#181 유지)
  it('이름 옆 배지에 소유자 핸들이 있다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 이름 줄의 Identity (variant=badge) 를 찾는다 — 두 번째 에이전트 표시
    const agentGlyphs = screen.getAllByText('에이전트');
    const nameLineGlyph = agentGlyphs[1]!; // 두 번째는 이름 줄

    // 이름 줄의 부모 span 을 찾고 그 안에 @owner 가 있는지 확인
    const nameLineParent = nameLineGlyph.parentElement!;
    expect(nameLineParent.textContent).toContain('@owner');
  });

  // 회귀 테스트 4: 거터 요소에 overflow-hidden 이 있고 flex-wrap 이 없다
  it('거터 Identity 에 overflow-hidden 이 있고 flex-wrap 이 없다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 에이전트 글리프를 찾는다 (거터에 있는 첫 번째)
    const agentGlyphs = screen.getAllByText('에이전트');
    const gutterGlyph = agentGlyphs[0]!;
    const gutterSpan = gutterGlyph.parentElement!;

    // avatar variant 에는 overflow-hidden 이 있어야 하고 flex-wrap 이 없어야 한다
    expect(gutterSpan.classList.contains('overflow-hidden')).toBe(true);
    expect(gutterSpan.classList.contains('flex-wrap')).toBe(false);
  });

  // 회귀 테스트 5: 스레드 패널의 에이전트 답변 거터도 1과 같다
  it('스레드 패널의 에이전트 거터에도 소유자 핸들 없다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    // inThread=true 로 스레드 내 메시지를 렌더링
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} inThread={true} />);

    // 거터의 Identity 에 소유자 핸들이 없는지 확인
    const agentGlyphs = screen.getAllByText('에이전트');
    const gutterGlyph = agentGlyphs[0]!;
    const gutterParent = gutterGlyph.parentElement!;
    expect(gutterParent.textContent).not.toContain('@owner');
  });
});

describe('#277 Identity variant 구분', () => {
  it('variant="avatar" 인 에이전트는 소유자 없이 글리프만 표시', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    render(<Identity account={agent('a1', 'bot', 'u1')} variant="avatar" />);

    // avatar variant: 글리프는 있지만 owner는 없다
    expect(screen.getByText('🤖')).toBeTruthy();
    expect(screen.queryByText('@owner')).toBeNull();
  });

  it('variant="badge" 인 에이전트는 소유자까지 전부 표시', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    render(<Identity account={agent('a1', 'bot', 'u1')} variant="badge" />);

    // badge variant: 글리프와 owner 모두 있다
    expect(screen.getByText('🤖')).toBeTruthy();
    expect(screen.getByText('@owner')).toBeTruthy();
  });

  it('variant 기본값은 badge 다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    // variant 없이 렌더링 = badge 와 같은 동작
    render(<Identity account={agent('a1', 'bot', 'u1')} />);

    expect(screen.getByText('@owner')).toBeTruthy();
  });
});
/**
 * **스레드도 늦게 자라는 내용까지 따라간다.**
 *
 * 보고(jaebin, 2026-09-10): "스레드 열었을 때 가장 최근 댓글로 열리는 기능이 개발된 것으로
 * 알고 있는데 제대로 동작 안 해."
 *
 * 원인은 **두 PR 이 갈린 것**이었다. #691 이 `ThreadPanel` 에 넣은 것은 효과 둘(열 때 ·
 * 답글 수가 늘 때)뿐이었는데, 바로 다음 날 #693 이 채널에서 **같은 증상**을 고치며 더한
 * 셋 — 그리기 전 이동(`useLayoutEffect`) · 관찰자 보정 · `stickyRef` — 이 이 파일에는
 * 오지 않았다. 그래서 채널만 고쳐지고 스레드에는 증상이 남았다.
 *
 * 줄 수가 그대로인 채 높이가 자라는 길은 스레드에서 오히려 잦다: 첨부 그림은 URL 을
 * 받아온 뒤에야 `<img>` 가 생기고(`Attachments.tsx`), 링크 카드도 fetch 뒤에 붙고
 * (`MessageBody` → `LinkPreview`), 접힌 진행·주고받기가 펴진다. 바닥으로 내려간 뒤 그것들이
 * 자라면 **스크롤 이벤트는 일어나지 않으므로**(사람이 움직인 것이 아니다) 화면은 그 자리에
 * 남고, 자란 높이가 그대로 "내려가야 하는 거리"가 된다.
 *
 * 이 파일이 붙잡는 규율은 채널의 `stickyBottomGrowth.test.tsx` 와 같다:
 *  1. 관찰자는 **스크롤 상자**를 기준으로 바닥 표식을 지켜본다(창이 아니다).
 *  2. 바닥에 붙어 있으면 표식이 벗어나는 순간 따라 내려간다.
 *  3. 위를 보고 있으면 건드리지 않는다 — 읽던 자리를 빼앗지 않는 규율(#691)은 그대로다.
 *  4. 브라우저의 스크롤 앵커링이 옮긴 것은 "사람이 올렸다"로 치지 않는다.
 *  5. 패널이 닫힌 상태에서 시작해 스레드를 열어도 보정이 붙는다(딸림값이 살아 있는가).
 *
 * jsdom 에는 `IntersectionObserver` 가 없다(제품 코드가 `typeof` 로 확인하는 이유다).
 * 여기서 심어 두고 콜백을 손으로 부른다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';

const root = () => msg('m1', 'c1', 1, '뿌리', 'u2');
const reply = (id: string, seq: number, author: string) =>
  msg(id, 'c1', seq, `답글 ${id}`, author, { threadRootId: 'm1' });

interface Watch {
  callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  root: Element | null;
  targets: Element[];
}
let watches: Watch[] = [];

beforeEach(() => {
  setController({
    reply: vi.fn(async () => undefined),
    closeThread: vi.fn(),
    openThread: vi.fn(),
  } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    activeChannelId: 'c1',
    threadRootId: 'm1',
    messages: { c1: [root(), reply('m2', 2, 'u2')] },
  });

  watches = [];
  class FakeObserver {
    private watch: Watch;
    constructor(callback: Watch['callback'], options?: { root?: Element | Document | null }) {
      this.watch = { callback, root: (options?.root as Element | null) ?? null, targets: [] };
      watches.push(this.watch);
    }
    observe(target: Element): void { this.watch.targets.push(target); }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

/** `scrollIntoView` 는 jsdom 에 없다 — 불렸는지 재려면 우리가 놓아 줘야 한다. */
const spyScroll = () => {
  const fn = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = fn;
  return fn;
};

/** 상자의 크기를 세운다(내용 2000px, 창 500px — 바닥은 `scrollTop` 1500 이다). */
const sizeBox = (el: HTMLElement) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 1500 });
};

/** 지금 자리를 상자에 알린다(브라우저의 scroll 이벤트 한 번). */
const scrollTo = (el: HTMLElement, top: number) => {
  (el as unknown as { scrollTop: number }).scrollTop = top;
  fireEvent.scroll(el);
};

/** **사람이 위로 올린다.** 사람이 한 일의 표식은 `scrollTop` 이 줄어드는 것이다. */
const lookUp = (el: HTMLElement) => {
  sizeBox(el);
  scrollTo(el, 1500);
  scrollTo(el, 0);
};

/** 그림·미리보기가 늦게 붙어 바닥 표식이 상자 밖으로 밀려났다. */
const grewBelow = () => {
  for (const w of watches) w.callback([{ isIntersecting: false }]);
};

describe('스레드에서 늦게 자라는 내용', () => {
  it('바닥 표식을 스크롤 상자 기준으로 지켜본다', () => {
    render(<ThreadPanel />);
    expect(watches.length).toBe(1);
    // 창을 기준으로 하면(root 가 null) 이 보정은 조용히 아무 일도 하지 않는다.
    expect(watches[0]!.root).toBe(screen.getByTestId('thread-scroll'));
    expect(watches[0]!.targets).toContain(screen.getByTestId('thread-bottom'));
  });

  it('바닥에 붙어 있으면 자란 만큼 따라 내려간다', () => {
    render(<ThreadPanel />);
    // jsdom 의 기본값(수치가 전부 0)이 곧 "바닥에 붙어 있다"다.
    const scrollIntoView = spyScroll();
    grewBelow();

    // 인자를 빼면 앱 껍데기까지 끌려 올라간다(`shellScroll.test.tsx`).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('위를 읽는 중이면 자라도 화면을 옮기지 않는다', () => {
    render(<ThreadPanel />);
    lookUp(screen.getByTestId('thread-scroll'));

    const scrollIntoView = spyScroll();
    grewBelow();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('바닥이 이미 보이면 아무 일도 하지 않는다', () => {
    render(<ThreadPanel />);
    const scrollIntoView = spyScroll();
    for (const w of watches) w.callback([{ isIntersecting: true }]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  /**
   * **브라우저가 옮긴 스크롤로 고정이 풀리지 않는다.** 화면 위쪽 답글에 그림이 붙으면
   * 스크롤 앵커링이 보이던 자리를 붙잡느라 `scrollTop` 을 스스로 **늘리고**, 진짜 scroll
   * 이벤트가 뜬다. 그것을 "사람이 위를 보는 중"으로 읽으면 정작 그때 필요한 보정이 죽는다.
   */
  it('내용이 자라 바닥이 멀어진 것은 사람이 올린 것으로 치지 않는다', () => {
    render(<ThreadPanel />);
    const list = screen.getByTestId('thread-scroll');
    sizeBox(list);
    scrollTo(list, 1500);

    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 3000 });
    scrollTo(list, 1600);

    const scrollIntoView = spyScroll();
    grewBelow();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  /**
   * **앱의 실제 순서로 마운트한다.** 스레드 패널은 뿌리가 없으면 아무것도 그리지 않으므로
   * (`if (!threadRootId) return null`) 첫 커밋에는 스크롤 상자도 바닥 표식도 없다. 관찰자를
   * 매다는 효과의 딸림값이 `[]` 이면 그 한 번으로 끝나 **영원히 안 붙는다** — 채널에서
   * 그대로 났던 사고다(#693 의 회귀선이 같은 것을 잡는다).
   */
  it('패널이 닫힌 상태에서 시작해 스레드를 열어도 보정이 붙는다', () => {
    useAppStore.getState().set({ threadRootId: null });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-scroll')).toBeNull();
    expect(watches.length).toBe(0);

    act(() => { useAppStore.getState().set({ threadRootId: 'm1' }); });

    expect(watches.length).toBe(1);
    expect(watches[0]!.root).toBe(screen.getByTestId('thread-scroll'));
    expect(watches[0]!.targets).toContain(screen.getByTestId('thread-bottom'));

    const scrollIntoView = spyScroll();
    grewBelow();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  /**
   * **다른 스레드로 옮기면 관찰자를 다시 맨다.** 상자는 같은 DOM 이라 한 번 매단 것이 계속
   * 도는 것처럼 보이지만, 딸림값이 뿌리인 덕에 앞 스레드에서 풀린 고정(`stickyRef`)이
   * `useLayoutEffect` 로 되돌려진다 — 그 순서를 여기서 못 박는다.
   */
  it('다른 스레드로 옮기면 위를 보던 상태가 남지 않는다', () => {
    render(<ThreadPanel />);
    // 앞 스레드에서 사람이 위로 올려 고정이 풀렸다.
    lookUp(screen.getByTestId('thread-scroll'));

    const scrollIntoView = spyScroll();
    act(() => {
      useAppStore.getState().set({
        threadRootId: 'm9',
        messages: { c1: [root(), reply('m2', 2, 'u2'), msg('m9', 'c1', 9, '다른 뿌리', 'u2')] },
      });
    });

    // 옮기면서 바닥으로 갔고(효과), 그 뒤 늦게 자란 것도 따라간다(보정이 살아 있다).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    scrollIntoView.mockClear();
    grewBelow();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

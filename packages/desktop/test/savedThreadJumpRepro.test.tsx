/**
 * QA 재현(2026-10-01, Saved → 스레드 답글 이동이 중간에 멈춤 — 원인 1).
 *
 * `openMessage` 는 답글이면 `openThread` 로 답글 페이지를 `upsertMessages` 한 뒤 강조를 건다.
 * 둘이 **한 커밋**에 묶이면: 자식 MessageItem 이 강조 줄로 `scrollIntoView` 한 다음, 부모
 * ThreadPanel 의 `[thread.length]` effect 가 (`atBottomRef` 가 아직 참이라) `scrollToBottom()` 을
 * 불러 바닥으로 되끌어 간다. ThreadPanel 에는 채널의 `onJump` 같은 "점프 중" 처리가 없다.
 *
 * jsdom 은 레이아웃이 없으므로 상자 500px · 줄 100px 를 세우고, `scrollIntoView` 를 브라우저처럼
 * (`block: 'nearest'`) 움직이게 한다. 스크롤 이벤트는 브라우저처럼 **다음 틱**에 보낸다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';
import type { MessageRow } from '@harkroom/shared';

const ROW_H = 100;
const VIEW_H = 500;
const N = 30; // 답글 수 — 패널 높이(5줄)보다 훨씬 길다
const TARGET = 'r5';

const root = () => msg('m1', 'c1', 1, '뿌리', 'u3');
const replies = (): MessageRow[] =>
  Array.from({ length: N }, (_, i) => msg(`r${i}`, 'c1', 10 + i, `답글 r${i}`, i % 2 ? 'u3' : 'u4', { threadRootId: 'm1' }));

const isBox = (el: Element) => (el as HTMLElement).dataset?.testid === 'thread-scroll';
const box = () => screen.getByTestId('thread-scroll');
/** 상자 안의 메시지 줄(MessageItem 의 바깥 div). */
const rowEls = (b: Element) => Array.from(b.children).filter((c) => c.classList.contains('group')) as HTMLElement[];
const tops = new WeakMap<Element, number>();

const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
function stub(proto: object, key: string, desc: PropertyDescriptor) {
  saved.push([proto, key, Object.getOwnPropertyDescriptor(proto, key)]);
  Object.defineProperty(proto, key, { configurable: true, ...desc });
}
const maxTop = (b: Element) => Math.max(0, rowEls(b).length * ROW_H - VIEW_H);
const fireScrollLater = (b: Element) => setTimeout(() => b.dispatchEvent(new Event('scroll')), 0);

beforeEach(() => {
  const P = HTMLElement.prototype;
  stub(P, 'clientHeight', { get(this: HTMLElement) { return isBox(this) ? VIEW_H : 0; } });
  stub(P, 'scrollHeight', { get(this: HTMLElement) { return isBox(this) ? rowEls(this).length * ROW_H : 0; } });
  stub(P, 'scrollTop', {
    get(this: HTMLElement) { return tops.get(this) ?? 0; },
    set(this: HTMLElement, v: number) { tops.set(this, Math.max(0, Math.min(isBox(this) ? maxTop(this) : 0, v))); },
  });
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn(function (this: HTMLElement) {
    const b = this.closest<HTMLElement>('[data-testid="thread-scroll"]');
    if (!b) return;
    if (this.dataset.testid === 'thread-bottom') { b.scrollTop = maxTop(b); fireScrollLater(b); return; }
    const i = rowEls(b).indexOf(this);
    if (i < 0) return;
    const top = i * ROW_H;
    if (top < b.scrollTop) b.scrollTop = top;
    else if (top + ROW_H > b.scrollTop + VIEW_H) b.scrollTop = top + ROW_H - VIEW_H;
    fireScrollLater(b);
  });
  setController({ reply: vi.fn(async () => undefined), closeThread: vi.fn(), openThread: vi.fn() } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u3: acc('u3', 'kim'), u4: acc('u4', 'lee'), a1: acc('a1', 'harkroom', 'agent'), a2: acc('a2', 'qa', 'agent') },
    activeChannelId: 'c1',
  });
});

afterEach(() => {
  cleanup();
  for (const [proto, key, desc] of saved.reverse()) {
    if (desc) Object.defineProperty(proto, key, desc);
    else delete (proto as Record<string, unknown>)[key];
  }
  saved.length = 0;
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
/** 대상 줄이 상자 안에 보이는가. */
function targetVisible(): boolean {
  const b = box();
  const i = rowEls(b).findIndex((r) => r.textContent?.includes(`답글 ${TARGET}`));
  if (i < 0) return false;
  const top = i * ROW_H;
  return top + ROW_H > b.scrollTop && top < b.scrollTop + VIEW_H;
}

describe('QA 재현: Saved → 스레드 답글 점프(원인 1)', () => {
  it('① 안 불러온 긴 스레드: 답글 upsert 와 강조가 한 커밋이면 대상이 화면에 있다', async () => {
    // openThread 첫 단계: 뿌리만 세운다(답글은 아직 없다).
    useAppStore.getState().set({ threadRootId: 'm1', messages: { c1: [root()] } });
    render(<ThreadPanel />);
    await settle();
    // 답글 페이지 도착 + 강조 — openMessage 가 같은 동기 구간에서 하는 일.
    act(() => {
      const s = useAppStore.getState();
      s.upsertMessages('c1', replies());
      s.set({ highlightedMessageId: TARGET });
    });
    await settle();
    expect({ visible: targetVisible(), scrollTop: box().scrollTop, max: maxTop(box()) }).toMatchObject({ visible: true });
  });

  it('①-c 마지막 답글이 내 것이어도 점프가 되끌려 가지 않는다', async () => {
    useAppStore.getState().set({ threadRootId: 'm1', messages: { c1: [root()] } });
    render(<ThreadPanel />);
    await settle();
    const rs = replies();
    rs[N - 1] = { ...rs[N - 1]!, authorId: 'u1' };
    act(() => {
      const s = useAppStore.getState();
      s.upsertMessages('c1', rs);
      s.set({ highlightedMessageId: TARGET });
    });
    await settle();
    expect({ visible: targetVisible(), scrollTop: box().scrollTop }).toMatchObject({ visible: true });
  });

  /**
   * 앞에 붙는 옛 답글은 「내 답글 따라가기」가 아니다(2026-10-06, 채널의 `prependKeepsPlace.test.tsx` 와
   * 같은 결함): 위를 읽는 중에 점프 창이 **앞에** 붙으면 마지막 답글은 그대로 내 것이라 바닥으로 끌려갔다.
   */
  it('위를 읽는 중에 옛 답글이 앞에 붙어도(마지막 답글이 내 것) 읽던 자리를 지킨다', async () => {
    const rs = replies();
    rs[N - 1] = { ...rs[N - 1]!, authorId: 'u1' };
    useAppStore.getState().set({ threadRootId: 'm1', messages: { c1: [root(), ...rs] } });
    render(<ThreadPanel />);
    await settle();
    const b = box();
    expect(b.scrollTop).toBe(maxTop(b));
    // 사람이 위로 올렸다.
    act(() => { b.scrollTop = b.scrollTop - 600; b.dispatchEvent(new Event('scroll')); });
    const before = b.scrollTop;
    // 옛 답글 한 페이지가 앞에 붙는다(`openThread(aroundSeq)`·위로 더 읽기).
    act(() => { useAppStore.getState().upsertMessages('c1', Array.from({ length: 10 }, (_, i) => msg(`o${i}`, 'c1', 2 + i, `옛 답글 o${i}`, 'u3', { threadRootId: 'm1' }))); });
    await settle();
    expect(b.scrollTop).not.toBe(maxTop(b));
    expect(b.scrollTop).toBe(before);
  });

  it('점프 뒤에 내가 보낸 답글은 여전히 따라 내려간다', async () => {
    useAppStore.getState().set({ threadRootId: 'm1', messages: { c1: [root()] } });
    render(<ThreadPanel />);
    await settle();
    act(() => {
      const s = useAppStore.getState();
      s.upsertMessages('c1', replies());
      s.set({ highlightedMessageId: TARGET });
    });
    await settle();
    // 작성칸에서 보낸 답글은 컨트롤러가 응답 id 를 적어 둔다(`lib/ownSends.ts`) — 그 표식이 있어야 따라간다.
    act(() => { const s = useAppStore.getState(); s.set({ ownSendIds: { mine: true } }); s.upsertMessages('c1', [msg('mine', 'c1', 999, '내 답글', 'u1', { threadRootId: 'm1' })]); });
    await settle();
    expect(box().scrollTop).toBe(maxTop(box()));
  });

  it('①-b 참고: 같은 상황인데 강조가 다음 커밋으로 갈리면', async () => {
    useAppStore.getState().set({ threadRootId: 'm1', messages: { c1: [root()] } });
    render(<ThreadPanel />);
    await settle();
    act(() => { useAppStore.getState().upsertMessages('c1', replies()); });
    act(() => { useAppStore.getState().set({ highlightedMessageId: TARGET }); });
    await settle();
    expect({ visible: targetVisible(), scrollTop: box().scrollTop }).toMatchObject({ visible: true });
  });

  it('② 이미 불러온 스레드를 다시 열면(답글 수 변화 없음) 대상이 화면에 있다', async () => {
    useAppStore.getState().set({ threadRootId: 'm1', messages: { c1: [root(), ...replies()] } });
    render(<ThreadPanel />);
    await settle();
    act(() => { useAppStore.getState().set({ highlightedMessageId: TARGET }); });
    await settle();
    expect({ visible: targetVisible(), scrollTop: box().scrollTop }).toMatchObject({ visible: true });
  });

  it('③ 대상이 에이전트끼리 주고받기(접힌 줄) 안에 있으면 펼쳐져서 보여야 한다', async () => {
    const ex = Array.from({ length: 6 }, (_, i) =>
      msg(`x${i}`, 'c1', 100 + i, `주고받기 x${i}`, i % 2 ? 'a2' : 'a1', { threadRootId: 'm1' }));
    useAppStore.getState().set({ threadRootId: 'm1', messages: { c1: [root(), ...replies(), ...ex] } });
    render(<ThreadPanel />);
    await settle();
    act(() => { useAppStore.getState().set({ highlightedMessageId: 'x2' }); });
    await settle();
    // 접힌 줄이면 MessageItem 이 없어 강조도 scrollIntoView 도 일어나지 않는다.
    expect(screen.queryByText('주고받기 x2')).not.toBeNull();
  });
});

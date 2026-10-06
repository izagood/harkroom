/**
 * 「내가 쓴 것은 따라 내려간다」가 **앞에 붙은 것**에도 들던 결함(2026-10-06, 링크 이동이 바닥으로 되끌림).
 *
 * `ChannelPane` 의 `[roots.length]` 효과는 줄 수가 늘면 "마지막 뿌리가 내 것인가"만 봤다. 그런데 줄 수는
 * 과거 페이지(`loadOlder`)·점프 창·스레드 뿌리처럼 **위에** 붙어도 는다 — 그때 마지막 뿌리는 그대로
 * 내 것이라, 위를 읽던(또는 방금 점프한) 화면이 바닥으로 끌려갔다. #task 처럼 마지막 최상위 글이 내
 * 것인 채널에서는 링크 이동이 매번 그랬다. 따라갈 것은 **새로 끝에 붙은 내 글**뿐이다.
 *
 * 레이아웃 스텁은 `savedJumpRepro.test.tsx` 의 것이다(가상 창 + 바닥 표식).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { setEagerMessageToolbar } from '../src/components/MessageItem';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';
import { ROW_ESTIMATE_PX } from '../src/components/MessageRows';
import type { MessageRow } from '@harkroom/shared';

const ROW_H = ROW_ESTIMATE_PX;
const VIEW_H = 600;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

const rows = (n: number, prefix: string, seqBase: number, author = 'u2'): MessageRow[] =>
  Array.from({ length: n }, (_, i) =>
    msg(`${prefix}${i}`, 'c1', seqBase + i, `줄 ${prefix}${i}`, author, {
      createdAt: new Date(T0 + Math.floor(i / 100) * DAY + (i % 100) * 60_000).toISOString(),
    }));

const isBox = (el: Element) => (el as HTMLElement).dataset?.testid === 'channel-scroll';
const tops = new WeakMap<Element, number>();
function contentHeight(el: Element): number {
  let h = el.querySelectorAll('[data-anchor-id]').length * ROW_H;
  for (const pad of Array.from(el.querySelectorAll<HTMLElement>('div[aria-hidden="true"][style]'))) {
    h += parseFloat(pad.style.height) || 0;
  }
  return h;
}
const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
function stub(proto: object, key: string, desc: PropertyDescriptor) {
  saved.push([proto, key, Object.getOwnPropertyDescriptor(proto, key)]);
  Object.defineProperty(proto, key, { configurable: true, ...desc });
}
function installLayout() {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const P = HTMLElement.prototype;
  stub(P, 'offsetHeight', { get(this: HTMLElement) { return isBox(this) ? VIEW_H : this.dataset.index != null ? ROW_H : 0; } });
  stub(P, 'offsetWidth', { get(this: HTMLElement) { return isBox(this) ? 800 : 0; } });
  stub(P, 'clientHeight', { get(this: HTMLElement) { return isBox(this) ? VIEW_H : 0; } });
  stub(P, 'scrollHeight', { get(this: HTMLElement) { return isBox(this) ? contentHeight(this) : 0; } });
  stub(P, 'scrollTop', {
    get(this: HTMLElement) { return tops.get(this) ?? 0; },
    set(this: HTMLElement, v: number) {
      const max = isBox(this) ? Math.max(0, contentHeight(this) - VIEW_H) : 0;
      tops.set(this, Math.max(0, Math.min(max, v)));
    },
  });
  stub(P, 'scrollTo', {
    value(this: HTMLElement, opts: { top?: number }) {
      if (opts?.top == null) return;
      this.scrollTop = opts.top;
      this.dispatchEvent(new Event('scroll'));
    },
  });
}
function uninstallLayout() {
  for (const [proto, key, desc] of saved.reverse()) {
    if (desc) Object.defineProperty(proto, key, desc);
    else delete (proto as Record<string, unknown>)[key];
  }
  saved.length = 0;
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
}

const scrollBox = () => screen.getByTestId('channel-scroll');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const view = () => { const el = scrollBox(); return { top: el.scrollTop, bottomGap: el.scrollHeight - el.scrollTop - el.clientHeight }; };

/** `controller.loadOlder` 흉내 — 한 페이지를 **앞에** 붙인다. */
let loadOlder = vi.fn(async () => undefined);

beforeEach(() => {
  installLayout();
  usePrefsStore.getState().setLocale('ko');
  loadOlder = vi.fn(async () => { useAppStore.getState().upsertMessages('c1', rows(100, 'anc', 100)); });
  setController({ send: vi.fn(async () => undefined), openThread: vi.fn(), loadOlder, api: scheduledApiStub() } as unknown as Controller);
  useAppStore.getState().reset();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn(function (this: HTMLElement) {
    if (this.dataset.testid !== 'channel-bottom') return;
    const box = this.closest<HTMLElement>('[data-testid="channel-scroll"]');
    if (box) box.scrollTop = box.scrollHeight;
  });
});
afterEach(() => {
  cleanup();
  uninstallLayout();
  setEagerMessageToolbar(true);
  usePrefsStore.getState().setLocale('system');
});

function open(messages: MessageRow[]) {
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'kim') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
    messages: { c1: messages },
    hasMore: { c1: true },
  });
  return render(<ChannelPane />);
}

/** 마지막 뿌리가 **내 글**인 채널 — #task 가 늘 이렇다. */
const latestEndingWithMine = () => {
  const latest = rows(150, 'm', 1000);
  latest[149] = { ...latest[149]!, authorId: 'u1' };
  return latest;
};

describe('앞에 붙는 줄은 「내 글 따라가기」가 아니다', () => {
  it('점프해 간 자리에서 과거 페이지가 앞에 붙어도(마지막 뿌리가 내 글) 바닥으로 끌려가지 않는다', async () => {
    open(latestEndingWithMine());
    await flush();
    // 점프 창 + 강조(한 커밋) — #984 가 지키는 자리.
    act(() => { const s = useAppStore.getState(); s.upsertMessages('c1', rows(100, 'old', 500)); s.set({ highlightedMessageId: 'old50' }); });
    await flush();
    expect(view().bottomGap).toBeGreaterThan(0);
    // 사람이 조금 더 위로 올려 과거 한 페이지가 **앞에** 붙는다(`maybeLoadOlder` → `loadOlder`).
    const el = scrollBox();
    act(() => { el.scrollTop = 100; fireEvent.scroll(el); });
    await flush();
    expect(loadOlder).toHaveBeenCalled();
    await flush();
    const v = view();
    expect(v.bottomGap).toBeGreaterThan(0);
    // 붙은 만큼 내려가 **보던 줄이 그 자리**다 — 100 + 100줄.
    expect(v.top).toBe(100 + 100 * ROW_H);
  });

  it('위를 읽는 중에 과거 페이지가 앞에 붙어도(마지막 뿌리가 내 글) 읽던 자리를 지킨다', async () => {
    open(latestEndingWithMine());
    await flush();
    const el = scrollBox();
    // 바닥에서 위로 올렸다 — 사람의 손.
    act(() => { el.scrollTop = el.scrollTop - 400; fireEvent.scroll(el); });
    act(() => { el.scrollTop = 100; fireEvent.scroll(el); });
    await flush();
    expect(loadOlder).toHaveBeenCalled();
    await flush();
    const v = view();
    expect(v.bottomGap).toBeGreaterThan(0);
    expect(v.top).toBe(100 + 100 * ROW_H);
  });

  it('대조군: 끝에 새로 붙은 내 글(이 기기의 작성칸에서 보낸 것)은 여전히 따라 내려간다', async () => {
    open(latestEndingWithMine());
    await flush();
    act(() => { const s = useAppStore.getState(); s.upsertMessages('c1', rows(100, 'old', 500)); s.set({ highlightedMessageId: 'old50' }); });
    await flush();
    expect(view().bottomGap).toBeGreaterThan(0);
    // 작성칸에서 보낸 글은 컨트롤러가 응답 id 를 적어 둔다(`lib/ownSends.ts`, #1191 후속 d3) — 그 표식이 있어야 따라간다.
    act(() => { const s = useAppStore.getState(); s.set({ ownSendIds: { mine: true } }); s.upsertMessages('c1', [msg('mine', 'c1', 2000, '내가 보냄', 'u1')]); });
    await flush();
    expect(view().bottomGap).toBe(0);
  });
});

/**
 * 채널 패널의 「내 글 따라가기」는 **이 기기의 작성칸에서 보낸 글**만 따라간다 (2026-10-06, #1191 후속 d3).
 *
 * 전에는 끝에 붙은 글의 작성자가 나이기만 하면 위를 읽던 화면이 바닥으로 갔다. 그런데 자동화는
 * 승인한 사람 이름으로 글을 쓰고, 다른 기기에서 보낸 것도 같은 작성자로 소켓을 타고 온다 —
 * 위를 읽던 사람이 자기가 하지 않은 일로 끌려 내려갔다(designer n3).
 *
 * 레이아웃 스텁은 `prependKeepsPlace.test.tsx` 와 같다(가상 창 + 바닥 표식).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { setEagerMessageToolbar } from '../src/components/MessageItem';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';
import { ROW_ESTIMATE_PX } from '../src/components/MessageRows';
import { beginSend, markOwnSend } from '../src/lib/ownSends';
import type { MessageRow } from '@harkroom/shared';

const ROW_H = ROW_ESTIMATE_PX;
const VIEW_H = 600;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

const rows = (n: number, prefix: string, seqBase: number, author = 'u2'): MessageRow[] =>
  Array.from({ length: n }, (_, i) =>
    msg(`${prefix}${i}`, 'c1', seqBase + i, `줄 ${prefix}${i}`, author, {
      createdAt: new Date(T0 + i * 60_000).toISOString(),
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
const bottomGap = () => { const el = scrollBox(); return el.scrollHeight - el.scrollTop - el.clientHeight; };

beforeEach(() => {
  installLayout();
  usePrefsStore.getState().setLocale('ko');
  setController({ send: vi.fn(async () => undefined), openThread: vi.fn(), loadOlder: vi.fn(async () => undefined), api: scheduledApiStub() } as unknown as Controller);
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

/** 채널을 열고 **위를 읽는 중**으로 세운다. */
async function openReadingUp() {
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'kim') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
    messages: { c1: rows(150, 'm', 1000) },
    hasMore: { c1: false },
  });
  const r = render(<ChannelPane />);
  await flush();
  act(() => { const el = scrollBox(); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await flush();
  expect(bottomGap()).toBeGreaterThan(0);
  return r;
}

const arrives = (id: string) => act(() => { useAppStore.getState().upsertMessages('c1', [msg(id, 'c1', 2000, '내 이름으로', 'u1')]); });

describe('내 글 따라가기는 이 기기에서 보낸 것만', () => {
  it('자동화·다른 기기가 내 이름으로 끝에 붙인 글(소켓)에는 끌려 내려가지 않는다', async () => {
    await openReadingUp();
    const before = bottomGap();
    arrives('auto1');
    await flush();
    expect(bottomGap()).toBeGreaterThan(0);
    expect(bottomGap()).toBeGreaterThanOrEqual(before);
    // 내려갈 길은 준다 — 남의 글이 왔을 때와 같다.
    expect(screen.getByTestId('channel-jump-to-bottom')).toBeTruthy();
  });

  it('작성칸에서 보낸 글(응답 id 가 적힘)은 따라 내려간다', async () => {
    await openReadingUp();
    act(() => { const s = useAppStore.getState(); s.set(markOwnSend({ ownSendIds: s.ownSendIds, sendsInFlight: s.sendsInFlight }, 'mine1')); });
    arrives('mine1');
    await flush();
    expect(bottomGap()).toBe(0);
  });

  it('응답보다 먼저 온 소켓 줄도 이 채널에서 보내는 중이면 따라간다', async () => {
    await openReadingUp();
    act(() => { const s = useAppStore.getState(); s.set(beginSend({ ownSendIds: s.ownSendIds, sendsInFlight: s.sendsInFlight }, 'c1')); });
    arrives('early1');
    await flush();
    expect(bottomGap()).toBe(0);
  });
});

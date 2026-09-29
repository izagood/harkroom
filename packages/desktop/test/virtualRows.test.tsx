/**
 * **채널 줄은 창으로 좁혀 그린다 — 그래도 예전에 되던 것은 그대로 된다**(대화 불러오기 성능,
 * 2026-09-29, `MessageRows.tsx` 의 근거).
 *
 * 창(가상 스크롤)은 `ResizeObserver` 가 있을 때만 켜진다. jsdom 에는 그것이 없어 다른 화면
 * 테스트는 예전처럼 모든 줄을 그린다 — 그래서 **창 쪽 동작은 이 파일만 지킨다.** 여기서는
 * 관찰자를 세우고, jsdom 이 재지 않는 레이아웃(상자 600px, 줄 100px)을 직접 세운다.
 *
 * 지키는 것(회귀 위험 지점):
 * - 채널을 열면 **바닥에서** 시작하고, 마운트되는 줄은 행 수와 상관없이 몇십 개다
 * - 강조 점프(saved·검색·링크): 창 밖 줄도 번호로 찾아가 마운트되고 바닥 추종이 꺼진다
 * - 날짜 구분선은 앞 자리가 창 밖이어도 **배열로** 판정한다(창의 첫 줄이라고 선이 서지 않는다)
 * - New messages 구분선
 * - loadOlder 앵커: 과거가 앞에 붙어도 보던 자리가 그대로다
 * - hover 툴바(A'): 창 안의 줄도 손을 대면 툴바가 선다
 *
 * 가변 높이(그림·코드 블록·답글 요약이 늦게 자람)는 실제 레이아웃이 있어야 재현된다 — WebKit
 * 탐침으로 잰다(PR 본문).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { setEagerMessageToolbar } from '../src/components/MessageItem';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';
import { ROW_ESTIMATE_PX } from '../src/components/MessageRows';
import type { MessageRow } from '@harkroom/shared';

/**
 * 스텁 줄 높이는 **어림값과 같게** 둔다. 다르면 줄이 재어지는 시점(느린 CI 에서는 한 커밋 늦다)에
 * 따라 내용 높이가 흔들려 바닥·앵커 수치가 타이밍에 묶인다(첫 CI 에서 -224px·7452 로 흔들렸다).
 * 재어진 높이가 어림과 다를 때의 보정은 실제 레이아웃이 있는 WebKit 탐침이 잰다.
 */
const ROW_H = ROW_ESTIMATE_PX;
const VIEW_H = 600;
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

/** 한 날에 100개씩 — 날짜 구분선이 m0·m100·m200… 에 선다. */
const rows = (n: number, prefix = 'm', seqBase = 1000): MessageRow[] =>
  Array.from({ length: n }, (_, i) =>
    msg(`${prefix}${i}`, 'c1', seqBase + i, `줄 ${prefix}${i}`, 'u2', {
      createdAt: new Date(T0 + Math.floor(i / 100) * DAY + (i % 100) * 60_000).toISOString(),
    }));

const isBox = (el: Element) => (el as HTMLElement).dataset?.testid === 'channel-scroll';
const tops = new WeakMap<Element, number>();

/** 상자 안 내용 높이: 마운트된 줄과 창의 여백 상자(인라인 높이)를 더한다. */
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
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
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

const mounted = () => Array.from(document.querySelectorAll<HTMLElement>('[data-anchor-id]')).map((r) => r.dataset.anchorId!);
const scrollBox = () => screen.getByTestId('channel-scroll');
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let loadOlder = vi.fn(async () => undefined);

beforeEach(() => {
  installLayout();
  usePrefsStore.getState().setLocale('ko');
  loadOlder = vi.fn(async () => undefined);
  setController({
    send: vi.fn(async () => undefined),
    openThread: vi.fn(),
    loadOlder,
    api: scheduledApiStub(),
  } as unknown as Controller);
  useAppStore.getState().reset();
  // 바닥 표식의 `scrollIntoView` 는 상자를 바닥으로 옮긴다(브라우저가 하는 일 그대로).
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

function open(messages: MessageRow[], extra: Record<string, unknown> = {}) {
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'kim') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
    messages: { c1: messages },
    ...extra,
  });
  return render(<ChannelPane />);
}

describe('창으로 좁힌 채널 줄', () => {
  it('바닥에서 시작하고, 1500행이어도 마운트는 몇십 줄이다', async () => {
    open(rows(1500));
    await flush();
    const ids = mounted();
    expect(ids).toContain('m1499');
    expect(ids).not.toContain('m0');
    expect(ids.length).toBeLessThan(60);
    const el = scrollBox();
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(0);
  });

  it('강조 점프: 창 밖 줄도 번호로 찾아가 마운트하고, 바닥 추종을 끈다', async () => {
    open(rows(1500));
    await flush();
    expect(mounted()).not.toContain('m200');
    act(() => { useAppStore.getState().set({ highlightedMessageId: 'm200' }); });
    await flush();
    expect(mounted()).toContain('m200');
    // 바닥에서 떠났으니 내려갈 길이 선다 — 정착 루프가 되끌어 가지 않았다는 뜻이기도 하다.
    expect(screen.getByTestId('channel-jump-to-bottom')).toBeTruthy();
  });

  it('날짜 구분선은 앞 자리가 창 밖이어도 배열로 판정한다', async () => {
    open(rows(1500));
    await flush();
    const first = document.querySelector<HTMLElement>('[data-anchor-id]')!;
    // 창의 첫 줄은 m14xx 이고 그 앞 줄과 같은 날이다 — 선이 서면 안 된다.
    expect(first.dataset.anchorId).not.toBe('m1400');
    expect(first.querySelector('[role="separator"]')).toBeNull();
    act(() => { useAppStore.getState().set({ highlightedMessageId: 'm1400' }); });
    await flush();
    const dayStart = document.querySelector<HTMLElement>('[data-anchor-id="m1400"]')!;
    expect(dayStart.querySelector('[role="separator"]')).not.toBeNull();
    const sameDay = document.querySelector<HTMLElement>('[data-anchor-id="m1401"]')!;
    expect(sameDay.querySelector('[role="separator"]')).toBeNull();
  });

  it('New messages 구분선이 창 안의 줄에 선다', async () => {
    open(rows(1500), { dividerSeq: { c1: 1000 + 1494 } });
    await flush();
    const row = document.querySelector<HTMLElement>('[data-anchor-id="m1495"]')!;
    expect(row.textContent).toContain('New messages');
    expect(screen.getAllByText('New messages')).toHaveLength(1);
  });

  it('loadOlder 앵커: 과거가 앞에 붙어도 보던 줄이 같은 자리에 있다', async () => {
    const current = rows(150, 'm', 1000);
    loadOlder.mockImplementationOnce(async () => {
      const older = rows(100, 'old', 800);
      act(() => {
        useAppStore.getState().set({ messages: { c1: [...older, ...useAppStore.getState().messages.c1!] } });
      });
    });
    open(current, { hasMore: { c1: true } });
    await flush();
    const el = scrollBox();
    fireEvent.wheel(el);
    el.scrollTop = 0;
    fireEvent.scroll(el);
    await flush();
    expect(loadOlder).toHaveBeenCalled();
    // 앞에 100줄이 어림 높이로 붙었다 — 자란 만큼 내려가 있어야 m0 이 그 자리에 있다.
    expect(el.scrollTop).toBe(100 * ROW_ESTIMATE_PX);
    fireEvent.scroll(el);
    await flush();
    expect(mounted()).toContain('m0');
    expect(mounted()).not.toContain('old0');
  });

  it("hover 툴바(A'): 창 안의 줄도 손을 대면 툴바가 선다", async () => {
    // 제품의 기본값(지연 마운트)으로 되돌려 잰다 — `test/setup.ts` 는 이것을 켜 둔다.
    setEagerMessageToolbar(false);
    open(rows(300));
    await flush();
    const row = screen.getByText('줄 m299').closest('.group') as HTMLElement;
    expect(within(row).queryByRole('toolbar', { name: 'message toolbar' })).toBeNull();
    fireEvent.mouseEnter(row);
    expect(within(row).getByRole('toolbar', { name: 'message toolbar' })).toBeTruthy();
  });
});

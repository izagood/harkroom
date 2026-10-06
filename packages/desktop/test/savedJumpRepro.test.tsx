/**
 * QA 재현(2026-10-01, Saved 클릭 이동이 중간에 멈춤). `virtualRows.test.tsx` 의 레이아웃 스텁을 그대로 빌린다.
 *
 * `openMessage` 는 대상이 스토어에 없으면 `around` 창을 합치고(upsertMessages) **같은 동기 구간에서**
 * 강조를 건다 → React 가 한 커밋으로 묶는다. 그 커밋에서 자식(VirtualRows)의 점프 effect 가 먼저
 * 돌아 onJump 로 바닥 추종을 끈 뒤, 부모(ChannelPane)의 `[roots.length]` effect 가 돈다. 그 effect 는
 * "마지막 뿌리 메시지가 내 것이면 바닥으로" 분기를 타서 scrollToBottom + startSettle 을 다시 건다.
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


const view = () => { const el = scrollBox(); return { top: el.scrollTop, bottomGap: el.scrollHeight - el.scrollTop - el.clientHeight }; };
/** 대상 줄이 화면(상자 600px) 안에 있는가 — padTop + 마운트된 줄 순서로 위치를 계산한다. */
function targetVisible(id: string): boolean {
  const el = scrollBox();
  const pad = el.querySelector<HTMLElement>('div[aria-hidden="true"][style]');
  const ids = mounted();
  const i = ids.indexOf(id);
  if (i < 0) return false;
  const top = (parseFloat(pad?.style.height ?? '0') || 0) + i * ROW_H;
  return top + ROW_H > el.scrollTop && top < el.scrollTop + VIEW_H;
}

/** openMessage 가 하는 일: around 창을 앞에 합치고, 같은 동기 구간에서 강조를 건다. */
function jumpWithAroundPage(older: MessageRow[], target: string) {
  act(() => {
    const s = useAppStore.getState();
    s.upsertMessages('c1', older);
    s.set({ highlightedMessageId: target });
  });
}

describe('QA 재현: Saved → 옛 메시지 점프', () => {
  for (const lastAuthor of ['u2', 'u1'] as const) {
    it(`마지막 뿌리 메시지 작성자=${lastAuthor === 'u1' ? '나' : '남'}: around 창 + 강조가 한 커밋이면 대상이 화면에 있다`, async () => {
      const latest = rows(150, 'm', 1000);
      latest[149] = { ...latest[149]!, authorId: lastAuthor };
      open(latest);
      await flush();
      const older = rows(100, 'old', 500);
      jumpWithAroundPage(older, 'old50');
      await flush();
      await act(async () => { await new Promise((r) => setTimeout(r, 1500)); }); // 정착 창(1.2s) 지나기
      const v = view();
      expect({ visible: targetVisible('old50'), ...v }).toMatchObject({ visible: true });
      expect(v.bottomGap).toBeGreaterThan(0);
    });
  }

  it('점프 뒤에 내가 보낸 글은 여전히 따라 내려간다(점프 표식은 그 커밋에서만 산다)', async () => {
    const latest = rows(150, 'm', 1000);
    latest[149] = { ...latest[149]!, authorId: 'u1' };
    open(latest);
    await flush();
    jumpWithAroundPage(rows(100, 'old', 500), 'old50');
    await flush();
    expect(view().bottomGap).toBeGreaterThan(0);
    // 작성칸에서 보낸 글은 컨트롤러가 응답 id 를 적어 둔다(`lib/ownSends.ts`) — 그 표식이 있어야 따라간다.
    act(() => { const s = useAppStore.getState(); s.set({ ownSendIds: { mine: true } }); s.upsertMessages('c1', [msg('mine', 'c1', 2000, '내가 보냄', 'u1')]); });
    await flush();
    expect(view().bottomGap).toBe(0);
  });

  it('대조군: 대상이 이미 스토어에 있으면(행 수 변화 없음) 내 말이 마지막이어도 대상이 화면에 있다', async () => {
    const latest = rows(1500, 'm', 1000);
    latest[1499] = { ...latest[1499]!, authorId: 'u1' };
    open(latest);
    await flush();
    act(() => { useAppStore.getState().set({ highlightedMessageId: 'm200' }); });
    await flush();
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(targetVisible('m200')).toBe(true);
  });
});

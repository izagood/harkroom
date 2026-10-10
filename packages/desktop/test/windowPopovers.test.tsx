import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { clipBounds, Menu } from '../src/components/Menu';
import { HostDocumentContext } from '../src/lib/hostDocument';
import { acc, fakeApi, fakeWsFactory, msg, tm } from './helpers/fakeApi';

/**
 * 새 창(채널·스레드 창) 안의 떠 있는 것들은 **그 창**에 뜨고 **그 창 크기**로 잘린다(2026-10-06 F1).
 *
 * 전에는 반응 말풍선·멘션 카드가 메인 `document.body` 로 포털돼 새 창에서 올린 것이 메인 창에 떴고
 * (WebKit 실측), 자르는 기준도 메인 `window.innerWidth/Height` 였다. jsdom 의 두 번째 문서는 창이 없으므로
 * (`defaultView` 가 null) 작은 창 하나를 붙여 준다 — 메인(jsdom 기본 1024×768)과 크기가 달라야 가려진다.
 */
const WIN = { width: 360, height: 420 };

function popupDoc(): Document {
  const doc = document.implementation.createHTMLDocument('popup');
  // 크기만 다르고 나머지(HTMLElement·getComputedStyle 등 React 가 읽는 것)는 메인 창 그대로다.
  const view = new Proxy(window, {
    get: (target, key) => {
      if (key === 'innerWidth') return WIN.width;
      if (key === 'innerHeight') return WIN.height;
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' && !/^[A-Z]/.test(String(key)) ? v.bind(target) : v;
    },
  });
  Object.defineProperty(doc, 'defaultView', { value: view });
  return doc;
}

/** 창 오른쪽 아래 구석에 있는 것처럼 보이게 한다 — jsdom 은 레이아웃을 재지 않는다. */
function placeAt(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  const r = { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top };
  el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
}

function renderInPopup(doc: Document, message: MessageRow) {
  const container = doc.body.appendChild(doc.createElement('div'));
  return render(
    <HostDocumentContext.Provider value={doc}>
      <MessageItem message={message} />
    </HostDocumentContext.Provider>,
    { container },
  );
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    teams: [tm('t1', 'ops-team', 0)],
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); setController(null as unknown as Controller); });

describe('새 창 안의 떠 있는 것', () => {
  it('반응 말풍선은 그 창에 뜨고 그 창 크기로 자른다', async () => {
    setController({ toggleReaction: vi.fn(async () => undefined) } as unknown as Controller);
    const doc = popupDoc();
    renderInPopup(doc, { ...msg('m1', 'c1', 1, '본문', 'u2'), reactions: [{ emoji: '👀', accountIds: ['u2'] }] });
    const chip = doc.querySelector<HTMLElement>('[data-testid="reaction-👀"]')!;
    placeAt(chip, { left: 300, top: 390, width: 20, height: 20 });
    vi.useFakeTimers();
    fireEvent.mouseEnter(chip);
    await act(async () => { vi.advanceTimersByTime(1000); });
    vi.useRealTimers();

    expect(document.body.querySelector('[data-testid="reaction-tooltip"]')).toBeNull();
    const tip = doc.querySelector<HTMLElement>('[data-testid="reaction-tooltip"]')!;
    expect(tip).toBeTruthy();
    // 가로: 창 폭 360 − 말풍선 208 − 가장자리 8 = 144 까지만 민다(메인 폭이면 206 에 서서 창 밖으로 나간다).
    expect(tip.style.left).toBe('144px');
    // 세로: 위로 열고, 바닥은 창 높이 기준 420 − 390 + 8.
    expect(tip.style.bottom).toBe('38px');
  });

  it('멘션 카드는 그 창에 뜨고 그 창 크기로 자른다', async () => {
    setController(new Controller(fakeApi({
      team: vi.fn(async () => ({ team: tm('t1', 'ops-team', 0), members: [] })),
    }), fakeWsFactory().makeWs));
    const doc = popupDoc();
    renderInPopup(doc, msg('m1', 'c1', 1, '@ops-team 봐', 'u1'));
    const wrap = doc.querySelector('[data-testid="mention-ops-team"]')!.parentElement!;
    placeAt(wrap, { left: 300, top: 390, width: 60, height: 20 });

    vi.useFakeTimers();
    fireEvent.mouseEnter(wrap);
    await act(async () => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();
    await act(async () => { await Promise.resolve(); });

    expect(document.body.querySelector('[data-testid="hovercard"]')).toBeNull();
    const card = doc.querySelector<HTMLElement>('[data-testid="hovercard"]')!;
    expect(card).toBeTruthy();
    // 가로: 360 − 카드 256 − 8 = 96. 세로: 아래 자리(410+4+320)가 창을 넘으니 위로, 바닥 420 − 390 + 4.
    expect(card.style.left).toBe('96px');
    expect(card.style.bottom).toBe('34px');
  });

  it('⋯ 메뉴의 뒤집기 판정(clipBounds)도 그 창 높이를 쓴다', () => {
    const doc = popupDoc();
    const el = doc.body.appendChild(doc.createElement('div'));
    expect(clipBounds(el)).toEqual({ top: 0, bottom: WIN.height });
  });

  /**
   * designer #1224 수정 1: 520×480 채널 창은 메시지 목록이 230px 남짓이라 맨 아래 글의 ⋯ 메뉴(약 218px)가
   * 위로도 아래로도 목록 안에 다 안 들어가 목록 테두리에서 잘렸다(Pin·Delete 를 못 누름, WebKit 실측).
   * 그때만 목록 밖(`position: fixed`)으로 꺼내 그 창 안으로 자른다.
   */
  function openMenuIn(list: { top: number; bottom: number }, trigger: { top: number; bottom: number }, menuHeight: number) {
    const doc = popupDoc();
    const rects = new Map<string, { top: number; bottom: number; left: number; width: number }>([
      ['list', { ...list, left: 0, width: WIN.width }],
      ['trigger', { ...trigger, left: 300, width: 24 }],
      ['menu', { top: trigger.bottom + 4, bottom: trigger.bottom + 4 + menuHeight, left: 260, width: 160 }],
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const key = this.getAttribute('role') === 'menu' ? 'menu' : (this.dataset.probe ?? '');
      const r = rects.get(key) ?? { top: 0, bottom: 0, left: 0, width: 0 };
      const full = { ...r, right: r.left + r.width, height: r.bottom - r.top, x: r.left, y: r.top };
      return { ...full, toJSON: () => full } as DOMRect;
    });
    const container = doc.body.appendChild(doc.createElement('div'));
    render(
      <HostDocumentContext.Provider value={doc}>
        <div data-probe="list" style={{ overflowY: 'auto' }}>
          <Menu
            placement="bottom"
            items={['Copy text', 'Mark unread', 'Pin', 'Edit', 'Delete'].map((label) => ({ label, onSelect: () => undefined }))}
            renderTrigger={(props) => <button {...props} data-probe="trigger">⋯</button>}
          />
        </div>
      </HostDocumentContext.Provider>,
      { container },
    );
    fireEvent.click(doc.querySelector('[data-probe="trigger"]')!);
    return doc.querySelector<HTMLElement>('[role="menu"]')!;
  }

  it('⋯ 메뉴가 목록 위·아래 어느 쪽에도 다 안 들어가면 목록 밖으로 꺼내 창 안에 둔다', () => {
    // 목록 40~270(230px), 맨 아래 글의 ⋯ 는 240~264, 메뉴 218px. 창은 360×420.
    const menu = openMenuIn({ top: 40, bottom: 270 }, { top: 240, bottom: 264 }, 218);
    expect(menu.style.position).toBe('fixed');
    const top = parseFloat(menu.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + 218).toBeLessThanOrEqual(WIN.height - 8);
    // 가로도 창 안: 메뉴 오른쪽 끝(left + 160) ≤ 360 − 8.
    expect(parseFloat(menu.style.left) + 160).toBeLessThanOrEqual(WIN.width - 8);
    // 목록 안의 `absolute` 배치 클래스는 떼어야 한다 — 남으면 top·bottom 이 둘 다 서서 메뉴가 늘어난다.
    expect(menu.className).not.toMatch(/\babsolute\b|top-full|bottom-full/);
  });

  it('목록 안에 들어가면 예전 그대로 목록 안의 absolute 다(메인 창 동작 그대로)', () => {
    const menu = openMenuIn({ top: 0, bottom: 400 }, { top: 40, bottom: 64 }, 218);
    expect(menu.style.position).toBe('');
    expect(menu.className).toMatch(/\babsolute\b/);
    expect(menu.className).toMatch(/top-full/);
  });

  /** #1224 후속 1(designer f1·security nit): 띄운 메뉴는 굴리면 ⋯ 와 떨어져 옆 글의 메뉴처럼 읽힌다. */
  it('띄운 ⋯ 메뉴는 그 창의 목록을 굴리면 닫힌다', () => {
    const menu = openMenuIn({ top: 40, bottom: 270 }, { top: 240, bottom: 264 }, 218);
    expect(menu.style.position).toBe('fixed');
    const doc = menu.ownerDocument;
    // 메뉴 자신이 굴러도 닫지 않는다.
    fireEvent.scroll(menu);
    expect(doc.querySelector('[role="menu"]')).not.toBeNull();
    fireEvent.scroll(doc.querySelector('[data-probe="list"]')!);
    expect(doc.querySelector('[role="menu"]')).toBeNull();
  });

  it('목록 안의 평소(absolute) 메뉴는 굴려도 닫지 않는다(메인 창 동작 그대로)', () => {
    const menu = openMenuIn({ top: 0, bottom: 400 }, { top: 40, bottom: 64 }, 218);
    expect(menu.style.position).toBe('');
    fireEvent.scroll(menu.ownerDocument.querySelector('[data-probe="list"]')!);
    expect(menu.ownerDocument.querySelector('[role="menu"]')).not.toBeNull();
  });

  /** #1224 후속 2(security nit): 위/아래 판정이 `[anchor]` 에만 묶여 창 크기가 바뀌어도 그대로였다. */
  it('반응 말풍선이 떠 있는 동안 그 창 높이가 바뀌면 위/아래를 다시 잰다', async () => {
    setController({ toggleReaction: vi.fn(async () => undefined) } as unknown as Controller);
    const doc = popupDoc();
    renderInPopup(doc, { ...msg('m1', 'c1', 1, '본문', 'u2'), reactions: [{ emoji: '👀', accountIds: ['u2'] }] });
    const chip = doc.querySelector<HTMLElement>('[data-testid="reaction-👀"]')!;
    // 창 맨 위의 칩 — 위로는 자리가 없어 아래로 연다(창이 충분히 높을 때).
    placeAt(chip, { left: 100, top: 5, width: 20, height: 20 });
    vi.useFakeTimers();
    fireEvent.mouseEnter(chip);
    await act(async () => { vi.advanceTimersByTime(1000); });
    vi.useRealTimers();
    const tip = () => doc.querySelector<HTMLElement>('[data-testid="reaction-tooltip"]')!;
    expect(tip().dataset.placement).toBe('bottom');

    const tall = WIN.height;
    try {
      WIN.height = 30; // 창을 줄여 아래에도 자리가 없게 한다
      await act(async () => { window.dispatchEvent(new Event('resize')); });
      expect(tip().dataset.placement).toBe('top');
    } finally {
      WIN.height = tall;
    }
  });
});

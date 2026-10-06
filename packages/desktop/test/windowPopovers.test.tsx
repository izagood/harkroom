import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { clipBounds } from '../src/components/Menu';
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
    teams: [tm('t1', 'udc-team', 0)],
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); setController(null as unknown as Controller); });

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
      team: vi.fn(async () => ({ team: tm('t1', 'udc-team', 0), members: [] })),
    }), fakeWsFactory().makeWs));
    const doc = popupDoc();
    renderInPopup(doc, msg('m1', 'c1', 1, '@udc-team 봐', 'u1'));
    const wrap = doc.querySelector('[data-testid="mention-udc-team"]')!.parentElement!;
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
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { AttachmentRow } from '@harkroom/shared';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { ImageLightbox } from '../src/components/ImageLightbox';
import { clampScale, fitScale, scrollToKeep, stepDown, stepUp } from '../src/lib/imageZoom';

// 그림 보기(라이트박스) — designer 사양 3192efed. jsdom 은 배치를 안 하므로 칸 폭·그림 고유 크기를 심는다.

// jsdom 에는 PointerEvent 가 없다 — 좌표가 실리도록 MouseEvent 를 물려 만든다.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const shot: AttachmentRow = { id: 'a1', filename: 'shot.jpg', contentType: 'image/jpeg', sizeBytes: 900_000 };
const VIEW_W = 880;
const VIEW_H = 600;
let restore: (() => void) | null = null;

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  setController({ saveAttachment: vi.fn(async () => undefined) } as unknown as Controller);
  const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return VIEW_W; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return VIEW_H; } });
  restore = () => {
    if (w) Object.defineProperty(HTMLElement.prototype, 'clientWidth', w);
    if (h) Object.defineProperty(HTMLElement.prototype, 'clientHeight', h);
  };
});
afterEach(() => { cleanup(); restore?.(); usePrefsStore.getState().setLocale('system'); });

/** 1100×6000 세로로 긴 캡처를 연다(사양 5의 그림). */
function open(onClose = vi.fn(), size = { w: 1100, h: 6000 }) {
  render(<ImageLightbox attachment={shot} url="blob:shot" onClose={onClose} />);
  const img = screen.getByTestId('attachment-full') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: size.w });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: size.h });
  fireEvent.load(img);
  return { img, onClose, body: screen.getByTestId('zoom-body') };
}
const scaleOf = (img: HTMLElement) => Number(img.getAttribute('data-scale'));

describe('배율 셈', () => {
  it('폭 맞춤은 min(1, 칸 폭 / 그림 폭)이고 작은 그림은 키우지 않는다', () => {
    expect(fitScale(880, 1100)).toBeCloseTo(0.8);
    expect(fitScale(880, 400)).toBe(1);
    expect(fitScale(0, 1100)).toBe(1);
  });
  it('단계는 25·50·75·100·150·200·300·400 이고 맞춤 값이 그 사이에 낀다', () => {
    expect(stepUp(0.8, 0.8)).toBe(1);
    expect(stepDown(0.8, 0.8)).toBe(0.75);
    expect(stepUp(1, 0.8)).toBe(1.5);
    expect(stepDown(1, 0.8)).toBe(0.8);
    expect(stepUp(4, 0.8)).toBe(4);
    expect(stepDown(0.25, 0.8)).toBe(0.25);
  });
  it('범위는 min(맞춤, 25%) ~ 400%', () => {
    expect(clampScale(9, 0.8)).toBe(4);
    expect(clampScale(0.01, 0.8)).toBe(0.25);
    expect(clampScale(0.01, 0.1)).toBe(0.1);
  });
  it('배율을 바꿔도 기준점은 같은 자리에 남는다', () => {
    // 맞춤 0.5 에서 칸의 (100) 지점 = 그림의 200px. 1.0 이 되면 그 점이 다시 100 에 오도록 스크롤 100.
    expect(scrollToKeep(0, 100, 0.5, 1)).toBe(100);
  });
});

describe('그림 보기', () => {
  it('세로로 긴 그림은 폭 맞춤으로 열리고 맨 위부터 보인다', () => {
    const { img, body } = open();
    expect(scaleOf(img)).toBeCloseTo(VIEW_W / 1100, 3);
    expect(img.style.width).toBe(`${1100 * (VIEW_W / 1100)}px`);
    expect(body.scrollTop).toBe(0);
    expect(screen.getByTestId('zoom-level').textContent).toBe('맞춤 80%');
  });

  it('누르면 100%, Esc 한 번에 맞춤, 두 번에 닫힌다', () => {
    const { img, body, onClose } = open();
    fireEvent.pointerDown(img, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(img, { button: 0, clientX: 10, clientY: 10 });
    expect(scaleOf(img)).toBe(1);
    expect(screen.getByTestId('zoom-level').textContent).toBe('100%');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(scaleOf(img)).toBeCloseTo(0.8, 3);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('4px 넘게 끌면 이동이고 배율은 그대로다', () => {
    const { img, body } = open();
    act(() => { fireEvent.click(screen.getByTestId('zoom-actual')); });
    const before = body.scrollTop;
    fireEvent.pointerDown(img, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(img, { clientX: 100, clientY: 40 });
    fireEvent.pointerUp(img, { button: 0, clientX: 100, clientY: 40 });
    expect(scaleOf(img)).toBe(1);
    expect(body.scrollTop).toBe(before + 60);
    // 3px 은 끌기가 아니라 클릭이다 — 배율이 맞춤으로 바뀐다.
    fireEvent.pointerDown(img, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(img, { clientX: 100, clientY: 97 });
    fireEvent.pointerUp(img, { button: 0, clientX: 100, clientY: 97 });
    expect(scaleOf(img)).toBeCloseTo(0.8, 3);
  });

  // designer c: 그림 바깥 빈 자리를 눌러도 배율이 바뀌면 안 된다.
  it('그림 바깥 빈 자리를 누르면 배율이 그대로다', () => {
    const { img, body } = open();
    fireEvent.pointerDown(body, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(body, { button: 0, clientX: 5, clientY: 5 });
    expect(scaleOf(img)).toBeCloseTo(0.8, 3);
  });

  // designer 수정 1: 라이트박스가 받은 ⌘+/⌘−/⌘0 은 앱 전체 배율(Workspace 의 문서 버블 리스너)까지 가지 않는다.
  it('⌘+·⌘−·⌘0 이 앱 배율 리스너까지 내려가지 않는다', () => {
    const appZoom = vi.fn();
    const listener = (e: KeyboardEvent) => { if (e.metaKey) appZoom(e.key); };
    document.addEventListener('keydown', listener);
    try {
      const { img } = open();
      fireEvent.keyDown(document.body, { key: '=', metaKey: true });
      fireEvent.keyDown(document.body, { key: '-', metaKey: true });
      fireEvent.keyDown(document.body, { key: '0', metaKey: true });
      expect(appZoom).not.toHaveBeenCalled();
      expect(scaleOf(img)).toBeCloseTo(0.8, 3);
      // 라이트박스가 안 쓰는 ⌘ 키(⌘K 등)는 그대로 지나간다.
      fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
      expect(appZoom).toHaveBeenCalledWith('k');
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });

  // designer: 열면 포커스는 그림 칸이고, Tab 한 번에 머리줄(첫 버튼)로 간다.
  it('Tab 한 번에 그림 칸에서 머리줄 첫 버튼으로 간다', () => {
    const { body } = open();
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('zoom-out'));
  });

  it('작은 그림(맞춤 = 100%)은 기본 커서다', () => {
    const { body } = open(vi.fn(), { w: 300, h: 200 });
    expect(body.style.cursor).toBe('default');
  });

  it('⌘+·⌘−·⌘0·⌘1 이 단계를 지킨다', () => {
    const { img } = open();
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    expect(scaleOf(img)).toBe(1);
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    expect(scaleOf(img)).toBe(1.5);
    fireEvent.keyDown(document.body, { key: '-', metaKey: true });
    expect(scaleOf(img)).toBe(1);
    fireEvent.keyDown(document.body, { key: '0', metaKey: true });
    expect(scaleOf(img)).toBeCloseTo(0.8, 3);
    fireEvent.keyDown(document.body, { key: '1', metaKey: true });
    expect(scaleOf(img)).toBe(1);
  });

  it('핀치(ctrl+휠)는 배율을 바꾸고, 그냥 휠은 바꾸지 않는다', () => {
    const { img, body } = open();
    fireEvent.wheel(body, { deltaY: 100 });
    expect(scaleOf(img)).toBeCloseTo(0.8, 3);
    fireEvent.wheel(body, { deltaY: -20, ctrlKey: true });
    expect(scaleOf(img)).toBeGreaterThan(0.8);
  });

  it('버튼: [+]·[−]·[맞춤]·[100%] 와 이름(접근성)', () => {
    const { img } = open();
    expect(screen.getByRole('button', { name: '확대' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '축소' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '화면 폭에 맞춤' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '확대' }));
    expect(scaleOf(img)).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '화면 폭에 맞춤' }));
    expect(scaleOf(img)).toBeCloseTo(0.8, 3);
    expect(screen.getByTestId('zoom-level').getAttribute('aria-live')).toBe('polite');
  });

  it('작은 그림은 100% 로 열린다(키우지 않는다)', () => {
    const { img } = open(vi.fn(), { w: 300, h: 200 });
    expect(scaleOf(img)).toBe(1);
  });

  it('× 는 확대 상태에서도 바로 닫는다', () => {
    const { onClose } = open();
    fireEvent.click(screen.getByTestId('zoom-actual'));
    fireEvent.click(screen.getByRole('button', { name: '확대 보기 닫기' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

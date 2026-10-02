import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@harkroom/shared';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { ImageGallery, canPreview } from '../src/components/Attachments';
import { collectGallery, type GalleryItem } from '../src/lib/imageGallery';

// 그림 넘겨 보기 — designer 사양(2026-10-02) 1~4·6 의 데스크톱 몫.

const img = (id: string, extra: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({ id, filename: `${id}.png`, contentType: 'image/png', sizeBytes: 1000, ...extra });
const msg = (id: string, seq: number, attachments: AttachmentRow[], extra: Partial<MessageRow> = {}): MessageRow =>
  ({ id, seq, channelId: 'c1', threadRootId: null, authorId: 'u1', createdAt: '2026-10-02T01:00:00Z', attachments, alsoInChannel: false, ...extra }) as MessageRow;

describe('넘겨 볼 목록(사양 1)', () => {
  const messages = [
    msg('m3', 3, [img('r1')], { threadRootId: 'm1' }),
    msg('m1', 1, [img('a1'), img('a2')]),
    msg('m2', 2, [img('s1', { contentType: 'image/svg+xml' }), img('b1')]),
    msg('m4', 4, [img('r2')], { threadRootId: 'm1', alsoInChannel: true }),
    msg('m5', 5, [{ ...img('card', { contentType: 'text/html' }), artifact: { coverAttachmentId: 'cover' } as never }, img('cover')]),
    msg('m6', 6, [img('x1')], { threadRootId: 'm9' }),
  ];
  const ids = (items: GalleryItem[]) => items.map((i) => i.attachment.id);

  it('채널: 최상위 글과 채널에도 올린 답글만, seq·첨부 순서대로, svg·표지는 뺀다', () => {
    expect(ids(collectGallery(messages, { kind: 'channel' }, canPreview))).toEqual(['a1', 'a2', 'b1', 'r2']);
  });
  it('스레드: 그 스레드의 루트와 답글만', () => {
    expect(ids(collectGallery(messages, { kind: 'thread', rootId: 'm1' }, canPreview))).toEqual(['a1', 'a2', 'r1', 'r2']);
  });
});

let restore: (() => void) | null = null;
const fetchAttachment = vi.fn(async (id: string) => new Blob([id]));
const openMessage = vi.fn(async () => undefined);

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  fetchAttachment.mockClear();
  openMessage.mockClear();
  setController({ saveAttachment: vi.fn(async () => undefined), fetchAttachment, openMessage } as unknown as Controller);
  let n = 0;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn();
  const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
  restore = () => {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    if (w) Object.defineProperty(HTMLElement.prototype, 'clientWidth', w);
  };
});
afterEach(() => { cleanup(); restore?.(); usePrefsStore.getState().setLocale('system'); });

const three: GalleryItem[] = [
  { attachment: img('g1'), message: msg('m1', 1, []) },
  { attachment: img('g2'), message: msg('m2', 2, []) },
  { attachment: img('g3'), message: msg('m3', 3, []) },
];

async function open(start = 0, items = three) {
  const onClose = vi.fn();
  render(<ImageGallery items={items} start={start} startUrl="blob:start" onClose={onClose} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return onClose;
}
function loadFull(w = 1600, h = 1000) {
  const el = screen.getByTestId('attachment-full') as HTMLImageElement;
  Object.defineProperty(el, 'naturalWidth', { configurable: true, value: w });
  Object.defineProperty(el, 'naturalHeight', { configurable: true, value: h });
  fireEvent.load(el);
  return el;
}
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document, { key: k, ...init });
const pos = () => screen.getByTestId('gallery-position').textContent;

describe('넘기기(사양 2·3·4)', () => {
  it('→ 로 다음 장, 끝에서는 멈추고 그쪽 화살표를 숨긴다', async () => {
    await open();
    expect(pos()).toBe('1 / 3');
    expect(screen.queryByTestId('gallery-prev')).toBeNull();
    key('ArrowRight');
    await act(async () => { await Promise.resolve(); });
    expect(pos()).toBe('2 / 3');
    fireEvent.click(screen.getByTestId('gallery-next'));
    expect(pos()).toBe('3 / 3');
    expect(screen.queryByTestId('gallery-next')).toBeNull();
    key('ArrowRight');
    expect(pos()).toBe('3 / 3');
    key('ArrowLeft');
    expect(pos()).toBe('2 / 3');
  });

  it('연 그림은 다시 받지 않고, 이웃(±1)은 미리 받는다', async () => {
    await open(1);
    expect(fetchAttachment.mock.calls.map((c) => c[0]).sort()).toEqual(['g1', 'g3']);
    expect((screen.getByTestId('attachment-full') as HTMLImageElement).src).toBe('blob:start');
  });

  it('확대 중이고 가로로 넘치면 → 는 스크롤이다 — Esc 로 맞춤에 돌아간 뒤 넘어간다', async () => {
    await open();
    const el = loadFull();
    key('1', { metaKey: true });
    expect(Number(el.getAttribute('data-scale'))).toBe(1);
    key('ArrowRight');
    expect(pos()).toBe('1 / 3');
    key('Escape');
    key('ArrowRight');
    expect(pos()).toBe('2 / 3');
  });

  it('넘기면 새 장은 맞춤으로 연다', async () => {
    await open();
    loadFull();
    key('1', { metaKey: true });
    key('Escape'); // 맞춤으로
    key('2'); // 아무 일 없음
    fireEvent.click(screen.getByTestId('gallery-next'));
    await act(async () => { await Promise.resolve(); });
    const next = loadFull();
    expect(Number(next.getAttribute('data-scale'))).toBeCloseTo(0.5);
    expect(screen.getByTestId('zoom-level').textContent).toContain('맞춤');
  });

  it('트랙패드 좌우 스와이프는 80px 를 넘기면 한 장, 손을 뗄 때까지 한 번만 넘긴다', async () => {
    vi.useFakeTimers();
    try {
      await open();
      const body = screen.getByTestId('zoom-body');
      for (let i = 0; i < 10; i += 1) fireEvent.wheel(body, { deltaX: 30, deltaY: 0 });
      expect(pos()).toBe('2 / 3');
      act(() => { vi.advanceTimersByTime(300); });
      fireEvent.wheel(body, { deltaX: 90, deltaY: 0 });
      expect(pos()).toBe('3 / 3');
    } finally { vi.useRealTimers(); }
  });

  it('[글로 가기]는 닫고 그 글을 연다', async () => {
    const onClose = await open(2);
    fireEvent.click(screen.getByTestId('gallery-goto'));
    expect(onClose).toHaveBeenCalled();
    expect(openMessage).toHaveBeenCalledWith('m3', three[2]!.message);
  });

  it('못 받은 장은 「불러오지 못했다」와 [다시 받기]를 보인다', async () => {
    fetchAttachment.mockImplementation(async (id: string) => { if (id === 'g2') throw new Error('x'); return new Blob([id]); });
    await open();
    key('ArrowRight');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('gallery-retry')).toBeTruthy();
    fetchAttachment.mockImplementation(async (id: string) => new Blob([id]));
    fireEvent.click(screen.getByTestId('gallery-retry'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('attachment-full')).toBeTruthy();
  });

  it('닫으면 여기서 만든 objectURL 을 revoke 한다', async () => {
    await open();
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});

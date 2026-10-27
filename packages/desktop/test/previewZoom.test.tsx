import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import type { AttachmentRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { ArtifactPanel } from '../src/components/ArtifactPreview';
import { acc } from './helpers/fakeApi';
import {
  PREVIEW_ZOOM_DEFAULT, PREVIEW_ZOOM_REMEMBERED, effectiveScale, normalizePreviewZoom, previewZoomStorage, stepPreviewZoom,
  viewportWidth,
} from '../src/lib/previewZoom';

// 미리보기 배율 — designer 시안 v1 C안(스레드 ee707114). 결정: 50~200% 10칸 · 기본 100% · 시안마다 기억 ·
// ⌘+/−/0 은 새 창·⤢ 창 전체에서만.

describe('preview zoom math', () => {
  it('steps through the browser-style table and stops at the ends', () => {
    let z = PREVIEW_ZOOM_DEFAULT;
    z = stepPreviewZoom(z, -1, 500);
    expect(z).toEqual({ kind: 'scale', pct: 90 });
    for (let i = 0; i < 10; i++) z = stepPreviewZoom(z, -1, 500);
    expect(z).toEqual({ kind: 'scale', pct: 50 });
    for (let i = 0; i < 20; i++) z = stepPreviewZoom(z, 1, 500);
    expect(z).toEqual({ kind: 'scale', pct: 200 });
  });

  it('fits a wide page into a narrow box and never enlarges past 100%', () => {
    expect(effectiveScale({ kind: 'fit', width: 1440 }, 520)).toBeCloseTo(520 / 1440);
    expect(effectiveScale({ kind: 'fit', width: 390 }, 520)).toBe(1);
    // 상자를 아직 못 쟀으면 1 — 그림이 0 배율로 사라지지 않는다.
    expect(effectiveScale({ kind: 'fit', width: 1440 }, 0)).toBe(1);
  });

  it('steps strictly away from a fitted scale (36% → + 50%, − stays)', () => {
    const fit = { kind: 'fit' as const, width: 1440 };
    expect(stepPreviewZoom(fit, 1, 520)).toEqual({ kind: 'scale', pct: 50 });
    expect(stepPreviewZoom(fit, -1, 520)).toBe(fit);
  });

  it('reports the width the page sees', () => {
    expect(viewportWidth({ kind: 'scale', pct: 75 }, 520)).toBe(693);
    expect(viewportWidth({ kind: 'fit', width: 1280 }, 520)).toBe(1280);
  });

  it('drops stored values that are not on the table', () => {
    expect(normalizePreviewZoom({ kind: 'scale', pct: 33 })).toBeNull();
    expect(normalizePreviewZoom({ kind: 'fit', width: 1000 })).toBeNull();
    expect(normalizePreviewZoom('x')).toBeNull();
    expect(normalizePreviewZoom({ kind: 'fit', width: 768 })).toEqual({ kind: 'fit', width: 768 });
  });
});

describe('preview zoom storage', () => {
  beforeEach(() => localStorage.clear());

  it('remembers per artifact and forgets the default', () => {
    previewZoomStorage.save('a', { kind: 'scale', pct: 75 });
    previewZoomStorage.save('b', { kind: 'fit', width: 1440 });
    expect(previewZoomStorage.load('a')).toEqual({ kind: 'scale', pct: 75 });
    expect(previewZoomStorage.load('b')).toEqual({ kind: 'fit', width: 1440 });
    expect(previewZoomStorage.load('c')).toEqual(PREVIEW_ZOOM_DEFAULT);
    previewZoomStorage.save('a', PREVIEW_ZOOM_DEFAULT);
    previewZoomStorage.save('b', PREVIEW_ZOOM_DEFAULT);
    expect(localStorage.getItem('harkroom.previewZoom')).toBeNull();
  });

  it('keeps only the most recent entries', () => {
    for (let i = 0; i <= PREVIEW_ZOOM_REMEMBERED; i++) previewZoomStorage.save(`a${i}`, { kind: 'scale', pct: 75 }, i);
    expect(previewZoomStorage.load('a0')).toEqual(PREVIEW_ZOOM_DEFAULT);
    expect(previewZoomStorage.load(`a${PREVIEW_ZOOM_REMEMBERED}`)).toEqual({ kind: 'scale', pct: 75 });
  });

  it('survives a broken stored value', () => {
    localStorage.setItem('harkroom.previewZoom', '{not json');
    expect(previewZoomStorage.load('a')).toEqual(PREVIEW_ZOOM_DEFAULT);
  });
});

const page = (id: string, artifactId: string, version = 1): AttachmentRow => ({
  id, filename: 'board.html', contentType: 'text/html', sizeBytes: 2048,
  artifact: { artifactId, version, latestVersion: version, title: '보드', summary: null, coverAttachmentId: null },
});

describe('the zoom control in the preview panel', () => {
  const open = (a: AttachmentRow) => act(() => { useAppStore.getState().set({ artifactPreview: a }); });
  beforeEach(() => {
    localStorage.clear();
    usePrefsStore.getState().setLocale('ko');
    usePrefsStore.getState().setZoom(100);
    useAppStore.getState().reset();
    useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') }, activeChannelId: 'c1' });
    setController({
      closeArtifactPreview: vi.fn(() => useAppStore.getState().set({ artifactPreview: null })),
      saveAttachment: vi.fn(async () => undefined),
      issuePreview: vi.fn(async (id: string) => ({
        path: `/preview/${id}`, url: `https://server.example.com/preview/${id}`, expiresAt: '2026-10-02T00:01:00Z',
        artifactId: 'x', version: 1, latestVersion: 1, title: '보드',
      })),
    } as unknown as Controller);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    usePrefsStore.getState().setLocale('system');
  });

  it('is at 100% by default and draws the frame exactly as before', async () => {
    render(<ArtifactPanel />);
    open(page('p1', 'art-1'));
    const frame = await screen.findByTestId('artifact-frame');
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('100%');
    expect(frame.getAttribute('style')).toBeNull();
    expect(frame.className).toContain('h-full w-full');
    expect(screen.queryByTestId('artifact-zoom-note')).toBeNull();
  });

  it('is dimmed while there is no page', () => {
    render(<ArtifactPanel />);
    open(page('p1', 'art-1'));
    expect((screen.getByTestId('artifact-zoom-menu') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('artifact-zoom-in') as HTMLButtonElement).disabled).toBe(true);
  });

  it('scales the frame with − and draws it larger so the page sees a wider screen', async () => {
    render(<ArtifactPanel />);
    open(page('p1', 'art-1'));
    await screen.findByTestId('artifact-frame');
    fireEvent.click(screen.getByTestId('artifact-zoom-out'));
    fireEvent.click(screen.getByTestId('artifact-zoom-out'));
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('80%');
    const style = screen.getByTestId('artifact-frame').style;
    expect(style.transform).toBe('scale(0.8)');
    expect(style.width).toBe('125%');
    expect(style.height).toBe('125%');
  });

  it('remembers the zoom per artifact and carries it to the next version', async () => {
    const { unmount } = render(<ArtifactPanel />);
    open(page('p1', 'art-1'));
    await screen.findByTestId('artifact-frame');
    fireEvent.click(screen.getByTestId('artifact-zoom-out'));
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('90%');
    // 다른 시안은 100%.
    open(page('q1', 'art-2'));
    await waitFor(() => expect(screen.getByTestId('artifact-frame').getAttribute('src')).toContain('/preview/q1'));
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('100%');
    unmount();
    // 같은 시안의 v2 는 90% 를 이어받는다 — 첫 그림부터.
    render(<ArtifactPanel />);
    open(page('p2', 'art-1', 2));
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('90%');
  });

  it('fits a width from the menu and says so in the footer', async () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: () => void) {}
      observe() { this.cb(); }
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 520, height: 600 } as DOMRect);
    render(<ArtifactPanel />);
    open(page('p1', 'art-1'));
    await screen.findByTestId('artifact-frame');
    fireEvent.click(screen.getByTestId('artifact-zoom-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: '데스크톱 1440px 폭에 맞춤' }));
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('36%');
    expect(screen.getByTestId('artifact-frame').style.width).toBe('1440px');
    expect(screen.getByTestId('artifact-zoom-note').textContent).toBe('1440px 폭에 맞춤');
    // 390 맞춤은 넓은 상자에서 100% 로 가운데 선다.
    fireEvent.click(screen.getByTestId('artifact-zoom-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: '폰 390px 폭에 맞춤' }));
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('100%');
    expect(screen.getByTestId('artifact-frame').style.left).toBe('65px');
  });

  it('leaves ⌘+/−/0 to the app zoom in the side panel', async () => {
    render(<ArtifactPanel />);
    open(page('p1', 'art-1'));
    await screen.findByTestId('artifact-frame');
    const notPrevented = fireEvent.keyDown(document, { key: '-', metaKey: true });
    expect(notPrevented).toBe(true);
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('100%');
    // 옆 패널 메뉴에는 단축키 표기가 없다.
    fireEvent.click(screen.getByTestId('artifact-zoom-menu'));
    expect(screen.getByRole('menuitem', { name: '100%로' }).textContent).not.toContain('⌘0');
  });

  it('takes ⌘+/−/0 for the preview when expanded to the window', async () => {
    render(<ArtifactPanel />);
    open(page('p1', 'art-1'));
    await screen.findByTestId('artifact-frame');
    fireEvent.click(screen.getByTestId('artifact-panel-expand'));
    const appListener = vi.fn();
    document.addEventListener('keydown', appListener);
    expect(fireEvent.keyDown(document.body, { key: '-', metaKey: true })).toBe(false);
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('90%');
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('110%');
    fireEvent.keyDown(document.body, { key: '0', metaKey: true });
    expect(screen.getByTestId('artifact-zoom-menu').textContent).toContain('100%');
    // 앱 배율 쪽(Workspace·새 창 가드)으로는 가지 않는다.
    expect(appListener).not.toHaveBeenCalled();
    document.removeEventListener('keydown', appListener);
    fireEvent.click(screen.getByTestId('artifact-zoom-menu'));
    expect(screen.getByRole('menuitem', { name: '100%로' }).textContent).toContain('⌘0');
  });
});

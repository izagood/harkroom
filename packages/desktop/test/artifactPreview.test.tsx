import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { Attachments } from '../src/components/Attachments';
import { ArtifactPanel } from '../src/components/ArtifactPreview';
import { ApiError } from '../src/lib/api';
import { acc, msg } from './helpers/fakeApi';
import { previewLayout } from '../src/lib/previewLayout';

// 미리보기 ④ — 카드·오른쪽 패널. 사양 designer d8ca47be·abcc05cf, 조건 security(스레드 31121b84).

const ART = 'art-1';
const page = (over: Partial<AttachmentRow> = {}, artifact: Partial<NonNullable<AttachmentRow['artifact']>> = {}): AttachmentRow => ({
  id: 'p1', filename: 'board.html', contentType: 'text/html', sizeBytes: 2048,
  artifact: { artifactId: ART, version: 1, latestVersion: 1, title: 'Inbox 보드 v1', summary: '열 이름 정정', coverAttachmentId: null, ...artifact },
  ...over,
});
const withAtt = (id: string, attachments: AttachmentRow[]): MessageRow => ({ ...msg(id, 'c1', 1, '시안', 'u2'), attachments });

const ticket = (over: Record<string, unknown> = {}) => ({
  path: '/preview/tok', url: 'https://server.example.com/preview/tok', expiresAt: '2026-10-02T00:01:00Z',
  artifactId: ART, version: 1, latestVersion: 1, title: 'Inbox 보드 v1', ...over,
});

const fakeController = (over: Record<string, unknown> = {}) => {
  const c = {
    fetchAttachment: vi.fn(async () => new Blob(['png'])),
    saveAttachment: vi.fn(async () => undefined),
    openArtifactPreview: vi.fn((a: AttachmentRow) => useAppStore.getState().set({ artifactPreview: a })),
    closeArtifactPreview: vi.fn(() => useAppStore.getState().set({ artifactPreview: null })),
    issuePreview: vi.fn(async (_id: string) => ticket()),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') }, activeChannelId: 'c1' });
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('the preview card in a message', () => {
  it('shows a text card with title, version, summary and size — no frame in the list', () => {
    fakeController();
    render(<Attachments attachments={[page()]} />);
    const card = screen.getByTestId('artifact-card');
    expect(card.textContent).toContain('Inbox 보드 v1');
    expect(card.textContent).toContain('v1');
    expect(card.textContent).toContain('열 이름 정정');
    expect(card.textContent).toContain('2.0 KB');
    expect(screen.queryByTestId('artifact-card-cover')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('opens the panel when the card is pressed', () => {
    const c = fakeController();
    render(<Attachments attachments={[page()]} />);
    fireEvent.click(screen.getByTestId('artifact-card'));
    expect(c.openArtifactPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), 'channel');
  });

  it('draws the cover inside the card and not again as a picture', async () => {
    fakeController();
    const cover: AttachmentRow = { id: 'c1', filename: 'cover.png', contentType: 'image/png', sizeBytes: 10 };
    render(<Attachments attachments={[page({}, { coverAttachmentId: 'c1' }), cover]} />);
    await waitFor(() => expect(screen.getByTestId('artifact-card-cover')).toBeTruthy());
    expect(screen.queryByTestId('attachment-preview')).toBeNull();
  });

  // security ④: svg 는 <img>(blob) 화이트리스트 밖이다 — 표지로 와도 그리지 않는다.
  it('does not draw an svg cover', () => {
    const c = fakeController();
    const cover: AttachmentRow = { id: 'c1', filename: 'cover.svg', contentType: 'image/svg+xml', sizeBytes: 10 };
    render(<Attachments attachments={[page({}, { coverAttachmentId: 'c1' }), cover]} />);
    expect(screen.queryByTestId('artifact-card-cover')).toBeNull();
    expect(c.fetchAttachment).not.toHaveBeenCalled();
  });

  // 서버의 latestVersion 은 읽은 순간 값이다 — 새 버전 글이 메모리에 들어오면 옛 카드가 스스로 알약을 단다.
  it('marks an old card when a newer version of the same artifact is loaded', () => {
    fakeController();
    render(<Attachments attachments={[page()]} />);
    expect(screen.queryByTestId('artifact-card-latest')).toBeNull();
    act(() => {
      useAppStore.getState().set({
        messages: { c1: [withAtt('m1', [page()]), withAtt('m2', [page({ id: 'p2' }, { version: 3, latestVersion: 3, title: 'Inbox 보드 v3' })])] },
      });
    });
    expect(screen.getByTestId('artifact-card-latest').textContent).toBe('최신 v3 있음');
  });

  it('keeps the version title on an old card even when the server knows a newer one', () => {
    fakeController();
    render(<Attachments attachments={[page({}, { latestVersion: 2 })]} />);
    expect(screen.getByTestId('artifact-card').textContent).toContain('Inbox 보드 v1');
    expect(screen.getByTestId('artifact-card-latest').textContent).toBe('최신 v2 있음');
  });

  it('says which pane the card was pressed in', () => {
    const c = fakeController();
    render(<Attachments attachments={[page()]} from="thread" />);
    fireEvent.click(screen.getByTestId('artifact-card'));
    expect(c.openArtifactPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), 'thread');
  });

  // designer a: 고쳐 올린 안인지 첫 판인지 카드에서 보인다.
  it('shows how many earlier versions a revised card has', () => {
    fakeController();
    render(<Attachments attachments={[page({}, { version: 3, latestVersion: 3 })]} />);
    expect(screen.getByTestId('artifact-card').textContent).toContain('v3 · 이전 2개');
  });

  // designer c: 지금 패널에 떠 있는 카드에 선택 표시.
  it('marks the card whose page is open in the panel', () => {
    fakeController();
    render(<Attachments attachments={[page(), page({ id: 'p2' }, { version: 2, latestVersion: 2 })]} />);
    act(() => { useAppStore.getState().set({ artifactPreview: page({ id: 'p2' }, { version: 2 }) }); });
    const cards = screen.getAllByTestId('artifact-card');
    expect(cards.map((c) => c.getAttribute('data-selected'))).toEqual(['false', 'true']);
  });

  it('leaves a plain attachment as it was', () => {
    fakeController();
    render(<Attachments attachments={[{ id: 'n1', filename: 'note.txt', contentType: 'text/plain', sizeBytes: 5 }]} />);
    expect(screen.queryByTestId('artifact-card')).toBeNull();
    expect(screen.getByText('note.txt')).toBeTruthy();
  });
});

describe('the preview panel', () => {
  const open = (a: AttachmentRow = page()) => act(() => { useAppStore.getState().set({ artifactPreview: a }); });

  it('is absent until a preview is opened', () => {
    fakeController();
    render(<ArtifactPanel />);
    expect(screen.queryByTestId('artifact-panel')).toBeNull();
  });

  it('frames the signed URL in a scripts-only sandbox with the app header outside the frame', async () => {
    const c = fakeController();
    render(<ArtifactPanel />);
    open();
    const frame = await screen.findByTestId('artifact-frame');
    expect(c.issuePreview).toHaveBeenCalledWith('p1');
    expect(frame.getAttribute('src')).toBe('https://server.example.com/preview/tok');
    // 서버 CSP 와 교집합 — 같은 origin·상위 이동·새 창·폼을 주지 않는다.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const title = screen.getByTestId('artifact-panel-title');
    expect(title.textContent).toBe('Inbox 보드 v1');
    expect(frame.contains(title)).toBe(false);
    expect(screen.getByText('에이전트가 만든 페이지')).toBeTruthy();
  });

  // A′: Tauri 안에서는 src 를 넣기 전에 그 URL 을 내비게이션 훅에 한 번 허용해 둔다. 실패하면 src 를 넣지 않는다.
  it('allows the signed URL in the navigation hook before framing it, every time', async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => { calls.push(`${cmd}:${String(args?.url)}`); });
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    try {
      fakeController({
        issuePreview: vi.fn()
          .mockResolvedValueOnce(ticket())
          .mockResolvedValueOnce(ticket({ url: 'https://server.example.com/preview/tok2' })),
      });
      render(<ArtifactPanel />);
      open();
      const frame = await screen.findByTestId('artifact-frame');
      expect(calls).toEqual(['allow_preview_once:https://server.example.com/preview/tok']);
      expect(frame.getAttribute('src')).toBe('https://server.example.com/preview/tok');
      fireEvent.click(screen.getAllByTestId('artifact-panel-reload')[0]!);
      await waitFor(() => expect(screen.getByTestId('artifact-frame').getAttribute('src')).toBe('https://server.example.com/preview/tok2'));
      expect(calls).toEqual([
        'allow_preview_once:https://server.example.com/preview/tok',
        'allow_preview_once:https://server.example.com/preview/tok2',
      ]);
    } finally {
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('does not frame the URL when the hook refuses to hold it', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: vi.fn(async () => { throw new Error('only /preview/ paths'); }) };
    try {
      fakeController();
      render(<ArtifactPanel />);
      open();
      await waitFor(() => expect(screen.getByTestId('artifact-panel-state').getAttribute('data-state')).toBe('failed'));
      expect(screen.queryByTestId('artifact-frame')).toBeNull();
    } finally {
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('asks for a fresh signed path every time it reloads (an expired path is not an error)', async () => {
    const c = fakeController({
      issuePreview: vi.fn()
        .mockResolvedValueOnce(ticket())
        .mockResolvedValueOnce(ticket({ url: 'https://server.example.com/preview/tok2' })),
    });
    render(<ArtifactPanel />);
    open();
    await screen.findByTestId('artifact-frame');
    fireEvent.click(screen.getAllByTestId('artifact-panel-reload')[0]!);
    await waitFor(() => expect(screen.getByTestId('artifact-frame').getAttribute('src')).toBe('https://server.example.com/preview/tok2'));
    expect(c.issuePreview).toHaveBeenCalledTimes(2);
  });

  // security ④: sandbox 는 프레임 자신의 이동을 막지 않는다 — 두 번째 load 는 페이지가 스스로 간 것이다.
  it('takes the frame down when the page navigates itself away', async () => {
    fakeController();
    render(<ArtifactPanel />);
    open();
    const frame = await screen.findByTestId('artifact-frame');
    fireEvent.load(frame);
    expect(screen.getByTestId('artifact-frame')).toBeTruthy();
    fireEvent.load(frame);
    expect(screen.queryByTestId('artifact-frame')).toBeNull();
    expect(screen.getByTestId('artifact-panel-state').getAttribute('data-state')).toBe('navigated');
  });

  it.each([
    [413, 'tooLarge', '미리보기 한도를 넘는다'],
    [403, 'forbidden', '볼 수 없다'],
    [404, 'gone', '지워진 미리보기'],
  ])('says why it cannot open (%s)', async (status, state, text) => {
    fakeController({ issuePreview: vi.fn(async () => { throw new ApiError(status, 'x', 'x'); }) });
    render(<ArtifactPanel />);
    open();
    await waitFor(() => expect(screen.getByTestId('artifact-panel-state').getAttribute('data-state')).toBe(state));
    expect(screen.getByTestId('artifact-panel-state').textContent).toContain(text);
  });

  it('expands to the window, and Esc steps back one level at a time', async () => {
    const c = fakeController();
    render(<ArtifactPanel />);
    open();
    await screen.findByTestId('artifact-frame');
    fireEvent.click(screen.getByTestId('artifact-panel-expand'));
    expect(screen.getByTestId('artifact-panel').getAttribute('data-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('artifact-panel').getAttribute('data-expanded')).toBe('false');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(c.closeArtifactPreview).toHaveBeenCalled();
    expect(screen.queryByTestId('artifact-panel')).toBeNull();
  });

  // designer f: 한도 초과에서 할 수 있는 유일한 일을 본문에도 둔다.
  it('offers the download in the body when the page is too large', async () => {
    const c = fakeController({ issuePreview: vi.fn(async () => { throw new ApiError(413, 'too_large', 'x'); }) });
    render(<ArtifactPanel />);
    open();
    fireEvent.click(await screen.findByTestId('artifact-panel-download-body'));
    expect(c.saveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  // designer 수정 2: 창 전체로 펼친 머리줄은 창을 끄는 자리다.
  it('makes the expanded header a window drag region', async () => {
    fakeController();
    render(<ArtifactPanel />);
    open();
    await screen.findByTestId('artifact-frame');
    expect(screen.getByTestId('artifact-panel-header').hasAttribute('data-tauri-drag-region')).toBe(false);
    fireEvent.click(screen.getByTestId('artifact-panel-expand'));
    expect(screen.getByTestId('artifact-panel-header').hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('downloads the file from the footer', async () => {
    const c = fakeController();
    render(<ArtifactPanel />);
    open();
    fireEvent.click(await screen.findByTestId('artifact-panel-download'));
    expect(c.saveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });
});

// designer 수정 1: 미리보기가 열린 동안 내용 칸은 둘(누른 칸 + 미리보기), 닫으면 그대로 돌아온다.
describe('which panes stay beside the preview', () => {
  it('keeps everything when no preview is open', () => {
    expect(previewLayout(null, true)).toEqual({ hideMain: false, hideThread: false, hideTerminal: false, fillPreview: false });
  });
  it('keeps the thread and folds the channel when the card was in the thread', () => {
    expect(previewLayout('thread', true)).toEqual({ hideMain: true, hideThread: false, hideTerminal: true, fillPreview: true });
  });
  it('keeps the channel and folds the thread when the card was in the channel', () => {
    expect(previewLayout('channel', true)).toEqual({ hideMain: false, hideThread: true, hideTerminal: true, fillPreview: false });
  });
  it('keeps the channel when the thread the card came from has since closed', () => {
    expect(previewLayout('thread', false).hideMain).toBe(false);
  });
});

// jaebin 신고(2026-10-05): 패널이 좁고 넓힐 수 없다 · 시안 카드인지 안 보인다 · 닫아도 주황 테두리가 남는다.
// 사양은 designer 답(같은 날, 스레드 39b9c322).
describe('preview panel width and leaving the card', () => {
  beforeEach(() => { localStorage.removeItem('harkroom.previewWidth'); });

  it('stands at the default css width, remembers the dragged width, and double-click forgets it', () => {
    fakeController();
    useAppStore.getState().set({ artifactPreview: page() });
    render(<ArtifactPanel />);
    const panel = screen.getByTestId('artifact-panel');
    expect(panel.style.width).toBe('min(48rem, 50vw)');
    expect(panel.style.minWidth).toBe('360px');
    const handle = screen.getByRole('separator', { name: '미리보기 너비 조절' });
    // jsdom 은 폭을 재지 못한다 — 원점은 하한(360)이다.
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 200 });
    fireEvent.mouseUp(document);
    expect(panel.style.width).toBe('660px');
    expect(localStorage.getItem('harkroom.previewWidth')).toBe('660');
    cleanup();
    useAppStore.getState().set({ artifactPreview: page() });
    render(<ArtifactPanel />);
    expect(screen.getByTestId('artifact-panel').style.width).toBe('660px');
    fireEvent.doubleClick(screen.getByRole('separator', { name: '미리보기 너비 조절' }));
    expect(screen.getByTestId('artifact-panel').style.width).toBe('min(48rem, 50vw)');
    expect(localStorage.getItem('harkroom.previewWidth')).toBeNull();
  });

  it('has no handle while expanded to the whole window', () => {
    fakeController();
    useAppStore.getState().set({ artifactPreview: page() });
    render(<ArtifactPanel />);
    fireEvent.click(screen.getByTestId('artifact-panel-expand'));
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('marks the card as a preview and says which one is open', () => {
    fakeController();
    render(<><Attachments attachments={[page()]} /><ArtifactPanel /></>);
    expect(screen.getByTestId('artifact-card-icon')).toBeTruthy();
    expect(screen.getByTestId('artifact-card-action').textContent).toBe('미리보기 열기 ›');
    fireEvent.click(screen.getByTestId('artifact-card'), { detail: 1 });
    expect(screen.getByTestId('artifact-card-action').textContent).toBe('미리보기 중');
  });

  it('opened with the mouse: lets go of the card focus on close, so no ring stays behind', () => {
    fakeController();
    render(<><Attachments attachments={[page()]} /><ArtifactPanel /></>);
    const card = screen.getByTestId('artifact-card');
    card.focus();
    fireEvent.click(card, { detail: 1 });
    expect(card.getAttribute('data-selected')).toBe('true');
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(useAppStore.getState().artifactPreview).toBeNull();
    expect(card.getAttribute('data-selected')).toBe('false');
    expect(document.activeElement).not.toBe(card);
  });

  it('opened with the keyboard: gives focus back to the card on close', () => {
    fakeController();
    render(<><Attachments attachments={[page()]} /><ArtifactPanel /></>);
    const card = screen.getByTestId('artifact-card');
    fireEvent.click(card, { detail: 0 });
    (document.body as HTMLElement).focus();
    act(() => { fireEvent.click(screen.getByTestId('artifact-panel-close')); });
    expect(card.getAttribute('data-selected')).toBe('false');
    expect(document.activeElement).toBe(card);
  });

  it('closes when another channel or thread is chosen', () => {
    const c = fakeController();
    useAppStore.getState().set({ artifactPreview: page() });
    render(<ArtifactPanel />);
    act(() => { useAppStore.getState().set({ threadRootId: 'm9' }); });
    expect(c.closeArtifactPreview).toHaveBeenCalled();
    expect(screen.queryByTestId('artifact-panel')).toBeNull();
  });

  it('switches to another card without closing', () => {
    const c = fakeController();
    render(<><Attachments attachments={[page(), page({ id: 'p2' }, { version: 2 })]} /><ArtifactPanel /></>);
    const [a, b] = screen.getAllByTestId('artifact-card') as [HTMLElement, HTMLElement];
    fireEvent.click(a, { detail: 1 });
    fireEvent.click(b, { detail: 1 });
    expect(c.closeArtifactPreview).not.toHaveBeenCalled();
    expect(b.getAttribute('data-selected')).toBe('true');
    expect(a.getAttribute('data-selected')).toBe('false');
  });
});

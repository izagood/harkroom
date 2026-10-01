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
    expect(c.openArtifactPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
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

  it('downloads the file from the footer', async () => {
    const c = fakeController();
    render(<ArtifactPanel />);
    open();
    fireEvent.click(await screen.findByTestId('artifact-panel-download'));
    expect(c.saveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });
});

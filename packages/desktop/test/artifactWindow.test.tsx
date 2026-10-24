import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { Attachments } from '../src/components/Attachments';
import { ArtifactPanel } from '../src/components/ArtifactPreview';
import { AppWindowsHost } from '../src/components/AppWindowsHost';
import {
  appWindowKey, loadSavedAppWindows, openAppWindow, persistAppWindows, resetAppWindowsForTest, setWindowOpener, useAppWindows,
} from '../src/lib/appWindows';
import { acc, msg } from './helpers/fakeApi';

/**
 * 미리보기(아티팩트) 패널 ⧉ → 새 창. 창 구조는 스레드 창(#1174)과 같다 — jsdom 의 두 번째 문서가
 * `window.open` 이 돌려주는 같은 출처 창 노릇을 한다(`appWindowsHost.test.tsx` 와 같은 꼴).
 */
function fakeWin() {
  const doc = document.implementation.createHTMLDocument('popup');
  const listeners: Record<string, Array<() => void>> = {};
  const win = {
    closed: false,
    document: doc,
    focus: vi.fn(),
    close: vi.fn(() => { win.closed = true; (listeners.pagehide ?? []).forEach((f) => f()); }),
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: () => undefined,
  };
  return win;
}

const page = (id: string, version: number): AttachmentRow => ({
  id, filename: 'board.html', contentType: 'text/html', sizeBytes: 2048,
  artifact: { artifactId: 'art-1', version, latestVersion: version, title: `보드 v${version}`, summary: '', coverAttachmentId: null },
});
const withAtt = (id: string, attachments: AttachmentRow[]): MessageRow => ({ ...msg(id, 'c1', 1, '시안', 'u2'), attachments });

const fakeController = () => {
  const c = {
    fetchAttachment: vi.fn(async () => new Blob(['png'])),
    saveAttachment: vi.fn(async () => undefined),
    openArtifactPreview: vi.fn((a: AttachmentRow) => useAppStore.getState().set({ artifactPreview: a, artifactPreviewFrom: 'channel' })),
    closeArtifactPreview: vi.fn(() => useAppStore.getState().set({ artifactPreview: null, artifactPreviewFrom: null })),
    issuePreview: vi.fn(async (id: string) => ({
      path: `/preview/${id}`, url: `https://server.example.com/preview/${id}`, expiresAt: '2026-10-02T00:01:00Z',
      artifactId: 'art-1', version: 1, latestVersion: 1, title: '보드 v1',
    })),
  };
  setController(c as unknown as Controller);
  return c;
};

let wins: ReturnType<typeof fakeWin>[] = [];

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetAppWindowsForTest();
  wins = [];
  setWindowOpener({ open: () => { const w = fakeWin(); wins.push(w); return w as unknown as Window; } });
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') }, activeChannelId: 'c1' });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('미리보기 새 창', () => {
  it('패널 머리 ⧉ 는 그 판을 창으로 **옮긴다** — 패널은 닫히고 카드의 「보는 중」 표시도 걷힌다', async () => {
    const c = fakeController();
    const v1 = page('p1', 1);
    useAppStore.getState().set({ messages: { c1: [withAtt('m1', [v1])] } });
    render(<><Attachments attachments={[v1]} /><ArtifactPanel /><AppWindowsHost /></>);
    fireEvent.click(screen.getByTestId('artifact-card'));
    expect(screen.getByTestId('artifact-card').getAttribute('data-selected')).toBe('true');

    // ⧉ 는 × 바로 왼쪽(스레드 패널 머리와 같은 자리).
    const pop = screen.getByTestId('artifact-pop-out');
    expect(pop.nextElementSibling?.getAttribute('data-testid')).toBe('artifact-panel-close');
    fireEvent.click(pop);

    // 닫기는 창을 연 작업이 아니라 다음 프레임이다 — 같은 작업이면 WKWebView 가 곁 스레드의 스크롤 위치를 놓친다
    // (`ArtifactPreview.tsx` ⧉ 주석).
    expect(c.closeArtifactPreview).not.toHaveBeenCalled();
    await waitFor(() => expect(c.closeArtifactPreview).toHaveBeenCalled());
    expect(screen.queryByTestId('artifact-panel')).toBeNull();
    expect(screen.getByTestId('artifact-card').getAttribute('data-selected')).toBe('false');

    const popup = wins[0]!.document;
    await waitFor(() => expect(popup.querySelector('[data-testid="artifact-frame"]')).toBeTruthy());
    expect(popup.querySelector('[data-testid="artifact-frame"]')!.getAttribute('src')).toBe('https://server.example.com/preview/p1');
    // 격리는 패널과 같다 — 창으로 옮겨도 sandbox 를 넓히지 않는다.
    expect(popup.querySelector('[data-testid="artifact-frame"]')!.getAttribute('sandbox')).toBe('allow-scripts');
    // 창 안에는 ⤢·⧉·손잡이가 없다(이미 창이다).
    expect(popup.querySelector('[data-testid="artifact-pop-out"]')).toBeNull();
    expect(popup.querySelector('[data-testid="artifact-panel-expand"]')).toBeNull();
    expect(popup.title).toBe('보드 v1 · v1');
  });

  it('창은 연 판에 머문다 — 새 판 글이 와도 그 창의 판은 그대로다', async () => {
    const c = fakeController();
    const v1 = page('p1', 1);
    useAppStore.getState().set({ messages: { c1: [withAtt('m1', [v1])] } });
    render(<AppWindowsHost />);
    act(() => { openAppWindow({ kind: 'artifact', channelId: 'c1', attachmentId: 'p1' }, { attachment: v1 }); });
    const popup = wins[0]!.document;
    await waitFor(() => expect(popup.querySelector('[data-testid="artifact-frame"]')).toBeTruthy());
    act(() => { useAppStore.getState().set({ messages: { c1: [withAtt('m1', [v1]), withAtt('m2', [page('p2', 2)])] } }); });
    expect(popup.querySelector('[data-testid="artifact-frame"]')!.getAttribute('src')).toBe('https://server.example.com/preview/p1');
    expect(c.issuePreview).toHaveBeenCalledTimes(1);
  });

  it('창에 떠 있는 판의 카드를 누르면 패널을 다시 띄우지 않고 그 창을 앞으로 가져온다', () => {
    const c = fakeController();
    const v1 = page('p1', 1);
    render(<Attachments attachments={[v1]} />);
    act(() => { openAppWindow({ kind: 'artifact', channelId: 'c1', attachmentId: 'p1' }, { attachment: v1 }); });
    fireEvent.click(screen.getByTestId('artifact-card'));
    expect(wins[0]!.focus).toHaveBeenCalled();
    expect(c.openArtifactPreview).not.toHaveBeenCalled();
  });

  it('머리줄은 한 줄 — 제목·판 오른쪽에 📌·↩ 가 서고 × 는 없다(닫기는 OS 몫, designer C안)', async () => {
    fakeController();
    const v1 = page('p1', 1);
    render(<AppWindowsHost />);
    act(() => { openAppWindow({ kind: 'artifact', channelId: 'c1', attachmentId: 'p1' }, { attachment: v1 }); });
    const popup = wins[0]!.document;
    await waitFor(() => expect(popup.querySelector('[data-testid="window-back-to-main"]')).toBeTruthy());
    const header = popup.querySelector('[data-testid="artifact-panel-header"]')!;
    expect(header.querySelector('[data-testid="artifact-panel-title"]')).toBeTruthy();
    expect(header.querySelector('[data-testid="window-pin"]')).toBeTruthy();
    expect(header.querySelector('[data-testid="window-back-to-main"]')).toBeTruthy();
    expect(popup.querySelectorAll('[data-testid="window-back-to-main"]')).toHaveLength(1);
    expect(popup.querySelector('[data-testid="artifact-panel-close"]')).toBeNull();
    // 머리줄 위에 따로 선 창 줄이 없다 — 창 뿌리의 첫 칸 맨 위가 곧 미리보기 패널이다.
    const column = popup.getElementById('hk-window-root')!.firstElementChild!;
    expect(column.firstElementChild?.getAttribute('data-testid')).toBe('artifact-panel');
  });

  it('「메인 창으로 되돌리기」는 창을 닫고 같은 판을 메인 패널에 연다', async () => {
    const c = fakeController();
    const v1 = page('p1', 1);
    render(<AppWindowsHost />);
    act(() => { openAppWindow({ kind: 'artifact', channelId: 'c1', attachmentId: 'p1' }, { attachment: v1 }); });
    const popup = wins[0]!.document;
    await waitFor(() => expect(popup.querySelector('[data-testid="window-back-to-main"]')).toBeTruthy());
    act(() => { (popup.querySelector('[data-testid="window-back-to-main"]') as HTMLElement).click(); });
    expect(wins[0]!.closed).toBe(true);
    expect(c.openArtifactPreview).toHaveBeenCalledWith(v1);
    expect(useAppWindows.getState().entries).toHaveLength(0);
  });

  it('첨부 행 없이는 열지 않고, 재시작 복원 목록에도 적지 않는다', () => {
    fakeController();
    expect(openAppWindow({ kind: 'artifact', channelId: 'c1', attachmentId: 'p1' }).kind).toBe('blocked');
    expect(wins).toHaveLength(0);
    openAppWindow({ kind: 'artifact', channelId: 'c1', attachmentId: 'p1' }, { attachment: page('p1', 1) });
    persistAppWindows();
    expect(loadSavedAppWindows()).toHaveLength(0);
    expect(appWindowKey({ kind: 'artifact', channelId: 'c1', attachmentId: 'P1' })).toBe('artifact-p1');
  });
});

/**
 * 첨부 저장은 **저장 창을 거친다**(2026-10-06, jaebin 결정 95ab9c9b).
 *
 * 전에는 칩을 누르면 `<a download>` 가 묻지 않고 기본 위치에 썼다. 이 파일이 지키는 것:
 * - 저장은 `FileSaver`(Tauri 에서는 Rust 저장 창)를 지난다. [취소]는 실패가 아니고 아무 말도 없다.
 * - 성공은 아래쪽 토스트(실제 폴더 이름), 실패는 Notice.
 * - 받는 동안·저장 창이 떠 있는 동안 다시 눌러도 두 번 받지 않는다.
 * - Tauri 표면은 바이트를 raw 본문으로, 이름은 헤더로 보내고 경로를 받지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { createTauriFileSaver, setFileSaver, SAVE_FILENAME_HEADER, type FileSaver, type SaveResult } from '../src/lib/fileSaver';
import { MessageItem } from '../src/components/MessageItem';
import { SaveToast, SAVE_TOAST_MS } from '../src/components/SaveToast';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

const att = (over: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({ id: 'a1', filename: 'rc68-SUMMARY.md', contentType: 'text/markdown', sizeBytes: 7680, ...over });

function fakeSaver(result: SaveResult | (() => Promise<SaveResult>)) {
  const saver = {
    save: vi.fn(async () => (typeof result === 'function' ? result() : result)),
    reveal: vi.fn(async () => undefined),
  } satisfies FileSaver;
  setFileSaver(saver);
  return saver;
}

function mount(fetchAttachment: () => Promise<Blob> = async () => new Blob(['# hi'])) {
  const api = fakeApi({ fetchAttachment: vi.fn(fetchAttachment) });
  const controller = new Controller(api, fakeWsFactory().makeWs);
  setController(controller);
  return { api, controller };
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
});

afterEach(() => {
  cleanup();
  setFileSaver(null);
  vi.useRealTimers();
});

describe('controller.saveAttachment', () => {
  it('저장 창을 거치고, 저장되면 실제 폴더 이름으로 토스트를 띄운다', async () => {
    const saver = fakeSaver({ kind: 'saved', name: 'rc68-SUMMARY.md', folder: 'Documents', token: 7 });
    const { controller } = mount();

    await controller.saveAttachment(att());

    expect(saver.save).toHaveBeenCalledWith(expect.any(Blob), 'rc68-SUMMARY.md');
    const toast = useAppStore.getState().saveToast;
    expect(toast).toMatchObject({ name: 'rc68-SUMMARY.md', folder: 'Documents', token: 7 });
    expect(useAppStore.getState().notice).toBeNull();
    expect(useAppStore.getState().attachmentSaving).toEqual({});
  });

  it('[취소]하면 아무 말도 없다 — 토스트도 Notice 도 없다', async () => {
    fakeSaver({ kind: 'canceled' });
    const { controller } = mount();

    await controller.saveAttachment(att());

    expect(useAppStore.getState().saveToast).toBeNull();
    expect(useAppStore.getState().notice).toBeNull();
    expect(useAppStore.getState().attachmentSaving).toEqual({});
  });

  it('쓰기에 실패하면 Notice 로 말한다', async () => {
    const saver = fakeSaver({ kind: 'canceled' });
    saver.save.mockRejectedValueOnce(new Error('disk full'));
    const { controller } = mount();

    await controller.saveAttachment(att());

    expect(useAppStore.getState().notice).toBe('파일을 저장하지 못했다');
    expect(useAppStore.getState().saveToast).toBeNull();
  });

  it('받기에 실패하면 저장 창을 띄우지 않는다', async () => {
    const saver = fakeSaver({ kind: 'canceled' });
    const { controller } = mount(async () => { throw new ApiError(404, 'attachment_missing', 'gone'); });

    await controller.saveAttachment(att());

    expect(saver.save).not.toHaveBeenCalled();
    expect(useAppStore.getState().notice).toBe('첨부 파일이 서버에 없다');
  });

  it('받는 동안 다시 눌러도 한 번만 받는다', async () => {
    fakeSaver({ kind: 'canceled' });
    let release!: (b: Blob) => void;
    const { api, controller } = mount(() => new Promise<Blob>((r) => { release = r; }));

    const first = controller.saveAttachment(att());
    expect(useAppStore.getState().attachmentSaving).toEqual({ a1: 'fetching' });
    await controller.saveAttachment(att());
    release(new Blob(['x']));
    await first;

    expect(api.fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it('브라우저(앵커)처럼 어디 썼는지 모르면 토스트를 띄우지 않는다', async () => {
    fakeSaver({ kind: 'saved', name: 'rc68-SUMMARY.md', folder: null, token: null });
    const { controller } = mount();

    await controller.saveAttachment(att());

    expect(useAppStore.getState().saveToast).toBeNull();
  });
});

describe('파일 칩', () => {
  const message = (): MessageRow => ({ ...msg('m1', 'c1', 1, '요약'), attachments: [att()] });

  it('누르면 무엇을 하는지 말하고(저장…), 받는 동안에는 받는 중… 이고 눌리지 않는다', async () => {
    fakeSaver({ kind: 'canceled' });
    let release!: (b: Blob) => void;
    mount(() => new Promise<Blob>((r) => { release = r; }));
    render(<MessageItem message={message()} />);

    const chip = screen.getByRole('button', { name: '저장: rc68-SUMMARY.md' });
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('저장…');

    fireEvent.click(chip);
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('받는 중…');
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.getAttribute('aria-busy')).toBe('true');

    await act(async () => { release(new Blob(['x'])); });
    expect((chip as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('저장…');
  });
});

describe('저장 토스트', () => {
  it('폴더와 이름을 말하고 [Finder에서 보기]는 표로 부른다, 4초 뒤 사라진다', async () => {
    vi.useFakeTimers();
    const saver = fakeSaver({ kind: 'canceled' });
    mount();
    useAppStore.getState().set({ saveToast: { id: 1, name: 'rc68-SUMMARY.md', folder: 'Downloads', token: 3 } });
    render(<SaveToast />);

    expect(screen.getByTestId('save-toast').textContent).toContain('Downloads에 rc68-SUMMARY.md 저장함');
    fireEvent.click(screen.getByRole('button', { name: 'Finder에서 보기' }));
    await act(async () => {});
    expect(saver.reveal).toHaveBeenCalledWith(3);

    act(() => { vi.advanceTimersByTime(SAVE_TOAST_MS); });
    expect(screen.queryByTestId('save-toast')).toBeNull();
  });

  it('새 토스트가 뜨면 앞 타이머가 그것을 지우지 않는다', () => {
    vi.useFakeTimers();
    mount();
    useAppStore.getState().set({ saveToast: { id: 1, name: 'a.md', folder: 'Downloads', token: 1 } });
    render(<SaveToast />);
    act(() => { vi.advanceTimersByTime(SAVE_TOAST_MS - 1000); });
    act(() => { useAppStore.getState().set({ saveToast: { id: 2, name: 'b.md', folder: 'Downloads', token: 2 } }); });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByTestId('save-toast').textContent).toContain('b.md');
  });
});

describe('Tauri 저장 표면', () => {
  // jsdom 의 Blob 에는 arrayBuffer 가 없다 — 웹뷰(WKWebView)에는 있다.
  const bytesBlob = (b: number[]) => ({ arrayBuffer: async () => new Uint8Array(b).buffer }) as unknown as Blob;

  it('바이트는 raw 본문, 이름은 인코딩한 헤더로 보낸다 — 경로를 보내지 않는다', async () => {
    const invoke = vi.fn(async () => ({ token: 5, name: '요약.md', folder: 'Downloads' }));
    const saver = createTauriFileSaver(invoke);

    const result = await saver.save(bytesBlob([1, 2, 3]), '요약.md');

    expect(invoke).toHaveBeenCalledWith('save_attachment', new Uint8Array([1, 2, 3]), {
      headers: { [SAVE_FILENAME_HEADER]: encodeURIComponent('요약.md') },
    });
    expect(result).toEqual({ kind: 'saved', name: '요약.md', folder: 'Downloads', token: 5 });
  });

  it('Rust 가 null 을 주면(취소) canceled 다', async () => {
    const saver = createTauriFileSaver(vi.fn(async () => null));
    expect(await saver.save(bytesBlob([1]), 'a.md')).toEqual({ kind: 'canceled' });
  });

  it('[Finder에서 보기]는 표 하나만 넘긴다', async () => {
    const invoke = vi.fn(async () => undefined);
    await createTauriFileSaver(invoke).reveal(9);
    expect(invoke).toHaveBeenCalledWith('reveal_saved_attachment', { token: 9 });
  });
});

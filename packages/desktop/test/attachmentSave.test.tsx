/**
 * 첨부 저장은 **저장 창을 먼저** 거친다(2026-10-23, jaebin 결정 92bf2dea — #1212 를 대체).
 *
 * 전에는 칩을 누르면 `<a download>` 가 묻지 않고 기본 위치에 썼다. 이 파일이 지키는 것:
 * - 순서: 저장 창(`pick`) → 받기 → 쓰기. [취소]면 **받지도 않고** 아무 말도 없다.
 * - 성공은 아래쪽 토스트(실제 폴더 이름), 실패는 Notice.
 * - 저장 창이 떠 있는 동안·받는 동안 다시 눌러도 창이 하나만 뜬다.
 * - 토스트는 hover·focus 동안 멈춘다(designer #1212 수정 2).
 * - Tauri 표면은 이름만 넘겨 고르고, 바이트는 raw 본문·표는 헤더로 쓴다 — 경로를 주고받지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { ApiClient, ApiError } from '../src/lib/api';
import { ImageLightbox } from '../src/components/ImageLightbox';
import { createTauriFileSaver, setFileSaver, SAVE_TOKEN_HEADER, type FileSaver, type SaveTarget } from '../src/lib/fileSaver';
import { formatProgressBytes } from '../src/lib/attachmentSaveProgress';
import { MessageItem } from '../src/components/MessageItem';
import { SaveToast, SAVE_TOAST_MS } from '../src/components/SaveToast';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

const att = (over: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({ id: 'a1', filename: 'rc68-SUMMARY.md', contentType: 'text/markdown', sizeBytes: 7680, ...over });

const picked: SaveTarget = { token: 7, name: 'rc68-SUMMARY.md', folder: 'Documents' };

function fakeSaver(target: SaveTarget | null | (() => Promise<SaveTarget | null>)) {
  const saver = {
    pick: vi.fn(async () => (typeof target === 'function' ? target() : target)),
    write: vi.fn(async () => undefined),
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

const noticeTexts = () => useAppStore.getState().notices.map((n) => n.text);

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
  it('저장 창을 먼저 띄우고, 고른 뒤에 받아 쓰고, 실제 폴더 이름으로 토스트를 띄운다', async () => {
    const saver = fakeSaver(picked);
    const { api, controller } = mount();
    const order: string[] = [];
    saver.pick.mockImplementationOnce(async () => { order.push('pick'); return picked; });
    (api.fetchAttachment as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { order.push('fetch'); return new Blob(['x']); });
    saver.write.mockImplementationOnce(async () => { order.push('write'); });

    await controller.saveAttachment(att());

    expect(order).toEqual(['pick', 'fetch', 'write']);
    expect(saver.pick).toHaveBeenCalledWith('rc68-SUMMARY.md');
    expect(saver.write).toHaveBeenCalledWith(picked, expect.anything());
    expect(useAppStore.getState().saveToast).toMatchObject({ name: 'rc68-SUMMARY.md', folder: 'Documents', token: 7 });
    expect(noticeTexts()).toEqual([]);
    expect(useAppStore.getState().attachmentSaving).toEqual({});
  });

  it('[취소]하면 받지도 않고 아무 말도 없다', async () => {
    const saver = fakeSaver(null);
    const { api, controller } = mount();

    await controller.saveAttachment(att());

    expect(api.fetchAttachment).not.toHaveBeenCalled();
    expect(saver.write).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveToast).toBeNull();
    expect(noticeTexts()).toEqual([]);
    expect(useAppStore.getState().attachmentSaving).toEqual({});
  });

  it('쓰기에 실패하면 Notice 로 말하고 토스트는 없다', async () => {
    const saver = fakeSaver(picked);
    saver.write.mockRejectedValueOnce(new Error('disk full'));
    const { controller } = mount();

    await controller.saveAttachment(att());

    expect(noticeTexts()).toEqual(['파일을 저장하지 못했다']);
    expect(useAppStore.getState().saveToast).toBeNull();
  });

  it('받기에 실패하면 쓰지 않고 Notice 로 말한다', async () => {
    const saver = fakeSaver(picked);
    const { controller } = mount(async () => { throw new ApiError(404, 'attachment_missing', 'gone'); });

    await controller.saveAttachment(att());

    expect(saver.write).not.toHaveBeenCalled();
    expect(noticeTexts()).toEqual(['첨부 파일이 서버에 없다']);
  });

  it('저장 창이 떠 있는 동안 다시 눌러도 창은 하나만 뜬다', async () => {
    let choose!: (t: SaveTarget | null) => void;
    const saver = fakeSaver(() => new Promise((r) => { choose = r; }));
    const { controller } = mount();

    const first = controller.saveAttachment(att());
    expect(useAppStore.getState().attachmentSaving).toEqual({ a1: { phase: 'choosing' } });
    await controller.saveAttachment(att());
    choose(null);
    await first;

    expect(saver.pick).toHaveBeenCalledTimes(1);
  });

  it('받는 동안 다시 눌러도 한 번만 받는다', async () => {
    fakeSaver(picked);
    let release!: (b: Blob) => void;
    const { api, controller } = mount(() => new Promise<Blob>((r) => { release = r; }));

    const first = controller.saveAttachment(att());
    await vi.waitFor(() => expect(useAppStore.getState().attachmentSaving.a1?.phase).toBe('fetching'));
    await controller.saveAttachment(att());
    release(new Blob(['x']));
    await first;

    expect(api.fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it('브라우저(앵커)처럼 어디 썼는지 모르면 토스트를 띄우지 않는다', async () => {
    fakeSaver({ token: null, name: 'rc68-SUMMARY.md', folder: null });
    const { controller } = mount();

    await controller.saveAttachment(att());

    expect(useAppStore.getState().saveToast).toBeNull();
  });
});

describe('파일 칩', () => {
  const message = (): MessageRow => ({ ...msg('m1', 'c1', 1, '요약'), attachments: [att()] });

  it('누르면 무엇을 하는지 말하고(저장…), 받는 동안에는 진행을 말하고 눌리지 않는다', async () => {
    fakeSaver(picked);
    let release!: (b: Blob) => void;
    mount(() => new Promise<Blob>((r) => { release = r; }));
    render(<MessageItem message={message()} />);

    const chip = screen.getByRole('button', { name: '저장: rc68-SUMMARY.md' });
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('저장…');

    await act(async () => { fireEvent.click(chip); });
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('0% · 0/7.5 KB');
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(chip.getAttribute('aria-busy')).toBe('true');

    await act(async () => { release(new Blob(['x'])); });
    expect((chip as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('저장…');
  });
});

describe('저장 토스트', () => {
  const show = (id: number, name = 'rc68-SUMMARY.md') =>
    useAppStore.getState().set({ saveToast: { id, name, folder: 'Downloads', token: id } });

  it('폴더와 이름을 말하고 [Finder에서 보기]는 표로 부른다, 4초 뒤 사라진다', async () => {
    vi.useFakeTimers();
    const saver = fakeSaver(null);
    mount();
    show(3);
    render(<SaveToast />);

    expect(screen.getByTestId('save-toast').textContent).toContain('Downloads에 rc68-SUMMARY.md 저장함');
    fireEvent.click(screen.getByRole('button', { name: 'Finder에서 보기' }));
    await act(async () => {});
    expect(saver.reveal).toHaveBeenCalledWith(3);

    act(() => { vi.advanceTimersByTime(SAVE_TOAST_MS); });
    expect(screen.queryByTestId('save-toast')).toBeNull();
  });

  it('마우스를 올린 동안·포커스가 안에 있는 동안 사라지지 않고, 떠나면 다시 센다', () => {
    vi.useFakeTimers();
    mount();
    show(1);
    render(<SaveToast />);
    const toast = screen.getByTestId('save-toast');

    fireEvent.mouseEnter(toast);
    act(() => { vi.advanceTimersByTime(SAVE_TOAST_MS * 3); });
    expect(screen.getByTestId('save-toast')).toBeTruthy();

    fireEvent.mouseLeave(toast);
    fireEvent.focus(screen.getByRole('button', { name: 'Finder에서 보기' }));
    act(() => { vi.advanceTimersByTime(SAVE_TOAST_MS * 3); });
    expect(screen.getByTestId('save-toast')).toBeTruthy();

    fireEvent.blur(screen.getByRole('button', { name: 'Finder에서 보기' }));
    act(() => { vi.advanceTimersByTime(SAVE_TOAST_MS - 100); });
    expect(screen.getByTestId('save-toast')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId('save-toast')).toBeNull();
  });

  it('새 토스트가 뜨면 앞 타이머가 그것을 지우지 않는다', () => {
    vi.useFakeTimers();
    mount();
    show(1, 'a.md');
    render(<SaveToast />);
    act(() => { vi.advanceTimersByTime(SAVE_TOAST_MS - 1000); });
    act(() => { show(2, 'b.md'); });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByTestId('save-toast').textContent).toContain('b.md');
  });
});

describe('Tauri 저장 표면', () => {
  // jsdom 의 Blob 에는 arrayBuffer 가 없다 — 웹뷰(WKWebView)에는 있다.
  const bytesBlob = (b: number[]) => ({ arrayBuffer: async () => new Uint8Array(b).buffer }) as unknown as Blob;

  it('고르기는 이름 하나만 넘긴다 — 경로를 받지 않는다', async () => {
    const invoke = vi.fn(async () => ({ token: 5, name: '요약.md', folder: 'Downloads' }));
    const target = await createTauriFileSaver(invoke).pick('요약.md');

    expect(invoke).toHaveBeenCalledWith('pick_save_target', { filename: '요약.md' });
    expect(target).toEqual({ token: 5, name: '요약.md', folder: 'Downloads' });
  });

  it('Rust 가 null 을 주면(취소) null 이다', async () => {
    expect(await createTauriFileSaver(vi.fn(async () => null)).pick('a.md')).toBeNull();
  });

  it('쓰기는 바이트를 raw 본문, 표를 헤더로 보낸다', async () => {
    const invoke = vi.fn(async () => undefined);
    await createTauriFileSaver(invoke).write({ token: 5, name: 'a.md', folder: 'Downloads' }, bytesBlob([1, 2, 3]));

    expect(invoke).toHaveBeenCalledWith('write_saved_attachment', new Uint8Array([1, 2, 3]), {
      headers: { [SAVE_TOKEN_HEADER]: '5' },
    });
  });

  it('[Finder에서 보기]는 표 하나만 넘긴다', async () => {
    const invoke = vi.fn(async () => undefined);
    await createTauriFileSaver(invoke).reveal(9);
    expect(invoke).toHaveBeenCalledWith('reveal_saved_attachment', { token: 9 });
  });
});

describe('받는 동안 진행률·취소 (P2)', () => {
  type Opts = { onProgress?: (loaded: number, total: number | null) => void; signal?: AbortSignal };
  const message = (): MessageRow => ({ ...msg('m1', 'c1', 1, '요약'), attachments: [att({ sizeBytes: 7_864_320 })] });

  /** 받기를 손으로 몬다: progress(loaded,total) 로 진행을 흘리고, finish/fail 로 끝낸다. 신호가 끊기면 AbortError. */
  function steeredFetch() {
    const ctl: { opts?: Opts; finish?: () => void; fail?: (e: Error) => void } = {};
    const fetchAttachment = vi.fn((_id: string, opts: Opts = {}) => new Promise<Blob>((resolve, reject) => {
      ctl.opts = opts;
      ctl.finish = () => resolve(new Blob(['x']));
      ctl.fail = reject;
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const progress = (loaded: number, total: number | null) => ctl.opts?.onProgress?.(loaded, total);
    return { ctl, fetchAttachment, progress };
  }

  it('칩 아래 막대와 「42% · 3.1/7.5 MB」를 보이고, 라이트박스 버튼도 같은 %를 말한다', async () => {
    fakeSaver(picked);
    const f = steeredFetch();
    mount(f.fetchAttachment as unknown as () => Promise<Blob>);
    render(<MessageItem message={message()} />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '저장: rc68-SUMMARY.md' })); });
    await act(async () => { f.progress(3_355_443, 7_864_320); });

    expect(screen.getByTestId('attachment-file-action').textContent).toBe('42% · 3.2/7.5 MB');
    expect((screen.getByTestId('attachment-file-progress') as HTMLElement).style.width).toBe('42%');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');

    render(<ImageLightbox attachment={att({ sizeBytes: 7_864_320 })} url="blob:x" onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: '42%' })).toBeTruthy();

    await act(async () => { f.ctl.finish!(); });
    expect(screen.queryByTestId('attachment-file-progress')).toBeNull();
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('저장…');
  });

  it('전체 크기를 모르면 막대 없이 「받는 중…」만 말한다', async () => {
    fakeSaver(picked);
    const f = steeredFetch();
    mount(f.fetchAttachment as unknown as () => Promise<Blob>);
    render(<MessageItem message={{ ...message(), attachments: [att({ sizeBytes: 0 })] }} />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '저장: rc68-SUMMARY.md' })); });
    await act(async () => { f.progress(1_000_000, null); });

    expect(screen.getByTestId('attachment-file-action').textContent).toBe('받는 중…');
    expect(screen.queryByTestId('attachment-file-progress')).toBeNull();
    await act(async () => { f.ctl.finish!(); });
  });

  it('[✕]를 누르면 받기를 멈추고, 쓰지 않고, 아무 말 없이 원래 칩으로 돌아간다', async () => {
    const saver = fakeSaver(picked);
    const f = steeredFetch();
    mount(f.fetchAttachment as unknown as () => Promise<Blob>);
    render(<MessageItem message={message()} />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '저장: rc68-SUMMARY.md' })); });
    await act(async () => { f.progress(1_000, 7_864_320); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '받기 취소: rc68-SUMMARY.md' })); });

    expect(f.ctl.opts?.signal?.aborted).toBe(true);
    expect(saver.write).not.toHaveBeenCalled();
    expect(noticeTexts()).toEqual([]);
    expect(useAppStore.getState().saveToast).toBeNull();
    expect(useAppStore.getState().attachmentSaving).toEqual({});
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('저장…');
    expect(screen.queryByRole('button', { name: '받기 취소: rc68-SUMMARY.md' })).toBeNull();
  });

  it('다 받고 쓰는 동안에는 [✕]를 감추고 다시 누를 수 없다 — 그때는 멈출 수 없다', async () => {
    const saver = fakeSaver(picked);
    let finishWrite!: () => void;
    saver.write.mockImplementationOnce(() => new Promise<undefined>((r) => { finishWrite = () => r(undefined); }));
    const f = steeredFetch();
    mount(f.fetchAttachment as unknown as () => Promise<Blob>);
    render(<MessageItem message={message()} />);
    const chip = screen.getByRole('button', { name: '저장: rc68-SUMMARY.md' });

    await act(async () => { fireEvent.click(chip); });
    await act(async () => { f.progress(7_864_320, 7_864_320); });
    expect(screen.getByRole('button', { name: '받기 취소: rc68-SUMMARY.md' })).toBeTruthy();
    await act(async () => { f.ctl.finish!(); });

    expect(useAppStore.getState().attachmentSaving.a1?.phase).toBe('writing');
    expect(screen.queryByRole('button', { name: '받기 취소: rc68-SUMMARY.md' })).toBeNull();
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('attachment-file-action').textContent).toBe('100% · 7.5/7.5 MB');

    await act(async () => { finishWrite(); });
    expect(useAppStore.getState().attachmentSaving).toEqual({});
    expect(useAppStore.getState().saveToast).toMatchObject({ name: 'rc68-SUMMARY.md' });
  });

  it('받기에 실패하면 칩이 「받기 실패 · 다시」를 말하고 다시 누르면 저장 창부터 다시 간다', async () => {
    const saver = fakeSaver(picked);
    const f = steeredFetch();
    mount(f.fetchAttachment as unknown as () => Promise<Blob>);
    render(<MessageItem message={message()} />);
    const chip = screen.getByRole('button', { name: '저장: rc68-SUMMARY.md' });

    await act(async () => { fireEvent.click(chip); });
    await act(async () => { f.ctl.fail!(new ApiError(500, 'attachment_failed', 'HTTP 500')); });

    expect(screen.getByTestId('attachment-file-action').textContent).toBe('받기 실패 · 다시');
    expect(noticeTexts()).toEqual(['첨부를 불러오지 못했다']);
    expect(saver.write).not.toHaveBeenCalled();
    expect((chip as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { fireEvent.click(chip); });
    expect(saver.pick).toHaveBeenCalledTimes(2);
    await act(async () => { f.ctl.finish!(); });
    expect(saver.write).toHaveBeenCalledTimes(1);
  });

  it('진행은 %가 바뀔 때만 가게에 적는다 — 조각마다 다시 그리지 않는다', async () => {
    fakeSaver(picked);
    const f = steeredFetch();
    const { controller } = mount(f.fetchAttachment as unknown as () => Promise<Blob>);
    const writes: unknown[] = [];
    const unsub = useAppStore.subscribe((s, prev) => { if (s.attachmentSaving !== prev.attachmentSaving) writes.push(s.attachmentSaving.a1); });

    const done = controller.saveAttachment(att({ sizeBytes: 1_000_000 }));
    await vi.waitFor(() => expect(f.ctl.opts).toBeDefined());
    writes.length = 0;
    for (let loaded = 1_000; loaded <= 9_000; loaded += 1_000) f.progress(loaded, 1_000_000);
    f.ctl.finish!();
    await done;
    unsub();

    // 1천~9천 바이트(0%)는 한 번도 새로 적지 않는다(앞서 적은 0% 그대로) — 쓰는 중 한 번과 끝에 지우는 한 번만 남는다.
    expect(writes.map((w) => (w as { phase?: string } | undefined)?.phase)).toEqual(['writing', undefined]);
  });
});

describe('ApiClient.fetchAttachment 진행률', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('content-length 로 전체를 알고 조각마다 진행을 알린다, 토큰은 헤더에만 싣는다', async () => {
    const chunks = [new Uint8Array(3), new Uint8Array(5)];
    let i = 0;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '8', 'content-type': 'text/markdown' }),
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
      blob: async () => { throw new Error('스트림으로 읽어야 한다'); },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: [number, number | null][] = [];
    const signal = new AbortController().signal;

    const blob = await new ApiClient('http://x', 'tok').fetchAttachment('a1', { onProgress: (l, t) => seen.push([l, t]), signal });

    expect(seen).toEqual([[0, 8], [3, 8], [8, 8]]);
    expect(formatProgressBytes(0, 7_864_320)).toBe('0/7.5 MB');
    expect(formatProgressBytes(3_355_443, 7_864_320)).toBe('3.2/7.5 MB');
    expect(formatProgressBytes(500, 900)).toBe('500/900 B');
    expect(blob.size).toBe(8);
    expect(fetchMock).toHaveBeenCalledWith('http://x/attachments/a1', { headers: { authorization: 'Bearer tok' }, signal });
  });

  it('content-length 가 없으면 전체는 null 이다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(),
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    })));
    const seen: (number | null)[] = [];
    await new ApiClient('http://x', 'tok').fetchAttachment('a1', { onProgress: (_l, t) => seen.push(t) });
    expect(seen).toEqual([null]);
  });

  it('404 는 attachment_missing, 그 밖의 실패는 attachment_failed 다', async () => {
    const api = new ApiClient('http://x', 'tok');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Headers() })));
    await expect(api.fetchAttachment('a1')).rejects.toMatchObject({ status: 404, code: 'attachment_missing' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, headers: new Headers() })));
    await expect(api.fetchAttachment('a1')).rejects.toMatchObject({ status: 500, code: 'attachment_failed' });
  });

  it('진행률을 원하지 않으면 예전처럼 blob() 이다', async () => {
    const b = new Blob(['x']);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null, blob: async () => b })));
    expect(await new ApiClient('http://x', null).fetchAttachment('a1')).toBe(b);
  });
});

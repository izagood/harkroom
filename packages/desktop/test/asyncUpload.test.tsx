import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { AttachmentRow } from '@harkroom/shared';
import { useActiveStore as useAppStore, useCommunityRegistry, resetCommunityRegistry } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { MAX_PARALLEL_UPLOADS, uploadPercent } from '../src/lib/attachmentUploads';
import type { PendingUpload } from '../src/state/appStore';
import { acc } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 첨부 업로드가 **작성창을 막지 않는다.** 예전에는 업로드가 끝나야 칩이 섰고, 그 사이에 보낸
 * 글은 그림 없이 나갔다 — 사람은 칩이 뜰 때까지 손을 놓고 기다렸다.
 */

const att = (over: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({ id: 'a1', filename: 'shot.txt', contentType: 'text/plain', sizeBytes: 10, ...over });

/** 아직 안 끝난 업로드. 테스트가 끝나면 거둔다 — 남기면 다음 테스트의 동시 업로드 자리를 잡는다. */
const open: ((e: unknown) => void)[] = [];

/** 끝을 테스트가 정하는 업로드. */
const deferredUploads = () => {
  const calls: { file: File; progress?: (f: number) => void; resolve: (r: AttachmentRow) => void; reject: (e: unknown) => void }[] = [];
  const upload = vi.fn((file: File, progress?: (f: number) => void) => new Promise<AttachmentRow>((resolve, reject) => {
    calls.push({ file, progress, resolve, reject });
    open.push(reject);
  }));
  return { calls, upload };
};

const fakeController = (over: Partial<Controller> = {}) => {
  const c = {
    upload: vi.fn(async () => att()),
    fetchAttachment: vi.fn(async () => new Blob(['bytes'])),
    send: vi.fn(async () => undefined),
    notifyTyping: vi.fn(),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
};

const pick = (name: string) => {
  const input = screen.getByLabelText('파일 첨부') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'text/plain' })] } });
};
const typeAndSend = (text: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

beforeEach(() => {
  resetCommunityRegistry();
  undoSendStorage.saveWindowMs(0);
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') }, activeChannelId: 'c1' });
});
afterEach(async () => {
  await act(async () => { for (const reject of open.splice(0)) reject(new Error('teardown')); });
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('uploading without blocking the composer', () => {
  it('shows the chip the moment the file is picked, with progress', async () => {
    const d = deferredUploads();
    fakeController({ upload: d.upload });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    pick('big.txt');

    const chip = await screen.findByTestId('pending-attachment');
    expect(chip.dataset.status).toBe('uploading');
    expect(chip.textContent).toContain('big.txt');
    act(() => d.calls[0]!.progress!(0.42));
    expect(screen.getByTestId('pending-attachment').textContent).toContain('42%');
  });

  it('sends while the upload is still running — the message waits for it, the composer does not', async () => {
    const d = deferredUploads();
    const onSend = vi.fn();
    fakeController({ upload: d.upload });
    render(<Composer onSend={onSend} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));

    typeAndSend('그림 봐라');

    // 작성창은 곧바로 비고 다음 글을 받는다. 글은 아직 안 나갔다.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId('pending-attachment')).toBeNull();
    // 길이를 아직 모른다 — 가짜 비율 대신 `…`.
    expect(screen.getByTestId('waiting-uploads').textContent).toContain('첨부 올리는 중…');
    // 바이트로 잰 % 가 대기 줄에 선다(칩은 작성창에서 빠졌으므로 볼 곳은 여기뿐이다).
    act(() => d.calls[0]!.progress!(0.42));
    expect(screen.getByTestId('waiting-uploads').textContent).toContain('첨부 올리는 중 42%');
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => { d.calls[0]!.resolve(att({ id: 'up-9' })); });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('그림 봐라', ['up-9']));
    expect(screen.queryByTestId('waiting-uploads')).toBeNull();
  });

  it('keeps the order: a later plain message waits behind one still waiting for its attachment', async () => {
    const d = deferredUploads();
    const onSend = vi.fn();
    fakeController({ upload: d.upload });
    render(<Composer onSend={onSend} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));
    typeAndSend('첫째');
    typeAndSend('둘째');
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => { d.calls[0]!.resolve(att({ id: 'up-1' })); });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls.map((c) => c[0])).toEqual(['첫째', '둘째']);
  });

  it('does not send when a waited-for attachment fails — the draft and the chip come back', async () => {
    const d = deferredUploads();
    const onSend = vi.fn();
    fakeController({ upload: d.upload });
    render(<Composer onSend={onSend} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));
    typeAndSend('그림 봐라');

    await act(async () => { d.calls[0]!.reject(new Error('413')); });

    await waitFor(() => expect(screen.getByTestId('send-error')).toBeTruthy());
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('그림 봐라');
    expect(screen.getByTestId('pending-attachment').dataset.status).toBe('failed');
  });

  it('retries a failed upload from the chip', async () => {
    const d = deferredUploads();
    fakeController({ upload: d.upload });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));
    await act(async () => { d.calls[0]!.reject(new Error('net')); });
    expect(await screen.findByRole('alert')).toBeTruthy();

    // 실패한 첨부를 든 채로는 보내지 않는다.
    typeAndSend('본문');
    expect(screen.getByTestId('send-error')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /retry big\.txt/i }));
    await waitFor(() => expect(d.calls).toHaveLength(2));
    await act(async () => { d.calls[1]!.resolve(att({ id: 'up-2', filename: 'big.txt' })); });
    await waitFor(() => expect(screen.getByTestId('pending-attachment').dataset.status).toBe('done'));
  });

  it('cancels a message that is waiting — the text and the attachment return', async () => {
    const d = deferredUploads();
    const onSend = vi.fn();
    fakeController({ upload: d.upload });
    render(<Composer onSend={onSend} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));
    typeAndSend('잠깐');

    fireEvent.click(screen.getByRole('button', { name: '보내기 취소' }));
    await act(async () => { d.calls[0]!.resolve(att({ id: 'up-3' })); });

    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('잠깐');
    expect(screen.getByTestId('pending-attachment')).toBeTruthy();
  });

  it('keeps an upload in the channel it started in when I switch channels', async () => {
    const d = deferredUploads();
    fakeController({ upload: d.upload });
    const { rerender } = render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));

    rerender(<Composer onSend={vi.fn()} scopeKey="c2" />);
    await act(async () => { d.calls[0]!.resolve(att({ id: 'up-4' })); });
    expect(screen.queryByTestId('pending-attachment')).toBeNull();

    rerender(<Composer onSend={vi.fn()} scopeKey="c1" />);
    expect(screen.getByTestId('pending-attachment').dataset.status).toBe('done');
  });

  it(`uploads several files at once, at most ${MAX_PARALLEL_UPLOADS} at a time`, async () => {
    const d = deferredUploads();
    fakeController({ upload: d.upload });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    const input = screen.getByLabelText('파일 첨부') as HTMLInputElement;
    const files = Array.from({ length: MAX_PARALLEL_UPLOADS + 1 }, (_, i) => new File(['x'], `f${i}.txt`));
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(d.calls).toHaveLength(MAX_PARALLEL_UPLOADS));
    expect(screen.getAllByTestId('pending-attachment')).toHaveLength(MAX_PARALLEL_UPLOADS + 1);
    // 떼면 끊기고 자리가 빈다 — 버린 업로드가 줄을 끝까지 막지 않는다.
    fireEvent.click(screen.getByRole('button', { name: /remove f1\.txt/i }));
    await act(async () => { d.calls[0]!.resolve(att({ id: 'x0' })); });
    await waitFor(() => expect(d.calls).toHaveLength(MAX_PARALLEL_UPLOADS + 1));
  });

  it('aborts the request when I remove a chip that is still uploading', async () => {
    let signal: AbortSignal | undefined;
    fakeController({ upload: vi.fn((_f: File, _p?: (f: number) => void, s?: AbortSignal) => {
      signal = s;
      return new Promise<AttachmentRow>((_r, reject) => { open.push(reject); });
    }) });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(signal).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /remove big\.txt/i }));

    expect(signal!.aborted).toBe(true);
    expect(screen.queryByTestId('pending-attachment')).toBeNull();
  });

  it('weighs the waiting percentage by bytes, not by count', () => {
    const u = (id: string, size: number, status: PendingUpload['status'], fraction: number | null): PendingUpload =>
      ({ localId: id, scope: null, file: new File(['x'.repeat(size)], `${id}.bin`), status, fraction, row: null });
    const uploads = { a: u('a', 100, 'done', 1), b: u('b', 900, 'uploading', 0.5) };
    // (100 + 450) / 1000
    expect(uploadPercent(uploads, ['a', 'b'])).toBe(55);
    expect(uploadPercent({ ...uploads, b: u('b', 900, 'uploading', null) }, ['a', 'b'])).toBeNull();
    // 다 가도 서버가 저장하는 동안은 100 을 말하지 않는다.
    expect(uploadPercent({ a: u('a', 10, 'uploading', 1) }, ['a'])).toBe(99);
  });

  it('shows one red line, not two, when a waited-for upload fails — the file name moves into it', async () => {
    const d = deferredUploads();
    fakeController({ upload: d.upload });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));
    typeAndSend('그림');
    await act(async () => { d.calls[0]!.reject(new Error('413')); });

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByTestId('send-error').textContent).toContain('big.txt');
  });

  it('counts the failures when more than one upload failed', async () => {
    const d = deferredUploads();
    fakeController({ upload: d.upload });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    const input = screen.getByLabelText('파일 첨부') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt'), new File(['x'], 'b.txt')] } });
    await waitFor(() => expect(d.calls).toHaveLength(2));
    await act(async () => { d.calls[0]!.reject(new Error('x')); d.calls[1]!.reject(new Error('x')); });

    expect((await screen.findByRole('alert')).textContent).toContain('첨부 2개를 올리지 못했다');
  });

  it('keeps drawing the picked image after the upload finishes until the server bytes arrive (no 📎 flash)', async () => {
    const d = deferredUploads();
    const created: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.createObjectURL = vi.fn(() => { const u = `blob:local-${created.length}`; created.push(u); return u; });
    URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
    try {
      // 서버 바이트는 끝까지 안 온다 — 그 사이에 무엇이 그려지는지 본다.
      fakeController({ upload: d.upload, fetchAttachment: vi.fn(() => new Promise<Blob>(() => {})) });
      render(<Composer onSend={vi.fn()} scopeKey="c1" />);
      const input = screen.getByLabelText('파일 첨부') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
      await waitFor(() => expect(d.calls).toHaveLength(1));
      const uploading = screen.getByTestId('attachment-local-thumb');
      expect(uploading.className).toContain('opacity-60');

      await act(async () => { d.calls[0]!.resolve(att({ id: 'img-1', filename: 'shot.png', contentType: 'image/png' })); });

      const placeholder = screen.getByTestId('attachment-local-thumb');
      expect(placeholder.className).not.toContain('opacity-60');
      expect(placeholder.getAttribute('src')).toBe(created[0]);
      // 떼면 미리보기 URL 을 놓는다.
      fireEvent.click(screen.getByRole('button', { name: /remove shot\.png/i }));
      expect(revoked).toContain(created[0]);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('drops a waiting message and aborts its upload on logout — nothing is sent, no draft comes back', async () => {
    let signal: AbortSignal | undefined;
    const onSend = vi.fn();
    fakeController({ upload: vi.fn((_f: File, _p?: (f: number) => void, s?: AbortSignal) => {
      signal = s;
      return new Promise<AttachmentRow>((_r, reject) => { open.push(reject); s?.addEventListener('abort', () => reject(new Error('aborted'))); });
    }) });
    render(<Composer onSend={onSend} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(signal).toBeDefined());
    typeAndSend('비밀');

    await act(async () => { useAppStore.getState().reset(); });

    expect(signal!.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('waiting-uploads')).toBeNull());
    expect(onSend).not.toHaveBeenCalled();
    expect(useAppStore.getState().drafts.c1).toBeUndefined();
  });

  it('puts a waiting message back into the draft when the window closes, and warns', async () => {
    const d = deferredUploads();
    const onSend = vi.fn();
    fakeController({ upload: d.upload });
    render(<Composer onSend={onSend} scopeKey="c1" />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));
    typeAndSend('닫기 전에');

    const ev = new Event('beforeunload', { cancelable: true });
    act(() => { window.dispatchEvent(ev); });

    expect(ev.defaultPrevented).toBe(true);
    expect(useAppStore.getState().drafts.c1).toBe('닫기 전에');
    await act(async () => { d.calls[0]!.resolve(att({ id: 'late' })); });
    expect(onSend).not.toHaveBeenCalled();
  });
});

/**
 * 기다리던 글은 **쓴 커뮤니티로** 나간다(PR #997 security 검토). 대기 중에 커뮤니티를 옮겼을 때
 * 활성 컨트롤러로 보내면 A 의 본문·첨부 id 가 B 서버에 POST 된다.
 */
describe('a waiting message stays with its community', () => {
  it('sends through the community it was written in, not the one now active', async () => {
    const { ChannelPane } = await import('../src/components/ChannelPane');
    const { scheduledApiStub, chan } = await import('./helpers/fakeApi');
    const d = deferredUploads();
    const a = fakeController({
      upload: d.upload, openChannel: vi.fn(), api: scheduledApiStub(),
    } as unknown as Partial<Controller>);
    useAppStore.getState().set({ channels: [chan('c1', 'general')] });
    render(<ChannelPane />);
    pick('big.txt');
    await waitFor(() => expect(d.calls).toHaveLength(1));
    typeAndSend('A 에만');

    // B 커뮤니티로 옮긴다.
    const reg = useCommunityRegistry.getState();
    const b = reg.register({ baseUrl: 'https://b.example.com' });
    const bController = { send: vi.fn(async () => undefined), api: scheduledApiStub(), openChannel: vi.fn() };
    reg.attachController(b.id, bController as unknown as Controller);
    act(() => { useCommunityRegistry.getState().setActive(b.id); });

    await act(async () => { d.calls[0]!.resolve(att({ id: 'up-a' })); });

    await waitFor(() => expect(a.send).toHaveBeenCalledWith('A 에만', ['up-a'], 'c1'));
    expect(bController.send).not.toHaveBeenCalled();
  });
});

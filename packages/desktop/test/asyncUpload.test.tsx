import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { AttachmentRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { MAX_PARALLEL_UPLOADS } from '../src/lib/attachmentUploads';
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
  const input = screen.getByLabelText('Attach a file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'text/plain' })] } });
};
const typeAndSend = (text: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

beforeEach(() => {
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
    expect(screen.getByTestId('waiting-uploads').textContent).toContain('0/1');
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

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sending' }));
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
    const input = screen.getByLabelText('Attach a file') as HTMLInputElement;
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
});

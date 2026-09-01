import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { Composer } from '../src/components/Composer';
import { acc, msg } from './helpers/fakeApi';

const withAttachments = (attachments: AttachmentRow[]): MessageRow =>
  ({ ...msg('m1', 'c1', 1, '파일 보냅니다', 'u2'), attachments });

const att = (over: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({ id: 'a1', filename: 'note.txt', contentType: 'text/plain', sizeBytes: 1234, ...over });

const fakeController = (over: Partial<Controller> = {}) => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    upload: vi.fn(async () => att()),
    fetchAttachment: vi.fn(async () => new Blob(['bytes'])),
    saveAttachment: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    activeChannelId: 'c1',
  });
});
afterEach(() => cleanup());

describe('showing attachments on a message', () => {
  it('names the file and its size', () => {
    fakeController();
    render(<MessageItem message={withAttachments([att()])} />);

    const item = screen.getByRole('button', { name: /note\.txt/ });
    expect(item.textContent).toMatch(/1\.2 KB/);
  });

  it('shows nothing when there are no attachments', () => {
    fakeController();
    render(<MessageItem message={withAttachments([])} />);

    expect(screen.queryAllByRole('button', { name: /\.txt/ })).toHaveLength(0);
  });

  it('keeps the order the server sent', () => {
    fakeController();
    render(<MessageItem message={withAttachments([
      att({ id: 'a1', filename: 'first.txt' }),
      att({ id: 'a2', filename: 'second.txt' }),
    ])} />);

    const names = screen.getAllByRole('button', { name: /\.txt/ }).map((l) => l.textContent);
    expect(names[0]).toContain('first.txt');
  });

  // 이미지는 미리 보여야 첨부가 쓸모 있다. 단 SVG 는 스크립트를 담을 수 있어 그리지 않는다.
  it('previews an image', async () => {
    fakeController();
    render(<MessageItem message={withAttachments([att({ contentType: 'image/png', filename: 'shot.png' })])} />);

    // 바이트를 받아 objectURL 을 만든 뒤에 그린다 — 토큰을 URL 에 넣지 않기 때문이다.
    expect(await screen.findByRole('img', { name: /shot\.png/ })).toBeTruthy();
  });

  // SVG 는 `<script>` 를 담을 수 있어 이미지처럼 보이지만 이미지가 아니다. 그리지 않는 것을
  // 확인할 때 `queryByRole('img')` 만 보면 거짓 통과한다 — blob 이 도착하기 전에는 어차피
  // img 가 없기 때문이다. **바이트를 아예 받지 않는다**를 확인해야 실제 가드를 검증한다.
  it('does not even fetch an svg for preview', async () => {
    const c = fakeController();
    render(<MessageItem message={withAttachments([att({ contentType: 'image/svg+xml', filename: 'x.svg' })])} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /x\.svg/ })).toBeTruthy());
    expect(c.fetchAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  // 이름은 올린 사람이 정한다 — `evil.png` 가 실제로 HTML 이면 그리면 안 된다.
  it('does not preview a file that merely claims to be an image by name', async () => {
    const c = fakeController();
    render(<MessageItem message={withAttachments([att({ contentType: 'text/html', filename: 'evil.png' })])} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /evil\.png/ })).toBeTruthy());
    expect(c.fetchAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('does fetch a real image so it can be shown', async () => {
    const c = fakeController();
    render(<MessageItem message={withAttachments([att({ contentType: 'image/png', filename: 'ok.png' })])} />);

    await waitFor(() => expect(c.fetchAttachment).toHaveBeenCalledWith('a1'));
  });
});

describe('attaching a file in the composer', () => {
  const pick = (name: string, type = 'text/plain') => {
    const input = screen.getByLabelText('Attach a file') as HTMLInputElement;
    const file = new File(['content'], name, { type });
    fireEvent.change(input, { target: { files: [file] } });
    return file;
  };

  it('uploads the file the moment it is picked', async () => {
    const c = fakeController();
    render(<Composer onSend={vi.fn()} />);

    pick('picked.txt');

    await waitFor(() => expect(c.upload).toHaveBeenCalled());
  });

  it('shows the pending attachment before the message is sent', async () => {
    fakeController({ upload: vi.fn(async () => att({ filename: 'pending.txt' })) });
    render(<Composer onSend={vi.fn()} />);

    pick('pending.txt');

    expect(await screen.findByText(/pending\.txt/)).toBeTruthy();
  });

  it('sends the attachment ids with the message', async () => {
    const onSend = vi.fn();
    fakeController({ upload: vi.fn(async () => att({ id: 'up-1' })) });
    render(<Composer onSend={onSend} />);
    pick('a.txt');
    await screen.findByText(/note\.txt|a\.txt/);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '본문', selectionStart: 2 } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('본문', ['up-1']));
  });

  // 파일만 보내는 것은 자연스럽다 — 본문을 비워도 Enter 가 막히면 안 된다.
  it('lets me send a file with no body', async () => {
    const onSend = vi.fn();
    fakeController({ upload: vi.fn(async () => att({ id: 'up-2' })) });
    render(<Composer onSend={onSend} />);
    pick('only.txt');
    await screen.findByText(/note\.txt|only\.txt/);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', ['up-2']));
  });

  it('clears the pending attachments after sending', async () => {
    fakeController({ upload: vi.fn(async () => att({ filename: 'gone.txt' })) });
    render(<Composer onSend={vi.fn()} />);
    pick('gone.txt');
    await screen.findByText(/gone\.txt/);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(screen.queryByText(/gone\.txt/)).toBeNull());
  });

  it('lets me drop a pending attachment before sending', async () => {
    fakeController({ upload: vi.fn(async () => att({ filename: 'oops.txt' })) });
    render(<Composer onSend={vi.fn()} />);
    pick('oops.txt');
    await screen.findByText(/oops\.txt/);

    fireEvent.click(screen.getByRole('button', { name: /remove oops\.txt/i }));

    expect(screen.queryByText(/oops\.txt/)).toBeNull();
  });

  // 업로드가 실패하면 사용자는 이유를 알아야 한다 — 조용히 사라지면 파일이 갔다고 믿는다.
  it('says so when the upload fails', async () => {
    fakeController({ upload: vi.fn(async () => { throw new Error('too large'); }) });
    render(<Composer onSend={vi.fn()} />);

    pick('big.bin');

    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('does not send a message with nothing in it', () => {
    const onSend = vi.fn();
    fakeController();
    render(<Composer onSend={onSend} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });
});

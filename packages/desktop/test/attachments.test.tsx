import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { Composer } from '../src/components/Composer';
import { Notice } from '../src/components/Notice';
import { ApiError } from '../src/lib/api';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

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
  // 이 파일이 검증하는 것은 보냄 취소 창이 아니다(#223) — 창을 끄고 즉시 전송 경로를 본다.
  // 창 자체는 undoSend.test.tsx 가 단독으로 지킨다.
  undoSendStorage.saveWindowMs(0);
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

  // 5. 실패를 조용히 삼키면 "불러오지 못했다"는 신호를 못 받는다 — 이미지가 파일 칩으로
  // 강등되기만 하고, 칩이 보이는 것이 실패 신호인데 아무도 그렇게 읽지 못한다(#257).
  it('shows "(불러오기 실패)" when preview fetch fails', async () => {
    fakeController({
      fetchAttachment: vi.fn(async () => { throw new Error('network error'); }),
    });
    render(<MessageItem message={withAttachments([att({ contentType: 'image/png', filename: 'fail.png' })])} />);

    await waitFor(() => expect(screen.getByText('(불러오기 실패)')).toBeTruthy());
    // 문구가 칩 **안에** 있어야 한다 — 어딘가 화면 밖에 있으면 강등을 설명하지 못한다.
    expect(screen.getByRole('button', { name: /fail\.png/ }).textContent)
      .toContain('(불러오기 실패)');
  });

  it('미리보기가 성공하면 실패 문구는 없다', async () => {
    fakeController();
    render(<MessageItem message={withAttachments([att({ contentType: 'image/png', filename: 'ok.png' })])} />);

    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    expect(screen.queryByText('(불러오기 실패)')).toBeNull();
  });
});

/**
 * #257 회귀선(칩 클릭). 칩을 누르면 바이트를 받아 디스크에 저장하는데, 그 거부가
 * `void getController().saveAttachment(...)` 로 버려지고 있었다 — 누른 사람에게는 아무
 * 일도 일어나지 않은 것처럼 보인다.
 *
 * 여기서는 **진짜 `Controller`** 를 쓴다. 컨트롤러를 가짜로 두면 "실패를 Notice 로
 * 세운다"는 그 컨트롤러의 책임이 검사되지 않는다.
 */
describe('첨부 저장 실패를 사람 앞에 세운다', () => {
  function mountWithRealController(fetchAttachment: () => Promise<Blob>) {
    const api = fakeApi({ fetchAttachment: vi.fn(fetchAttachment) });
    setController(new Controller(api, fakeWsFactory().makeWs));
    render(<><Notice /><MessageItem message={withAttachments([att()])} /></>);
    return api;
  }

  it('6. 칩 클릭이 실패하면 Notice 가 뜬다', async () => {
    mountWithRealController(async () => { throw new Error('네트워크가 끊겼다'); });

    fireEvent.click(screen.getByRole('button', { name: /note\.txt/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('첨부를 불러오지 못했');
  });

  it('7. 404 attachment_missing 은 "서버에 없다"로 구분돼 보인다', async () => {
    // "행은 있는데 바이트가 없다" 는 재시도로 해결되지 않는다 — 사람이 그 차이를 알아야
    // 운영자에게 말할 수 있다. 일반 실패와 같은 문구면 그 구분이 사라진다.
    mountWithRealController(async () => {
      throw new ApiError(404, 'attachment_missing', 'attachment file not found on the server');
    });

    fireEvent.click(screen.getByRole('button', { name: /note\.txt/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('서버에 없');
    expect(alert.textContent).not.toContain('첨부를 불러오지 못했');
  });

  it('성공하면 Notice 가 뜨지 않는다', async () => {
    mountWithRealController(async () => new Blob(['bytes']));

    fireEvent.click(screen.getByRole('button', { name: /note\.txt/ }));

    await waitFor(() => expect(useAppStore.getState().notice).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
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

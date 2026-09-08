import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { Composer } from '../src/components/Composer';
import { Notice } from '../src/components/Notice';
import { ApiError } from '../src/lib/api';
import { nameClipboardFile } from '../src/components/Composer';
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

/**
 * 스크린샷 붙여넣기(클립보드 → 첨부).
 *
 * 이 표면이 없으면 사람은 스크린샷을 파일로 한 번 저장하고, 📎 로 다시 찾아 고른다 —
 * 채팅에서 그림을 보내는 가장 흔한 동작에 왕복 두 번이 붙는다.
 */
describe('pasting a screenshot into the composer', () => {
  const paste = (opts: { files?: File[]; text?: string }) => {
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        files: opts.files ?? [],
        getData: () => opts.text ?? '',
      },
    });
  };

  const png = (name = 'image.png') => new File(['bytes'], name, { type: 'image/png' });

  it('uploads the image on the clipboard', async () => {
    const c = fakeController({ upload: vi.fn(async () => att({ filename: 'screenshot.png' })) });
    render(<Composer onSend={vi.fn()} />);

    paste({ files: [png()] });

    await waitFor(() => expect(c.upload).toHaveBeenCalled());
    expect(await screen.findByText(/screenshot\.png/)).toBeTruthy();
  });

  /**
   * 경계. 표·문서에서 글을 복사하면 많은 앱이 같은 클립보드에 그림 표현을 함께 싣는다.
   * 파일이 있다는 이유만으로 가로채면 문장을 붙여넣으려던 사람이 이미지 첨부를 받고
   * **글은 들어가지 않는다** — 이 줄이 그 사고를 막는다.
   */
  it('글자가 함께 있으면 평범한 텍스트 붙여넣기로 둔다', () => {
    const c = fakeController();
    render(<Composer onSend={vi.fn()} />);

    paste({ files: [png()], text: '표에서 복사한 문장' });

    expect(c.upload).not.toHaveBeenCalled();
  });

  it('이름 없는 스크린샷에는 시각을 박아 서로 구분되게 한다', () => {
    const at = new Date(2026, 8, 7, 14, 45, 3);

    const one = nameClipboardFile(png(), at);
    const two = nameClipboardFile(png(), at, 1);

    expect(one.name).toBe('screenshot-20260907-144503.png');
    // 같은 붙여넣기에서 온 두 번째 장이 첫 장을 가리면 안 된다.
    expect(two.name).toBe('screenshot-20260907-144503-2.png');
  });

  it('진짜 파일을 복사해 붙여넣었으면 그 이름을 그대로 쓴다', () => {
    const named = new File(['bytes'], '설계도.png', { type: 'image/png' });

    expect(nameClipboardFile(named, new Date()).name).toBe('설계도.png');
  });
});

/**
 * 파일을 끌어다 놓아 첨부하기.
 *
 * Tauri 는 기본값(`dragDropEnabled: true`)에서 웹뷰의 HTML5 drop 을 가로채고 파일 **경로**만
 * 주는 자기 이벤트로 바꾼다. 그러면 같은 기능이 dev(브라우저)와 패키징 앱에서 서로 다른
 * 코드로 갈리고, 브라우저에서 끌어온 이미지처럼 경로가 없는 것은 아예 받을 수 없다.
 * 그래서 `tauri.conf.json` 에서 그 가로채기를 끈다 — 아래 회귀선이 그 설정을 붙잡는다.
 */
describe('dropping files on the composer', () => {
  const filesTransfer = (files: File[]) => ({ files, types: ['Files'], dropEffect: 'none' });

  it('uploads what was dropped', async () => {
    const c = fakeController({ upload: vi.fn(async () => att({ filename: 'dropped.png' })) });
    render(<Composer onSend={vi.fn()} />);
    const box = screen.getByRole('textbox');

    fireEvent.drop(box, { dataTransfer: filesTransfer([new File(['b'], 'dropped.png', { type: 'image/png' })]) });

    await waitFor(() => expect(c.upload).toHaveBeenCalled());
    expect(await screen.findByText(/dropped\.png/)).toBeTruthy();
  });

  // 놓을 자리가 보이지 않으면 사람은 여기가 받는 자리인지 모른 채 손을 놓는다.
  it('shows where to drop while files hover', () => {
    fakeController();
    render(<Composer onSend={vi.fn()} />);
    const box = screen.getByRole('textbox');

    fireEvent.dragEnter(box, { dataTransfer: filesTransfer([]) });
    expect(screen.getByTestId('drop-zone')).toBeTruthy();

    fireEvent.dragLeave(box, { dataTransfer: filesTransfer([]) });
    expect(screen.queryByTestId('drop-zone')).toBeNull();
  });

  // 컴포저 안에서 글자를 끌어 옮기는 것은 첨부가 아니다.
  it('글자를 끄는 동안에는 놓을 자리를 그리지 않는다', () => {
    fakeController();
    render(<Composer onSend={vi.fn()} />);

    fireEvent.dragEnter(screen.getByRole('textbox'), {
      dataTransfer: { files: [], types: ['text/plain'], dropEffect: 'none' },
    });

    expect(screen.queryByTestId('drop-zone')).toBeNull();
  });

  /**
   * 이 설정이 없으면 **패키징한 앱에서만** drop 이 조용히 죽는다. 브라우저 dev 에서는
   * 계속 초록이라 아무도 모른다 — 그 거리를 테스트로 메운다.
   */
  it('tauri.conf.json 이 웹뷰의 드래그앤드롭을 가로채지 않는다', () => {
    const conf = JSON.parse(
      readFileSync(path.resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'),
    );

    for (const w of conf.app.windows) {
      expect(w.dragDropEnabled, 'true(기본값)면 웹뷰의 drop 이벤트가 앱에 오지 않는다').toBe(false);
    }
  });
});

/**
 * 보내기 전 칩의 작은 미리보기(#첨부 미리보기).
 *
 * 첨부 칩에 이름과 크기만 있으면 **무엇을 붙였는지 확인할 수 없다** — 붙여넣은 스크린샷은
 * 이름이 시각뿐이라 서로 거의 같고, 잘못된 장을 붙인 채 보내도 보내기 전에는 티가 없다.
 * 미리보기는 메시지에 그리는 것과 같은 화이트리스트를 쓴다: 칩이 SVG 로 뚫리면 안 된다.
 */
describe('보내기 전 첨부 칩의 미리보기', () => {
  const pick = (name: string, type: string) => {
    const input = screen.getByLabelText('Attach a file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['content'], name, { type })] } });
  };

  it('이미지를 붙이면 칩 안에 작은 그림이 선다', async () => {
    fakeController({ upload: vi.fn(async () => att({ contentType: 'image/png', filename: 'shot.png' })) });
    render(<Composer onSend={vi.fn()} />);

    pick('shot.png', 'image/png');

    const thumb = await screen.findByTestId('attachment-thumb');
    // 자리만 잡고 바이트가 안 온 것은 미리보기가 아니다 — src 가 있어야 눈에 보인다.
    expect(thumb.getAttribute('src')).toBeTruthy();
  });

  // 이름을 두 번 읽히면 칩 하나가 파일 두 개처럼 들린다 — 이름은 이미 옆에 글자로 있다.
  it('그림은 이름을 되풀어 읽지 않는다', async () => {
    fakeController({ upload: vi.fn(async () => att({ contentType: 'image/png', filename: 'shot.png' })) });
    render(<Composer onSend={vi.fn()} />);

    pick('shot.png', 'image/png');

    expect((await screen.findByTestId('attachment-thumb')).getAttribute('alt')).toBe('');
    expect(screen.getAllByText(/shot\.png/)).toHaveLength(1);
  });

  // 이미지가 아닌 것은 그릴 수 없다. 그런데도 바이트를 받으면 첨부마다 헛왕복이 붙는다.
  it('이미지가 아닌 첨부는 바이트를 받지 않고 📎 로 남는다', async () => {
    const c = fakeController({ upload: vi.fn(async () => att({ filename: 'note.txt' })) });
    render(<Composer onSend={vi.fn()} />);

    pick('note.txt', 'text/plain');

    await screen.findByText(/note\.txt/);
    expect(c.fetchAttachment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attachment-thumb')).toBeNull();
  });

  // SVG 는 `<script>` 를 담을 수 있다. 칩이 작다는 이유로 화이트리스트가 갈리면 안 된다.
  it('SVG 는 칩에서도 그리지 않는다', async () => {
    const c = fakeController({ upload: vi.fn(async () => att({ contentType: 'image/svg+xml', filename: 'x.svg' })) });
    render(<Composer onSend={vi.fn()} />);

    pick('x.svg', 'image/svg+xml');

    await screen.findByText(/x\.svg/);
    expect(c.fetchAttachment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attachment-thumb')).toBeNull();
  });

  // 미리보기를 못 받아도 칩은 남아야 한다 — 첨부가 사라진 것처럼 보이면 다시 붙인다.
  it('미리보기를 못 받아도 칩은 이름을 지킨다', async () => {
    fakeController({
      upload: vi.fn(async () => att({ contentType: 'image/png', filename: 'shot.png' })),
      fetchAttachment: vi.fn(async () => { throw new Error('network error'); }),
    });
    render(<Composer onSend={vi.fn()} />);

    pick('shot.png', 'image/png');

    expect(await screen.findByText(/shot\.png/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('attachment-thumb')).toBeNull());
  });

  // 실패한 그림 자리를 "원래 미리보기가 없는 파일" 과 같은 📎 로 덮으면, 사람은 잘못 붙인
  // 장을 확인할 기회를 잃은 채 그대로 보낸다. 본문 미리보기와 같은 규칙으로 갈라 말한다.
  it('미리보기를 못 받은 것과 원래 없는 것을 가려 말한다', async () => {
    fakeController({
      upload: vi.fn(async () => att({ contentType: 'image/png', filename: 'shot.png' })),
      fetchAttachment: vi.fn(async () => { throw new Error('network error'); }),
    });
    render(<Composer onSend={vi.fn()} />);

    pick('shot.png', 'image/png');

    // 문구가 칩 **안에** 있어야 어느 첨부가 실패했는지 말해 준다.
    await screen.findByText('(미리보기 실패)');
    const chip = screen.getByRole('button', { name: /remove shot\.png/i }).parentElement;
    expect(chip?.textContent).toContain('(미리보기 실패)');
  });

  it('원래 미리보기가 없는 첨부는 실패라고 말하지 않는다', async () => {
    fakeController({ upload: vi.fn(async () => att({ filename: 'note.txt' })) });
    render(<Composer onSend={vi.fn()} />);

    pick('note.txt', 'text/plain');

    await screen.findByText(/note\.txt/);
    expect(screen.queryByText('(미리보기 실패)')).toBeNull();
  });

  it('미리보기가 성공하면 실패 문구는 남지 않는다', async () => {
    fakeController({ upload: vi.fn(async () => att({ contentType: 'image/png', filename: 'shot.png' })) });
    render(<Composer onSend={vi.fn()} />);

    pick('shot.png', 'image/png');

    await screen.findByTestId('attachment-thumb');
    expect(screen.queryByText('(미리보기 실패)')).toBeNull();
  });

  /**
   * 바이트가 도착하는 순간 📎(11px)가 그림(24px)으로 바뀌면 칩 줄이 통째로 밀려 내려간다 —
   * 지우기(×)를 누르려던 손이 빗나간다. 그래서 그림이 **올 자리**는 미리 잡아 둔다.
   */
  it('그림이 올 자리는 미리 잡아 칩이 튀지 않게 한다', async () => {
    const hold = new Promise<Blob>(() => {});
    fakeController({
      upload: vi.fn(async () => att({ contentType: 'image/png', filename: 'shot.png' })),
      fetchAttachment: vi.fn(() => hold),
    });
    render(<Composer onSend={vi.fn()} />);

    pick('shot.png', 'image/png');

    const chip = (await screen.findByRole('button', { name: /remove shot\.png/i })).parentElement;
    // 칩의 첫 칸이 그림 자리다 — 바이트가 오기 전에도 그림과 같은 높이를 차지해야 한다.
    expect(chip?.firstElementChild?.className).toContain('h-6');
  });
});

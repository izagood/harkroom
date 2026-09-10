import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { Composer } from '../src/components/Composer';
import { Notice } from '../src/components/Notice';
import { ApiError } from '../src/lib/api';
import { nameClipboardFile } from '../src/components/Composer';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { useFileDropGuard } from '../src/lib/useFileDropGuard';

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
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    activeChannelId: 'c1',
  });
});
// **언어를 고정한다**(이 묶음의 문구가 사전을 지나면서 기본이 영어가 됐다). 이 파일이
// 재는 것은 언어가 아니라 **그 언어로 표현된 규율**이다 — 언어를 재는 자리는
// `i18n.test.tsx` 하나이고, 두 곳에서 재면 문구를 고칠 때 한쪽만 고쳐진다
// (`gallery.test.tsx`·`skillsSettings.test.tsx`·`agentGrid.test.tsx` 와 같은 규약).
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

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
   *
   * **플랫폼 설정까지 함께 본다.** Tauri 는 `tauri.<플랫폼>.conf.json` 을 JSON Merge
   * Patch(RFC 7386)로 얹는데, 그 규칙에서 **배열은 병합되지 않고 통째로 갈린다.** 즉
   * `app.windows` 를 다시 적은 플랫폼 파일은 기본 파일의 창 설정을 **전부** 덮는다 —
   * 거기 적지 않은 `dragDropEnabled` 는 기본값 `true` 로 되돌아간다.
   *
   * 실제로 그렇게 됐다(2026-09-10): `tauri.macos.conf.json` 이 제목표시줄 때문에 창을
   * 다시 적으면서 `dragDropEnabled: false` 를 데려가지 않았고, **macOS 에서만** Finder
   * 드래그앤드롭이 죽었다(wry 가 네이티브 핸들러로 drop 을 삼키고 웹뷰에 넘기지 않는다).
   * 기본 파일만 읽던 그때의 회귀선은 초록이었다.
   */
  it('플랫폼 설정을 얹은 뒤에도 웹뷰의 드래그앤드롭을 가로채지 않는다', () => {
    const dir = path.resolve(__dirname, '../src-tauri');
    const read = (file: string) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    const base = read('tauri.conf.json');
    const platforms = readdirSync(dir).filter((f) => /^tauri\.[a-z]+\.conf\.json$/.test(f));

    // 기본 파일이 곧 리눅스다(얹는 것이 없다) — 그 자리도 함께 잰다.
    for (const [name, conf] of [['tauri.conf.json', base] as const,
      ...platforms.map((f) => [f, read(f)] as const)]) {
      // Merge Patch 의 배열 규칙: 적었으면 그것이 전부, 안 적었으면 기본이 그대로 산다.
      const windows = conf.app?.windows ?? base.app.windows;
      for (const w of windows) {
        expect(w.dragDropEnabled, `${name}: true(기본값)면 웹뷰의 drop 이벤트가 앱에 오지 않는다`)
          .toBe(false);
      }
    }
  });
});

/**
 * 컴포저 **밖**에 떨어진 파일.
 *
 * 웹뷰의 기본 동작은 그 파일을 여는 것이다 — SPA 인 이 앱에서는 화면과 초안이 통째로
 * 사라진다. 손은 자주 조금 빗나가므로(메시지 목록·사이드바) 창 전체에 안전망을 깐다.
 */
describe('컴포저 밖에 떨어진 파일', () => {
  const Guarded = () => { useFileDropGuard(); return <div data-testid="page">page</div>; };

  it('앱을 갈아치우지 못하게 기본 동작을 막는다', () => {
    render(<Guarded />);

    const dropped = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropped, 'dataTransfer', { value: { files: [], types: ['Files'] } });
    screen.getByTestId('page').dispatchEvent(dropped);

    expect(dropped.defaultPrevented, '막지 않으면 웹뷰가 그 파일을 열어 앱이 사라진다').toBe(true);
  });

  // 글자 드래그까지 막으면 컴포저 안에서 글을 끌어 옮기는 평범한 동작이 죽는다.
  it('글자를 끄는 것은 막지 않는다', () => {
    render(<Guarded />);

    const dropped = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropped, 'dataTransfer', { value: { files: [], types: ['text/plain'] } });
    screen.getByTestId('page').dispatchEvent(dropped);

    expect(dropped.defaultPrevented).toBe(false);
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

/**
 * 그림을 눌러 크게 보기(라이트박스).
 *
 * 본문의 미리보기는 `max-h-64` 로 줄여 그린다 — 스크린샷을 보낸 사람이 보라고 보낸 것은
 * 대개 그 안의 글자인데, 줄인 그림에서는 읽히지 않는다. 크게 볼 자리가 없으면 사람은
 * 그림을 디스크에 저장해 시스템 뷰어로 열고, 그 왕복에서 채팅을 떠난다.
 */
describe('첨부 이미지를 눌러 크게 보기', () => {
  const image = (over: Partial<AttachmentRow> = {}) =>
    att({ contentType: 'image/png', filename: 'shot.png', ...over });

  const renderImage = async (over: Partial<AttachmentRow> = {}) => {
    render(<MessageItem message={withAttachments([image(over)])} />);
    return screen.findByRole('button', { name: /크게 보기/ });
  };

  // 누르는 자리는 그림 자체다 — 옆에 따로 링크를 두면, 손이 이미 올라간 곳 밖에서
  // 누를 곳을 다시 찾아야 한다.
  it('그림을 누르면 확대 보기가 열린다', async () => {
    fakeController();
    fireEvent.click(await renderImage());

    const dialog = screen.getByRole('dialog', { name: 'shot.png' });
    expect(dialog.querySelector('[data-testid="attachment-full"]')).toBeTruthy();
  });

  // 열기 전에는 떠 있으면 안 된다 — 채널을 열자마자 그림이 화면을 덮으면 목록을 읽을 수 없다.
  it('누르기 전에는 열려 있지 않다', async () => {
    fakeController();
    await renderImage();

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // 키보드로도 열려야 한다: `div` 에 onClick 만 달면 마우스만 그림을 볼 수 있다.
  it('그림 자리는 버튼이라 Tab 으로 닿는다', async () => {
    fakeController();
    const opener = await renderImage();

    expect(opener.tagName).toBe('BUTTON');
  });

  /**
   * 닫는 길은 `Overlay` 가 정한다 — Esc · 스크림. 이 케이스는 그 프리미티브를 **실제로
   * 쓰는지**를 잰다: 여기서 스크림·Esc 를 따로 구현하면 "겹쳐 열려도 맨 위 하나만
   * 닫힌다"는 규칙이 이 자리에서만 갈린다.
   */
  it('Esc 로 닫힌다', async () => {
    fakeController();
    fireEvent.click(await renderImage());
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('바깥(스크림)을 눌러도 닫힌다', async () => {
    fakeController();
    fireEvent.click(await renderImage());
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement;

    fireEvent.click(scrim);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('닫기 버튼으로도 닫힌다', async () => {
    fakeController();
    fireEvent.click(await renderImage());

    fireEvent.click(screen.getByRole('button', { name: '확대 보기 닫기' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * 확대할 그림은 이미 본문에 그려진 그것이다. 다시 받으면 클릭마다 왕복이 붙고,
   * objectURL 의 수명을 두 곳이 나눠 갖게 된다 — 닫는 쪽이 revoke 한 URL 을 본문이
   * 계속 가리키면 미리보기가 빈 자리가 된다.
   */
  it('확대해도 바이트를 다시 받지 않는다', async () => {
    const c = fakeController();
    fireEvent.click(await renderImage());

    await screen.findByTestId('attachment-full');
    expect(c.fetchAttachment).toHaveBeenCalledTimes(1);
  });

  /**
   * 이미지는 칩이 아니라 그림으로 그려지므로, 확대 보기 말고는 **저장할 자리가 없다** —
   * 미리보기가 되는 첨부일수록 내려받을 길이 없어지는 것이 이 버튼이 있는 이유다.
   */
  it('확대 보기에서 그림을 저장할 수 있다', async () => {
    const c = fakeController();
    fireEvent.click(await renderImage());

    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    expect(c.saveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  it('이름과 크기를 함께 말한다 — 어느 파일을 보고 있는지', async () => {
    fakeController();
    fireEvent.click(await renderImage({ sizeBytes: 1234 }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('shot.png');
    expect(dialog.textContent).toContain('1.2 KB');
  });

  // 그릴 수 없는 첨부(칩)를 누르는 것은 저장이다 — 확대 보기가 그 자리를 먹으면
  // 파일을 받으려던 사람이 겹창을 보게 된다. 열리지 않는 것만이 아니라 **저장이
  // 그대로 불리는지**까지 잰다: 클릭이 조용히 아무 일도 안 하는 것도 같은 회귀다.
  it('이미지가 아닌 첨부에는 확대 보기가 없다', async () => {
    const c = fakeController();
    render(<MessageItem message={withAttachments([att()])} />);

    fireEvent.click(screen.getByRole('button', { name: /note\.txt/ }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /크게 보기/ })).toBeNull();
    expect(c.saveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  // 바이트를 못 받았으면 확대할 것도 없다 — 빈 창을 열면 실패를 성공처럼 보이게 한다.
  it('미리보기를 못 받으면 확대 보기 자리도 없다', async () => {
    fakeController({ fetchAttachment: vi.fn(async () => { throw new Error('network error'); }) });
    render(<MessageItem message={withAttachments([image()])} />);

    await screen.findByText('(불러오기 실패)');
    expect(screen.queryByRole('button', { name: /크게 보기/ })).toBeNull();
  });

  /**
   * PR #646 이 세운 경계 셋 — 같은 기능을 따로 구현하면서 잡은 것이라, 구현은 겹치지만
   * 이 회귀선들은 main 에 없었다.
   */

  /**
   * **포커스가 겹창으로 들어와야 한다.** 그림 버튼에 남으면 화살표·PageDown 이 스크림
   * 뒤의 목록을 움직이고, Tab 은 겹창이 아니라 뒤 화면의 다음 버튼으로 간다 — 키보드로
   * 열었을 때 `×` 가 손에 닿지 않는 것도 같은 이유다.
   */
  it('열면 포커스가 겹창 안으로 들어온다', async () => {
    fakeController();
    fireEvent.click(await renderImage());

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '확대 보기 닫기' }));
  });

  /**
   * "다시 받지 않는다" 를 요청 수로만 재면, 겹창이 **다른** objectURL(예: 두 번째 blob)을
   * 그려도 초록이다. 같은 URL 인지까지 봐야 목록의 그림을 그대로 쓴다는 뜻이 된다.
   */
  it('겹창의 그림은 목록의 그림과 같은 objectURL 이다', async () => {
    fakeController();
    const opener = await renderImage();
    const listed = screen.getByRole('img', { name: 'shot.png' }).getAttribute('src');

    fireEvent.click(opener);

    expect(screen.getByTestId('attachment-full').getAttribute('src')).toBe(listed);
    expect(listed).toBeTruthy();
  });

  /**
   * 여러 장이 붙은 메시지에서 **누른** 그림이 열려야 한다. 열림 상태를 첨부마다 들지 않고
   * 메시지 하나에 들면, 두 번째 그림을 눌렀을 때 첫 장이 열리는 모양이 된다.
   */
  it('여러 장 중 누른 그림이 열린다', async () => {
    fakeController();
    render(<MessageItem message={withAttachments([
      image({ id: 'a1', filename: 'first.png' }),
      image({ id: 'a2', filename: 'second.png' }),
    ])} />);

    fireEvent.click(await screen.findByRole('button', { name: '크게 보기: second.png' }));

    expect(screen.getByRole('dialog', { name: 'second.png' })).toBeTruthy();
  });
});

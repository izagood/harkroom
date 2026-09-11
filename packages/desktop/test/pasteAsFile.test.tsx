import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AttachmentRow } from '@harkroom/shared';
import { MAX_MESSAGE_BODY_CHARS } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { Composer, pastedTextFile } from '../src/components/Composer';
import { acc } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 긴 글을 **파일로 넘긴다**.
 *
 * 왜 필요한가: 코드 파일이나 로그를 통째로 붙여넣는 일이 잦고, 그것을 그대로 보내면 한 통이
 * 채널을 몇 화면 밀어내 앞뒤 대화가 스크롤 밖으로 사라진다(상한 8000자를 안 넘겨도 그렇다).
 * 상한을 넘긴 경우에는 아예 나가지도 않는다.
 *
 * 이 파일이 지키는 것 셋: 붙여넣기는 **여전히 글자를 남기고**(막지 않는다), 파일로 옮기는
 * 것은 **버튼을 누를 때만** 일어나고, **올린 뒤에 초안에서 뺀다**(실패하면 글을 잃지 않는다).
 */

const att = (over: Partial<AttachmentRow> = {}): AttachmentRow =>
  ({ id: 'a1', filename: 'pasted.txt', contentType: 'text/plain', sizeBytes: 4096, ...over });

const fakeController = (over: Partial<Controller> = {}) => {
  const c = {
    upload: vi.fn(async () => att()),
    fetchAttachment: vi.fn(async () => new Blob(['bytes'])),
    send: vi.fn(async () => undefined),
    notifyTyping: vi.fn(),
    refreshAccounts: vi.fn(async () => undefined),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
};

/**
 * 브라우저의 붙여넣기를 흉내낸다 — jsdom 은 paste 의 기본 동작(글자 삽입)을 하지 않으므로
 * 막히지 않았을 때만 삽입까지 해 준다(`permalinkPaste.test.tsx` 와 같은 도구).
 */
const paste = (box: HTMLElement, text: string): void => {
  const notPrevented = fireEvent.paste(box, { clipboardData: { getData: () => text } });
  if (!notPrevented) return;
  const next = (box as HTMLTextAreaElement).value + text;
  fireEvent.change(box, { target: { value: next, selectionStart: next.length } });
};

/** jsdom 의 `File` 은 `.text()` 도 `Response` 도 받지 않는다 — 표준 리더로 읽는다. */
const readText = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(file);
});

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const moveButton = () => screen.getByTestId('paste-as-file-move');
const CODE = 'const x = 1;\n'.repeat(200); // 2,600자 — 제안선(2,000)을 넘긴다

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().clearDrafts();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
  fakeController();
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
  setController(null as unknown as Controller);
});

describe('긴 붙여넣기', () => {
  it('글자는 그대로 초안에 들어가고, 제안 줄이 함께 선다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    paste(box(), CODE);

    // **막지 않는다** — 붙여넣기는 붙여넣기로 끝난다(퍼머링크와 같은 규칙).
    expect(box().value).toBe(CODE);
    expect(screen.getByTestId('paste-as-file').textContent).toContain('2,600자');
  });

  it('짧은 붙여넣기에는 아무것도 서지 않는다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    paste(box(), '이건 그냥 한 문장이다');

    expect(screen.queryByTestId('paste-as-file')).toBeNull();
  });

  it('버튼을 누르면 .txt 첨부가 되고 그만큼 초안에서 빠진다', async () => {
    const c = fakeController({ upload: vi.fn(async () => att({ filename: 'pasted-1.txt' })) });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    paste(box(), CODE);
    fireEvent.change(box(), { target: { value: `${CODE}이거 봐 줘`, selectionStart: 0 } });
    fireEvent.click(moveButton());

    await waitFor(() => expect(c.upload).toHaveBeenCalled());
    const file = (c.upload as unknown as { mock: { calls: File[][] } }).mock.calls[0]![0]!;
    expect(file.name).toMatch(/^pasted-\d{8}-\d{6}\.txt$/);
    expect(file.type).toBe('text/plain;charset=utf-8');
    expect(await readText(file)).toBe(CODE);

    // 붙여넣은 덩어리만 빠지고 사람이 쓴 말은 남는다 — 그것이 이 기능의 요점이다.
    await waitFor(() => expect(box().value).toBe('이거 봐 줘'));
    expect(screen.queryByTestId('paste-as-file')).toBeNull();
  });

  /** 올린 뒤에 뺀다 — 순서가 뒤집히면 업로드가 실패한 순간 붙여넣은 글이 어디에도 없다. */
  it('업로드가 실패하면 초안을 건드리지 않는다', async () => {
    fakeController({ upload: vi.fn(async () => { throw new Error('nope'); }) });
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    paste(box(), CODE);
    fireEvent.click(moveButton());

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('올리지 못했다'));
    expect(box().value).toBe(CODE);
    // 제안은 그대로 남는다 — 다시 누를 수 있어야 한다.
    expect(screen.getByTestId('paste-as-file')).toBeTruthy();
  });

  it('붙여넣은 글을 지우면 제안도 사라진다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    paste(box(), CODE);
    fireEvent.change(box(), { target: { value: '', selectionStart: 0 } });

    expect(screen.queryByTestId('paste-as-file')).toBeNull();
  });

  it('채널을 옮기면 제안을 들고 가지 않는다', () => {
    const { rerender } = render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    paste(box(), CODE);

    rerender(<Composer onSend={vi.fn()} scopeKey="c2" />);

    expect(screen.queryByTestId('paste-as-file')).toBeNull();
  });
});

describe('상한을 넘긴 본문', () => {
  /**
   * 상한을 넘기면 전송이 막힌다(앞 PR). 그때 이 줄이 **유일한 출구**다 — 붙여넣은 덩어리를
   * 들고 있지 않아도(여러 번에 걸쳐 넣었거나 직접 썼어도) 본문 전체를 파일로 넘길 수 있다.
   */
  it('붙여넣지 않았어도 본문 전체를 파일로 넘길 수 있다', async () => {
    const c = fakeController();
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    const long = '가'.repeat(MAX_MESSAGE_BODY_CHARS + 10);
    fireEvent.change(box(), { target: { value: long, selectionStart: long.length } });

    expect(screen.getByTestId('paste-as-file')).toBeTruthy();
    fireEvent.click(moveButton());

    await waitFor(() => expect(c.upload).toHaveBeenCalled());
    await waitFor(() => expect(box().value).toBe(''));
    // 첨부만 남았으니 전송은 다시 살아 있다 — 첨부만 보내는 것은 자연스럽다.
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('상한을 넘긴 줄에는 물릴 버튼을 주지 않는다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    const long = '가'.repeat(MAX_MESSAGE_BODY_CHARS + 10);
    fireEvent.change(box(), { target: { value: long, selectionStart: long.length } });

    // 버튼은 옮기기 하나뿐이다 — 지워 두면 사람은 막힌 채로 남는다.
    expect(screen.getByTestId('paste-as-file').querySelectorAll('button')).toHaveLength(1);
  });
});

describe('pastedTextFile', () => {
  it('시각을 이름에 박는다 — 한 채널에 pasted.txt 가 열 개면 구분할 수 없다', () => {
    const file = pastedTextFile('본문', new Date(2026, 8, 9, 3, 4, 5));
    expect(file.name).toBe('pasted-20260909-030405.txt');
  });
});

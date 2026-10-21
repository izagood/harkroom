import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { MessageBody } from '../src/components/MessageBody';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { continueList, formatShortcut, inFence, toggleInline, toggleLinePrefix } from '../src/lib/mdFormat';

/*
  입력창 서식 단축키와 Enter 규칙(입력창 개편 P1, 시안 v1 키보드 표).

  지키는 축:
  1. **넣은 기호는 메시지 렌더러가 읽는 기호다** — 단축키로 만든 글을 `MessageBody` 로 그리면
     그 서식이 선다. 굵게와 맞닿은 기울임이 `*` 가 아니라 `_` 인 이유가 여기 있다.
  2. **켜고 끄기는 짝이다** — 같은 열쇠를 다시 누르면 원문으로 돌아온다.
  3. **Enter 는 보내기, 코드 블록 안에서는 줄바꿈, ⌘Enter 는 어디서든 보내기.**
*/

const key = (code: string, opts: { shift?: boolean } = {}) => ({
  key: '', code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: !!opts.shift,
});

const place = (value: string, start: number, end = start) => {
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value, selectionStart: end } });
  box.setSelectionRange(start, end);
  return box;
};
const draft = () => useAppStore.getState().drafts[''] ?? '';

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
  setController(new Controller(fakeApi()));
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
});

describe('⌘B·⌘I·⌘⇧X — 고른 글을 감싸고 벗긴다', () => {
  it('굵게·기울임·취소선은 렌더러가 읽는 기호로 감싼다', () => {
    const b = toggleInline('아주 중요', 3, 5, '**');
    const i = toggleInline(b.text, b.start, b.end, '*');
    const x = toggleInline('지운 말', 0, 2, '~~');
    expect(i.text).toBe('아주 **_중요_**');
    expect(x.text).toBe('~~지운~~ 말');

    render(<MessageBody body={`${i.text} ${x.text}`} messageId="m1" />);
    expect(document.querySelector('strong em, em strong')?.textContent).toBe('중요');
    expect(document.querySelector('del, s')?.textContent).toBe('지운');
  });

  it('다시 누르면 원문으로 돌아온다 — 굵게 안의 기울임도 개수로 가른다', () => {
    const b = toggleInline('a 중요 b', 2, 4, '**');
    expect(toggleInline(b.text, b.start, b.end, '**').text).toBe('a 중요 b');
    const bi = toggleInline(b.text, b.start, b.end, '*');
    // 기울임만 벗기면 굵게는 남는다.
    expect(toggleInline(bi.text, bi.start, bi.end, '*').text).toBe(b.text);
    // 굵게만 있는 데서 ⌘I 는 벗기기가 아니라 감싸기다 — 굵게와 맞닿으니 `_` 로.
    expect(bi.text).toBe('a **_중요_** b');
    // 맞닿지 않으면 `*` 다(`_` 는 영숫자 뒤에서 열리지 않는다).
    expect(toggleInline('abc 중요', 4, 6, '*').text).toBe('abc *중요*');
  });

  it('고른 것이 없으면 빈 짝을 열고 커서를 안에 둔다', () => {
    const out = toggleInline('앞', 1, 1, '**');
    expect(out).toEqual({ text: '앞****', start: 3, end: 3 });
    // 빈 짝 안에서 다시 누르면 짝을 거둔다.
    expect(toggleInline(out.text, 3, 3, '**').text).toBe('앞');
  });

  it('앞뒤 공백은 기호 밖에 둔다 — 렌더러는 `** 글**` 를 굵게로 읽지 않는다', () => {
    expect(toggleInline('a  굵게 b', 1, 5, '**').text).toBe('a  **굵게** b');
  });

  it('여러 줄은 줄마다 감싼다', () => {
    expect(toggleInline('하나\n\n둘', 0, 5, '**').text).toBe('**하나**\n\n**둘**');
  });

  it('입력창에서 ⌘B 를 누르면 초안이 바뀌고 선택은 같은 글자에 남는다', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
    render(<Composer onSend={vi.fn()} />);
    const box = place('이건 중요하다', 3, 5);
    fireEvent.keyDown(box, { key: 'ㅠ', code: 'KeyB', metaKey: true });
    expect(draft()).toBe('이건 **중요**하다');
    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 7]);
    vi.restoreAllMocks();
  });
});

describe('⌘⇧7·⌘⇧8·⌘⇧9 — 줄머리 기호', () => {
  it('번호 목록은 줄마다 번호를 매기고, 빈 줄은 건너뛴다', () => {
    expect(toggleLinePrefix('가\n\n나', 0, 4, 'ordered').text).toBe('1. 가\n\n2. 나');
  });

  it('글머리 목록에서 번호 목록으로 바뀐다 — 두 겹이 되지 않는다', () => {
    expect(toggleLinePrefix('- 가\n- 나', 0, 7, 'ordered').text).toBe('1. 가\n2. 나');
  });

  it('모든 줄이 이미 그 기호면 뗀다', () => {
    expect(toggleLinePrefix('> 가\n> 나', 0, 7, 'quote').text).toBe('가\n나');
    expect(toggleLinePrefix('- 가', 3, 3, 'bullet')).toEqual({ text: '가', start: 1, end: 1 });
  });

  it('커서만 있으면 그 줄 하나에 붙이고 커서는 같은 글자 앞에 남는다', () => {
    expect(toggleLinePrefix('앞\n가나', 4, 4, 'bullet')).toEqual({ text: '앞\n- 가나', start: 6, end: 6 });
  });

  it('열쇠는 글자가 아니라 자리(code)로 읽는다 — 한글 입력·⇧ 와 숫자에서도 같다', () => {
    expect(formatShortcut(key('KeyB'))).toEqual({ kind: 'inline', mark: '**' });
    expect(formatShortcut(key('KeyI'))).toEqual({ kind: 'inline', mark: '*' });
    expect(formatShortcut(key('KeyX', { shift: true }))).toEqual({ kind: 'inline', mark: '~~' });
    expect(formatShortcut(key('Digit7', { shift: true }))).toEqual({ kind: 'line', line: 'ordered' });
    expect(formatShortcut(key('Digit8', { shift: true }))).toEqual({ kind: 'line', line: 'bullet' });
    expect(formatShortcut(key('Digit9', { shift: true }))).toEqual({ kind: 'line', line: 'quote' });
    // ⇧ 없는 숫자·⌘ 없는 B 는 서식이 아니다.
    expect(formatShortcut(key('Digit7'))).toBeNull();
    expect(formatShortcut({ ...key('KeyB'), metaKey: false })).toBeNull();
  });
});

describe('Enter 규칙', () => {
  it('목록 줄에서 Shift+Enter 는 다음 기호를 잇는다 — 번호는 하나 오른다', () => {
    expect(continueList('- 가', 3)).toEqual({ text: '- 가\n- ', start: 6, end: 6 });
    expect(continueList('  2. 나', 6)).toEqual({ text: '  2. 나\n  3. ', start: 12, end: 12 });
    expect(continueList('평범한 줄', 5)).toBeNull();
  });

  it('빈 항목에서 Shift+Enter 는 목록을 끝낸다 — 기호만 지운다', () => {
    expect(continueList('- 가\n- ', 6)).toEqual({ text: '- 가\n', start: 4, end: 4 });
  });

  it('코드 블록 안(닫히지 않은 블록 포함)과 여는 펜스 줄 끝은 블록 안이다', () => {
    expect(inFence('```\nls', 6)).toBe(true);
    expect(inFence('```js', 5)).toBe(true);
    expect(inFence('```\nls\n```\n뒤', 12)).toBe(false);
    expect(inFence('그냥 글', 4)).toBe(false);
  });

  it('입력창: 코드 블록 안의 Enter 는 보내지 않고, ⌘Enter 는 보낸다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = place('```\nls -la', 10);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    // 보내지 않은 Enter 는 편집기의 줄바꿈이 된다.
    expect(draft()).toBe('```\nls -la\n');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toContain('```\nls -la');
  });

  it('입력창: 조합 중의 Enter 는 보내지 않는다 — 글자를 확정하는 Enter 다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = place('안녕', 2);
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

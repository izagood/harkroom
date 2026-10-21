import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import {
  ENTER_TRACE_MAX, clearEnterTrace, dumpEnterTrace, enterTraceSnapshot, isEnterTraceDumpShortcut, recordEnter,
} from '../src/lib/enterTrace';

/*
  입력창 Enter 기록(진단). 지키는 것:
  1. Enter 가 지나간 길이 남는다 — 글 칸 도착(raw) → 열쇠 처리기의 갈래(key) → 보내기 판정(send).
  2. **글자는 한 자도 남지 않는다** — 사람이 복사해 채팅에 붙이는 기록이다.
  3. 200개를 넘으면 오래된 것부터 버린다.
*/

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

beforeEach(() => {
  clearEnterTrace();
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

describe('Enter 기록', () => {
  it('보낸 Enter 는 raw → key(send) → send(sent) 로 남고, 편집기 글 길이와 초안 길이를 둘 다 적는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('비밀 초안 hello');
    box.focus();
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledTimes(1);

    const kinds = enterTraceSnapshot().map((e) => [e.kind, e.route ?? e.outcome ?? null]);
    expect(kinds).toEqual([['raw', null], ['key', 'send'], ['send', 'sent']]);
    const key = enterTraceSnapshot().find((e) => e.kind === 'key')!;
    expect(key.docLen).toBe('비밀 초안 hello'.length);
    expect(key.draftLen).toBe('비밀 초안 hello'.length);
    expect(key.focus).toBe('cm-content');
  });

  it('빈 칸의 Enter 는 보내지 않은 사유(empty)를 남긴다', () => {
    render(<Composer onSend={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(enterTraceSnapshot().filter((e) => e.kind === 'send').map((e) => e.outcome)).toEqual(['empty']);
  });

  it('Shift+Enter·⌘Enter 는 갈래 이름으로 남는다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('줄');
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13, metaKey: true });
    expect(enterTraceSnapshot().filter((e) => e.kind === 'key').map((e) => e.route)).toEqual(['shift', 'meta-send']);
  });

  it('덤프에는 쓴 글자가 한 자도 없다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('절대 새면 안 되는 글 secret-123');
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13 });
    const dump = dumpEnterTrace();
    expect(dump).toMatch(/^harkroom enter-trace v1\n/);
    for (const word of ['절대', '새면', 'secret', '123']) expect(dump).not.toContain(word);
  });

  it('200개를 넘으면 오래된 것부터 버린다', () => {
    for (let i = 0; i < ENTER_TRACE_MAX + 5; i++) recordEnter({ kind: 'raw', docLen: i });
    const snap = enterTraceSnapshot();
    expect(snap).toHaveLength(ENTER_TRACE_MAX);
    expect(snap[0]!.docLen).toBe(5);
  });

  it('꺼내는 열쇠는 ⌘⌥⇧E 이고 글자 대신 자리(code)로 본다 — 한글 입력 상태에서도 된다', () => {
    const k = { metaKey: true, ctrlKey: false, altKey: true, shiftKey: true };
    expect(isEnterTraceDumpShortcut({ ...k, code: 'KeyE' })).toBe(true);
    expect(isEnterTraceDumpShortcut({ ...k, shiftKey: false, code: 'KeyE' })).toBe(false);
    expect(isEnterTraceDumpShortcut({ ...k, code: 'KeyD' })).toBe(false);
  });
});

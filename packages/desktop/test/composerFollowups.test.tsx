import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/*
  입력창 후속(10-23 jaebin 「f1~f5 한 PR」). 여기서는 입력창(Composer·편집기·도구줄) 몫 — f3 서식 켜짐 표시·조합 중 ⌘B,
  f4 조합 대기 중 자리를 옮기면 대기를 버림, f5 좁은 칸 도구줄. f1·f2(스레드 「…에도 올리기」)는 alsoInChannel.test.
*/

const typeInto = (value: string, caret = value.length) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: caret } });
  (box as HTMLTextAreaElement).setSelectionRange(caret, caret);
  return box;
};
const draft = (scope = '') => useAppStore.getState().drafts[scope] ?? '';
const wait = (ms: number) => act(() => new Promise<void>((r) => { setTimeout(r, ms); }));
const pressed = (kind: string) => screen.getByTestId(`fmt-${kind}`).getAttribute('aria-pressed');

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

describe('f3 도구줄 켜짐 표시', () => {
  it('커서가 굵은 글 안이면 B 가 켜지고, 밖으로 나가면 꺼진다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('앞 **굵게** 뒤', 6);
    expect(pressed('bold')).toBe('true');
    expect(pressed('italic')).toBe('false');
    act(() => { (screen.getByRole('textbox') as HTMLTextAreaElement).setSelectionRange(1, 1); });
    expect(pressed('bold')).toBe('false');
  });

  it('목록·인용·코드도 커서 자리를 따라 켜진다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('- 항목');
    expect(pressed('bullet')).toBe('true');
    cleanup();
    render(<Composer onSend={vi.fn()} />);
    typeInto('말 `코드` 끝', 4);
    expect(pressed('code')).toBe('true');
  });
});

describe('f3 조합 중 ⌘B — 확정한 뒤 굵게', () => {
  it('조합 중 ⌘B 는 그 자리에서 아무것도 안 하고, 확정이 끝나면 굵게를 건다', async () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('한글');
    fireEvent.compositionStart(box, { data: '' });
    const ev = fireEvent.keyDown(box, { key: 'b', code: 'KeyB', metaKey: true, isComposing: true });
    // 브라우저의 서식 명령(<b>)은 막는다.
    expect(ev).toBe(false);
    expect(draft()).toBe('한글');
    fireEvent.compositionEnd(box, { data: '글' });
    await wait(10);
    expect(draft()).toContain('**');
  });
});

describe('f4 조합 대기 중 자리를 옮기면 대기를 버린다', () => {
  it('조합 중 Enter 뒤 다른 자리로 옮기면, 시한이 지나도 옮긴 자리의 초안을 보내지 않는다', async () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} scopeKey="A" />);
    const box = typeInto('A 글');
    fireEvent.compositionStart(box, { data: '' });
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    useAppStore.getState().setDraft('B', 'B 초안');
    rerender(<Composer onSend={onSend} scopeKey="B" />);
    await wait(400);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('자리를 안 옮겼으면 조합 중 Enter 는 그대로 한 번 보낸다(「Enter 두 번」 고침 유지)', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="A" />);
    const box = typeInto('A 글');
    fireEvent.compositionStart(box, { data: '' });
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    await wait(400);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('f5 좁은 칸 도구줄', () => {
  it('도구줄은 넘치면 다음 줄로 넘긴다 — 가로로 밀어 잘라 두지 않는다', () => {
    render(<Composer onSend={vi.fn()} />);
    const bar = screen.getByTestId('composer-toolbar');
    expect(bar.className).toContain('flex-wrap');
    expect(bar.className).not.toContain('overflow-x-auto');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/*
  되돌리기(⌘Z) 기록은 **자리(채널·스레드)마다 따로**다(#1428 security F1).

  입력창은 채널을 옮겨도 다시 만들어지지 않는다(`scopeKey` 만 바뀐다). 편집기의 기록이 자리를 넘어
  이어지면 B 에서 ⌘Z 를 눌렀을 때 A(DM 일 수 있다)의 초안이 B 칸에 돌아오고, 그대로 Enter 를 치면
  A 의 글이 B 로 나간다. 같은 자리 안에서도 코드가 넣은 값(보낸 뒤 비우기)은 기록에 남기지 않는다 —
  남기면 보낸 글이 ⌘Z 로 되살아난다.
*/

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
};
const view = () => EditorView.findFromDOM(document.querySelector('.cm-content') as HTMLElement)!;
const pressUndo = () => act(() => { undo(view()); });
const drafts = () => useAppStore.getState().drafts;
/**
 * 편집기는 0.5초 안에 붙어 일어난 바뀜을 되돌리기 한 번으로 묶는다(`newGroupDelay`). 시험은 한 틱에 다
 * 일어나므로 시계를 넘기지 않으면 「사람이 친 것」과 「코드가 넣은 것」이 한 덩이가 되어, 고치기 전에도
 * 우연히 통과한다. 사람이 실제로 쓰는 간격을 흉내 낸다.
 */
const later = () => vi.setSystemTime(Date.now() + 2000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
  setController(new Controller(fakeApi()));
});
afterEach(() => {
  vi.useRealTimers();
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
});

describe('되돌리기 기록은 자리마다 끊긴다', () => {
  it('A 에서 쓰고 B 로 옮긴 뒤 ⌘Z — A 의 초안이 B 로 넘어오지 않는다', () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} scopeKey="dm-A" />);
    typeInto('DM 비밀 초안');
    expect(drafts()['dm-A']).toBe('DM 비밀 초안');

    later();
    rerender(<Composer onSend={onSend} scopeKey="public-B" />);
    expect(view().state.doc.toString()).toBe('');
    later();
    pressUndo();

    expect(view().state.doc.toString()).toBe('');
    expect(drafts()['public-B'] ?? '').toBe('');
    expect(drafts()['dm-A']).toBe('DM 비밀 초안');
  });

  it('B 에 이미 초안이 있어도 ⌘Z 는 그 초안을 A 것으로 바꾸지 않는다', () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} scopeKey="public-B" />);
    typeInto('B 초안');
    rerender(<Composer onSend={onSend} scopeKey="dm-A" />);
    typeInto('DM 비밀 초안');

    rerender(<Composer onSend={onSend} scopeKey="public-B" />);
    expect(view().state.doc.toString()).toBe('B 초안');
    pressUndo();
    expect(view().state.doc.toString()).toBe('B 초안');
    expect(drafts()['public-B']).toBe('B 초안');
  });

  it('같은 자리에서도 보낸 뒤 ⌘Z 로 보낸 글이 되살아나지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c" />);
    typeInto('보낸 글');
    later();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(view().state.doc.toString()).toBe('');

    later();
    pressUndo();
    expect(view().state.doc.toString()).toBe('');
    expect(drafts()['c'] ?? '').toBe('');
  });

  it('사람이 친 것은 그 자리 안에서 여전히 되돌릴 수 있다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c" />);
    typeInto('첫');
    later();
    typeInto('첫 둘');
    pressUndo();
    expect(view().state.doc.toString()).not.toBe('첫 둘');
  });
});

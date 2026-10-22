import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { clearEnterTrace, enterTraceSnapshot } from '../src/lib/enterTrace';

/*
  입력창의 Enter 는 **우리가 먼저 받는다**(「Enter 두 번」 10-21~22, 진단 덤프 둘).

  CodeMirror 는 Safari 계열(WKWebView·jsdom — navigator.vendor 가 Apple)에서 「입력기가 확정에 쓴 키」로 보이는 keydown 을
  처리기에 넘기지 않고 버린다(`@codemirror/view` `ignoreDuringComposition`). 버려진 Enter 는 아무도 막지 않아 브라우저가 줄을
  바꾸고, 다음 Enter 가 빈 줄을 단 채 보냈다. 버리는 갈래는 여럿이다:
  - E1: DOM `compositionend` 뒤 100ms 안
  - E2: 조합 중 `beforeinput insertText` 뒤 CodeMirror 가 **DOM 이벤트 없이** 20ms 뒤 조합 끝을 흉내 낸 뒤 100ms 안
    (v0.4.159 덤프: 「친 직후 첫 Enter」 19건·Shift+Enter 10건이 이 꼴로 사라졌다)
  시간 창을 쫓지 않고 Enter·Shift+Enter 를 글 칸 캡처 단계에서 늘 먼저 받는다. 조합이 **정말 진행 중**(`isComposing`)인
  Enter 만 입력기에 넘기고, 확정이 끝난 뒤 한 번 보낸다.
*/

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};
const draft = (scope = '') => useAppStore.getState().drafts[scope] ?? '';
const wait = (ms: number) => act(() => new Promise<void>((r) => { setTimeout(r, ms); }));
const enter = (box: HTMLElement, opts: { shift?: boolean } = {}) =>
  fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: !!opts.shift });

/** E1: 입력기가 DOM compositionend 를 쏜다. */
const domCompositionEnd = (box: HTMLElement, data: string) => {
  fireEvent.compositionStart(box, { data: '' });
  fireEvent.compositionEnd(box, { data });
};
/** E2: 조합 중 insertText 가 오고 compositionend 는 오지 않는다 — CodeMirror 가 20ms 뒤 혼자 흉내 낸다. */
const simulatedCompositionEnd = async (box: HTMLElement, data: string) => {
  fireEvent.compositionStart(box, { data: '' });
  box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true }));
  await wait(40);
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

describe('Enter 는 한 번에 보낸다', () => {
  it('E1 — DOM 조합 끝 바로 뒤 Enter 한 번 = 보냄, 줄바꿈 막힘, 칸 비움', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('지금 이렇게 하면 어때');
    domCompositionEnd(box, '때');
    expect(enter(box)).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe('지금 이렇게 하면 어때');
    expect(draft()).toBe('');
  });

  it('E2 — 흉내 낸 조합 끝 뒤 Enter 한 번 = 보냄(고치기 전 main 에서 빨강: raw 만 남고 안 막힘)', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('데스크톱에서 엔터');
    await simulatedCompositionEnd(box, '터');
    expect(enter(box)).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe('데스크톱에서 엔터');
    expect(enterTraceSnapshot().map((e) => e.kind)).toEqual(['raw', 'key', 'send']);
  });

  it('조합이 진행 중인 Enter 는 입력기에 넘기고, 확정이 끝나면 마지막 음절까지 한 번 보낸다 — 줄바꿈은 막는다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('안녕하세요');
    fireEvent.compositionStart(box, { data: '' });
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    // 입력기가 확정에 이어 줄바꿈을 넣으려 한다 — 막혀야 한다.
    const lineBreak = new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true });
    box.dispatchEvent(lineBreak);
    expect(lineBreak.defaultPrevented).toBe(true);
    fireEvent.compositionEnd(box, { data: '요' });
    await wait(10);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe('안녕하세요');
  });

  it('입력기가 compositionend 를 빠뜨려도 조합 중 Enter 는 결국 한 번 보낸다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('끝');
    fireEvent.compositionStart(box, { data: '' });
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    await wait(400);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('두 번 보내지 않는다 — 처리기는 Enter 하나에 한 번', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('안녕');
    await simulatedCompositionEnd(box, '녕');
    enter(box);
    await wait(400);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(enterTraceSnapshot().filter((e) => e.kind === 'key')).toHaveLength(1);
  });

  it('조합 없는 Enter 는 그대로 보낸다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    enter(typeInto('hello'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('줄바꿈은 줄바꿈으로', () => {
  it('흉내 낸 조합 끝 뒤 Shift+Enter 는 보내지 않고 줄을 바꾼다(고치기 전 main 에서 빨강: 줄이 안 들어감)', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('첫 줄');
    await simulatedCompositionEnd(box, '줄');
    expect(enter(box, { shift: true })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(draft()).toBe('첫 줄\n');
  });

  it('코드 블록 안 Enter 는 줄바꿈이다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('```\nls');
    enter(box);
    expect(onSend).not.toHaveBeenCalled();
    expect(draft()).toBe('```\nls\n');
  });

  it('목록 줄의 Shift+Enter 는 다음 항목을 잇는다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('- 하나');
    enter(box, { shift: true });
    expect(draft()).toBe('- 하나\n- ');
  });
});


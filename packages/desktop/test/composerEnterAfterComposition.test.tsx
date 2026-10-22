import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { clearEnterTrace, enterTraceSnapshot } from '../src/lib/enterTrace';

/*
  「글 끝에서 Enter 를 두 번 쳐야 보내진다」(10-21 jaebin 실물, 진단 덤프 10-22).

  덤프: 마지막 음절 바로 뒤 Enter 가 글 칸에 도착(raw)했는데 입력창 처리기(key)에는 닿지 않았고,
  isComposing·편집기 조합 상태는 둘 다 false 였다. 브라우저 기본 동작으로 줄이 바뀌고, 그 빈 줄에서
  친 두 번째 Enter 가 빈 줄을 단 채 보냈다.

  CodeMirror 가 조합이 **끝난 뒤** 키를 버리는 길은 하나다(`@codemirror/view` `ignoreDuringComposition`):
  Safari 계열(WKWebView 포함)에서 `compositionend` 가 keydown 보다 먼저 오면, 그 뒤 100ms 안의 keydown 을
  「입력기가 확정에 쓴 키」로 보고 버린다. 한글 입력기는 Enter 로 확정하지 않는다 — 확정은 끝났고 그
  Enter 는 보내기다. jsdom 의 navigator.vendor 가 Apple 이라 CodeMirror 는 여기서도 Safari 로 돈다.
*/

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};
const draft = () => useAppStore.getState().drafts[''] ?? '';
const finishComposition = (box: HTMLElement, data: string) => {
  fireEvent.compositionStart(box, { data: '' });
  fireEvent.compositionEnd(box, { data });
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

describe('조합이 끝난 직후의 Enter', () => {
  it('마지막 음절 조합이 끝난 바로 뒤 Enter 한 번이면 보낸다 — 줄바꿈이 남지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('지금 이렇게 하면 어때');
    finishComposition(box, '때');
    const ev = fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13 });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe('지금 이렇게 하면 어때');
    // 기본 동작(줄바꿈)이 막혔다 — 막히지 않으면 브라우저가 빈 줄을 넣는다.
    expect(ev).toBe(false);
    expect(draft()).toBe('');
    // 기록에도 처리기 갈래(key)와 보냄(sent)이 남는다 — 덤프의 「raw 만 있고 key 없음」이 사라진다.
    expect(enterTraceSnapshot().map((e) => e.kind)).toEqual(['raw', 'key', 'send']);
  });

  it('한 번만 보낸다 — 처리기가 두 번 불려 두 번 보내지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('안녕');
    finishComposition(box, '녕');
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(enterTraceSnapshot().filter((e) => e.kind === 'key')).toHaveLength(1);
  });

  it('조합 직후의 Shift+Enter 는 여전히 줄바꿈이다(보내지 않는다)', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('안녕');
    finishComposition(box, '녕');
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('조합이 없을 때의 Enter 는 그대로 보낸다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('hello');
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

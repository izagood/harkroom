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
  보낼 때 **끝의** 빈 줄·공백만 지운다(jaebin 결정, 10-22). 앞과 가운데는 그대로다 — 줄 나눔·들여쓰기는 글의
  모양이고, 끝의 빈 줄은 모양이 아니라 흔적이다(「Enter 두 번」 회귀 때 그대로 나갔다).
*/

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};
const sendWith = (value: string) => {
  const onSend = vi.fn();
  render(<Composer onSend={onSend} />);
  const box = typeInto(value);
  fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', keyCode: 13, metaKey: true });
  return onSend;
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

describe('보낼 때 끝 다듬기', () => {
  it('끝의 빈 줄과 공백은 지운다', () => {
    expect(sendWith('지금 이렇게\n하면 어때\n\n').mock.calls[0]![0]).toBe('지금 이렇게\n하면 어때');
    cleanup();
    expect(sendWith('끝에 공백   \n \t\n').mock.calls[0]![0]).toBe('끝에 공백');
  });

  it('앞·가운데의 빈 줄과 들여쓰기는 그대로 둔다', () => {
    expect(sendWith('  들여쓴 첫 줄\n\n\n가운데 빈 줄 둘 뒤\n    들여쓴 끝 줄\n').mock.calls[0]![0])
      .toBe('  들여쓴 첫 줄\n\n\n가운데 빈 줄 둘 뒤\n    들여쓴 끝 줄');
  });

  it('끝이 코드 블록이면 닫는 펜스 뒤만 지운다 — 블록 안의 들여쓰기·빈 줄은 남는다', () => {
    expect(sendWith('보세요\n```\n  a\n\n  b\n```\n\n').mock.calls[0]![0]).toBe('보세요\n```\n  a\n\n  b\n```');
  });

  it('다듬으면 빈 글이 되는 것은 지금처럼 보내지 않는다(empty)', () => {
    const onSend = sendWith('\n \n\t\n');
    expect(onSend).not.toHaveBeenCalled();
    expect(enterTraceSnapshot().filter((e) => e.kind === 'send').map((e) => e.outcome)).toEqual(['empty']);
  });
});

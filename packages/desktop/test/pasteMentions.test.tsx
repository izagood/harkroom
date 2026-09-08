/**
 * 붙여넣기가 호출이 되는 것을 끊는 두 장치(2단계).
 *
 * 사고의 모양: 팀으로 부른 답변을 복사해 이어 가려 붙여넣자 본문의 `@handle` 이 **다시
 * 호출**로 읽혀 한 스레드에 턴이 연달아 떴다. 그래서 이 파일이 지키는 것은 둘이다 —
 * (1) 붙여넣기가 무엇을 부르는지 **말해 주고**, 한 번 눌러 인용으로 바꿀 수 있다.
 * (2) 셋 이상을 부르는 발화는 **보내기 전에** 확인을 받는다.
 *
 * 그리고 두 장치가 다 **되돌릴 수 있는 지점**에 서 있다는 것이 요점이다: 보내고 나면
 * 턴은 이미 떴고, 그때 남는 수단은 중단(3단계)뿐이다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

/** 붙여넣기 흉내. **기본 동작은 우리가 대신 낸다** — jsdom 은 붙여넣기로 값을 넣지 않는다. */
const paste = (text: string, before = '') => {
  const box = screen.getByRole('textbox');
  fireEvent.paste(box, { clipboardData: { getData: () => text, files: [] } });
  fireEvent.change(box, { target: { value: before + text, selectionStart: (before + text).length } });
  return box;
};

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'murmur', 'agent'),
      a2: acc('a2', 'patch', 'agent'),
      a3: acc('a3', 'docs', 'agent'),
    },
  });
  setController(new Controller(fakeApi()));
});

afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
});

describe('붙여넣기 — 무엇을 부르는지 말해 준다', () => {
  it('부르는 이름이 있으면 제안 줄이 서고, 이름을 그대로 보인다', () => {
    render(<Composer onSend={vi.fn()} />);
    paste('@murmur @patch 확인 부탁');
    const row = screen.getByTestId('pasted-calls');
    expect(row.textContent).toContain('@murmur');
    expect(row.textContent).toContain('@patch');
  });

  it('부를 이름이 없으면 줄을 세우지 않는다 — 평범한 붙여넣기다', () => {
    render(<Composer onSend={vi.fn()} />);
    paste('그냥 문장이다');
    expect(screen.queryByTestId('pasted-calls')).toBeNull();
  });

  it('붙여넣기 자체는 글자를 고치지 않는다 — 인용은 버튼을 눌러야 일어난다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = paste('@murmur 확인');
    expect((box as HTMLTextAreaElement).value).toBe('@murmur 확인');
  });

  it('[인용으로 바꾸기] 는 붙여넣은 조각만 인용으로 만든다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = paste('@murmur 확인', '내 말: ');
    fireEvent.click(screen.getByTestId('pasted-calls-quote'));
    expect((box as HTMLTextAreaElement).value).toBe('내 말: > @murmur 확인');
    expect(screen.queryByTestId('pasted-calls')).toBeNull();
  });

  it('인용으로 바꾼 뒤에는 확인 겹창도 뜨지 않는다 — 부르는 것이 없어졌으므로', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    paste('@murmur @patch @docs 확인');
    fireEvent.click(screen.getByTestId('pasted-calls-quote'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toContain('> @murmur @patch @docs 확인');
  });

  it('[그대로 두기] 를 누르면 줄만 사라진다 — 글자는 그대로다', () => {
    render(<Composer onSend={vi.fn()} />);
    const box = paste('@murmur 확인');
    fireEvent.click(screen.getByTestId('pasted-calls-dismiss'));
    expect(screen.queryByTestId('pasted-calls')).toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe('@murmur 확인');
  });
});

describe('다수 호출 — 보내기 전에 한 번 묻는다', () => {
  it('셋을 부르면 보내지 않고 먼저 묻는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@murmur @patch @docs 확인');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('확인하면 그대로 나간다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@murmur @patch @docs 확인');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('confirm-ok'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe('@murmur @patch @docs 확인');
  });

  it('취소하면 초안이 남는다 — 이름을 지우고 다시 보낼 수 있어야 한다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = typeInto('@murmur @patch @docs 확인');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('@murmur @patch @docs 확인');
  });

  it('둘까지는 묻지 않는다 — 사람이 의도해서 부르는 일이 흔하다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@murmur @patch 확인');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('인용 줄 안의 이름은 세지 않는다 — 서버가 부르지 않는 것을 화면도 세지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('> @murmur @patch @docs 라고 적혀 있었다');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController, type Controller as C } from '../src/state/controller';
import { TypingLine } from '../src/components/TypingLine';
import { Composer } from '../src/components/Composer';
import { fakeApi, acc } from './helpers/fakeApi';

const feed = (c: Controller, e: unknown) =>
  (c as unknown as { handleEvent: (e: unknown) => void }).handleEvent(e);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone'), u3: acc('u3', 'third'), u4: acc('u4', 'fourth') },
    activeChannelId: 'c1',
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('showing who is typing', () => {
  it('shows nothing when nobody is typing', () => {
    render(<TypingLine />);

    expect(screen.queryByTestId('typing-line')).toBeNull();
  });

  it('names one person', () => {
    useAppStore.getState().set({ typing: { c1: ['u2'] } });

    render(<TypingLine />);

    expect(screen.getByTestId('typing-line').textContent).toMatch(/someone/);
  });

  it('names two people', () => {
    useAppStore.getState().set({ typing: { c1: ['u2', 'u3'] } });

    render(<TypingLine />);

    const text = screen.getByTestId('typing-line').textContent!;
    expect(text).toMatch(/someone/);
    expect(text).toMatch(/third/);
  });

  // 이름을 다 늘어놓으면 줄이 길어지고, 그 줄이 늘어나면 메시지 목록이 밀린다.
  it('summarizes when many are typing', () => {
    useAppStore.getState().set({ typing: { c1: ['u2', 'u3', 'u4'] } });

    render(<TypingLine />);

    expect(screen.getByTestId('typing-line').textContent).toMatch(/3/);
  });

  it('only shows the active channel', () => {
    useAppStore.getState().set({ typing: { c2: ['u2'] } });

    render(<TypingLine />);

    expect(screen.queryByTestId('typing-line')).toBeNull();
  });

  it('drops someone the store no longer knows', () => {
    useAppStore.getState().set({ typing: { c1: ['ghost'] } });

    render(<TypingLine />);

    // 이름을 모르는 사람을 '…'로 표시하면 유령이 입력 중인 것처럼 보인다.
    expect(screen.queryByTestId('typing-line')).toBeNull();
  });
});

describe('receiving typing events', () => {
  it('records who is typing in which channel', () => {
    const c = new Controller(fakeApi());

    feed(c, { type: 'typing.changed', channelId: 'c1', accountIds: ['u2'] });

    expect(useAppStore.getState().typing['c1']).toEqual(['u2']);
  });

  // 서버가 상태 전체를 보내므로 클라이언트는 덮어쓰기만 한다 — 더하고 빼는 로직을 두면
  // 두 곳에서 같은 맵을 갱신하게 되고 그 두 곳이 갈라진다.
  it('replaces the channel state rather than merging', () => {
    const c = new Controller(fakeApi());
    feed(c, { type: 'typing.changed', channelId: 'c1', accountIds: ['u2', 'u3'] });

    feed(c, { type: 'typing.changed', channelId: 'c1', accountIds: ['u3'] });

    expect(useAppStore.getState().typing['c1']).toEqual(['u3']);
  });

  it('clears the channel when nobody is left', () => {
    const c = new Controller(fakeApi());
    feed(c, { type: 'typing.changed', channelId: 'c1', accountIds: ['u2'] });

    feed(c, { type: 'typing.changed', channelId: 'c1', accountIds: [] });

    expect(useAppStore.getState().typing['c1'] ?? []).toEqual([]);
  });

  it('leaves other channels alone', () => {
    const c = new Controller(fakeApi());
    feed(c, { type: 'typing.changed', channelId: 'c2', accountIds: ['u2'] });

    feed(c, { type: 'typing.changed', channelId: 'c1', accountIds: ['u3'] });

    expect(useAppStore.getState().typing['c2']).toEqual(['u2']);
  });
});

describe('telling the server I am typing', () => {
  const fakeCtl = () => {
    const c = {
      upload: vi.fn(), fetchAttachment: vi.fn(), saveAttachment: vi.fn(),
      notifyTyping: vi.fn(),
    };
    setController(c as unknown as C);
    return c;
  };

  it('signals when I start typing', () => {
    const c = fakeCtl();
    render(<Composer onSend={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '안', selectionStart: 1 } });

    expect(c.notifyTyping).toHaveBeenCalledWith(true);
  });

  // 글자마다 소켓으로 보내면 한 문장에 수십 번 오간다. 서버의 만료 창(6초)보다 짧게만
  // 갱신하면 충분하다.
  it('does not signal again for every keystroke', () => {
    vi.useFakeTimers();
    const c = fakeCtl();
    render(<Composer onSend={vi.fn()} />);
    const box = screen.getByRole('textbox');

    fireEvent.change(box, { target: { value: '안', selectionStart: 1 } });
    fireEvent.change(box, { target: { value: '안녕', selectionStart: 2 } });
    fireEvent.change(box, { target: { value: '안녕하', selectionStart: 3 } });

    expect(c.notifyTyping).toHaveBeenCalledTimes(1);
  });

  it('signals again after the throttle window', () => {
    vi.useFakeTimers();
    const c = fakeCtl();
    render(<Composer onSend={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '안', selectionStart: 1 } });

    vi.advanceTimersByTime(4000);
    fireEvent.change(box, { target: { value: '안녕', selectionStart: 2 } });

    expect(c.notifyTyping).toHaveBeenCalledTimes(2);
  });

  // 보냈으면 입력이 끝난 것이다. 만료를 기다리면 자기 메시지 아래에 '입력 중'이 남는다.
  it('signals a stop when the message is sent', async () => {
    const c = fakeCtl();
    render(<Composer onSend={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '보낸다', selectionStart: 3 } });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(c.notifyTyping).toHaveBeenCalledWith(false));
  });

  // 입력 중 표시는 없어도 대화가 되는 기능이다. 여기서 실패가 새면 onChange 가 죽고 글을
  // 쓸 수 없게 된다 — 부가 기능이 본 기능을 막는 것은 어떤 경우에도 잘못이다.
  it('keeps letting me type when the typing signal itself fails', () => {
    setController({
      upload: vi.fn(), fetchAttachment: vi.fn(), saveAttachment: vi.fn(),
      notifyTyping: vi.fn(() => { throw new Error('socket gone'); }),
    } as unknown as C);
    render(<Composer onSend={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '계속 쓴다', selectionStart: 5 } });

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('계속 쓴다');
  });

  it('signals a stop when the draft becomes empty', () => {
    const c = fakeCtl();
    render(<Composer onSend={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '안', selectionStart: 1 } });

    fireEvent.change(box, { target: { value: '', selectionStart: 0 } });

    expect(c.notifyTyping).toHaveBeenCalledWith(false);
  });
});

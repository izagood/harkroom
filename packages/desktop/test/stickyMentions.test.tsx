import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Composer } from '../src/components/Composer';
import { acc } from './helpers/fakeApi';

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  // selectionStart 는 jsdom 이 change 로 갱신하지 않는다 — 커서를 끝에 두는 것을 직접 흉내낸다.
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

/** 한 번 쓰고 보낸다. 목록이 열려 있을 수 있으므로 Escape 로 닫고 Enter 를 친다. */
const sendText = (value: string) => {
  const box = typeInto(value);
  fireEvent.keyDown(box, { key: 'Escape' });
  fireEvent.keyDown(box, { key: 'Enter' });
};

const chips = () =>
  screen.queryAllByTestId('sticky-mention').map((el) => el.getAttribute('data-handle'));

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'fizz', 'agent'),
      a2: acc('a2', 'honey', 'agent'),
      a3: acc('a3', 'pollen', 'agent'),
      u2: acc('u2', 'rusalka'),
    },
  });
});
afterEach(() => cleanup());

describe('sticky mentions', () => {
  // 한 번 부른 상대와는 대화가 이어진다. 매번 @를 다시 치게 하면 사용자는 잊어버리고,
  // 잊으면 에이전트는 깨어나지 않는다.
  it('keeps a handle mentioned once as a chip', () => {
    render(<Composer onSend={vi.fn()} />);

    sendText('@fizz avcs 가 어떤 프로젝트인지 확인해봐');

    expect(chips()).toEqual(['fizz']);
  });

  it('prefixes the sticky mention onto the next message', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');

    sendText('너가 작업하는 내용도 내가 볼 수 있어?');

    expect(onSend).toHaveBeenLastCalledWith('@fizz 너가 작업하는 내용도 내가 볼 수 있어?');
  });

  // 여러 명을 불러도 전부 유지된다 — 한 명만 남기면 나머지는 조용히 대화에서 빠진다.
  it('keeps every handle when several are mentioned', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    sendText('@fizz @honey @pollen 너네도');
    sendText('다음 질문');

    expect(chips()).toEqual(['fizz', 'honey', 'pollen']);
    expect(onSend).toHaveBeenLastCalledWith('@fizz @honey @pollen 다음 질문');
  });

  // 고정된 상대를 손으로 또 부르면 본문에 두 번 나온다. 알림이 두 번 가지는 않지만
  // 읽는 사람에게는 잡음이다.
  it('does not repeat a mention that the body already carries', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');

    sendText('@fizz 다시');

    expect(onSend).toHaveBeenLastCalledWith('@fizz 다시');
  });

  // 새로 부른 사람은 뒤에 붙되, 이미 고정된 사람의 순서는 흔들리지 않는다.
  it('adds a newly mentioned handle to the ones already kept', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');

    sendText('@honey 너도 봐');
    sendText('셋째 줄');

    expect(chips()).toEqual(['fizz', 'honey']);
    expect(onSend).toHaveBeenLastCalledWith('@fizz @honey 셋째 줄');
  });

  it('stops prefixing a handle whose chip is removed', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz @honey 둘 다');

    fireEvent.click(screen.getByRole('button', { name: 'Remove @fizz' }));
    sendText('honey 에게만');

    expect(chips()).toEqual(['honey']);
    expect(onSend).toHaveBeenLastCalledWith('@honey honey 에게만');
  });

  // 채널을 옮기면 상대도 바뀐다. 앞 채널에서 부르던 에이전트를 다른 채널에 끌고 가면
  // 엉뚱한 곳에서 깨어난다.
  it('keeps the set per conversation', () => {
    const { rerender } = render(<Composer scopeKey="c1" onSend={vi.fn()} />);
    sendText('@fizz 확인해봐');

    rerender(<Composer scopeKey="c2" onSend={vi.fn()} />);
    expect(chips()).toEqual([]);

    rerender(<Composer scopeKey="c1" onSend={vi.fn()} />);
    expect(chips()).toEqual(['fizz']);
  });

  // 고정 멘션만으로는 보낼 것이 없다 — 빈 Enter 가 '@fizz' 만 던지면 사고다.
  it('does not send when nothing but the sticky mentions would go out', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');
    onSend.mockClear();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });

  // 실패하면 사용자가 친 글만 돌아와야 한다. 접두사까지 초안에 남기면 다음 전송에서
  // 멘션이 두 번 붙는다.
  it('puts back only what the user typed when sending fails', async () => {
    const onSend = vi.fn(async (body: string) => {
      if (body.startsWith('@fizz 두 번째')) throw new Error('offline');
    });
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');

    sendText('두 번째');

    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('두 번째'));
  });

  // 계정이 사라지면 고정도 사라져야 한다 — 없는 handle 을 붙이면 그냥 텍스트가 된다.
  it('forgets a handle that is no longer a known account', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');

    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'rusalka') },
    });
    sendText('그 다음');

    expect(chips()).toEqual([]);
    expect(onSend).toHaveBeenLastCalledWith('그 다음');
  });
});

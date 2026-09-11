import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Composer } from '../src/components/Composer';
import { acc } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  // selectionStart 는 jsdom 이 change 로 갱신하지 않는다 — 커서를 끝에 두는 것을 직접 흉내낸다.
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

/**
 * 한 번 쓰고 보낸다. 목록이 열려 있을 수 있으므로 Escape 로 닫고 Enter 를 친다.
 *
 * **셋 이상을 부르면 확인 겹창이 선다**(2단계, `pasteCalls.ts::MANY_CALLS`) — 이 파일이
 * 재는 것은 고정 멘션이므로 그 문은 통과시켜 준다. 겹창 자체는 `pasteMentions.test.tsx`
 * 가 단독으로 지킨다(보냄 취소 창을 여기서 끄는 것과 같은 규율이다).
 */
const sendText = (value: string) => {
  const box = typeInto(value);
  fireEvent.keyDown(box, { key: 'Escape' });
  fireEvent.keyDown(box, { key: 'Enter' });
  const confirm = screen.queryByTestId('confirm-ok') ?? screen.queryByText('Send');
  if (confirm) fireEvent.click(confirm);
};

const chips = () =>
  screen.queryAllByTestId('sticky-mention').map((el) => el.getAttribute('data-handle'));

beforeEach(() => {
  // 이 파일이 검증하는 것은 보냄 취소 창이 아니다(#223) — 창을 끄고 즉시 전송 경로를 본다.
  // 창 자체는 undoSend.test.tsx 가 단독으로 지킨다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  // 고정은 이제 기기 로컬에 남는다(#706) — 앞 시험이 적어 둔 것이 다음 시험의 사실이 되면
  // 어느 것이 무엇을 재는지 알 수 없다.
  localStorage.clear();
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

    expect(onSend).toHaveBeenLastCalledWith('@fizz 너가 작업하는 내용도 내가 볼 수 있어?', []);
  });

  // 여러 명을 불러도 전부 유지된다 — 한 명만 남기면 나머지는 조용히 대화에서 빠진다.
  it('keeps every handle when several are mentioned', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    sendText('@fizz @honey @pollen 너네도');
    sendText('다음 질문');

    expect(chips()).toEqual(['fizz', 'honey', 'pollen']);
    expect(onSend).toHaveBeenLastCalledWith('@fizz @honey @pollen 다음 질문', []);
  });

  // 고정된 상대를 손으로 또 부르면 본문에 두 번 나온다. 알림이 두 번 가지는 않지만
  // 읽는 사람에게는 잡음이다.
  it('does not repeat a mention that the body already carries', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');

    sendText('@fizz 다시');

    expect(onSend).toHaveBeenLastCalledWith('@fizz 다시', []);
  });

  // 새로 부른 사람은 뒤에 붙되, 이미 고정된 사람의 순서는 흔들리지 않는다.
  it('adds a newly mentioned handle to the ones already kept', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz 확인해봐');

    sendText('@honey 너도 봐');
    sendText('셋째 줄');

    expect(chips()).toEqual(['fizz', 'honey']);
    expect(onSend).toHaveBeenLastCalledWith('@fizz @honey 셋째 줄', []);
  });

  it('stops prefixing a handle whose chip is removed', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    sendText('@fizz @honey 둘 다');

    fireEvent.click(screen.getByRole('button', { name: 'Remove @fizz' }));
    sendText('honey 에게만');

    expect(chips()).toEqual(['honey']);
    expect(onSend).toHaveBeenLastCalledWith('@honey honey 에게만', []);
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
    expect(onSend).toHaveBeenLastCalledWith('그 다음', []);
  });
});

describe('adding a mention without sending', () => {
  const openPicker = () => fireEvent.click(screen.getByRole('button', { name: 'Add mention' }));

  // 첫 줄을 보내기 전에도 상대를 정해 둘 수 있어야 한다. 지금은 한 번 불러 봐야만
  // 고정되므로, 부를 상대를 아직 안 쓴 사용자는 @ 를 손으로 쳐야 한다.
  it('keeps a handle chosen from the button, without touching the draft', () => {
    render(<Composer onSend={vi.fn()} />);

    openPicker();
    fireEvent.click(screen.getByRole('option', { name: /fizz/ }));

    expect(chips()).toEqual(['fizz']);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('prefixes a mention added that way onto the next message', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: /fizz/ }));

    sendText('첫 줄');

    expect(onSend).toHaveBeenLastCalledWith('@fizz 첫 줄', []);
  });

  // 이미 고정된 상대를 또 고를 이유가 없다. 목록에 남겨 두면 두 번 고른 사용자가
  // 무엇이 달라졌는지 알 수 없다.
  it('leaves out handles that are already kept', () => {
    render(<Composer onSend={vi.fn()} />);
    sendText('@fizz 확인해봐');

    openPicker();

    expect(screen.queryByRole('option', { name: /fizz/ })).toBeNull();
    expect(screen.getByRole('option', { name: /honey/ })).toBeTruthy();
  });

  it('does not offer the author themselves', () => {
    render(<Composer onSend={vi.fn()} />);

    openPicker();

    expect(screen.queryByRole('option', { name: /me/ })).toBeNull();
  });

  it('closes after a choice so the next Enter sends', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: /fizz/ }));

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    typeInto('보낸다');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('@fizz 보낸다', []);
  });

  it('closes on Escape', () => {
    render(<Composer onSend={vi.fn()} />);
    openPicker();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('closes when the button is pressed again', () => {
    render(<Composer onSend={vi.fn()} />);
    openPicker();

    openPicker();

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});


/**
 * 화면을 떠났다 돌아오는 것 — **이 파일이 처음부터 재야 했던 것**이다(#706).
 *
 * 고정이 컴포저의 지역 state 였을 때 위의 시험들은 모두 초록이었다. 하나의 컴포저 인스턴스
 * 안에서만 재고 있었기 때문이다(`rerender` 는 언마운트가 아니다). 실제 앱에서 스레드
 * 패널은 조건부 렌더라(`Workspace.tsx` 의 `{threadRootId && <ThreadPanel/>}`) 다른 채널을
 * 한 번 누르면 통째로 언마운트되고, 그때 고정이 사라졌다 — 초안은 스토어에 남아 돌아오므로
 * 사람은 글은 그대로인데 칩만 없는 입력창을 보고, 그 상태로 Enter 를 눌러 아무도 깨우지
 * 못했다.
 */
describe('sticky mentions survive leaving the view', () => {
  const STORE_KEY = 'harkroom.stickyMentions';

  // 스레드 패널이 빠지는 것을 흉내내는 유일한 방법은 **언마운트**다.
  it('keeps the chips when the composer unmounts and comes back', () => {
    const onSend = vi.fn();
    const first = render(<Composer onSend={onSend} scopeKey="thread:t1" />);
    sendText('@fizz 확인해봐');
    expect(chips()).toEqual(['fizz']);

    first.unmount();
    render(<Composer onSend={onSend} scopeKey="thread:t1" />);

    expect(chips()).toEqual(['fizz']);
    sendText('돌아와서 한 줄');
    expect(onSend).toHaveBeenLastCalledWith('@fizz 돌아와서 한 줄', []);
  });

  // 다른 자리의 고정을 끌고 오지 않는다 — 언마운트 뒤 다른 스레드로 돌아오는 경우.
  it('does not carry a kept handle into another scope', () => {
    const first = render(<Composer onSend={vi.fn()} scopeKey="thread:t1" />);
    sendText('@fizz 확인해봐');
    first.unmount();

    render(<Composer onSend={vi.fn()} scopeKey="thread:t2" />);

    expect(chips()).toEqual([]);
  });

  it('writes the kept handles to device storage', () => {
    render(<Composer onSend={vi.fn()} scopeKey="thread:t1" />);

    sendText('@fizz @honey 둘 다');

    expect(JSON.parse(localStorage.getItem(STORE_KEY)!)).toEqual({ 'thread:t1': ['fizz', 'honey'] });
  });

  // 칩을 떼면 보관소에서도 없어져야 한다 — 남으면 다음 기동에 되살아난다.
  it('drops a removed handle from storage too', () => {
    render(<Composer onSend={vi.fn()} scopeKey="thread:t1" />);
    sendText('@fizz 확인해봐');

    fireEvent.click(screen.getByRole('button', { name: 'Remove @fizz' }));

    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });

  // 보관소 읽기는 **앱 기동 시점**이다(`controller.start` 가 부른다) — 컴포저가 보관소를
  // 직접 뒤지지 않는다. `drafts.test.tsx` 의 재시작 시험과 같은 규약이다.
  it('restores the chips after a restart', () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ 'thread:t1': ['fizz'] }));
    useAppStore.getState().hydrateStickyMentions();

    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="thread:t1" />);

    expect(chips()).toEqual(['fizz']);
    sendText('재시작 후 한 줄');
    expect(onSend).toHaveBeenLastCalledWith('@fizz 재시작 후 한 줄', []);
  });

  // 초안과 같은 수명이다 — 로그아웃이 초안을 지우는 자리에서 고정도 지운다.
  it('is wiped on logout, in memory and in storage', () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ 'thread:t1': ['fizz'], c2: ['honey'] }));
    useAppStore.getState().hydrateStickyMentions();
    expect(Object.keys(useAppStore.getState().stickyMentions)).toHaveLength(2);

    useAppStore.getState().clearStickyMentions();

    expect(Object.keys(useAppStore.getState().stickyMentions)).toHaveLength(0);
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });
});

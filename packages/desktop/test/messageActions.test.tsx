import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { Notice } from '../src/components/Notice';
import { acc, chan, msg, pin } from './helpers/fakeApi';

// #179 — 메시지 오버플로 메뉴에 붙은 동작들의 회귀 테스트.
//
// 이 파일이 지키는 것은 두 가지다. 하나는 **본문 복사에 권한 게이트가 없다**는 것 —
// Edit·Delete 와 같은 조건을 따라가는 순간, 남의 메시지 앞에서 메뉴가 통째로 비어
// 읽을 수 있는 사람이 옮겨 적을 길을 잃는다. 다른 하나는 **"여기부터 안 읽음"이 그
// 메시지의 seq 를 보낸다**는 것 — 다음 메시지의 seq 를 보내면 사람이 표시한 그 메시지가
// 읽은 것으로 남아, 돌아왔을 때 정작 그것이 안 보인다.

const fakeController = () => {
  const c = {
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    pinMessage: vi.fn(async () => undefined),
    unpinMessage: vi.fn(async () => undefined),
    markChannelUnread: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

const setClipboard = (writeText: (text: string) => Promise<void>): void => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
};

const openMenu = (): void => { fireEvent.click(screen.getByLabelText('More actions')); };

// 남이 쓴 메시지가 기본이다 — 복사도 안읽음도 남의 발화 앞에서 쓸모가 있어야 한다.
const theirs = msg('m9', 'c1', 5, 'hey @me, the decision stands', 'u2');
const mine = msg('m8', 'c1', 4, 'what I said myself', 'u1');

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
    messages: { c1: [mine, theirs] },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('Copy text', () => {
  it('puts the original body on the clipboard', async () => {
    fakeController();
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    render(<MessageItem message={theirs} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }));

    // 렌더된 형태가 아니라 원문이다 — 멘션 표기가 그대로 살아 있어야 다시 붙여넣을 수 있다.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hey @me, the decision stands'));
  });

  // 권한 게이트가 붙는 순간, 남의 메시지 앞에서는 옮겨 적을 길이 사라진다.
  it("offers the copy on someone else's message, with no permission gate", () => {
    fakeController();
    render(<MessageItem message={theirs} />);

    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Copy text' })).toBeTruthy();
    // 같은 메뉴에 Edit 이 없다는 것이 게이트가 없다는 사실의 대조군이다 —
    // Edit 이 걸러진 자리에서도 복사는 남아 있어야 한다.
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  });

  // 삼키면 사람은 붙여넣기를 시도하고 나서야 안 됐다는 것을 안다.
  it('shows the person the failure when the clipboard write fails', async () => {
    fakeController();
    setClipboard(async () => { throw new Error('denied'); });
    render(<><MessageItem message={theirs} /><Notice /></>);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not copy/i);
  });

  it('shows the failure when the environment has no clipboard at all', async () => {
    fakeController();
    render(<><MessageItem message={theirs} /><Notice /></>);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not copy/i);
  });
});

describe('Mark unread from here', () => {
  // 보내는 것은 **그 메시지의** seq 다. 다음 메시지의 seq 를 보내면 사람이 표시한 메시지가
  // 읽은 것으로 남아, 돌아왔을 때 정작 그것이 안 보인다.
  it('sends the seq of the message the person marked', () => {
    const c = fakeController();
    render(<MessageItem message={theirs} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark unread from here' }));

    expect(c.markChannelUnread).toHaveBeenCalledWith('c1', 5);
  });

  // 내 발화는 애초에 미읽음으로 세지 않는다(`readPositions.ts` 의 `author_id <> $1`).
  // 눌러도 숫자가 그대로인 항목은 거짓 신호다.
  it('is absent on my own message', () => {
    fakeController();
    render(<MessageItem message={mine} />);

    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Mark unread from here' })).toBeNull();
    // 메뉴 자체는 열렸다 — 항목이 안 보이는 이유가 메뉴가 안 떠서가 아님을 못 박는다.
    expect(screen.getByRole('menuitem', { name: 'Copy text' })).toBeTruthy();
  });
});

// 새 항목이 늘어난 뒤에도 원래 있던 것들이 같은 자리에서 같은 일을 하는가.
describe('the actions that were already there', () => {
  it('still edits and deletes my own message', () => {
    const c = fakeController();
    render(<MessageItem message={mine} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    // Edit 은 컨트롤러를 부르지 않고 초안을 연다 — 열린 textarea 가 본문을 담고 있어야 한다.
    expect(screen.getByRole('textbox').getAttribute('value') ?? (screen.getByRole('textbox') as HTMLTextAreaElement).value)
      .toBe('what I said myself');

    cleanup();
    render(<MessageItem message={mine} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    // 확인은 메뉴 밖이다 — 누르는 순간 메뉴가 닫히면서 확인 단계가 사라지지 않도록.
    fireEvent.click(screen.getByRole('button', { name: 'Really delete' }));
    expect(c.deleteMessage).toHaveBeenCalledWith('m8');
  });

  it('still pins and unpins (#218)', () => {
    const c = fakeController();
    render(<MessageItem message={theirs} />);

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
    expect(c.pinMessage).toHaveBeenCalledWith('c1', 'm9');

    cleanup();
    useAppStore.getState().set({ pins: { c1: [pin('m9', 'c1', 'u1', theirs)] } });
    render(<MessageItem message={theirs} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }));
    expect(c.unpinMessage).toHaveBeenCalledWith('c1', 'm9');
  });
});

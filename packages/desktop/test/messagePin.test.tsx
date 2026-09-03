import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { MessageItem } from '../src/components/MessageItem';
import { acc, chan, msg, pin, scheduledApiStub } from './helpers/fakeApi';

// 메시지 고정(#218)의 화면 쪽. 고정 목록이 실제로 도달 가능한가(접힘 → 펼침 → 그 메시지로
// 이동), 그리고 ⋯ 메뉴가 서버의 권한과 같은 것을 내주는가를 지킨다.

const fakeController = () => {
  const c = {
    send: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    openMessage: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => undefined),
    pinMessage: vi.fn(async () => undefined),
    unpinMessage: vi.fn(async () => undefined),
    // #222: 컴포저가 예약 목록을 읽는다 — 목에 이 표면이 없으면 화면이 뜨지 않는다.
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

const pinned = msg('m1', 'c1', 1, 'the decision we keep', 'u2');

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
    messages: { c1: [pinned] },
  });
});
afterEach(() => cleanup());

describe('pinned messages', () => {
  it('lists the pins and jumps to the message when one is clicked', () => {
    const c = fakeController();
    useAppStore.getState().set({ pins: { c1: [pin('m1', 'c1', 'u1', pinned)] } });
    render(<ChannelPane />);

    // 기본은 접힌 상태다 — 몇 개인지만 보이고 목록 자체는 아직 없다. 본문 문자열로 묻지
    // 않는 이유: 같은 문장이 아래 대화에도 그려져 있어 접힘 여부와 무관하게 잡힌다.
    const toggle = screen.getByRole('button', { name: /1 pinned/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /the decision we keep/ })).toBeNull();

    fireEvent.click(toggle);

    const entry = screen.getByRole('button', { name: /the decision we keep/ });
    expect(within(entry).getByText('someone')).toBeTruthy();

    fireEvent.click(entry);
    expect(c.openMessage).toHaveBeenCalledWith('m1');
  });

  // 고정은 글을 쓸 수 있는 사람 누구나 — 남의 메시지도 고정한다. 해제는 고정한 사람 또는 admin.
  it('offers Pin to anyone, and Unpin only to the person who pinned it', () => {
    const c = fakeController();
    render(<MessageItem message={pinned} />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
    expect(c.pinMessage).toHaveBeenCalledWith('c1', 'm1');

    // 내가 고정한 것이면 해제가 보이고, 이미 고정됐으니 고정은 사라진다.
    cleanup();
    useAppStore.getState().set({ pins: { c1: [pin('m1', 'c1', 'u1', pinned)] } });
    render(<MessageItem message={pinned} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Pin' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }));
    expect(c.unpinMessage).toHaveBeenCalledWith('c1', 'm1');
  });

  // 남이 올린 핀을 아무나 내리면 핀이 신호가 못 된다 — 화면도 서버와 같은 선을 그어야 한다.
  it("hides Unpin from a non-admin looking at someone else's pin", () => {
    fakeController();
    useAppStore.getState().set({ pins: { c1: [pin('m1', 'c1', 'u2', pinned)] } });
    render(<MessageItem message={pinned} />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Unpin' })).toBeNull();

    // admin 에게는 열린다 — 서버가 열어 둔 조정 수단이 도달 불가가 되면 안 된다.
    cleanup();
    useAppStore.getState().set({ me: { ...acc('u1', 'me'), isAdmin: true } });
    render(<MessageItem message={pinned} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Unpin' })).toBeTruthy();
  });
});

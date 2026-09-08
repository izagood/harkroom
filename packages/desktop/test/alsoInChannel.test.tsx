import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { MessageItem } from '../src/components/MessageItem';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

// #231: 스레드 답을 채널에도 함께 올린다. **메시지는 하나**이고 두 곳에 보인다 —
// 그래서 이 파일의 회귀선은 "같은 id 가 두 화면에 각각 뜨는가"를 본다.
const fakeController = () => {
  const c = {
    send: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    openThread: vi.fn(),
    closeThread: vi.fn(),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => undefined),
    // #222: 컴포저가 예약 목록을 읽는다 — 목에 이 표면이 없으면 화면이 뜨지 않는다.
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

const seed = (alsoInChannel: boolean) => {
  // 되돌리기 창(#223)을 0 으로 둔다 — 여기서 보려는 것은 전달되는 인자이지 그 창이 아니다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general', 'main-repo')],
    activeChannelId: 'c1',
    threadRootId: 'm1',
    messages: {
      c1: [
        msg('m1', 'c1', 1, 'root message', 'u1'),
        msg('m2', 'c1', 2, 'thread answer', 'u2', { threadRootId: 'm1', alsoInChannel }),
      ],
    },
  });
};

afterEach(() => {
  cleanup();
});

describe('#231 스레드 답을 채널에도 함께 올린다', () => {
  beforeEach(() => {
    seed(true);
  });

  it('alsoInChannel 이면 채널 뷰에도 뜬다', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.getByText('thread answer')).toBeTruthy();
  });

  it('채널에도 올렸어도 스레드 뷰에서 사라지지 않는다', () => {
    fakeController();
    render(<ThreadPanel />);
    expect(screen.getByText('root message')).toBeTruthy();
    expect(screen.getByText('thread answer')).toBeTruthy();
  });

  it('alsoInChannel 이 아니면 채널 뷰에 없다', () => {
    seed(false);
    fakeController();
    render(<ChannelPane />);
    expect(screen.queryByText('thread answer')).toBeNull();
  });

  // 채널에 그냥 뜨면 앞뒤 없는 말이 된다 — 원래 스레드로 가는 길이 그 자리에 있어야 한다.
  it('채널 뷰의 그 메시지에서 원래 스레드로 갈 수 있다', () => {
    const c = fakeController();
    render(<ChannelPane />);
    fireEvent.click(screen.getByRole('button', { name: 'View in thread' }));
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });

  // 스레드 뷰의 답에는 그 길이 필요 없다 — 이미 그 스레드 안이다.
  it('스레드 뷰에서는 스레드로 가는 표시를 그리지 않는다', () => {
    fakeController();
    render(<ThreadPanel />);
    expect(screen.queryByRole('button', { name: 'View in thread' })).toBeNull();
  });

  it('스레드 답 작성기에서 채널에도 올리기를 켜면 그대로 전달된다', () => {
    const c = fakeController();
    render(<ThreadPanel />);
    fireEvent.click(screen.getByLabelText('채널에도 올리기'));
    const box = screen.getByPlaceholderText('Reply…') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'on it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(c.reply).toHaveBeenCalledWith('on it', [], 'c1', 'm1', true);
  });
});


// #231 되돌리기 — 스레드에서 하던 이야기를 채널로 잘못 흘렸을 때 **채널에서만** 거둔다.
//
// 이 블록이 지키는 것은 항목이 뜨는 조건이다. 이미 거둔 메시지·채널 메시지·남의 메시지에
// 항목이 남아 있으면, 눌러도 아무 일이 없거나 서버가 403 으로 돌려보낸다 — 둘 다
// 화면이 없는 것을 있다고 말한 것이다.
describe('#231 채널에서 거두기', () => {
  const openMenu = (): void => { fireEvent.click(screen.getByLabelText('More actions')); };
  const recallItem = () => screen.queryByRole('menuitem', { name: 'Remove from channel' });

  const controllerWithRecall = () => {
    const c = { ...fakeController(), recallFromChannel: vi.fn(async () => undefined) };
    setController(c as unknown as Controller);
    return c;
  };

  const mineInChannel = msg('m2', 'c1', 2, 'thread answer', 'u1', { threadRootId: 'm1', alsoInChannel: true });

  beforeEach(() => { seed(true); });

  it('채널에도 올린 내 답에서 거둘 수 있다', () => {
    const c = controllerWithRecall();
    render(<MessageItem message={mineInChannel} />);

    openMenu();
    fireEvent.click(recallItem()!);
    expect(c.recallFromChannel).toHaveBeenCalledWith('m2');
  });

  it('이미 거둔 답에는 항목이 없다', () => {
    controllerWithRecall();
    render(<MessageItem message={{ ...mineInChannel, alsoInChannel: false }} />);
    openMenu();
    expect(recallItem()).toBeNull();
  });

  // 스레드 답이 아니면 거둘 채널 사본 자체가 없다 — 그 메시지가 곧 채널 메시지다.
  it('그냥 채널 메시지에는 항목이 없다', () => {
    controllerWithRecall();
    render(<MessageItem message={msg('m3', 'c1', 3, 'plain', 'u1')} />);
    openMenu();
    expect(recallItem()).toBeNull();
  });

  it('남의 답은 admin 이 아니면 거둘 수 없다', () => {
    controllerWithRecall();
    render(<MessageItem message={{ ...mineInChannel, authorId: 'u2' }} />);
    openMenu();
    expect(recallItem()).toBeNull();
  });

  // 삭제와 같은 권한이다 — 지울 수 있는 사람이 그보다 약한 일을 못 하면
  // 화면이 admin 에게 더 거친 쪽을 권하게 된다.
  it('admin 은 남의 답도 거둘 수 있다', () => {
    seed(true);
    useAppStore.getState().set({ me: { ...acc('u1', 'admin'), isAdmin: true } });
    controllerWithRecall();
    render(<MessageItem message={{ ...mineInChannel, authorId: 'u2' }} />);
    openMenu();
    expect(recallItem()).toBeTruthy();
  });
});

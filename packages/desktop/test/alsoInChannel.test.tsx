import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { MessageItem } from '../src/components/MessageItem';
import { acc, chan, msg, scheduledApiStub, fakeApi, fakeWsFactory } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { en } from '../src/i18n/en';

// 문구는 **사전에서 읽는다** — 여기 영문을 다시 적으면 사전과 화면이 갈릴 때
// 이 파일이 조용히 옛 문구를 지킨다. jsdom 은 영어라 영어 사전이 뜬다.
const RECENT_REPLIES = en['message.recentReplies'];
const CHANNEL_ECHO = en['message.channelEcho'];

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
    fireEvent.click(screen.getByTestId('thread-origin-link'));
    // 출처 줄은 스레드 **머리**로 간다 — "무슨 얘기였나"에 답하는 링크다.
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });

  // 스레드 뷰의 답에는 그 길이 필요 없다 — 이미 그 스레드 안이다.
  it('스레드 뷰에서는 스레드로 가는 표시를 그리지 않는다', () => {
    fakeController();
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-origin-link')).toBeNull();
    expect(screen.queryByRole('button', { name: RECENT_REPLIES })).toBeNull();
  });

  /**
   * #624 요구 1 — 스레드 안에서 **이 말이 채널에도 나갔다**는 사실이 보인다.
   * 안 보이면 같은 스레드를 읽는 사람이 "우리끼리 한 말"로 알고 다음 말을 고른다.
   */
  it('스레드 뷰의 답에는 채널에도 전송됐다는 표시가 붙는다', () => {
    fakeController();
    render(<ThreadPanel />);
    expect(screen.getByTestId('channel-echo-mark').textContent).toContain(CHANNEL_ECHO);
  });

  it('채널에 안 올린 답에는 그 표시가 없다', () => {
    seed(false);
    fakeController();
    render(<ThreadPanel />);
    expect(screen.queryByTestId('channel-echo-mark')).toBeNull();
  });

  /** 채널 쪽 사본에는 달지 않는다 — 거기서 필요한 사실은 반대(어디서 왔는가)다. */
  it('채널 뷰에는 채널에도 전송됨 표시를 달지 않는다', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.queryByTestId('channel-echo-mark')).toBeNull();
  });

  /**
   * #624 요구 2 — 출처 줄은 **어느 메시지의 스레드**에서 왔는지를 말한다. 뿌리 본문을
   * 싣지 않으면 스레드가 열 개 있는 채널에서 "어떤 스레드"인지 눌러 보기 전엔 모른다.
   */
  it('채널 뷰의 출처 줄이 뿌리 메시지 본문을 싣는다', () => {
    fakeController();
    render(<ChannelPane />);
    expect(screen.getByTestId('thread-origin-link').textContent).toContain('root message');
  });

  /**
   * 뿌리가 아직 안 불러와졌을 수도 있다(뿌리가 지금 페이지보다 오래됐다). 그때도
   * **링크는 남는다** — 미리보기는 편의지만 스레드로 가는 길은 이 사본의 앞뒤다.
   */
  it('뿌리를 아직 모를 때도 출처 줄은 남는다', () => {
    seed(true);
    useAppStore.getState().set({
      messages: { c1: [msg('m2', 'c1', 2, 'thread answer', 'u2', { threadRootId: 'm1', alsoInChannel: true })] },
    });
    const c = fakeController();
    render(<ChannelPane />);
    fireEvent.click(screen.getByTestId('thread-origin-link'));
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });

  /**
   * #624 요구 3 — 하단 링크는 스레드 머리가 아니라 **이 메시지 자리**로 간다.
   * 이 링크가 답하는 질문은 "이 말 뒤에 무슨 말이 더 있었나"이고, 뿌리로 보내면
   * 답글이 백 개 달린 스레드에서 방금 본 그 말을 다시 찾아야 한다.
   */
  it('최근 댓글 보기는 그 메시지 자리로 간다', () => {
    const c = fakeController();
    render(<ChannelPane />);
    fireEvent.click(screen.getByRole('button', { name: RECENT_REPLIES }));
    expect(c.openThread).toHaveBeenCalledWith('m1', 'm2');
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

/**
 * 컨트롤러 쪽 계약(#624 요구 3). 화면이 `openThread(root, id)` 를 부르는 것만 잰다면,
 * 두 번째 인자를 컨트롤러가 **버려도** 회귀선이 초록으로 남는다 — 그러면 링크는
 * 눌리는데 스레드는 뿌리에서 열린다.
 */
describe('#624 스레드를 특정 답글 자리에서 연다', () => {
  const mount = () => {
    const api = fakeApi({
      messages: vi.fn(async () => ({
        messages: [
          msg('m1', 'c1', 1, 'root message', 'u1'),
          msg('m2', 'c1', 2, 'thread answer', 'u2', { threadRootId: 'm1', alsoInChannel: true }),
        ],
        hasMore: false,
      })),
    });
    const c = new Controller(api, fakeWsFactory().makeWs);
    setController(c);
    useAppStore.getState().reset();
    useAppStore.getState().set({ activeChannelId: 'c1' });
    return c;
  };

  it('겨냥한 답글에 강조가 걸린다 — 화면이 그 자리로 스크롤하는 수단이다', async () => {
    const c = mount();
    await c.openThread('m1', 'm2');
    expect(useAppStore.getState().threadRootId).toBe('m1');
    expect(useAppStore.getState().highlightedMessageId).toBe('m2');
  });

  it('겨냥하지 않으면 강조를 건드리지 않는다 — 뿌리부터 읽는 평소의 열기다', async () => {
    const c = mount();
    await c.openThread('m1');
    expect(useAppStore.getState().threadRootId).toBe('m1');
    expect(useAppStore.getState().highlightedMessageId).toBeNull();
  });
});

/**
 * #231 의 반대 방향 — 스레드에 이미 올라간 답을 **나중에** 채널로도 올린다.
 *
 * 거두기 블록의 거울이다: 지키는 것은 항목이 뜨는 조건이다. 이미 채널에 있는 답·채널
 * 메시지·남의 답·보관된 채널에 항목이 남아 있으면 눌러도 아무 일이 없거나 서버가 403·400
 * 으로 돌려보낸다 — 둘 다 화면이 없는 것을 있다고 말한 것이다(design.md §4).
 */
describe('#231 나중에 채널로 보내기', () => {
  const openMenu = (): void => { fireEvent.click(screen.getByLabelText('More actions')); };
  const shareItem = () => screen.queryByRole('menuitem', { name: 'Send to channel' });

  const controllerWithShare = () => {
    const c = { ...fakeController(), shareToChannel: vi.fn(async () => undefined) };
    setController(c as unknown as Controller);
    return c;
  };

  // 채널에는 아직 안 보이는 내 스레드 답 — 이 기능의 대상이다.
  const mineQuiet = msg('m2', 'c1', 2, 'thread answer', 'u1', { threadRootId: 'm1', alsoInChannel: false });

  beforeEach(() => { seed(false); });

  it('채널에 안 보이는 내 답을 나중에 올릴 수 있다', () => {
    const c = controllerWithShare();
    render(<MessageItem message={mineQuiet} />);

    openMenu();
    fireEvent.click(shareItem()!);
    expect(c.shareToChannel).toHaveBeenCalledWith('m2');
  });

  it('이미 채널에 올라간 답에는 항목이 없다', () => {
    controllerWithShare();
    render(<MessageItem message={{ ...mineQuiet, alsoInChannel: true }} />);
    openMenu();
    expect(shareItem()).toBeNull();
  });

  // 채널 메시지는 이미 채널에 있다 — 켤 것이 없다(서버도 400 이다).
  it('그냥 채널 메시지에는 항목이 없다', () => {
    controllerWithShare();
    render(<MessageItem message={msg('m3', 'c1', 3, 'plain', 'u1')} />);
    openMenu();
    expect(shareItem()).toBeNull();
  });

  // 거두기와 달리 admin 에게도 열지 않는다: 남의 말을 더 넓은 자리로 내보내는 것은
  // 조정이 아니라 발화다. 서버도 작성자만 받는다.
  it('남의 답은 admin 이라도 올릴 수 없다', () => {
    seed(false);
    useAppStore.getState().set({ me: { ...acc('u1', 'admin'), isAdmin: true } });
    controllerWithShare();
    render(<MessageItem message={{ ...mineQuiet, authorId: 'u2' }} />);
    openMenu();
    expect(shareItem()).toBeNull();
  });

  // 보관된 채널은 읽기 전용이라 서버가 거절한다 — 메뉴에 남겨 두면 거짓 신호다.
  it('보관된 채널에는 항목이 없다', () => {
    seed(false);
    useAppStore.getState().set({ channels: [chan('c1', 'general', 'main-repo', 'public', { archivedAt: '2024-02-01T00:00:00.000Z' })] });
    controllerWithShare();
    render(<MessageItem message={mineQuiet} />);
    openMenu();
    expect(shareItem()).toBeNull();
  });

  /**
   * 컨트롤러 쪽 계약. 화면이 부르는 것만 재면, 컨트롤러가 응답을 스토어에 얹지 않아도
   * 회귀선이 초록으로 남는다 — 그러면 누른 뒤 채널 화면이 그대로여서 아무 일도 안 한
   * 것처럼 보인다(WS 이벤트가 늦게 오면 그 사이가 비어 있다).
   */
  it('컨트롤러가 갱신된 메시지를 스토어에 얹는다', async () => {
    const api = fakeApi({});
    const c = new Controller(api, fakeWsFactory().makeWs);
    setController(c);
    useAppStore.getState().reset();
    useAppStore.getState().set({ activeChannelId: 'c1', messages: { c1: [mineQuiet] } });

    await c.shareToChannel('m2');
    expect(api.shareToChannel).toHaveBeenCalledWith('c1', 'm2');
    expect(useAppStore.getState().messages.c1?.find((m) => m.id === 'm2')?.alsoInChannel).toBe(true);
  });
});

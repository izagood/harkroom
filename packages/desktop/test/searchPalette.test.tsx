import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, getController, type Controller } from '../src/state/controller';
import { SearchPalette } from '../src/components/SearchPalette';
import { acc, chan, msg, fakeApi } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * **언어를 한국어로 고정한다.** 이 파일이 재는 것은 언어가 아니라 **그 언어로 표현된
 * 규율**이다 — 문구가 사전을 지나게 된 뒤(i18n 이전)에도 그 규율은 그대로여야 하므로,
 * 한국어 문구를 재는 줄을 지우는 대신 언어를 못 박는다. `gallery.test.tsx`·
 * `skillsSettings.test.tsx`·`agentGrid.test.tsx`·`accountAvatar.test.tsx` 가 세운 선례다.
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

let mockController: ReturnType<typeof vi.fn> & { openChannel: ReturnType<typeof vi.fn>; openThread: ReturnType<typeof vi.fn>; openMessage: ReturnType<typeof vi.fn>; api: ReturnType<typeof fakeApi> };

/** 스코프 없음. 셋을 매번 손으로 적으면 무엇이 달라졌는지 읽히지 않는다. */
const GLOBAL_SCOPE = { channelId: null, threadRootId: null, offset: 0 };

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    dms: [],
  });

  const api = fakeApi();
  mockController = {
    openChannel: vi.fn(),
    openThread: vi.fn(),
    openMessage: vi.fn(),
    api,
    logout: vi.fn(),
    startDm: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(),
    toggleChannelStar: vi.fn(),
    closeThread: vi.fn(),
    notifyTyping: vi.fn(),
    refreshAccounts: vi.fn(),
    upload: vi.fn(),
    send: vi.fn(),
    reply: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    toggleReaction: vi.fn(),
    fetchAttachment: vi.fn(),
    saveAttachment: vi.fn(),
    listAgents: vi.fn(),
    listPats: vi.fn(),
    updateAgent: vi.fn(),
    createAgent: vi.fn(),
    revokePat: vi.fn(),
    mintPat: vi.fn(),
    createInvite: vi.fn(),
    loadOlder: vi.fn(),
  } as unknown as typeof mockController & { openChannel: ReturnType<typeof vi.fn>; openThread: ReturnType<typeof vi.fn>; openMessage: ReturnType<typeof vi.fn>; api: ReturnType<typeof fakeApi> };
  setController(mockController as unknown as Controller);
});

afterEach(() => {
  cleanup();
});

describe('SearchPalette', () => {
  it('단축키(외부)로 열고 Escape 로 닫는다', () => {
    const onClose = vi.fn();
    render(<SearchPalette open={true} onClose={onClose} />);

    expect(screen.getByLabelText('검색어 입력')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('질문을 넣으면 api.search 가 그 질문으로 불린다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'hello' } });

    await waitFor(() => {
      // 채널을 열어 두지 않았으므로 스코프는 null 이다 — 전역 검색.
      expect(mockController.api.search).toHaveBeenCalledWith('hello', GLOBAL_SCOPE);
    }, { timeout: 1000 });
  });

  it('결과가 그려진다(작성자·본문·채널을 알 수 있다)', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
      msg('m1', 'c1', 1, 'Hello world', 'u2'),
      ],
      hasMore: false,
    });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'hello' } });

    await waitFor(() => {
      expect(screen.getByText('@bot')).toBeTruthy();
      expect(screen.getByText('Hello world')).toBeTruthy();
      expect(screen.getByText('general')).toBeTruthy();
    }, { timeout: 1000 });
  });

  it('결과가 0건이면 "없다"가 보인다 — 빈 화면이 아니다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'nonexistent' } });

    await waitFor(() => {
      // **어투를 `~다` 로 맞췄고 범위를 말한다.** 이 팔레트는 메시지만 뒤지므로
      // (채널·사람은 사이드바 찾기 줄이 한다) 그 범위가 문장에 있어야 한다.
      // 재는 것은 문구가 아니라 **빈 결과를 사람에게 말하는가** 이므로 그대로 잰다.
      expect(screen.getByText('맞는 메시지가 없다')).toBeTruthy();
    }, { timeout: 1000 });
  });

  it('검색이 실패하면 사용자에게 오류가 보인다 — 조용히 삼키지 않는다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('서버 오류'));

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'error' } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText('서버 오류')).toBeTruthy();
    }, { timeout: 1000 });
  });

  it('결과를 누르면 openMessage 하나로 간다 — 강조·스레드·실패 통지가 그 안에 있다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
      msg('m1', 'c2', 1, 'Hello', 'u1'),
      ],
      hasMore: false,
    });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'hello' } });

    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeTruthy();
    }, { timeout: 1000 });

    const result = screen.getByText('Hello');
    fireEvent.click(result);

    await waitFor(() => {
      expect(mockController.openMessage).toHaveBeenCalledWith('m1');
      // openChannel/openThread 를 직접 부르면 highlightedMessageId 가 안 걸려
      // "눌렀는데 아무 일도 없다"가 된다. 그 길로 가지 않는 것이 이 테스트의 요지다.
      expect(mockController.openChannel).not.toHaveBeenCalled();
    }, { timeout: 1000 });
  });

  it('스레드 답글 결과도 같은 길로 간다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
      msg('m2', 'c1', 2, 'reply', 'u1', { threadRootId: 'm1' }),
      ],
      hasMore: false,
    });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'reply' } });

    await waitFor(() => {
      expect(screen.getByText('스레드')).toBeTruthy();
    }, { timeout: 1000 });

    const result = screen.getByText('reply');
    fireEvent.click(result);

    await waitFor(() => {
      expect(mockController.openMessage).toHaveBeenCalledWith('m2');
    }, { timeout: 1000 });
  });

  /**
   * #221 — 화살표로 옮기고 Enter 로 연다.
   *
   * 두 결과를 **서로 다른 채널**에 둔다. 둘 다 `c1` 이면 마지막 단언이 이동과 무관하게
   * 통과해서, 화살표가 아무것도 하지 않아도 초록이 된다 — 이동을 확인한다는 이 테스트의
   * 이름이 거짓이 된다.
   *
   * 대기가 왜 이 모양인가(#333): 이 팔레트의 keydown 리스너는 `results`·`activeIndex` 가
   * 바뀔 때마다 다시 등록되는 passive effect 다. RTL 의 `waitFor` 는 도는 동안 act 환경을
   * 꺼 두므로, 결과가 DOM 에 보이는 시점에도 등록된 리스너는 아직 `results: []` ·
   * `activeIndex: -1` 이던 렌더의 것일 수 있다. 그 리스너는 화살표도 Enter 도 그냥
   * 흘려보낸다. 부하가 크면 스케줄러가 밀려 이 창이 넓어지고, CI 에서 여기가 샜다.
   *
   * 그래서 시간을 재지 않는다 — `setTimeout` 을 끼우면 창이 좁아질 뿐 없어지지 않는다.
   * **키가 실제로 먹었다는 관측 가능한 상태**가 나올 때까지 키를 보낸다: 선택 표시
   * (`aria-selected`)가 두 번째 항목으로 옮겨 간 것. 한 번 먹은 뒤부터는 `fireEvent` 가
   * act 안에서 렌더와 이펙트를 동기로 밀어내므로 다음 키는 기다릴 것이 없다.
   */
  it('키보드로 결과를 이동·선택할 수 있다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
      msg('m1', 'c1', 1, 'First', 'u1'),
      msg('m2', 'c2', 2, 'Second', 'u2'),
      ],
      hasMore: false,
    });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('First')).toBeTruthy();
      expect(screen.getByText('Second')).toBeTruthy();
    }, { timeout: 1000 });

    // 검색이 끝나면 첫 항목이 선택된 채로 시작한다 — 이동의 출발점을 먼저 못박는다.
    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
    }, { timeout: 1000 });

    // ↓ 한 번이면 두 번째 항목으로 옮겨 간다. 리스너가 아직 옛 렌더의 것이면 이 키는
    // 사라지므로, 선택 표시가 실제로 옮겨 갈 때까지 보낸다.
    await waitFor(() => {
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
    }, { timeout: 1000 });

    fireEvent.keyDown(document, { key: 'Enter' });

    // 연 메시지가 `m2` 여야 한다 — 화살표가 실제로 두 번째 결과로 옮겨 갔다는 뜻이다.
    await waitFor(() => {
      expect(mockController.openMessage).toHaveBeenCalledWith('m2');
    }, { timeout: 1000 });
  });

  it('입력마다 서버를 때리지 않는다(디바운스)', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    vi.useFakeTimers();

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    const input = screen.getByLabelText('검색어 입력');

    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    await vi.runAllTimersAsync();

    vi.useRealTimers();

    expect(mockController.api.search).toHaveBeenCalledTimes(1);
    expect(mockController.api.search).toHaveBeenCalledWith('abc', GLOBAL_SCOPE);
  });

  /**
   * #221 — 스코프 토글. 확인하는 것은 "서버에 무엇을 보냈나"다. 결과 목록을 보는 것으로는
   * 클라이언트 필터와 구분되지 않고, 이 기능의 요점이 바로 서버에서 좁히는 것이다.
   */
  it('채널을 열어 두었어도 기본값은 전역이다', async () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    expect(screen.getByTestId('search-scope-all').getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByLabelText('검색어 입력'), { target: { value: 'hello' } });

    await waitFor(() => {
      expect(mockController.api.search).toHaveBeenCalledWith('hello', GLOBAL_SCOPE);
    }, { timeout: 1000 });
  });

  it('이 채널을 고르면 그 채널로 스코프가 걸려 다시 검색한다', async () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('검색어 입력'), { target: { value: 'hello' } });
    await waitFor(() => {
      expect(mockController.api.search).toHaveBeenCalledWith('hello', GLOBAL_SCOPE);
    }, { timeout: 1000 });

    fireEvent.click(screen.getByTestId('search-scope-channel'));

    await waitFor(() => {
      expect(mockController.api.search).toHaveBeenCalledWith('hello', { channelId: 'c1', threadRootId: null, offset: 0 });
    }, { timeout: 1000 });

    // 전체로 되돌아올 수 있어야 한다 — 한 방향으로만 가는 스코프는 스코프가 아니다.
    fireEvent.click(screen.getByTestId('search-scope-all'));
    await waitFor(() => {
      const calls = (mockController.api.search as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[calls.length - 1]).toEqual(['hello', GLOBAL_SCOPE]);
    }, { timeout: 1000 });
  });

  it('열려 있는 채널이 없으면 스코프 줄 자체가 없다', () => {
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    expect(screen.queryByTestId('search-scope-channel')).toBeNull();
  });

  /** 스레드 칸은 스레드가 열려 있을 때만 선다 — 없는 자리를 회색으로 남기지 않는다. */
  it('스레드가 닫혀 있으면 스레드 칸이 없다', () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });
    render(<SearchPalette open={true} onClose={vi.fn()} />);
    expect(screen.queryByTestId('search-scope-thread')).toBeNull();
  });

  it('initialScope=thread 로 열면 열려 있는 스레드로 좁혀 찾는다', async () => {
    useAppStore.getState().set({ activeChannelId: 'c1', threadRootId: 'm1' });
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} initialScope="thread" />);
    expect(screen.getByTestId('search-scope-thread').getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByLabelText('검색어 입력'), { target: { value: 'hello' } });
    await waitFor(() => {
      // 스레드 스코프에도 채널을 함께 보낸다 — 서버의 403 판정이 채널 단위다.
      expect(mockController.api.search).toHaveBeenCalledWith(
        'hello', { channelId: 'c1', threadRootId: 'm1', offset: 0 },
      );
    }, { timeout: 1000 });
  });

  /**
   * 잘렸다는 것을 말하지 않으면 사람은 "없다"로 읽는다. '더 보기'는 offset 을 이어
   * 붙이고 결과를 **잇는다**(갈아치우지 않는다).
   */
  it('더 있으면 더 보기가 서고, 누르면 offset 을 이어 붙인다', async () => {
    (mockController.api.search as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ messages: [msg('m1', 'c1', 1, 'First', 'u1')], hasMore: true })
      .mockResolvedValueOnce({ messages: [msg('m2', 'c1', 2, 'Second', 'u1')], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('검색어 입력'), { target: { value: 'hello' } });

    await waitFor(() => expect(screen.getByTestId('search-more')).toBeTruthy(), { timeout: 1000 });
    fireEvent.click(screen.getByTestId('search-more'));

    await waitFor(() => {
      expect(mockController.api.search).toHaveBeenLastCalledWith(
        'hello', { channelId: null, threadRootId: null, offset: 1 },
      );
      expect(screen.getByText('First')).toBeTruthy();
      expect(screen.getByText('Second')).toBeTruthy();
      expect(screen.queryByTestId('search-more')).toBeNull();
    }, { timeout: 1000 });
  });

  it('initialScope=channel 로 열면 첫 검색이 채널로 좁혀진다', async () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} initialScope="channel" />);

    expect(screen.getByTestId('search-scope-channel').getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByLabelText('검색어 입력'), { target: { value: 'hello' } });

    await waitFor(() => {
      expect(mockController.api.search).toHaveBeenCalledWith('hello', { channelId: 'c1', threadRootId: null, offset: 0 });
    }, { timeout: 1000 });
  });

  it('initialScope=all 로 열면 전역이다', async () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });
    (mockController.api.search as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [], hasMore: false });

    render(<SearchPalette open={true} onClose={vi.fn()} initialScope="all" />);

    expect(screen.getByTestId('search-scope-all').getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByLabelText('검색어 입력'), { target: { value: 'hello' } });

    await waitFor(() => {
      expect(mockController.api.search).toHaveBeenCalledWith('hello', GLOBAL_SCOPE);
    }, { timeout: 1000 });
  });

  it('placeholder 가 스코프 상태를 말한다', () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });

    // 두 번째 render 를 겹쳐 띄우면 앞의 팔레트가 화면에 남아 두 placeholder 가 동시에
    // 존재한다. 지금은 문구가 달라 우연히 통과하지만, 문구를 손대는 순간 어느 팔레트를
    // 집었는지 모르게 되므로 하나씩 내리고 확인한다.
    const scopedRender = render(
      <SearchPalette open={true} onClose={vi.fn()} initialScope="channel" />,
    );
    expect(screen.getByPlaceholderText('이 채널에서 찾기 (general)')).toBeTruthy();
    scopedRender.unmount();

    render(<SearchPalette open={true} onClose={vi.fn()} initialScope="all" />);
    expect(screen.getByPlaceholderText('전체에서 찾기')).toBeTruthy();
  });

  // 팔레트는 Workspace 에 계속 마운트된 채 open 만 뒤집힌다. useState 초기값은 마운트
  // 때 한 번만 읽히므로, 열릴 때마다 initialScope 를 다시 적용하지 않으면 진입점이
  // 정한 스코프가 두 번째 열기부터 무시된다(#258 회수 중 발견).
  it('닫았다 다시 열면 그때의 initialScope 를 반영한다', () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });

    const view = render(<SearchPalette open={false} onClose={vi.fn()} initialScope="all" />);
    view.rerender(<SearchPalette open={true} onClose={vi.fn()} initialScope="channel" />);

    expect(
      screen.getByTestId('search-scope-channel').getAttribute('aria-pressed'),
      '열 때의 initialScope 가 반영돼야 한다',
    ).toBe('true');
  });

  // 이미 열려 있는 동안 부모가 initialScope 를 바꿔도, 사람이 손으로 고른 스코프를
  // 덮어쓰지 않는다. 스코프는 사람의 선택이고 열기 동작만 그걸 초기화한다.
  it('열려 있는 동안 initialScope 가 바뀌어도 손으로 고른 스코프를 덮지 않는다', () => {
    useAppStore.getState().set({ activeChannelId: 'c1' });

    const view = render(<SearchPalette open={true} onClose={vi.fn()} initialScope="all" />);
    fireEvent.click(screen.getByTestId('search-scope-channel'));
    expect(screen.getByTestId('search-scope-channel').getAttribute('aria-pressed')).toBe('true');

    view.rerender(<SearchPalette open={true} onClose={vi.fn()} initialScope="all" />);
    expect(screen.getByTestId('search-scope-channel').getAttribute('aria-pressed')).toBe('true');
  });
});

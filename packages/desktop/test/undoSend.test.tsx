import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Composer } from '../src/components/Composer';
import { ChannelPane } from '../src/components/ChannelPane';
import { Controller, setController } from '../src/state/controller';
import { acc, chan, fakeApi } from './helpers/fakeApi';
import { DEFAULT_UNDO_SEND_MS, undoSendStorage } from '../src/lib/prefs';

/**
 * 보낸 메시지를 되돌린다(#223).
 *
 * 이 파일이 지키는 한 문장: **되돌리면 서버는 그 메시지를 본 적이 없다.** 서버에 지연 장치를
 * 두지 않고 클라이언트가 아예 보내지 않기 때문에 성립한다 — 그래서 검증도 "표시가 떴는가"가
 * 아니라 **"서버 호출이 일어났는가"** 로 한다.
 */

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  // selectionStart 는 jsdom 이 change 로 갱신하지 않는다 — 커서를 끝에 두는 것을 직접 흉내낸다.
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

/** 타이머를 밀고 그 사이 걸린 프로미스까지 흘려보낸다. act 밖에서 밀면 상태 갱신이 새어 경고가 난다. */
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), a1: acc('a1', 'fizz', 'agent') },
  });
  setController(new Controller(fakeApi()));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setController(null as unknown as Controller);
});

describe('보냄 취소 창', () => {
  // 이 하나가 무너지면 나머지는 전부 장식이다 — 창이 도는 동안 서버가 메시지를 이미 받았다면
  // 멘션 알림도 이미 나갔고, "되돌렸다"는 표시는 거짓말이 된다.
  it('창이 도는 동안에는 서버 호출이 일어나지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    typeInto('아직 보내지 마라');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('undo-send')).toBeTruthy();
  });

  it('창이 끝나면 보내진다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    typeInto('결국 나간다');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await advance(DEFAULT_UNDO_SEND_MS);

    expect(onSend).toHaveBeenCalledWith('결국 나간다', []);
    expect(screen.queryByTestId('undo-send')).toBeNull();
  });

  // 이 작업의 핵심. **영영** 일어나지 않아야 한다 — 창 길이만큼 더 밀어도 마찬가지다.
  it('되돌리면 서버 호출이 영영 일어나지 않는다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    typeInto('이건 실수다');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo send' }));

    await advance(DEFAULT_UNDO_SEND_MS * 4);
    expect(onSend).not.toHaveBeenCalled();
  });

  // 되돌리는 이유는 대개 "이렇게 보내면 안 됐다"이지 "안 보내고 싶다"가 아니다.
  it('되돌리면 컴포저에 원문이 돌아온다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    typeInto('고쳐서 다시 보낼 원문');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Undo send' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('고쳐서 다시 보낼 원문');
  });

  // 사람이 쓴 것을 잃는 것이 가장 나쁘다 — 되돌린 것이 아니면 반드시 나간다.
  it('창이 끝나기 전에 언마운트되면 즉시 보내진다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    typeInto('떠나도 나가야 한다');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    cleanup();
    expect(onSend).toHaveBeenCalledWith('떠나도 나가야 한다', []);
  });

  it('창 길이가 0 이면 즉시 보내진다', () => {
    undoSendStorage.saveWindowMs(0);
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    typeInto('끄면 예전과 같다');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('끄면 예전과 같다', []);
    expect(screen.queryByTestId('undo-send')).toBeNull();
  });

  // 하나만 들 수 있으므로 덮으면 앞의 글을 잃는다 — 그 손실은 화면 어디에도 표시되지 않는다.
  it('창이 도는 동안 또 보내면 앞의 것이 먼저 나간다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    typeInto('첫째 줄');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    typeInto('둘째 줄');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('첫째 줄', []);
  });
});

describe('보냄 취소와 채널', () => {
  /**
   * #184 가 닫은 결함을 되살리지 않는다. 컴포저 인스턴스는 채널 전환에도 살아 있고
   * (ChannelPane 이 같은 자리에 렌더한다) 컨트롤러는 활성 채널을 호출 시점에 읽으므로,
   * 대기 항목이 자기 자리를 들고 있지 않으면 A 에 쓴 글이 B 로 나간다.
   */
  it('채널을 옮겨도 원래 채널로 간다', async () => {
    const postMessage = vi.fn(async (channelId: string) => ({
      id: 'm-new', seq: 1, channelId, threadRootId: null, authorId: 'u1', body: 'x',
      kind: 'user' as const, meta: {}, createdAt: new Date().toISOString(), editedAt: null,
      reactions: [], attachments: [], replyCount: null, lastReplyAt: null, participantIds: null,
    }));
    setController(new Controller(fakeApi({ postMessage: postMessage as never })));
    useAppStore.getState().set({
      channels: [chan('c1', 'general'), chan('c2', 'other')],
      activeChannelId: 'c1',
    });
    render(<ChannelPane />);

    typeInto('c1 에 쓴 글');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(postMessage).not.toHaveBeenCalled();

    // 채널을 옮긴다 — 옮기는 순간 대기 중인 것이 나가야 하고, 나가는 자리는 c1 이어야 한다.
    await act(async () => {
      useAppStore.getState().set({ activeChannelId: 'c2' });
      await Promise.resolve();
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0]).toBe('c1');
  });
});

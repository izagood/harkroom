import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller, Controller as RealController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

/**
 * 스레드를 시작한 말을 지웠을 때(2026-09-09 신고). 지금까지는 그 한 행만 사라져서
 * 채널에서는 스레드가 통째로 없어진 것처럼 보였고, 살아 있는 답글로 들어갈 문이 없었다.
 *
 * 이 파일이 지키는 것은 두 가지다:
 * 1) 답글이 남은 머리는 **자리표시자**로 남고, 본문 대신 "삭제되었다"는 한 줄과
 *    스레드로 들어가는 문만 보인다.
 * 2) 답글이 없는 메시지는 그냥 사라진다 — 자리표시자를 남기지 않는다.
 *
 * 언어를 한국어로 고정하는 이유는 다른 회귀선과 같다: 재는 것은 언어가 아니라 그 언어로
 * 표현된 규율이고, 로케일 기본값이 바뀔 때 이유 없이 빨개지면 안 된다.
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

const tombstone = (id: string, replyCount: number) =>
  msg(id, 'c1', 1, '', 'u2', { deletedAt: '2026-09-09T00:00:00.000Z', replyCount });

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general', 'main-repo')],
    activeChannelId: 'c1',
  });
});

describe('지워진 스레드 머리의 자리표시자', () => {
  it('본문 대신 "채팅이 삭제되었습니다" 한 줄을 그린다', () => {
    setController({ openThread: vi.fn() } as unknown as Controller);
    render(<MessageItem message={tombstone('m1', 2)} />);
    expect(screen.getByTestId('deleted-message')).toBeTruthy();
    expect(screen.getByText('채팅이 삭제되었습니다')).toBeTruthy();
  });

  it('작성자·시각·툴바를 곁들이지 않는다 — 지운 말의 일부다', () => {
    setController({ openThread: vi.fn() } as unknown as Controller);
    render(<MessageItem message={tombstone('m1', 2)} />);
    expect(screen.queryByTestId('author-name')).toBeNull();
    expect(screen.queryByTestId('author-gutter')).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'message toolbar' })).toBeNull();
  });

  it('답글 수 버튼이 스레드를 연다 — 이 행이 남는 이유가 그 문이다', () => {
    const c = { openThread: vi.fn() };
    setController(c as unknown as Controller);
    render(<MessageItem message={tombstone('m1', 3)} />);
    const button = screen.getByTestId('deleted-message-replies');
    expect(button.textContent).toContain('3');
    fireEvent.click(button);
    expect(c.openThread).toHaveBeenCalledWith('m1');
  });

  it('스레드 안에서는 문을 그리지 않는다 — 이미 그 안이다', () => {
    setController({ openThread: vi.fn() } as unknown as Controller);
    render(<MessageItem message={tombstone('m1', 3)} inThread />);
    expect(screen.getByText('채팅이 삭제되었습니다')).toBeTruthy();
    expect(screen.queryByTestId('deleted-message-replies')).toBeNull();
  });
});

describe('controller.deleteMessage', () => {
  const controllerWith = async (deleteMessage: ReturnType<typeof vi.fn>) => {
    const api = fakeApi({ deleteMessage });
    const c = new RealController(api, fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    return c;
  };

  it('자리표시자가 오면 목록에서 빼지 않고 덮는다 (스레드도 닫지 않는다)', async () => {
    const row = tombstone('m1', 1);
    const c = await controllerWith(vi.fn(async () => row));
    useAppStore.getState().set({ messages: { c1: [msg('m1', 'c1', 1, 'root', 'u1', { replyCount: 1 })] }, threadRootId: 'm1' });

    await c.deleteMessage('m1');

    const s = useAppStore.getState();
    expect(s.messages.c1?.map((m) => m.id)).toEqual(['m1']);
    expect(s.messages.c1?.[0]?.deletedAt).toBe('2026-09-09T00:00:00.000Z');
    expect(s.threadRootId).toBe('m1');
  });

  it('204(=undefined) 면 목록에서 빼고 열려 있던 스레드를 닫는다', async () => {
    const c = await controllerWith(vi.fn(async () => undefined));
    useAppStore.getState().set({ messages: { c1: [msg('m1', 'c1', 1, 'root', 'u1')] }, threadRootId: 'm1' });

    await c.deleteMessage('m1');

    const s = useAppStore.getState();
    expect(s.messages.c1 ?? []).toHaveLength(0);
    expect(s.threadRootId).toBeNull();
  });
});

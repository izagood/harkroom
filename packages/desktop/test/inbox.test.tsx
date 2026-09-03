import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { InboxEntry } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Inbox } from '../src/components/Inbox';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, msg } from './helpers/fakeApi';

const entry = (
  id: number, reason: InboxEntry['reason'], channelId: string, readAt: string | null = null,
): InboxEntry => ({ id, messageId: `m${id}`, reason, readAt, channelId });

/**
 * 이 화면은 스토어의 `unread` 가 아니라 `api.inbox()` 를 직접 부른다 — 그 배열은 `?unread=1`
 * 로만 채워져 안 읽은 것밖에 없고, 그것만 보면 '안 읽음만' 필터가 항상 참이 된다.
 */
const fakeController = (
  inbox: () => Promise<InboxEntry[]> = async () => [],
) => {
  const c = {
    api: { inbox: vi.fn(inbox) },
    openMessage: vi.fn(async () => undefined),
    openChannel: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ channels: [chan('c1', 'general'), chan('c2', 'random')] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = () => render(<Inbox open onClose={vi.fn()} />);

describe('Inbox (#185)', () => {
  // 1. 목록 자체가 없던 것이 이 이슈의 핵심이다. 셋 중 하나라도 빠지면 그 종류로 나를 부른
  //    것은 여전히 어디에도 안 보인다.
  it('멘션·스레드 답글·DM 항목이 모두 목록에 나온다', async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1'), entry(2, 'thread_reply', 'c1'), entry(3, 'dm', 'c2'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());
    expect(screen.getByTestId('inbox-entry-2')).toBeTruthy();
    expect(screen.getByTestId('inbox-entry-3')).toBeTruthy();
    expect(screen.getByTestId('inbox-reason-1').textContent).toBe('멘션');
    expect(screen.getByTestId('inbox-reason-2').textContent).toBe('스레드 답글');
    expect(screen.getByTestId('inbox-reason-3').textContent).toBe('DM');
  });

  // 2. 종류 필터.
  it('종류 필터가 동작한다', async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1'), entry(2, 'thread_reply', 'c1'), entry(3, 'dm', 'c2'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('종류 필터'), { target: { value: 'mention' } });
    expect(screen.getByTestId('inbox-entry-1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-entry-2')).toBeNull();
    expect(screen.queryByTestId('inbox-entry-3')).toBeNull();

    fireEvent.change(screen.getByLabelText('종류 필터'), { target: { value: 'dm' } });
    expect(screen.queryByTestId('inbox-entry-1')).toBeNull();
    expect(screen.getByTestId('inbox-entry-3')).toBeTruthy();
  });

  // 3. 안 읽음만. 스토어의 unread 배열을 읽었다면 읽은 항목이 애초에 없어 이 필터는
  //    아무것도 거르지 않는 스위치가 된다 — 그래서 읽은 항목을 fixture 에 반드시 둔다.
  it('"안 읽음만" 필터가 동작한다', async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1', null),
      entry(2, 'mention', 'c1', '2026-09-03T00:00:00.000Z'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());
    expect(screen.getByTestId('inbox-entry-2')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('안 읽음만'));
    expect(screen.getByTestId('inbox-entry-1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-entry-2')).toBeNull();
  });

  // 4. 채널 필터.
  it('채널 필터가 동작한다', async () => {
    fakeController(async () => [entry(1, 'mention', 'c1'), entry(2, 'mention', 'c2')]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('채널 필터'), { target: { value: 'c2' } });
    expect(screen.queryByTestId('inbox-entry-1')).toBeNull();
    expect(screen.getByTestId('inbox-entry-2')).toBeTruthy();
  });

  // 5. 초안. 공백만 남은 초안은 쓰다 만 답글이 아니라 흔적이다 — 그것을 항목으로 내면
  //    목록이 처리할 것이 있다고 거짓말한다.
  it('내용이 있는 초안은 항목으로 뜨고, 빈 초안은 뜨지 않는다', async () => {
    fakeController();
    useAppStore.getState().set({ drafts: { c1: '쓰다 만 답글', c2: '   ' } });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-draft-c1')).toBeTruthy());
    expect(screen.getByTestId('inbox-draft-c1').textContent).toContain('쓰다 만 답글');
    expect(screen.queryByTestId('inbox-draft-c2')).toBeNull();
  });

  // 6. 하나는 남이 나를 부른 것이고 하나는 내가 쓰다 만 것이다. 한 목록에 섞이면 목록이
  //    무엇을 말하는지 알 수 없다 — 구획이 갈려 있고 초안에 글자 표가 붙어야 한다.
  it('초안 항목이 inbox 항목과 구분돼 보인다', async () => {
    fakeController(async () => [entry(1, 'mention', 'c1')]);
    useAppStore.getState().set({ drafts: { c1: '쓰다 만 답글' } });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const called = screen.getByRole('region', { name: '나를 부른 것' });
    const draftBox = screen.getByRole('region', { name: '쓰다 만 초안' });
    expect(within(called).getByTestId('inbox-entry-1')).toBeTruthy();
    expect(within(called).queryByTestId('inbox-draft-c1')).toBeNull();
    expect(within(draftBox).getByTestId('inbox-draft-c1')).toBeTruthy();
    expect(within(draftBox).queryByTestId('inbox-entry-1')).toBeNull();
    // 구획이 갈린 것만으로는 부족하다 — 행 자체가 무엇인지 말해야 한다.
    expect(screen.getByTestId('inbox-draft-badge-c1').textContent).toBe('초안');
  });

  // 7. 실패를 빈 목록으로 삼키면 "아무도 나를 부르지 않았다" 는 거짓말이 된다.
  it('조회 실패가 "없다"가 아니라 오류로 보인다', async () => {
    fakeController(async () => { throw new Error('boom'); });
    open();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('boom');
    expect(screen.queryByText('나를 부른 것이 없다')).toBeNull();
  });

  it('부른 것이 없으면 "없다"를 보여 준다', async () => {
    fakeController(async () => []);
    open();
    await waitFor(() => expect(screen.getByText('나를 부른 것이 없다')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // 이동 경로는 #178·#228 이 이미 만든 것을 쓴다. 새로 만들면 실패 처리가 갈라진다.
  it('항목을 누르면 그 메시지로 간다', async () => {
    const c = fakeController(async () => [entry(7, 'mention', 'c1')]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-7')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inbox-entry-7'));
    expect(c.openMessage).toHaveBeenCalledWith('m7');
  });

  // 스레드 초안의 scopeKey 에 든 rootId 는 메시지 id 다 — openMessage 가 채널까지 연다.
  it('스레드 초안을 누르면 그 스레드 루트로 간다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ drafts: { 'thread:root-1': '답글 쓰다 말았다' } });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-draft-thread:root-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inbox-draft-thread:root-1'));
    expect(c.openMessage).toHaveBeenCalledWith('root-1');
  });

  // 아무도 열 수 없는 화면은 없는 화면과 같다. #226 의 디렉터리와 **같은 방식으로** 연다 —
  // 사이드바 항목이 뷰를 연다. 화면마다 여는 방식이 다르면 다음 화면이 어느 쪽을 따를지 모른다.
  it('사이드바에서 인박스로 갈 수 있다', () => {
    fakeController();
    useAppStore.getState().set({ me: acc('u1', 'alice') });
    const onOpenInbox = vi.fn();
    render(
      <Sidebar
        onOpenDirectory={vi.fn()}
        onOpenInbox={onOpenInbox}
        onOpenChannelDirectory={vi.fn()}
        onLogout={vi.fn()}
        onOpenSettings={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Inbox'));
    expect(onOpenInbox).toHaveBeenCalled();
  });

  // 종류로 좁히면 초안은 빠진다 — 초안은 멘션도 답글도 DM 도 아니다.
  it('종류로 좁히면 초안 구획이 비고, 채널 필터는 초안에도 걸린다', async () => {
    fakeController(async () => [entry(1, 'mention', 'c1')]);
    useAppStore.getState().set({
      drafts: { c1: 'c1 초안', c2: 'c2 초안' },
      messages: { c1: [msg('root-1', 'c1', 1, '루트')] },
    });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-draft-c1')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('채널 필터'), { target: { value: 'c1' } });
    expect(screen.getByTestId('inbox-draft-c1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-draft-c2')).toBeNull();

    fireEvent.change(screen.getByLabelText('채널 필터'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('종류 필터'), { target: { value: 'mention' } });
    expect(screen.queryByTestId('inbox-draft-c1')).toBeNull();
    expect(screen.queryByTestId('inbox-draft-c2')).toBeNull();
  });
});

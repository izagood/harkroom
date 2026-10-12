// A3-2 — 끊긴 동안의 스레드 패널(designer 시안 ②④⑥). 패널이 「받아 둔 것만 그리고 있다」는 것을
// **말하는지** 잰다: 말하지 않으면 못 받은 답글이 「없는 것」·「끝남」으로 읽힌다(design.md §4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { acc, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = { reply: vi.fn(async () => undefined), closeThread: vi.fn(), openThread: vi.fn(), retryThread: vi.fn(async () => undefined) };
  setController(c as unknown as Controller);
  return c;
};

const root = msg('m1', 'c1', 1, 'root message', 'u1', { replyCount: 7 } as never);
const reply = msg('m2', 'c1', 2, 'a reply', 'u2', { threadRootId: 'm1' });

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    activeChannelId: 'c1', threadRootId: 'm1', connected: true,
    messages: { c1: [root, reply] },
  });
});
afterEach(() => cleanup());

describe('끊긴 동안의 스레드 패널 (A3-2)', () => {
  it('붙어 있으면 아무 표지도 없다', () => {
    fakeController();
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-held-boundary')).toBeNull();
    expect(screen.queryByTestId('thread-unfetched')).toBeNull();
    expect(screen.queryByTestId('thread-no-response')).toBeNull();
  });

  it('② 끊겨 있으면 마지막 답글 아래 경계 줄을 긋고, 다시 online 이면 걷는다', () => {
    fakeController();
    useAppStore.getState().set({ connected: false, link: 'offline', offlineSince: Date.parse('2026-10-12T10:00:00Z') });
    const { rerender } = render(<ThreadPanel />);
    expect(screen.getByTestId('thread-held-boundary').textContent).toMatch(/Replies received up to here/);
    useAppStore.getState().set({ connected: true, link: 'resyncing' });
    rerender(<ThreadPanel />);
    expect(screen.queryByTestId('thread-held-boundary')).not.toBeNull();
    useAppStore.getState().set({ link: 'online', offlineSince: null });
    rerender(<ThreadPanel />);
    expect(screen.queryByTestId('thread-held-boundary')).toBeNull();
  });

  it('④ 답글을 하나도 못 받았으면 「답글 없음」·「끝남」 대신 빈 상태 + 「모름」', () => {
    fakeController();
    useAppStore.getState().set({
      connected: false, link: 'offline', messages: { c1: [root] },
      threadFetch: { rootId: 'm1', reason: 'offline' },
    });
    render(<ThreadPanel />);
    expect(screen.getByTestId('thread-unfetched').textContent).toMatch(/7 replies not loaded yet/);
    expect(screen.queryByTestId('thread-empty')).toBeNull();
    expect(screen.getByTestId('thread-state').getAttribute('data-state')).toBe('unknown');
  });

  it('⑥ 소켓은 붙었는데 답이 없으면 패널 안에서만 [다시 시도]', () => {
    const c = fakeController();
    useAppStore.getState().set({ messages: { c1: [root] }, threadFetch: { rootId: 'm1', reason: 'noResponse' } });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-unfetched')).toBeNull();
    expect(screen.getByTestId('thread-state').getAttribute('data-state')).toBe('unknown');
    fireEvent.click(screen.getByTestId('thread-retry'));
    expect(c.retryThread).toHaveBeenCalled();
  });

  it('다른 스레드의 표지는 이 패널의 사실이 아니다', () => {
    fakeController();
    useAppStore.getState().set({ threadFetch: { rootId: 'other', reason: 'noResponse' } });
    render(<ThreadPanel />);
    expect(screen.queryByTestId('thread-no-response')).toBeNull();
    expect(screen.getByTestId('thread-state').getAttribute('data-state')).not.toBe('unknown');
  });

  /** designer s1 — 경계 줄이 「이 아래는 모른다」고 하는 동안 배지가 「끝남」이면 서로 반대 말을 한다. */
  it('끊김 + 받아 둔 답글 + done → 「모름」, 다시 붙으면 「끝남」', () => {
    fakeController();
    const { rerender } = render(<ThreadPanel />);
    expect(screen.getByTestId('thread-state').getAttribute('data-state')).toBe('done');
    useAppStore.getState().set({ connected: false, link: 'offline', offlineSince: Date.parse('2026-10-12T10:00:00Z') });
    rerender(<ThreadPanel />);
    expect(screen.getByTestId('thread-held-boundary')).toBeTruthy();
    expect(screen.getByTestId('thread-state').getAttribute('data-state')).toBe('unknown');
    useAppStore.getState().set({ connected: true, link: 'online', offlineSince: null });
    rerender(<ThreadPanel />);
    expect(screen.getByTestId('thread-state').getAttribute('data-state')).toBe('done');
  });

  /** designer n1·n5 — ⑥ 은 원인(서버가 응답하지 않는다)을 말하고, 받아 둔 답글이 있으면 못 받은 것은 「새」 답글이다. */
  it('⑥ 둘째 줄이 원인을 말하고, 받아 둔 답글이 있으면 「새 답글」이다', () => {
    fakeController();
    useAppStore.getState().set({ threadFetch: { rootId: 'm1', reason: 'noResponse' } });
    const { rerender } = render(<ThreadPanel />);
    const held = screen.getByTestId('thread-no-response').textContent ?? '';
    expect(held).toMatch(/Couldn't load new replies/);
    expect(held).toMatch(/The server is not responding/);
    useAppStore.getState().set({ messages: { c1: [root] } });
    rerender(<ThreadPanel />);
    const empty = screen.getByTestId('thread-no-response').textContent ?? '';
    expect(empty).toMatch(/Couldn't load replies/);
    expect(empty).not.toMatch(/new replies/);
  });
});

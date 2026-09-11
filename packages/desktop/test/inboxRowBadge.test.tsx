import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan } from './helpers/fakeApi';
import type { InboxEntry } from '@harkroom/shared';

/**
 * 사이드바 `Inbox` 줄의 미읽음 표시(2026-09-11 신고: *"새로운 알림이 왔을 때 Inbox 에도
 * 알림이 있어야 알지"*).
 *
 * 재는 것은 **모양이 아니라 두 신호가 갈리는가**다 — 나를 막는 것은 숫자로 세고, 새 대화만
 * 있으면 점 하나다. 둘이 한 표시로 뭉치면 인박스 배지가 늘 켜져 있어 아무 말도 하지 않는다
 * (`InboxRowBadge` 의 주석).
 */
const entry = (id: number, reason: InboxEntry['reason'], readAt: string | null): InboxEntry => ({
  id, messageId: `m${id}`, reason, readAt, channelId: 'c1', authorId: 'u1',
  body: '', meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId: null,
});

const renderSidebar = () => render(
  <Sidebar
    panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}}
    onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
    collapsed={false} onToggleCollapse={vi.fn()}
  />,
);

beforeEach(() => {
  useAppStore.getState().reset();
  setController({ openChannel: vi.fn(), startDm: vi.fn() } as unknown as Controller);
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin') },
    channels: [chan('c1', 'general')],
    dms: [],
    connected: true,
    activeChannelId: 'c1',
  });
  usePrefsStore.getState().setLocale('ko');
});

afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('사이드바 Inbox 줄의 표시', () => {
  it('부를 것이 없으면 아무 표시도 없다', () => {
    useAppStore.getState().set({ unread: [] });
    renderSidebar();
    expect(screen.queryByTestId('inbox-blocking-badge')).toBeNull();
    expect(screen.queryByTestId('inbox-unread-dot')).toBeNull();
  });

  it('안 읽은 멘션·DM 은 숫자로 센다', () => {
    useAppStore.getState().set({
      unread: [entry(1, 'mention', null), entry(2, 'dm', null), entry(3, 'mention', '2024-01-02T00:00:00.000Z')],
    });
    renderSidebar();
    expect(screen.getByTestId('inbox-blocking-badge').textContent).toBe('2');
    // 숫자가 서면 점은 서지 않는다 — 한 목록을 두 번 가리키는 군더더기다.
    expect(screen.queryByTestId('inbox-unread-dot')).toBeNull();
  });

  it('나를 막는 것 없이 답글만 있으면 숫자가 아니라 점이다', () => {
    useAppStore.getState().set({ unread: [entry(1, 'thread_reply', null)] });
    renderSidebar();
    expect(screen.queryByTestId('inbox-blocking-badge')).toBeNull();
    expect(screen.getByTestId('inbox-unread-dot')).toBeTruthy();
  });

  it('레일 홈 배지와 같은 수를 센다 — 두 자리가 갈리지 않는다', async () => {
    const { blockingUnreadCount } = await import('../src/state/unread');
    const unread = [entry(1, 'mention', null), entry(2, 'dm', null), entry(3, 'thread_reply', null)];
    useAppStore.getState().set({ unread });
    renderSidebar();
    expect(screen.getByTestId('inbox-blocking-badge').textContent)
      .toBe(String(blockingUnreadCount(unread)));
  });

  it('표시에는 글자가 없으므로 접근 이름이 두 신호를 갈라 말한다', () => {
    useAppStore.getState().set({ unread: [entry(1, 'mention', null)] });
    renderSidebar();
    expect(screen.getByLabelText('인박스에 내 답을 기다리는 것 1개')).toBeTruthy();
    cleanup();
    useAppStore.getState().set({ unread: [entry(1, 'thread_reply', null)] });
    renderSidebar();
    expect(screen.getByLabelText('인박스에 안 읽은 것 1개')).toBeTruthy();
  });
});

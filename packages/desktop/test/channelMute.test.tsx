import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ChannelPrefRow, InboxEntry } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { DEFAULT_PREFS } from '../src/lib/prefs';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

/**
 * #229 회귀선. 음소거는 저장·조회·토글까지만 되어 있고 **소비하는 곳이 없었다** —
 * `mutedAt` 을 읽는 곳이 메뉴 라벨 둘뿐이라, 껐다고 믿은 사용자에게 알림과 배지가 그대로 갔다.
 * 부재보다 나쁜 거짓 이행이라 여기 두 경로(OS 알림·미읽음 배지)를 함께 묶어 둔다.
 */

const entry = (id: number, messageId: string, channelId = 'c1',
  reason: InboxEntry['reason'] = 'mention'): InboxEntry =>
  ({ id, messageId, reason, readAt: null, channelId });

const pref = (channelId: string, muted: boolean): ChannelPrefRow =>
  ({ accountId: 'u1', channelId, mutedAt: muted ? '2026-09-03T00:00:00.000Z' : null, starredAt: null });

function fakeNotifier() {
  const sent: { title: string; body: string }[] = [];
  return { sent, notify: vi.fn(async (n: { title: string; body: string }) => { sent.push(n); }) };
}

/** 창이 배경에 있어야 알림 경로가 돈다 — 포커스 분기는 그 앞에서 전부 삼킨다. */
const setFocus = (focused: boolean) => { vi.spyOn(document, 'hasFocus').mockReturnValue(focused); };

/** 알림 판정은 refreshUnread().then(...) 안에서 돈다 — 스토어 반영을 기다린 뒤 매크로태스크로 넘긴다. */
async function settled(expectedUnread: number) {
  await vi.waitFor(() => expect(useAppStore.getState().unread).toHaveLength(expectedUnread));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function started(notifier: ReturnType<typeof fakeNotifier>, arriving: InboxEntry[], prefs: ChannelPrefRow[]) {
  let calls = 0;
  const api = fakeApi({
    channels: vi.fn(async () => [chan('c1', 'general'), chan('c2', 'dev')]),
    accounts: vi.fn(async () => [acc('u1', 'admin'), acc('u2', 'bot', 'agent')]),
    // 첫 조회(백로그)는 비어 있다 — 시작 시점에 쌓여 있던 것은 이미 '지나간 것'으로 표시되므로
    // 그 위에서는 음소거 가드가 도는지 아닌지를 구분할 수 없다.
    inboxUnread: vi.fn(async () => (calls++ === 0 ? [] : arriving)),
    channelPrefs: vi.fn(async () => prefs),
  });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs, notifier);
  await c.start();
  // 채널 선호는 크리티컬 패스 밖에서 들어온다 — 스토어에 실제로 앉을 때까지 기다린다.
  if (prefs.length) await vi.waitFor(() => expect(Object.keys(useAppStore.getState().channelPrefs)).toHaveLength(prefs.length));
  return { c, callbacks };
}

beforeEach(() => {
  useAppStore.getState().reset();
  usePrefsStore.setState({ notifications: { ...DEFAULT_PREFS.notifications } });
  vi.restoreAllMocks();
});
afterEach(() => cleanup());

describe('음소거된 채널의 알림', () => {
  it('음소거한 채널의 새 멘션은 알림을 띄우지 않는다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'c1')], [pref('c1', true)]);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '이것 좀 봐줘', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await settled(1);

    expect(n.sent).toHaveLength(0);
  });

  // 가드가 전부를 막으면 음소거가 아니라 알림 기능을 끈 것이다.
  it('음소거하지 않은 채널은 여전히 알린다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'c2')], [pref('c1', true)]);
    useAppStore.getState().upsertMessages('c2', [msg('m1', 'c2', 1, 'dev 쪽 멘션', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    expect(n.sent[0]!.title).toContain('dev');
    expect(n.sent[0]!.body).toBe('dev 쪽 멘션');
  });

  // 이 작업의 핵심 회귀선. 건너뛴 항목을 `announced` 에 넣지 않으면 음소거를 해제하는 순간
  // 그동안 묶여 있던 것이 한꺼번에 터진다 — 끄고 켜는 것이 폭탄의 뇌관이 되면 안 된다.
  it('음소거를 해제해도 그동안 쌓인 것이 한꺼번에 터지지 않는다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const arriving = [entry(1, 'm1', 'c1'), entry(2, 'm2', 'c1'), entry(3, 'm3', 'c1')];
    const { callbacks } = await started(n, arriving, [pref('c1', true)]);
    useAppStore.getState().upsertMessages('c1', [
      msg('m1', 'c1', 1, '하나', 'u2'), msg('m2', 'c1', 2, '둘', 'u2'), msg('m3', 'c1', 3, '셋', 'u2'),
    ]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await settled(3);
    expect(n.sent).toHaveLength(0);

    // 음소거 해제 — 토글이 서버 응답으로 스토어를 갱신하는 것과 같은 모양이다.
    const store = useAppStore.getState();
    store.set({ channelPrefs: { ...store.channelPrefs, c1: pref('c1', false) } });
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await settled(3);

    expect(n.sent).toHaveLength(0);

    // 해제한 뒤에 온 것은 다시 알린다 — 가드가 그 채널의 입을 영구히 막는 것이 아니다.
    arriving.push(entry(4, 'm4', 'c1'));
    useAppStore.getState().upsertMessages('c1', [msg('m4', 'c1', 4, '해제 뒤', 'u2')]);
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });

    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    expect(n.sent[0]!.body).toBe('해제 뒤');
  });
});

describe('음소거된 채널의 미읽음 배지', () => {
  const renderSidebar = () => {
    setController({
      openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      toggleChannelMute: vi.fn(), toggleChannelStar: vi.fn(),
    } as unknown as Controller);
    render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} onOpenDirectory={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />);
  };

  beforeEach(() => {
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
      channels: [chan('c1', 'general'), chan('c2', 'dev')],
      dms: [],
      unread: [
        { id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c1' },
        { id: 2, messageId: 'm2', reason: 'mention', readAt: null, channelId: 'c2' },
      ],
      channelPrefs: { c1: pref('c1', true) },
      connected: true,
    });
  });

  it('음소거한 채널에는 미읽음 배지가 뜨지 않는다', () => {
    renderSidebar();
    expect(screen.queryByTestId('unread-c1')).toBeNull();
  });

  it('음소거하지 않은 채널의 배지는 그대로다', () => {
    renderSidebar();
    expect(screen.getByTestId('unread-c2').textContent).toBe('1');
  });

  // 끄는 것은 알림과 배지이지 채널이 아니다. 목록에서 지우면 사용자는 새 대화가 있다는
  // 사실 자체를 잃고, 음소거를 되돌릴 자리(메뉴)까지 사라진다.
  it('음소거해도 채널은 목록에 남는다', () => {
    renderSidebar();
    expect(screen.getByText('general')).toBeTruthy();
  });
});

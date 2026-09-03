import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ChannelPrefRow, InboxEntry, NotifyLevel } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { DEFAULT_PREFS } from '../src/lib/prefs';
import { Sidebar } from '../src/components/Sidebar';
import { acc, accountsResult, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

/**
 * #224 회귀선 — 채널마다 알림 수준(`all`/`mentions`/`none`).
 *
 * #229 는 on/off 하나뿐인 스키마 위에서 "끄면 멘션도 끈다"로 갔고, 세분화가 생기면 그 결정을
 * 다시 정하라고 남겼다. 여기서 **뒤집지 않고 유지한다**: 덜 받고 싶은 사람에게는 `mentions`
 * 라는 자리가 따로 생겼으므로, `none` 을 고른 것은 정말로 전부 끄겠다는 뜻이다. 이 파일이
 * 그 결정의 증거다 — 없으면 "멘션은 예외였나?"가 세 번째로 논의된다.
 */

const entry = (id: number, messageId: string, channelId = 'c1',
  reason: InboxEntry['reason'] = 'mention'): InboxEntry =>
  ({ id, messageId, reason, readAt: null, channelId });

/**
 * `mutedAt` 을 **항상 채워 둔다.** 판정이 `notifyLevel` 만 본다는 것을 fixture 자체가
 * 강제한다 — 어느 코드가 `mutedAt` 을 다시 읽기 시작하면 `all`·`mentions` 테스트가 빨강이
 * 된다(#224 요구 7).
 */
const pref = (channelId: string, notifyLevel: NotifyLevel): ChannelPrefRow =>
  ({ accountId: 'u1', channelId, mutedAt: '2026-09-03T00:00:00.000Z', starredAt: null, notifyLevel, section: null, sortOrder: null });

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

/** message.created 경로는 이벤트 안에서 비동기로 돈다 — 매크로태스크 하나면 가라앉는다. */
const drained = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(notifier: ReturnType<typeof fakeNotifier>, arriving: InboxEntry[], prefs: ChannelPrefRow[]) {
  let calls = 0;
  const api = fakeApi({
    channels: vi.fn(async () => [chan('c1', 'general'), chan('c2', 'dev')]),
    accounts: vi.fn(async () => accountsResult([acc('u1', 'admin'), acc('u2', 'bot', 'agent')])),
    // 첫 조회(백로그)는 비어 있다 — 시작 시점에 쌓여 있던 것은 이미 '지나간 것'으로 표시되므로
    // 그 위에서는 수준 가드가 도는지 아닌지를 구분할 수 없다.
    inboxUnread: vi.fn(async () => (calls++ === 0 ? [] : arriving)),
    channelPrefs: vi.fn(async () => prefs),
  });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs, notifier);
  await c.start();
  if (prefs.length) await vi.waitFor(() => expect(Object.keys(useAppStore.getState().channelPrefs)).toHaveLength(prefs.length));
  return { c, callbacks };
}

beforeEach(() => {
  useAppStore.getState().reset();
  usePrefsStore.setState({ notifications: { ...DEFAULT_PREFS.notifications } });
  vi.restoreAllMocks();
});
afterEach(() => cleanup());

describe('채널 알림 수준 — 알림', () => {
  // 요구 1. 가드가 전부를 막으면 수준이 아니라 알림 기능을 끈 것이다.
  it("'all' 은 멘션을 지금처럼 알린다", async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'c1')], [pref('c1', 'all')]);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '이것 좀 봐줘', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    expect(n.sent[0]!.body).toBe('이것 좀 봐줘');
  });

  // 요구 1 의 나머지 절반 — 'all' 은 나를 부르지 않은 평범한 메시지까지 알린다.
  it("'all' 은 일반 메시지도 알린다", async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [], [pref('c1', 'all')]);

    callbacks.current!.onEvent({ type: 'message.created', message: msg('m9', 'c1', 9, '점심 뭐 먹지', 'u2'), audience: 'all' });
    await drained();

    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]!.body).toBe('점심 뭐 먹지');
  });

  // 요구 2. 'mentions' 는 나를 부른 것만 통과시킨다 — 이 둘이 같은 결과가 되면 수준이 셋이 아니다.
  it("'mentions' 는 멘션은 알리고 일반 메시지는 알리지 않는다", async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'c1')], [pref('c1', 'mentions')]);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '나를 부른 것', 'u2')]);

    // 일반 메시지 — 알리지 않는다.
    callbacks.current!.onEvent({ type: 'message.created', message: msg('m9', 'c1', 9, '그냥 잡담', 'u2'), audience: 'all' });
    await drained();
    expect(n.sent).toHaveLength(0);

    // 멘션 — 알린다.
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    expect(n.sent[0]!.body).toBe('나를 부른 것');
  });

  // 요구 3. #229 의 결정을 유지한다 — 'none' 에서는 멘션도 예외가 아니다.
  it("'none' 은 멘션도 알리지 않는다", async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'c1')], [pref('c1', 'none')]);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '이것 좀 봐줘', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await settled(1);
    callbacks.current!.onEvent({ type: 'message.created', message: msg('m9', 'c1', 9, '잡담', 'u2'), audience: 'all' });
    await drained();

    expect(n.sent).toHaveLength(0);
  });

  // 요구 4. 건너뛴 항목을 `announced` 에 넣지 않으면 수준을 올리는 순간 그동안 묶여 있던 것이
  // 한꺼번에 터진다 — 설정을 바꾸는 일이 폭탄의 뇌관이 되면 안 된다.
  it('수준을 올려도 그동안 쌓인 것이 한꺼번에 터지지 않는다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const arriving = [entry(1, 'm1', 'c1'), entry(2, 'm2', 'c1'), entry(3, 'm3', 'c1')];
    const { callbacks } = await started(n, arriving, [pref('c1', 'none')]);
    useAppStore.getState().upsertMessages('c1', [
      msg('m1', 'c1', 1, '하나', 'u2'), msg('m2', 'c1', 2, '둘', 'u2'), msg('m3', 'c1', 3, '셋', 'u2'),
    ]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await settled(3);
    expect(n.sent).toHaveLength(0);

    // none → all. 서버 응답으로 스토어를 갱신하는 것과 같은 모양이다.
    const store = useAppStore.getState();
    store.set({ channelPrefs: { ...store.channelPrefs, c1: pref('c1', 'all') } });
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await settled(3);
    expect(n.sent).toHaveLength(0);

    // 올린 뒤에 온 것은 다시 알린다 — 가드가 그 채널의 입을 영구히 막는 것이 아니다.
    arriving.push(entry(4, 'm4', 'c1'));
    useAppStore.getState().upsertMessages('c1', [msg('m4', 'c1', 4, '올린 뒤', 'u2')]);
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });

    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    expect(n.sent[0]!.body).toBe('올린 뒤');
  });

  // 요구 7. pref 행에 `mutedAt` 이 있어도 수준이 'all' 이면 알린다 — 판정이 두 곳을 함께
  // 읽고 있으면 여기서 빨강이 된다. `mutedAt` 은 "언제 껐나"라는 기록일 뿐이다.
  it('mutedAt 이 남아 있어도 수준이 all 이면 알린다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const withMutedAt: ChannelPrefRow = {
      accountId: 'u1', channelId: 'c1',
      mutedAt: '2026-09-03T00:00:00.000Z', starredAt: null, notifyLevel: 'all',
      section: null, sortOrder: null,
    };
    const { callbacks } = await started(n, [entry(1, 'm1', 'c1')], [withMutedAt]);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '기록은 기록일 뿐', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    expect(n.sent[0]!.body).toBe('기록은 기록일 뿐');
  });

  // 'all' 채널에서는 같은 메시지가 message.created 와 inbox.updated 두 경로로 온다.
  // 두 경로가 서로의 기록을 보지 않으면 멘션 하나에 알림이 두 번 뜬다.
  it("'all' 채널의 멘션은 두 경로가 겹쳐도 한 번만 울린다", async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'c1')], [pref('c1', 'all')]);

    callbacks.current!.onEvent({ type: 'message.created', message: msg('m1', 'c1', 1, '한 번만', 'u2'), audience: 'all' });
    await drained();
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await settled(1);

    expect(n.sent).toHaveLength(1);
  });

  // 요구 8. pref 행이 아예 없는 채널 — 아무도 아무것도 고르지 않은 상태다. 여기가 'all' 이면
  // 업데이트하는 순간 모든 채널의 모든 메시지가 OS 알림이 된다. 기본값은 024 이전 동작과
  // 같아야 한다: 나를 부른 것만 알린다.
  it('pref 를 정한 적 없는 채널은 일반 메시지를 알리지 않는다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [], []);

    callbacks.current!.onEvent({ type: 'message.created', message: msg('m9', 'c1', 9, '잡담', 'u2'), audience: 'all' });
    await drained();

    expect(n.sent).toHaveLength(0);
  });

  // 같은 기본값의 나머지 절반 — 조용해지는 것이지 꺼지는 것이 아니다. 나를 부르면 알린다.
  it('pref 를 정한 적 없는 채널도 멘션은 알린다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'c1')], []);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '불렀다', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    expect(n.sent[0]!.body).toBe('불렀다');
  });

  // 내가 쓴 글에 내가 알림을 받으면 알림이 소음이 된다.
  it('내가 쓴 메시지는 알리지 않는다', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [], [pref('c1', 'all')]);

    callbacks.current!.onEvent({ type: 'message.created', message: msg('m9', 'c1', 9, '내 글', 'u1'), audience: 'all' });
    await drained();

    expect(n.sent).toHaveLength(0);
  });
});

describe('채널 알림 수준 — 미읽음 배지', () => {
  const renderSidebar = () => {
    setController({
      openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
    } as unknown as Controller);
    render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} onOpenDirectory={vi.fn()} onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()} onOpenSaved={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
  };

  beforeEach(() => {
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
      channels: [chan('c1', 'quiet'), chan('c2', 'partly'), chan('c3', 'loud')],
      dms: [],
      unread: [
        { id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c1' },
        { id: 2, messageId: 'm2', reason: 'mention', readAt: null, channelId: 'c2' },
        { id: 3, messageId: 'm3', reason: 'mention', readAt: null, channelId: 'c3' },
      ],
      channelPrefs: {
        c1: pref('c1', 'none'),
        c2: pref('c2', 'mentions'),
        c3: pref('c3', 'all'),
      },
      connected: true,
    });
  });

  // 요구 5. 배지는 'none' 에서만 꺼진다. 'mentions' 는 "덜 알리겠다"이지 "숫자도 보지
  // 않겠다"가 아니다 — 그 채널에서 멘션 알림은 여전히 오므로, 배지를 지우면 알림과 화면이
  // 서로 다른 말을 하게 된다.
  it("배지는 'none' 에서만 꺼진다", () => {
    renderSidebar();
    expect(screen.queryByTestId('unread-c1')).toBeNull();
    expect(screen.getByTestId('unread-c2').textContent).toBe('1');
    expect(screen.getByTestId('unread-c3').textContent).toBe('1');
  });

  // 끄는 것은 알림과 배지이지 채널이 아니다.
  it("'none' 이어도 채널은 목록에 남는다", () => {
    renderSidebar();
    expect(screen.getByText('quiet')).toBeTruthy();
  });
});

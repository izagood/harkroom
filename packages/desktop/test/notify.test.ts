import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InboxEntry } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { DEFAULT_PREFS } from '../src/lib/prefs';
import { acc, accountsResult, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

const entry = (id: number, messageId: string, reason: InboxEntry['reason'] = 'mention'): InboxEntry =>
  ({ id, messageId, reason, readAt: null, channelId: 'c1' });

function fakeNotifier() {
  const sent: { title: string; body: string }[] = [];
  return { sent, notify: vi.fn(async (n: { title: string; body: string }) => { sent.push(n); }) };
}

/** 창이 포커스를 갖고 있는지 — 알림 여부를 가르는 조건이다. */
const setFocus = (focused: boolean) => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
};

beforeEach(() => {
  useAppStore.getState().reset();
  usePrefsStore.setState({ notifications: { ...DEFAULT_PREFS.notifications } });
  vi.restoreAllMocks();
});

/** 시작 시점의 미읽음(backlog)과 그 뒤에 도착하는 미읽음을 나눠 준다 — 실제 흐름과 같다. */
async function started(
  notifier: ReturnType<typeof fakeNotifier>,
  arriving: InboxEntry[] = [],
  backlog: InboxEntry[] = [],
) {
  let calls = 0;
  const api = fakeApi({
    channels: vi.fn(async () => [chan('c1', 'general')]),
    accounts: vi.fn(async () => accountsResult([acc('u1', 'admin'), acc('u2', 'bot', 'agent')])),
    inboxUnread: vi.fn(async () => (++calls === 1 ? backlog : arriving)),
  });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs, notifier);
  await c.start();
  return { c, api, callbacks };
}

describe('mention notifications', () => {
  it('announces a new unread mention while the window is in the background', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1')]);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '이것 좀 봐줘', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    expect(n.sent[0]!.title).toContain('bot');
    expect(n.sent[0]!.title).toContain('general');
    expect(n.sent[0]!.body).toBe('이것 좀 봐줘');
  });

  // 보고 있는 창에 알림을 띄우는 것은 방해다 — 배지가 이미 그 일을 한다.
  it('stays quiet while the window has focus', async () => {
    setFocus(true);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await new Promise((r) => setTimeout(r, 20));

    expect(n.sent).toHaveLength(0);
  });

  // 같은 항목이 여러 번 알려지면 알림이 쓸모없어진다.
  it('announces each inbox entry at most once', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await new Promise((r) => setTimeout(r, 20));

    expect(n.sent).toHaveLength(1);
  });

  // 앱을 열 때 쌓여 있던 미읽음은 이미 지난 일이다. 그 뒤 새 멘션 하나가 오면 그것만 알려야 하고,
  // 백로그까지 한꺼번에 터지면 알림이 소음이 된다.
  it('announces only what arrived after startup, not the backlog', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const backlog = [entry(1, 'm1'), entry(2, 'm2')];
    const { callbacks } = await started(n, [...backlog, entry(3, 'm3')], backlog);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));

    expect(n.sent).toHaveLength(1);
  });

  it('names the reason when the message body is not loaded', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'unknown-msg', 'dm')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    expect(n.sent[0]!.body.length).toBeGreaterThan(0);
  });

  it('ignores inbox events for other accounts', async () => {
    setFocus(false);
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'someone-else' });
    await new Promise((r) => setTimeout(r, 20));

    expect(n.sent).toHaveLength(0);
  });

  // 끈 동안 도착한 것을 '이미 지나간 것'으로 표시하지 않으면, 사용자가 알림을 켜는 순간
  // 그동안 쌓인 미읽음이 한꺼번에 터진다. 켜고 끄는 것이 폭탄의 뇌관이 되면 안 된다.
  it('stays silent while off, and does not replay the backlog when switched on', async () => {
    setFocus(false);
    usePrefsStore.getState().setNotifications({ enabled: false });
    const n = fakeNotifier();
    const arriving = [entry(1, 'm1')];
    const { callbacks } = await started(n, arriving);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, 'while off', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    // 조회 '호출 횟수'는 배리어가 못 된다 — 알림 판정은 refreshUnread().then(...) 안에서
    // 그 뒤에 돈다. 스토어 반영을 기다린 뒤 매크로태스크로 한 번 넘겨 그 then 까지 비운다.
    await vi.waitFor(() => expect(useAppStore.getState().unread).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(n.sent).toHaveLength(0);

    usePrefsStore.getState().setNotifications({ enabled: true });
    arriving.push(entry(2, 'm2'));
    useAppStore.getState().upsertMessages('c1', [msg('m2', 'c1', 2, 'after', 'u2')]);
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });

    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    expect(n.sent[0]!.body).toBe('after');
  });

  it('honours per-reason toggles', async () => {
    setFocus(false);
    usePrefsStore.getState().setNotifications({ dm: false });
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1', 'dm'), entry(2, 'm2', 'mention')]);
    useAppStore.getState().upsertMessages('c1', [
      msg('m1', 'c1', 1, 'dm body', 'u2'),
      msg('m2', 'c1', 2, 'mention body', 'u2'),
    ]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    expect(n.sent[0]!.body).toBe('mention body');
  });

  // 미리보기를 끄는 이유는 잠금화면에 대화 내용이 뜨는 것이다. 누가·어디서는 가릴 이유가 없다.
  it('omits the message body when previews are off, keeping the title', async () => {
    setFocus(false);
    usePrefsStore.getState().setNotifications({ showPreview: false });
    const n = fakeNotifier();
    const { callbacks } = await started(n, [entry(1, 'm1')]);
    useAppStore.getState().upsertMessages('c1', [msg('m1', 'c1', 1, 'secret text', 'u2')]);

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));
    expect(n.sent[0]!.body).toBe('New mention');
    expect(n.sent[0]!.title).toContain('bot');
    expect(n.sent[0]!.title).toContain('general');
  });
});

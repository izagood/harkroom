import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { WsCallbacks, connectWs } from '../src/lib/ws';
import {
  getCommunityConnected,
  resetCommunityRegistry,
  useActiveStore,
  useCommunityRegistry,
  type CommunityEntry,
} from '../src/state/communities';
import { setController, startCommunitySession, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { DEFAULT_PREFS } from '../src/lib/prefs';
import { acc, accountsResult, chan, fakeApi, msg } from './helpers/fakeApi';

/**
 * 커뮤니티마다 스토어·컨트롤러 인스턴스를 둔다(#166, #163 결정 A).
 *
 * 여기서 지키는 것은 **격리가 구조로 강제되는가**다. 스토어 키는 `channelId`(UUID)라
 * 커뮤니티가 달라도 충돌하지 않는다 — 그래서 "A 의 메시지가 B 의 채널에 붙는" 사고는
 * 타입 검사에도 기존 테스트에도 걸리지 않는다. 잡을 수 있는 자리는 인스턴스가 정말로
 * 둘인가, 활성 전환이 정말로 다른 인스턴스를 가리키는가뿐이다.
 */

/** `connectWs` 호출을 **센다** — 커뮤니티마다 연결이 하나씩 붙는지 보려면 수가 필요하다. */
function countingWsFactory() {
  const urls: string[] = [];
  const callbacks: WsCallbacks[] = [];
  const makeWs = ((url: string, _getTicket: unknown, cb: WsCallbacks) => {
    urls.push(url);
    callbacks.push(cb);
    return { close: vi.fn(), send: vi.fn() };
  }) as unknown as typeof connectWs;
  return { makeWs, urls, callbacks };
}

/** 사이드바는 컨트롤러를 부른다. 커뮤니티마다 하나씩 꽂아야 전환 뒤에도 화면이 선다. */
const fakeController = () => ({
  openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
  createChannel: vi.fn(), updateChannel: vi.fn(),
  setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
}) as unknown as Controller;

async function twoCommunities() {
  const ws = countingWsFactory();
  const a = await startCommunitySession({
    baseUrl: 'https://a.example', token: 't-a', active: true, accountId: 'acct-a', label: null,
    api: fakeApi({ baseUrl: 'https://a.example' }), makeWs: ws.makeWs,
  });
  const b = await startCommunitySession({
    baseUrl: 'https://b.example', token: 't-b', active: false, accountId: 'acct-b', label: null,
    api: fakeApi({ baseUrl: 'https://b.example' }), makeWs: ws.makeWs,
  });
  return { a, b, ws };
}

/** 사이드바가 서려면 필요한 최소 상태. 커뮤니티마다 **다른 handle** 을 준다(#166 §6). */
function seed(entry: CommunityEntry, handle: string, connected: boolean) {
  const me = acc('u1', handle, 'human', true);
  entry.store.getState().set({
    me, accounts: { u1: me }, channels: [chan('c1', 'general')], dms: [],
    unread: [], online: [], connected, activeChannelId: 'c1',
  });
  useCommunityRegistry.getState().attachController(entry.id, fakeController());
}

const renderSidebar = () => render(
  <Sidebar
    onLogout={() => {}} onOpenSettings={() => {}} onOpenDirectory={() => {}}
    onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenSaved={() => {}}
    collapsed={false} onToggleCollapse={() => {}}
  />,
);

/** 알림기 하나. 제목이 커뮤니티를 드러내는지만 본다. */
function fakeNotifier() {
  const sent: { title: string; body: string }[] = [];
  return { sent, notify: vi.fn(async (n: { title: string; body: string }) => { sent.push(n); }) };
}

/** 멘션 하나가 뒤늦게 도착하는 커뮤니티를 띄운다 — `notify.test.ts` 와 같은 흐름이다. */
async function communityWithMention(baseUrl: string, active: boolean, notifier: ReturnType<typeof fakeNotifier>) {
  let calls = 0;
  const api = fakeApi({
    baseUrl,
    channels: vi.fn(async () => [chan('c1', 'general')]),
    accounts: vi.fn(async () => accountsResult([acc('u1', 'admin'), acc('u2', 'bot', 'agent')])),
    inboxUnread: vi.fn(async () => (++calls === 1
      ? []
      : [{ id: 1, messageId: 'm1', reason: 'mention' as const, readAt: null, channelId: 'c1' }])),
  });
  const ws = countingWsFactory();
  const entry = await startCommunitySession({
    baseUrl, token: 't', active, accountId: `acct-${baseUrl}`, label: null, api, makeWs: ws.makeWs, notifier,
  });
  entry.store.getState().upsertMessages('c1', [msg('m1', 'c1', 1, '이것 좀 봐줘', 'u2')]);
  return { entry, ws };
}

beforeEach(() => {
  resetCommunityRegistry();
  usePrefsStore.setState({ notifications: { ...DEFAULT_PREFS.notifications } });
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('커뮤니티마다 스토어·컨트롤러 인스턴스 (#166)', () => {
  it('2. 두 커뮤니티를 등록하면 스토어가 둘이고 서로의 상태를 안 본다', async () => {
    const { a, b } = await twoCommunities();

    expect(useCommunityRegistry.getState().entries).toHaveLength(2);
    expect(a.store).not.toBe(b.store);
    expect(a.controller).not.toBe(b.controller);

    a.store.getState().upsertMessages('c1', [msg('m1', 'c1', 1, 'A 의 메시지', 'u2')]);

    expect(a.store.getState().messages['c1']).toHaveLength(1);
    // `channelId` 는 UUID 라 두 커뮤니티에서 같은 키가 나올 수 있다. 스토어가 하나면
    // 이 단언이 조용히 통과한다 — 그것이 이 이슈가 막는 사고다.
    expect(b.store.getState().messages['c1']).toBeUndefined();
  });

  it('3. 활성을 바꾸면 useActiveStore 가 다른 스토어를 돌려준다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'alice', true);
    seed(b, 'bob', true);

    expect(useActiveStore.getState().me?.handle).toBe('alice');

    useCommunityRegistry.getState().setActive(b.id);

    expect(useActiveStore.getState().me?.handle).toBe('bob');
    // 전환은 화면이 보는 것을 바꿀 뿐이다 — A 의 세계는 그대로 살아 있어야 알림이 온다.
    expect(a.store.getState().me?.handle).toBe('alice');
  });

  it('4. reset() 은 커뮤니티 목록을 비우지 않는다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'alice', true);

    a.store.getState().reset();

    // 로그아웃은 **그 커뮤니티의 세계**를 비우는 동작이다. 레지스트리가 `AppState` 안에
    // 있으면 커뮤니티 하나에서 로그아웃한 것만으로 나머지 목록까지 사라진다.
    expect(useCommunityRegistry.getState().entries.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(useCommunityRegistry.getState().activeId).toBe(a.id);
    expect(a.store.getState().me).toBeNull();
    expect(b.store.getState()).toBeDefined();
  });

  it('5. WS 는 커뮤니티마다 하나씩 붙는다', async () => {
    const { ws } = await twoCommunities();

    // 수를 센다: 하나만 붙으면 보고 있지 않은 커뮤니티에 알림이 오지 않고, 그 실패는
    // 조용하다(화면에는 아무 일도 안 일어난다).
    expect(ws.urls).toHaveLength(2);
    expect(ws.urls).toEqual(['https://a.example', 'https://b.example']);
    expect(ws.callbacks[0]).not.toBe(ws.callbacks[1]);
  });

  it('6. 보고 있지 않은 커뮤니티도 이벤트로 미읽음이 갱신된다', async () => {
    const { a, b, ws } = await twoCommunities();

    // 두 번째 연결이 B 의 것이다. B 는 비활성이고 `activeChannelId` 가 null 이라
    // 히스토리는 늦게 받지만, 미읽음·알림은 지금 갱신돼야 한다.
    ws.callbacks[1]!.onEvent({
      type: 'message.created', message: msg('m1', 'c1', 1, '너 불렀어', 'u2'), audience: 'all',
    });

    expect(b.store.getState().reads['c1']?.unread).toBe(1);
    expect(a.store.getState().reads['c1']).toBeUndefined();
  });

  it('7. connected 는 커뮤니티별이고 사이드바 점은 활성 커뮤니티의 값을 읽는다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'alice', true);
    seed(b, 'bob', false);

    expect(getCommunityConnected()).toEqual([
      { id: a.id, connected: true },
      { id: b.id, connected: false },
    ]);

    renderSidebar();
    expect(screen.getByTitle('connected')).toBeTruthy();

    cleanup();
    useCommunityRegistry.getState().setActive(b.id);
    renderSidebar();

    // 전역 플래그 하나로 합치면 "셋 중 하나가 끊겼다" 가 "끊김" 으로 뭉쳐 거짓말이 된다.
    expect(screen.getByTitle('disconnected')).toBeTruthy();
  });

  it('8. me 가 커뮤니티마다 다를 때 화면은 활성 커뮤니티의 것을 보인다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'alice', true);
    seed(b, 'bob', true);

    renderSidebar();
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.queryByText('@bob')).toBeNull();

    cleanup();
    useCommunityRegistry.getState().setActive(b.id);
    renderSidebar();

    // 같은 사람이 커뮤니티마다 다른 handle 을 쓴다. 활성이 아닌 쪽의 handle 을 보이면
    // 사용자는 자기가 누구로 말하고 있는지 잘못 안다.
    expect(screen.getByText('@bob')).toBeTruthy();
    expect(screen.queryByText('@alice')).toBeNull();
  });

  it('§6. 커뮤니티가 하나뿐이면 알림 제목이 오늘과 같다', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const n = fakeNotifier();
    const { ws } = await communityWithMention('https://a.example', true, n);

    ws.callbacks[0]!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    // 하나뿐인데 이름을 붙이면 사용자 눈에 보이는 변화가 생긴다 — 이 이슈의 성공 기준은 0 이다.
    expect(n.sent[0]!.title).toBe('@bot mentioned you in #general');
  });

  it('§6. 커뮤니티가 둘이면 알림 제목이 어느 커뮤니티인지 드러낸다', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const n = fakeNotifier();
    await communityWithMention('https://a.example', true, fakeNotifier());
    const { ws } = await communityWithMention('https://b.example', false, n);

    ws.callbacks[0]!.onEvent({ type: 'inbox.updated', accountId: 'u1' });
    await vi.waitFor(() => expect(n.sent).toHaveLength(1));

    // 같은 이름의 채널이 커뮤니티마다 있다. 제목만으로는 어디서 온 것인지 알 수 없다.
    expect(n.sent[0]!.title).toBe('@bot mentioned you in #general (b.example)');
  });

  it('setController 는 활성 커뮤니티의 컨트롤러만 바꾼다', async () => {
    const { a, b } = await twoCommunities();
    const fake = fakeController();

    setController(fake);

    const entries = useCommunityRegistry.getState().entries;
    expect(entries.find((e) => e.id === a.id)!.controller).toBe(fake);
    expect(entries.find((e) => e.id === b.id)!.controller).toBe(b.controller);
  });

  it('같은 커뮤니티에 다시 로그인해도 목록이 늘지 않는다', async () => {
    const ws = countingWsFactory();
    await startCommunitySession({
      baseUrl: 'https://a.example', token: 't-a', active: true, accountId: 'acct-a', label: null,
      api: fakeApi(), makeWs: ws.makeWs,
    });
    await startCommunitySession({
      baseUrl: 'https://a.example', token: 't-a2', active: true, accountId: 'acct-a', label: null,
      api: fakeApi(), makeWs: ws.makeWs,
    });

    // 재로그인마다 엔트리가 붙으면 죽은 커뮤니티가 쌓이고, 그것만으로 알림 제목에
    // 커뮤니티 꼬리표가 붙어 사용자 눈에 보이는 변화가 생긴다(§7 의 성공 기준).
    expect(useCommunityRegistry.getState().entries).toHaveLength(1);
  });
});

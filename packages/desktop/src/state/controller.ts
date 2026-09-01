import type { WsServerEvent } from '@murmur/shared';
import type { ApiClient } from '../lib/api';
import { connectWs, type WsHandle } from '../lib/ws';
import { sessionStore } from '../lib/session';
import { silentNotifier, type Notifier } from '../lib/notify';
import { useAppStore } from './appStore';

export class Controller {
  private ws: WsHandle | null = null;
  private unreadFetchSeq = 0;
  /** 히스토리를 이미 통째로 받은 채널. 이 집합에 없으면 openChannel이 증분이 아니라 전체를 받는다. */
  private loadedChannels = new Set<string>();
  /** 이미 알린 inbox 항목. 같은 항목을 두 번 알리면 알림이 쓸모없어진다. */
  private announced = new Set<number>();

  constructor(
    public api: ApiClient,
    private makeWs: typeof connectWs = connectWs,
    private notifier: Notifier = silentNotifier,
  ) {}

  // fire-and-forget 호출의 unhandled rejection 방지 — 실패는 조용히 무시(다음 이벤트/리컨실이 자연 복구).
  private swallow(p: Promise<unknown>): void { void p.catch(() => {}); }

  async start(): Promise<void> {
    const store = useAppStore.getState();
    const [me, accounts, channels, dms, leases, unread] = await Promise.all([
      this.api.me(), this.api.accounts(), this.api.channels(),
      this.api.dms(), this.api.leases(), this.api.inboxUnread(),
    ]);
    store.set({
      me, channels, dms, leases, unread,
      accounts: Object.fromEntries(accounts.map((a) => [a.id, a])),
    });
    // 앱을 열자마자 쌓여 있던 미읽음이 한꺼번에 터지면 알림이 소음이 된다.
    for (const e of unread) this.announced.add(e.id);
    // 장기 토큰은 ApiClient 가 헤더로만 쓴다 — WS URL 에는 단기 티켓만 실린다.
    this.ws = this.makeWs(this.api.baseUrl, () => this.api.wsTicket(), {
      onEvent: (e) => this.handleEvent(e),
      onOpen: () => { useAppStore.getState().set({ connected: true }); this.swallow(this.reconcile()); },
      onDown: () => useAppStore.getState().set({ connected: false }),
    });
  }

  stop(): void { this.ws?.close(); this.ws = null; }

  private handleEvent(e: WsServerEvent): void {
    const store = useAppStore.getState();
    switch (e.type) {
      case 'message.created':
        store.upsertMessages(e.message.channelId, [e.message]);
        // 서버는 기동 시 투영용 system 계정을 만든다 — 그보다 먼저 부트스트랩한 클라이언트는
        // 그 계정을 모르고, 작성자가 '…'로 표시된다. 디렉터리는 정적이 아니다.
        if (!store.accounts[e.message.authorId]) this.swallow(this.refreshAccounts());
        break;
      case 'message.updated':
        // 같은 id 로 덮어쓰면 upsert 가 제자리 교체한다.
        store.upsertMessages(e.message.channelId, [e.message]);
        break;
      case 'message.deleted':
        store.removeMessage(e.channelId, e.messageId);
        break;
      case 'inbox.updated':
        if (e.accountId === store.me?.id) {
          this.swallow(this.refreshUnread().then(() => this.announceNewMentions()));
        }
        break;
      case 'lease.changed':
        this.swallow(this.api.leases().then((leases) => useAppStore.getState().set({ leases })));
        break;
      case 'presence.snapshot':
        store.set({ online: e.online });
        break;
      case 'presence.changed': {
        const cur = new Set(useAppStore.getState().online);
        if (e.online) cur.add(e.accountId); else cur.delete(e.accountId);
        store.set({ online: [...cur] });
        break;
      }
    }
  }

  private async reconcile(): Promise<void> {
    const { activeChannelId, messages } = useAppStore.getState();
    if (activeChannelId) {
      const maxSeq = Math.max(0, ...(messages[activeChannelId] ?? []).map((m) => m.seq));
      const page = await this.api.messages(activeChannelId, { since: maxSeq });
      useAppStore.getState().upsertMessages(activeChannelId, page.messages);
    }
    await this.refreshUnread();
    useAppStore.getState().set({ leases: await this.api.leases() });
  }

  /** 미지의 작성자가 연달아 오면 요청이 폭주하므로, 진행 중인 조회 하나에 합류시킨다. */
  private accountsInFlight: Promise<void> | null = null;
  private refreshAccounts(): Promise<void> {
    this.accountsInFlight ??= this.api
      .accounts()
      .then((accounts) => {
        useAppStore.getState().set({ accounts: Object.fromEntries(accounts.map((a) => [a.id, a])) });
      })
      .finally(() => { this.accountsInFlight = null; });
    return this.accountsInFlight;
  }

  /** 새로 들어온 미읽음을 OS 알림으로 알린다. 보고 있는 창에는 띄우지 않는다 — 배지가 그 일을 한다. */
  private async announceNewMentions(): Promise<void> {
    const { unread, me, channels, dms, accounts, messages } = useAppStore.getState();
    if (document.hasFocus()) {
      // 포커스 중에는 알리지 않되, 본 것으로 처리해 나중에 뒤늦게 터지지 않게 한다.
      for (const e of unread) this.announced.add(e.id);
      return;
    }

    const label = { mention: 'mentioned you in', thread_reply: 'replied in a thread in', dm: 'messaged you in' };
    for (const e of unread) {
      if (e.readAt || this.announced.has(e.id)) continue;
      this.announced.add(e.id);

      const row = (messages[e.channelId] ?? []).find((m) => m.id === e.messageId);
      const author = row ? accounts[row.authorId]?.handle : null;
      const channel = channels.find((c) => c.id === e.channelId);
      const dm = dms.find((d) => d.id === e.channelId);
      const where = channel
        ? `#${channel.name}`
        : dm
          ? dm.memberIds.filter((id) => id !== me?.id).map((id) => accounts[id]?.handle ?? '…').join(', ')
          : 'murmur';

      await this.notifier.notify({
        title: `${author ? `@${author} ` : ''}${label[e.reason]} ${where}`.trim(),
        // 본문이 스토어에 없으면(창 밖으로 밀려난 채널 등) 이유만으로도 알림은 성립한다.
        body: row?.body ?? `New ${e.reason.replace('_', ' ')}`,
      });
    }
  }

  // 단조 버전 가드 — 나중에 발행됐지만 먼저 도착한 응답만 반영되도록, stale 응답은 버린다.
  private async refreshUnread(): Promise<void> {
    const seq = ++this.unreadFetchSeq;
    const entries = await this.api.inboxUnread();
    if (seq === this.unreadFetchSeq) useAppStore.getState().set({ unread: entries });
  }

  async openChannel(channelId: string): Promise<void> {
    const store = useAppStore.getState();
    store.set({ activeChannelId: channelId, threadRootId: null });
    // 투영된 system 메시지는 사용자가 그 채널을 보고 있지 않아도 WS로 들어와 maxSeq를 올린다.
    // 그 상태에서 증분 조회를 하면 backlog 전체가 건너뛰어져 채널이 거의 비어 보인다 —
    // 그래서 처음 여는 채널은 히스토리를 통째로 받는다(since=0 → 서버가 최신 N개를 준다).
    const since = this.loadedChannels.has(channelId)
      ? Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq))
      : 0;
    const page = await this.api.messages(channelId, { since });
    this.loadedChannels.add(channelId);
    useAppStore.getState().upsertMessages(channelId, page.messages);
    useAppStore.getState().set({
      hasMore: { ...useAppStore.getState().hasMore, [channelId]: page.hasMore },
    });
    const ids = useAppStore.getState().unread
      .filter((e) => e.channelId === channelId && !e.readAt)
      .map((e) => e.id);
    if (ids.length) {
      await this.api.markRead(ids);
      await this.refreshUnread();
    }
  }

  async openThread(rootId: string): Promise<void> {
    const channelId = useAppStore.getState().activeChannelId;
    if (!channelId) return;
    useAppStore.getState().set({ threadRootId: rootId });
    const page = await this.api.messages(channelId, { thread: rootId });
    useAppStore.getState().upsertMessages(channelId, page.messages);
  }

  /** 상단에 도달했을 때 한 페이지 더 과거로. 남은 게 없으면 요청하지 않는다. */
  async loadOlder(): Promise<void> {
    const { activeChannelId, messages, hasMore } = useAppStore.getState();
    if (!activeChannelId || !hasMore[activeChannelId]) return;
    const rows = messages[activeChannelId] ?? [];
    if (!rows.length) return;
    const oldest = Math.min(...rows.map((m) => m.seq));

    const page = await this.api.messages(activeChannelId, { before: oldest });
    useAppStore.getState().upsertMessages(activeChannelId, page.messages);
    useAppStore.getState().set({
      hasMore: { ...useAppStore.getState().hasMore, [activeChannelId]: page.hasMore },
    });
  }

  closeThread(): void { useAppStore.getState().set({ threadRootId: null }); }

  async send(body: string): Promise<void> {
    const { activeChannelId } = useAppStore.getState();
    if (!activeChannelId || !body.trim()) return;
    const m = await this.api.postMessage(activeChannelId, body, undefined, crypto.randomUUID());
    useAppStore.getState().upsertMessages(activeChannelId, [m]);
  }

  async reply(body: string): Promise<void> {
    const { activeChannelId, threadRootId } = useAppStore.getState();
    if (!activeChannelId || !threadRootId || !body.trim()) return;
    const m = await this.api.postMessage(activeChannelId, body, threadRootId, crypto.randomUUID());
    useAppStore.getState().upsertMessages(activeChannelId, [m]);
  }

  async editMessage(messageId: string, body: string): Promise<void> {
    const { activeChannelId } = useAppStore.getState();
    if (!activeChannelId || !body.trim()) return;
    const updated = await this.api.editMessage(activeChannelId, messageId, body);
    useAppStore.getState().upsertMessages(activeChannelId, [updated]);
  }

  async deleteMessage(messageId: string): Promise<void> {
    const { activeChannelId } = useAppStore.getState();
    if (!activeChannelId) return;
    await this.api.deleteMessage(activeChannelId, messageId);
    useAppStore.getState().removeMessage(activeChannelId, messageId);
  }

  async startDm(accountId: string): Promise<void> {
    const dm = await this.api.createDm([accountId]);
    useAppStore.getState().set({ dms: await this.api.dms() });
    await this.openChannel(dm.id);
  }

  logout(): void {
    // 서버 세션 폐기를 **발사하되 기다리지 않는다.** 응답을 기다리면 오프라인일 때 로그아웃이
    // 멈추고, 실패해도 로컬은 반드시 비워야 한다 — 안 그러면 사용자가 로그인 상태에 갇힌다.
    // 남은 서버 세션은 TTL 만료와 소켓 재검증 sweep 이 정리한다.
    this.swallow(this.api.logout());
    this.stop();
    sessionStore.clear();
    useAppStore.getState().reset();
  }
}

let current: Controller | null = null;
export function setController(c: Controller | null): void { current = c; }
export function getController(): Controller {
  if (!current) throw new Error('controller not initialized');
  return current;
}

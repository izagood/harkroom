import type { WsServerEvent } from '@murmur/shared';
import type { ApiClient } from '../lib/api';
import { connectWs, type WsHandle } from '../lib/ws';
import { sessionStore } from '../lib/session';
import { useAppStore } from './appStore';

export class Controller {
  private ws: WsHandle | null = null;

  constructor(
    public api: ApiClient,
    private makeWs: typeof connectWs = connectWs,
    private token: string | null = null,
  ) {}

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
    this.ws = this.makeWs(this.api.baseUrl, this.token ?? '', {
      onEvent: (e) => this.handleEvent(e),
      onOpen: () => { useAppStore.getState().set({ connected: true }); void this.reconcile(); },
      onDown: () => useAppStore.getState().set({ connected: false }),
    });
  }

  stop(): void { this.ws?.close(); this.ws = null; }

  private handleEvent(e: WsServerEvent): void {
    const store = useAppStore.getState();
    switch (e.type) {
      case 'message.created':
        store.upsertMessages(e.message.channelId, [e.message]);
        break;
      case 'inbox.updated':
        if (e.accountId === store.me?.id) void this.refreshUnread();
        break;
      case 'lease.changed':
        void this.api.leases().then((leases) => useAppStore.getState().set({ leases }));
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
      const rows = await this.api.messages(activeChannelId, { since: maxSeq });
      useAppStore.getState().upsertMessages(activeChannelId, rows);
    }
    await this.refreshUnread();
    useAppStore.getState().set({ leases: await this.api.leases() });
  }

  private async refreshUnread(): Promise<void> {
    useAppStore.getState().set({ unread: await this.api.inboxUnread() });
  }

  async openChannel(channelId: string): Promise<void> {
    const store = useAppStore.getState();
    store.set({ activeChannelId: channelId, threadRootId: null });
    const maxSeq = Math.max(0, ...(store.messages[channelId] ?? []).map((m) => m.seq));
    const rows = await this.api.messages(channelId, { since: maxSeq });
    useAppStore.getState().upsertMessages(channelId, rows);
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
    const rows = await this.api.messages(channelId, { thread: rootId });
    useAppStore.getState().upsertMessages(channelId, rows);
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

  async startDm(accountId: string): Promise<void> {
    const dm = await this.api.createDm([accountId]);
    useAppStore.getState().set({ dms: await this.api.dms() });
    await this.openChannel(dm.id);
  }

  logout(): void {
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

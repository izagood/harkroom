import { create } from 'zustand';
import type { AccountView, ChannelRow, DmView, InboxEntry, LeaseRow, MessageRow } from '@murmur/shared';

export interface AppState {
  me: AccountView | null;
  accounts: Record<string, AccountView>;
  channels: ChannelRow[];
  dms: DmView[];
  activeChannelId: string | null;
  threadRootId: string | null;
  messages: Record<string, MessageRow[]>;
  /** 채널별 '더 오래된 것이 남았는가'. */
  hasMore: Record<string, boolean>;
  unread: InboxEntry[];
  online: string[];
  leases: LeaseRow[];
  connected: boolean;
  set(partial: Partial<AppState>): void;
  upsertMessages(channelId: string, rows: MessageRow[]): void;
  removeMessage(channelId: string, messageId: string): void;
  reset(): void;
}

const initial = {
  me: null, accounts: {}, channels: [], dms: [], activeChannelId: null, threadRootId: null,
  messages: {}, hasMore: {}, unread: [], online: [], leases: [], connected: false,
};

export const useAppStore = create<AppState>((set, get) => ({
  ...initial,
  set: (partial) => set(partial),
  upsertMessages: (channelId, rows) => {
    const byId = new Map((get().messages[channelId] ?? []).map((m) => [m.id, m]));
    for (const r of rows) byId.set(r.id, r);
    const merged = [...byId.values()].sort((a, b) => a.seq - b.seq);
    set({ messages: { ...get().messages, [channelId]: merged } });
  },
  removeMessage: (channelId, messageId) => {
    const rows = get().messages[channelId];
    if (!rows) return;
    set({ messages: { ...get().messages, [channelId]: rows.filter((m) => m.id !== messageId) } });
  },
  reset: () => set({ ...initial }),
}));

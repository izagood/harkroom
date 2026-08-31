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
  unread: InboxEntry[];
  online: string[];
  leases: LeaseRow[];
  connected: boolean;
  set(partial: Partial<AppState>): void;
  upsertMessages(channelId: string, rows: MessageRow[]): void;
  reset(): void;
}

const initial = {
  me: null, accounts: {}, channels: [], dms: [], activeChannelId: null, threadRootId: null,
  messages: {}, unread: [], online: [], leases: [], connected: false,
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
  reset: () => set({ ...initial }),
}));

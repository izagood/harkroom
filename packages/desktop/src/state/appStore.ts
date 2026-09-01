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
  /** 채널별 읽음 상태(서버 진실). 사이드바 배지가 여기서 나온다. */
  reads: Record<string, { lastReadSeq: number; unread: number }>;
  /**
   * 채널을 **열 때** 얼려 둔 읽음 위치. 구분선은 이 값으로 그린다 — 라이브 `reads` 를 쓰면
   * 열자마자 읽음 처리가 돌아 구분선이 즉시 사라져 아무 쓸모가 없다.
   */
  dividerSeq: Record<string, number>;
  online: string[];
  leases: LeaseRow[];
  connected: boolean;
  set(partial: Partial<AppState>): void;
  upsertMessages(channelId: string, rows: MessageRow[]): void;
  applyReaction(channelId: string, messageId: string, emoji: string, accountId: string, on: boolean): void;
  removeMessage(channelId: string, messageId: string): void;
  reset(): void;
}

const initial = {
  me: null, accounts: {}, channels: [], dms: [], activeChannelId: null, threadRootId: null,
  messages: {}, hasMore: {}, unread: [], reads: {}, dividerSeq: {},
  online: [], leases: [], connected: false,
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
  /**
   * 리액션 델타를 적용한다. 같은 사람이 두 번 들어오지 않게 하는 것이 핵심이다 — 내가 누른
   * 것은 로컬 갱신과 소켓 이벤트로 두 번 도착하고, 두 번 세면 1 이 2 로 보인다.
   */
  applyReaction: (channelId, messageId, emoji, accountId, on) => {
    const rows = get().messages[channelId];
    if (!rows) return;
    const next = rows.map((m) => {
      if (m.id !== messageId) return m;
      const others = m.reactions.filter((r) => r.emoji !== emoji);
      const hit = m.reactions.find((r) => r.emoji === emoji);
      const ids = (hit?.accountIds ?? []).filter((id) => id !== accountId);
      if (on) ids.push(accountId);
      // 아무도 남지 않으면 칩을 지운다 — 0 이 적힌 칩은 UI 의 거짓말이다.
      if (!ids.length) return { ...m, reactions: others };
      // 이모지의 원래 자리를 지킨다. 뒤로 밀면 누를 때마다 칩이 춤춘다.
      return {
        ...m,
        reactions: m.reactions.map((r) => (r.emoji === emoji ? { emoji, accountIds: ids } : r))
          .concat(hit ? [] : [{ emoji, accountIds: ids }]),
      };
    });
    set({ messages: { ...get().messages, [channelId]: next } });
  },
  removeMessage: (channelId, messageId) => {
    const rows = get().messages[channelId];
    if (!rows) return;
    set({ messages: { ...get().messages, [channelId]: rows.filter((m) => m.id !== messageId) } });
  },
  reset: () => set({ ...initial }),
}));

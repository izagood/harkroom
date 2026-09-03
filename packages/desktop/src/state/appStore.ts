import { create } from 'zustand';
import { draftsStorage } from '../lib/prefs';
import type { AccountStatus, AccountView, ChannelRow, ChannelPrefRow, DmView, InboxEntry, LeaseRow, MessageRow } from '@murmur/shared';

export interface AppState {
  me: AccountView | null;
  accounts: Record<string, AccountView>;
  channels: ChannelRow[];
  dms: DmView[];
  activeChannelId: string | null;
  threadRootId: string | null;
  messages: Record<string, MessageRow[]>;
  /** channelId → 입력 중인 accountId 들. 서버가 상태 전체를 보내므로 덮어쓰기만 한다. */
  typing: Record<string, string[]>;
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
  /** 계정별 채널 음소거·즐겨찾기. channelId → preference */
  channelPrefs: Record<string, ChannelPrefRow>;
  /**
   * 스코프별 초안. 키는 scopeKey (channelId 또는 thread:<rootId>).
   * 설정과 달리 사용자가 쓴 문장 전체이므로 로그아웃 시 반드시 삭제한다.
   */
  drafts: Record<string, string>;
  set(partial: Partial<AppState>): void;
  upsertMessages(channelId: string, rows: MessageRow[]): void;
  applyReaction(channelId: string, messageId: string, emoji: string, accountId: string, on: boolean): void;
  removeMessage(channelId: string, messageId: string): void;
  /**
   * 사람이 고른 상태를 반영한다(#186). `online` 은 **건드리지 않는다** — 연결 여부는
   * presence 이벤트만이 정한다. 둘을 한 자리에서 갱신하면 상태 변경이 연결 표시를
   * 흔들어, 소켓이 멀쩡한 사람이 잠깐 회색으로 보인다.
   */
  applyStatus(accountId: string, status: AccountStatus, statusText: string | null): void;
  reset(): void;
  clearDrafts(): void;
  setDraft(scopeKey: string, draft: string): void;
  /** 기동 시 보관소에서 초안을 읽어 온다. */
  hydrateDrafts(): void;
}

const initial = {
  me: null, accounts: {}, channels: [], dms: [], activeChannelId: null, threadRootId: null,
  messages: {}, typing: {}, hasMore: {}, unread: [], reads: {}, dividerSeq: {},
  online: [], leases: [], connected: false, channelPrefs: {}, drafts: {},
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
  applyStatus: (accountId, status, statusText) => {
    const cur = get().accounts[accountId];
    // 처음 보는 계정이면 디렉터리에 없다는 뜻이다. 여기서 껍데기를 만들면 handle 없는
    // 계정이 멘션 후보·작성자 표에 섞인다 — 계정을 다시 받아오는 것은 컨트롤러의 몫이다.
    if (!cur) return;
    const patched = { ...cur, status, statusText };
    const me = get().me;
    // `me` 는 accounts 와 **별도 객체**다. 한쪽만 고치면 내가 정한 상태가 남의 화면에는
    // 보이는데 내 사이드바에는 안 보이는(또는 그 반대인) 갈라짐이 생긴다.
    set({
      accounts: { ...get().accounts, [accountId]: patched },
      ...(me?.id === accountId ? { me: { ...me, status, statusText } } : {}),
    });
  },
  reset: () => set({ ...initial }),
  clearDrafts: () => { set({ drafts: {} }); draftsStorage.clear(); },
  /**
   * 스토어가 초안의 **단일 원천**이다. 영속도 여기서 한다 — 컴포저가 지역 state 와
   * 보관소를 각각 들면 진실이 둘이 되고, 실제로 초판이 그랬다(스토어 쪽은 아무도
   * 쓰지 않는 죽은 코드였고 로그아웃이 그쪽을 비우지 않았다).
   *
   * 맵이 이미 메모리에 있으므로 키 입력마다 보관소를 **읽지** 않는다. 초판은 매
   * 글자마다 load() 로 JSON 을 파싱했다 — murmur 메시지는 길다는 것이 이 기능의
   * 전제인데 그 전제와 정면으로 어긋난다.
   */
  setDraft: (scopeKey, draft) => {
    const next = { ...get().drafts };
    if (draft) next[scopeKey] = draft;
    else delete next[scopeKey];
    set({ drafts: next });
    draftsStorage.save(next);
  },
  hydrateDrafts: () => set({ drafts: draftsStorage.load() }),
}));

import { create } from 'zustand';
import { draftsStorage } from '../lib/prefs';
import type { AccountStatus, AccountView, ChannelAutoMentionRow, ChannelDoc, ChannelRow, ChannelMemberRow, ChannelPrefRow, DmView, HandleGroupRow, InboxEntry, LeaseRow, MessageRow, PinRow, ProjectionStatus } from '@murmur/shared';
import type { RunnerState } from '../lib/runnerLauncher';

export interface HistoryEntry {
  channelId: string;
  threadRootId: string | null;
}

const MAX_HISTORY_LENGTH = 50;

export interface AppState {
  me: AccountView | null;
  accounts: Record<string, AccountView>;
  groups: HandleGroupRow[];
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
  /**
   * 지금 터미널 패널이 붙어 있는 에이전트 계정 id(#141). `null` 은 패널이 닫혀 있다는
   * 뜻이다 — 세션 id 가 아니라 **에이전트** id 인 이유: 칩은 에이전트별로 뜨고(스펙 §5,
   * 한 스레드에 세션이 N개일 수 있다), 어느 세션에 붙을지는 패널이 목록을 받아 정한다.
   */
  terminalAgentId: string | null;
  leases: LeaseRow[];
  connected: boolean;
  /**
   * avcs 투영 상태(#267). 60초마다 갱신한다. `null` 은 **"아직 모른다"** 다 —
   * "투영이 없다"가 아니다. 화면이 둘을 갈라 말해야 하므로 별도의 값으로 둔다.
   */
  projectionStatus: ProjectionStatus | null;
  /**
   * 투영 상태를 **읽지 못한** 이유(#267). `null` 이면 실패하지 않았다는 뜻이다.
   *
   * 왜 별도 필드인가: 조회 실패를 `projectionStatus: null` 로만 표현하면 "아직 안 왔다"와
   * "물어봤는데 실패했다"가 한 값에 뭉치고, 화면은 그 둘을 같은 문구로 그린다 —
   * 이 이슈가 닫으려는 결함이 스토어 층에 그대로 되살아난다(docs/design.md §4).
   */
  projectionStatusError: string | null;
  /** 계정별 채널 음소거·즐겨찾기. channelId → preference */
  channelPrefs: Record<string, ChannelPrefRow>;
  /**
   * 채널별 고정 메시지(#218). `channelPrefs` 와 나란히 있지만 **성질이 다르다** — 저쪽은
   * 내 취향이고 이쪽은 채널 전역 사실이라 누가 봐도 같은 값이다. 그래서 로그아웃 시
   * 초안처럼 비밀로 다룰 것이 없고, 다음 사람이 열면 서버에서 다시 받는다.
   */
  pins: Record<string, PinRow[]>;
  /**
   * 채널별 문서(#188). **키가 없는 것과 본문이 빈 문서는 다르다** — 없으면 "아직 안
   * 받았다", 있는데 본문이 ''면 "정말 비어 있다"다. 조회 실패를 빈 문서로 채우면 두
   * 상태가 같은 화면이 되고, 사람은 못 읽은 문서를 없는 문서로 읽는다.
   *
   * `pins` 와 같은 이유로 로그아웃 시 비밀로 다룰 것이 없다 — 채널 전역 사실이다.
   */
  channelDocs: Record<string, ChannelDoc>;
  /**
   * 내가 담아 둔 메시지의 id 전부(#219). `open` 과 `done` 을 **둘 다** 담는다 —
   * `⋯` 메뉴가 "담겨 있는가"를 이것으로 판단하고, 완료로 옮긴 메시지도 담긴 상태다.
   *
   * 목록 화면의 행들을 여기 두지 않는 이유: 패널은 탭 하나(`open` 또는 `done`)만 받아
   * 오는데 그것을 이 자리에 쓰면 '완료' 탭을 한 번 본 뒤로 메뉴가 `open` 인 메시지를
   * 담기지 않은 것으로 읽는다. 행들은 패널의 지역 상태다.
   */
  savedIds: string[];
  /**
   * 담아 둔 것 중 `open` 개수. 사이드바 배지에 쓴다 — `savedIds.length` 가 아니다
   * (완료로 옮긴 것은 배지에서 빠져야 한다).
   */
  savedCount: number;
  /**
   * 채널별 멤버 목록. channelId → members. **키가 없는 것과 빈 배열은 다르다** —
   * 없으면 "아직 안 받았다", 빈 배열이면 "정말 아무도 없다"다. 조회 실패를 빈 배열로
   * 채우면 그 구분이 사라져 나가기 경고가 조용히 꺼진다.
   */
  channelMembers: Record<string, ChannelMemberRow[]>;
  /**
   * 채널별 자동 멘션 에이전트(#173). `pins` 와 같은 채널 전역 사실이다 — 내 취향이 아니라
   * 누가 봐도 같은 값이라 비밀로 다룰 것이 없다. `channelMembers` 와 같이 **키가 없는 것과
   * 빈 배열은 다르다**: 없으면 아직 못 받았다, 빈 배열이면 정말 아무도 없다.
   */
  channelAutoMentions: Record<string, ChannelAutoMentionRow[]>;
  /**
   * 스코프별 초안. 키는 scopeKey (channelId 또는 thread:<rootId>).
   * 설정과 달리 사용자가 쓴 문장 전체이므로 로그아웃 시 반드시 삭제한다.
   */
  drafts: Record<string, string>;
  /** 뒤로/앞으로 탐색용 이력 스택. 채널·스레드만 담고 스크롤 위치는 담지 않는다.
   * 뒤로/앞으로 이동 시에는push하지 않는다 — 그렇게 하면 뒤로 갈 때마다 스택이 자라
   * 영원히 빠져나오지 못한다. openChannel/openThread 에서만 새 항목을 밀어 넣는다.
   * 세션 한정 인메모리다 — localStorage 에 넣지 않는다. */
  history: HistoryEntry[];
  historyIndex: number;
  /**
   * 사람에게 보여야 하는 짧은 알림·오류(#178). 조용히 삼키면 안 되는 실패가 여기로 온다 —
   * 링크가 가리키는 메시지를 못 열었다, 클립보드 쓰기가 막혔다 같은 것들.
   * 없으면 null 이다. 화면 상태이므로 영속하지 않는다.
   */
  notice: string | null;
  /**
   * 링크로 방금 이동한 메시지(#178). **메시지 데이터가 아니라 화면 상태다** — 여기 두지
   * 않고 `MessageRow` 에 넣으면 서버에서 온 사실과 지금 화면의 사정이 한 값에 섞인다.
   * 다음 이동 때 갈아탄다(`openChannel` 이 지우고 `openMessage` 가 다시 건다).
   */
  highlightedMessageId: string | null;
  /**
   * 지금 펼쳐 둔 긴 메시지들(#217). messageId → true.
   *
   * **세션 한정 화면 상태다.** `localStorage` 에 넣지 않는다 — 다시 켰을 때 무엇이 펼쳐져
   * 있을지 사람이 예측할 수 없다. `MessageRow` 에도 넣지 않는다 — 서버에서 온 사실과 지금
   * 화면의 사정이 한 값에 섞인다(강조 상태가 바로 위에 있는 것과 같은 이유다).
   *
   * 채널을 옮기면 비워진다(`openChannel`). 돌아왔을 때 접힌 상태가 기본이어야 긴 메시지가
   * 다시 앞뒤 대화를 스크롤 밖으로 밀어내지 않는다.
   */
  expandedMessageIds: Record<string, true>;
  /** 에이전트별 러너 실행 상태. agentId → state */
  runnerStates: Record<string, RunnerState>;
  /**
   * 링크 미리보기가 준비된 시각. url → 타임스탬프(#215).
   *
   * 카드 **내용**을 여기 담지 않는 이유: 캐시는 서버에 하나뿐이고, 두 벌을 두면 어느 쪽이
   * 최신인지 화면마다 갈린다. 여기 있는 것은 "다시 읽어라"는 신호뿐이다.
   */
  linkPreviewReadyAt: Record<string, number>;
  /**
   * 스킬 목록이 바뀐 횟수(#311). `skill.*` 이벤트를 받을 때마다 1 올라간다.
   *
   * 목록을 여기 담지 않는 이유는 미리보기와 같다 — 목록은 서버에 하나뿐이고, 두 벌을
   * 두면 어느 쪽이 최신인지 갈린다. 여기 있는 것은 "다시 읽어라"는 신호뿐이다.
   *
   * **시각이 아니라 세는 수인 이유:** 같은 밀리초에 두 이벤트가 오면 `Date.now()` 는
   * 같은 값이라 화면이 두 번째를 못 본다. 세는 수는 그런 자리가 없다.
   */
  skillsRevision: number;
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
  /** 그 계정의 프로필 사진 첨부 id 를 갈아 끼운다. null 은 지우기다(#159). */
  applyAvatar(accountId: string, avatarAttachmentId: string | null): void;
  /** 그 계정의 handle 을 바꾼다(#271). */
  applyHandle(accountId: string, handle: string): void;
  reset(): void;
  clearDrafts(): void;
  setDraft(scopeKey: string, draft: string): void;
  /** 기동 시 보관소에서 초안을 읽어 온다. */
  hydrateDrafts(): void;
  /** 새 채널·스레드를 열 때 이력에 추가한다. 뒤로/앞로 이동에서는 부른다. */
  pushHistory(entry: HistoryEntry): void;
  /** 이력에서 뒤로 간다. 이미 첫 항목이면 아무 일도 하지 않는다. */
  goBack(): HistoryEntry | null;
  /** 이력에서 앞으로 간다. 이미 마지막 항목이면 아무 일도 하지 않는다. */
  goForward(): HistoryEntry | null;
  /** 현재 위치에서 미래 이력을 모두 잘라낸다(새 항목 추가 시). */
  truncateForward(): void;
  /** 긴 메시지의 펼침을 뒤집는다(#217). */
  toggleExpanded(messageId: string): void;
}

const initial = {
  me: null, accounts: {}, groups: [], channels: [], dms: [], activeChannelId: null, threadRootId: null,
  messages: {}, typing: {}, hasMore: {}, unread: [], reads: {}, dividerSeq: {},
  online: [], terminalAgentId: null, leases: [], connected: false, projectionStatus: null, projectionStatusError: null,
  channelPrefs: {}, pins: {}, channelDocs: {}, channelMembers: {}, channelAutoMentions: {}, drafts: {},
  history: [], historyIndex: -1, notice: null, highlightedMessageId: null,
  expandedMessageIds: {}, runnerStates: {}, savedIds: [], savedCount: 0,
  linkPreviewReadyAt: {}, skillsRevision: 0,
};

/**
 * 커뮤니티 하나의 세계를 담는 스토어를 만든다(#166).
 *
 * 예전에는 이 자리에 모듈 최상위 싱글턴 `useAppStore` 가 있었고, 그 하나가 곧 "그 서버"
 * 였다. 커뮤니티가 N 개가 되면 그 전제가 깨지므로 **팩토리**로 바꾼다. `AppState`·
 * `initial`·`reset()` 의 모양은 하나도 건드리지 않았다 — 이 이슈가 바꾸는 것은 상태의
 * 모양이 아니라 그것이 **몇 벌 존재하는가**다.
 *
 * 활성 커뮤니티의 것을 읽는 자리는 `state/communities.ts` 의 `useActiveStore` 다.
 */
export function createAppStore() {
  return create<AppState>((set, get) => ({
    ...initial,
    set: (partial) => set(partial),
    toggleExpanded: (messageId) => {
      const cur = get().expandedMessageIds;
      if (!cur[messageId]) {
        set({ expandedMessageIds: { ...cur, [messageId]: true } });
        return;
      }
      // 다시 접을 때는 키를 **지운다** — false 를 남기면 "접어 둔 것" 과 "손대지 않은 것" 이
      // 구분되지 않는 채 목록만 자란다.
      const next = { ...cur };
      delete next[messageId];
      set({ expandedMessageIds: next });
    },
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
    /**
     * 프로필 사진이 바뀌었다(#159). `applyStatus` 와 같은 이유로 `me` 도 함께 고친다 —
     * 한쪽만 고치면 내가 방금 올린 사진이 남의 화면에는 보이는데 내 화면에는 안 보인다.
     */
    applyAvatar: (accountId, avatarAttachmentId) => {
      const cur = get().accounts[accountId];
      const me = get().me;
      // 디렉터리에 없는 계정에 껍데기를 만들지 않는다 — `applyStatus` 와 같은 판단이다.
      if (!cur && me?.id !== accountId) return;
      set({
        ...(cur ? { accounts: { ...get().accounts, [accountId]: { ...cur, avatarAttachmentId } } } : {}),
        ...(me?.id === accountId ? { me: { ...me, avatarAttachmentId } } : {}),
      });
    },
    /**
     * handle 이 바뀌었다(#271). `applyStatus` 와 같은 이유로 `me` 도 함께 고친다 —
     * 한쪽만 고치면 내가 방금 바꾼 이름이 남의 화면에는 보이는데 내 화면에는 안 된다.
     */
    applyHandle: (accountId, handle) => {
      const cur = get().accounts[accountId];
      const me = get().me;
      if (!cur && me?.id !== accountId) return;
      set({
        ...(cur ? { accounts: { ...get().accounts, [accountId]: { ...cur, handle } } } : {}),
        ...(me?.id === accountId ? { me: { ...me, handle } } : {}),
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
    pushHistory: (entry) => {
      const { history, historyIndex } = get();
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(entry);
      if (newHistory.length > MAX_HISTORY_LENGTH) {
        newHistory.shift();
        set({ history: newHistory, historyIndex: newHistory.length - 1 });
      } else {
        set({ history: newHistory, historyIndex: newHistory.length - 1 });
      }
    },
    goBack: () => {
      const { history, historyIndex } = get();
      if (historyIndex <= 0) return null;
      const entry = history[historyIndex - 1];
      return entry ?? null;
    },
    goForward: () => {
      const { history, historyIndex } = get();
      if (historyIndex >= history.length - 1) return null;
      const entry = history[historyIndex + 1];
      return entry ?? null;
    },
    truncateForward: () => {
      const { history, historyIndex } = get();
      set({ history: history.slice(0, historyIndex + 1) });
    },
  }));
}

/** `createAppStore()` 가 만든 스토어 하나. 커뮤니티 엔트리가 이것을 들고 있다. */
export type AppStore = ReturnType<typeof createAppStore>;

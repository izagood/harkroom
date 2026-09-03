import { create, useStore } from 'zustand';
import { createAppStore, type AppState, type AppStore } from './appStore';
import type { Controller } from './controller';

/**
 * 커뮤니티마다 스토어·컨트롤러 인스턴스를 두는 레지스트리(#166, #163 결정 A).
 *
 * 왜 "모든 키에 커뮤니티 차원을 얹기"가 아니라 "인스턴스를 여럿 두기"인가: 스토어 키는
 * 이미 `channelId`(UUID)라 커뮤니티가 달라도 **충돌하지 않는다**. 그래서 차원을 얹는 쪽은
 * 충돌을 막는 일이 아니라 "어느 커뮤니티 것인지"를 경로마다 손으로 실어 보내는 일이 되고,
 * 한 곳만 빠뜨리면 A 의 메시지가 B 의 채널에 조용히 붙는다 — 타입 검사도 테스트도 못 잡는다.
 * 인스턴스를 여럿 두면 잘못 읽는 것이 "잘못된 스토어 객체를 잡는 일"이라 격리가 구조로
 * 강제된다.
 *
 * **이 레지스트리는 `AppState` 밖이다.** 안에 두면 `appStore.reset()`(로그아웃)이 세계를
 * 비우면서 커뮤니티 목록까지 지운다 — 커뮤니티 하나에서 로그아웃했다고 나머지 목록이
 * 사라지는 것은 오답이다.
 */

/** 커뮤니티 꼬리표에 쓸 수 없는 baseUrl 일 때의 표기. 빈 문자열로 흘리지 않는다. */
const UNNAMED = 'community';

export interface CommunityEntry {
  /**
   * 클라이언트가 만드는 **로컬** 식별자다 — 서버는 이것을 모른다. `baseUrl` 로 식별하지
   * 않는 이유가 둘 있다: 같은 서버를 계정 둘로 두 번 등록할 수 있고, URL 은 바뀐다.
   */
  id: string;
  /** 이 커뮤니티의 서버 주소. 아직 세션이 붙지 않은 기동 엔트리는 빈 문자열이다. */
  baseUrl: string;
  /** 이 커뮤니티의 세계. 다른 커뮤니티의 스토어와 아무것도 공유하지 않는다. */
  store: AppStore;
  /**
   * 이 커뮤니티의 컨트롤러. 등록 직후에는 `null` 이다 — 스토어는 만들었지만 세션이 아직
   * 안 붙은 순간이 실제로 존재한다. 그 순간을 `undefined` 로 흘리지 않고 명시적 `null` 로 적는다.
   */
  controller: Controller | null;
}

export interface CommunityRegistryState {
  entries: CommunityEntry[];
  /** 지금 화면이 보고 있는 커뮤니티. 항상 `entries` 안의 id 다. */
  activeId: string;
  /**
   * 아직 서버가 정해지지 않은 기동 엔트리의 id. `null` 이면 이미 첫 커뮤니티가 가져갔다.
   *
   * 왜 별도 필드인가: `baseUrl === ''` 으로 판정하면 "아직 안 정해졌다"와 "빈 주소로
   * 등록됐다"가 한 값에 뭉친다. 이 저장소가 여러 자리에서 거절한 모양이다.
   */
  unclaimedId: string | null;
  /** 커뮤니티를 등록한다. 활성으로 만들지는 않는다 — 그것은 `setActive` 가 한다. */
  register(input: { baseUrl: string; controller?: Controller | null }): CommunityEntry;
  /** 활성 커뮤니티를 바꾼다. 모르는 id 면 던진다 — 조용히 무시하면 전환 실패가 안 보인다. */
  setActive(id: string): void;
  /** 그 커뮤니티의 컨트롤러를 꽂는다. `null` 은 떼어낸다는 뜻이다. */
  attachController(id: string, controller: Controller | null): void;
  /** 커뮤니티를 뺀다. 마지막 하나는 뺄 수 없다 — 활성 스토어가 없는 상태를 만들지 않는다. */
  remove(id: string): void;
}

let seq = 0;
function nextId(): string { return `community-${++seq}`; }

function makeEntry(baseUrl: string, controller: Controller | null = null): CommunityEntry {
  return { id: nextId(), baseUrl, store: createAppStore(), controller };
}

function bootstrap(): Pick<CommunityRegistryState, 'entries' | 'activeId' | 'unclaimedId'> {
  const entry = makeEntry('');
  return { entries: [entry], activeId: entry.id, unclaimedId: entry.id };
}

export const useCommunityRegistry = create<CommunityRegistryState>((set, get) => ({
  ...bootstrap(),
  register: ({ baseUrl, controller = null }) => {
    const { entries, unclaimedId } = get();
    // 기동 엔트리가 남아 있으면 **그것을 쓴다.** 레지스트리는 활성 스토어가 항상 존재하도록
    // 엔트리 하나를 들고 시작하는데(그래야 세션 이전에도 `useActiveStore` 가 읽힌다), 첫
    // 커뮤니티를 그 옆에 새로 붙이면 서버가 정해지지 않은 빈 커뮤니티가 목록에 유령으로 남는다.
    if (unclaimedId) {
      const claimed = entries.map((e) => (e.id === unclaimedId ? { ...e, baseUrl, controller } : e));
      set({ entries: claimed, unclaimedId: null });
      return claimed.find((e) => e.id === unclaimedId)!;
    }
    const entry = makeEntry(baseUrl, controller);
    set({ entries: [...entries, entry] });
    return entry;
  },
  setActive: (id) => {
    if (!get().entries.some((e) => e.id === id)) throw new Error(`모르는 커뮤니티다: ${id}`);
    set({ activeId: id });
  },
  attachController: (id, controller) => {
    const { entries } = get();
    if (!entries.some((e) => e.id === id)) throw new Error(`모르는 커뮤니티다: ${id}`);
    set({ entries: entries.map((e) => (e.id === id ? { ...e, controller } : e)) });
  },
  remove: (id) => {
    const { entries, activeId } = get();
    if (entries.length <= 1) throw new Error('마지막 커뮤니티는 뺄 수 없다');
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) throw new Error(`모르는 커뮤니티다: ${id}`);
    set({
      entries: next,
      // 활성을 뺐으면 남은 첫 번째로 옮긴다. 활성 없는 상태를 만들지 않는다.
      activeId: activeId === id ? next[0]!.id : activeId,
      unclaimedId: get().unclaimedId === id ? null : get().unclaimedId,
    });
  },
}));

/**
 * 레지스트리를 기동 직후 상태로 되돌린다. **테스트 전용 이음새다** — 화면에서 부르지 마라.
 * 커뮤니티 목록을 비우는 것은 사용자에게 커뮤니티를 통째로 잃게 하는 동작이다.
 */
export function resetCommunityRegistry(): void {
  useCommunityRegistry.setState(bootstrap());
}

export function getActiveEntry(): CommunityEntry {
  const { entries, activeId } = useCommunityRegistry.getState();
  const hit = entries.find((e) => e.id === activeId);
  // 레지스트리는 엔트리 하나로 시작하고 `remove` 가 마지막 하나를 거절하므로 여기 도달할 수
  // 없다. 그래도 빈 스토어를 즉석에서 만들어 돌려주지 않는다 — 그러면 화면이 "아무것도 없는
  // 커뮤니티" 를 정상으로 그리고, 상태를 잃었다는 사실이 조용히 사라진다.
  if (!hit) throw new Error('활성 커뮤니티가 없다');
  return hit;
}

export function getActiveStore(): AppStore {
  return getActiveEntry().store;
}

/** 문구는 기존 `getController()` 의 것을 그대로 쓴다 — 이 이슈는 오류 표면을 바꾸지 않는다. */
export function getActiveController(): Controller {
  const c = getActiveEntry().controller;
  if (!c) throw new Error('controller not initialized');
  return c;
}

/**
 * 커뮤니티별 연결 상태(#166 §5). `connected` 는 커뮤니티마다 자기 스토어 안에 있다 —
 * 전역 플래그 하나로 합치면 셋 중 하나만 끊긴 상태가 "끊김" 하나로 뭉쳐 거짓말이 된다.
 *
 * **이 값을 화면에 어떻게 보이는지는 이 이슈가 정하지 않는다**(#165 의 몫). 오늘의 두
 * 독자(사이드바 점, `ConnectionSettings`)는 `useActiveStore` 로 활성 커뮤니티의 값만 읽어
 * 오늘과 같은 뜻을 유지한다. 이 함수는 그 위에 목록을 올릴 자리다.
 */
export function getCommunityConnected(): { id: string; connected: boolean }[] {
  return useCommunityRegistry.getState().entries
    .map((e) => ({ id: e.id, connected: e.store.getState().connected }));
}

/**
 * 알림에 붙일 커뮤니티 꼬리표(#166 §6). 서버는 커뮤니티 이름을 모르고 이름을 붙이는 UI 도
 * 아직 없으므로(#165) 호스트를 쓴다. 파싱에 실패하면 id 로 떨어진다 — 빈 문자열을 흘리면
 * 알림 제목이 "posted in #general ()" 처럼 망가진다.
 */
export function communityLabel(entry: CommunityEntry): string {
  if (!entry.baseUrl) return entry.id;
  try {
    return new URL(entry.baseUrl).host || UNNAMED;
  } catch {
    return entry.baseUrl;
  }
}

const identity = (s: AppState): AppState => s;

function useActiveStoreHook(selector: (s: AppState) => unknown = identity): unknown {
  // **스토어 api 자체**를 구독한다. 활성 전환이 곧 다른 api 를 `useStore` 에 넘기는 일이
  // 되어, 전환 시 리렌더가 구조로 따라온다 — 컴포넌트가 커뮤니티 id 를 꿸 필요가 없다.
  const store = useCommunityRegistry((r) => r.entries.find((e) => e.id === r.activeId)?.store);
  if (!store) throw new Error('활성 커뮤니티가 없다');
  return useStore(store, selector);
}

/**
 * 활성 커뮤니티의 스토어. 예전 `useAppStore` 싱글턴을 대신한다.
 *
 * 훅으로도(`useActiveStore((s) => s.me)`) 훅 밖에서도(`useActiveStore.getState()`) 쓰인다 —
 * 호출 모양이 예전과 같아야 이 이슈의 diff 가 "상태 구조" 에 머문다. 그래서 zustand 스토어와
 * 같은 표면을 가진 얇은 대리자로 만든다.
 *
 * **`subscribe` 는 부르는 시점의 활성 스토어에 묶인다** — 나중에 커뮤니티를 전환해도 그
 * 구독은 옮겨 가지 않는다. 훅 경로(`useStore`)는 위에서 전환을 따라가므로 화면은 안전하고,
 * 훅 밖에서 오래 사는 구독을 걸 자리는 지금 없다. 생기면 그때 커뮤니티를 지목해 걸어야 한다.
 */
export const useActiveStore = Object.assign(useActiveStoreHook, {
  getState: () => getActiveStore().getState(),
  getInitialState: () => getActiveStore().getInitialState(),
  setState: (...args: Parameters<AppStore['setState']>) => getActiveStore().setState(...args),
  subscribe: (...args: Parameters<AppStore['subscribe']>) => getActiveStore().subscribe(...args),
}) as unknown as AppStore;

export { createAppStore };
export type { AppStore, AppState };

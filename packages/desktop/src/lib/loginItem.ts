import { useCallback, useEffect, useState } from 'react';

/**
 * 「로그인할 때 자동으로 시작」 표면 — macOS 로그인 항목(`src-tauri/src/login_item.rs`, `SMAppService.mainApp`).
 *
 * 앱째 창 없이 뜬다 — 그래서 맥을 다시 켠 뒤 앱을 열지 않아도 이 머신의 오퍼레이터가 서고 에이전트가 답한다.
 * `fullDiskAccess.ts` 와 같은 이유로 인터페이스 뒤에 둔다: Tauri 는 브라우저 dev·시험에 없고, 시험은 이 자리를 갈아 끼운다.
 */
export type LoginItemStatus = 'unsupported' | 'unknown' | 'off' | 'on' | 'approval';

export interface LoginItemSurface {
  status(): Promise<LoginItemStatus>;
  /** 켜거나 끈다. 성공하면 바뀐 상태, 실패하면 macOS 가 준 사유로 거절한다. */
  set(enabled: boolean): Promise<LoginItemStatus>;
  openSettings(): Promise<void>;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  const fn = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  return typeof fn === 'function' ? fn : null;
}

const STATUSES: readonly LoginItemStatus[] = ['unsupported', 'unknown', 'off', 'on', 'approval'];
const parse = (raw: unknown): LoginItemStatus => (STATUSES.includes(raw as LoginItemStatus) ? (raw as LoginItemStatus) : 'unknown');

export function createLoginItemSurface(): LoginItemSurface {
  return {
    async status() {
      const invoke = tauriInvoke();
      if (!invoke) return 'unsupported';
      return parse(await invoke('login_item_status').catch(() => 'unknown'));
    },
    async set(enabled) {
      const invoke = tauriInvoke();
      if (!invoke) throw new Error('this build has no Tauri surface');
      return parse(await invoke('login_item_set', { enabled }));
    },
    async openSettings() {
      const invoke = tauriInvoke();
      if (!invoke) throw new Error('this build has no Tauri surface');
      await invoke('login_item_open_settings');
    },
  };
}

let current: LoginItemSurface | null = null;

/** 시험이 표면을 갈아 끼운다. null 이면 다음 사용 때 실제 표면을 다시 만든다. */
export function setLoginItemSurface(s: LoginItemSurface | null): void { current = s; }

export function getLoginItemSurface(): LoginItemSurface {
  return (current ??= createLoginItemSurface());
}

/**
 * 이 기기에서 기억하는 두 가지.
 * - `wanted`: 사람이 **여기서 켰는가**. macOS 는 「한 번도 안 켬」과 「시스템 설정에서 끔」을 같은 꺼짐으로 돌려준다 —
 *   켠 적이 있는데 꺼짐으로 읽히면 시스템 설정에서 끈 것이다(앱이 끈 것은 이 값도 함께 내린다).
 * - `asked`: 첫 등록 뒤 안내 띠로 **한 번 물었는가**(시안 B안). 어떻게 닫든 다시 묻지 않는다.
 */
const WANTED_KEY = 'harkroom.loginItemWanted';
const ASKED_KEY = 'harkroom.loginItemAsked';

export const loginItemStorage = {
  wanted(): boolean {
    try { return localStorage.getItem(WANTED_KEY) === '1'; } catch { return false; }
  },
  setWanted(on: boolean): void {
    try { if (on) localStorage.setItem(WANTED_KEY, '1'); else localStorage.removeItem(WANTED_KEY); } catch { /* 이번 실행만 */ }
  },
  wasAsked(): boolean {
    try { return localStorage.getItem(ASKED_KEY) === '1'; } catch { return true; }
  },
  markAsked(): void {
    try { localStorage.setItem(ASKED_KEY, '1'); } catch { /* 저장이 막히면 이번 실행에서만 안 묻는다 */ }
  },
};

/** 화면이 그리는 다섯 상태(시안 2절) + 숨김. */
export type LoginItemView = 'hidden' | 'off' | 'on' | 'approval' | 'failed' | 'system';

/**
 * macOS 상태·이 기기의 기억·이번 실행의 실패 → 화면 상태.
 * `failed` 는 방금 켜려다 거절된 것 — macOS 상태로는 꺼짐이라 기억(wanted)보다 먼저 본다.
 */
export function loginItemView(status: LoginItemStatus | null, wanted: boolean, failure: string | null): LoginItemView {
  if (status === null || status === 'unsupported') return 'hidden';
  if (failure !== null && status !== 'on' && status !== 'approval') return 'failed';
  if (status === 'on') return 'on';
  if (status === 'approval') return 'approval';
  if (status === 'off' && wanted) return 'system';
  return 'off';
}

/** 첫 등록 뒤 한 번 묻는 띠를 세울 때인가 — 확실히 꺼져 있고, 묻지 않았고, 이 맥이 등록돼 있고, FDA 첫 창이 비켰을 때. */
export function shouldAskLoginItem(o: {
  status: LoginItemStatus | null; asked: boolean; wanted: boolean; registered: boolean; fdaBusy: boolean;
}): boolean {
  return o.status === 'off' && !o.asked && !o.wanted && o.registered && !o.fdaBusy;
}

/**
 * 상태·켜고 끄기를 한 벌로. 창에 포커스가 돌아올 때마다 다시 읽는다 — 사람이 시스템 설정에서 바꾸고 돌아오는 때다.
 * 실패 사유는 이번 실행에만 산다(다시 시도·성공하면 지운다). 여러 자리(설정 줄·띠)가 같은 값을 보도록 모듈에 하나 둔다.
 */
type Shared = { status: LoginItemStatus | null; failure: string | null; wanted: boolean };
let shared: Shared = { status: null, failure: null, wanted: false };
const listeners = new Set<() => void>();
const publish = (next: Partial<Shared>) => { shared = { ...shared, ...next }; listeners.forEach((l) => l()); };

export async function refreshLoginItem(): Promise<void> {
  const status = await getLoginItemSurface().status().catch((): LoginItemStatus => 'unknown');
  publish({ status, wanted: loginItemStorage.wanted() });
}

/** 켜기/끄기. 실패하면 사유를 `failure` 로 남기고 거절을 그대로 넘긴다. */
export async function setLoginItem(enabled: boolean): Promise<LoginItemStatus> {
  try {
    const status = await getLoginItemSurface().set(enabled);
    loginItemStorage.setWanted(enabled);
    publish({ status, failure: null, wanted: enabled });
    return status;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (!enabled) { publish({}); throw e; }
    const status = await getLoginItemSurface().status().catch((): LoginItemStatus => 'unknown');
    publish({ status, failure: reason });
    throw e;
  }
}

/** 시험용 — 모듈에 남은 값을 비운다. */
export function resetLoginItemForTest(): void { shared = { status: null, failure: null, wanted: false }; listeners.forEach((l) => l()); }

export function useLoginItem(): Shared & { view: LoginItemView; refresh: () => void } {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const refresh = useCallback(() => { void refreshLoginItem(); }, []);
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  return { ...shared, view: loginItemView(shared.status, shared.wanted, shared.failure), refresh };
}

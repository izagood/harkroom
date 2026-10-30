import { useCallback, useEffect, useState } from 'react';

/**
 * macOS **전체 디스크 접근**(Full Disk Access) 표면 — 확인·설정 열기·다시 시작.
 *
 * 확인은 Rust(`src-tauri/src/fda_probe.rs`)가 한다. 웹뷰는 무엇을 확인할지 고르지 못하고(명령에 파라미터가 없다)
 * 결과는 이 화면에만 쓰인다 — 서버·로그로 보내지 않는다(security S3·S4, 소유자 결정 2026-10-29).
 *
 * `openExternal.ts` 와 같은 이유로 인터페이스 뒤에 둔다: Tauri 는 브라우저 dev·시험에 없고, 시험은 이 자리를
 * 갈아 끼워 상태를 정한다.
 */
export type FdaStatus = 'unsupported' | 'unknown' | 'on' | 'off' | 'restart';

export interface FdaSurface {
  status(): Promise<FdaStatus>;
  openSettings(): Promise<void>;
  revealApp(): Promise<void>;
  relaunch(): Promise<void>;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriProcessPlugin = { relaunch(): Promise<void> };

function tauriInvoke(): Invoke | null {
  const fn = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  return typeof fn === 'function' ? fn : null;
}

const STATUSES: readonly FdaStatus[] = ['unsupported', 'unknown', 'on', 'off', 'restart'];

export function createFdaSurface(): FdaSurface {
  return {
    async status() {
      const invoke = tauriInvoke();
      // Tauri 가 없는 곳(브라우저 dev)은 권할 것이 없다.
      if (!invoke) return 'unsupported';
      const raw = await invoke('fda_status').catch(() => 'unknown');
      return STATUSES.includes(raw as FdaStatus) ? (raw as FdaStatus) : 'unknown';
    },
    async openSettings() {
      const invoke = tauriInvoke();
      if (!invoke) throw new Error('this build has no Tauri surface');
      await invoke('fda_open_settings');
    },
    async revealApp() {
      const invoke = tauriInvoke();
      if (!invoke) throw new Error('this build has no Tauri surface');
      await invoke('fda_reveal_app');
    },
    async relaunch() {
      const process = (await import('@tauri-apps/plugin-process')) as unknown as TauriProcessPlugin;
      await process.relaunch();
    },
  };
}

let current: FdaSurface | null = null;

/** 시험이 표면을 갈아 끼운다. null 이면 다음 사용 때 실제 표면을 다시 만든다. */
export function setFdaSurface(s: FdaSurface | null): void { current = s; }

export function getFdaSurface(): FdaSurface {
  return (current ??= createFdaSurface());
}

/**
 * 안내 창을 **이 기기에서 이미 띄웠는가**. 소유자 결정 #1·#2: 첫 실행 또는 로그인 뒤 권한이 없을 때 **한 번만**
 * 띄우고, 어떻게 닫았든 다시 묻지 않는다. 다시 여는 길은 설정 › 이 머신의 오퍼레이터 한 곳이다.
 */
const PROMPTED_KEY = 'harkroom.fdaPrompted';

export const fdaPromptStorage = {
  wasShown(): boolean {
    try { return localStorage.getItem(PROMPTED_KEY) === '1'; } catch { return true; }
  },
  markShown(): void {
    try { localStorage.setItem(PROMPTED_KEY, '1'); } catch { /* 저장이 막히면 이번 실행에서만 안 묻는다 */ }
  },
};

/** 첫 실행 안내를 띄울 상태인가 — 권한이 **없다고 확인됐을 때만**. 모르면 권하지 않는다. */
export function shouldPrompt(status: FdaStatus, shownBefore: boolean): boolean {
  return status === 'off' && !shownBefore;
}

/**
 * 지금 상태를 읽고, **앱 창에 포커스가 돌아올 때마다** 다시 읽는다 — 사람이 시스템 설정에서 스위치를 켜고
 * 돌아오는 순간이 바로 그때다.
 */
export function useFdaStatus(): { status: FdaStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<FdaStatus | null>(null);
  const refresh = useCallback(() => {
    void getFdaSurface().status().then(setStatus, () => setStatus('unknown'));
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  return { status, refresh };
}

/**
 * codex 계정의 **웹뷰 쪽 얇은 표면**. `claudeAccounts.ts` 와 같은 경계다 — 실제 일(디렉터리,
 * `codex login`, `active.json`)은 전부 데몬이 하고, 여기서 넘기는 것은 **계정 이름·로그인 id**
 * 뿐이다. 타입은 프로토콜의 한 벌을 그대로 쓴다(베끼지 않는다).
 */
import type {
  CodexAccountsSnapshot,
  CodexAuthStatus,
  CodexLoginEvent,
} from '@harkroom/shared/daemonProtocol';

import { hasClaudeAccountsSurface } from './claudeAccounts';

export type { CodexAccountsSnapshot, CodexAuthStatus, CodexLoginEvent };

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
interface TauriInternals {
  invoke?: Invoke;
  transformCallback?: (cb: (payload: unknown) => void) => number;
}
function internals(): TauriInternals | null {
  return (globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null;
}

/** 표면 판정은 claude 쪽과 **같은 하나**다 — 둘로 갈리면 한 카드만 "못 쓴다"를 말한다. */
export const hasCodexAccountsSurface = hasClaudeAccountsSurface;

function call(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = internals()?.invoke;
  if (!invoke) return Promise.reject(new Error('이 빌드에는 Tauri 표면이 없다 — codex 계정을 다룰 수 없다'));
  return invoke(cmd, args);
}

export function listCodexAccounts(): Promise<CodexAccountsSnapshot> {
  return call('codex_accounts_list') as Promise<CodexAccountsSnapshot>;
}

export function startCodexLogin(account: string): Promise<{ loginId: string }> {
  return call('codex_account_login_start', { account }) as Promise<{ loginId: string }>;
}

export function cancelCodexLogin(loginId: string): Promise<void> {
  return call('codex_account_login_cancel', { loginId }) as Promise<void>;
}

export function removeCodexAccount(account: string): Promise<void> {
  return call('codex_account_remove', { account }) as Promise<void>;
}

/** `null` 이면 시스템 기본 로그인으로 돌아간다. 러너는 **다음 codex 턴부터** 이 계정으로 돈다. */
export function activateCodexAccount(account: string | null): Promise<void> {
  return call('codex_account_activate', { account }) as Promise<void>;
}

/** Rust 가 쓰는 이벤트 이름. `main.rs::CODEX_LOGIN_EVENT` 와 **같은 값**이어야 한다. */
export const CODEX_LOGIN_EVENT = 'harkroom://codex-login';

/** 로그인 진행을 듣는다(`listenClaudeLogin` 과 같은 경로). 표면이 없으면 아무것도 안 하는 해제 함수. */
export async function listenCodexLogin(cb: (e: CodexLoginEvent) => void): Promise<() => void> {
  const api = internals();
  if (typeof api?.invoke !== 'function' || typeof api.transformCallback !== 'function') return () => undefined;
  const invoke = api.invoke;
  const handlerId = api.transformCallback((payload) => {
    const body = (payload as { payload?: unknown })?.payload as CodexLoginEvent | undefined;
    if (body && typeof body.loginId === 'string') cb(body);
  });
  const eventId = await invoke('plugin:event|listen', {
    event: CODEX_LOGIN_EVENT, target: { kind: 'Any' }, handler: handlerId,
  });
  return () => { void invoke('plugin:event|unlisten', { event: CODEX_LOGIN_EVENT, eventId }); };
}

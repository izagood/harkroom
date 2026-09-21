/**
 * 이 머신의 오퍼레이터 로컬 설정 — "이 머신이 어떤 에이전트를 돌릴 수 있나"(스펙 2026-09-20 §3
 * 능력). 파일(`operator.json`)의 writer 는 오퍼레이터 하나이고 앱은 소켓으로 넣고 뺀다 —
 * `claudeAccounts.ts` 와 같은 경계다: 웹뷰가 넘기는 것은 URL·id·문자열뿐이고 Rust 커맨드가
 * 데몬에 전달한다.
 */
import type { OperatorAgentsListResult, OperatorLocalAgent } from '@harkroom/shared/daemonProtocol';

interface TauriInternals { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }

function internals(): TauriInternals | null {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return g.__TAURI_INTERNALS__ ?? null;
}

/** 이 빌드에 Tauri 표면이 있는가 — 웹·테스트에서는 없고, 그때 화면은 이 절을 그리지 않는다. */
export function hasOperatorLocalSurface(): boolean {
  return typeof internals()?.invoke === 'function';
}

function call(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = internals()?.invoke;
  if (!invoke) return Promise.reject(new Error('이 빌드에는 Tauri 표면이 없다 — 오퍼레이터 로컬 설정을 다룰 수 없다'));
  return invoke(cmd, args);
}

export function listLocalAgents(): Promise<OperatorAgentsListResult> {
  return call('operator_agents_list') as Promise<OperatorAgentsListResult>;
}

export async function setLocalAgent(baseUrl: string, agentId: string, config: OperatorLocalAgent): Promise<void> {
  await call('operator_agent_set', { baseUrl, agentId, config });
}

export async function removeLocalAgent(baseUrl: string, agentId: string): Promise<void> {
  await call('operator_agent_remove', { baseUrl, agentId });
}

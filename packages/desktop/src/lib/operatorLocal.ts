/**
 * 이 머신의 오퍼레이터 로컬 설정 — "이 머신이 어떤 에이전트를 돌릴 수 있나"(스펙 2026-09-20 §3
 * 능력). 파일(`operator.json`)의 writer 는 오퍼레이터 하나이고 앱은 소켓으로 넣고 뺀다 —
 * `claudeAccounts.ts` 와 같은 경계다: 웹뷰가 넘기는 것은 URL·id·문자열뿐이고 Rust 커맨드가
 * 데몬에 전달한다.
 */
import type { CleanupLedger, CleanupSettings } from '@harkroom/shared/workspaceCleanup';
import type { OperatorAgentsListResult, OperatorLocalAgent, OperatorMcpAuthStartResult, OperatorMcpAuthState, OperatorMcpListResult, OperatorMcpRemoteDefinition, OperatorMergeState, OperatorRegisterResult } from '@harkroom/shared/daemonProtocol';

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

/** 이 머신의 오퍼레이터를 이 커뮤니티에 등록한다 — 코드는 서버가 발급했고, claim 은 오퍼레이터가 한다. */
export function registerLocalOperator(baseUrl: string, code: string, name?: string): Promise<OperatorRegisterResult> {
  return call('operator_register', { baseUrl, code, name: name ?? null }) as Promise<OperatorRegisterResult>;
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

/**
 * 이 머신의 MCP 정의(`operator/mcp-servers.json`) — 서버 레지스트리의 이름에 붙는 명령·url·토큰.
 * 목록은 env·headers 의 **키만** 돌려준다. 정의를 바꿔도 도는 러너는 그대로다 — 러너를 다시
 * 띄울 때 새 config 가 만들어진다.
 */
export function listLocalMcpServers(): Promise<OperatorMcpListResult> {
  return call('operator_mcp_list') as Promise<OperatorMcpListResult>;
}

/** http·sse 정의만 넣는다 — stdio 는 오퍼레이터가 거절한다(#431). */
export async function setLocalMcpServer(name: string, definition: OperatorMcpRemoteDefinition): Promise<void> {
  await call('operator_mcp_set', { name, definition });
}

export async function removeLocalMcpServer(name: string): Promise<void> {
  await call('operator_mcp_remove', { name });
}

/**
 * 원격 MCP 의 OAuth(2026-09-30). 토큰은 오퍼레이터가 들고 러너를 띄울 때 헤더로 굽는다 — 계정 풀의
 * 어느 계정으로 돌든 같은 토큰이다. 앱은 인가 url 을 받아 브라우저로 열고 상태를 물을 뿐, 토큰은 보지 않는다.
 */
export function startLocalMcpAuth(name: string): Promise<OperatorMcpAuthStartResult> {
  return call('operator_mcp_auth', { action: 'start', name }) as Promise<OperatorMcpAuthStartResult>;
}

export function localMcpAuthStatus(name: string): Promise<OperatorMcpAuthState> {
  return call('operator_mcp_auth', { action: 'status', name }) as Promise<OperatorMcpAuthState>;
}

export async function forgetLocalMcpAuth(name: string): Promise<void> {
  await call('operator_mcp_auth', { action: 'forget', name });
}

/**
 * 머지 래퍼의 gh 계정(`operator.json` 의 `merge.ghUser`). 목록은 이 머신 gh 의 로그인 이름뿐이고 토큰은 오지 않는다.
 * 고를 수 있는 것은 그 순간 gh 에 로그인된 이름만이다 — 오퍼레이터가 다시 잰다(security C7).
 */
export function getLocalMerge(): Promise<OperatorMergeState> {
  return call('operator_merge_get') as Promise<OperatorMergeState>;
}

/** `null` 은 비우기다 — 그 뒤로 래퍼는 머지하지 않는다(`no_gh_user`). */
export function setLocalMergeGhUser(ghUser: string | null): Promise<OperatorMergeState> {
  return call('operator_merge_set', { ghUser }) as Promise<OperatorMergeState>;
}

/** 머지 권한 줄 하나(`owner/name`·`owner/*`)의 gh 계정 — null 은 그 줄의 지정을 지운다(스레드 e085b6a7). */
export function setLocalMergeScopeUser(scope: string, ghUser: string | null): Promise<OperatorMergeState> {
  return call('operator_merge_set', { ghUser, scope }) as Promise<OperatorMergeState>;
}

/** 옛 기기 기본값을 지금 줄들에 한 번 복사한다 — 이미 옮겼으면 오퍼레이터가 아무것도 안 한다. */
export function migrateLocalMerge(scopes: string[]): Promise<OperatorMergeState> {
  return call('operator_merge_set', { migrate: scopes }) as Promise<OperatorMergeState>;
}

// ── 작업 폴더 정리(스레드 9e909150) ──────────────────────────────────────────────
// 원장은 오퍼레이터의 것이다(`operator/src/workspaceCleanup.ts`). 앱은 읽고, 설정을 바꾸고, 보존·되돌리기·삭제 예정에 넣기만
// 한다 — **바로 지우는 길은 없다**(D3·D5).

export interface WorkspaceCleanupView {
  settings: CleanupSettings;
  ledger: CleanupLedger;
  running: boolean;
}

export function getWorkspaceCleanup(): Promise<WorkspaceCleanupView> {
  return call('workspace_cleanup_get') as Promise<WorkspaceCleanupView>;
}

export function setWorkspaceCleanupSettings(next: { enabled?: boolean; graceDays?: number }): Promise<WorkspaceCleanupView> {
  return call('workspace_cleanup_settings_set', { enabled: next.enabled ?? null, graceDays: next.graceDays ?? null }) as Promise<WorkspaceCleanupView>;
}

/** `by` 는 누른 사람의 계정 id 다(화면의 「누가 보존」). */
export function actWorkspaceCleanup(path: string, action: 'keep' | 'unkeep' | 'list', by: string): Promise<WorkspaceCleanupView> {
  return call('workspace_cleanup_act', { path, action, by }) as Promise<WorkspaceCleanupView>;
}

export function sweepWorkspaceCleanup(): Promise<WorkspaceCleanupView> {
  return call('workspace_cleanup_sweep') as Promise<WorkspaceCleanupView>;
}

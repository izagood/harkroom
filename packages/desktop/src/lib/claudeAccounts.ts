/**
 * claude 계정 풀의 **웹뷰 쪽 얇은 표면**. `invoke` 를 감싸고 로그인 이벤트를 듣는다.
 *
 * ## 왜 이렇게 얇은가
 *
 * 실제 일은 전부 데몬이 한다 — 디렉터리를 읽고, `claude auth login` 을 띄우고, `pools.json`
 * 을 쓴다. 웹뷰에는 로컬 파일을 읽거나 프로그램을 띄울 표면이 **의도적으로** 없고
 * (`capabilities/default.json` 에 `shell:allow-execute` 가 0개, `#513` 이 지웠다), 이 기능은
 * 그 문을 열지 않는다. 그래서 이 파일이 넘기는 것은 **이름·코드·id 뿐**이다.
 *
 * ## `@tauri-apps/api` 를 쓰지 않는다
 *
 * 이 저장소는 `globalThis.__TAURI_INTERNALS__.invoke` 를 직접 쓴다(`runnerLauncher.ts`,
 * `session.ts`, `notify.ts` 가 모두 그렇다). 그 관례를 따른다 — 여기만 다른 경로를 쓰면
 * 표면 부재 판정(`hasTauri`)도 두 가지가 된다.
 */
import type { ClaudePoolsConfig } from '@murmur/shared/claudePools';

/** `claude auth status --json` 에서 UI 가 쓰는 것만. **비밀값은 이 출력에 없다.** */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
}

export interface ClaudeAccountView {
  name: string;
  status: ClaudeAuthStatus;
}

export interface ClaudePoolView {
  name: string;
  accounts: ClaudeAccountView[];
}

export interface ClaudeAccountsSnapshot {
  root: string;
  /** `flat` = `pools.json` 이 없다. 그때 `pools` 는 이름이 빈 풀 하나다. */
  mode: 'flat' | 'pools';
  defaultPool: string | null;
  agents: Record<string, string>;
  pools: ClaudePoolView[];
  /** 풀 모드인데 뿌리에 남은 평평한 계정. UI 가 이전을 안내하는 근거다. */
  strays: string[];
}

/** 로그인 진행 통지. 필드가 상황마다 다르다 — url 만, 또는 done+status. */
export interface ClaudeLoginEvent {
  loginId: string;
  url?: string;
  done?: boolean;
  status?: ClaudeAuthStatus;
  error?: string;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriInternals {
  invoke?: Invoke;
  transformCallback?: (cb: (payload: unknown) => void) => number;
}

function internals(): TauriInternals | null {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return g.__TAURI_INTERNALS__ ?? null;
}

/**
 * 이 빌드에 Tauri 표면이 있는가. **웹·테스트에서는 없다.**
 *
 * 판정을 노출하는 이유: 없을 때 화면이 "이 빌드에서는 쓸 수 없다"를 말해야 한다. 그러지
 * 않으면 버튼이 눌리는데 아무 일도 안 나고, 사람은 자기 계정 설정이 깨진 줄 안다.
 * `NotificationSettings`·`useUpdateCheck` 가 같은 판정을 쓴다.
 */
export function hasClaudeAccountsSurface(): boolean {
  return typeof internals()?.invoke === 'function';
}

function call(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = internals()?.invoke;
  if (!invoke) {
    // 던지는 이유: 조용히 성공하면 화면이 "했다"를 그린다. 표면이 없다는 것은 화면이
    // `hasClaudeAccountsSurface` 로 **먼저** 알아야 하는 사실이고, 여기까지 왔다면 배선 결함이다.
    return Promise.reject(new Error('이 빌드에는 Tauri 표면이 없다 — 계정 풀을 다룰 수 없다'));
  }
  return invoke(cmd, args);
}

export function listClaudeAccounts(): Promise<ClaudeAccountsSnapshot> {
  return call('claude_accounts_list') as Promise<ClaudeAccountsSnapshot>;
}

/**
 * 기본 풀·순서·배정을 한 번에 쓴다. **부분 갱신이 아니다** — 세 값이 서로를 참조하므로
 * (배정이 가리키는 풀이 사라지는 등) 한 번에 쓰는 편이 그 어긋남을 만들지 않는다.
 *
 * 없는 풀 이름이 나타나면 데몬이 그 디렉터리를 만든다 — **그것이 풀 생성 경로다.**
 */
export function configureClaudeAccounts(config: ClaudePoolsConfig): Promise<void> {
  return call('claude_accounts_configure', { config }) as Promise<void>;
}

export function startClaudeLogin(pool: string, account: string): Promise<{ loginId: string }> {
  return call('claude_account_login_start', { pool, account }) as Promise<{ loginId: string }>;
}

export function submitClaudeLoginCode(loginId: string, code: string): Promise<void> {
  return call('claude_account_login_submit', { loginId, code }) as Promise<void>;
}

export function cancelClaudeLogin(loginId: string): Promise<void> {
  return call('claude_account_login_cancel', { loginId }) as Promise<void>;
}

export function removeClaudeAccount(pool: string, account: string): Promise<void> {
  return call('claude_account_remove', { pool, account }) as Promise<void>;
}

export function removeClaudePool(pool: string): Promise<void> {
  return call('claude_pool_remove', { pool }) as Promise<void>;
}

/** 평평한 계정을 풀 안으로 옮긴다. **로그인이 유지됐는지를 돌려준다**(장담하지 않는다). */
export function moveClaudeAccount(account: string, toPool: string): Promise<{ loggedIn: boolean }> {
  return call('claude_account_move', { account, toPool }) as Promise<{ loggedIn: boolean }>;
}

/** Rust 가 쓰는 이벤트 이름. `main.rs::CLAUDE_LOGIN_EVENT` 와 **같은 값**이어야 한다. */
export const CLAUDE_LOGIN_EVENT = 'murmur://claude-login';

/**
 * 로그인 진행을 듣는다. 반환값은 해제 함수다.
 *
 * **`@tauri-apps/api` 를 의존으로 들이지 않고** 이벤트 플러그인의 invoke 표면을 직접 쓴다 —
 * `runnerLauncher.ts::listenRunnerExit` 와 **같은 경로**다. 그 파일 주석의 근거가 그대로
 * 적용된다: 이 저장소는 `__TAURI_INTERNALS__.invoke` 하나로 표면을 다루고, 이벤트 하나
 * 때문에 그 규칙을 깨면 표면이 둘로 갈린다.
 *
 * 표면이 없으면 **아무것도 하지 않는 해제 함수**를 준다 — 던지지 않는다. 이벤트를 못 듣는
 * 것은 화면이 이미 `hasClaudeAccountsSurface` 로 아는 사실이고, 여기서 던지면 그 화면의
 * 마운트가 깨진다(관찰 하나가 화면을 죽이지 않는다는 규율).
 */
export async function listenClaudeLogin(
  cb: (e: ClaudeLoginEvent) => void,
): Promise<() => void> {
  const api = internals();
  if (typeof api?.invoke !== 'function' || typeof api.transformCallback !== 'function') {
    return () => undefined;
  }
  const invoke = api.invoke;
  const handlerId = api.transformCallback((payload) => {
    const message = payload as { payload?: unknown };
    const body = message?.payload as ClaudeLoginEvent | undefined;
    // **`loginId` 가 없는 것은 버린다.** 화면은 그 값으로 어느 로그인의 통지인지 가른다 —
    // 없으면 쓸 수 없고, 올려 보내면 화면이 그것을 다시 버릴 뿐이다.
    if (body && typeof body.loginId === 'string') cb(body);
  });
  const eventId = await invoke('plugin:event|listen', {
    event: CLAUDE_LOGIN_EVENT,
    target: { kind: 'Any' },
    handler: handlerId,
  });
  return () => {
    void invoke('plugin:event|unlisten', { event: CLAUDE_LOGIN_EVENT, eventId });
  };
}

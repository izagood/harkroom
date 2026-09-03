/**
 * 세션 보관. 데스크탑 앱에서는 **OS 키체인**(macOS Keychain / Windows Credential Manager /
 * Linux Secret Service)에 넣고, 그것이 없는 환경(브라우저 개발·테스트)에서는 `localStorage`로
 * 물러난다.
 *
 * 왜 비동기인가: 키체인 접근은 Tauri IPC 뒤에 있어 필연적으로 비동기다. `localStorage`가
 * 동기라서 이 표면도 동기였지만, 키체인을 지원하려면 여기서 한 번 바꾸는 것이 호출부마다
 * 우회로를 만드는 것보다 낫다.
 *
 * 한계를 분명히 적는다: **폴백 경로의 토큰은 평문이다.** 브라우저 개발에서는 그것을 받아들이고
 * (배포되는 표면이 아니다), 배포되는 데스크탑 앱에서는 키체인을 쓴다.
 *
 * ## 저장 구조 (#164)
 *
 * - 단일 세션(`murmur.session`)에서 N개 커뮤니티 지원(`murmur.sessions`)으로 변경.
 * - 키: 커뮤니티 구분은 계정 id다. URL(baseUrl)이 아니다 — 같은 서버가 localhost와 LAN IP 등 여러 URL 로 닿을 수 있어 URL 로 키를 두면 같은 커뮤니티가 목록에 두 번 나타난다.
 * - accountId는 서버 DB의 UUID라 어느 URL로 접근해도 동일하고, 다른 서버와는 다르다.
 */
import { useAppStore } from '../state/appStore';

export interface StoredCommunity {
  accountId: string;
  baseUrl: string;
  token: string;
  handle: string;
}

export interface StoredSessions {
  active: string | null;
  communities: StoredCommunity[];
}

const KEY = 'murmur.sessions';
const LEGACY_KEY = 'murmur.session';

/**
 * 키체인 쓰기가 실패했을 때 사람 앞에 세우는 문구(#212).
 *
 * 두 가지를 **다** 말해야 한다: 저장이 안 됐다는 것과, 지금은 계속 쓸 수 있지만 앱을 다시
 * 켜면 다시 로그인해야 한다는 것. 앞만 말하면 사람은 무엇이 걸린 일인지 모르고, 뒤를 빼면
 * 다음 기동의 로그아웃이 여전히 이유 없는 로그아웃으로 남는다 — 이 이슈가 고치려는 것이 그것이다.
 *
 * 문구는 영어다(저장소 관례 — UI 문자열은 영어, 주석은 한국어).
 */
const SAVE_FAILED_NOTICE =
  'Could not save your session to the OS keychain. You can keep using the app now, but you will need to sign in again the next time you open it.';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? internals.invoke : null;
}

const readPlain = (): StoredSessions | null => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSessions;
    return parsed.communities && Array.isArray(parsed.communities) ? parsed : null;
  } catch { return null; }
};

const writePlain = (s: StoredSessions): void => {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장 불가 환경 허용 */ }
};

const clearPlain = (): void => {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
};

const parse = (raw: unknown): StoredSessions | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSessions;
    return parsed.communities && Array.isArray(parsed.communities) ? parsed : null;
  } catch { return null; }
};

const readLegacyPlain = (): { baseUrl: string; token: string } | null => {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { baseUrl: string; token: string };
    return parsed.baseUrl && parsed.token ? parsed : null;
  } catch { return null; }
};

export const sessionStore = {
  async load(): Promise<StoredSessions | null> {
    const invoke = tauriInvoke();
    if (!invoke) {
      const newFormat = readPlain();
      if (newFormat) return newFormat;
      const legacy = readLegacyPlain();
      if (!legacy) return null;
      const migrated: StoredSessions = {
        active: null,
        communities: [{ accountId: '', baseUrl: legacy.baseUrl, token: legacy.token, handle: '' }],
      };
      writePlain(migrated);
      localStorage.removeItem(LEGACY_KEY);
      return migrated;
    }
    try {
      const fromKeychain = parse(await invoke('secret_get', { key: KEY }));
      if (fromKeychain) return fromKeychain;
      const legacy = readLegacyPlain();
      if (!legacy) return null;
      const migrated: StoredSessions = {
        active: null,
        communities: [{ accountId: '', baseUrl: legacy.baseUrl, token: legacy.token, handle: '' }],
      };
      await invoke('secret_set', { key: KEY, value: JSON.stringify(migrated) });
      localStorage.removeItem(LEGACY_KEY);
      return migrated;
    } catch {
      return readPlain();
    }
  },

  async save(s: StoredSessions): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) { writePlain(s); return; }
    try {
      await invoke('secret_set', { key: KEY, value: JSON.stringify(s) });
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // 평문으로 **내려가지 않는다**(#212). 키체인을 쓰겠다고 해놓고 조용히 평문이 되는 것이
      // 더 나쁘다 — 그 결정은 유지한다. 고칠 것은 아무에게도 알리지 않는 것 하나였다:
      // 세션이 어디에도 없는데 화면은 로그인 상태라, 사람은 다음 기동에 로그아웃되고 이유를
      // 알 방법이 없었다.
      //
      // 알림을 호출부에 맡기지 않고 여기서 세우는 이유: save() 를 부르는 자리가 여럿이고
      // (로그인 직후의 App, remove()), 한 곳이 확인을 빼먹으면 이 조용한 삼킴이 그대로
      // 돌아온다. 실패한 자리에서 알리면 빼먹을 수가 없다.
      //
      // 재시도는 넣지 않는다 — 키체인 잠김은 사람이 풀어야 하는 것이고, 조용한 재시도는
      // 실패를 다시 숨긴다. 이번 실행은 메모리의 세션으로 계속된다(로그인을 막지 않는다).
      useAppStore.getState().set({ notice: SAVE_FAILED_NOTICE });
    }
  },

  /**
   * **커뮤니티 하나만** 목록에서 뺀다(#164). 세션 하나가 죽었다고 나머지 커뮤니티의
   * 토큰까지 지우면, 이 이슈가 고치려던 것("셋 중 하나가 죽었는데 전부 잃는다")의
   * 데이터 버전이 된다.
   *
   * 지운 것이 활성이었으면 `active` 를 비운다 — 다음 기동이 첫 커뮤니티로 떨어진다.
   */
  async remove(accountId: string): Promise<void> {
    const current = await this.load();
    if (!current) return;
    const communities = current.communities.filter((c) => c.accountId !== accountId);
    if (!communities.length) return this.clear();
    await this.save({
      active: current.active === accountId ? null : current.active,
      communities,
    });
  },

  /** 전부 지운다 — 마지막 커뮤니티가 사라졌거나 사용자가 명시적으로 로그아웃했을 때다. */
  async clear(): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) { clearPlain(); localStorage.removeItem(LEGACY_KEY); return; }
    try {
      await invoke('secret_delete', { key: KEY });
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* 지울 수 없으면 다음 기동에 다시 시도된다 */ }
  },
};
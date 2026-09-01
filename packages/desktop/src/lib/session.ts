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
 */
export interface StoredSession { baseUrl: string; token: string }

const KEY = 'murmur.session';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri 안에서 도는가. v2 는 `__TAURI_INTERNALS__.invoke` 를 심는다. */
function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? internals.invoke : null;
}

const readPlain = (): StoredSession | null => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed.baseUrl && parsed.token ? parsed : null;
  } catch { return null; } // 손상된 항목은 없는 것과 같이 취급한다
};

const writePlain = (s: StoredSession): void => {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장 불가 환경 허용 */ }
};

const clearPlain = (): void => {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
};

const parse = (raw: unknown): StoredSession | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed.baseUrl && parsed.token ? parsed : null;
  } catch { return null; }
};

export const sessionStore = {
  async load(): Promise<StoredSession | null> {
    const invoke = tauriInvoke();
    if (!invoke) return readPlain();
    try {
      const fromKeychain = parse(await invoke('secret_get', { key: KEY }));
      if (fromKeychain) return fromKeychain;
      // 마이그레이션. 기존 사용자의 토큰은 localStorage 에 있다 — 이 경로가 없으면 이 버전을
      // 배포하는 순간 전원이 로그아웃된다. 옮긴 뒤 **평문을 지운다**(옮기기만 하면 의미가 없다).
      const legacy = readPlain();
      if (!legacy) return null;
      await invoke('secret_set', { key: KEY, value: JSON.stringify(legacy) });
      clearPlain();
      return legacy;
    } catch {
      // 키체인이 잠겨 있거나 사용자가 접근을 거부했다. 여기서 null 을 주면 로그아웃되므로,
      // 평문 경로로 물러나 세션을 유지한다(아직 마이그레이션 전일 수도 있다).
      return readPlain();
    }
  },

  async save(s: StoredSession): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) { writePlain(s); return; }
    try {
      await invoke('secret_set', { key: KEY, value: JSON.stringify(s) });
      clearPlain(); // 키체인에 넣었으면 평문 사본을 남기지 않는다
    } catch {
      // 저장 실패로 로그인 자체를 막지 않는다 — 이번 세션은 메모리로 돌고, 다음 기동에
      // 다시 로그인하면 된다. 평문으로 쓰지 않는 이유: 키체인을 쓰겠다고 했으면 조용히
      // 평문으로 내려가서는 안 된다(그게 더 나쁜 실패다).
    }
  },

  async clear(): Promise<void> {
    clearPlain(); // 마이그레이션이 반쯤 된 상태도 있으므로 양쪽을 지운다
    const invoke = tauriInvoke();
    if (!invoke) return;
    try { await invoke('secret_delete', { key: KEY }); } catch { /* 지울 수 없으면 다음 기동에 다시 시도된다 */ }
  },
};

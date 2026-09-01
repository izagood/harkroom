import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../src/lib/session';

/** Tauri IPC 스텁. 키체인은 IPC 뒤에 있으므로 여기서 그 경계를 흉내낸다. */
function keychain(): { vault: Map<string, string>; invoke: ReturnType<typeof vi.fn> } {
  const vault = new Map<string, string>();
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'secret_get') return vault.get(String(args?.key)) ?? null;
    if (cmd === 'secret_set') { vault.set(String(args?.key), String(args?.value)); return null; }
    if (cmd === 'secret_delete') { vault.delete(String(args?.key)); return null; }
    throw new Error(`unknown command ${cmd}`);
  });
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
  return { vault, invoke };
}

beforeEach(() => {
  localStorage.clear();
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const session = { baseUrl: 'http://x:3400', token: 'murs_secret' };

describe('세션 보관 — 키체인이 있을 때', () => {
  it('keeps the token out of localStorage', async () => {
    const { vault } = keychain();

    await sessionStore.save(session);

    expect(JSON.stringify(vault ? [...vault.values()] : [])).toContain('murs_secret');
    expect(localStorage.getItem('murmur.session')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('murs_secret');
  });

  it('round-trips through the keychain', async () => {
    keychain();
    await sessionStore.save(session);

    expect(await sessionStore.load()).toEqual(session);
  });

  it('clears the keychain entry', async () => {
    const { vault } = keychain();
    await sessionStore.save(session);

    await sessionStore.clear();

    expect(await sessionStore.load()).toBeNull();
    expect([...vault.values()]).toEqual([]);
  });

  // 배포 순간 전원이 로그아웃되면 안 된다. 기존 사용자의 토큰은 localStorage 에 있다.
  it('migrates an existing localStorage session into the keychain and removes the plaintext', async () => {
    localStorage.setItem('murmur.session', JSON.stringify(session));
    const { vault } = keychain();

    const loaded = await sessionStore.load();

    expect(loaded).toEqual(session);
    expect([...vault.values()].join()).toContain('murs_secret');
    expect(localStorage.getItem('murmur.session')).toBeNull(); // 평문은 남기지 않는다
  });

  // 키체인이 잠겨 있거나 사용자가 접근을 거부하면 읽기가 던진다. 그때 로그아웃시키는 것보다
  // 평문 경로로 물러나 세션을 유지하는 편이 낫다 — 아직 마이그레이션 전일 수도 있다.
  it('falls back to localStorage when the keychain read fails', async () => {
    localStorage.setItem('murmur.session', JSON.stringify(session));
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => { throw new Error('keychain locked'); }),
    };

    expect(await sessionStore.load()).toEqual(session);
  });

  it('does not throw when saving fails', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => { throw new Error('keychain locked'); }),
    };

    await expect(sessionStore.save(session)).resolves.toBeUndefined();
  });
});

describe('세션 보관 — 키체인이 없을 때(브라우저 개발)', () => {
  it('uses localStorage so dev in a browser still works', async () => {
    await sessionStore.save(session);

    expect(await sessionStore.load()).toEqual(session);
    expect(localStorage.getItem('murmur.session')).toBeTruthy();
  });

  it('returns null with nothing stored', async () => {
    expect(await sessionStore.load()).toBeNull();
  });

  it('ignores a corrupt entry instead of throwing', async () => {
    localStorage.setItem('murmur.session', '{not json');

    expect(await sessionStore.load()).toBeNull();
  });

  it('clears localStorage', async () => {
    await sessionStore.save(session);

    await sessionStore.clear();

    expect(await sessionStore.load()).toBeNull();
  });
});

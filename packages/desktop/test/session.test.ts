import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore, type StoredSessions, type StoredCommunity } from '../src/lib/session';

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

const community: StoredCommunity = { accountId: 'acct_123', baseUrl: 'http://x:3400', token: 'murs_secret', handle: 'testuser', label: null };
const sessions: StoredSessions = { active: 'acct_123', communities: [community] };

describe('세션 보관 — 키체인이 있을 때', () => {
  it('keeps the token out of localStorage', async () => {
    const { vault } = keychain();

    await sessionStore.save(sessions);

    expect(JSON.stringify(vault ? [...vault.values()] : [])).toContain('murs_secret');
    expect(localStorage.getItem('murmur.sessions')).toBeNull();
    expect(localStorage.getItem('murmur.session')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('murs_secret');
  });

  it('round-trips through the keychain', async () => {
    keychain();
    await sessionStore.save(sessions);

    expect(await sessionStore.load()).toEqual(sessions);
  });

  it('clears the keychain entry', async () => {
    const { vault } = keychain();
    await sessionStore.save(sessions);

    await sessionStore.clear();

    expect(await sessionStore.load()).toBeNull();
    expect([...vault.values()]).toEqual([]);
  });

  it('migrates an existing localStorage session into the keychain and removes the plaintext', async () => {
    localStorage.setItem('murmur.session', JSON.stringify({ baseUrl: 'http://x:3400', token: 'murs_secret' }));
    const { vault } = keychain();

    const loaded = await sessionStore.load();

    expect(loaded).toEqual({
      active: null,
      communities: [{ accountId: '', baseUrl: 'http://x:3400', token: 'murs_secret', handle: '', label: null }],
    });
    expect([...vault.values()].join()).toContain('murs_secret');
    expect(localStorage.getItem('murmur.session')).toBeNull();
  });

  it('falls back to localStorage when the keychain read fails', async () => {
    localStorage.setItem('murmur.sessions', JSON.stringify(sessions));
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => { throw new Error('keychain locked'); }),
    };

    expect(await sessionStore.load()).toEqual(sessions);
  });

  it('does not throw when saving fails', async () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => { throw new Error('keychain locked'); }),
    };

    await expect(sessionStore.save(sessions)).resolves.toBeUndefined();
  });
});

describe('세션 보관 — 키체인이 없을 때(브라우저 개발)', () => {
  it('uses localStorage so dev in a browser still works', async () => {
    await sessionStore.save(sessions);

    expect(await sessionStore.load()).toEqual(sessions);
    expect(localStorage.getItem('murmur.sessions')).toBeTruthy();
  });

  it('returns null with nothing stored', async () => {
    expect(await sessionStore.load()).toBeNull();
  });

  it('ignores a corrupt entry instead of throwing', async () => {
    localStorage.setItem('murmur.sessions', '{not json');

    expect(await sessionStore.load()).toBeNull();
  });

  it('clears localStorage', async () => {
    await sessionStore.save(sessions);

    await sessionStore.clear();

    expect(await sessionStore.load()).toBeNull();
  });
});

describe('다중 커뮤니티 (#164)', () => {
  it('같은 계정 id로 저장하면 항목을 늘리지 않고 갱신한다', async () => {
    keychain();
    await sessionStore.save({
      active: 'acct_123',
      communities: [{ accountId: 'acct_123', baseUrl: 'http://a:3400', token: 'token_a', handle: 'user_a', label: null }],
    });

    await sessionStore.save({
      active: 'acct_123',
      communities: [{ accountId: 'acct_123', baseUrl: 'http://b:3400', token: 'token_b', handle: 'user_b', label: null }],
    });

    const loaded = await sessionStore.load();
    expect(loaded?.communities.length).toBe(1);
    expect(loaded?.communities?.[0]?.token).toBe('token_b');
  });

  it('서로 다른 계정 id는 항목을 둘로 만든다', async () => {
    keychain();
    await sessionStore.save({
      active: 'acct_123',
      communities: [{ accountId: 'acct_123', baseUrl: 'http://a:3400', token: 'token_a', handle: 'user_a', label: null }],
    });

    await sessionStore.save({
      active: 'acct_456',
      communities: [
        { accountId: 'acct_123', baseUrl: 'http://a:3400', token: 'token_a', handle: 'user_a', label: null },
        { accountId: 'acct_456', baseUrl: 'http://b:3400', token: 'token_b', handle: 'user_b', label: null },
      ],
    });

    const loaded = await sessionStore.load();
    expect(loaded?.communities.length).toBe(2);
  });

  it('active를 바꾸면 유지된다', async () => {
    keychain();
    await sessionStore.save({
      active: 'acct_123',
      communities: [
        { accountId: 'acct_123', baseUrl: 'http://a:3400', token: 'token_a', handle: 'user_a', label: null },
        { accountId: 'acct_456', baseUrl: 'http://b:3400', token: 'token_b', handle: 'user_b', label: null },
      ],
    });

    await sessionStore.save({
      active: 'acct_456',
      communities: [
        { accountId: 'acct_123', baseUrl: 'http://a:3400', token: 'token_a', handle: 'user_a', label: null },
        { accountId: 'acct_456', baseUrl: 'http://b:3400', token: 'token_b', handle: 'user_b', label: null },
      ],
    });

    const loaded = await sessionStore.load();
    expect(loaded?.active).toBe('acct_456');
  });
});

describe('커뮤니티 단위 제거 (#164)', () => {
  // 세션 하나가 죽었다고 나머지 커뮤니티의 토큰까지 지우면, 이 이슈가 고치려던 것
  // ("셋 중 하나가 죽었는데 전부 잃는다")의 데이터 버전이 된다.
  it('하나만 빼고 나머지는 남는다', async () => {
    await sessionStore.save({
      active: 'a1',
      communities: [
        { accountId: 'a1', baseUrl: 'http://x', token: 't1', handle: 'h1', label: null },
        { accountId: 'a2', baseUrl: 'http://y', token: 't2', handle: 'h2', label: null },
      ],
    });

    await sessionStore.remove('a1');

    const after = await sessionStore.load();
    expect(after!.communities.map((c) => c.accountId)).toEqual(['a2']);
    expect(after!.communities[0]!.token).toBe('t2');
  });

  it('지운 것이 활성이었으면 active 를 비운다', async () => {
    await sessionStore.save({
      active: 'a1',
      communities: [
        { accountId: 'a1', baseUrl: 'http://x', token: 't1', handle: 'h1', label: null },
        { accountId: 'a2', baseUrl: 'http://y', token: 't2', handle: 'h2', label: null },
      ],
    });

    await sessionStore.remove('a1');

    expect((await sessionStore.load())!.active).toBeNull();
  });

  it('활성이 아닌 것을 빼면 active 가 유지된다', async () => {
    await sessionStore.save({
      active: 'a1',
      communities: [
        { accountId: 'a1', baseUrl: 'http://x', token: 't1', handle: 'h1', label: null },
        { accountId: 'a2', baseUrl: 'http://y', token: 't2', handle: 'h2', label: null },
      ],
    });

    await sessionStore.remove('a2');

    expect((await sessionStore.load())!.active).toBe('a1');
  });

  // 마지막 하나가 빠지면 전부 지운다 — 빈 목록을 남겨 두면 다음 기동이 "커뮤니티가
  // 있는데 못 붙는다" 로 보인다.
  it('마지막 하나를 빼면 보관소가 비워진다', async () => {
    await sessionStore.save({
      active: 'a1',
      communities: [{ accountId: 'a1', baseUrl: 'http://x', token: 't1', handle: 'h1', label: null }],
    });

    await sessionStore.remove('a1');

    expect(await sessionStore.load()).toBeNull();
  });

  // 마이그레이션된 항목은 active 가 null 이다. 복원이 그것을 첫 커뮤니티로 떨어뜨리지
  // 않으면 **배포하는 순간 전원이 로그아웃된다** — 이 이슈에서 가장 비싼 실패다.
  it('active 가 null 이어도 목록의 첫 항목이 남아 있다', async () => {
    localStorage.setItem('murmur.session', JSON.stringify({ baseUrl: 'http://x', token: 'murs_old' }));

    const loaded = await sessionStore.load();

    expect(loaded!.active).toBeNull();
    expect(loaded!.communities).toHaveLength(1);
    expect(loaded!.communities[0]!.token).toBe('murs_old');
  });
});

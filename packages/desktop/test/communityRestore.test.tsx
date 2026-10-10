import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import App from '../src/App';
import { ApiError } from '../src/lib/api';
import { sessionStore, type StoredSessions } from '../src/lib/session';
import type { connectWs } from '../src/lib/ws';
import { resetCommunityRegistry, useCommunityRegistry } from '../src/state/communities';
import { restoreCommunitySession, startCommunitySession } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';

/**
 * 기동 때 비활성 커뮤니티를 되살린다(2026-09-29 beta-team 사고).
 *
 * 사고: 앱이 기동할 때 보관본의 **활성 커뮤니티 하나만** 띄웠다. 나머지는 키체인에 그대로
 * 있었는데 레지스트리에 없어서, 앱을 다시 켤 때마다 레일에서 사라졌다. 곁가지로 활성 하나가
 * 못 붙으면 `clear()` 가 모든 커뮤니티의 토큰을 지웠다.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  resetCommunityRegistry();
});

const KEY = 'harkroom.sessions';
const two: StoredSessions = {
  active: 'acct-a',
  communities: [
    { accountId: 'acct-a', baseUrl: 'https://a.example', token: 't-a', handle: 'ja', label: null },
    { accountId: 'acct-b', baseUrl: 'https://b.example', token: 't-b', handle: 'jb', label: 'beta-team' },
  ],
};
const stored = (): StoredSessions => JSON.parse(localStorage.getItem(KEY) ?? 'null') as StoredSessions;

/** 서버 흉내. 호스트마다 `me` 가 누구인지, 또는 그 호스트가 어떻게 실패하는지 정한다. */
function stubServers(hosts: Record<string, 'ok' | 'down' | 'unauthorized'>) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input));
    const mode = hosts[url.host] ?? 'down';
    if (mode === 'down') throw new TypeError('Failed to fetch');
    if (mode === 'unauthorized') return json({ error: { code: 'unauthorized', message: 'bad token' } }, 401);
    switch (url.pathname) {
      case '/auth/me': return json(acc(`acct-${url.host[0]}`, `j${url.host[0]}`));
      case '/accounts': return json({ accounts: [], groups: [], teams: [] });
      case '/channels': return json({ channels: [] });
      case '/dms': return json({ dms: [] });
      case '/leases': return json({ leases: [] });
      case '/inbox': return json({ entries: [] });
      case '/reads': return json({ reads: [] });
      default: return json({});
    }
  }));
  // 소켓은 이 테스트의 관심이 아니다 — 열리지도 끊기지도 않는 채로 둔다.
  vi.stubGlobal('WebSocket', class { close() {} send() {} addEventListener() {} removeEventListener() {} });
}

const accountIds = () => useCommunityRegistry.getState().entries.map((e) => e.accountId);

describe('기동 복원 — App', () => {
  it('brings every stored community back into the registry, not just the active one', async () => {
    localStorage.setItem(KEY, JSON.stringify(two));
    stubServers({ 'a.example': 'ok', 'b.example': 'ok' });

    render(<App />);

    await waitFor(() => expect(accountIds()).toEqual(['acct-a', 'acct-b']));
    // 사람이 붙인 이름이 복원에서도 살아 있다.
    expect(useCommunityRegistry.getState().entries[1]!.label).toBe('beta-team');
  });

  it('keeps an unreachable inactive community on the rail instead of dropping it', async () => {
    localStorage.setItem(KEY, JSON.stringify(two));
    stubServers({ 'a.example': 'ok', 'b.example': 'down' });

    render(<App />);

    await waitFor(() => expect(accountIds()).toEqual(['acct-a', 'acct-b']));
    const b = useCommunityRegistry.getState().entries[1]!;
    expect(b.store.getState().connected).toBe(false);
    // 보관본도 그대로다 — 서버가 잠깐 내려간 것은 커뮤니티를 잃을 이유가 아니다.
    await Promise.resolve();
    expect(stored().communities.map((c) => c.accountId)).toEqual(['acct-a', 'acct-b']);
  });

  it('drops only the inactive community whose token the server rejected', async () => {
    localStorage.setItem(KEY, JSON.stringify(two));
    stubServers({ 'a.example': 'ok', 'b.example': 'unauthorized' });

    render(<App />);

    await waitFor(() => expect(stored().communities.map((c) => c.accountId)).toEqual(['acct-a']));
    expect(accountIds()).toEqual(['acct-a']);
  });

  it('keeps every stored community when the active server is unreachable at boot', async () => {
    localStorage.setItem(KEY, JSON.stringify(two));
    stubServers({ 'a.example': 'down', 'b.example': 'ok' });

    render(<App />);

    expect(await screen.findByText(/Could not reach a\.example/)).toBeTruthy();
    // 예전에는 여기서 `clear()` 가 두 커뮤니티의 토큰을 모두 지웠다.
    expect(stored().communities.map((c) => c.accountId)).toEqual(['acct-a', 'acct-b']);
  });

  it('removes only the active community when the server rejects its token at boot', async () => {
    localStorage.setItem(KEY, JSON.stringify(two));
    stubServers({ 'a.example': 'unauthorized', 'b.example': 'ok' });

    render(<App />);

    expect(await screen.findByText(/expired/)).toBeTruthy();
    expect(stored().communities.map((c) => c.accountId)).toEqual(['acct-b']);
  });
});

describe('restoreCommunitySession', () => {
  const makeWs = (() => ({ close: vi.fn(), send: vi.fn() })) as unknown as typeof connectWs;
  const base = { baseUrl: 'https://b.example', token: 't-b', accountId: 'acct-b', label: null, makeWs };

  async function withActive() {
    await startCommunitySession({
      baseUrl: 'https://a.example', token: 't-a', active: true, accountId: 'acct-a', label: null,
      api: fakeApi({ baseUrl: 'https://a.example' }), makeWs,
    });
  }

  it('retries a failed start and attaches the controller once the server answers', async () => {
    await withActive();
    let calls = 0;
    const makeApi = vi.fn(() => fakeApi({
      baseUrl: 'https://b.example',
      me: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return acc('acct-b', 'jb');
      }),
    }));

    restoreCommunitySession({ ...base, makeApi, retryDelaysMs: [0], onCredentialRejected: vi.fn() });

    // 첫 시도가 실패해도 타일은 선다.
    expect(accountIds()).toEqual(['acct-a', 'acct-b']);
    await waitFor(() => expect(makeApi).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useCommunityRegistry.getState().entries[1]!.controller).not.toBeNull());
  });

  it('drops the entry and reports it when the server rejects the token', async () => {
    await withActive();
    const onCredentialRejected = vi.fn();
    const makeApi = () => fakeApi({
      me: vi.fn(async () => { throw new ApiError(401, 'unauthorized', 'bad token'); }),
    });

    restoreCommunitySession({ ...base, makeApi, retryDelaysMs: [0], onCredentialRejected });

    await waitFor(() => expect(onCredentialRejected).toHaveBeenCalledWith('acct-b'));
    expect(accountIds()).toEqual(['acct-a']);
  });

  it('does not treat a non-401 server error as a dead token', async () => {
    await withActive();
    const onCredentialRejected = vi.fn();
    const makeApi = vi.fn(() => fakeApi({
      me: vi.fn(async () => { throw new ApiError(415, 'fst_err_ctp_invalid_media_type', 'old server'); }),
    }));

    const handle = restoreCommunitySession({ ...base, makeApi, retryDelaysMs: [0], onCredentialRejected });

    await waitFor(() => expect(makeApi.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(onCredentialRejected).not.toHaveBeenCalled();
    expect(accountIds()).toEqual(['acct-a', 'acct-b']);
    handle.cancel();
    expect(accountIds()).toEqual(['acct-a']);
  });

  it('does not add a second entry for an account that is already on the rail', async () => {
    await withActive();

    restoreCommunitySession({ ...base, accountId: 'acct-a', makeApi: () => fakeApi(), onCredentialRejected: vi.fn() });

    expect(accountIds()).toEqual(['acct-a']);
  });
});

describe('보관본 중복 접기', () => {
  it('folds a community stored twice into one, keeping the newer token and the label', async () => {
    localStorage.setItem(KEY, JSON.stringify({
      active: 'acct-a',
      communities: [
        { accountId: 'acct-a', baseUrl: 'https://a.example', token: 't-a', handle: 'ja', label: null },
        { accountId: 'acct-b', baseUrl: 'https://b.example', token: 'old', handle: 'jb', label: 'beta-team' },
        { accountId: 'acct-b', baseUrl: 'https://b.example', token: 'new', handle: 'jb', label: null },
      ],
    }));

    const loaded = await sessionStore.load();

    expect(loaded!.communities).toEqual([
      { accountId: 'acct-a', baseUrl: 'https://a.example', token: 't-a', handle: 'ja', label: null },
      { accountId: 'acct-b', baseUrl: 'https://b.example', token: 'new', handle: 'jb', label: 'beta-team' },
    ]);
  });
});

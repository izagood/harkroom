import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import type { WsCallbacks, connectWs } from '../src/lib/ws';
import App from '../src/App';
import { Workspace } from '../src/components/Workspace';
import { ConnectScreen } from '../src/screens/ConnectScreen';
import {
  resetCommunityRegistry,
  useCommunityRegistry,
  type CommunityEntry,
} from '../src/state/communities';
import { startCommunitySession, type Controller } from '../src/state/controller';
import { acc, chan, fakeApi } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * 한 커뮤니티의 세션이 끝났을 때(designer 시안 ④ B, 2026-10-27).
 *
 * 그날의 사고: 활성 커뮤니티 하나가 14일 만료로 끊기자 앱 전체가 첫 실행 로그인 화면으로 바뀌어 레일이 사라졌고,
 * 살아 있던 다른 커뮤니티로 갈 길이 없어 "둘 다 못 들어간다"로 읽혔다. 여기서 지키는 것:
 * - d1 다른 커뮤니티가 살아 있으면 레일이 남고 그 자리에 다시 로그인 패널이 선다
 * - d2 「로그인 필요」는 warning 이고 글자로도 말한다
 * - d3 보고 있지 않은 커뮤니티가 끝나면 카드 한 장, [나중에] 뒤에도 점·칩은 남는다
 * - d4 다시 로그인하면 같은 자리로 돌아오고 다른 연결은 끊기지 않는다
 * - d5 전부 끝나면 저장된 커뮤니티 줄이 있는 로그인 화면, 첫 실행 링크는 접힌다
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

/** `App` 경로의 소켓 — 커뮤니티마다 콜백을 잡아 둔다. 세션 손실은 이 콜백으로 흉내 낸다. */
const wsSpy = vi.hoisted(() => ({ cbs: [] as { url: string; cb: WsCallbacks }[], closed: 0 }));
vi.mock('../src/lib/ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ws')>();
  return {
    ...actual,
    connectWs: (url: string, _ticket: unknown, cb: WsCallbacks) => {
      wsSpy.cbs.push({ url, cb });
      return { close: () => { wsSpy.closed += 1; }, send: () => {} };
    },
  };
});

function capturingWs() {
  const cbs: WsCallbacks[] = [];
  const makeWs = ((_url: string, _t: unknown, cb: WsCallbacks) => {
    cbs.push(cb);
    return { close: vi.fn(), send: vi.fn() };
  }) as unknown as typeof connectWs;
  return { makeWs, cbs };
}

const fakeController = (baseUrl: string) => ({
  api: { baseUrl },
  openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(), stop: vi.fn(),
  createChannel: vi.fn(), updateChannel: vi.fn(), goBack: vi.fn(), goForward: vi.fn(),
  setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
  projectionConfig: vi.fn(async () => ({ url: null, source: null, appUrl: null, envUrl: null })),
  setProjectionConfig: vi.fn(async () => ({ url: null, source: null, appUrl: null, envUrl: null })),
  refreshProjection: vi.fn(async () => {}),
}) as unknown as Controller;

function seed(entry: CommunityEntry, handle: string): void {
  const me = acc('u1', handle, 'human', true);
  entry.store.getState().set({
    me, accounts: { u1: me }, channels: [chan('c1', 'general')], dms: [],
    unread: [], online: [], connected: true, activeChannelId: null,
  });
  useCommunityRegistry.getState().attachController(entry.id, fakeController(entry.baseUrl));
}

async function community(baseUrl: string, accountId: string, active: boolean, loginId: string | null = null) {
  const { makeWs, cbs } = capturingWs();
  const entry = await startCommunitySession({
    baseUrl, token: `t-${accountId}`, accountId, label: null, loginId, active,
    api: fakeApi({ baseUrl }), makeWs,
  });
  return { entry, cbs };
}

const entryOf = (id: string) => useCommunityRegistry.getState().entries.find((e) => e.id === id)!;

/** 서버 두 대를 흉내내는 `fetch`. 비밀번호가 'bad' 면 로그인을 401 로 거절한다. */
function serverFetch() {
  const who: Record<string, { id: string; handle: string }> = {
    'https://a.example': { id: 'acct-a', handle: 'me-a' },
    'https://b.example': { id: 'acct-b', handle: 'me-b' },
  };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const host = Object.keys(who).find((h) => url.startsWith(h)) ?? 'https://a.example';
    const me = who[host]!;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const account = {
      id: me.id, handle: me.handle, displayName: me.handle, kind: 'human', isAdmin: true,
      disabled: false, deleted: false, status: 'available', statusText: null, ownerAccountId: null,
      avatarAttachmentId: null,
    };
    if (url.endsWith('/auth/login')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { password?: string };
      return body.password === 'bad'
        ? json({ error: { code: 'invalid_credentials', message: '로그인 ID 또는 비밀번호가 틀렸다' } }, 401)
        : json({ token: `tok-${me.id}` });
    }
    if (url.endsWith('/auth/me')) return json(account);
    if (url.endsWith('/accounts')) return json({ accounts: [account], groups: [] });
    if (url.endsWith('/channels')) return json({ channels: [] });
    if (url.endsWith('/channels/prefs')) return json({ prefs: [] });
    if (url.endsWith('/dms')) return json({ dms: [] });
    if (url.endsWith('/leases')) return json({ leases: [] });
    if (url.includes('/inbox')) return json({ entries: [] });
    if (url.endsWith('/reads')) return json({ reads: [] });
    return json({});
  });
}

beforeEach(() => {
  resetCommunityRegistry();
  localStorage.clear();
  wsSpy.cbs = [];
  wsSpy.closed = 0;
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('세션 손실 표시는 커뮤니티를 세우는 길마다 선다', () => {
  it('활성·비활성 모두 credential 손실이면 그 엔트리만 signedOut 이 된다', async () => {
    const a = await community('https://a.example', 'acct-a', true);
    const b = await community('https://b.example', 'acct-b', false);
    seed(entryOf(a.entry.id), 'me-a');

    act(() => { b.cbs[0]!.onDown('credential'); });
    expect(entryOf(b.entry.id).signedOut).toBe(true);
    expect(entryOf(a.entry.id).signedOut).toBe(false);

    act(() => { a.cbs[0]!.onDown('credential'); });
    expect(entryOf(a.entry.id).signedOut).toBe(true);
  });

  it('네트워크 끊김은 표시를 세우지 않는다', async () => {
    const a = await community('https://a.example', 'acct-a', true);
    act(() => { a.cbs[0]!.onDown('network'); });
    expect(entryOf(a.entry.id).signedOut).toBe(false);
  });
});

describe('d1·d2 보고 있는 커뮤니티가 끝났다', () => {
  async function activeSignedOut() {
    const a = await community('https://a.example', 'acct-a', true, 'login-a');
    const b = await community('https://b.example', 'acct-b', false);
    seed(entryOf(b.entry.id), 'me-b');
    act(() => { useCommunityRegistry.getState().setSignedOut(a.entry.id, true); });
    return { a: a.entry, b: b.entry };
  }

  it('레일은 남고 사이드바+본문 자리에 서버·ID 가 고정된 패널이 선다', async () => {
    await activeSignedOut();
    render(<Workspace onLogout={() => {}} onOpenSettings={() => {}} onRelogin={vi.fn()} />);

    const panel = screen.getByTestId('relogin-panel');
    expect(within(panel).getByRole('heading').textContent).toBe('a.example에서 로그아웃됐다');
    expect(screen.getByTestId('relogin-server').textContent).toBe('a.example');
    expect(screen.getByTestId('relogin-login-id').textContent).toBe('login-a');
    expect(screen.queryByTestId('relogin-login-id-input')).toBeNull();
    // 다른 커뮤니티가 살아 있으니 그 말을 덧붙인다.
    expect(panel.textContent).toContain('다른 커뮤니티는 그대로 연결돼 있다.');
    // 레일 타일이 남아 있고, 끝난 상태를 점과 글자(aria)로 말한다 — 빨간 끊김 점이 아니다.
    const tile = screen.getByTestId('rail-community-mark');
    expect(tile.getAttribute('aria-label')).toContain('로그인 필요');
    expect(screen.getByTestId('rail-community-signed-out')).toBeTruthy();
    expect(screen.queryByTestId('rail-community-offline')).toBeNull();
  });

  it('로그인 ID 를 모르는 옛 보관본이면 칸을 연다', async () => {
    const a = await community('https://a.example', 'acct-a', true);
    act(() => { useCommunityRegistry.getState().setSignedOut(a.entry.id, true); });
    render(<Workspace onLogout={() => {}} onOpenSettings={() => {}} onRelogin={vi.fn()} />);
    expect(screen.getByTestId('relogin-login-id-input')).toBeTruthy();
    // 다른 커뮤니티가 없으면 그 칸도, 「그대로 연결돼 있다」도 없다.
    expect(screen.queryByText('다른 커뮤니티로 가기')).toBeNull();
    expect(screen.getByTestId('relogin-panel').textContent).not.toContain('그대로 연결돼 있다');
  });

  it('「다른 커뮤니티로 가기」 줄을 누르면 그리로 간다', async () => {
    const { b } = await activeSignedOut();
    render(<Workspace onLogout={() => {}} onOpenSettings={() => {}} onRelogin={vi.fn()} />);

    const row = screen.getByTestId(`relogin-other-${b.id}`);
    expect(row.textContent).toContain('⌥⌘2');
    fireEvent.click(row);
    await waitFor(() => expect(useCommunityRegistry.getState().activeId).toBe(b.id));
    expect(screen.queryByTestId('relogin-panel')).toBeNull();
  });

  it('d4 비밀번호를 넣으면 그 서버에 로그인해 결과를 올린다 · 틀리면 오류를 그 자리에', async () => {
    await activeSignedOut();
    vi.stubGlobal('fetch', serverFetch());
    const onRelogin = vi.fn(async () => {});
    render(<Workspace onLogout={() => {}} onOpenSettings={() => {}} onRelogin={onRelogin} />);

    fireEvent.change(screen.getByTestId('relogin-password'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('relogin-submit'));
    expect((await screen.findByTestId('relogin-error')).textContent).toContain('틀렸다');
    expect(onRelogin).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('relogin-password'), { target: { value: 'good' } });
    fireEvent.click(screen.getByTestId('relogin-submit'));
    await waitFor(() => expect(onRelogin).toHaveBeenCalledWith({
      baseUrl: 'https://a.example', token: 'tok-acct-a', accountId: 'acct-a', handle: 'me-a', loginId: 'login-a',
    }));
  });
});

describe('d3 보고 있지 않은 커뮤니티가 끝났다', () => {
  async function inactiveSignedOut() {
    const a = await community('https://a.example', 'acct-a', true);
    const b = await community('https://b.example', 'acct-b', false);
    seed(entryOf(a.entry.id), 'me-a');
    act(() => { useCommunityRegistry.getState().setSignedOut(b.entry.id, true); });
    return { a: a.entry, b: b.entry };
  }

  it('카드 한 장 — [다시 로그인]은 그 커뮤니티로 가고, [나중에] 뒤에도 점·칩이 남는다', async () => {
    const { b } = await inactiveSignedOut();
    render(<Workspace onLogout={() => {}} onOpenSettings={() => {}} onRelogin={vi.fn()} />);

    const card = screen.getByTestId('signed-out-card');
    expect(card.textContent).toContain('b.example에서 로그아웃됐다');
    expect(card.textContent).toContain('지금 보는 a.example은 그대로다');
    // 오른쪽 위 노란 점이 선다.
    expect(screen.getByTestId('rail-community-others-signed-out')).toBeTruthy();
    expect(screen.getByTestId('rail-community-mark').getAttribute('aria-label')).toContain('다른 커뮤니티 1곳에 로그인 필요');

    fireEvent.click(within(card).getByTestId('signed-out-card-later'));
    expect(screen.queryByTestId('signed-out-card')).toBeNull();
    expect(screen.getByTestId('rail-community-others-signed-out')).toBeTruthy();
    fireEvent.click(screen.getByTestId('rail-community-mark'));
    expect(screen.getByTestId(`community-signed-out-${b.id}`).textContent).toBe('로그인 필요');
  });

  it('[다시 로그인]을 누르면 그 커뮤니티로 가서 패널이 선다', async () => {
    const { b } = await inactiveSignedOut();
    render(<Workspace onLogout={() => {}} onOpenSettings={() => {}} onRelogin={vi.fn()} />);
    fireEvent.click(screen.getByTestId('signed-out-card-relogin'));
    await waitFor(() => expect(useCommunityRegistry.getState().activeId).toBe(b.id));
    expect(await screen.findByTestId('relogin-panel')).toBeTruthy();
  });
});

describe('d5 전부 끝났다 — 로그인 화면', () => {
  it('저장된 커뮤니티 줄로 시작하고, 첫 실행 링크는 한 줄 뒤에 접힌다 · 빨간 안내를 겹치지 않는다', async () => {
    const a = await community('https://a.example', 'acct-a', true, 'login-a');
    const b = await community('https://b.example', 'acct-b', false, 'login-b');
    act(() => {
      useCommunityRegistry.getState().setSignedOut(a.entry.id, true);
      useCommunityRegistry.getState().setSignedOut(b.entry.id, true);
    });
    render(<ConnectScreen onConnected={vi.fn()} initialError="Your session is no longer valid" />);

    expect(screen.getByRole('heading').textContent).toBe('다시 로그인');
    expect(screen.queryByText('Your session is no longer valid')).toBeNull();
    expect((screen.getByLabelText('서버 주소', { exact: false }) as HTMLInputElement).value).toBe('https://a.example');
    expect(screen.getByTestId(`connect-saved-${a.entry.id}`).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId(`connect-saved-${b.entry.id}`));
    expect((screen.getByLabelText('서버 주소', { exact: false }) as HTMLInputElement).value).toBe('https://b.example');
    expect((screen.getByLabelText('로그인 ID', { exact: false }) as HTMLInputElement).value).toBe('login-b');

    // 첫 실행 링크는 접혀 있다.
    expect(screen.queryByText(/관리자 계정 만들기/)).toBeNull();
    fireEvent.click(screen.getByTestId('connect-show-new'));
    expect(screen.getByText(/관리자 계정 만들기/)).toBeTruthy();
  });

  it('처음 켠 앱(저장된 커뮤니티 없음)은 예전 그대로다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe('Harkroom');
    expect(screen.queryByTestId('connect-show-new')).toBeNull();
  });
});

describe('App 배선 — 활성 하나가 끝나도 로그인 전체 화면으로 가지 않는다', () => {
  const store = () => localStorage.setItem('harkroom.sessions', JSON.stringify({
    active: 'acct-a',
    communities: [
      { accountId: 'acct-a', baseUrl: 'https://a.example', token: 't-a', handle: 'me-a', label: null, loginId: 'login-a' },
      { accountId: 'acct-b', baseUrl: 'https://b.example', token: 't-b', handle: 'me-b', label: null },
    ],
  }));

  it('다른 커뮤니티가 살아 있으면 패널, 그것도 끝나면 저장된 줄이 있는 로그인 화면', async () => {
    store();
    vi.stubGlobal('fetch', serverFetch());
    render(<App />);
    expect(await screen.findByTestId('app-header')).toBeTruthy();
    await waitFor(() => expect(wsSpy.cbs.length).toBe(2));
    const cbOf = (host: string) => wsSpy.cbs.find((c) => c.url.startsWith(host))!.cb;

    act(() => { cbOf('https://a.example').onDown('credential'); });
    expect(await screen.findByTestId('relogin-panel')).toBeTruthy();
    expect(screen.getByTestId('relogin-login-id').textContent).toBe('login-a');
    const closedBefore = wsSpy.closed;

    // d4: 다시 로그인하면 같은 자리로 돌아오고 b 의 연결은 그대로다.
    fireEvent.change(screen.getByTestId('relogin-password'), { target: { value: 'good' } });
    fireEvent.click(screen.getByTestId('relogin-submit'));
    await waitFor(() => expect(screen.queryByTestId('relogin-panel')).toBeNull());
    expect(await screen.findByTestId('app-header')).toBeTruthy();
    const active = useCommunityRegistry.getState().entries.find((e) => e.id === useCommunityRegistry.getState().activeId)!;
    expect(active.accountId).toBe('acct-a');
    expect(active.signedOut).toBe(false);
    expect(useCommunityRegistry.getState().entries.filter((e) => e.accountId === 'acct-a')).toHaveLength(1);
    expect(wsSpy.closed).toBe(closedBefore);
    const saved = JSON.parse(localStorage.getItem('harkroom.sessions')!) as { communities: { accountId: string; loginId?: string }[] };
    expect(saved.communities.find((c) => c.accountId === 'acct-a')?.loginId).toBe('login-a');

    // 둘 다 끝나면 저장된 줄이 있는 로그인 화면이다.
    act(() => { cbOf('https://b.example').onDown('credential'); });
    const latestA = [...wsSpy.cbs].reverse().find((c) => c.url.startsWith('https://a.example'))!.cb;
    act(() => { latestA.onDown('credential'); });
    expect(await screen.findByRole('heading', { name: '다시 로그인' })).toBeTruthy();
  });
});

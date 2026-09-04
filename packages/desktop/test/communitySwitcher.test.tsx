import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { connectWs } from '../src/lib/ws';
import App from '../src/App';
import { Workspace } from '../src/components/Workspace';
import { CommunitySettings } from '../src/components/settings/CommunitySettings';
import { ConnectionSettings } from '../src/components/settings/ConnectionSettings';
import { ConnectScreen, type ConnectScreenProps } from '../src/screens/ConnectScreen';
import {
  resetCommunityRegistry,
  useActiveStore,
  useCommunityRegistry,
  type CommunityEntry,
} from '../src/state/communities';
import { setController, startCommunitySession, type Controller } from '../src/state/controller';
import { acc, chan, fakeApi } from './helpers/fakeApi';

/**
 * 커뮤니티 목록·추가·전환 UI(#165, #163 결정 A).
 *
 * 여기서 지키는 것은 네 가지다:
 * 1. 커뮤니티가 하나인 사람의 화면이 **하나도 바뀌지 않는다**(레일이 없다).
 * 2. 추가 흐름이 `phase` 를 건드리지 않는다 — 건드리면 다른 커뮤니티들의 라이브 연결이
 *    화면과 함께 사라진다. 이것이 이 이슈의 실제 문제다.
 * 3. 제거가 `logout()` 을 부르지 않는다 — 그것은 서버 세션까지 폐기해 **다른 기기**의
 *    세션까지 죽인다.
 * 4. 끊긴 커뮤니티가 목록 안에서 **개별로** 보인다(전역 하나로 뭉치지 않는다).
 *
 * `App` 을 통째로 띄우는 배선 테스트를 반드시 포함한다 — props 를 손으로 넘긴 테스트는
 * 앱에서 죽은 버튼을 초록으로 통과시킨다(이 저장소에서 여러 번 실측됐다).
 */

/** `App` 경로의 `connectWs` 호출을 **센다** — 추가 흐름이 기존 연결을 끊었는지는 수로만 보인다. */
const wsSpy = vi.hoisted(() => ({ count: 0, closed: 0 }));
vi.mock('../src/lib/ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ws')>();
  return {
    ...actual,
    connectWs: () => {
      wsSpy.count += 1;
      return { close: () => { wsSpy.closed += 1; }, send: () => {} };
    },
  };
});

function countingWs() {
  const urls: string[] = [];
  const makeWs = ((url: string) => {
    urls.push(url);
    return { close: vi.fn(), send: vi.fn() };
  }) as unknown as typeof connectWs;
  return { makeWs, urls };
}

/**
 * 커뮤니티 한 벌의 가짜 컨트롤러. `logout` 과 `stop` 을 **따로** 둔다 — 제거가 어느 쪽을
 * 부르는지가 이 이슈의 결정 4 그 자체다.
 */
const fakeController = (baseUrl: string) => ({
  api: { baseUrl },
  openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(), stop: vi.fn(),
  createChannel: vi.fn(), updateChannel: vi.fn(), goBack: vi.fn(), goForward: vi.fn(),
  setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
}) as unknown as Controller;

/** 화면이 서려면 필요한 최소 상태. 커뮤니티마다 다른 handle·연결 상태를 준다. */
function seed(entry: CommunityEntry, handle: string, connected: boolean): Controller {
  const me = acc('u1', handle, 'human', true);
  entry.store.getState().set({
    me, accounts: { u1: me }, channels: [chan('c1', 'general')], dms: [],
    unread: [], online: [], connected, activeChannelId: null,
  });
  const controller = fakeController(entry.baseUrl);
  useCommunityRegistry.getState().attachController(entry.id, controller);
  return controller;
}

async function community(baseUrl: string, accountId: string, active: boolean) {
  const { makeWs } = countingWs();
  return startCommunitySession({
    baseUrl, token: `t-${accountId}`, accountId, label: null, active,
    api: fakeApi({ baseUrl }), makeWs,
  });
}

const twoCommunities = async () => ({
  a: await community('https://a.example', 'acct-a', true),
  b: await community('https://b.example', 'acct-b', false),
});

const storeSessions = (communities: { accountId: string; baseUrl: string; handle: string }[]) =>
  localStorage.setItem('murmur.sessions', JSON.stringify({
    active: communities[0]?.accountId ?? null,
    communities: communities.map((c) => ({ ...c, token: `t-${c.accountId}`, label: null })),
  }));

/** 서버 두 대를 흉내내는 `fetch`. 호스트로 갈라 계정을 다르게 준다. */
function serverFetch() {
  const who: Record<string, { id: string; handle: string }> = {
    'https://a.example': { id: 'acct-a', handle: 'me-a' },
    'https://b.example': { id: 'acct-b', handle: 'me-b' },
  };
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const host = Object.keys(who).find((h) => url.startsWith(h)) ?? 'https://a.example';
    const me = who[host]!;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const account = {
      id: me.id, handle: me.handle, displayName: me.handle, kind: 'human', isAdmin: true,
      disabled: false, status: 'available', statusText: null, ownerAccountId: null,
      avatarAttachmentId: null,
    };
    if (url.endsWith('/auth/login')) return json({ token: `tok-${me.id}` });
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

const renderWorkspace = () => render(
  <Workspace onLogout={() => {}} onOpenSettings={() => {}} />,
);

/** `App` 을 띄워 설정 › Communities 까지 실제로 눌러 간다. props 를 손으로 넘기지 않는다. */
async function openCommunitySettingsInApp(handle: string) {
  render(<App />);
  expect(await screen.findByTestId('app-header')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: `@${handle}` }));
  fireEvent.click(await screen.findByText('Settings'));
  fireEvent.click(await screen.findByRole('button', { name: 'Communities' }));
  expect(await screen.findByRole('heading', { name: 'Communities' })).toBeTruthy();
}

beforeEach(() => {
  resetCommunityRegistry();
  localStorage.clear();
  wsSpy.count = 0;
  wsSpy.closed = 0;
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('커뮤니티 전환기 레일 (#165)', () => {
  it('1. 커뮤니티가 하나면 레일을 그리지 않는다 — 오늘 화면과 같다', async () => {
    const a = await community('https://a.example', 'acct-a', true);
    seed(a, 'me-a', true);

    renderWorkspace();

    // 폭 0 인 껍데기도 두지 않는다 — 없는 것을 위해 자리를 비우지 않는다는 결정이다.
    expect(screen.queryByTestId('community-rail')).toBeNull();
    expect(screen.queryByLabelText('커뮤니티 전환')).toBeNull();
  });

  it('2. 둘이면 타일 둘이고, 활성 타일이 구분되고, 접근 가능한 이름에 상태가 들어 있다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'me-a', true);
    seed(b, 'me-b', false);

    renderWorkspace();

    const rail = screen.getByTestId('community-rail');
    expect(within(rail).getAllByRole('button')).toHaveLength(2);
    // 이름을 붙이지 않았으면 호스트명이 기본값이고, 타일은 그 이니셜이다.
    expect(within(rail).getByTestId(`community-tile-${a.id}`).textContent).toContain('A');
    // 상태를 색·점으로만 말하지 않는다 — 점 하나는 스크린리더에 아무것도 아니다.
    expect(screen.getByLabelText('a.example — 연결됨')).toBeTruthy();
    expect(screen.getByLabelText('b.example — 연결 끊김')).toBeTruthy();
    expect(screen.getByTestId(`community-tile-${a.id}`).getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId(`community-tile-${b.id}`).getAttribute('aria-current')).toBeNull();
  });

  it('3. 타일을 누르면 활성이 바뀌고 useActiveStore 가 다른 스토어를 돌려준다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'me-a', true);
    seed(b, 'me-b', true);
    storeSessions([
      { accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' },
      { accountId: 'acct-b', baseUrl: 'https://b.example', handle: 'me-b' },
    ]);

    renderWorkspace();
    expect(useActiveStore.getState().me?.handle).toBe('me-a');

    fireEvent.click(screen.getByTestId(`community-tile-${b.id}`));

    await waitFor(() => expect(useCommunityRegistry.getState().activeId).toBe(b.id));
    expect(useActiveStore.getState().me?.handle).toBe('me-b');
    // 보관본의 활성도 함께 옮긴다 — 안 그러면 다음 기동마다 예전 커뮤니티로 돌아간다.
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('murmur.sessions')!) as { active: string };
      expect(stored.active).toBe('acct-b');
    });
    expect(a.id).not.toBe(b.id);
  });

  it('8. 끊긴 커뮤니티의 타일에만 상태 표시가 붙고, Connection 에 옛 문구가 없다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'me-a', true);
    seed(b, 'me-b', false);

    renderWorkspace();

    // "셋 중 하나가 끊겼다" 를 전역 하나로 뭉개지 않는다 — 끊긴 것에만 붙는다.
    expect(screen.getByTestId(`community-offline-${b.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`community-offline-${a.id}`)).toBeNull();

    cleanup();
    render(<ConnectionSettings onSignOut={() => {}} />);

    // (A) 아래서 거짓 문장이 된 옛 문구가 화면에 남아 있으면 안 된다.
    expect(screen.queryByText('Use a different server')).toBeNull();
    expect(screen.queryByText('Sign out to enter another server address.')).toBeNull();
    expect(screen.getByText('Sign out of this community')).toBeTruthy();
    expect(screen.getByText(/Settings › Communities/)).toBeTruthy();
  });
});

describe('커뮤니티 추가 (#165 결정 3)', () => {
  it('4. 추가 모달을 열고 닫아도 phase 가 그대로다 — 기존 연결이 끊기지 않는다 (App 배선)', async () => {
    storeSessions([{ accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' }]);
    vi.stubGlobal('fetch', serverFetch());

    await openCommunitySettingsInApp('me-a');
    expect(wsSpy.count).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Add community' }));
    expect(await screen.findByText('Sign in to another community')).toBeTruthy();

    // **설정 화면이 그대로 서 있다.** `phase` 를 `connect` 로 되돌렸다면 이 화면 자체가
    // 사라지고 접속 화면 하나만 남는다 — 그것이 이 이슈가 막는 결함이다.
    expect(screen.getByRole('heading', { name: 'Communities' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Sign in to another community')).toBeNull());

    // 워크스페이스로 돌아갈 수 있고(= 세션이 살아 있다), 연결을 다시 맺지도 끊지도 않았다.
    fireEvent.click(screen.getByText(/Back to app/));
    expect(await screen.findByTestId('app-header')).toBeTruthy();
    expect(wsSpy.count).toBe(1);
    expect(wsSpy.closed).toBe(0);
  });

  it('5a. add 모드는 onAdded 로 올려 보내고 초기 흐름의 onConnected 를 부르지 않으며, bootstrap 진입점이 없다', async () => {
    vi.stubGlobal('fetch', serverFetch());
    const onAdded = vi.fn();
    const onConnected = vi.fn();
    // `onConnected` 는 add 모드의 타입에 없다 — 그래도 넘겨 두고 **불리지 않음**을 본다.
    render(<ConnectScreen {...({
      mode: 'add', onAdded, onCancel: () => {}, onConnected,
    } as unknown as ConnectScreenProps)} />);

    // 이미 서버가 있는 사람이 새 서버를 부트스트랩하는 것은 다른 일이다 — 감춘다.
    expect(screen.queryByText('First run? Create the admin account')).toBeNull();
    // 초대 가입은 남는다 — 초대받은 커뮤니티를 하나 더 붙이는 것은 같은 일이다.
    expect(screen.getByText('Have an invite token? Join this workspace')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://b.example' } });
    fireEvent.change(screen.getByLabelText('Login ID'), { target: { value: 'me-b' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(onAdded.mock.calls[0]![2]).toBe('acct-b');
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('5b. 추가 성공이 레지스트리에 등록하고, 활성은 그대로다', async () => {
    const a = await community('https://a.example', 'acct-a', true);
    seed(a, 'me-a', true);
    storeSessions([{ accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' }]);
    vi.stubGlobal('fetch', serverFetch());

    render(<CommunitySettings onCommunitiesEmpty={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add community' }));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://b.example' } });
    fireEvent.change(screen.getByLabelText('Login ID'), { target: { value: 'me-b' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(useCommunityRegistry.getState().entries).toHaveLength(2));
    const entries = useCommunityRegistry.getState().entries;
    expect(entries[1]!.baseUrl).toBe('https://b.example');
    expect(entries[1]!.accountId).toBe('acct-b');
    // 추가는 **전환이 아니다** — 보고 있는 커뮤니티가 바뀌면 사람은 자기 대화를 잃는다.
    expect(useCommunityRegistry.getState().activeId).toBe(a.id);
    // 보관본에도 들어간다(다음 기동에 되살아난다).
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('murmur.sessions')!) as { communities: unknown[] };
      expect(stored.communities).toHaveLength(2);
    });
  });
  /**
   * 추가가 **폼 밖에서** 막히는 두 경우. 겹창이 목록을 덮으므로, 그 문구를 목록 쪽에만
   * 적으면 사람 눈에는 "로그인을 눌렀는데 아무 일도 없다" 가 된다 — 이 저장소가 반복해서
   * 잡아 온 '눌러도 아무 일이 없는 버튼'의 오류 버전이다.
   */
  it('5c. 이미 이 기기에 있는 커뮤니티를 다시 추가하면 겹창 안에서 그 이유를 말한다', async () => {
    const a = await community('https://a.example', 'acct-a', true);
    seed(a, 'me-a', true);
    storeSessions([{ accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' }]);
    vi.stubGlobal('fetch', serverFetch());

    render(<CommunitySettings onCommunitiesEmpty={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add community' }));
    // 같은 서버 = 같은 계정(acct-a) 이다.
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://a.example' } });
    fireEvent.change(screen.getByLabelText('Login ID'), { target: { value: 'me-a' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // 문구가 **겹창 안**에 있어야 한다. 목록 쪽에만 있으면 겹창이 덮어 보이지 않는다.
    const dialog = await screen.findByRole('dialog', { name: '커뮤니티 추가' });
    await waitFor(() => expect(
      within(dialog).getByText('This community is already on this device.'),
    ).toBeTruthy());

    // 목록도 늘지 않고, 겹창도 닫히지 않는다 — 사람이 서버 주소를 고쳐 다시 시도할 자리다.
    expect(useCommunityRegistry.getState().entries).toHaveLength(1);
    expect(screen.getByText('Sign in to another community')).toBeTruthy();
  });

  it('5d. 세션 시작이 실패한 커뮤니티는 목록에 남지 않는다', async () => {
    const a = await community('https://a.example', 'acct-a', true);
    seed(a, 'me-a', true);

    // 남기면 전환기 레일에 영원히 끊긴 타일이 서고, 사용자는 그것을 뺄 이유를 알 수 없다.
    await expect(startCommunitySession({
      baseUrl: 'https://b.example', token: 't-b', accountId: 'acct-b', label: null, active: false,
      api: fakeApi({ me: vi.fn(async () => { throw new Error('nope'); }) }),
      makeWs: countingWs().makeWs,
    })).rejects.toThrow('nope');

    expect(useCommunityRegistry.getState().entries).toHaveLength(1);
    expect(useCommunityRegistry.getState().activeId).toBe(a.id);
  });
});

describe('커뮤니티 제거 (#165 결정 4)', () => {
  it('6. 확인 전에는 아무 일도 없고, 제거는 logout() 을 부르지 않는다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'me-a', true);
    const cb = seed(b, 'me-b', true);
    storeSessions([
      { accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' },
      { accountId: 'acct-b', baseUrl: 'https://b.example', handle: 'me-b' },
    ]);

    render(<CommunitySettings onCommunitiesEmpty={vi.fn()} />);
    const row = screen.getByTestId(`community-row-${b.id}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));

    // 확인 단계다 — 문구가 "이 기기에서만 빠진다" 를 말하고, 아직 아무것도 안 했다.
    expect(screen.getByText(/It stays on the server/)).toBeTruthy();
    expect(useCommunityRegistry.getState().entries).toHaveLength(2);
    expect(cb.stop).not.toHaveBeenCalled();
    expect(cb.logout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove from this device' }));

    await waitFor(() => expect(useCommunityRegistry.getState().entries).toHaveLength(1));
    // **서버 세션을 폐기하지 않는다.** logout() 을 부르면 같은 서버에 붙은 다른 기기의
    // 세션까지 죽는다 — 커뮤니티를 이 기기에서 치우는 조작이 그것을 뜻하면 안 된다.
    expect(cb.logout).not.toHaveBeenCalled();
    expect(cb.stop).toHaveBeenCalled();
    // 키체인 항목도 빠진다.
    const stored = JSON.parse(localStorage.getItem('murmur.sessions')!) as { communities: { accountId: string }[] };
    expect(stored.communities.map((c) => c.accountId)).toEqual(['acct-a']);
  });

  it('7a. 활성 커뮤니티를 제거하면 남은 첫 번째가 활성이 된다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'me-a', true);
    seed(b, 'me-b', true);
    storeSessions([
      { accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' },
      { accountId: 'acct-b', baseUrl: 'https://b.example', handle: 'me-b' },
    ]);
    expect(useCommunityRegistry.getState().activeId).toBe(a.id);

    render(<CommunitySettings onCommunitiesEmpty={vi.fn()} />);
    const row = screen.getByTestId(`community-row-${a.id}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this device' }));

    await waitFor(() => expect(useCommunityRegistry.getState().entries).toHaveLength(1));
    expect(useCommunityRegistry.getState().activeId).toBe(b.id);
    expect(useActiveStore.getState().me?.handle).toBe('me-b');
  });

  it('7b. 마지막 하나를 제거하면 접속 화면으로 돌아간다 (App 배선)', async () => {
    storeSessions([{ accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' }]);
    vi.stubGlobal('fetch', serverFetch());

    await openCommunitySettingsInApp('me-a');

    const row = screen.getByTestId(`community-row-${useCommunityRegistry.getState().activeId}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this device' }));

    // 그때는 정말 세션이 없다 — 여기서만 `phase` 가 `connect` 로 돌아간다.
    expect(await screen.findByText('Server URL')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Communities' })).toBeNull();
  });
});

describe('커뮤니티 표시 이름 (#165 결정 2)', () => {
  it('9. 이름을 붙이면 타일·목록이 그것을 쓰고 보관본에 남는다. 비우면 호스트로 돌아간다', async () => {
    const { a, b } = await twoCommunities();
    seed(a, 'me-a', true);
    seed(b, 'me-b', true);
    storeSessions([
      { accountId: 'acct-a', baseUrl: 'https://a.example', handle: 'me-a' },
      { accountId: 'acct-b', baseUrl: 'https://b.example', handle: 'me-b' },
    ]);

    render(<CommunitySettings onCommunitiesEmpty={vi.fn()} />);
    const row = screen.getByTestId(`community-row-${b.id}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText(/Display name on this device/), {
      target: { value: 'Work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('murmur.sessions')!) as {
        communities: { accountId: string; label: string | null }[];
      };
      expect(stored.communities.find((c) => c.accountId === 'acct-b')!.label).toBe('Work');
    });
    expect(useCommunityRegistry.getState().entries.find((e) => e.id === b.id)!.label).toBe('Work');

    cleanup();
    renderWorkspace();
    // 이니셜 타일이 붙인 이름을 따른다(아바타가 아니다 — 서버 계약이 없다).
    expect(screen.getByLabelText('Work — 연결됨')).toBeTruthy();
    expect(screen.getByTestId(`community-tile-${b.id}`).textContent).toContain('W');
  });
});

afterEach(() => { setController(null); });

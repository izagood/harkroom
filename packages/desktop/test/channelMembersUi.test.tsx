import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan } from './helpers/fakeApi';
import type { ChannelMemberRow } from '@murmur/shared';

/**
 * 채널 멤버 화면의 회귀선(#183).
 *
 * 이 화면이 지켜야 하는 것은 "누가 있나"를 그리는 것만이 아니다. **서버가 정한 것보다
 * 넓은 것을 내주지 않는 것**이 같은 무게다 — 비멤버에게 초대를, 비admin 에게 내보내기를
 * 내주면 눌렀을 때 403 이 나고 그건 "할 수 있다"는 거짓 신호다(docs/design.md §4).
 * public 채널에서 이 목록의 뜻이 다르다는 것도 같은 종류의 사실이다: 멤버가 아니어도
 * 읽고 쓸 수 있으므로 목록에 없는 사람이 못 본다는 뜻으로 읽히면 안 된다.
 *
 * 역할(채널별 읽기/쓰기/관리 권한)은 이 작업의 범위가 아니다 — 여기서 구분하는 것은
 * 계정 속성 둘뿐이다: 워크스페이스 admin 인가, 에이전트인가 사람인가.
 */
const fakeController = (members: ChannelMemberRow[]) => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), archiveChannel: vi.fn(),
    toggleChannelMute: vi.fn(), toggleChannelStar: vi.fn(), send: vi.fn(),
    openThread: vi.fn(), loadOlder: vi.fn(), markChannelUnread: vi.fn(),
    loadChannelMembers: vi.fn(async (channelId: string) => {
      const store = useAppStore.getState();
      store.set({ channelMembers: { ...store.channelMembers, [channelId]: members } });
      return members;
    }),
    inviteChannelMember: vi.fn(async () => members),
    leaveChannel: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

/** c1 은 public, c2 는 private 이다 — 같은 목록이 두 채널에서 다른 뜻을 갖는지 본다. */
const seed = (opts: { admin: boolean }) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: { ...acc('u1', 'me'), isAdmin: opts.admin },
    accounts: {
      u1: { ...acc('u1', 'me'), isAdmin: opts.admin },
      u2: acc('u2', 'other'),
      a1: acc('a1', 'bot', 'agent'),
      ad: acc('ad', 'boss', 'human', true),
    },
    channels: [chan('c1', 'general'), chan('c2', 'secret', null, 'private')],
    dms: [], connected: true,
  });
};

const sidebar = () => render(
  <Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} onOpenDirectory={vi.fn()} onOpenInbox={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />,
);

const openMenuFor = (accessibleName: RegExp): void => {
  const row = screen.getByRole('button', { name: accessibleName }).closest('div')!;
  fireEvent.click(within(row).getByRole('button', { name: '⋯' }));
};

const openMembers = async (accessibleName: RegExp, channelId: string): Promise<HTMLElement> => {
  openMenuFor(accessibleName);
  fireEvent.click(screen.getByRole('menuitem', { name: '멤버 보기' }));
  // 패널로 범위를 좁힌다 — 사이드바 하단이 내 handle 을 똑같이 '@me' 로 그리므로
  // 화면 전체에서 찾으면 목록에 없는 것을 목록에 있다고 읽는다.
  return await screen.findByTestId(`members-${channelId}`);
};

const memberRow = (panel: HTMLElement, handle: string): HTMLElement =>
  within(panel).getByText(`@${handle}`).closest('li')!;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('채널 멤버 화면 (#183)', () => {
  it('멤버 목록이 그려지고 사람과 에이전트가 구분된다', async () => {
    seed({ admin: false });
    fakeController([
      { accountId: 'u1', handle: 'me' },
      { accountId: 'a1', handle: 'bot' },
    ]);
    sidebar();

    const panel = await openMembers(/# general\b/, 'c1');

    // 이름만 나열하면 "에이전트가 1급 참여자"라는 사실이 화면에서 사라진다 — 누가 사람이고
    // 누가 에이전트인지는 목록 자체가 말해야 한다.
    expect(within(memberRow(panel, 'me')).getByText('사람')).toBeTruthy();
    expect(within(memberRow(panel, 'bot')).getByText('에이전트')).toBeTruthy();
    expect(within(memberRow(panel, 'me')).queryByText('에이전트')).toBeNull();
  });

  it('admin 계정은 워크스페이스 admin 으로 표시된다 — 채널 역할이 아니다', async () => {
    seed({ admin: false });
    fakeController([
      { accountId: 'u1', handle: 'me' },
      { accountId: 'ad', handle: 'boss' },
    ]);
    sidebar();

    const panel = await openMembers(/# general\b/, 'c1');

    // 라벨이 '워크스페이스 admin' 인 것이 요점이다: 채널별 역할은 아직 없으므로
    // 이 배지를 '관리자'로 적으면 없는 개념을 있다고 말하는 것이 된다.
    expect(within(memberRow(panel, 'boss')).getByText('워크스페이스 admin')).toBeTruthy();
    expect(within(memberRow(panel, 'me')).queryByText('워크스페이스 admin')).toBeNull();
  });

  it('멤버는 초대할 수 있다', async () => {
    seed({ admin: false });
    const c = fakeController([{ accountId: 'u1', handle: 'me' }]);
    sidebar();

    const panel = await openMembers(/비공개 채널 secret\b/, 'c2');

    fireEvent.change(within(panel).getByLabelText('초대할 계정'), { target: { value: 'u2' } });
    fireEvent.click(within(panel).getByRole('button', { name: '초대' }));

    expect(c.inviteChannelMember).toHaveBeenCalledWith('c2', 'u2');
  });

  it('private 채널의 비멤버에게는 초대 항목이 아예 없다', async () => {
    // admin 은 자기가 없는 private 채널도 목록에서 보고 멤버까지 볼 수 있다(#182 의 절충).
    // 하지만 초대는 못 한다 — 서버 게이트가 `assertChannelVisible` 이라 403 이다.
    seed({ admin: true });
    fakeController([{ accountId: 'u2', handle: 'other' }]);
    sidebar();

    const panel = await openMembers(/비공개 채널 secret\b/, 'c2');

    expect(within(panel).getByText('@other')).toBeTruthy();
    expect(within(panel).queryByLabelText('초대할 계정')).toBeNull();
    expect(within(panel).queryByRole('button', { name: '초대' })).toBeNull();
    // 멤버가 아니므로 나갈 것도 없다.
    expect(within(panel).queryByRole('button', { name: '나가기' })).toBeNull();

    // 멤버가 아닌 것이 확인된 뒤에는 메뉴에서도 초대가 사라진다. 패널은 채널 행을
    // 대신 그리므로 먼저 닫아야 메뉴에 닿는다.
    fireEvent.click(within(panel).getByRole('button', { name: '닫기' }));
    openMenuFor(/비공개 채널 secret\b/);
    expect(screen.queryByRole('menuitem', { name: '초대' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '나가기' })).toBeNull();
    // 보는 것 자체는 계속 할 수 있다 — 뺀 것은 못 하는 동작뿐이다.
    expect(screen.getByRole('menuitem', { name: '멤버 보기' })).toBeTruthy();
  });

  it('admin 이 아니면 남을 빼는 항목이 없고 자기 나가기만 있다', async () => {
    seed({ admin: false });
    fakeController([
      { accountId: 'u1', handle: 'me' },
      { accountId: 'u2', handle: 'other' },
    ]);
    sidebar();

    const panel = await openMembers(/비공개 채널 secret\b/, 'c2');

    // 남을 빼는 것은 admin 만이다(#156). 항목을 내주면 눌렀을 때 403 이다.
    expect(within(panel).queryByLabelText('other 내보내기')).toBeNull();
    // 자기 자신은 언제나 나갈 수 있다 — 그것까지 막으면 private 채널이 편도가 된다.
    expect(within(panel).getByRole('button', { name: '나가기' })).toBeTruthy();
  });

  it('admin 은 남을 빼는 항목을 받는다', async () => {
    seed({ admin: true });
    const c = fakeController([
      { accountId: 'u1', handle: 'me' },
      { accountId: 'u2', handle: 'other' },
    ]);
    sidebar();

    const panel = await openMembers(/비공개 채널 secret\b/, 'c2');

    fireEvent.click(within(panel).getByLabelText('other 내보내기'));
    expect(c.leaveChannel).toHaveBeenCalledWith('c2', 'u2');
    // 자기 자신에게는 내보내기가 붙지 않는다 — 나가기와 두 갈래로 갈리면 뜻이 흐려진다.
    expect(within(panel).queryByLabelText('me 내보내기')).toBeNull();
  });

  it('public 채널과 private 채널에서 목록의 뜻이 다르게 표시된다', async () => {
    seed({ admin: false });
    fakeController([{ accountId: 'u1', handle: 'me' }]);
    sidebar();

    // public: 멤버십은 구독이다. 여기서 "멤버 1명"만 보여 주면 나머지 사람들이 이 채널을
    // 못 본다는 뜻으로 읽힌다 — 사실이 아니다.
    const openPanel = await openMembers(/# general\b/, 'c1');
    expect(within(openPanel).getByText(/구독한 사람이지, 볼 수 있는 사람의 전부가 아니다/)).toBeTruthy();
    expect(within(openPanel).queryByText(/이 목록이 이 채널을 볼 수 있는 사람의 전부다/)).toBeNull();

    fireEvent.click(within(openPanel).getByRole('button', { name: '닫기' }));

    // private: 이 목록이 곧 볼 수 있는 사람의 전부다.
    const privatePanel = await openMembers(/비공개 채널 secret\b/, 'c2');
    expect(within(privatePanel).getByText(/이 목록이 이 채널을 볼 수 있는 사람의 전부다/)).toBeTruthy();
    expect(within(privatePanel).queryByText(/구독한 사람이지, 볼 수 있는 사람의 전부가 아니다/)).toBeNull();
  });

  it('조회 실패는 멤버가 없다가 아니라 오류로 보인다', async () => {
    seed({ admin: false });
    const c = fakeController([]);
    c.loadChannelMembers.mockRejectedValueOnce(new Error('boom'));
    sidebar();

    openMenuFor(/비공개 채널 secret\b/);
    fireEvent.click(screen.getByRole('menuitem', { name: '멤버 보기' }));

    const panel = await screen.findByTestId('members-c2');
    expect(within(panel).getByRole('alert')).toBeTruthy();
    // 실패를 빈 목록으로 삼키면 private 채널에서 그것은 "아무도 이 채널을 볼 수 없다"는
    // 거짓 사실이 되고, 나가기 경고까지 조용히 사라진다.
    expect(within(panel).queryByText('멤버가 없다')).toBeNull();
    expect(within(panel).queryByLabelText('초대할 계정')).toBeNull();
  });
});

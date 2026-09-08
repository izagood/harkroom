import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan } from './helpers/fakeApi';
import { PROJECTION_UNCONFIGURED_NOTICE, type ChannelPrefRow, type ProjectionStatus } from '@murmur/shared';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'dev', 'main-repo')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'], lastMessageAt: null }],
    unread: [
      { id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c2' , authorId: 'u1', body: '', meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId: null},
      { id: 2, messageId: 'm2', reason: 'dm', readAt: null, channelId: 'd1' , authorId: 'u1', body: '', meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId: null},
    ],
    online: ['u2'],
    connected: true,
    activeChannelId: 'c1',
  });
  // **언어를 한국어로 고정한다.** 이 파일의 축들은 사이드바의 한국어 문구로 쓰여 있고,
  // 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(#619 가 대기 사슬에서
  // 세운 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면
  // 한국어라고 말해야 한다 — 그리고 그렇게 적어 두면 이 축들이 무엇을 재는지가 오히려
  // 또렷해진다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
  usePrefsStore.getState().setLocale('ko');
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('Sidebar', () => {
  // #97: 부트스트랩 직후 채널을 만들 수단이 UI 에 없었다. POST /channels 는 admin 전용이므로
  // 일반 사용자에게 보이면 누르는 족족 403 이 된다 — 없는 것을 있다고 표시하지 않는다.
  describe('채널 만들기 (admin 전용)', () => {
    const asAdmin = (): void => {
      useAppStore.getState().set({ me: { ...acc('u1', 'admin'), isAdmin: true } });
    };

    it('admin 이 아니면 생성 수단이 보이지 않는다', () => {
      fakeController();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
      expect(screen.queryByTestId('add-channel')).toBeNull();
    });

    it('admin 이면 이름을 넣어 채널을 만들 수 있다', async () => {
      const c = fakeController();
      c.createChannel.mockResolvedValue(chan('c9', 'design'));
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      fireEvent.click(screen.getByTestId('add-channel'));
      fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'design' } });
      fireEvent.click(screen.getByText('만들기'));

      // #182 이후 공개 범위가 인자로 함께 간다. 체크박스를 건드리지 않았으므로 'public' 이다 —
      // 기본값이 조용히 private 이 되면 만든 사람 말고는 아무도 못 보는 채널이 생긴다.
      await waitFor(() => expect(c.createChannel).toHaveBeenCalledWith('design', 'public'));
      // 성공하면 입력 자리는 닫힌다.
      await waitFor(() => expect(screen.queryByLabelText('New channel name')).toBeNull());
    });

    it('서버가 거절하면 사용자에게 보인다 — 조용히 사라지지 않는다', async () => {
      const c = fakeController();
      c.createChannel.mockRejectedValue(new Error('이미 있는 이름이다'));
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      fireEvent.click(screen.getByTestId('add-channel'));
      fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'general' } });
      fireEvent.click(screen.getByText('만들기'));

      expect((await screen.findByRole('alert')).textContent).toContain('이미 있는 이름이다');
      // 실패했으니 입력 자리는 열린 채로 남아 고쳐 쓸 수 있어야 한다.
      expect(screen.getByLabelText('New channel name')).toBeTruthy();
    });

    it('이름 규칙에 맞지 않으면 서버에 보내지 않고 안내한다', async () => {
      const c = fakeController();
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      fireEvent.click(screen.getByTestId('add-channel'));
      fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'Design Team' } });
      fireEvent.click(screen.getByText('만들기'));

      expect((await screen.findByRole('alert')).textContent).toContain('1~48자');
      expect(c.createChannel).not.toHaveBeenCalled();
    });
  });

  // #97: 채널 편집(topic·repo 바인딩) 기능이 데스크탑에 없다.
  // PATCH /channels/:id 로 topic 과 repo 바인딩을 수정할 수 있는데 UI 가 없다.
  describe('채널 편집 (admin 전용)', () => {
    const asAdmin = (): void => {
      useAppStore.getState().set({ me: { ...acc('u1', 'admin'), isAdmin: true } });
    };

    // #151/#152 로 비-admin 도 트리거를 갖는다(알림 수준·즐겨찾기는 계정별이다). 그래서
    // "트리거가 없다"로는 더 이상 검사할 수 없다 — 의도는 **편집 항목이 없다**는 것이다.
    it('admin 이 아니면 메뉴에 편집 항목이 없다', () => {
      fakeController();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      fireEvent.contextMenu(screen.getAllByRole('button', { name: /^# / })[0]!);

      expect(screen.queryByRole('menuitem', { name: '채널 편집' })).toBeNull();
      // 계정별 항목은 비-admin 에게도 도달 가능해야 한다.
      expect(screen.getByRole('menuitem', { name: '알림: 없음' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: '즐겨찾기' })).toBeTruthy();
    });

    // 채널 순서는 이제 클라이언트가 정한다(즐겨찾기 먼저, 그 안에서 이름순). 인덱스로
    // 행을 고르면 정렬이 바뀔 때 **조용히 다른 채널을 집는다** — 실제로 그렇게 깨졌다.
    const openMenuFor = (name: string): void => {
      // `#` 과 이름이 별도 노드라 텍스트 매칭이 안 된다. 접근성 이름으로 찾되, 별도
      // 노드가 **공백으로 결합**되므로(`"# dev main-repo 1"`) 그 공백을 포함해 맞춘다.
      // 행 자체가 트리거다 — 우클릭 이벤트가 채널 버튼에서 그 행까지 올라간다.
      fireEvent.contextMenu(screen.getByRole('button', { name: new RegExp(`# ${name}\\b`) }));
    };

    // `⋯` 버튼은 없앴다 — 그래서 "트리거가 몇 개인가"는 버튼을 세어 볼 수 없다.
    // 대신 **행마다 메뉴가 달려 있는가**를 본다: 채널 버튼을 감싼 트리거가
    // `aria-haspopup="menu"` 를 갖는지가 그 사실이다.
    it('admin 이면 채널 행마다 메뉴가 달려 있다', () => {
      fakeController();
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
      const rows = screen.getAllByRole('button', { name: /^# / });
      expect(rows.length).toBe(2);
      expect(rows.map((b) => b.parentElement?.getAttribute('aria-haspopup')))
        .toEqual(['menu', 'menu']);
    });

    it('편집 메뉴를 누르면 폼이 열리고 현재 값이 채워진다', () => {
      const c = fakeController();
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      openMenuFor('general');
      fireEvent.click(screen.getByRole('menuitem', { name: '채널 편집' }));

      expect(screen.getByText('#general 편집')).toBeTruthy();
      expect((screen.getByLabelText('Topic') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('Repository') as HTMLInputElement).value).toBe('');
    });

    it('topic 만 고치면 repo 키가 요청에 없다 — 바인딩이 조용히 끊기지 않는다', async () => {
      const c = fakeController();
      c.updateChannel.mockResolvedValue(chan('c1', 'c1', null));
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      openMenuFor('general');
      fireEvent.click(screen.getByRole('menuitem', { name: '채널 편집' }));

      fireEvent.change(screen.getByLabelText('Topic'), { target: { value: '일반 Talk' } });
      fireEvent.click(screen.getByText('저장'));

      await waitFor(() => expect(c.updateChannel).toHaveBeenCalledWith('c1', { topic: '일반 Talk' }));
    });

    it('repo 필드를 비우면 null 이 요청에 간다 (조용히 무시되지 않는다)', async () => {
      const c = fakeController();
      c.updateChannel.mockResolvedValue(chan('c1', 'c1', null));
      asAdmin();
      useAppStore.getState().set({ channels: [chan('c1', 'c1', 'old-repo')] });
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      openMenuFor('c1');
      fireEvent.click(screen.getByRole('menuitem', { name: '채널 편집' }));

      expect((screen.getByLabelText('Repository') as HTMLInputElement).value).toBe('old-repo');
      fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '' } });
      fireEvent.click(screen.getByText('저장'));

      // 필드를 비운 것은 해제 의사다. undefined 가 아니라 null 이어야 한다 —
      // undefined 는 JSON 에서 사라져 조작이 조용히 무시된다.
      await waitFor(() => expect(c.updateChannel).toHaveBeenCalledWith('c1', { repo: null }));
    });

    it('repo 를 새 값으로 바꾸면 그 값이 요청에 간다', async () => {
      const c = fakeController();
      c.updateChannel.mockResolvedValue(chan('c1', 'c1', 'new-repo'));
      asAdmin();
      useAppStore.getState().set({ channels: [chan('c1', 'c1', 'old-repo')] });
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      openMenuFor('c1');
      fireEvent.click(screen.getByRole('menuitem', { name: '채널 편집' }));

      fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'new-repo' } });
      fireEvent.click(screen.getByText('저장'));

      await waitFor(() => expect(c.updateChannel).toHaveBeenCalledWith('c1', { repo: 'new-repo' }));
    });

    it('실패하면 사용자에게 오류가 보인다', async () => {
      const c = fakeController();
      c.updateChannel.mockRejectedValue(new Error('권한이 없다'));
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      openMenuFor('general');
      fireEvent.click(screen.getByRole('menuitem', { name: '채널 편집' }));
      fireEvent.click(screen.getByText('저장'));

      expect((await screen.findByRole('alert')).textContent).toContain('권한이 없다');
    });

    it('성공하면 폼이 닫힌다', async () => {
      const c = fakeController();
      c.updateChannel.mockResolvedValue(chan('c1', 'c1', 'new-repo'));
      asAdmin();
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

      openMenuFor('general');
      fireEvent.click(screen.getByRole('menuitem', { name: '채널 편집' }));
      fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'new-repo' } });
      fireEvent.click(screen.getByText('저장'));

      await waitFor(() => expect(screen.queryByText('#general 편집')).toBeNull());
    });

    // #381: 투영이 꺼져 있을 때 repo 를 바인딩하면 그 사실을 말한다.
    const projection = (over: Partial<ProjectionStatus> = {}): ProjectionStatus => ({
      state: 'unconfigured',
      configured: false,
      repo: null,
      lastLogIndex: 0,
      lastPolledAt: null,
      lastAdvancedAt: null,
      lastError: null,
      ...over,
    });

    /**
     * 편집 폼 **안쪽**의 경고만 본다. `LeasePanel` 도 같은 문구를 그리므로 화면 전체에서
     * 찾으면 사이드바 폼에 아무것도 없어도 초록이 된다.
     */
    const editFormWarning = (): string | null => {
      const editFormRoot = screen.getByText('#general 편집').parentElement;
      expect(editFormRoot).not.toBeNull();
      return editFormRoot!.querySelector('.text-warning')?.textContent ?? null;
    };

    const openEditWithRepo = (projectionStatus: ProjectionStatus | null) => {
      asAdmin();
      useAppStore.getState().set({ projectionStatus });
      render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
      openMenuFor('general');
      fireEvent.click(screen.getByRole('menuitem', { name: '채널 편집' }));
      fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'new-repo' } });
    };

    it('투영이 설정되지 않았으면 repo 입력에 경고를 보인다', () => {
      fakeController();
      openEditWithRepo(projection());

      // 상수를 **가져와서** 전문을 대조한다. `/AVCS_BASE_URL/` 같은 부분 일치로 두면
      // 문구가 배너에서 갈라져도(예: "AVCS_BASE_URL" 한 낱말만 남아도) 초록이다.
      expect(editFormWarning()).toBe(PROJECTION_UNCONFIGURED_NOTICE);
    });

    it('투영이 켜져 있으면 repo 입력에 경고가 없다 — 늘 보이면 소음이다', () => {
      fakeController();
      openEditWithRepo(projection({
        state: 'ok', configured: true, repo: 'org/repo', lastPolledAt: Date.now(),
      }));

      expect(editFormWarning()).toBeNull();
    });
  });

  it('lists channels with unread badge and opens on click', () => {
    const c = fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.getByTestId('unread-c2').textContent).toBe('1');
    fireEvent.click(screen.getByText('dev'));
    expect(c.openChannel).toHaveBeenCalledWith('c2');
  });

  it('shows dm with peer handle, state on the avatar, unread badge', () => {
    // 상태를 담는 자리가 점에서 아바타로 옮겨갔다(`docs/desktop-rail.html` 2단계 ·
    // `Sidebar.tsx` 의 `dmRow`). 여기서 `u2` 는 **에이전트**라 `faceState` 가 판정하고,
    // 붙어 있고(`online`) 러너 기록이 없으므로 `ok` 다.
    fakeController();
    render(<Sidebar panel="dm" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
    // `Identity` 가 핸들을 `sr-only` 로도 내므로 **보이는 이름 하나 + 아바타의 sr-only
    // 하나 = 2** 다(`chatAvatars.test.tsx` 가 같은 셈을 적어 뒀다). 여기서 재려는 것은
    // "줄에 상대 이름이 글자로 있다"이므로 **보이는 쪽**을 고른다 — `truncate` 가 그 자리다.
    // `getByText` 로 뭉뚱그리면 아바타가 이름을 두 번 그려도 초록으로 남는다(`#365`).
    const label = screen.getByText('bot', { selector: '.truncate' });
    expect(label).toBeTruthy();
    expect(screen.getByTestId('dm-face-d1').dataset.face).toBe('ok');
    expect(screen.getByTestId('unread-d1').textContent).toBe('1');
  });

  it('starts a new dm from account picker', () => {
    const c = fakeController();
    render(<Sidebar panel="dm" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
    fireEvent.click(screen.getByTestId('add-dm'));
    fireEvent.click(screen.getByRole('button', { name: /bot/ }));
    expect(c.startDm).toHaveBeenCalledWith('u2');
  });

  /*
   * 계정 메뉴 테스트가 여기 있었다(#113). **`rail.test.tsx` 로 갔다** — 정본 문서
   * `docs/desktop-rail.html` 이 그 메뉴를 레일 맨 아래로 옮겼고, 계약을 재는 자리는
   * 그것이 사는 자리를 따라간다. 테스트가 사라진 것이 아니라 옮겨 간 것이다.
   */
});

describe('채널 음소거·즐겨찾기 (#151, #152)', () => {
  const pref = (channelId: string, o: { muted?: boolean; starred?: boolean }): ChannelPrefRow => ({
    accountId: 'u1', channelId,
    mutedAt: o.muted ? '2026-09-03T00:00:00.000Z' : null,
    starredAt: o.starred ? '2026-09-03T00:00:00.000Z' : null, hiddenAt: null,
    // #224 이후 음소거는 수준 `none` 이다.
    notifyLevel: o.muted ? 'none' : 'all',
    section: null,
    sortOrder: null,
  });

  // star 를 저장만 하고 정렬을 안 건드리면 기능이 아무것도 하지 않는다(#152 본문).
  it('즐겨찾기 채널이 목록 위로 올라가고 그 안에서 이름순이다', () => {
    fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'alpha'), chan('c2', 'beta'), chan('c3', 'zulu')],
      channelPrefs: { c3: pref('c3', { starred: true }) },
    });
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    // 행 텍스트에는 미읽음 배지 숫자가 섞여 들어온다 — 이름만 뽑지 말고 **상대 순서**를 본다.
    const order = screen.getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => t.startsWith('#'));
    const at = (n: string) => order.findIndex((t) => t.startsWith(`#${n}`));
    expect(at('zulu')).toBe(0);
    expect(at('alpha')).toBeLessThan(at('beta'));
  });

  // 알림 수준·즐겨찾기는 **계정별**이라 비-admin 에게도 도달 가능해야 한다.
  it('비-admin 도 알림 수준·즐겨찾기에 도달한다', () => {
    const c = fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    // 정렬이 있는 화면이라 인덱스로 고른 행이 c1 이라는 보장이 없다 — 채널 id 는
    // 열어 둔 행의 것으로 맞춘다.
    fireEvent.contextMenu(screen.getAllByRole('button', { name: /^# / })[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: '알림: 없음' }));

    expect(c.setChannelNotifyLevel).toHaveBeenCalledWith(expect.any(String), 'none');
  });

  // 토글이 아니라 세 수준이 나란히 있고 현재 값에 표시가 붙는다(#224). 켬/끔 스위치와
  // 수준을 같이 두면 "음소거 껐는데 왜 아직 조용하지"가 생긴다.
  it('현재 알림 수준에 표시가 붙는다', () => {
    fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'general')],
      channelPrefs: { c1: pref('c1', { muted: true }) },
    });
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole('button', { name: /^# general\b/ }));

    expect(screen.getByRole('menuitem', { name: '✓ 알림: 없음' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '알림: 전체' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '알림: 멘션만' })).toBeTruthy();
    // 음소거 토글은 더 이상 없다.
    expect(screen.queryByRole('menuitem', { name: '음소거' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '음소거 해제' })).toBeNull();
  });

  // #151 본문: "알림 층이 mute 를 어떻게 읽을지는 저장 모양을 정한 뒤의 후속" —
  // 그 작업은 저장과 표시까지였고, 배지 계산을 건드리는 것이 범위 이탈이라 이 자리에
  // "음소거가 배지를 바꾸지 않는다"는 방지선이 서 있었다.
  //
  // #229 가 그 후속이다: 저장해 놓고 아무 데서도 읽지 않는 상태는 미완성이 아니라 거짓
  // 이행이었으므로(사용자는 껐다고 믿는다) 방지선의 방향을 뒤집는다. 알림 쪽까지 묶은
  // 회귀선은 channelMute.test.tsx 에 있고, 여기서는 같은 미읽음이 음소거만으로 다른
  // 결과가 된다는 것을 남긴다.
  it('알림을 끄면(none) 미읽음 배지가 사라진다 (#229, #224)', () => {
    fakeController();
    const seed = {
      channels: [chan('c1', 'general')],
      unread: [
        { id: 1, channelId: 'c1', messageId: 'm1', readAt: null },
        { id: 2, channelId: 'c1', messageId: 'm2', readAt: null },
      ] as never,
    };

    useAppStore.getState().set({ ...seed, channelPrefs: {} });
    const { unmount } = render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);
    const before = screen.getByTestId('unread-c1').textContent;
    unmount();

    useAppStore.getState().set({ ...seed, channelPrefs: { c1: pref('c1', { muted: true }) } });
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    // 음소거 전에는 세던 것이(before) 음소거 뒤에는 배지 자체가 없다.
    expect(before).toBe('2');
    expect(screen.queryByTestId('unread-c1')).toBeNull();
  });
});

describe('채널 컨텍스트 메뉴 (#111)', () => {
  const getChannelButton = (name: string): HTMLElement => {
    return screen.getByRole('button', { name: new RegExp(`# ${name}\\b`) }) as HTMLElement;
  };

  it('채널 행을 우클릭하면 메뉴가 열린다', () => {
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    const button = getChannelButton('general');
    fireEvent.contextMenu(button);

    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '채널명 복사' })).toBeTruthy();
  });

  it('우클릭이 브라우저 기본 메뉴를 막는다 (preventDefault)', () => {
    // preventDefault 테스트는 testing-library 와 React event 시스템의 조합으로
    // 정확하게 검증하기 어렵다. 수동 테스트로 대체한다.
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    const button = getChannelButton('general');
    fireEvent.contextMenu(button);

    expect(screen.getByRole('menu')).toBeTruthy();
  });

  // 여는 이벤트가 자기를 닫아서는 안 된다. **실제 순서를 재현해야** 검증이 된다 —
  // 우클릭은 `mousedown`(button=2) 이 먼저 오고 `contextmenu` 가 뒤에 온다. 메뉴는
  // 후자에서 열리므로 그 mousedown 은 리스너가 붙기 전에 지나간다.
  //
  // 초판 테스트는 `contextMenu` 만 발사하고 "우클릭으로는 절대 닫히지 않는다"를
  // 단정했다 — 그건 요구사항이 아니라 결함이었다(메뉴가 열린 상태에서 다른 곳을
  // 우클릭해도 안 닫힌다).
  it('여는 우클릭이 자기 메뉴를 닫지 않는다', () => {
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    const button = getChannelButton('general');
    fireEvent.mouseDown(button, { button: 2 });
    fireEvent.contextMenu(button);

    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('메뉴가 열린 뒤 바깥을 누르면 닫힌다 — 버튼 종류와 무관하다', () => {
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    fireEvent.contextMenu(getChannelButton('general'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body, { button: 2 });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(getChannelButton('general'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body, { button: 0 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // Menu.tsx 는 접근성 속성과 ref 를 renderTrigger 로 넘기지만 **적용을 강제할 수
  // 없다** — 소비자가 전개를 빼먹어도 타입은 통과한다. 초판이 그렇게 aria 속성과
  // Escape 후 포커스 복귀를 잃었다.
  it('트리거에 접근성 속성이 붙어 있다', () => {
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    // 트리거는 채널 버튼을 감싼 행이다(`⋯` 버튼은 없앴다).
    const trigger = getChannelButton('general').parentElement!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.contextMenu(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  /*
   * `⋯` 버튼을 없앤 자리. 그 버튼은 우클릭과 **같은 `items`** 를 냈다 —
   * 같은 일을 하는 두 번째 진입점이라, 줄마다 자리를 먹으면서 채널 이름이 쓸 폭만
   * 좁혔다. 지운 뒤에도 메뉴 자체는 그대로여야 하므로 셋을 함께 지킨다:
   * 버튼이 없다 · 우클릭은 여전히 연다 · 왼쪽 클릭은 **채널을 열 뿐** 메뉴를 열지 않는다.
   */
  it('채널 행에 ⋯ 버튼이 없고, 메뉴는 우클릭으로만 열린다', () => {
    const c = fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '⋯' })).toBeNull();

    // 왼쪽 클릭은 채널을 여는 것으로 끝난다.
    fireEvent.click(getChannelButton('general'));
    expect(c.openChannel).toHaveBeenCalledWith('c1');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(getChannelButton('general'));
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toContain('채널명 복사');
    expect(items).toContain('알림: 없음');
  });

  /*
   * 메뉴가 열린 채로 다른 채널을 누르면 닫힌다. Menu 의 바깥 클릭 리스너는 **트리거
   * 안쪽** mousedown 을 무시하므로(클릭으로 여는 소비자의 중복 토글을 막는 장치다),
   * 행이 곧 트리거가 된 지금은 행을 눌러도 그 리스너가 닫아 주지 않는다 —
   * 트리거의 `onClick` 을 열려 있을 때만 되불러 닫는 이유가 이것이다. 없으면 메뉴가
   * 커서 자리에 뜬 채 남는다.
   */
  it('메뉴가 열린 채 행을 왼쪽 클릭하면 닫힌다', () => {
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    fireEvent.contextMenu(getChannelButton('general'));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(getChannelButton('general'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('채널명 복사가 클립보드에 이름을 쓴다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    fireEvent.contextMenu(getChannelButton('general'));
    fireEvent.click(screen.getByRole('menuitem', { name: '채널명 복사' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('general'));
    vi.unstubAllGlobals();
  });

  it('채널 ID 복사가 클립보드에 ID 를 쓴다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    fireEvent.contextMenu(getChannelButton('general'));
    fireEvent.click(screen.getByRole('menuitem', { name: '채널 ID 복사' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('c1'));
    vi.unstubAllGlobals();
  });

  it('안 되는 항목(Archive/Delete/Leave/Mark unread/Move to section)이 메뉴에 없다', () => {
    fakeController();
    render(<Sidebar panel="home" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />);

    fireEvent.contextMenu(getChannelButton('general'));
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);

    expect(items).not.toContain('Archive');
    expect(items).not.toContain('Delete');
    expect(items).not.toContain('Leave');
    expect(items).not.toContain('Mark unread');
    expect(items).not.toContain('Move to section');
  });
});

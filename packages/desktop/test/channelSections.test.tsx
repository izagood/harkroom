import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ChannelPrefRow, ChannelRow } from '@murmur/shared';
import { sortChannelsBySection } from '@murmur/shared';
import { createAppStore, useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi } from './helpers/fakeApi';

/**
 * 채널 섹션(#157).
 *
 * 정렬은 `shared` 의 순수 함수 하나(`sortChannelsBySection`)가 갖는다 — 사이드바 안에
 * 흩어 놓으면 채널 목록·섹션 헤더 묶기·"위로/아래로"가 계산하는 이웃이 서로 다른 답을 본다.
 */
const pref = (channelId: string, o: Partial<ChannelPrefRow> = {}): ChannelPrefRow => ({
  accountId: 'u1', channelId,
  mutedAt: null, starredAt: null, notifyLevel: 'all',
  section: null, sortOrder: null, ...o,
});

describe('섹션 정렬 함수 (#157 요구 4)', () => {
  const item = (name: string, p: Partial<ChannelPrefRow> = {}) =>
    ({ channel: chan(`id-${name}`, name), pref: pref(`id-${name}`, p) });
  const names = (rows: { channel: ChannelRow }[]) => rows.map((r) => r.channel.name);

  /**
   * fixture 를 **정답과 정반대 순서**로 둔다. 이미 정렬된 입력을 주면 `return 0` 인
   * 비교 함수도 통과한다.
   */
  it('1단 — 섹션 이름순, 섹션 없음(null)은 맨 아래', () => {
    const input = [
      item('none-b'),
      item('zed', { section: 'Zeta' }),
      item('none-a'),
      item('ay', { section: 'Alpha' }),
    ];
    expect(names(sortChannelsBySection(input))).toEqual(['ay', 'zed', 'none-a', 'none-b']);
  });

  it('2단 — 섹션 안에서 별표가 먼저다(별표는 별도 축이다, #152)', () => {
    const input = [
      item('plain', { section: 'Work' }),
      item('starred', { section: 'Work', starredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(names(sortChannelsBySection(input))).toEqual(['starred', 'plain']);
  });

  it('2단 — 별표는 섹션을 뛰어넘지 않는다', () => {
    const input = [
      item('a-plain', { section: 'Alpha' }),
      item('z-starred', { section: 'Zeta', starredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    // 별표가 섹션보다 세면 z-starred 가 먼저 온다 — 그러면 섹션 헤더가 뜻을 잃는다.
    expect(names(sortChannelsBySection(input))).toEqual(['a-plain', 'z-starred']);
  });

  it('3단 — sortOrder 가 작은 것이 앞이고, 값이 있는 것이 없는 것보다 앞이다', () => {
    const input = [
      item('no-order', { section: 'Work' }),
      item('third', { section: 'Work', sortOrder: 3 }),
      item('first', { section: 'Work', sortOrder: 1 }),
    ];
    expect(names(sortChannelsBySection(input))).toEqual(['first', 'third', 'no-order']);
  });

  it('3단 — sortOrder 는 이름을 이긴다', () => {
    const input = [
      item('aaa', { section: 'Work', sortOrder: 2 }),
      item('zzz', { section: 'Work', sortOrder: 1 }),
    ];
    expect(names(sortChannelsBySection(input))).toEqual(['zzz', 'aaa']);
  });

  it('4단 — 나머지는 이름순', () => {
    const input = [item('zulu', { section: 'Work' }), item('alpha', { section: 'Work' })];
    expect(names(sortChannelsBySection(input))).toEqual(['alpha', 'zulu']);
  });

  it('선호가 없는 채널(null pref)도 섹션 없음으로 다뤄진다', () => {
    const input = [
      { channel: chan('c2', 'no-pref'), pref: null },
      { channel: chan('c1', 'sectioned'), pref: pref('c1', { section: 'Work' }) },
    ];
    expect(names(sortChannelsBySection(input))).toEqual(['sectioned', 'no-pref']);
  });

  it('섹션 이름이 특수문자여도 "섹션 없음"과 섞이지 않는다', () => {
    // sentinel 문자열로 null 을 흉내 내면 그 문자를 쓴 섹션과 "섹션 없음"이 같아진다.
    const input = [item('plain'), item('weird', { section: '￿' })];
    expect(names(sortChannelsBySection(input))).toEqual(['weird', 'plain']);
  });

  it('입력 배열을 제자리에서 바꾸지 않는다', () => {
    const input = [item('zulu'), item('alpha')];
    const before = names(input);
    sortChannelsBySection(input);
    expect(names(input)).toEqual(before);
  });
});

const fakeController = (overrides: Record<string, unknown> = {}) => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
    setChannelSection: vi.fn(async () => undefined),
    renameSection: vi.fn(async () => undefined),
    reorderChannels: vi.fn(async () => undefined),
    ...overrides,
  };
  setController(c as unknown as Controller);
  return c;
};

const mount = () => render(
  <Sidebar
    onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}}
    onOpenInbox={() => {}} onOpenSaved={() => {}}
    onLogout={vi.fn()} onOpenSettings={vi.fn()}
    collapsed={false} onToggleCollapse={vi.fn()}
  />,
);

/**
 * 사이드바에 그려진 채널·섹션 헤더를 **DOM 순서 그대로** 뽑는다.
 *
 * 개수만 세면 정렬을 지워도 통과한다 — 이 목록의 **순서**가 곧 요구 6·8 이다.
 */
const visibleOrder = (): string[] => {
  const nav = document.querySelector('nav')!;
  return [...nav.querySelectorAll('[data-testid^="section-header-"], button')]
    .flatMap((el) => {
      const testid = el.getAttribute('data-testid');
      if (testid) return [testid.replace('section-header-', '')];
      if (el.tagName !== 'BUTTON') return [];
      const text = (el.textContent ?? '').trim();
      return text.startsWith('#') ? [text.replace(/⋯$/, '').trim()] : [];
    });
};

/** 채널 행의 `⋯` 메뉴를 연다. 이름으로 골라야 정렬이 바뀌어도 옳은 행을 집는다. */
const openMenuFor = (name: string) => {
  const button = screen.getAllByRole('button').find((b) => (b.textContent ?? '').startsWith(`#${name}`));
  if (!button) throw new Error(`행을 못 찾았다: ${name}`);
  const dots = button.parentElement!.querySelector('button[aria-haspopup="menu"]') as HTMLElement;
  fireEvent.click(dots);
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin') },
    connected: true,
  });
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('사이드바의 섹션 (#157)', () => {
  it('6. 섹션 헤더로 묶어 그린다 — DOM 순서로', () => {
    fakeController();
    useAppStore.getState().set({
      // fixture 는 정답과 반대로 둔다.
      channels: [chan('c3', 'loose'), chan('c2', 'zed'), chan('c1', 'ay')],
      channelPrefs: {
        c1: pref('c1', { section: 'Alpha' }),
        c2: pref('c2', { section: 'Zeta' }),
        c3: pref('c3'),
      },
    });
    mount();

    expect(visibleOrder()).toEqual(['Alpha', '#ay', 'Zeta', '#zed', '#loose']);
  });

  it('7. "섹션에서 빼기" 가 null 로 되돌리고, 그 채널은 맨 아래로 내려간다', async () => {
    const c = fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay'), chan('c2', 'zed')],
      channelPrefs: { c1: pref('c1', { section: 'Work' }), c2: pref('c2') },
    });
    mount();
    expect(visibleOrder()).toEqual(['Work', '#ay', '#zed']);

    openMenuFor('ay');
    fireEvent.click(screen.getByRole('menuitem', { name: '섹션에서 빼기' }));
    expect(c.setChannelSection).toHaveBeenCalledWith('c1', null);

    // 서버 응답이 스토어에 반영되면 헤더가 사라지고 이름순 맨 아래로 간다.
    useAppStore.getState().set({ channelPrefs: { c1: pref('c1'), c2: pref('c2') } });
    await waitFor(() => expect(visibleOrder()).toEqual(['#ay', '#zed']));
  });

  it('섹션이 없는 채널에는 "섹션에서 빼기" 항목이 없다', () => {
    fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay')], channelPrefs: { c1: pref('c1') },
    });
    mount();

    openMenuFor('ay');
    // 눌러도 아무 일이 없는 항목은 "할 수 있다"는 거짓 신호다.
    expect(screen.queryByRole('menuitem', { name: '섹션에서 빼기' })).toBeNull();
  });

  it('이미 쓴 섹션이 메뉴 항목으로 선다 — 이름을 다시 치게 하지 않는다', () => {
    const c = fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay'), chan('c2', 'zed')],
      channelPrefs: { c1: pref('c1'), c2: pref('c2', { section: 'Work' }) },
    });
    mount();

    openMenuFor('ay');
    fireEvent.click(screen.getByRole('menuitem', { name: '섹션: Work' }));
    expect(c.setChannelSection).toHaveBeenCalledWith('c1', 'Work');
  });

  it('"새 섹션…" 은 인라인 입력을 연다 — 창을 막는 prompt 가 아니다', () => {
    const c = fakeController();
    // prompt 를 쓰면 이 감시에 걸린다. Electron 에서 꺼져 있으면 죽은 항목이 된다.
    const promptSpy = vi.fn();
    vi.stubGlobal('prompt', promptSpy);
    useAppStore.getState().set({
      channels: [chan('c1', 'ay')], channelPrefs: { c1: pref('c1') },
    });
    mount();

    openMenuFor('ay');
    fireEvent.click(screen.getByRole('menuitem', { name: '새 섹션…' }));
    expect(promptSpy).not.toHaveBeenCalled();

    const input = screen.getByLabelText('새 섹션 이름');
    fireEvent.change(input, { target: { value: '  Work  ' } });
    fireEvent.click(screen.getByRole('button', { name: '옮기기' }));

    // 앞뒤 공백은 떼고 보낸다.
    expect(c.setChannelSection).toHaveBeenCalledWith('c1', 'Work');
    vi.unstubAllGlobals();
  });

  it('인라인 입력에서 취소하면 아무것도 저장하지 않는다', () => {
    const c = fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay')], channelPrefs: { c1: pref('c1') },
    });
    mount();

    openMenuFor('ay');
    fireEvent.click(screen.getByRole('menuitem', { name: '새 섹션…' }));
    fireEvent.change(screen.getByLabelText('새 섹션 이름'), { target: { value: 'Oops' } });
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(c.setChannelSection).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('새 섹션 이름')).toBeNull();
  });

  it('DM 에는 섹션 항목이 아예 없다 — 서버도 400 을 준다', () => {
    fakeController();
    useAppStore.getState().set({
      channels: [], dms: [{ id: 'd1', memberIds: ['u1', 'u2'] }],
      accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
      channelPrefs: {},
    });
    mount();

    expect(screen.queryByRole('menuitem', { name: '새 섹션…' })).toBeNull();
  });

  /**
   * 8. "위로/아래로" 가 실제로 순서를 바꾼다.
   *
   * 초판은 `sortOrder ± 1` 이었다 — 같은 섹션의 다른 채널이 전부 null 이라 비교가 이름순으로
   * 떨어져, 눌러도 화면이 그대로였다. 개수·호출만 세면 그 죽은 버튼도 통과한다.
   */
  it('8. "위로" 가 이웃과 자리를 바꾸고 순서가 화면에 반영된다', async () => {
    const c = fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay'), chan('c2', 'bee'), chan('c3', 'see')],
      channelPrefs: {
        c1: pref('c1', { section: 'Work' }),
        c2: pref('c2', { section: 'Work' }),
        c3: pref('c3', { section: 'Work' }),
      },
    });
    mount();
    expect(visibleOrder()).toEqual(['Work', '#ay', '#bee', '#see']);

    openMenuFor('see');
    fireEvent.click(screen.getByRole('menuitem', { name: '위로' }));

    // 그 섹션 전체에 명시 순서를 매긴다 — 절반만 매기면 다음 클릭이 또 아무 일도 안 한다.
    expect(c.reorderChannels).toHaveBeenCalledWith(['c1', 'c3', 'c2']);

    useAppStore.getState().set({
      channelPrefs: {
        c1: pref('c1', { section: 'Work', sortOrder: 0 }),
        c3: pref('c3', { section: 'Work', sortOrder: 1 }),
        c2: pref('c2', { section: 'Work', sortOrder: 2 }),
      },
    });
    await waitFor(() => expect(visibleOrder()).toEqual(['Work', '#ay', '#see', '#bee']));
  });

  it('8b. "아래로" 도 같은 경로로 자리를 바꾼다', () => {
    const c = fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay'), chan('c2', 'bee')],
      channelPrefs: {
        c1: pref('c1', { section: 'Work' }),
        c2: pref('c2', { section: 'Work' }),
      },
    });
    mount();

    openMenuFor('ay');
    fireEvent.click(screen.getByRole('menuitem', { name: '아래로' }));
    expect(c.reorderChannels).toHaveBeenCalledWith(['c2', 'c1']);
  });

  it('8c. 맨 위에는 "위로" 가, 맨 아래에는 "아래로" 가 없다', () => {
    fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay'), chan('c2', 'bee')],
      channelPrefs: {
        c1: pref('c1', { section: 'Work' }),
        c2: pref('c2', { section: 'Work' }),
      },
    });
    mount();

    openMenuFor('ay');
    expect(screen.queryByRole('menuitem', { name: '위로' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '아래로' })).toBeTruthy();
  });

  it('혼자 있는 섹션에는 순서 항목이 없다', () => {
    fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'ay')], channelPrefs: { c1: pref('c1', { section: 'Work' }) },
    });
    mount();

    openMenuFor('ay');
    expect(screen.queryByRole('menuitem', { name: '위로' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '아래로' })).toBeNull();
  });

  describe('섹션 이름 바꾸기 (#323)', () => {
    it('5. 섹션 헤더 우클릭으로 컨텍스트 메뉴가 열리고 "이름 바꾸기"가 있다', () => {
      const c = fakeController();
      useAppStore.getState().set({
        channels: [chan('c1', 'ay'), chan('c2', 'bee')],
        channelPrefs: {
          c1: pref('c1', { section: 'Work' }),
          c2: pref('c2', { section: 'Work' }),
        },
      });
      mount();

      const sectionHeader = screen.getByTestId('section-header-Work');
      fireEvent.contextMenu(sectionHeader);

      expect(screen.getByRole('menuitem', { name: '이름 바꾸기' })).toBeTruthy();
    });

    it('"이름 바꾸기" 를 선택하면 인라인 입력창이 나타난다', () => {
      fakeController();
      useAppStore.getState().set({
        channels: [chan('c1', 'ay'), chan('c2', 'bee')],
        channelPrefs: {
          c1: pref('c1', { section: 'Work' }),
          c2: pref('c2', { section: 'Work' }),
        },
      });
      mount();

      const sectionHeader = screen.getByTestId('section-header-Work');
      fireEvent.contextMenu(sectionHeader);
      fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));

      expect(screen.getByLabelText('섹션 새 이름')).toBeTruthy();
      expect(screen.getByDisplayValue('Work')).toBeTruthy();
    });

    it('인라인 입력에서 Enter 를 치면 renameSection 이 호출되고 입력창이 닫힌다', async () => {
      const c = fakeController();
      useAppStore.getState().set({
        channels: [chan('c1', 'ay'), chan('c2', 'bee')],
        channelPrefs: {
          c1: pref('c1', { section: 'Work' }),
          c2: pref('c2', { section: 'Work' }),
        },
      });
      mount();

      const sectionHeader = screen.getByTestId('section-header-Work');
      fireEvent.contextMenu(sectionHeader);
      fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));

      const input = screen.getByLabelText('섹션 새 이름');
      fireEvent.change(input, { target: { value: 'NewName' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(c.renameSection).toHaveBeenCalledWith('Work', 'NewName');
      expect(screen.queryByLabelText('섹션 새 이름')).toBeNull();
    });

    it('"바꾸기" 버튼을 눌러도 renameSection 이 호출된다', () => {
      const c = fakeController();
      useAppStore.getState().set({
        channels: [chan('c1', 'ay'), chan('c2', 'bee')],
        channelPrefs: {
          c1: pref('c1', { section: 'Work' }),
          c2: pref('c2', { section: 'Work' }),
        },
      });
      mount();

      const sectionHeader = screen.getByTestId('section-header-Work');
      fireEvent.contextMenu(sectionHeader);
      fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));

      const input = screen.getByLabelText('섹션 새 이름');
      fireEvent.change(input, { target: { value: 'NewName' } });
      fireEvent.click(screen.getByRole('button', { name: '바꾸기' }));

      expect(c.renameSection).toHaveBeenCalledWith('Work', 'NewName');
    });

    it('"취소" 버튼을 누르면 입력창이 닫히고 renameSection 은 호출되지 않는다', () => {
      const c = fakeController();
      useAppStore.getState().set({
        channels: [chan('c1', 'ay'), chan('c2', 'bee')],
        channelPrefs: {
          c1: pref('c1', { section: 'Work' }),
          c2: pref('c2', { section: 'Work' }),
        },
      });
      mount();

      const sectionHeader = screen.getByTestId('section-header-Work');
      fireEvent.contextMenu(sectionHeader);
      fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));

      const input = screen.getByLabelText('섹션 새 이름');
      fireEvent.change(input, { target: { value: 'NewName' } });
      fireEvent.click(screen.getByRole('button', { name: '취소' }));

      expect(c.renameSection).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('섹션 새 이름')).toBeNull();
    });

    it('빈 이름으로 바꾸면 섹션이 제거된다(null)', () => {
      const c = fakeController();
      useAppStore.getState().set({
        channels: [chan('c1', 'ay'), chan('c2', 'bee')],
        channelPrefs: {
          c1: pref('c1', { section: 'Work' }),
          c2: pref('c2', { section: 'Work' }),
        },
      });
      mount();

      const sectionHeader = screen.getByTestId('section-header-Work');
      fireEvent.contextMenu(sectionHeader);
      fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));

      const input = screen.getByLabelText('섹션 새 이름');
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: '바꾸기' }));

      expect(c.renameSection).toHaveBeenCalledWith('Work', null);
    });
  });
});

/**
 * 5. 배선 — `Workspace` 를 통째로 띄우고 **진짜 `Controller`** 로 돈다.
 *
 * 위의 화면 테스트들은 컨트롤러를 목으로 끼운다. 그러면 `Sidebar` → `Controller` →
 * `ApiClient` 중 어느 한 마디가 끊겨 있어도 전부 초록이다 — #166 회수에서 실제로
 * 회귀선 1043 건이 전부 초록인 채 배선이 죽어 있었다. 여기서는 목을 **api 한 겹**에만
 * 두고, 그 위의 배선은 프로덕션 코드를 그대로 지나가게 한다.
 */
describe('섹션 이름 바꾸기 배선 (#323 요구 5)', () => {
  const seedTwoChannelSection = () => {
    useAppStore.getState().set({
      channels: [chan('c1', 'ay'), chan('c2', 'bee')],
      dms: [],
      channelPrefs: {
        c1: pref('c1', { section: 'Work', sortOrder: 0 }),
        c2: pref('c2', { section: 'Work', sortOrder: 1 }),
      },
      activeChannelId: 'c1',
    });
  };

  it('헤더 메뉴 → 인라인 입력 → 서버 응답이 목록에 반영된다', async () => {
    // 서버는 새로고침된 선호 전체를 돌려준다(#323 의 응답 계약). 목은 그 계약만 흉내 낸다.
    const renameSection = vi.fn(async (_oldName: string, newName: string | null) => ({
      prefs: [
        pref('c1', { section: newName, sortOrder: 0 }),
        pref('c2', { section: newName, sortOrder: 1 }),
      ],
    }));
    const api = fakeApi({ renameSection } as never);
    setController(new Controller(api));
    seedTwoChannelSection();

    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(visibleOrder()).toEqual(['Work', '#ay', '#bee']);

    fireEvent.contextMenu(screen.getByTestId('section-header-Work'));
    fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));

    const input = screen.getByLabelText('섹션 새 이름');
    fireEvent.change(input, { target: { value: 'Focus' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 목은 api 한 겹뿐이다 — 여기까지 왔다는 것은 화면부터 클라이언트까지 이어져 있다는 뜻이다.
    expect(renameSection).toHaveBeenCalledWith('Work', 'Focus');

    // 개수가 아니라 **DOM 순서**로 본다. 헤더 글자만 바꾸고 채널을 두고 오면 여기서 갈린다.
    await waitFor(() => expect(visibleOrder()).toEqual(['Focus', '#ay', '#bee']));
    expect(screen.queryByTestId('section-header-Work')).toBeNull();
    // 입력은 닫힌다 — 열린 채로 남으면 다음 클릭이 헤더가 아니라 입력으로 간다.
    expect(screen.queryByLabelText('섹션 새 이름')).toBeNull();
  });

  /**
   * 커뮤니티 경계(#166). 두 커뮤니티가 열려 있을 때 컨트롤러가 **활성** 스토어를 직접
   * 읽으면, 보고 있지 않은 커뮤니티의 이름 바꾸기가 활성 커뮤니티의 목록을 덮어쓴다.
   * 커뮤니티가 하나뿐인 화면 테스트로는 그 차이가 보이지 않는다 — 두 스토어를 세워야
   * 비로소 갈린다. `#166` 병합에서 실제로 이 한 줄이 전역 싱글턴으로 되돌아가 있었다.
   */
  it('이름 바꾸기는 이 컨트롤러가 들고 있는 커뮤니티 스토어에만 쓴다', async () => {
    const other = createAppStore();
    const renameSection = vi.fn(async () => ({ prefs: [pref('c9', { section: 'Moved', sortOrder: 0 })] }));
    const api = fakeApi({ renameSection } as never);
    // 8번째 인자가 이 컨트롤러의 스토어다. 인자 자리가 밀리면 타입은 통과하고 값만 어긋난다.
    const c = new Controller(api, undefined, undefined, undefined, undefined, undefined, undefined, other);

    await c.renameSection('Work', 'Moved');

    expect(other.getState().channelPrefs.c9?.section).toBe('Moved');
    // 활성 스토어는 손대지 않는다.
    expect(useAppStore.getState().channelPrefs.c9).toBeUndefined();
  });

  it('빈 이름이면 섹션이 사라지고 채널은 남는다 — 진짜 배선으로', async () => {
    const renameSection = vi.fn(async () => ({
      prefs: [pref('c1', { section: null }), pref('c2', { section: null })],
    }));
    const api = fakeApi({ renameSection } as never);
    setController(new Controller(api));
    seedTwoChannelSection();

    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.contextMenu(screen.getByTestId('section-header-Work'));
    fireEvent.click(screen.getByRole('menuitem', { name: '이름 바꾸기' }));
    fireEvent.change(screen.getByLabelText('섹션 새 이름'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '바꾸기' }));

    // 공백뿐인 이름은 명시적 null 로 간다 — `undefined` 로 보내면 서버가 키를 못 본다.
    expect(renameSection).toHaveBeenCalledWith('Work', null);
    await waitFor(() => expect(visibleOrder()).toEqual(['#ay', '#bee']));
  });
});

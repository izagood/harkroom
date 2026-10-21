import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import type { ChannelPrefRow, ChannelSectionRow, InboxEntry } from '@harkroom/shared';
import { useActiveStore as useAppStore, useCommunityRegistry, resetCommunityRegistry } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan, fakeApi } from './helpers/fakeApi';

/**
 * 사이드바 섹션 표(136, S2). 옛 이름 묶음(#157)은 `channelSections.test.tsx` 가 잰다 —
 * 여기는 `channelSections` 가 있을 때의 모양: 손 순서·빈 섹션·접기(D4)·지우기 되돌리기·메뉴로 옮기기.
 */
const pref = (channelId: string, o: Partial<ChannelPrefRow> = {}): ChannelPrefRow => ({
  accountId: 'u1', channelId,
  mutedAt: null, starredAt: null, hiddenAt: null, notifyLevel: 'all',
  section: null, sectionId: null, sortOrder: null, ...o,
});
const section = (id: string, name: string, position: number, o: Partial<ChannelSectionRow> = {}): ChannelSectionRow =>
  ({ id, name, position, collapsed: false, createdAt: '2026-10-21T00:00:00.000Z', ...o });

const mount = () => render(
  <Sidebar panel="home"
    onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}}
    onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
    collapsed={false} onToggleCollapse={vi.fn()}
  />,
);

/** 섹션 머리와 채널 줄을 DOM 순서로. 순서가 곧 요구다(손으로 정한 섹션 순서 → CHANNELS). */
const order = (): string[] => {
  const nav = document.querySelector('aside nav')!;
  return [...nav.querySelectorAll('[data-testid^="section-toggle-"], button[data-channel-row]')]
    .map((el) => (el.getAttribute('data-testid')?.startsWith('section-toggle-')
      ? `[${(el.textContent ?? '').replace(/[▾▸]/g, '').trim()}]`
      : (el.textContent ?? '').trim().split(/\s/)[0]!.replace(/\d+$/, '')));
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin'), accounts: { u1: acc('u1', 'admin') }, connected: true });
  usePrefsStore.getState().setLocale('ko');
});
afterEach(() => {
  cleanup();
  setController(null as unknown as Controller);
  usePrefsStore.getState().setLocale('system');
});

describe('사이드바 섹션 표 (136)', () => {
  it('섹션은 position 순, 빈 섹션도 머리가 서고, 미분류는 CHANNELS 아래', () => {
    setController(new Controller(fakeApi()));
    useAppStore.getState().set({
      channels: [chan('c1', 'api-farm'), chan('c2', 'avcs'), chan('c3', 'testbed')],
      channelSections: [section('s2', '개인', 1), section('s1', '회사', 0), section('s3', '실험', 2)],
      channelPrefs: {
        c1: pref('c1', { sectionId: 's1', section: '회사' }),
        c2: pref('c2', { sectionId: 's2', section: '개인' }),
        c3: pref('c3'),
      },
    });
    mount();
    expect(order()).toEqual(['[회사]', '#api-farm', '[개인]', '#avcs', '[실험]', '#testbed']);
    expect(screen.getByTestId('section-empty-s3')).toBeTruthy();
    expect(screen.getByTestId('add-section')).toBeTruthy();
  });

  it('접힌 섹션(D4): 부른 말이 있는 채널만 남기고, 안 읽음만 있는 채널이 숨으면 머리에 점', () => {
    setController(new Controller(fakeApi()));
    const entry = { id: 'e1', channelId: 'c1', readAt: null } as unknown as InboxEntry;
    useAppStore.getState().set({
      channels: [chan('c1', 'rcms'), chan('c2', 'cmdb'), chan('c3', 'icp')],
      channelSections: [section('s1', '회사', 0, { collapsed: true })],
      channelPrefs: {
        c1: pref('c1', { sectionId: 's1' }), c2: pref('c2', { sectionId: 's1' }), c3: pref('c3', { sectionId: 's1' }),
      },
      unread: [entry],
      reads: { c2: { unread: 3 } } as never,
    });
    mount();
    expect(order()).toEqual(['[회사]', '#rcms']);
    expect(screen.getByTestId('section-dot-s1')).toBeTruthy();
    expect(screen.getByTestId('section-toggle-s1').getAttribute('aria-expanded')).toBe('false');
  });

  it('머리를 누르면 바로 접히고(낙관적) 서버에 collapsed 를 보낸다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    useAppStore.getState().set({
      channels: [chan('c1', 'rcms')],
      channelSections: [section('s1', '회사', 0)],
      channelPrefs: { c1: pref('c1', { sectionId: 's1' }) },
    });
    mount();
    fireEvent.click(screen.getByTestId('section-toggle-s1'));
    expect(useAppStore.getState().channelSections![0]!.collapsed).toBe(true);
    await waitFor(() => expect(api.updateChannelSection).toHaveBeenCalledWith('s1', { collapsed: true }));
  });

  it('지우면 되돌리기 줄이 서고, 누르면 같은 이름·자리·채널로 되살린다', async () => {
    const removed = { section: section('s1', '회사', 0), channelIds: ['c1'] };
    const api = fakeApi({ deleteChannelSection: vi.fn(async () => removed) });
    setController(new Controller(api));
    useAppStore.getState().set({
      channels: [chan('c1', 'rcms')],
      channelSections: [section('s1', '회사', 0)],
      channelPrefs: { c1: pref('c1', { sectionId: 's1' }) },
    });
    mount();
    fireEvent.click(screen.getByTestId('section-menu-s1'));
    fireEvent.click(await screen.findByText('섹션 삭제 — 채널 1개는 Channels로'));
    const undo = await screen.findByTestId('section-undo');
    expect(within(undo).getByText(/「회사」 섹션을 지웠습니다/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('section-undo-button'));
    await waitFor(() => expect(api.createChannelSection).toHaveBeenCalledWith({ name: '회사', position: 0, channelIds: ['c1'] }));
  });

  it('채널 메뉴로 다른 섹션에 옮기면 sectionId 로 보낸다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    useAppStore.getState().set({
      channels: [chan('c1', 'rcms')],
      channelSections: [section('s1', '회사', 0), section('s2', '개인', 1)],
      channelPrefs: { c1: pref('c1', { sectionId: 's1' }) },
    });
    mount();
    const row = screen.getAllByRole('button').find((b) => (b.textContent ?? '').startsWith('#rcms'))!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('섹션으로 옮기기…'));
    fireEvent.click(screen.getByTestId('section-pick-c1-s2'));
    await waitFor(() => expect(api.updateChannelPref).toHaveBeenCalledWith('c1', { sectionId: 's2' }));
  });

  it('「섹션 만들기」 → 이름 Enter 로 빈 섹션을 만든다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    useAppStore.getState().set({ channels: [chan('c1', 'rcms')], channelSections: [], channelPrefs: {} });
    mount();
    fireEvent.click(screen.getByTestId('add-section'));
    const input = screen.getByTestId('new-section-input');
    fireEvent.change(input, { target: { value: ' 실험 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.createChannelSection).toHaveBeenCalledWith({ name: '실험', channelIds: undefined, position: undefined }));
  });

  it('섹션 표를 모르는 서버(null)면 「섹션 만들기」가 없고 옛 이름 묶음 그대로다', () => {
    setController(new Controller(fakeApi()));
    useAppStore.getState().set({
      channels: [chan('c1', 'rcms')], channelSections: null,
      channelPrefs: { c1: pref('c1', { section: '회사' }) },
    });
    mount();
    expect(screen.queryByTestId('add-section')).toBeNull();
    expect(screen.getByTestId('section-header-회사')).toBeTruthy();
  });
});

describe('사이드바 섹션 표 — 검토 후속 (designer s1·s2·n1, security n1)', () => {
  afterEach(() => { resetCommunityRegistry(); });

  const seed = () => useAppStore.getState().set({
    channels: [chan('c1', 'rcms'), chan('c2', 'avcs')],
    channelSections: [section('s1', '회사', 0), section('s2', '개인', 1, { collapsed: true })],
    channelPrefs: { c1: pref('c1', { sectionId: 's1' }), c2: pref('c2', { sectionId: 's2' }) },
  });

  it('s1: 되돌리기 줄은 스크롤 목록(nav) 밖, 사이드바 아래 고정 칸에 선다', async () => {
    const removed = { section: section('s1', '회사', 0), channelIds: ['c1'] };
    setController(new Controller(fakeApi({ deleteChannelSection: vi.fn(async () => removed) })));
    seed();
    mount();
    fireEvent.click(screen.getByTestId('section-menu-s1'));
    fireEvent.click(await screen.findByText('섹션 삭제 — 채널 1개는 Channels로'));
    const undo = await screen.findByTestId('section-undo');
    expect(undo.closest('nav')).toBeNull();
    const footer = screen.getByTestId('section-footer');
    expect(footer.contains(undo)).toBe(true);
    expect(footer.className).toContain('sticky');
    expect(footer.className).toContain('bottom-0');
  });

  it('s2: 접힌 섹션으로 옮기면 그 섹션을 펼친다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed();
    mount();
    const row = screen.getAllByRole('button').find((b) => (b.textContent ?? '').startsWith('#rcms'))!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('섹션으로 옮기기…'));
    fireEvent.click(screen.getByTestId('section-pick-c1-s2'));
    await waitFor(() => expect(api.updateChannelSection).toHaveBeenCalledWith('s2', { collapsed: false }));
    expect(useAppStore.getState().channelSections!.find((s) => s.id === 's2')!.collapsed).toBe(false);
  });

  it('n1: 이름 바꾸기는 Enter 뒤 blur 가 와도 한 번만 보낸다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed();
    mount();
    fireEvent.doubleClick(screen.getByTestId('section-toggle-s1'));
    const input = screen.getByTestId('section-rename-s1');
    fireEvent.change(input, { target: { value: '본업' } });
    // Enter 와 그 뒤의 blur 가 입력칸이 사라지기 전 한 묶음 안에 온다(실물의 순서).
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
    });
    await waitFor(() => expect(api.updateChannelSection).toHaveBeenCalledWith('s1', { name: '본업' }));
    expect((api.updateChannelSection as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1]?.name !== undefined)).toHaveLength(1);
  });

  it('security n1: 지운 뒤 커뮤니티를 바꾸면 되돌리기가 사라지고, 새 커뮤니티 서버로 아무것도 안 간다', async () => {
    const removed = { section: section('s1', '회사', 0), channelIds: ['c1'] };
    setController(new Controller(fakeApi({ deleteChannelSection: vi.fn(async () => removed) })));
    seed();
    mount();
    fireEvent.click(screen.getByTestId('section-menu-s1'));
    fireEvent.click(await screen.findByText('섹션 삭제 — 채널 1개는 Channels로'));
    await screen.findByTestId('section-undo');

    const reg = useCommunityRegistry.getState();
    const b = reg.register({ baseUrl: 'https://b.example.com' });
    const bApi = fakeApi();
    reg.attachController(b.id, new Controller(bApi));
    act(() => { useCommunityRegistry.getState().setActive(b.id); });

    await waitFor(() => expect(screen.queryByTestId('section-undo')).toBeNull());
    expect(bApi.createChannelSection).not.toHaveBeenCalled();
  });
});

/**
 * S3 — 끌어 옮기기(섹션 순서·채널 넘나들기)와 designer n2(섹션 고르기 칸)·n3(CHANNELS 머리 ＋)·n6(갈매기).
 * jsdom 에는 레이아웃이 없어 줄 높이가 0 이다 — `clientY` 0 은 「앞」, 1 은 「뒤」로 읽힌다(isLowerHalf).
 */
describe('사이드바 섹션 표 — 끌어 옮기기 (S3)', () => {
  const seed3 = () => useAppStore.getState().set({
    channels: [chan('c1', 'rcms'), chan('c2', 'avcs'), chan('c3', 'cmdb'), chan('c4', 'study')],
    channelSections: [section('s1', '회사', 0), section('s2', '개인', 1, { collapsed: true })],
    channelPrefs: {
      c1: pref('c1', { sectionId: 's1', sortOrder: 0 }),
      c3: pref('c3', { sectionId: 's1', sortOrder: 1 }),
      c2: pref('c2', { sectionId: 's2' }),
      c4: pref('c4', { starredAt: '2026-10-21T00:00:00.000Z', sectionId: 's1' }),
    },
  });
  // jsdom 의 끌기 이벤트는 `clientY` 를 싣지 않는다 — 늘 「앞」에 놓인다.
  const drag = (from: HTMLElement, to: HTMLElement) => {
    fireEvent.dragStart(from);
    fireEvent.dragOver(to);
    fireEvent.drop(to);
  };

  it('섹션 머리를 다른 머리 앞에 놓으면 섹션 전부를 새 순서로 보낸다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed3();
    mount();
    drag(screen.getByTestId('section-head-s2'), screen.getByTestId('section-head-s1'));
    await waitFor(() => expect(api.reorderChannelSections).toHaveBeenCalledWith(['s2', 's1']));
  });

  it('제자리에 놓으면 아무것도 보내지 않는다', () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed3();
    mount();
    drag(screen.getByTestId('section-head-s1'), screen.getByTestId('section-head-s2'));
    expect(api.reorderChannelSections).not.toHaveBeenCalled();
  });

  it('끄는 동안 놓을 자리에 표시선이 서고, 끝나면 사라진다', () => {
    setController(new Controller(fakeApi()));
    seed3();
    mount();
    fireEvent.dragStart(screen.getByTestId('section-head-s2'));
    fireEvent.dragOver(screen.getByTestId('section-head-s1'));
    expect(within(screen.getByTestId('section-s1')).getByTestId('drop-line')).toBeTruthy();
    fireEvent.dragEnd(screen.getByTestId('section-head-s2'));
    expect(screen.queryByTestId('drop-line')).toBeNull();
  });

  it('d1·d2: 섹션 표시선은 섹션 블록에 하나만 겹쳐 그린다(줄을 밀지 않는다)', () => {
    // jsdom 은 끌기 clientY 를 싣지 않아 「앞」만 잰다 — 「뒤」(블록 끝)는 Chrome 하네스 캡처로 본다.
    setController(new Controller(fakeApi()));
    seed3();
    mount();
    fireEvent.dragStart(screen.getByTestId('section-head-s2'));
    fireEvent.dragOver(screen.getByTestId('section-head-s1'));
    const lines = within(screen.getByTestId('section-s1')).getAllByTestId('drop-line');
    const line = lines[0]!;
    expect(lines).toHaveLength(1);
    expect(line.getAttribute('data-after')).toBe('false');
    expect(line.className).toContain('absolute');
    expect(line.className).toContain('-top-px');
    expect(screen.getByTestId('section-s1').className).toContain('relative');
  });

  it('d3: 놓을 수 없는 곳으로 나가면 표시가 지워진다', () => {
    setController(new Controller(fakeApi()));
    seed3();
    mount();
    fireEvent.dragStart(screen.getByTestId('channel-drag-c1'));
    fireEvent.dragOver(screen.getByTestId('section-head-s2'));
    expect(screen.getByTestId('section-head-s2').className).toContain('ring-accent');
    fireEvent.dragOver(document.querySelector('nav')!);
    expect(screen.getByTestId('section-head-s2').className).not.toContain('ring-accent');
  });

  it('d3: 빈 섹션 안내 줄에 놓으면 그 섹션으로 들어간다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed3();
    useAppStore.getState().set({
      channelSections: [section('s1', '회사', 0), section('s2', '개인', 1, { collapsed: true }), section('s3', '빈', 2)],
    });
    mount();
    drag(screen.getByTestId('channel-drag-c1'), screen.getByTestId('section-empty-s3'));
    await waitFor(() => expect(api.updateChannelPref).toHaveBeenCalledWith('c1', { sectionId: 's3' }));
  });

  it('채널을 접힌 섹션 머리에 놓으면 그 섹션으로 옮기고 펼친다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed3();
    mount();
    drag(screen.getByTestId('channel-drag-c1'), screen.getByTestId('section-head-s2'));
    await waitFor(() => expect(api.updateChannelPref).toHaveBeenCalledWith('c1', { sectionId: 's2' }));
    await waitFor(() => expect(api.updateChannelSection).toHaveBeenCalledWith('s2', { collapsed: false }));
  });

  it('채널을 같은 섹션의 다른 채널 앞에 놓으면 섹션은 그대로 두고 손 순서만 다시 매긴다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed3();
    mount();
    drag(screen.getByTestId('channel-drag-c3'), screen.getByTestId('channel-drag-c1'));
    await waitFor(() => expect(api.updateChannelPref).toHaveBeenCalledWith('c1', { sortOrder: 1 }));
    expect(api.updateChannelPref).toHaveBeenCalledWith('c3', { sortOrder: 0 });
    expect(api.updateChannelPref).not.toHaveBeenCalledWith('c3', expect.objectContaining({ sectionId: expect.anything() }));
  });

  it('채널을 CHANNELS 머리에 놓으면 섹션에서 뺀다', async () => {
    const api = fakeApi();
    setController(new Controller(api));
    seed3();
    mount();
    drag(screen.getByTestId('channel-drag-c1'), screen.getByTestId('channels-heading'));
    await waitFor(() => expect(api.updateChannelPref).toHaveBeenCalledWith('c1', { sectionId: null }));
  });

  it('즐겨찾기 채널은 끌 수 없다(FAVORITES 에만 보인다)', () => {
    setController(new Controller(fakeApi()));
    seed3();
    mount();
    expect(screen.getByTestId('channel-drag-c4').getAttribute('draggable')).toBe('false');
    expect(screen.getByTestId('channel-drag-c1').getAttribute('draggable')).toBe('true');
  });

  it('순서 바꾸기가 409(sections_changed)면 다시 읽는다', async () => {
    const api = fakeApi({
      reorderChannelSections: vi.fn(async () => { throw Object.assign(new Error('changed'), { code: 'sections_changed' }); }),
    });
    setController(new Controller(api));
    seed3();
    mount();
    drag(screen.getByTestId('section-head-s2'), screen.getByTestId('section-head-s1'));
    await waitFor(() => expect(api.channelPrefsAndSections).toHaveBeenCalled());
  });

  it('n2: 채널 메뉴에는 「섹션으로 옮기기…」 하나만 서고, 고르기 칸은 지금 섹션에 ✓·누를 수 없음', async () => {
    setController(new Controller(fakeApi()));
    seed3();
    mount();
    const row = screen.getAllByRole('button').find((b) => (b.textContent ?? '').startsWith('#rcms'))!;
    fireEvent.contextMenu(row);
    await screen.findByText('섹션으로 옮기기…');
    expect(screen.queryByText('섹션: 개인')).toBeNull();
    fireEvent.click(screen.getByText('섹션으로 옮기기…'));
    const current = screen.getByTestId('section-pick-c1-s1') as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.textContent).toContain('✓');
    expect((screen.getByTestId('section-pick-c1-s2') as HTMLButtonElement).disabled).toBe(false);
    // n8: 포커스는 처음으로 누를 수 있는 항목에 — 지금 섹션(disabled)이 아니다.
    expect(document.activeElement).toBe(screen.getByTestId('section-pick-c1-s2'));
    // 고르기 칸은 채널 줄 **아래**에 선다.
    const pick = screen.getByTestId('section-pick-c1');
    expect(row.compareDocumentPosition(pick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(pick, { key: 'Escape' });
    expect(screen.queryByTestId('section-pick-c1')).toBeNull();
  });

  it('n3: 섹션 표가 있으면 「채널 만들기」는 CHANNELS 머리의 ＋ 다(첫 줄 + 는 없다)', () => {
    setController(new Controller(fakeApi()));
    seed3();
    useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    mount();
    const add = screen.getByTestId('add-channel');
    expect(screen.getByTestId('channels-heading').contains(add)).toBe(true);
    expect(add.getAttribute('aria-label')).toBe('Create channel');
  });

  it('n6: 섹션 머리 갈매기는 SVG 이고 펼친 섹션만 90° 돈다', () => {
    setController(new Controller(fakeApi()));
    seed3();
    mount();
    const open = screen.getByTestId('section-toggle-s1').querySelector('svg')!;
    const closed = screen.getByTestId('section-toggle-s2').querySelector('svg')!;
    expect(open.getAttribute('class')).toContain('rotate-90');
    expect(closed.getAttribute('class')).not.toContain('rotate-90');
    expect(screen.getByTestId('section-toggle-s1').textContent).not.toMatch(/[▾▸]/);
  });
});

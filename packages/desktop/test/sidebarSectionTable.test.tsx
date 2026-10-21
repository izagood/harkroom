import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { ChannelPrefRow, ChannelSectionRow, InboxEntry } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
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
    fireEvent.click(await screen.findByText('섹션: 개인'));
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan, fakeApi } from './helpers/fakeApi';

/**
 * 채널 우클릭 메뉴의 **묶음**(UX ⑦a, designer 사양). 재는 것은 항목의 존재가 아니라(그건 각
 * 기능 테스트가 잰다) **어느 묶음에 섰고 묶음 사이에 선이 있는가** 다 — 그래서 메뉴를 위에서
 * 아래로 읽어 구분선에서 끊은 묶음 목록으로 비교한다.
 */
const sidebar = () => render(
  <Sidebar panel="home" onOpenDirectory={vi.fn()}
    onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
    collapsed={false} onToggleCollapse={vi.fn()} />,
);

/** 열린 메뉴를 구분선에서 끊어 묶음별 항목 이름으로 읽는다. */
const menuGroups = (): string[][] => {
  const menu = screen.getByRole('menu');
  const groups: string[][] = [[]];
  for (const el of Array.from(menu.children)) {
    if (el.getAttribute('role') === 'separator') groups.push([]);
    else if (el.getAttribute('role') === 'menuitem') groups[groups.length - 1]!.push((el.textContent ?? '').trim());
  }
  return groups;
};

const seed = (isAdmin: boolean): void => {
  useAppStore.getState().reset();
  const me = { ...acc('u1', 'me'), isAdmin };
  useAppStore.getState().set({
    me, accounts: { u1: me },
    channels: [chan('c1', 'general')],
    channelMembers: { c1: [{ accountId: 'u1' } as never] },
    dms: [], connected: true, channelPrefs: {},
  });
};

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); setController(new Controller(fakeApi())); });
afterEach(() => { cleanup(); setController(null as unknown as Controller); usePrefsStore.getState().setLocale('system'); });

describe('채널 우클릭 메뉴 묶음 (UX ⑦a)', () => {
  it('admin — 다섯 묶음이고, 숨기기·나가기가 맨 아래 묶음이다', () => {
    seed(true);
    sidebar();
    fireEvent.contextMenu(screen.getByRole('button', { name: /general/ }));
    const groups = menuGroups();
    expect(groups).toHaveLength(5);
    // 알림 세 수준은 한 묶음에만 있다.
    expect(groups[1]!.length).toBe(3);
    // 되돌리기 어려운 항목은 복사·알림 사이에 섞이지 않는다 — 나가기는 마지막 묶음의 마지막이다.
    expect(groups[4]!.at(-1)).toMatch(/나가기/);
    expect(groups[4]!.some((l) => /숨기기/.test(l))).toBe(true);
    // 복사 둘은 사람·링크 묶음에 있다.
    expect(groups[2]!.filter((l) => /복사/.test(l))).toHaveLength(2);
  });

  it('admin 이 아니면 채널 바꾸기 묶음이 통째로 빠지고 선이 겹치지 않는다', () => {
    seed(false);
    sidebar();
    fireEvent.contextMenu(screen.getByRole('button', { name: /general/ }));
    const groups = menuGroups();
    expect(groups).toHaveLength(4);
    expect(groups.every((g) => g.length > 0)).toBe(true);
    // 맨 앞에는 선이 없다.
    expect(within(screen.getByRole('menu')).getAllByRole('separator')).toHaveLength(3);
    expect(screen.getByRole('menu').firstElementChild?.getAttribute('role')).not.toBe('separator');
  });
});

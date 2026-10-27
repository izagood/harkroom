/**
 * 멤버와 초대 › **역할·권한 칸**(designer 시안 B). 화면은 서버 규칙(`grantRoutes.ts`)을 비추기만 한다 —
 * 누가 무엇을 바꿀 수 있는지가 서버와 갈리면 누른 뒤 403 이 나고, 그건 「할 수 있다」는 거짓 신호다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AccountView } from '@harkroom/shared';
import { useActiveStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { InviteSettings } from '../src/components/settings/InviteSettings';
import { roleChoices, canEditCaps } from '../src/components/settings/MemberAccessPanel';
import { acc } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

const owner: AccountView = { ...acc('o1', 'boss', 'human', true), role: 'owner' };
const admin: AccountView = acc('a1', 'ops', 'human', true);
const member: AccountView = acc('m1', 'dev', 'human', false);
const guest: AccountView = { ...acc('g1', 'visitor', 'human', false), role: 'guest' };

function fakeController(grants: { capability: string; scope: string }[] = []) {
  const c = {
    createInvite: vi.fn(async () => 't'),
    refreshAccounts: vi.fn(async () => {}),
    loginIds: vi.fn(async () => ({})),
    listGrants: vi.fn(async () => grants),
    putGrant: vi.fn(async () => []),
    deleteGrant: vi.fn(async () => undefined),
    setRole: vi.fn(async (_id: string, role: string) => ({ role })),
  };
  setController(c as unknown as Controller);
  return c;
}

function seed(me: AccountView) {
  useActiveStore.getState().set({
    me, accounts: Object.fromEntries([owner, admin, member, guest].map((a) => [a.id, a])),
  });
}

beforeEach(() => { usePrefsStore.getState().setLocale('en'); useActiveStore.getState().reset(); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('역할 바꾸기 규칙 — 서버와 같다', () => {
  it('owner 는 owner 를 뺀 모두를, admin 은 admin 이 아닌 사람의 member↔guest 만, member 는 아무것도', () => {
    expect([...roleChoices(owner, member)].sort()).toEqual(['admin', 'guest', 'member']);
    expect([...roleChoices(owner, admin)].sort()).toEqual(['admin', 'guest', 'member']);
    expect(roleChoices(owner, owner).size).toBe(0);
    expect([...roleChoices(admin, member)].sort()).toEqual(['guest', 'member']);
    expect(roleChoices(admin, { ...admin, id: 'a2' }).size).toBe(0);
    expect(roleChoices(admin, owner).size).toBe(0);
    expect(roleChoices(member, guest).size).toBe(0);
  });
  it('권한 스위치는 admin 이 member 에게만', () => {
    expect(canEditCaps(owner, member)).toBe(true);
    expect(canEditCaps(admin, member)).toBe(true);
    expect(canEditCaps(admin, guest)).toBe(false);
    expect(canEditCaps(owner, admin)).toBe(false);
    expect(canEditCaps(member, member)).toBe(false);
  });
});

describe('멤버와 초대 › 역할·권한 칸', () => {
  it('줄마다 역할 칩이 서고, 줄을 누르면 그 사람의 칸이 열린다', async () => {
    fakeController();
    seed(owner);
    render(<InviteSettings />);
    const row = screen.getByTestId('directory-row-m1');
    expect(within(row).getByTestId('role-chip').getAttribute('data-role')).toBe('member');
    fireEvent.click(row);
    const side = await screen.findByTestId('member-access-side');
    expect(side.textContent).toContain('@dev');
    // 좁은 폭용 펼침도 같은 사람이다(container query 로 하나만 보인다).
    expect(screen.getByTestId('member-access-inline').textContent).toContain('@dev');
  });

  it('owner 가 member 에게 「에이전트 만들기」를 켜면 전역 grant 를 준다', async () => {
    const c = fakeController();
    seed(owner);
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('directory-row-m1'));
    const sw = await screen.findByTestId('member-access-side-cap-agent.create');
    expect((sw as HTMLInputElement).checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledWith('m1', { capability: 'agent.create', scope: '', expiresAt: null }));
    expect((sw as HTMLInputElement).checked).toBe(true);
  });

  it('켜 둔 권한을 끄면 grant 를 거두고, 실패하면 원래 값으로 돌리고 알린다', async () => {
    const c = fakeController([{ capability: 'agent.create', scope: '' }]);
    c.deleteGrant.mockRejectedValueOnce(new Error('boom'));
    seed(owner);
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('directory-row-m1'));
    const sw = await screen.findByTestId('member-access-side-cap-agent.create');
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(true));
    fireEvent.click(sw);
    await waitFor(() => expect(c.deleteGrant).toHaveBeenCalledWith('m1', 'agent.create', ''));
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(true));
    expect(within(screen.getByTestId('member-access-side')).getByRole('alert').textContent).toContain('Couldn’t change it');
  });

  it('admin 승격은 확인 창을 거친다 — 확인해야 PUT /role 이 나간다', async () => {
    const c = fakeController();
    seed(owner);
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('directory-row-m1'));
    fireEvent.click(await screen.findByTestId('member-access-side-role-admin'));
    expect(c.setRole).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(c.setRole).toHaveBeenCalledWith('m1', 'admin'));
  });

  it('member↔guest 는 바로 바뀐다', async () => {
    const c = fakeController();
    seed(admin);
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('directory-row-m1'));
    fireEvent.click(await screen.findByTestId('member-access-side-role-guest'));
    await waitFor(() => expect(c.setRole).toHaveBeenCalledWith('m1', 'guest'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('admin 에게 admin 으로 올리는 칸은 잠기고, 그 까닭을 말한다', async () => {
    fakeController();
    seed(admin);
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('directory-row-m1'));
    const radio = await screen.findByTestId('member-access-side-role-admin');
    expect((radio as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('member-access-side').textContent).toContain('Only the owner can promote to admin');
  });

  it('member 는 남의 칸을 읽기만 하고, 남의 grant 는 묻지도 않는다(서버 403)', async () => {
    const c = fakeController();
    const other: AccountView = acc('m2', 'qa');
    seed(member);
    useActiveStore.getState().set({ accounts: { ...useActiveStore.getState().accounts, m2: other } });
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('directory-row-m2'));
    const side = await screen.findByTestId('member-access-side');
    expect((within(side).getByTestId('member-access-side-role-guest') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('member-access-side-caps').textContent).toContain('Only admins can see other people’s permissions');
    expect(c.listGrants).not.toHaveBeenCalled();
    // 자기 것은 읽는다 — 스위치는 잠긴 채로.
    fireEvent.click(screen.getByTestId('directory-row-m1'));
    const sw = await screen.findByTestId('member-access-side-cap-agent.create');
    expect((sw as HTMLInputElement).disabled).toBe(true);
    expect(c.listGrants).toHaveBeenCalledWith('m1');
  });

  it('[← 초대] 로 돌아가면 초대 칸이 다시 선다', async () => {
    fakeController();
    seed(owner);
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('directory-row-m1'));
    const side = await screen.findByTestId('member-access-side');
    fireEvent.click(within(side).getByRole('button', { name: '← Invite' }));
    expect(screen.queryByTestId('member-access-side')).toBeNull();
  });
});

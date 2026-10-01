import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { InviteSettings } from '../src/components/settings/InviteSettings';
// 계정 fixture 는 공용 헬퍼를 쓴다 — 여기서 객체를 손으로 만들면 AccountView 에 필드가
// 늘 때(실제로 `disabled` 가 늘었다) 이 파일만 조용히 낡는다.
import { acc as baseAcc } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * **언어를 한국어로 고정한다.** 이 파일이 재는 것은 언어가 아니라 **그 언어로 표현된
 * 규율**이다 — 문구가 사전을 지나게 된 뒤(i18n 이전)에도 그 규율은 그대로여야 하므로,
 * 한국어 문구를 재는 줄을 지우는 대신 언어를 못 박는다. `gallery.test.tsx`·
 * `skillsSettings.test.tsx`·`agentGrid.test.tsx`·`accountAvatar.test.tsx` 가 세운 선례다.
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

const acc = (id: string, handle: string, isAdmin: boolean) => baseAcc(id, handle, 'human', isAdmin);

const fakeController = (token = 'invite_token_abc') => {
  const c = {
    createInvite: vi.fn(async () => token),
    refreshAccounts: vi.fn(async () => {}),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', true) });
});
afterEach(() => cleanup());

describe('InviteSettings', () => {
  it('초대 발급은 admin 에게만 열린다 — 일반 사용자에게는 초대 묶음만 닫히고 멤버 목록은 보인다', () => {
    fakeController();
    const me = acc('u1', 'user', false);
    useAppStore.getState().set({ me, accounts: { u1: me } });
    render(<InviteSettings />);
    // **`관리자` 가 `admin` 으로 바뀌었다** — 이 저장소는 그 값을 옮기지 않는다
    // (`agents` 영역 머리말의 고유어 규율). 재는 것은 낱말이 아니라 **admin 이 아닌
    // 사람에게 초대가 닫혀 있다고 말하는가** 이므로, 그 사실을 그대로 잰다.
    expect(screen.getByText(/초대 권한이 있는 사람만 발급할 수 있다/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /초대 토큰 발급/ })).toBeNull();
    // UX ⑥b-5: 전에는 페이지 전체가 닫혔다. 목록은 `GET /accounts`(모두에게 열림)의 것이라 닫을 이유가 없다.
    expect(screen.getByTestId('members-list').textContent).toContain('@user');
  });

  it('admin 이 아니어도 member.invite 능력이 있으면 발급 버튼이 선다 — 서버 판정과 같다', () => {
    fakeController();
    const me = { ...acc('u1', 'user', false), capabilities: ['member.invite' as const] };
    useAppStore.getState().set({ me, accounts: { u1: me } });
    render(<InviteSettings />);
    expect(screen.getByRole('button', { name: /초대 토큰 발급/ })).toBeTruthy();
  });

  it('멤버 목록은 사람만 이름순으로 싣는다 — 에이전트는 에이전트 › 목록의 것이다', async () => {
    const c = fakeController();
    const me = acc('u1', 'zed', true);
    useAppStore.getState().set({
      me,
      accounts: {
        u1: me,
        u2: acc('u2', 'amy', false),
        a1: { ...baseAcc('a1', 'bot'), kind: 'agent' as const },
      },
    });
    render(<InviteSettings />);
    const list = screen.getByTestId('members-list');
    const rows = [...list.querySelectorAll('[data-testid^="directory-row-"]')].map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual(['directory-row-u2', 'directory-row-u1']);
    expect(screen.getByText('멤버 (2)')).toBeTruthy();
    // 열 때 한 번 새로 받는다 — 스로틀에 걸리면 묻지도 않고 끝나므로 force 다(Directory 와 같다).
    await waitFor(() => expect(c.refreshAccounts).toHaveBeenCalledWith({ force: true }));
  });

  it('불러오는 동안 목록이 비었으면 묶음 제목에 숫자를 달지 않는다 — 0 은 "아무도 없다" 로 읽힌다', async () => {
    let resolve!: () => void;
    const c = { createInvite: vi.fn(async () => 't'), refreshAccounts: vi.fn(() => new Promise<void>((r) => { resolve = r; })) };
    setController(c as unknown as Controller);
    render(<InviteSettings />);
    expect(screen.getByText('멤버')).toBeTruthy();
    expect(screen.queryByText('멤버 (0)')).toBeNull();
    resolve();
    // 다 받은 뒤에도 비었으면 그때는 0 이 사실이다.
    expect(await screen.findByText('멤버 (0)')).toBeTruthy();
  });

  it('조회가 실패하고 목록이 비었으면 제목에 숫자를 달지 않는다', async () => {
    const c = { createInvite: vi.fn(async () => 't'), refreshAccounts: vi.fn(async () => { throw new Error('503'); }) };
    setController(c as unknown as Controller);
    render(<InviteSettings />);
    await screen.findByRole('alert');
    expect(screen.getByText('멤버')).toBeTruthy();
    expect(screen.queryByText('멤버 (0)')).toBeNull();
  });

  it('멤버 줄에는 종류 칩(HUMAN)을 달지 않는다 — 사람만 싣는 목록이다', () => {
    fakeController();
    const me = acc('u1', 'zed', true);
    useAppStore.getState().set({ me, accounts: { u1: me } });
    render(<InviteSettings />);
    expect(screen.getByTestId('directory-row-u1')).toBeTruthy();
    expect(screen.queryByTestId('directory-kind-u1')).toBeNull();
  });

  it('목록 조회가 실패하면 빈 목록 대신 실패를 말하고 다시 시도할 수 있다', async () => {
    let n = 0;
    const c = {
      createInvite: vi.fn(async () => 't'),
      refreshAccounts: vi.fn(async () => { if (++n === 1) throw new Error('503'); }),
    };
    setController(c as unknown as Controller);
    render(<InviteSettings />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('503');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(c.refreshAccounts).toHaveBeenCalledTimes(2);
  });

  it('admin이 초대 버튼을 누르면 createInvite가 호출되고 토큰이 화면에 보인다', async () => {
    const c = fakeController('muri_abc123');
    render(<InviteSettings />);

    fireEvent.click(screen.getByRole('button', { name: '초대 토큰 발급' }));

    // **토큰 렌더까지 `waitFor` 안에서 기다린다.** 호출만 기다린 뒤 화면을 동기로 단언하면
    // 느린 러너에서 튄다 — 호출은 이미 됐지만 프로미스 해소 뒤의 리렌더가 아직 안 왔다.
    await waitFor(() => {
      expect(c.createInvite).toHaveBeenCalled();
      expect(screen.getByText(/muri_abc123/)).toBeTruthy();
    });
  });

  it('실패하면 오류 메시지가 화면에 표시된다', async () => {
    const c = {
      createInvite: vi.fn(async () => { throw new Error('403 Forbidden'); }),
      refreshAccounts: vi.fn(async () => {}),
    };
    setController(c as unknown as Controller);

    render(<InviteSettings />);
    fireEvent.click(screen.getByRole('button', { name: '초대 토큰 발급' }));

    // 위와 같은 이유로 오류 문구도 `waitFor` 안에서 기다린다.
    await waitFor(() => {
      expect(c.createInvite).toHaveBeenCalled();
      expect(screen.getByText(/403 Forbidden/)).toBeTruthy();
    });
  });

  // 초대는 여러 사람에게 하는 일이고, 토큰은 한 번 쓰면 소진된다 — 한 번 발급했다고
  // 버튼을 잠그면 두 번째 사람을 부를 수 없다.
  it('토큰을 발급한 뒤에도 새 토큰을 다시 발급할 수 있다', async () => {
    let n = 0;
    const c = { createInvite: vi.fn(async () => `muri_${++n}`), refreshAccounts: vi.fn(async () => {}) };
    setController(c as unknown as Controller);

    render(<InviteSettings />);
    fireEvent.click(screen.getByRole('button', { name: /초대 토큰 발급/ }));
    await waitFor(() => expect(screen.getByText('muri_1')).toBeTruthy());

    const again = screen.getByRole('button', { name: /새 토큰 발급/ });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(again);

    await waitFor(() => {
      expect(screen.getByText('muri_2')).toBeTruthy();
      // 옛 토큰이 사라진 것도 같은 리렌더의 결과다 — 따로 동기 단언하면 같은 경합이 난다.
      expect(screen.queryByText('muri_1')).toBeNull();
    });
    expect(c.createInvite).toHaveBeenCalledTimes(2);
  });

});

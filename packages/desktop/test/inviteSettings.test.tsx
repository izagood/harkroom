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

const acc = (id: string, handle: string, isAdmin: boolean) => ({ ...baseAcc(id, handle), isAdmin });

const fakeController = (token = 'invite_token_abc') => {
  const c = {
    createInvite: vi.fn(async () => token),
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
  it('초대 섹션은 admin에게만 보인다 — 일반 사용자에게는 접근 제한 메시지가 보인다', () => {
    useAppStore.getState().set({ me: acc('u1', 'user', false) });
    render(<InviteSettings />);
    // **`관리자` 가 `admin` 으로 바뀌었다** — 이 저장소는 그 값을 옮기지 않는다
    // (`agents` 영역 머리말의 고유어 규율). 재는 것은 낱말이 아니라 **admin 이 아닌
    // 사람에게 이 화면이 닫혀 있다고 말하는가** 이므로, 그 사실을 그대로 잰다.
    expect(screen.getByText(/admin 만 볼 수 있다/)).toBeTruthy();
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
    const c = { createInvite: vi.fn(async () => `muri_${++n}`) };
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

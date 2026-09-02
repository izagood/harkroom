import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AccountView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { InviteSettings } from '../src/components/settings/InviteSettings';

const acc = (id: string, handle: string, isAdmin: boolean): AccountView =>
  ({ id, handle, displayName: handle, kind: 'human', isAdmin });

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
    expect(screen.getByText(/관리자만 볼 수 있습니다/)).toBeTruthy();
  });

  it('admin이 초대 버튼을 누르면 createInvite가 호출되고 토큰이 화면에 보인다', async () => {
    const c = fakeController('muri_abc123');
    render(<InviteSettings />);

    fireEvent.click(screen.getByRole('button', { name: '초대 토큰 발급' }));

    await waitFor(() => expect(c.createInvite).toHaveBeenCalled());
    expect(screen.getByText(/muri_abc123/)).toBeTruthy();
  });

  it('실패하면 오류 메시지가 화면에 표시된다', async () => {
    const c = {
      createInvite: vi.fn(async () => { throw new Error('403 Forbidden'); }),
    };
    setController(c as unknown as Controller);

    render(<InviteSettings />);
    fireEvent.click(screen.getByRole('button', { name: '초대 토큰 발급' }));

    await waitFor(() => expect(c.createInvite).toHaveBeenCalled());
    expect(screen.getByText(/403 Forbidden/)).toBeTruthy();
  });
});
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { InviteView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { InviteSettings } from '../src/components/settings/InviteSettings';
import { ApiError } from '../src/lib/api';
import { acc as baseAcc } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

// 초대 메일 칸(서버 0.4.280~). 언어는 한국어로 못 박는다(inviteSettings.test.tsx 와 같은 이유).
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

const admin = baseAcc('u1', 'admin', 'human', true);
const NEW = { version: '0.4.280', commit: null, startedAt: '' };

const row = (over: Partial<InviteView>): InviteView => ({
  id: 'i1', status: 'pending', createdAt: new Date().toISOString(), createdBy: { id: 'u1', handle: 'admin' },
  expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), revokedAt: null, usedBy: null,
  email: null, mailStatus: null, lastSentAt: null, ...over,
});

const fake = (opts: { mail?: 'on' | 'off'; invites?: InviteView[] } = {}) => {
  let list = opts.invites ?? [];
  const c = {
    refreshAccounts: vi.fn(async () => {}),
    createInvite: vi.fn(async () => 'hrki_tok'),
    loginIds: vi.fn(async () => ({})),
    inviteMailStatus: vi.fn(async () => opts.mail ?? 'on'),
    invites: vi.fn(async () => list),
    sendInvite: vi.fn(async (email: string, _locale?: string) => {
      if (email.startsWith('bad')) return { id: 'x', expiresAt: '', mail: 'failed' as const, token: 'hrki_x' };
      list = [row({ id: `n-${email}`, email, mailStatus: 'sent', lastSentAt: new Date().toISOString() }), ...list];
      return { id: `n-${email}`, expiresAt: '', mail: 'sent' as const };
    }),
    resendInvite: vi.fn(async (_id: string, _locale?: string) => ({ id: 'r', expiresAt: '', mail: 'sent' as const })),
    revokeInvite: vi.fn(async () => {}),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: admin, accounts: { u1: admin }, serverVersion: NEW });
});

describe('초대 메일 칸', () => {
  it('옛 서버(0.4.280 미만)에서는 지금 흐름만 — 목록·메일을 부르지 않는다', async () => {
    const c = fake();
    useAppStore.getState().set({ serverVersion: { version: '0.4.279', commit: null, startedAt: '' } });
    render(<InviteSettings />);
    expect(screen.getByRole('button', { name: '초대 토큰 발급' })).toBeTruthy();
    expect(screen.queryByTestId('invite-email-input')).toBeNull();
    expect(c.invites).not.toHaveBeenCalled();
    expect(c.inviteMailStatus).not.toHaveBeenCalled();
  });

  it('메일이 꺼진 서버: 그 사실을 말하고 토큰 발급을 주 동작으로 보인다(c1)', async () => {
    fake({ mail: 'off' });
    render(<InviteSettings />);
    expect(await screen.findByTestId('invite-mail-off')).toBeTruthy();
    expect(screen.getByRole('button', { name: '초대 토큰 발급' })).toBeTruthy();
    expect(screen.queryByTestId('invite-email-input')).toBeNull();
  });

  it('쉼표로 칩을 만들고, 틀린 주소는 빨간 칩으로 남긴 채 맞는 주소에만 보낸다', async () => {
    const c = fake();
    render(<InviteSettings />);
    const input = await screen.findByTestId('invite-email-input');
    fireEvent.change(input, { target: { value: 'a@example.com, B@Example.com,nope ' } });
    expect(screen.getByTestId('invite-chip-a@example.com')).toBeTruthy();
    expect(screen.getByTestId('invite-chip-b@example.com')).toBeTruthy();
    expect(screen.getByTestId('invite-chip-nope').textContent).toContain('주소 형식이 아니다');
    expect(screen.getByTestId('invite-mail-send').textContent).toBe('2명에게 초대 메일 보내기');
    await act(async () => { fireEvent.click(screen.getByTestId('invite-mail-send')); });
    expect(c.sendInvite.mock.calls.map((a) => a[0])).toEqual(['a@example.com', 'b@example.com']);
    expect(c.sendInvite.mock.calls[0]![1]).toBe('ko');
    expect((await screen.findByTestId('invite-mail-sent')).textContent).toContain('2명에게');
    // 성공한 칩은 빠지고 틀린 주소만 남는다. 포커스는 입력칸에(c6).
    expect(screen.queryByTestId('invite-chip-a@example.com')).toBeNull();
    expect(screen.getByTestId('invite-chip-nope')).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('일부 실패: 실패한 주소만 칩으로 되돌리고, 성공한 사람에게 다시 보내지 않는다(c2)', async () => {
    const c = fake();
    render(<InviteSettings />);
    const input = await screen.findByTestId('invite-email-input');
    fireEvent.change(input, { target: { value: 'ok@example.com,bad@example.com,' } });
    await act(async () => { fireEvent.click(screen.getByTestId('invite-mail-send')); });
    expect((await screen.findByTestId('invite-mail-failed')).textContent).toContain('bad@example.com');
    expect(screen.queryByTestId('invite-chip-ok@example.com')).toBeNull();
    expect(screen.getByTestId('invite-chip-bad@example.com')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('invite-mail-send')); });
    expect(c.sendInvite.mock.calls.map((a) => a[0])).toEqual(['ok@example.com', 'bad@example.com', 'bad@example.com']);
  });

  it('메일이 실패한 초대는 곧바로 거두고, 서버가 준 토큰은 화면에 남기지 않는다(jaebin 카드 8e864edd)', async () => {
    const c = fake();
    render(<InviteSettings />);
    fireEvent.change(await screen.findByTestId('invite-email-input'), { target: { value: 'bad@example.com,' } });
    await act(async () => { fireEvent.click(screen.getByTestId('invite-mail-send')); });
    expect(c.revokeInvite).toHaveBeenCalledWith('x');
    expect((await screen.findByTestId('invite-mail-failed')).textContent).toContain('거뒀다');
    expect(document.body.textContent).not.toContain('hrki_x');
    expect(screen.queryByTestId('invite-mail-withdraw-failed')).toBeNull();
  });

  it('거두기까지 실패하면 그 사실과 할 일([취소])을 말한다 — 토큰은 여전히 안 보인다', async () => {
    const c = fake();
    c.revokeInvite.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    render(<InviteSettings />);
    fireEvent.change(await screen.findByTestId('invite-email-input'), { target: { value: 'bad@example.com,' } });
    await act(async () => { fireEvent.click(screen.getByTestId('invite-mail-send')); });
    expect((await screen.findByTestId('invite-mail-withdraw-failed')).textContent).toContain('[취소]');
    expect(document.body.textContent).not.toContain('hrki_x');
    expect(screen.getByTestId('invite-chip-bad@example.com')).toBeTruthy();
  });

  it('줄의 [다시 보내기]가 메일에 실패하면 새 초대를 거두고 주소를 칩으로 돌린다', async () => {
    const c = fake({ invites: [row({ id: 'old', email: 'retry@example.com', mailStatus: 'failed', lastSentAt: '2026-10-01T00:00:00Z' })] });
    c.resendInvite.mockResolvedValueOnce({ id: 'new1', expiresAt: '', mail: 'failed' as const, token: 'hrki_secret' } as never);
    render(<InviteSettings />);
    const b = await screen.findByTestId('invite-resend-old');
    await act(async () => { fireEvent.click(b); });
    expect(c.revokeInvite).toHaveBeenCalledWith('new1');
    expect(screen.getByTestId('invite-chip-retry@example.com')).toBeTruthy();
    expect(document.body.textContent).not.toContain('hrki_secret');
  });

  it('이미 초대 중인 주소는 「초대 중」 칩이고, 보내기가 다시 보내기가 된다', async () => {
    const c = fake({ invites: [row({ id: 'p1', email: 'again@example.com', mailStatus: 'sent', lastSentAt: '2026-10-01T00:00:00Z' })] });
    render(<InviteSettings />);
    await screen.findByTestId('invite-row-p1');
    fireEvent.change(screen.getByTestId('invite-email-input'), { target: { value: 'again@example.com,' } });
    expect(screen.getByTestId('invite-chip-again@example.com').textContent).toContain('초대 중');
    await act(async () => { fireEvent.click(screen.getByTestId('invite-mail-send')); });
    expect(c.resendInvite).toHaveBeenCalledWith('p1', 'ko');
    expect(c.sendInvite).not.toHaveBeenCalled();
  });

  it('서버가 mail_disabled 로 거절하면 지금 흐름으로 물러난다', async () => {
    const c = fake();
    c.sendInvite.mockRejectedValueOnce(new ApiError(409, 'mail_disabled', 'off'));
    render(<InviteSettings />);
    fireEvent.change(await screen.findByTestId('invite-email-input'), { target: { value: 'x@example.com,' } });
    await act(async () => { fireEvent.click(screen.getByTestId('invite-mail-send')); });
    expect(await screen.findByTestId('invite-mail-off')).toBeTruthy();
  });

  it('보낸 초대: 손볼 것(보내지 못함·만료)이 위, 가입함이 아래, 취소된 것은 없다', async () => {
    fake({ invites: [
      row({ id: 'used', status: 'used', email: 'u@example.com', usedBy: { id: 'u9', handle: 'newbie' } }),
      row({ id: 'sent', email: 's@example.com', mailStatus: 'sent', lastSentAt: '2026-10-01T00:00:00Z' }),
      row({ id: 'gone', status: 'revoked', email: 'r@example.com' }),
      row({ id: 'exp', status: 'expired', email: 'e@example.com' }),
      row({ id: 'fail', email: 'f@example.com', mailStatus: 'failed' }),
      row({ id: 'tok' }),
    ] });
    render(<InviteSettings />);
    await screen.findByTestId('invite-row-used');
    const ids = Array.from(document.querySelectorAll('[data-testid^="invite-row-"]')).map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['invite-row-fail', 'invite-row-exp', 'invite-row-sent', 'invite-row-tok', 'invite-row-used']);
    expect(screen.getByTestId('invite-status-fail').textContent).toBe('보내지 못함');
    // 실패 줄 아랫줄은 실패 시각만 — 「보냄」·「남음」을 쓰지 않는다(designer s1).
    expect(screen.getByTestId('invite-row-fail').textContent).toContain('보내지 못함');
    expect(screen.getByTestId('invite-row-fail').textContent).not.toMatch(/보냄|남음/);
    expect(screen.getByTestId('invite-status-used').textContent).toBe('가입함');
    expect(screen.getByTestId('invite-row-used').textContent).toContain('@newbie');
    expect(screen.getByTestId('invite-resend-exp').textContent).toBe('새로 보내기');
    // 토큰으로 낸 초대는 다시 보낼 수 없고 취소만 된다.
    expect(screen.queryByTestId('invite-resend-tok')).toBeNull();
    expect(screen.getByTestId('invite-revoke-tok')).toBeTruthy();
    fireEvent.click(screen.getByTestId('invite-filter-todo'));
    const todo = Array.from(document.querySelectorAll('[data-testid^="invite-row-"]')).map((e) => e.getAttribute('data-testid'));
    expect(todo).toEqual(['invite-row-fail', 'invite-row-exp']);
  });

  it('방금 보낸 초대는 1분 동안 다시 보내기가 잠긴다', async () => {
    fake({ invites: [row({ id: 'fresh', email: 'n@example.com', mailStatus: 'sent', lastSentAt: new Date().toISOString() })] });
    render(<InviteSettings />);
    const b = await screen.findByTestId('invite-resend-fresh') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toContain('1분');
  });

  it('취소를 누르면 서버에 거두고 목록을 다시 읽는다', async () => {
    const c = fake({ invites: [row({ id: 'tok' })] });
    render(<InviteSettings />);
    const b = await screen.findByTestId('invite-revoke-tok');
    await act(async () => { fireEvent.click(b); });
    expect(c.revokeInvite).toHaveBeenCalledWith('tok');
    await waitFor(() => expect(c.invites.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('초대 권한이 없으면 목록을 그리지도 부르지도 않는다(c5)', () => {
    const c = fake();
    const me = baseAcc('u2', 'plain', 'human', false);
    useAppStore.getState().set({ me, accounts: { u2: me } });
    render(<InviteSettings />);
    expect(screen.queryByTestId('invite-list')).toBeNull();
    expect(c.invites).not.toHaveBeenCalled();
  });
});

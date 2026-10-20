/**
 * 비밀번호 재설정 코드 — 화면(스레드 a6017542, 서버 #1409). 재는 것: 누가 누구에게 [재설정 코드] 를 보나(서버 선과 같다),
 * 옛 서버에는 버튼이 없다, 발급 창은 비밀번호 재확인 → 코드를 한 번 보이고 닫으면 사라진다, 복사는 가림 클립보드 먼저,
 * 로그인 화면은 안내(서버 호출 없음) → 코드 폼, 실패 문구는 하나, 옛 서버면 「지원하지 않는다」, 알림 띠는 발급자를 이름으로.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  canIssueResetCode, groupCode, PasswordResetNoticeBanner, ResetCodeDialog, ResetWithCodeForm, ForgotPasswordGuide,
} from '../src/components/PasswordReset';
import { InviteSettings } from '../src/components/settings/InviteSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setConcealedClipboardInvoke } from '../src/lib/concealedClipboard';
import { acc } from './helpers/fakeApi';

const owner = acc('o1', 'boss', 'human', true, { role: 'owner' });
const admin = acc('a1', 'adm', 'human', true);
const member = acc('m1', 'minji');
const member2 = acc('m2', 'hoon');

function setup(over: Partial<Record<string, unknown>> = {}) {
  const c = {
    refreshAccounts: vi.fn(async () => undefined),
    unlockSecrets: vi.fn(async () => ({ steppedUpUntil: new Date(Date.now() + 900_000).toISOString() })),
    issuePasswordResetCode: vi.fn(async () => ({ code: 'K7QF-9MXD-2PQR', expiresAt: new Date(Date.now() + 1_800_000).toISOString() })),
    revokePasswordResetCode: vi.fn(async () => undefined),
    passwordResetNotices: vi.fn(async () => ({ notices: [] })),
    ackPasswordResetNotices: vi.fn(async () => undefined),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
}
const setServer = (version: string) => useActiveStore.getState().set({ serverVersion: { version } as never });

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); setConcealedClipboardInvoke(null); vi.unstubAllGlobals(); cleanup(); });

describe('누가 누구에게', () => {
  it('서버 선과 같다 — 자기·owner 는 아니고, admin 대상은 owner 만, member 는 못 한다', () => {
    expect(canIssueResetCode(owner, member)).toBe(true);
    expect(canIssueResetCode(owner, admin)).toBe(true);
    expect(canIssueResetCode(admin, member)).toBe(true);
    expect(canIssueResetCode(admin, acc('a2', 'adm2', 'human', true))).toBe(false);
    expect(canIssueResetCode(admin, owner)).toBe(false);
    expect(canIssueResetCode(owner, owner)).toBe(false);
    expect(canIssueResetCode(member, member2)).toBe(false);
    expect(canIssueResetCode(owner, acc('ag', 'bot', 'agent'))).toBe(false);
  });

  it('코드 칸은 4-4-4 로 묶고 12자에서 자른다', () => {
    expect(groupCode('k7qf9mxd2pqr')).toBe('K7QF-9MXD-2PQR');
    expect(groupCode('K7QF-9MXD-2PQRXX')).toBe('K7QF-9MXD-2PQR');
    expect(groupCode('k7q')).toBe('K7Q');
  });

  it('멤버 목록: 새 서버에서만, 대상 줄에만 버튼이 선다', async () => {
    setup();
    useActiveStore.getState().set({ me: admin, accounts: { a1: admin, m1: member, o1: owner } });
    setServer('0.4.113');
    const { unmount } = render(<InviteSettings />);
    await waitFor(() => expect(screen.getByTestId('members-list')).toBeTruthy());
    expect(screen.queryByTestId('reset-code-open-m1')).toBeNull();
    unmount();
    setServer('0.4.122');
    render(<InviteSettings />);
    expect(await screen.findByTestId('reset-code-open-m1')).toBeTruthy();
    expect(screen.queryByTestId('reset-code-open-o1')).toBeNull();
    expect(screen.queryByTestId('reset-code-open-a1')).toBeNull();
  });
});

describe('발급 창', () => {
  it('비밀번호를 확인한 뒤 코드를 한 번 보이고, 복사는 가림 클립보드를 먼저 쓴다', async () => {
    const c = setup();
    const writes: string[] = [];
    setConcealedClipboardInvoke(async (_cmd: string, args: unknown) => { writes.push((args as { text: string }).text); });
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    const onClose = vi.fn();
    render(<ResetCodeDialog account={member} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('reset-code-password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByTestId('reset-code-issue'));
    expect((await screen.findByTestId('reset-code-value')).textContent).toBe('K7QF-9MXD-2PQR');
    expect(c.unlockSecrets).toHaveBeenCalledWith('pw123456');
    expect(c.issuePasswordResetCode).toHaveBeenCalledWith('m1');
    fireEvent.click(screen.getByTestId('reset-code-copy'));
    await waitFor(() => expect(writes).toEqual(['K7QF-9MXD-2PQR']));
    expect(screen.getByText('복사했다. 클립보드는 60초 뒤에 비운다.')).toBeTruthy();
  });

  it('거두면 코드가 화면에서 사라진다', async () => {
    const c = setup();
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    render(<ResetCodeDialog account={member} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('reset-code-issue'));
    await screen.findByTestId('reset-code-value');
    fireEvent.click(screen.getByText('코드 거두기'));
    await screen.findByTestId('reset-code-revoked');
    expect(c.revokePasswordResetCode).toHaveBeenCalledWith('m1');
    expect(screen.queryByText('K7QF-9MXD-2PQR')).toBeNull();
  });
});

describe('로그인 화면', () => {
  it('안내 단계는 서버를 부르지 않는다', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const onHave = vi.fn();
    render(<ForgotPasswordGuide onHaveCode={onHave} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId('pwreset-have-code'));
    expect(onHave).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  const fill = () => {
    fireEvent.change(screen.getByTestId('pwreset-code'), { target: { value: 'k7qf9mxd2pqr' } });
    fireEvent.change(screen.getByTestId('pwreset-new'), { target: { value: 'new-pass-1234' } });
    fireEvent.change(screen.getByTestId('pwreset-confirm'), { target: { value: 'new-pass-1234' } });
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('새 비밀번호 칸은 new-password autofill 이고, 실패 문구는 하나다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/healthz')
      ? json(200, { ok: true, version: '0.4.122' })
      : json(400, { error: { code: 'invalid_reset_code', message: 'the reset code is wrong, already used, or expired' } })));
    render(<ResetWithCodeForm baseUrl="https://hk.example.com" initialLoginId="minji" onSignedIn={vi.fn()} onBack={() => {}} />);
    expect(screen.getByTestId('pwreset-new').getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByTestId('pwreset-confirm').getAttribute('autocomplete')).toBe('new-password');
    fill();
    expect((screen.getByTestId('pwreset-code') as HTMLInputElement).value).toBe('K7QF-9MXD-2PQR');
    fireEvent.click(screen.getByTestId('pwreset-submit'));
    expect((await screen.findByTestId('pwreset-error')).textContent)
      .toBe('코드가 맞지 않거나 이미 쓴 코드거나 만료됐다. 관리자에게 새 코드를 받아라.');
  });

  it('옛 서버면 라우트를 부르지 않고 「지원하지 않는다」를 말한다', async () => {
    const fetch = vi.fn(async () => json(200, { ok: true, version: '0.4.113' }));
    vi.stubGlobal('fetch', fetch);
    render(<ResetWithCodeForm baseUrl="https://hk.example.com" initialLoginId="minji" onSignedIn={vi.fn()} onBack={() => {}} />);
    fill();
    fireEvent.click(screen.getByTestId('pwreset-submit'));
    expect((await screen.findByTestId('pwreset-error')).textContent).toContain('아직 재설정 코드를 지원하지 않는다');
    expect(fetch.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['https://hk.example.com/healthz']);
  });

  it('성공하면 받은 토큰으로 곧바로 로그인한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/healthz')
      ? json(200, { ok: true, version: '0.4.122' }) : json(200, { token: 'hrks_new' })));
    const onSignedIn = vi.fn(async () => {});
    render(<ResetWithCodeForm baseUrl="https://hk.example.com" initialLoginId="minji" onSignedIn={onSignedIn} onBack={() => {}} />);
    fill();
    fireEvent.click(screen.getByTestId('pwreset-submit'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect((onSignedIn.mock.calls[0] as unknown[])[1]).toBe('hrks_new');
  });
});

describe('본인 알림', () => {
  it('발급자를 id 가 아니라 이름으로 보이고, 확인하면 내려간다', async () => {
    const c = setup({
      passwordResetNotices: vi.fn(async () => ({ notices: [{
        id: 'n1', issuedById: 'a1', issuedAt: '2026-10-20T03:00:00Z', expiresAt: '2026-10-20T03:30:00Z', usedAt: null, revokedAt: null,
      }] })),
    });
    useActiveStore.getState().set({ me: member, accounts: { m1: member, a1: admin } });
    setServer('0.4.122');
    render(<PasswordResetNoticeBanner />);
    const banner = await screen.findByTestId('pwreset-notice');
    expect(banner.textContent).toContain('adm (@adm)');
    expect(banner.textContent).not.toContain('a1');
    fireEvent.click(screen.getByTestId('pwreset-notice-ack'));
    await waitFor(() => expect(screen.queryByTestId('pwreset-notice')).toBeNull());
    expect(c.ackPasswordResetNotices).toHaveBeenCalledWith(['n1']);
  });

  it('옛 서버에는 묻지 않는다', async () => {
    const c = setup();
    useActiveStore.getState().set({ me: member, accounts: { m1: member } });
    setServer('0.4.113');
    render(<PasswordResetNoticeBanner />);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.passwordResetNotices).not.toHaveBeenCalled();
  });
});

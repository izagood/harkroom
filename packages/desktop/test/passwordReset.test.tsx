/**
 * 비밀번호 재설정 코드 — 화면(스레드 a6017542, 서버 #1409). 재는 것: 누가 누구에게 [재설정 코드] 를 보나(서버 선과 같다),
 * 옛 서버에는 버튼이 없다, 발급 창은 비밀번호 재확인 → 코드를 한 번 보이고 닫으면 사라진다, 복사는 가림 클립보드 먼저,
 * 로그인 화면은 안내(서버 호출 없음) → 코드 폼, 실패 문구는 하나, 옛 서버면 「지원하지 않는다」, 알림 띠는 발급자를 이름으로.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import {
  canIssueResetCode, groupCode, PasswordResetNoticeBanner, ResetCodeDialog, ResetWithCodeForm, ForgotPasswordGuide,
} from '../src/components/PasswordReset';
import { InviteSettings } from '../src/components/settings/InviteSettings';
import { ConnectScreen } from '../src/screens/ConnectScreen';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setConcealedClipboardInvoke } from '../src/lib/concealedClipboard';
import { ApiError } from '../src/lib/api';
import { PASSWORD_MAX_LENGTH } from '@harkroom/shared';
import { acc } from './helpers/fakeApi';

const owner = acc('o1', 'boss', 'human', true, { role: 'owner' });
const admin = acc('a1', 'adm', 'human', true);
const member = acc('m1', 'minji');
const member2 = acc('m2', 'hoon');

function setup(over: Partial<Record<string, unknown>> = {}) {
  const c = {
    refreshAccounts: vi.fn(async () => undefined),
    unlockSecrets: vi.fn(async () => ({ steppedUpUntil: new Date(Date.now() + 900_000).toISOString() })),
    lockSecrets: vi.fn(async () => undefined),
    issuePasswordResetCode: vi.fn(async () => ({ code: 'K7QF-9MXD-2PQR', expiresAt: new Date(Date.now() + 1_800_000).toISOString() })),
    revokePasswordResetCode: vi.fn(async () => undefined),
    passwordResetNotices: vi.fn(async () => ({ notices: [] })),
    ackPasswordResetNotices: vi.fn(async () => undefined),
    loginIds: vi.fn(async (): Promise<Record<string, string>> => ({})),
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

describe('멤버와 초대의 로그인 ID(관리자만)', () => {
  it('관리자·새 서버면 줄마다 로그인 ID 를 보인다', async () => {
    const c = setup({ loginIds: vi.fn(async () => ({ m1: 'member-login-1' })) });
    useActiveStore.getState().set({ me: admin, accounts: { a1: admin, m1: member } });
    setServer('0.4.184');
    render(<InviteSettings />);
    expect((await screen.findByTestId('member-login-id-m1')).textContent).toContain('member-login-1');
    expect(c.loginIds).toHaveBeenCalled();
  });

  it('긴 로그인 ID 는 @handle 뒤에서 잘리고 title 로 전체를 보인다(designer s1·n1) — 사람이 늘면 다시 읽는다(n2)', async () => {
    const long = 'l'.repeat(64);
    const c = setup({ loginIds: vi.fn(async () => ({ m1: long })) });
    useActiveStore.getState().set({ me: admin, accounts: { a1: admin, m1: member } });
    setServer('0.4.184');
    render(<InviteSettings />);
    const value = await screen.findByTestId('member-login-id-value-m1');
    expect(value.className).toContain('truncate');
    expect(value.getAttribute('title')).toBe(long);
    // 줄 끝 동작 칸이 아니라 @handle 뒤에 있다.
    const row = screen.getByTestId('directory-row-m1');
    const handle = within(row).getByText('@minji');
    expect(handle.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const calls = c.loginIds.mock.calls.length;
    act(() => { useActiveStore.getState().set({ accounts: { a1: admin, m1: member, m2: member2 } }); });
    await waitFor(() => expect(c.loginIds.mock.calls.length).toBeGreaterThan(calls));
  });

  it('권한이 없거나 옛 서버면 부르지도 않고, 실패하면 줄을 그리지 않는다', async () => {
    const c = setup({ loginIds: vi.fn(async () => ({ m1: 'x' })) });
    useActiveStore.getState().set({ me: member, accounts: { m1: member, m2: member2 } });
    setServer('0.4.184');
    const r1 = render(<InviteSettings />);
    await waitFor(() => expect(screen.getByTestId('members-list')).toBeTruthy());
    expect(c.loginIds).not.toHaveBeenCalled();
    r1.unmount();

    useActiveStore.getState().set({ me: admin, accounts: { a1: admin, m1: member } });
    setServer('0.4.183'); // 0.4.181~0.4.183 에는 이 라우트가 없다
    const r2 = render(<InviteSettings />);
    await waitFor(() => expect(screen.getByTestId('members-list')).toBeTruthy());
    expect(c.loginIds).not.toHaveBeenCalled();
    r2.unmount();

    setup({ loginIds: vi.fn(async () => { throw new ApiError(404, 'not_found', 'nope'); }) });
    setServer('0.4.184');
    render(<InviteSettings />);
    await waitFor(() => expect(screen.getByTestId('members-list')).toBeTruthy());
    expect(screen.queryByTestId('member-login-id-m1')).toBeNull();
  });
});

describe('발급 창', () => {
  const stepUpRequired = () => new ApiError(403, 'step_up_required', 'confirm your password');
  const CODE = { code: 'K7QF-9MXD-2PQR', expiresAt: new Date(Date.now() + 1_800_000).toISOString() };

  it('창이 잠겨 있으면 비밀번호로 열고 코드를 한 번 보인다 — 복사는 가림 클립보드 먼저, 닫으면 내가 연 창을 잠근다', async () => {
    const c = setup({
      issuePasswordResetCode: vi.fn().mockRejectedValueOnce(stepUpRequired()).mockResolvedValue(CODE),
    });
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
    cleanup();
    expect(c.lockSecrets).toHaveBeenCalledTimes(1);
  });

  it('이미 열려 있던 창이면 비밀번호를 묻지 않고, 닫아도 그 창을 잠그지 않는다', async () => {
    const c = setup();
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    render(<ResetCodeDialog account={member} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('reset-code-issue'));
    await screen.findByTestId('reset-code-value');
    expect(c.unlockSecrets).not.toHaveBeenCalled();
    cleanup();
    expect(c.lockSecrets).not.toHaveBeenCalled();
  });

  it('창이 잠겨 있는데 비밀번호를 안 쓰면 그렇게 말한다', async () => {
    setup({ issuePasswordResetCode: vi.fn().mockRejectedValue(stepUpRequired()) });
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    render(<ResetCodeDialog account={member} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('reset-code-issue'));
    expect((await screen.findByTestId('reset-code-error')).textContent).toBe('코드를 발급하려면 비밀번호를 입력해라.');
  });

  it('코드가 보이는 동안 Esc 로는 닫히지 않는다(designer n1) — [닫기] 로만', async () => {
    setup();
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    const onClose = vi.fn();
    render(<ResetCodeDialog account={member} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('reset-code-issue'));
    await screen.findByTestId('reset-code-value');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('reset-code-dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('reset-code-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('줄 버튼 이름은 사람마다 다르다(n3)', () => {
    setup();
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    setServer('0.4.122');
    render(<InviteSettings />);
    return screen.findByRole('button', { name: 'minji의 비밀번호 재설정 코드' });
  });

  it('발급 응답의 로그인 ID 를 코드와 함께 보이고 「함께 전해라」로 안내한다 — 옛 서버(없음)면 줄을 그리지 않는다', async () => {
    setup({ issuePasswordResetCode: vi.fn(async () => ({ ...CODE, loginId: 'login-other-7' })) });
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    render(<ResetCodeDialog account={member} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('reset-code-issue'));
    const line = await screen.findByTestId('reset-code-login-id');
    expect(line.textContent).toContain('login-other-7');
    expect(screen.getByText(/로그인 ID와 코드를 함께/)).toBeTruthy();
    // 받는 쪽 입력 순서대로 로그인 ID 가 코드보다 위(designer n1).
    expect(line.compareDocumentPosition(screen.getByTestId('reset-code-value')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // [복사]는 둘을 함께 담는다(designer s1) — 가림 클립보드에 쓴 글에 두 값이 다 있다.
    const writes: string[] = [];
    setConcealedClipboardInvoke(async (_cmd: string, args: unknown) => { writes.push((args as { text: string }).text); });
    const copyBtn = screen.getByTestId('reset-code-copy');
    expect(copyBtn.textContent).toBe('로그인 ID와 코드 복사');
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writes).toEqual(['로그인 ID: login-other-7\n재설정 코드: K7QF-9MXD-2PQR']));
    cleanup();

    setup({ issuePasswordResetCode: vi.fn(async () => CODE) });
    useActiveStore.getState().set({ me: owner, accounts: { o1: owner, m1: member } });
    render(<ResetCodeDialog account={member} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('reset-code-issue'));
    await screen.findByTestId('reset-code-value');
    expect(screen.queryByTestId('reset-code-login-id')).toBeNull();
    // 옛 서버면 코드만 복사한다.
    const only: string[] = [];
    setConcealedClipboardInvoke(async (_cmd: string, args: unknown) => { only.push((args as { text: string }).text); });
    expect(screen.getByTestId('reset-code-copy').textContent).toBe('복사');
    fireEvent.click(screen.getByTestId('reset-code-copy'));
    await waitFor(() => expect(only).toEqual(['K7QF-9MXD-2PQR']));
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
  it('새 비밀번호를 정하는 자리(초대 가입)는 상한을 넘으면 문구로 막는다 — 로그인은 보지 않는다', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    const pw = screen.getByTestId('connect-password') as HTMLInputElement;
    expect(pw.hasAttribute('maxlength')).toBe(false);
    const long = 'z'.repeat(PASSWORD_MAX_LENGTH + 1);
    fireEvent.change(pw, { target: { value: long } });
    // 로그인: 정해 둔 것을 대는 자리라 문구가 없다.
    expect(screen.queryByTestId('connect-password-too-long')).toBeNull();
    fireEvent.click(screen.getByText('초대 토큰으로 이 커뮤니티에 들어가기'));
    expect(screen.getByTestId('connect-password-too-long').textContent).toBe(`비밀번호는 ${PASSWORD_MAX_LENGTH}자를 넘을 수 없다.`);
    expect((screen.getByRole('button', { name: '초대로 들어가기' }) as HTMLButtonElement).disabled).toBe(true);
    // 상한 안으로 줄이면 문구가 사라진다.
    fireEvent.change(screen.getByTestId('connect-password'), { target: { value: 'z'.repeat(PASSWORD_MAX_LENGTH) } });
    expect(screen.queryByTestId('connect-password-too-long')).toBeNull();
  });

  it('「비밀번호」 라벨은 칸에 붙고, 「잊었다면」은 칸 뒤·로그인 앞이다(designer s1)', () => {
    render(<ConnectScreen onConnected={vi.fn()} />);
    const input = screen.getByTestId('connect-password');
    // 라벨 이름이 칸에 붙어 있다 — 버튼이 label 안에 있으면 이 조회가 버튼을 돌려준다.
    expect(screen.getByLabelText('비밀번호')).toBe(input);
    const forgot = screen.getByTestId('connect-forgot');
    expect(forgot.closest('label')).toBeNull();
    expect(input.compareDocumentPosition(forgot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const submit = screen.getByRole('button', { name: '로그인' });
    expect(forgot.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(forgot);
    expect(screen.getByTestId('pwreset-guide')).toBeTruthy();
  });

  it('코드 화면은 Enter(폼 제출)로 보내고, 로그인 ID 가 있으면 코드 칸에 포커스한다(s2·n4)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/healthz')
      ? new Response(JSON.stringify({ ok: true, version: '0.4.122' }), { status: 200 })
      : new Response(JSON.stringify({ token: 'hrks_new' }), { status: 200 })));
    const onSignedIn = vi.fn(async () => {});
    render(<ResetWithCodeForm baseUrl="https://hk.example.com" initialLoginId="minji" onSignedIn={onSignedIn} onBack={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId('pwreset-code'));
    fireEvent.change(screen.getByTestId('pwreset-code'), { target: { value: 'k7qf9mxd2pqr' } });
    fireEvent.change(screen.getByTestId('pwreset-new'), { target: { value: 'new-pass-1234' } });
    fireEvent.change(screen.getByTestId('pwreset-confirm'), { target: { value: 'new-pass-1234' } });
    fireEvent.submit(screen.getByTestId('pwreset-form'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it('「8자 이상」은 칸을 떠난 뒤에야 보인다(n5)', () => {
    render(<ResetWithCodeForm baseUrl="https://hk.example.com" initialLoginId="" onSignedIn={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByTestId('pwreset-new'), { target: { value: 'abc' } });
    expect(screen.queryByText('8자 이상이어야 한다.')).toBeNull();
    fireEvent.blur(screen.getByTestId('pwreset-new'));
    expect(screen.getByText('8자 이상이어야 한다.')).toBeTruthy();
  });

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

  it('새 비밀번호가 128자를 넘으면 보내지 않는다(n2)', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<ResetWithCodeForm baseUrl="https://hk.example.com" initialLoginId="minji" onSignedIn={vi.fn()} onBack={() => {}} />);
    fill();
    const long = 'x'.repeat(129);
    fireEvent.change(screen.getByTestId('pwreset-new'), { target: { value: long } });
    fireEvent.change(screen.getByTestId('pwreset-confirm'), { target: { value: long } });
    expect(screen.getByText('128자를 넘을 수 없다.')).toBeTruthy();
    expect((screen.getByTestId('pwreset-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('새 비밀번호 칸은 상한으로 자르지 않는다 — 붙여 넣은 값이 그대로 남는다', () => {
    render(<ResetWithCodeForm baseUrl="https://hk.example.com" initialLoginId="minji" onSignedIn={vi.fn()} onBack={() => {}} />);
    const input = screen.getByTestId('pwreset-new') as HTMLInputElement;
    expect(input.hasAttribute('maxlength')).toBe(false);
    const long = 'y'.repeat(PASSWORD_MAX_LENGTH + 5);
    fireEvent.change(input, { target: { value: long } });
    expect(input.value.length).toBe(PASSWORD_MAX_LENGTH + 5);
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

  it('여러 건이면 전부 보이고, [확인] 은 보인 id 만 내린다(security F1)', async () => {
    const c = setup({
      passwordResetNotices: vi.fn(async () => ({ notices: [
        { id: 'n2', issuedById: 'o1', issuedAt: '2026-10-20T04:00:00Z', expiresAt: '2026-10-20T04:30:00Z', usedAt: '2026-10-20T04:05:00Z', revokedAt: null },
        { id: 'n1', issuedById: 'a1', issuedAt: '2026-10-20T03:00:00Z', expiresAt: '2026-10-20T03:30:00Z', usedAt: '2026-10-20T03:10:00Z', revokedAt: null },
      ] })),
    });
    useActiveStore.getState().set({ me: member, accounts: { m1: member, a1: admin, o1: { ...owner, displayName: '' } } });
    setServer('0.4.122');
    render(<PasswordResetNoticeBanner />);
    expect((await screen.findByTestId('pwreset-notice-n1')).textContent).toContain('adm (@adm)');
    // 표시 이름이 비면 handle 로(n3).
    expect(screen.getByTestId('pwreset-notice-n2').textContent).toContain('boss (@boss)');
    fireEvent.click(screen.getByTestId('pwreset-notice-ack'));
    await waitFor(() => expect(screen.queryByTestId('pwreset-notice')).toBeNull());
    expect(c.ackPasswordResetNotices).toHaveBeenCalledWith(['n2', 'n1']);
  });

  it('사용됨과 사용 안 된 발급이 섞이면 두 설명을 다 보인다(designer n7)', async () => {
    setup({
      passwordResetNotices: vi.fn(async () => ({ notices: [
        { id: 'n2', issuedById: 'a1', issuedAt: '2026-10-20T04:00:00Z', expiresAt: '2026-10-20T04:30:00Z', usedAt: null, revokedAt: null },
        { id: 'n1', issuedById: 'o1', issuedAt: '2026-10-20T03:00:00Z', expiresAt: '2026-10-20T03:30:00Z', usedAt: '2026-10-20T03:10:00Z', revokedAt: null },
      ] })),
    });
    useActiveStore.getState().set({ me: member, accounts: { m1: member, a1: admin, o1: owner } });
    setServer('0.4.122');
    render(<PasswordResetNoticeBanner />);
    const detail = await screen.findByTestId('pwreset-notice-detail');
    expect(detail.textContent).toContain('다른 기기의 로그인은 모두 끊었다.');
    expect(detail.textContent).toContain('요청한 적이 없다면 소유자에게 알려라.');
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

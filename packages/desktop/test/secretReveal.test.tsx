/**
 * 비밀 소유자 보기(114, designer v3) — 판정은 서버다. 여기서 재는 것: 옛 서버에서는 버튼이 없다, 잠겨 있으면 확인 창
 * 하나가 뜨고 풀리면 누른 행이 바로 열린다, 머리줄 시각은 서버 값으로만, 30초 뒤 값이 화면에서 사라진다, 복사는
 * 서버에서 다시 받고 `writeConcealed` 결과에 따라 문구가 갈린다, 429 는 본문 retryAfterSec 로 「n분 뒤」, 잠그기는 DELETE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { SecretsSettings } from '../src/components/settings/SecretsSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError, type SecretView } from '../src/lib/api';
import { setConcealedClipboardInvoke } from '../src/lib/concealedClipboard';
import { acc } from './helpers/fakeApi';

const ME = 'owner-1';
const VALUE = 'reveal-test-value-0001';
const secret = (name: string, over: Partial<SecretView> = {}): SecretView => ({
  id: `id-${name}`, name, kind: 'text', filename: null, description: '', ownerAccountId: ME,
  expiresAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', version: 1, sizeBytes: 10, grantCount: 0, ...over,
});
const until = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

function setup(over: Partial<Record<string, unknown>> = {}) {
  const c = {
    listSecrets: vi.fn(async () => ({ enabled: true, secrets: [secret('api-token')] })),
    listSecretAccess: vi.fn(async () => []),
    unlockSecrets: vi.fn(async () => ({ steppedUpUntil: until(15) })),
    lockSecrets: vi.fn(async () => undefined),
    revealSecret: vi.fn(async () => ({ steppedUpUntil: until(15), name: 'api-token', kind: 'text', filename: null, version: 1, value: VALUE })),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
}
const setServer = (version: string) =>
  useActiveStore.getState().set({ serverVersion: { version } as never });

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc(ME, 'owner'), accounts: { [ME]: acc(ME, 'owner') } });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); setConcealedClipboardInvoke(null); vi.useRealTimers(); cleanup(); });

describe('비밀 소유자 보기', () => {
  it('옛 서버(0.4.20 아래)에서는 [값 보기]·잠금 해제가 없다', async () => {
    setup(); setServer('0.4.19');
    render(<SecretsSettings />);
    await screen.findByTestId('secret-api-token');
    expect(screen.queryByText(/값 보기/)).toBeNull();
  });

  it('잠긴 채 [값 보기] → 확인 창 하나 → 풀리면 그 행이 바로 열리고 머리줄은 서버 시각', async () => {
    const c = setup(); setServer('0.4.20');
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'api-token 값 보기' }));
    expect(screen.getByTestId('secrets-unlock-dialog').textContent).toContain('api-token');
    fireEvent.change(screen.getByTestId('secrets-unlock-password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByTestId('secrets-unlock-submit'));
    await waitFor(() => expect(screen.getByTestId('secret-reveal-value').textContent).toBe(VALUE));
    expect(c.unlockSecrets).toHaveBeenCalledWith('pw123456');
    expect(c.revealSecret).toHaveBeenCalledWith('id-api-token', expect.objectContaining({ action: 'view' }));
    expect(screen.getByTestId('secrets-unlocked').textContent).toContain('잠금 해제됨');
    expect(screen.queryByTestId('secrets-unlock-dialog')).toBeNull();
  });

  it('틀린 비밀번호는 칸 아래 오류, 429 는 본문 retryAfterSec 로 「n분 뒤」 + 비활성', async () => {
    let n = 0;
    setup({ unlockSecrets: vi.fn(async () => {
      n += 1;
      if (n === 1) throw new ApiError(401, 'invalid_credentials', 'wrong');
      throw new ApiError(429, 'rate_limited', 'slow', { error: { code: 'rate_limited', retryAfterSec: 125 } });
    }) });
    setServer('0.4.20');
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /값 보기 잠금 해제/ }));
    fireEvent.change(screen.getByTestId('secrets-unlock-password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('secrets-unlock-submit'));
    expect((await screen.findByTestId('secrets-unlock-error')).textContent).toContain('맞지 않는다');
    fireEvent.click(screen.getByTestId('secrets-unlock-submit'));
    await waitFor(() => expect(screen.getByTestId('secrets-unlock-error').textContent).toContain('3분 뒤'));
    expect((screen.getByTestId('secrets-unlock-password') as HTMLInputElement).disabled).toBe(true);
  });

  it('30초가 지나면 값이 화면에서 사라지고 [다시 보기] 한 줄이 남는다', async () => {
    setup(); setServer('0.4.20');
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /값 보기 잠금 해제/ }));
    fireEvent.change(screen.getByTestId('secrets-unlock-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('secrets-unlock-submit'));
    await screen.findByTestId('secrets-unlocked');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: 'api-token 값 보기' }));
    await waitFor(() => expect(screen.getByTestId('secret-reveal-value').textContent).toBe(VALUE));
    for (let i = 0; i < 31; i++) await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByTestId('secret-reveal-value')).toBeNull();
    expect(document.body.textContent).not.toContain(VALUE);
    expect(screen.getByRole('button', { name: '다시 보기' })).toBeTruthy();
  });

  it('복사는 서버에서 다시 받고, writeConcealed 가 되면 「60초 뒤 비운다」, 안 되면 「비워 주세요」', async () => {
    const c = setup(); setServer('0.4.20');
    const invoke = vi.fn(async () => undefined);
    setConcealedClipboardInvoke(invoke);
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /값 보기 잠금 해제/ }));
    fireEvent.change(screen.getByTestId('secrets-unlock-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('secrets-unlock-submit'));
    await screen.findByTestId('secrets-unlocked');
    fireEvent.click(screen.getByRole('button', { name: 'api-token 값 보기' }));
    await screen.findByTestId('secret-reveal-value');
    fireEvent.click(screen.getByRole('button', { name: '복사' }));
    await waitFor(() => expect(screen.getByTestId('secrets-toast').textContent).toContain('60초 뒤'));
    expect(c.revealSecret).toHaveBeenCalledWith('id-api-token', expect.objectContaining({ action: 'copy' }));
    expect(invoke).toHaveBeenCalledWith('clipboard_write_concealed', { text: VALUE });
    setConcealedClipboardInvoke(async () => { throw new Error('not macOS'); });
    fireEvent.click(screen.getByRole('button', { name: '복사' }));
    await waitFor(() => expect(screen.getByTestId('secrets-toast').textContent).toContain('비워 주세요'));
  });

  it('[잠그기]는 화면부터 잠그고 DELETE 를 부른다 — 열린 값 패널도 닫힌다', async () => {
    const c = setup(); setServer('0.4.20');
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /값 보기 잠금 해제/ }));
    fireEvent.change(screen.getByTestId('secrets-unlock-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('secrets-unlock-submit'));
    await screen.findByTestId('secrets-unlocked');
    fireEvent.click(screen.getByRole('button', { name: 'api-token 값 보기' }));
    await screen.findByTestId('secret-reveal-value');
    fireEvent.click(screen.getByRole('button', { name: '잠그기' }));
    expect(screen.queryByTestId('secrets-unlocked')).toBeNull();
    expect(screen.queryByTestId('secret-reveal')).toBeNull();
    expect(c.lockSecrets).toHaveBeenCalledTimes(1);
  });

  it('설정을 닫으면(언마운트) 열린 창을 서버에서도 끝낸다', async () => {
    const c = setup(); setServer('0.4.20');
    const view = render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /값 보기 잠금 해제/ }));
    fireEvent.change(screen.getByTestId('secrets-unlock-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('secrets-unlock-submit'));
    await screen.findByTestId('secrets-unlocked');
    view.unmount();
    expect(c.lockSecrets).toHaveBeenCalledTimes(1);
  });
});

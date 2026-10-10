/**
 * 머지 거절에서 온 권한 카드의 [이번 한 번 머지](스레드 1b75d7a0 ③). 판정은 전부 서버다. 여기서 재는 것:
 * `once` 가 있을 때만 서는가 · 소유자에게만 버튼 · 펼친 뒤에만 계정·CI 칸 · ✕ 계정은 못 고름 · byScope ✓ 미리 고름 ·
 * 다른 기기면 버튼 대신 안내 · 보내는 것은 계정·CI 완화뿐 · 결정 뒤 한 줄 · cause_not_human 은 7일이 안 풀린다는 안내.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { PermissionOncePanel, readPermissionOnce } from '../src/components/PermissionOncePanel';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';
import { ApiError } from '../src/lib/api';

const ME = 'owner-1';
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const card = (over: Record<string, unknown> = {}, once: Record<string, unknown> | null = {}): MessageRow => ({
  id: 'm1', seq: 1, channelId: 'c1', threadRootId: 't1', authorId: 'agent-1', body: 'card',
  kind: 'user', createdAt: '', editedAt: null, reactions: [], attachments: [],
  meta: {
    kind: 'ask', ask: { options: [{ id: 'approve', label: '승인' }, { id: 'deny', label: '거절' }], to: { kind: 'human' } },
    permissionRequest: {
      requestId: 'req-1', agentId: 'agent-1', ownerAccountId: ME, kind: 'merge', target: 'example-org/service-api', channelId: null,
      warnings: [], reason: 'x', requestedAt: '', expiresAt: '',
      ...(once ? { once: { number: 42, headSha: HEAD, reason: 'not_granted', ...once } } : {}),
      ...over,
    },
  },
} as unknown as MessageRow);

let invoke: ReturnType<typeof vi.fn>;
function tauri(opts: { here?: boolean; byScope?: Record<string, string>; reach?: Record<string, 'ok' | 'no' | 'unknown'> } = {}) {
  const { here = true, byScope = {}, reach = { izagood: 'ok', 'corp-account': 'no', other: 'unknown' } } = opts;
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'operator_agents_list') return { communities: [{ baseUrl: 'x', registered: true, operatorId: 'op', agents: here ? { 'agent-1': {} } : {} }] };
    if (cmd === 'operator_merge_get') return { ghUser: null, byScope, accounts: [{ login: 'izagood', active: false }, { login: 'corp-account', active: true }, { login: 'other', active: false }], host: 'mac' };
    if (cmd === 'operator_merge_check') {
      return { reach: { 'example-org/service-api': Object.fromEntries(Object.entries(reach).map(([k, v]) => [k, { status: v, checkedAt: '2026-10-10T00:00:00Z' }])) } };
    }
    throw new Error(`unexpected ${cmd}`);
  });
  (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
}
function setup(over: Record<string, unknown> = {}) {
  const c = { approvePermissionOnce: vi.fn(async () => ({ status: 'approved_once', approvalExpiresAt: '2026-10-11T05:14:00Z', cardMessageId: 'm1' })), ...over };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({
    me: acc(ME, 'owner'),
    accounts: { [ME]: acc(ME, 'owner'), 'agent-1': acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME }), other: acc('other', 'carol') },
  });
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  cleanup();
});

describe('PermissionOncePanel', () => {
  it('거절에서 온 머지 카드(once)에만 선다 — 일반 권한 카드·명령 카드에는 없다', () => {
    expect(readPermissionOnce(card({}, null).meta)).toBeNull();
    expect(readPermissionOnce(card({ kind: 'tool' }).meta)).toBeNull();
    setup();
    const { container } = render(<PermissionOncePanel message={card({}, null)} />);
    expect(container.innerHTML).toBe('');
  });

  it('위층에 저장소·PR·head 9자리·이유, 펼치기 전엔 계정·CI 칸이 없고 오퍼레이터에도 묻지 않는다', () => {
    tauri(); setup();
    render(<PermissionOncePanel message={card()} />);
    expect(screen.getByTestId('merge-once-repo').textContent).toBe('example-org/service-api');
    expect(screen.getByTestId('merge-once-pr').getAttribute('href')).toBe('https://github.com/example-org/service-api/pull/42');
    expect(screen.getByTestId('merge-once-head').textContent).toBe(HEAD.slice(0, 9));
    expect(screen.getByTestId('merge-once-reason').dataset.reason).toBe('not_granted');
    expect(screen.queryByTestId('merge-once-form')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('펼치면 ✕ 계정은 못 고르고, 고르기 전엔 승인이 꺼져 있고, 보내는 것은 계정·CI 완화뿐이다', async () => {
    tauri(); const c = setup();
    render(<PermissionOncePanel message={card()} />);
    fireEvent.click(screen.getByTestId('merge-once-open'));
    const select = await screen.findByTestId('merge-once-account') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].find((o) => o.value === 'corp-account')?.disabled).toBe(true));
    expect((screen.getByTestId('merge-once-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'izagood' } });
    fireEvent.click(screen.getByTestId('merge-once-relax'));
    fireEvent.click(screen.getByTestId('merge-once-submit'));
    await waitFor(() => expect(c.approvePermissionOnce).toHaveBeenCalledWith('agent-1', 'req-1', { ghUser: 'izagood', relaxChecks: true, number: 42, headSha: HEAD }));
    expect((await screen.findByTestId('merge-once-approved')).textContent).toContain('izagood');
    // 저장하지 않는다 — byScope 를 쓰는 명령을 부르지 않는다.
    expect(invoke.mock.calls.map((x) => x[0])).not.toContain('operator_merge_set');
  });

  it('이 저장소 줄에 정해 둔 계정이 ✓ 이면 미리 고른다 · 「확인 못 함」은 고를 수 있고 경고를 붙인다', async () => {
    tauri({ byScope: { 'example-org/service-api': 'izagood' } }); setup();
    render(<PermissionOncePanel message={card()} />);
    fireEvent.click(screen.getByTestId('merge-once-open'));
    const select = await screen.findByTestId('merge-once-account') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('izagood'));
    fireEvent.change(select, { target: { value: 'other' } });
    expect(screen.getByTestId('merge-once-unknown')).toBeTruthy();
  });

  it('에이전트가 다른 기기에서 돌면 계정 칸 대신 「그 기기에서」 안내만', async () => {
    tauri({ here: false }); setup();
    render(<PermissionOncePanel message={card()} />);
    fireEvent.click(screen.getByTestId('merge-once-open'));
    expect(await screen.findByTestId('merge-once-elsewhere')).toBeTruthy();
    expect(screen.queryByTestId('merge-once-account')).toBeNull();
    expect(invoke.mock.calls.map((x) => x[0])).toEqual(['operator_agents_list']);
  });

  it('소유자가 아니면 버튼 없이 기다림 안내 · cause_not_human 은 7일로 안 풀린다는 줄', () => {
    tauri(); setup();
    useActiveStore.getState().set({ me: acc('other', 'carol') });
    render(<PermissionOncePanel message={card({}, { reason: 'cause_not_human' })} />);
    expect(screen.queryByTestId('merge-once-open')).toBeNull();
    expect(screen.getByTestId('merge-once-owner-only').textContent).toContain('owner');
    cleanup();
    useActiveStore.getState().set({ me: acc(ME, 'owner') });
    render(<PermissionOncePanel message={card({}, { reason: 'cause_not_human' })} />);
    expect(screen.getByTestId('merge-once-7day-note')).toBeTruthy();
  });

  it('결정된 카드(approved_once)는 버튼 대신 한 줄 — 기한이 지나면 회색', () => {
    setup();
    render(<PermissionOncePanel message={card({ status: 'approved_once', decidedBy: ME, approvedOnce: { ghUser: 'izagood', relaxChecks: false, expiresAt: '2999-01-01T00:00:00Z' } })} />);
    expect(screen.getByTestId('merge-once-approved').textContent).toContain('izagood');
    expect(screen.queryByTestId('merge-once-open')).toBeNull();
    cleanup();
    render(<PermissionOncePanel message={card({ status: 'approved_once', approvedOnce: { ghUser: 'izagood', relaxChecks: false, expiresAt: '2000-01-01T00:00:00Z' } })} />);
    expect(screen.getByTestId('merge-once-approved').dataset.expired).toBe('true');
  });

  it('카드가 바뀌었으면(card_stale) 다시 확인하라고 보인다(security F1)', async () => {
    tauri(); setup({ approvePermissionOnce: vi.fn(async () => { throw new ApiError(409, 'card_stale', 'the card changed'); }) });
    render(<PermissionOncePanel message={card()} />);
    fireEvent.click(screen.getByTestId('merge-once-open'));
    const select = await screen.findByTestId('merge-once-account') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].some((o) => o.value === 'izagood')).toBe(true));
    fireEvent.change(select, { target: { value: 'izagood' } });
    fireEvent.click(screen.getByTestId('merge-once-submit'));
    const err = await screen.findByTestId('merge-once-error');
    expect(err.dataset.code).toBe('card_stale');
    expect(err.textContent).toContain('카드가 바뀌었다');
  });

  it('서버 거절은 사람에게 하는 말로 — 원문은 title 로만', async () => {
    tauri(); setup({ approvePermissionOnce: vi.fn(async () => { throw new ApiError(409, 'already_decided', 'this request is already granted'); }) });
    render(<PermissionOncePanel message={card()} />);
    fireEvent.click(screen.getByTestId('merge-once-open'));
    const select = await screen.findByTestId('merge-once-account') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].some((o) => o.value === 'izagood')).toBe(true));
    fireEvent.change(select, { target: { value: 'izagood' } });
    fireEvent.click(screen.getByTestId('merge-once-submit'));
    const err = await screen.findByTestId('merge-once-error');
    expect(err.dataset.code).toBe('already_decided');
    expect(err.textContent).not.toContain('already granted');
  });
});

/**
 * 「머지에 쓸 GitHub 계정」 줄(스레드 febe9ff8 P2, security C7·C8). 판정(목록에 있는 이름인지)은 오퍼레이터가 한다 —
 * 여기서 재는 것은 ① 이 기기에 배정된 에이전트의 소유자에게만 보이는가 ② 비어 있으면 경고가 보이고 미리 골라 둔
 * 계정이 없는가 ③ 고른 이름이 그대로 `operator_merge_set` 에 닿는가 ④ 어느 기기의 값인지 보이는가 ⑤ 오퍼레이터
 * 거절이 사람 말로 보이는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView, GrantRow } from '@harkroom/shared';
import type { OperatorMergeState } from '@harkroom/shared/daemonProtocol';
import { AgentGrantsSection } from '../src/components/settings/AgentGrantsSection';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

const ME_ID = 'owner-1';
const HERE = 'op-here';
const agent = (operatorId: string | null): AgentView => ({
  ...(acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME_ID }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, claudeLane: null, invokeScope: 'owner', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [],
  assignment: operatorId ? { agentId: 'agent-1', operatorId, assignedBy: ME_ID, assignedAt: '2026-10-01T00:00:00Z' } : null,
});

const ACCOUNTS = [{ login: 'work-account', active: true }, { login: 'izagood', active: false }];

function tauri(initial: OperatorMergeState, onSet?: (ghUser: string | null) => OperatorMergeState | Error) {
  let state = initial;
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'operator_merge_get') return state;
    if (cmd === 'operator_merge_set') {
      const r = onSet ? onSet(args!.ghUser as string | null) : { ...state, ghUser: args!.ghUser as string | null };
      if (r instanceof Error) throw r.message;  // Tauri 는 Err(String) 을 문자열로 던진다
      state = r; return r;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc(ME_ID, 'owner'), accounts: { [ME_ID]: acc(ME_ID, 'owner') } });
  grants([GRANT]);
});

const GRANT: GrantRow = { accountId: 'agent-1', capability: 'repo.merge', scope: 'repo:izagood/harkroom', grantedBy: ME_ID, grantedAt: '2026-10-02T00:00:00Z', expiresAt: null, allowAgentCause: false };
function grants(rows: GrantRow[]) {
  setController({ listGrants: vi.fn(async () => rows), putGrant: vi.fn(async () => rows), deleteGrant: vi.fn() } as unknown as Controller);
}
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  usePrefsStore.getState().setLocale('system');
  cleanup();
});

describe('머지 gh 계정 줄', () => {
  it('비어 있으면 기기 이름과 함께 경고를 띄우고, 고르는 칸에는 미리 골라 둔 계정이 없다(활성 계정도 아니다)', async () => {
    const invoke = tauri({ ghUser: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    const warn = await screen.findByTestId('merge-gh-user-unset');
    expect(warn.textContent).toContain('mac-1');
    fireEvent.click(screen.getByText('정하기'));
    const select = screen.getByLabelText('GitHub 계정') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(['계정을 고른다…', 'work-account (gh 활성 계정)', 'izagood']);
    expect((screen.getByText('저장') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'izagood' } });
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_merge_set', { ghUser: 'izagood' }));
    expect((await screen.findByTestId('merge-gh-user-value')).textContent).toBe('izagood');
    expect(screen.getByTestId('merge-gh-user').textContent).toContain('이 기기(mac-1)');
  });

  it('정해져 있으면 값을 보이고 [비우기]는 null 을 보낸다', async () => {
    const invoke = tauri({ ghUser: 'izagood', accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await screen.findByTestId('merge-gh-user-value')).textContent).toBe('izagood');
    fireEvent.click(screen.getByText('바꾸기'));
    fireEvent.click(screen.getByText('비우기'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_merge_set', { ghUser: null }));
    await screen.findByTestId('merge-gh-user-unset');
  });

  it('정한 계정이 gh 에서 로그아웃됐으면 머지가 실패한다고 알린다', async () => {
    tauri({ ghUser: 'gone', accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect(await screen.findByText(/gone 계정이 이 기기의 gh 에서 로그아웃됐다/)).toBeTruthy();
  });

  it('오퍼레이터의 흔한 거절은 사람 말로 옮긴다(#1140 n3)', async () => {
    tauri({ ghUser: null, accounts: ACCOUNTS, host: 'mac-1' }, () => new Error('izagood is not logged in to gh on this machine'));
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.click(await screen.findByText('정하기'));
    fireEvent.change(screen.getByLabelText('GitHub 계정'), { target: { value: 'izagood' } });
    fireEvent.click(screen.getByText('저장'));
    const err = (await screen.findByTestId('merge-gh-user-save-error')).textContent ?? '';
    expect(err).toContain('그 계정은 이제 이 기기의 gh 에 로그인돼 있지 않다');
    expect(err).not.toContain('not logged in');
  });

  it('gh 를 못 찾으면 사람 말로, 그 밖의 까닭은 원문을 200자로 자른다. 어느 쪽이든 고르는 칸이 없다', async () => {
    tauri({ ghUser: null, accounts: null, accountsError: 'gh auth status failed: spawn /usr/local/bin/gh ENOENT', host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.click(await screen.findByText('정하기'));
    expect(screen.getByText(/GitHub CLI 를 설치하고/)).toBeTruthy();
    expect(screen.queryByText(/ENOENT/)).toBeNull();
    expect(screen.queryByLabelText('GitHub 계정')).toBeNull();
    cleanup();
    tauri({ ghUser: null, accounts: null, accountsError: `gh auth status failed: ${'x'.repeat(300)}`, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.click(await screen.findByText('정하기'));
    expect(screen.getByRole('alert').textContent!.length).toBeLessThan(260);
  });

  it('권한이 하나도 없으면 절이 접히고 gh 계정 줄은 그리지 않는다(#1146 designer c) — 오퍼레이터도 묻지 않는다', async () => {
    grants([]);
    const invoke = tauri({ ghUser: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    await screen.findByTestId('agent-grants-none');
    expect(screen.queryByTestId('merge-gh-user')).toBeNull();
    expect(screen.queryByTestId('merge-gh-user-unset')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('만료된 권한만 있으면 경고 상자 대신 조용한 한 줄이다(#1140 n2) — [정하기]는 그대로', async () => {
    grants([{ ...GRANT, expiresAt: '2026-01-01T00:00:00Z' }]);
    const invoke = tauri({ ghUser: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await screen.findByTestId('merge-gh-user-unset-quiet')).textContent).toContain('머지에 쓸 GitHub 계정: 없음');
    expect(screen.queryByTestId('merge-gh-user-unset')).toBeNull();
    fireEvent.click(screen.getByText('정하기'));
    fireEvent.change(screen.getByLabelText('GitHub 계정'), { target: { value: 'izagood' } });
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_merge_set', { ghUser: 'izagood' }));
  });

  it('gh 실행 파일이 아닌 다른 파일의 ENOENT 는 "gh 없음"으로 바꾸지 않는다(#1146 security n1)', async () => {
    tauri({ ghUser: null, accounts: null, accountsError: 'gh auth status failed: open /home/me/.config/gh/hosts.yml: ENOENT', host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.click(await screen.findByText('정하기'));
    expect(screen.getByRole('alert').textContent).toContain('hosts.yml');
    expect(screen.queryByText(/GitHub CLI 를 설치하고/)).toBeNull();
  });

  it('gh 활성 계정을 고르면 회사 계정일 수 있다고 한 번 더 알린다(security n2). 이 값이 기기 전체에 걸린다는 안내가 있다', async () => {
    tauri({ ghUser: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.click(await screen.findByText('정하기'));
    expect(screen.getByTestId('merge-gh-user-device-wide').textContent).toContain('이 기기에서 도는 에이전트는 모두');
    expect(screen.queryByTestId('merge-gh-user-active-warn')).toBeNull();
    fireEvent.change(screen.getByLabelText('GitHub 계정'), { target: { value: 'work-account' } });
    expect(screen.getByTestId('merge-gh-user-active-warn').textContent).toContain('work-account 계정은 gh 활성 계정이다');
    fireEvent.change(screen.getByLabelText('GitHub 계정'), { target: { value: 'izagood' } });
    expect(screen.queryByTestId('merge-gh-user-active-warn')).toBeNull();
  });

  it('읽는 동안 자리를 먼저 잡는다(#1140 n5)', async () => {
    let resolve!: (v: unknown) => void;
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(() => new Promise((r) => { resolve = r; })) };
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect(await screen.findByTestId('merge-gh-user-loading')).toBeTruthy();
    resolve({ ghUser: 'izagood', accounts: ACCOUNTS, host: 'mac-1' });
    await screen.findByTestId('merge-gh-user-value');
    expect(screen.queryByTestId('merge-gh-user-loading')).toBeNull();
  });

  it('다른 기기에 배정된 에이전트면 줄 대신 안내만, 소유자가 아니거나 배정이 없으면 아무것도 — 오퍼레이터를 묻지도 않는다', async () => {
    const invoke = tauri({ ghUser: null, accounts: ACCOUNTS, host: 'mac-1' });
    const { unmount } = render(<AgentGrantsSection agent={agent('op-elsewhere')} canGrant canRevoke localOperatorId={HERE} assignedOperatorName="studio-mini" />);
    // 어느 기기인지 말한다(#1140 n4)
    expect((await screen.findByTestId('merge-gh-user-other')).textContent).toContain('다른 기기(studio-mini)');
    unmount();
    const r1 = render(<AgentGrantsSection agent={agent('op-elsewhere')} canGrant canRevoke localOperatorId={HERE} />);
    // 이름을 모르면 괄호 없는 문장(#1146 designer a)
    expect((await screen.findByTestId('merge-gh-user-other')).textContent).toBe('이 에이전트는 다른 기기에서 돈다. 머지에 쓸 GitHub 계정은 그 기기에서 정한다.');
    r1.unmount();
    const r2 = render(<AgentGrantsSection agent={agent(HERE)} canGrant={false} canRevoke localOperatorId={HERE} />);
    r2.unmount();
    render(<AgentGrantsSection agent={agent(null)} canGrant canRevoke localOperatorId={HERE} />);
    await waitFor(() => expect(screen.getByTestId('agent-grants')).toBeTruthy());
    expect(screen.queryByTestId('merge-gh-user')).toBeNull();
    expect(screen.queryByTestId('merge-gh-user-other')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

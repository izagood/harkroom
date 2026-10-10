/**
 * 머지 권한 줄마다 gh 계정(스레드 e085b6a7 · 앞선 P2 febe9ff8, security C7·C8). 판정(목록에 있는 이름인지)은 오퍼레이터가 한다 —
 * 여기서 재는 것은 ① 이 기기에 배정된 에이전트의 소유자에게만 묻는가 ② 처음 열 때 옛 값을 줄들에 한 번 옮기는가 ③ 계정 없는
 * 줄은 미리 골라 두지 않고 경고하는가(같은 owner 줄만 이어받는다) ④ 고른 이름이 그 줄 범위와 함께 `operator_merge_set` 에
 * 닿는가 ⑤ 로그아웃된 계정·오퍼레이터 거절이 사람 말로 보이는가 ⑥ 어느 기기의 값인지 보이는가 ⑦ 닿음 ✓/✕(A·B·E)가 줄과 목록에
 * 보이고, 닿는 계정을 위로 올리되 미리 고르지 않는가다.
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

type SetArgs = { ghUser?: string | null; scope?: string; migrate?: string[] };
/** 오퍼레이터 흉내 — migrate·scope 를 실제 규칙(한 번만 옮김, 목록에 있는 이름만)대로 처리한다. */
function tauri(initial: OperatorMergeState, opts: { failSet?: string; failCheck?: boolean; reach?: Record<string, Record<string, 'ok' | 'no' | 'unknown'>> } = {}) {
  let state = initial;
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'operator_merge_get') return state;
    if (cmd === 'operator_merge_check') {
      if (opts.failCheck) throw 'gh api: network down';
      const scopes = (args as { scopes: string[] }).scopes;
      const reach: Record<string, Record<string, { status: string; checkedAt: string }>> = {};
      for (const sc of scopes) for (const [login, status] of Object.entries(opts.reach?.[sc] ?? {})) (reach[sc] ??= {})[login] = { status, checkedAt: '2026-10-09T14:30:00Z' };
      return { reach };
    }
    if (cmd === 'operator_merge_set') {
      const a = args as SetArgs;
      if (a.migrate) {
        if (state.byScope === null) state = { ...state, ghUser: null, byScope: Object.fromEntries(state.ghUser ? a.migrate.map((sc) => [sc, state.ghUser!]) : []) };
        return state;
      }
      if (opts.failSet) throw opts.failSet;  // Tauri 는 Err(String) 을 문자열로 던진다
      if (a.ghUser && !state.accounts?.some((x) => x.login === a.ghUser)) throw `${a.ghUser} is not logged in to gh on this machine`;
      const byScope = { ...(state.byScope ?? {}) };
      if (a.ghUser) byScope[a.scope!] = a.ghUser; else delete byScope[a.scope!];
      state = { ...state, byScope };
      return state;
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
const ORG = (owner: string): GrantRow => ({ ...GRANT, scope: `repo:${owner}/*` });
function grants(rows: GrantRow[]) {
  setController({ listGrants: vi.fn(async () => rows), putGrant: vi.fn(async () => rows), deleteGrant: vi.fn() } as unknown as Controller);
}
/** 에이전트마다 다른 grant — 같은 기기의 다른 에이전트 줄(#1265 security n1)을 재려고. 그 에이전트들은 내 것으로 store 에 넣는다. */
function grantsBy(byAgent: Record<string, GrantRow[]>) {
  setController({ listGrants: vi.fn(async (id: string) => byAgent[id] ?? []), putGrant: vi.fn(async () => []), deleteGrant: vi.fn() } as unknown as Controller);
  const accounts = { [ME_ID]: acc(ME_ID, 'owner') } as Record<string, ReturnType<typeof acc>>;
  for (const id of Object.keys(byAgent)) if (id !== 'agent-1') accounts[id] = acc(id, id, 'agent', false, { ownerAccountId: ME_ID });
  useActiveStore.getState().set({ accounts });
}
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  usePrefsStore.getState().setLocale('system');
  cleanup();
});
const sel = (id: string) => screen.findByTestId(`merge-account-${id}`) as Promise<HTMLSelectElement>;

describe('머지 gh 계정 — 줄마다', () => {
  it('처음 열면 옛 기기 값을 지금 줄들에 한 번 옮긴다 — 맨 위 기기 줄은 없고, 절 머리에 기기 이름', async () => {
    grants([GRANT, ORG('acme-org')]);
    const invoke = tauri({ ghUser: 'izagood', byScope: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await sel('izagood_harkroom')).value).toBe('izagood');
    expect((await sel('acme-org__')).value).toBe('izagood');
    expect(invoke).toHaveBeenCalledWith('operator_merge_set', { migrate: ['izagood/harkroom', 'acme-org/*'] });
    expect(screen.getByTestId('merge-gh-user').textContent).toContain('이 기기(mac-1)');
    expect(screen.queryByText('머지에 쓸 GitHub 계정')).toBeNull();
  });

  it('옛 값은 이 기기에 배정된 내 에이전트 전부의 줄로 옮긴다 — 다른 기기 에이전트 줄은 빼고, 닿음 확인은 이 에이전트 줄만(#1265 security n1)', async () => {
    grantsBy({
      'agent-1': [GRANT],
      'agent-2': [{ ...GRANT, accountId: 'agent-2', scope: 'repo:acme-org/ops' }, { ...GRANT, accountId: 'agent-2' }],
      'agent-3': [{ ...GRANT, accountId: 'agent-3', scope: 'repo:acme/api' }],
    });
    const invoke = tauri({ ghUser: 'izagood', byScope: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} deviceAgentIds={['agent-1', 'agent-2']} />);
    expect((await sel('izagood_harkroom')).value).toBe('izagood');
    expect(invoke).toHaveBeenCalledWith('operator_merge_set', { migrate: ['izagood/harkroom', 'acme-org/ops'] });
    expect(invoke.mock.calls.filter(([c]) => c === 'operator_merge_set')).toHaveLength(1);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_merge_check', { scopes: ['izagood/harkroom'] }));
    expect(screen.getByTestId('merge-gh-user-shared').textContent).toBe('같은 범위의 줄은 이 기기의 모든 에이전트가 같은 계정을 쓴다');
  });

  it('같은 기기 다른 에이전트 줄을 모으는 동안에도 「읽는 중」으로 자리를 먼저 잡는다(#1279 designer n1)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setController({ listGrants: vi.fn(async (id: string) => { if (id === 'agent-2') { await gate; return []; } return [GRANT]; }), putGrant: vi.fn(), deleteGrant: vi.fn() } as unknown as Controller);
    useActiveStore.getState().set({ accounts: { [ME_ID]: acc(ME_ID, 'owner'), 'agent-2': acc('agent-2', 'agent-2', 'agent', false, { ownerAccountId: ME_ID }) } });
    const invoke = tauri({ ghUser: 'izagood', byScope: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} deviceAgentIds={['agent-1', 'agent-2']} />);
    expect(await screen.findByTestId('merge-gh-user-loading')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    release();
    expect((await sel('izagood_harkroom')).value).toBe('izagood');
    expect(screen.queryByTestId('merge-gh-user-loading')).toBeNull();
  });

  it('이미 첫 에이전트로만 옮겨진 기기 — 같은 기기 다른 에이전트의 계정 없는 줄도 같은 owner 줄을 이어받는다', async () => {
    grantsBy({ 'agent-1': [GRANT], 'agent-2': [{ ...GRANT, accountId: 'agent-2', scope: 'repo:izagood/infra' }, { ...GRANT, accountId: 'agent-2', scope: 'repo:acme/api' }] });
    const invoke = tauri({ ghUser: null, byScope: { 'izagood/harkroom': 'izagood' }, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} deviceAgentIds={['agent-1', 'agent-2']} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_merge_set', { ghUser: 'izagood', scope: 'izagood/infra' }));
    expect(invoke).not.toHaveBeenCalledWith('operator_merge_set', expect.objectContaining({ scope: 'acme/api' }));
    expect(invoke).not.toHaveBeenCalledWith('operator_merge_set', expect.objectContaining({ migrate: expect.anything() }));
  });

  it('닿지 않음 줄의 확인 시각은 앱 언어로 적는다(#1265 designer n1)', async () => {
    const when = (loc: string) => new Date('2026-10-09T14:30:00Z').toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    for (const loc of ['ko', 'en'] as const) {
      usePrefsStore.getState().setLocale(loc);
      tauri({ ghUser: null, byScope: { 'izagood/harkroom': 'izagood' }, accounts: ACCOUNTS, host: 'mac-1' }, { reach: { 'izagood/harkroom': { izagood: 'no' } } });
      render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
      expect((await screen.findByTestId('merge-account-no-reach-izagood_harkroom')).textContent).toContain(when(loc));
      cleanup();
    }
    expect(when('ko')).not.toBe(when('en'));
  });

  it('닿음(A)·닿지 않음(B)·확인 못 함(E) — 줄의 계정 옆에, 목록은 닿는 계정이 위로·✓/✕ 표시, 고른 값은 그대로', async () => {
    grants([GRANT, ORG('acme-org'), ORG('acme-labs')]);
    const invoke = tauri({ ghUser: 'izagood', byScope: null, accounts: ACCOUNTS, host: 'mac-1' }, { reach: {
      'izagood/harkroom': { izagood: 'ok', 'work-account': 'no' },
      'acme-org/*': { izagood: 'no', 'work-account': 'ok' },
      'acme-labs/*': { izagood: 'unknown', 'work-account': 'unknown' },
    } });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await screen.findByTestId('merge-account-reach-izagood_harkroom')).dataset.reach).toBe('ok');
    const org = await screen.findByTestId('merge-account-reach-acme-org__');
    expect(org.dataset.reach).toBe('no');
    expect(screen.getByTestId('merge-account-no-reach-acme-org__').textContent).toMatch(/izagood 계정은 acme-org/);
    expect((await screen.findByTestId('merge-account-reach-acme-labs__')).dataset.reach).toBe('unknown');
    expect(screen.queryByTestId('merge-account-no-reach-acme-labs__')).toBeNull();
    // 목록: 닿는 work-account 가 위, 표시가 붙되 값은 옮긴 izagood 그대로(미리 바꾸지 않는다)
    const s = await sel('acme-org__');
    expect(s.value).toBe('izagood');
    expect([...s.options].map((o) => o.textContent)).toEqual(['work-account (gh 활성 계정) ✓', 'izagood ✕']);
    expect(invoke).toHaveBeenCalledWith('operator_merge_check', { scopes: ['izagood/harkroom', 'acme-org/*', 'acme-labs/*'] });
  });

  it('닿음 확인이 실패해도 칸은 그대로 쓸 수 있다', async () => {
    const invoke = tauri({ ghUser: 'izagood', byScope: null, accounts: ACCOUNTS, host: 'mac-1' }, { failCheck: true });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await sel('izagood_harkroom')).value).toBe('izagood');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_merge_check', expect.anything()));
    expect(screen.queryByTestId('merge-account-reach-izagood_harkroom')).toBeNull();
    expect((await sel('izagood_harkroom')).disabled).toBe(false);
  });

  it('줄의 계정을 고르면 그 줄 범위와 함께 바로 저장한다(저장 버튼 없음)', async () => {
    grants([GRANT, ORG('acme-org')]);
    const invoke = tauri({ ghUser: null, byScope: { 'izagood/harkroom': 'izagood', 'acme-org/*': 'izagood' }, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.change(await sel('acme-org__'), { target: { value: 'work-account' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_merge_set', { ghUser: 'work-account', scope: 'acme-org/*' }));
    await waitFor(async () => expect((await sel('acme-org__')).value).toBe('work-account'));
    expect((await sel('izagood_harkroom')).value).toBe('izagood');
  });

  it('계정 없는 줄(C)은 미리 골라 두지 않고 경고한다 — 옮길 옛 값도 같은 owner 줄도 없을 때', async () => {
    const invoke = tauri({ ghUser: null, byScope: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await sel('izagood_harkroom')).value).toBe('');
    expect((await screen.findByTestId('merge-account-unset-izagood_harkroom')).textContent).toContain('이 줄로 머지되지 않는다');
    expect(invoke.mock.calls.filter(([, a]) => (a as SetArgs | undefined)?.scope)).toEqual([]);
  });

  it('새 줄은 같은 owner 줄의 계정을 이어받는다 — 다른 owner 줄은 이어받지 않는다', async () => {
    grants([ORG('acme-org'), { ...GRANT, scope: 'repo:acme-org/rcms' }, { ...GRANT, scope: 'repo:acme/api' }]);
    const invoke = tauri({ ghUser: null, byScope: { 'acme-org/*': 'work-account' }, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await sel('acme-org_rcms')).value).toBe('work-account');
    expect((await sel('acme_api')).value).toBe('');
    expect(invoke).toHaveBeenCalledWith('operator_merge_set', { ghUser: 'work-account', scope: 'acme-org/rcms' });
    expect(invoke).not.toHaveBeenCalledWith('operator_merge_set', expect.objectContaining({ scope: 'acme/api' }));
  });

  it('고른 계정이 gh 에서 로그아웃됐으면(D) 그 줄에 알린다', async () => {
    tauri({ ghUser: null, byScope: { 'izagood/harkroom': 'gone' }, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await screen.findByTestId('merge-account-logged-out-izagood_harkroom')).textContent).toContain('gone 계정이 이 기기의 gh 에서 로그아웃됐다');
    expect((await sel('izagood_harkroom')).value).toBe('gone');
  });

  it('오퍼레이터 거절은 사람 말로, 원문이 길면 자른다', async () => {
    tauri({ ghUser: null, byScope: {}, accounts: ACCOUNTS, host: 'mac-1' }, { failSet: 'izagood is not logged in to gh on this machine' });
    const { unmount } = render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.change(await sel('izagood_harkroom'), { target: { value: 'izagood' } });
    const err = (await screen.findByTestId('merge-account-error-izagood_harkroom')).textContent ?? '';
    expect(err).toContain('이제 이 기기의 gh 에 로그인돼 있지 않다');
    expect(err).not.toContain('is not logged in to gh on this machine');
    unmount();
    tauri({ ghUser: null, byScope: {}, accounts: ACCOUNTS, host: 'mac-1' }, { failSet: `boom ${'x'.repeat(300)}` });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    fireEvent.change(await sel('izagood_harkroom'), { target: { value: 'izagood' } });
    expect((await screen.findByTestId('merge-account-error-izagood_harkroom')).textContent!.length).toBeLessThan(260);
  });

  it('gh 를 못 찾으면 절 머리에 사람 말로, 고르기는 막는다. 다른 파일의 ENOENT 는 "gh 없음"으로 바꾸지 않는다(#1146 n1)', async () => {
    tauri({ ghUser: null, byScope: {}, accounts: null, accountsError: 'gh auth status failed: spawn /usr/local/bin/gh ENOENT', host: 'mac-1' });
    const r = render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await screen.findByRole('alert')).textContent).toContain('GitHub CLI 를 설치하고');
    expect((await sel('izagood_harkroom')).disabled).toBe(true);
    r.unmount();
    tauri({ ghUser: null, byScope: {}, accounts: null, accountsError: 'gh auth status failed: open /home/me/.config/gh/hosts.yml: ENOENT', host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect((await screen.findByRole('alert')).textContent).toContain('hosts.yml');
    expect(screen.queryByText(/GitHub CLI 를 설치하고/)).toBeNull();
  });

  it('권한이 하나도 없으면 절이 접히고 오퍼레이터를 묻지 않는다(#1146 designer c)', async () => {
    grants([]);
    const invoke = tauri({ ghUser: null, byScope: null, accounts: ACCOUNTS, host: 'mac-1' });
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    await screen.findByTestId('agent-grants-none');
    expect(screen.queryByTestId('merge-gh-user')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('읽는 동안 자리를 먼저 잡는다(#1140 n5)', async () => {
    let resolve!: (v: unknown) => void;
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(() => new Promise((r) => { resolve = r; })) };
    render(<AgentGrantsSection agent={agent(HERE)} canGrant canRevoke localOperatorId={HERE} />);
    expect(await screen.findByTestId('merge-gh-user-loading')).toBeTruthy();
    resolve({ ghUser: null, byScope: { 'izagood/harkroom': 'izagood' }, accounts: ACCOUNTS, host: 'mac-1' });
    await sel('izagood_harkroom');
    expect(screen.queryByTestId('merge-gh-user-loading')).toBeNull();
  });

  it('다른 기기에 배정된 에이전트(F)면 안내만, 소유자가 아니거나 배정이 없으면 아무것도 — 오퍼레이터를 묻지도 않는다', async () => {
    const invoke = tauri({ ghUser: null, byScope: null, accounts: ACCOUNTS, host: 'mac-1' });
    const { unmount } = render(<AgentGrantsSection agent={agent('op-elsewhere')} canGrant canRevoke localOperatorId={HERE} assignedOperatorName="studio-mini" />);
    expect((await screen.findByTestId('merge-gh-user-other')).textContent).toContain('다른 기기(studio-mini)');
    expect(screen.queryByTestId('merge-account-izagood_harkroom')).toBeNull();
    unmount();
    const r1 = render(<AgentGrantsSection agent={agent('op-elsewhere')} canGrant canRevoke localOperatorId={HERE} />);
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

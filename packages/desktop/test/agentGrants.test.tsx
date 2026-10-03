/**
 * 「할 수 있는 일」 절(에이전트 머지 권한, 스레드 3deac356). 판정은 전부 서버가 한다 — 여기서 재는 것은 목록이
 * 응답을 그대로 앉히는가, 주기/거두기가 컨트롤러 표면(`putGrant`·`deleteGrant`)에 **정확한 scope** 로 닿는가,
 * 소유자가 아니면 [권한 주기] 가 없는가, 거두기는 확인창을 거치는가, 서버 거절이 사람 말로 보이는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView, GrantRow } from '@harkroom/shared';
import { AgentGrantsSection } from '../src/components/settings/AgentGrantsSection';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError } from '../src/lib/api';
import { acc } from './helpers/fakeApi';

const ME_ID = 'owner-1';
const agent = (): AgentView => ({
  ...(acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME_ID }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, claudeLane: null, assignment: null, invokeScope: 'owner', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [],
});
const grant = (scope: string, over: Partial<GrantRow> = {}): GrantRow => ({
  accountId: 'agent-1', capability: 'repo.merge', scope, grantedBy: ME_ID, grantedAt: '2026-10-02T00:00:00Z', expiresAt: null, allowAgentCause: false, ...over,
});

function setup(over: Partial<Record<string, unknown>> = {}) {
  let rows: GrantRow[] = [grant('repo:izagood/harkroom'), { ...grant(''), capability: 'channel.create' }];
  const c = {
    listGrants: vi.fn(async () => rows),
    listConnectors: vi.fn(async () => []),
    putGrant: vi.fn(async (_id: string, body: { scope: string }) => { rows = [...rows, grant(body.scope)]; return rows; }),
    deleteGrant: vi.fn(async (_id: string, _cap: string, scope: string) => { rows = rows.filter((g) => g.scope !== scope); }),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({
    me: acc(ME_ID, 'owner'),
    accounts: { [ME_ID]: acc(ME_ID, 'owner'), 'agent-1': acc('agent-1', 'alpha', 'agent') },
  });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('AgentGrantsSection', () => {
  it('repo.merge grant 만 저장소·준 사람·만료로 그린다 — 다른 capability 는 이 절의 것이 아니다', async () => {
    setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await waitFor(() => expect(screen.getByTestId('agent-grant-izagood/harkroom')).toBeTruthy());
    const row = screen.getByTestId('agent-grant-izagood/harkroom');
    expect(row.textContent).toContain('izagood/harkroom');
    expect(row.textContent).toContain('준 사람: owner');
    expect(row.textContent).toContain('만료 없음');
    expect(screen.queryByText(/channel\.create/)).toBeNull();
  });

  it('내 연결이 모두 이미 권한을 가졌으면 「연결이 없다」가 아니라 그 사실을 말한다(designer a)', async () => {
    const cid = '11111111-1111-4111-8111-111111111111';
    setup({
      listGrants: vi.fn(async () => [grant('repo:izagood/harkroom'), { ...grant(`connector:${cid}`), capability: 'api.call', limits: { methods: ['GET'], pathPrefix: '/' } }]),
      listConnectors: vi.fn(async () => [{ id: cid, name: 'lab-api', ownerAccountId: ME_ID, baseUrl: 'https://api.example.internal', authKind: 'bearer', authHeader: null, secretId: 's1', methods: ['GET'], createdAt: '', updatedAt: '', grantCount: 1 }]),
    });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-api-grant-lab-api');
    fireEvent.click(screen.getByText('+ 권한 주기'));
    expect(screen.getByTestId('api-grant-all-granted').textContent).toContain('이미 권한이 있다');
    expect(screen.queryByTestId('api-grant-no-connector')).toBeNull();
  });

  it('소유자는 저장소 여러 개를 한 번에 준다 — 각각 repo:<owner>/<name> 소문자 scope 로, 만료 7일이면 expiresAt 이 실린다', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    fireEvent.click(screen.getByText('+ 권한 주기'));
    fireEvent.click(screen.getByRole('radio', { name: 'PR 머지' }));
    fireEvent.change(screen.getByLabelText('저장소 (정확한 이름, 한 줄에 하나)'), { target: { value: 'Izagood/Harkroom-Gate\nizagood/homelab, izagood/homelab' } });
    fireEvent.change(screen.getByLabelText('만료'), { target: { value: '7d' } });
    fireEvent.click(screen.getByText('주기'));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledTimes(2));
    const scopes = c.putGrant.mock.calls.map((call) => (call[1] as { scope: string }).scope);
    expect(scopes).toEqual(['repo:izagood/harkroom-gate', 'repo:izagood/homelab']);
    const at = (c.putGrant.mock.calls[0]![1] as unknown as { expiresAt: string | null }).expiresAt;
    expect(at).not.toBeNull();
    expect(Date.parse(at as string) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    await waitFor(() => expect(screen.getByTestId('agent-grant-izagood/homelab')).toBeTruthy());
    // 폼은 닫히고 비워진다.
    expect(screen.queryByTestId('agent-grants-add')).toBeNull();
  });

  it('와일드카드·빈 이름은 보내기 전에 막는다 — 서버 F1 과 같은 문법', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    fireEvent.click(screen.getByText('+ 권한 주기'));
    fireEvent.click(screen.getByRole('radio', { name: 'PR 머지' }));
    fireEvent.change(screen.getByLabelText('저장소 (정확한 이름, 한 줄에 하나)'), { target: { value: 'izagood/*' } });
    expect((screen.getByText('주기') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/와일드카드/).textContent).toContain('izagood/*');
    expect(c.putGrant).not.toHaveBeenCalled();
  });

  it('소유자가 아니면(admin) [권한 주기] 가 없고 거두기만 보인다', async () => {
    setup();
    render(<AgentGrantsSection agent={agent()} canGrant={false} canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    expect(screen.queryByText('+ 권한 주기')).toBeNull();
    expect(screen.getByText(/소유자만 할 수 있다/)).toBeTruthy();
    expect(screen.getByLabelText('izagood/harkroom 머지 권한 거두기')).toBeTruthy();
  });

  it('거두기는 확인창을 거친다 — 취소하면 아무것도 안 보내고, 확인하면 그 scope 로 deleteGrant', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    fireEvent.click(screen.getByLabelText('izagood/harkroom 머지 권한 거두기'));
    expect(screen.getByText('izagood/harkroom 머지 권한을 거둘까?')).toBeTruthy();
    fireEvent.click(screen.getByText('취소'));
    expect(c.deleteGrant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('izagood/harkroom 머지 권한 거두기'));
    fireEvent.click(screen.getAllByText('거두기').at(-1)!);
    await waitFor(() => expect(c.deleteGrant).toHaveBeenCalledWith('agent-1', 'repo.merge', 'repo:izagood/harkroom'));
    await waitFor(() => expect(screen.getByTestId('agent-grants-none')).toBeTruthy());
  });

  it('서버의 거절(403 — 소유자 아님)은 사람 말로 보인다', async () => {
    setup({ putGrant: vi.fn(async () => { throw new ApiError(403, 'forbidden', 'repo.merge 는 그 에이전트의 소유자만 준다'); }) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    fireEvent.click(screen.getByText('+ 권한 주기'));
    fireEvent.click(screen.getByRole('radio', { name: 'PR 머지' }));
    fireEvent.change(screen.getByLabelText('저장소 (정확한 이름, 한 줄에 하나)'), { target: { value: 'izagood/x' } });
    fireEvent.click(screen.getByText('주기'));
    await waitFor(() => expect(screen.getByTestId('agent-grants-error').textContent).toContain('소유자(사람)만'));
  });

  it('목록을 못 읽으면 "없음"이 아니라 실패를 말한다', async () => {
    setup({ listGrants: vi.fn(async () => { throw new Error('boom'); }) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('읽지 못했다'));
    expect(screen.queryByTestId('agent-grants-none')).toBeNull();
  });
});

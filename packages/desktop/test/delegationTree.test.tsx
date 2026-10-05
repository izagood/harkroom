/**
 * 위임 나무(외부 API P5 desktop). 판정은 서버다 — 여기서 재는 것: 줄들이 parentGrantId 로 엮이는가 · 막힌 아래 줄이 흐린가 ·
 * 「허락 기다림 N」이 루트 사람에게만 서고 [허락]·[거절]이 grant id 로만 가는가 · [이 아래 전부 거두기]가 자기 줄은 남기고
 * 바로 아래 줄들만 지우는가(아래는 서버 cascade).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AgentView, GrantRow } from '@harkroom/shared';
import { AgentGrantsSection } from '../src/components/settings/AgentGrantsSection';
import { blockedReason, buildForest, decidableBy, descendantCount, pendingForRoot, PENDING_APPROVAL } from '../src/lib/delegationForest';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

const ME = 'owner-1';
const CONN = '11111111-1111-4111-8111-111111111111';
const g = (id: string, accountId: string, over: Partial<GrantRow> = {}): GrantRow => ({
  id, accountId, capability: 'api.call', scope: `connector:${CONN}`, grantedBy: ME, grantedAt: `2026-10-0${id.length % 9}T00:00:00Z`,
  expiresAt: null, parentGrantId: null, delegateDepth: 0, limits: { methods: ['GET'], pathPrefix: '/api/' }, suspendedAt: null, suspendReason: null, ...over,
});
// 사람 → A(단계 2) → B(단계 1) → C(0), A → D(대기)
const rows = (): GrantRow[] => [
  g('ra', 'agent-a', { delegateDepth: 2 }),
  g('rb', 'agent-b', { parentGrantId: 'ra', grantedBy: 'agent-a', delegateDepth: 1, limits: { methods: ['GET'], pathPrefix: '/api/x/' }, expiresAt: '2099-01-01T00:00:00Z' }),
  g('rc', 'agent-c', { parentGrantId: 'rb', grantedBy: 'agent-b', delegateDepth: 0, expiresAt: '2099-01-01T00:00:00Z' }),
  g('rd', 'agent-d', { parentGrantId: 'ra', grantedBy: 'agent-a', suspendedAt: '2026-10-05T00:00:00Z', suspendReason: PENDING_APPROVAL, expiresAt: '2099-01-01T00:00:00Z' }),
];

describe('delegationForest', () => {
  it('parentGrantId 로 엮고, 아래 줄 수를 센다', () => {
    const f = buildForest(rows());
    expect(f.get('ra')!.children.map((c) => c.grant.id).sort()).toEqual(['rb', 'rd']);
    expect(descendantCount(f.get('ra')!)).toBe(3);
    expect(f.get('rc')!.parent!.grant.id).toBe('rb');
  });

  it('막힘: 대기 줄은 pending, 위가 만료·정지·대기거나 단계가 모자라거나 부모를 못 찾으면 chain', () => {
    expect(blockedReason(buildForest(rows()).get('rc')!)).toBeNull();
    expect(blockedReason(buildForest(rows()).get('rd')!)).toBe('pending');
    const expired = rows().map((r) => (r.id === 'rb' ? { ...r, expiresAt: '2000-01-01T00:00:00Z' } : r));
    expect(blockedReason(buildForest(expired).get('rc')!)).toBe('chain');
    // 사람이 A 를 단계 0 으로 다시 주면(루트로 덮음) 아래는 막힌다(security #1157 판정)
    const narrowed = rows().map((r) => (r.id === 'ra' ? { ...r, delegateDepth: 0 } : r));
    expect(blockedReason(buildForest(narrowed).get('rb')!)).toBe('chain');
    expect(blockedReason(buildForest(rows().filter((r) => r.id !== 'rb')).get('rc')!)).toBe('chain');
  });

  it('허락 기다림은 루트 사람의 것만', () => {
    const f = buildForest(rows());
    expect(pendingForRoot(f, ME).map((n) => n.grant.id)).toEqual(['rd']);
    expect(pendingForRoot(f, 'someone-else')).toEqual([]);
    expect(decidableBy(f.get('rd')!, 'someone-else')).toBe(false);
  });
});

const agent = (id: string): AgentView => ({
  ...(acc(id, id.replace('agent-', ''), 'agent', false, { ownerAccountId: ME }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, claudeLane: null, assignment: null, invokeScope: 'owner', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [],
});

function setup() {
  let all = rows();
  const c = {
    listGrants: vi.fn(async (id: string) => all.filter((r) => r.accountId === id)),
    listConnectors: vi.fn(async () => [{ id: CONN, name: 'lab-api', ownerAccountId: ME, baseUrl: 'https://api.example.internal', authKind: 'bearer', authHeader: null, secretId: 's1', methods: ['GET'], createdAt: '', updatedAt: '', grantCount: 1 }]),
    deleteGrant: vi.fn(async (id: string, _cap: string, _scope: string) => { all = all.filter((r) => r.accountId !== id); }),
    approveDelegation: vi.fn(async () => undefined),
    declineDelegation: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  const agents = Object.fromEntries(['agent-a', 'agent-b', 'agent-c', 'agent-d'].map((id) => [id, acc(id, id.replace('agent-', ''), 'agent', false, { ownerAccountId: ME })]));
  useActiveStore.getState().set({ me: acc(ME, 'owner'), accounts: { [ME]: acc(ME, 'owner'), ...agents } });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('AgentGrantsSection — 위임 나무', () => {
  it('루트 줄 아래로 다시 준 줄을 들여 그리고, 대기 줄은 흐리게 「허락 대기」', async () => {
    setup();
    render(<AgentGrantsSection agent={agent('agent-a')} canGrant canRevoke />);
    await waitFor(() => expect(screen.getByTestId('delegation-children-ra')).toBeTruthy());
    expect(screen.getByTestId('delegation-row-rb').textContent).toContain('@b');
    expect(screen.getByTestId('delegation-row-rc').textContent).toContain('@c');
    expect(screen.getByTestId('delegation-row-rd').getAttribute('data-blocked')).toBe('pending');
  });

  it('「허락 기다림 N」에서 [허락]은 grant id 로만 간다', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent('agent-a')} canGrant canRevoke />);
    const strip = await screen.findByTestId('delegation-pending');
    expect(strip.textContent).toContain('허락 기다림 1');
    expect(strip.textContent).toContain('@a → @d');
    fireEvent.click(within(strip).getByTestId('delegation-approve-rd'));
    await waitFor(() => expect(c.approveDelegation).toHaveBeenCalledWith('rd'));
  });

  it('[이 아래 전부 거두기]는 확인창에 아래 줄 수를 적고, 자기 줄은 남기고 바로 아래 줄들만 지운다', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent('agent-a')} canGrant canRevoke />);
    fireEvent.click(await screen.findByTestId('delegation-revoke-below-ra'));
    expect(screen.getByText('이 아래 3줄을 거둘까?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '거두기' }));
    await waitFor(() => expect(c.deleteGrant).toHaveBeenCalledTimes(2));
    expect(c.deleteGrant.mock.calls.map((x) => x[0]).sort()).toEqual(['agent-b', 'agent-d']);
    expect(c.deleteGrant.mock.calls.every((x) => x[1] === 'api.call' && x[2] === `connector:${CONN}`)).toBe(true);
  });

  it('API 행 [바꾸기]: 같은 폼을 지금 grant 로 연다 — 거두지 않고 PUT 한 번', async () => {
    const c = setup();
    (c as unknown as { putGrant: unknown }).putGrant = vi.fn(async () => []);
    render(<AgentGrantsSection agent={agent('agent-a')} canGrant canRevoke />);
    fireEvent.click(await screen.findByTestId('api-grant-change-lab-api'));
    const form = await screen.findByTestId('api-grant-form');
    expect(form.textContent).toContain('지금:');
    fireEvent.click(within(form).getByRole('button', { name: '바꾸기' }));
    await waitFor(() => expect((c as unknown as { putGrant: ReturnType<typeof vi.fn> }).putGrant).toHaveBeenCalledTimes(1));
    expect(c.deleteGrant).not.toHaveBeenCalled();
  });

  it('받은 줄에는 「받은 곳」을 적는다', async () => {
    setup();
    render(<AgentGrantsSection agent={agent('agent-b')} canGrant canRevoke />);
    await waitFor(() => expect(screen.getByTestId('delegation-from-rb').textContent).toContain('@a'));
  });

  it('소유자가 아니면 나무를 엮지 않고 허락 줄도 없다', async () => {
    setup();
    render(<AgentGrantsSection agent={agent('agent-a')} canGrant={false} canRevoke={false} />);
    await waitFor(() => expect(screen.getByTestId('agent-api-grants')).toBeTruthy());
    expect(screen.queryByTestId('delegation-pending')).toBeNull();
    expect(screen.queryByTestId('delegation-revoke-below-ra')).toBeNull();
  });
});

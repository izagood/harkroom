/**
 * 「머지·API 권한」 절(옛 「할 수 있는 일」, 에이전트 머지 권한, 스레드 3deac356 · febe9ff8 P1). 판정은 전부 서버가 한다 — 여기서 재는 것은 목록이
 * 응답을 그대로 앉히는가, 주기/거두기가 컨트롤러 표면(`putGrant`·`deleteGrant`)에 **정확한 scope** 로 닿는가,
 * 소유자가 아니면 [권한 주기] 가 없는가, 거두기는 확인창을 거치는가, 서버 거절이 사람 말로 보이는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
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
    fireEvent.change(screen.getByLabelText('저장소 (정확한 이름 또는 조직 전체 owner/*, 한 줄에 하나)'), { target: { value: 'Izagood/Harkroom-Gate\nizagood/homelab, izagood/homelab' } });
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

  it('* 하나·*/*·부분 패턴은 보내기 전에 막는다 — 서버 F1 과 같은 문법(repoGrantScope)', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    fireEvent.click(screen.getByText('+ 권한 주기'));
    fireEvent.click(screen.getByRole('radio', { name: 'PR 머지' }));
    for (const bad of ['*', '*/*', 'izagood/hark*', '*/harkroom']) {
      fireEvent.change(screen.getByLabelText('저장소 (정확한 이름 또는 조직 전체 owner/*, 한 줄에 하나)'), { target: { value: bad } });
      expect((screen.getByText('주기') as HTMLButtonElement).disabled, bad).toBe(true);
      expect(screen.getByText(/owner\/ab\* 는 안 됨/).textContent, bad).toContain(bad);
    }
    expect(c.putGrant).not.toHaveBeenCalled();
  });

  it('조직 전체 owner/* 는 경고를 보이고 repo:<owner>/* 로 준다 — 목록·거두기 확인창은 「조직 전체」라고 말한다', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    fireEvent.click(screen.getByText('+ 권한 주기'));
    fireEvent.click(screen.getByRole('radio', { name: 'PR 머지' }));
    expect(screen.queryByTestId('agent-grants-org-warning')).toBeNull();
    fireEvent.change(screen.getByLabelText('저장소 (정확한 이름 또는 조직 전체 owner/*, 한 줄에 하나)'), { target: { value: 'Rebellions-SW/*' } });
    expect(screen.getByTestId('agent-grants-org-warning').textContent).toContain('rebellions-sw 조직의 모든 저장소');
    expect((screen.getByText('주기') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('주기'));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledWith('agent-1', { capability: 'repo.merge', scope: 'repo:rebellions-sw/*', expiresAt: null }));
    const row = await screen.findByTestId('agent-grant-rebellions-sw/*');
    expect(row.textContent).toContain('rebellions-sw/*');
    expect(within(row).getByTestId('agent-grant-org-rebellions-sw').textContent).toBe('조직 전체');
    // 정확한 이름 줄에는 배지가 없다.
    expect(within(screen.getByTestId('agent-grant-izagood/harkroom')).queryByTestId(/agent-grant-org-/)).toBeNull();
    fireEvent.click(screen.getByLabelText('rebellions-sw 조직 전체 머지 권한 거두기'));
    expect(screen.getByText('rebellions-sw 조직 전체 머지 권한을 거둘까?')).toBeTruthy();
    // designer n1: 조직 grant 를 거둬도 따로 준 저장소 권한은 남는다 — 「조직 전체 머지가 막힌다」고 세게 말하지 않는다.
    expect(screen.getByText('다음 턴부터 @alpha 의 rebellions-sw 조직 전체 권한이 빠진다. 따로 준 저장소 권한은 남는다.')).toBeTruthy();
    fireEvent.click(screen.getAllByText('거두기').at(-1)!);
    await waitFor(() => expect(c.deleteGrant).toHaveBeenCalledWith('agent-1', 'repo.merge', 'repo:rebellions-sw/*'));
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
    // 지난 nit n1 — 변수 뒤에 받침 따라 바뀌는 조사를 붙이지 않는다
    expect(screen.getByText('다음 턴부터 @alpha 의 izagood/harkroom 머지가 막힌다.')).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('저장소 (정확한 이름 또는 조직 전체 owner/*, 한 줄에 하나)'), { target: { value: 'izagood/x' } });
    fireEvent.click(screen.getByText('주기'));
    await waitFor(() => expect(screen.getByTestId('agent-grants-error').textContent).toContain('소유자(사람)만'));
  });

  it('P1: 절 이름은 「머지·API 권한」, 비어 있으면 설명 없이 한 줄로 접히고 [+ 권한 주기]로 펼친다', async () => {
    setup({ listGrants: vi.fn(async () => []) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    const none = await screen.findByTestId('agent-grants-none');
    expect(none.textContent).toContain('준 권한 없음');
    const box = screen.getByTestId('agent-grants');
    expect(box.textContent).toContain('머지·API 권한');
    expect(box.textContent).not.toContain('부여가 곧 승인');  // 설명 문단은 접힌다
    fireEvent.click(screen.getByText('+ 권한 주기'));
    // 펼치면 종류 고르기(#1144: API 가 기본)가 서고, PR 머지를 고르면 저장소 칸이 열린다
    fireEvent.click(screen.getByRole('radio', { name: 'PR 머지' }));
    expect(screen.getByTestId('agent-grants-add')).toBeTruthy();
    expect(screen.getByTestId('agent-grants').textContent).toContain('부여가 곧 승인');
  });

  // 비밀 만들기(서버 102): capability secret.create · scope '' 하나. 기본 꺼짐, 소유자만 준다(서버 판정).
  it('비밀 만들기: 소유자는 [+ 권한 주기] › 비밀 만들기 › [허용] 으로 secret.create 를 scope "" 로 준다', async () => {
    const c = setup({ listGrants: vi.fn(async () => []) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId('agent-grants-none');
    fireEvent.click(screen.getByText('+ 권한 주기'));
    fireEvent.click(screen.getByRole('radio', { name: '비밀 만들기' }));
    expect(screen.getByTestId('agent-secret-create-add').textContent).toContain('알림 줄이 남고');
    expect(screen.getByTestId('agent-secret-create-add').textContent).not.toContain('알림을 받는다');
    fireEvent.click(screen.getByRole('button', { name: '허용' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledWith('agent-1', { capability: 'secret.create', scope: '', expiresAt: null }));
  });

  it('비밀 만들기: 준 줄이 있으면 절이 펼쳐 그 줄을 그리고, 거두기는 확인창을 거쳐 secret.create·"" 로 지운다', async () => {
    const c = setup({ listGrants: vi.fn(async () => [{ ...grant(''), capability: 'secret.create' }]) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    const row = await screen.findByTestId('agent-secret-create-grant');
    // 줄 첫 칸은 상태다(designer n1) — 소제목이 이미 「비밀 만들기」다.
    expect(row.textContent).toContain('허용됨');
    expect(row.textContent).not.toContain('비밀 만들기');
    expect(row.textContent).toContain('준 사람: owner');
    expect(row.textContent).toContain('만료 없음');
    fireEvent.click(within(row).getByRole('button', { name: '거두기' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('@alpha 의 비밀 만들기를 거둘까?');
    fireEvent.click(within(dialog).getByRole('button', { name: '거두기' }));
    await waitFor(() => expect(c.deleteGrant).toHaveBeenCalledWith('agent-1', 'secret.create', ''));
  });

  it('P1: 만료된 줄은 한 단 낮추고 [다시 7일]로 같은 scope 를 7일 다시 준다 — 소유자에게만', async () => {
    const before = Date.now();
    const c = setup({ listGrants: vi.fn(async () => [grant('repo:izagood/harkroom-gate', { expiresAt: '2026-01-01T00:00:00Z', allowAgentCause: true }), grant('repo:izagood/harkroom')]) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    const row = await screen.findByTestId('agent-grant-izagood/harkroom-gate');
    expect(row.getAttribute('data-expired')).toBe('true');
    expect(row.className).toContain('text-fg-subtle');
    expect(screen.getByTestId('agent-grant-izagood/harkroom').getAttribute('data-expired')).toBeNull();
    // 살아 있는 줄에는 [다시 7일]이 없다
    expect(screen.queryByLabelText('izagood/harkroom 머지 권한을 7일 다시 주기')).toBeNull();
    fireEvent.click(screen.getByLabelText('izagood/harkroom-gate 머지 권한을 7일 다시 주기'));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledTimes(1));
    const [id, body] = c.putGrant.mock.calls[0]! as unknown as [string, { capability: string; scope: string; expiresAt: string; allowAgentCause?: boolean }];
    expect(id).toBe('agent-1');
    expect(body.capability).toBe('repo.merge');
    expect(body.scope).toBe('repo:izagood/harkroom-gate');
    expect(body.allowAgentCause).toBe(true);  // 있던 플래그를 떨어뜨리지 않는다
    const days = (Date.parse(body.expiresAt) - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
  });

  it('P1: 소유자가 아니면(admin) 만료된 줄에도 [다시 7일]이 없다', async () => {
    setup({ listGrants: vi.fn(async () => [grant('repo:izagood/harkroom-gate', { expiresAt: '2026-01-01T00:00:00Z' })]) });
    render(<AgentGrantsSection agent={agent()} canGrant={false} canRevoke />);
    await screen.findByTestId('agent-grant-izagood/harkroom-gate');
    expect(screen.queryByText('다시 7일')).toBeNull();
  });

  it('P1: 제목은 이웃 FieldGroup 과 같은 h3 이고 테두리 상자가 없다(#1146 designer 수정 1). 읽는 동안도 접힌 모양이다', async () => {
    let resolve!: (v: GrantRow[]) => void;
    setup({ listGrants: vi.fn(() => new Promise<GrantRow[]>((r) => { resolve = r; })) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    expect(screen.getByRole('heading', { level: 3, name: /^머지·API 권한/ })).toBeTruthy();
    expect(screen.getByTestId('agent-grants-loading')).toBeTruthy();
    expect(screen.getByTestId('agent-grants').className).not.toContain('border');
    expect(screen.getByTestId('agent-grants').textContent).not.toContain('부여가 곧 승인');
    resolve([grant('repo:izagood/harkroom')]);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    expect(screen.getByRole('heading', { level: 3, name: /^머지·API 권한/ })).toBeTruthy();
    expect(screen.getByTestId('agent-grants').className).not.toContain('border');
  });

  it('P1: API 호출 권한만 있어도 접지 않는다 — 그 줄들이 이 절에 산다(#1144)', async () => {
    const cid = '11111111-1111-4111-8111-111111111111';
    setup({ listGrants: vi.fn(async () => [{ ...grant(`connector:${cid}`), capability: 'api.call', limits: { methods: ['GET'], pathPrefix: '/' } }]) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    expect(await screen.findByTestId('agent-api-grants')).toBeTruthy();
    expect(screen.getByTestId('agent-grants').textContent).toContain('부여가 곧 승인');
  });

  it('P1: 소유자가 아니면(admin) 수를 알리지 않는다 — 남의 에이전트 배지가 목록에 끼지 않게(#1146 security n2)', async () => {
    const onCount = vi.fn();
    setup();
    render(<AgentGrantsSection agent={agent()} canGrant={false} canRevoke onCountChange={onCount} />);
    await screen.findByTestId('agent-grant-izagood/harkroom');
    expect(onCount).not.toHaveBeenCalled();
  });

  it('#1255 designer n3: 조직 grant 는 따로 센다 — 만료된 것은 안 센다', async () => {
    const onCount = vi.fn();
    setup({ listGrants: vi.fn(async () => [grant('repo:a/b'), grant('repo:a/*'), grant('repo:c/*', { expiresAt: '2026-01-01T00:00:00Z' })]) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke onCountChange={onCount} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith({ repos: 1, orgs: 1 }));
  });

  it('#1255 security n2: 정확한 이름 줄이 꺼져 있어도 같은 조직 grant 가 에이전트 턴을 허락하면 그 사실을 그 줄에 적는다', async () => {
    setup({ listGrants: vi.fn(async () => [
      grant('repo:rebellions-sw/npu'), grant('repo:rebellions-sw/*', { allowAgentCause: true }),
      grant('repo:rebellions-sw-evil/x'), grant('repo:izagood/harkroom'),
    ]) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    const note = await screen.findByTestId('agent-grant-cause-via-org-rebellions-sw/npu');
    expect(note.textContent).toContain('rebellions-sw 조직 전체 권한으로 에이전트가 띄운 턴에서도(겹치면 넓은 쪽)');
    // 앞부분만 같은 다른 owner·다른 owner 에는 붙지 않는다.
    expect(screen.queryByTestId('agent-grant-cause-via-org-rebellions-sw-evil/x')).toBeNull();
    expect(screen.queryByTestId('agent-grant-cause-via-org-izagood/harkroom')).toBeNull();
  });

  it('P1: 읽을 때마다 살아 있는 권한 수를 알린다(목록 카드 「머지 N」)', async () => {
    const onCount = vi.fn();
    setup({ listGrants: vi.fn(async () => [grant('repo:a/b'), grant('repo:a/c', { expiresAt: '2026-01-01T00:00:00Z' }), { ...grant(''), capability: 'channel.create' }]) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke onCountChange={onCount} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith({ repos: 1, orgs: 0 }));
  });

  it('목록을 못 읽으면 "없음"이 아니라 실패를 말한다', async () => {
    setup({ listGrants: vi.fn(async () => { throw new Error('boom'); }) });
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('읽지 못했다'));
    expect(screen.queryByTestId('agent-grants-none')).toBeNull();
  });
});

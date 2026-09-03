import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentView, PatView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

/**
 * 소유자에게 연 서버 권한을 화면에서도 연다(#299).
 *
 * `#253` 이 정한 필드별 권한 표가 정본이다: PAT·메모리·설정(instructions·harness·model·
 * effort·workingDir)은 **소유자 또는 admin**, `ownerAccountId`·`disabled`·
 * `mentionPermission` 은 **admin 만**. 화면이 그 표를 그대로 반영하는지 본다.
 *
 * admin 전용 필드는 **비활성 입력이 아니라 부재**다 — 눌러도 안 되는 것을 보여 주면
 * 사람은 자기가 뭘 잘못했다고 생각한다.
 */
const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

const MINE = agent('mybot', { ownerAccountId: 'u2' });

const fakeController = (overrides: Record<string, unknown> = {}) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => [MINE]),
    listPats: vi.fn(async (): Promise<PatView[]> => (
      [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]
    )),
    agentMemory: vi.fn(async () => [{ slug: 'note', value: '기억 한 줄', updatedAt: '2026-01-01' }]),
    deleteAgentMemory: vi.fn(async (): Promise<void> => undefined),
    updateAgent: vi.fn(async (_id: string, _patch: Partial<AgentConfig>) => MINE),
    revokePat: vi.fn(async () => ({ revoked: 1 })),
    mintPat: vi.fn(async () => 'murp_new'),
    // admin 전용 라우트다 — 소유자에게는 403 이 나는 것이 정상이고, 화면은 그것을
    // 오류로 그리지 않아야 한다.
    agentDefaults: vi.fn(async () => { throw new Error('forbidden'); }),
    ...overrides,
  };
  setController(c as unknown as Controller);
  return c;
};

/** 소유자(admin 아님)로 로그인해 자기 에이전트를 연다. */
const openAsOwner = async (overrides: Record<string, unknown> = {}) => {
  useAppStore.getState().set({
    me: acc('u2', 'owner', 'human', false),
    accounts: { u2: acc('u2', 'owner', 'human', false) },
  });
  const c = fakeController(overrides);
  render(<AgentsSettings />);
  await screen.findByText('mybot');
  fireEvent.click(screen.getByText('mybot'));
  await screen.findByLabelText('Working directory');
  return c;
};

beforeEach(() => useAppStore.getState().reset());
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('소유자의 에이전트 설정 화면 (#299)', () => {
  it('5. 소유자 화면에 PAT·메모리 패널이 보이고 내용이 실제로 채워진다', async () => {
    const c = await openAsOwner();

    // 절이 그려지는 것만으로는 모자란다 — 그리기만 하고 조회가 안 나가면 영영 비어 있다.
    // (실측 결함: 소유자 판정을 `useState` 에 담고 같은 `pick` 안에서 읽어, 첫 선택에서
    //  두 조회가 모두 갱신 전 값을 보고 그냥 돌아왔다.)
    expect(screen.getByText('PAT (Personal Access Token)')).toBeTruthy();
    expect(screen.getByText('기억 (memory)')).toBeTruthy();
    await waitFor(() => expect(c.listPats).toHaveBeenCalledWith('id-mybot'));
    await waitFor(() => expect(c.agentMemory).toHaveBeenCalledWith('id-mybot'));
    await screen.findByText('기억 한 줄');
    await screen.findByText('runner');
  });

  it('5b. 러너 실행 명령도 소유자에게 보인다(#177) — PAT 가 열렸으니 명령도 열린다', async () => {
    await openAsOwner();
    expect(screen.getByText('러너 실행')).toBeTruthy();
  });

  it('6. admin 전용 컨트롤은 소유자 화면에 **없다**(비활성이 아니라 부재)', async () => {
    await openAsOwner();

    // 소유자 지정 select, 비활성화 버튼, 멘션 권한 select — 셋 다 부재여야 한다.
    expect(screen.queryByLabelText('Owner')).toBeNull();
    expect(screen.queryByLabelText('Mention permission')).toBeNull();
    expect(screen.queryByLabelText('에이전트 비활성화')).toBeNull();
    expect(screen.queryByLabelText('에이전트 활성화')).toBeNull();

    // 값 자체는 읽기 전용으로 보인다 — 숨겨 버리면 소유자는 자기 에이전트가 읽기 전용인지도
    // 모른 채 부른다.
    expect(screen.getByText(/Mention permission: auto/)).toBeTruthy();
  });

  it('6b. 소유자에게 열린 필드는 그대로 있다 — 지시문·harness·model·workingDir', async () => {
    await openAsOwner();
    expect(screen.getByLabelText('Working directory')).toBeTruthy();
    expect(screen.getByLabelText('Agent harness')).toBeTruthy();
  });

  /**
   * 저장이 실제로 통하는가. 서버는 admin 전용 키의 **존재**만으로 403 을 주고 아무것도
   * 저장하지 않는다(`accountRoutes.ts` 의 `ADMIN_ONLY_FIELDS`). 그래서 이 두 키를 늘
   * 싣던 동안 소유자의 저장 버튼은 무엇을 고치든 반드시 실패했다 — 화면은 "저장하지
   * 못했다" 만 띄웠다. 키의 부재를 단언한다.
   */
  it('소유자의 저장 본문에 admin 전용 키가 실리지 않는다', async () => {
    const c = await openAsOwner();

    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    const patch = (c.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.workingDir).toBe('/tmp/x');
    expect(Object.keys(patch)).not.toContain('mentionPermission');
    expect(Object.keys(patch)).not.toContain('ownerAccountId');
    // 저장 실패 안내가 뜨지 않아야 한다.
    expect(screen.queryByText('저장하지 못했다')).toBeNull();
  });

  it('admin 의 저장 본문에는 admin 전용 키가 그대로 실린다', async () => {
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true) },
    });
    const c = fakeController({ agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })) });
    render(<AgentsSettings />);
    await screen.findByText('mybot');
    fireEvent.click(screen.getByText('mybot'));
    await screen.findByLabelText('Mention permission');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    const patch = (c.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(patch)).toContain('mentionPermission');
    expect(Object.keys(patch)).toContain('ownerAccountId');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentConfig, AgentView, PatView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
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
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false, role: 'member', assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [],
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, deleted: false, runnerVersion: null,
  claudeLane: null,
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
  await screen.findByTestId('agent-card-mybot');
  fireEvent.click(screen.getByTestId('agent-card-mybot'));
  await screen.findByLabelText('Working directory');
  return c;
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(사이드바 PR 이 세운
// 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면 한국어라고
// 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => { useAppStore.getState().reset(); usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); setController(null as unknown as Controller); usePrefsStore.getState().setLocale('system'); });

describe('소유자의 에이전트 설정 화면 (#299)', () => {
  it('5. 소유자 화면에 PAT·메모리 패널이 보이고 내용이 실제로 채워진다', async () => {
    const c = await openAsOwner();

    // 절이 그려지는 것만으로는 모자란다 — 그리기만 하고 조회가 안 나가면 영영 비어 있다.
    // (실측 결함: 소유자 판정을 `useState` 에 담고 같은 `pick` 안에서 읽어, 첫 선택에서
    //  두 조회가 모두 갱신 전 값을 보고 그냥 돌아왔다.)
    expect(screen.getByText('기억 (memory)')).toBeTruthy();
    await waitFor(() => expect(c.listPats).toHaveBeenCalledWith('id-mybot'));
    await waitFor(() => expect(c.agentMemory).toHaveBeenCalledWith('id-mybot'));
    await screen.findByText('기억 한 줄');
    await screen.findByText('runner');
    // 옛 러너 토큰 칸은 살아 있는 토큰이 있을 때만 선다 — 이 픽스처에는 'runner' 가 살아 있다.
    expect(screen.getByTestId('legacy-pats')).toBeTruthy();
  });

  it('5b. 배정도 소유자에게 열린다(스펙 2026-09-20 §3) — 자기 에이전트를 어디서 돌릴지는 소유자가 정한다', async () => {
    await openAsOwner();
    expect(screen.getByText('어디서 돌리나')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    const patch = (c.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.workingDir).toBe('/tmp/x');
    expect(Object.keys(patch)).not.toContain('mentionPermission');
    expect(Object.keys(patch)).not.toContain('ownerAccountId');
    // 저장 실패 안내가 뜨지 않아야 한다.
    expect(screen.queryByText('저장하지 못했다')).toBeNull();
  });

  it('087: "다른 에이전트가 고를 수 있는 모델" 은 소유자에게만 선다 — admin 이어도 소유자가 아니면 없다', async () => {
    const options = vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null, pickable: [{ model: 'opus', efforts: [] }] }));
    await openAsOwner({ agentModelOptions: options });
    expect(await screen.findByTestId('pickable-row-opus')).toBeTruthy();
    // 목록의 저장은 상세의 저장 바로 모였다(A3) — 제 [목록 저장]이 없고, 고치기 전에는 바도 없다.
    expect(screen.queryByTestId('pickable-save')).toBeNull();
    expect(screen.queryByTestId('agent-save-bar')).toBeNull();
    cleanup();

    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true) },
    });
    fakeController({ agentModelOptions: options, agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })) });
    render(<AgentsSettings />);
    await screen.findByTestId('agent-card-mybot');
    fireEvent.click(screen.getByTestId('agent-card-mybot'));
    await screen.findByLabelText('Mention permission');
    expect(screen.queryByTestId('agent-pickable')).toBeNull();
  });

  it('모델 목록도 저장 바로 모인다(A3) — effort 를 켜면 바가 서고 [저장]이 목록을 보낸다', async () => {
    const options = vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null, pickable: [{ model: 'opus', efforts: [] }] }));
    const setPickable = vi.fn(async (_id: string, models: unknown) => ({ models, outside: 0 }));
    await openAsOwner({ agentModelOptions: options, setAgentPickableModels: setPickable });
    await screen.findByTestId('pickable-row-opus');
    expect(screen.queryByTestId('agent-save-bar')).toBeNull();

    fireEvent.click(screen.getByLabelText('opus 에 effort high 허용'));
    expect(screen.getByTestId('agent-save-count').textContent).toBe('1개 바뀜');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(setPickable).toHaveBeenCalledWith('id-mybot', [{ model: 'opus', efforts: ['high'] }], false));
    await waitFor(() => expect(screen.queryByTestId('agent-save-bar')).toBeNull());
  });

  it('admin 의 저장 본문에는 admin 전용 키가 그대로 실린다', async () => {
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true) },
    });
    const c = fakeController({ agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })) });
    render(<AgentsSettings />);
    await screen.findByTestId('agent-card-mybot');
    fireEvent.click(screen.getByTestId('agent-card-mybot'));
    await screen.findByLabelText('Mention permission');

    // 저장 바는 바뀐 것이 있을 때만 선다(A3) — 무엇이든 하나 고친다.
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/tmp/y' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(c.updateAgent).toHaveBeenCalled());
    const patch = (c.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(patch)).toContain('mentionPermission');
    expect(Object.keys(patch)).toContain('ownerAccountId');
  });
});

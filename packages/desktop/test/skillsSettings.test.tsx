import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { WorkspaceSkillView } from '@murmur/shared';
import { skillGroupOf } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { SkillsSettings, APPROVE_CONFIRM_TEXT } from '../src/components/settings/SkillsSettings';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

/**
 * 워크스페이스 스킬 승인 화면(#311).
 *
 * 무엇을 지키는가: 승인은 그 본문이 **모든 에이전트의 시스템 프롬프트**에 들어가는 일이다.
 * 그래서 이 회귀선이 지키는 것은 배치가 아니라 세 가지다 — (1) 승인 권한이 없는 사람에게는
 * 컨트롤이 **아예 없고**, (2) 확인을 거치기 전에는 요청이 **나가지 않으며**, (3) 본문은
 * 해석되지 않고 **실제 바이트 그대로** 보인다. 셋 중 하나라도 새면 승인 게이트가 있는
 * 것과 없는 것이 같아진다.
 */

const skill = (slug: string, extra: Partial<WorkspaceSkillView> = {}): WorkspaceSkillView => ({
  slug,
  body: `${slug} 본문`,
  proposedBy: 'a1',
  proposedAt: '2026-09-01T00:00:00.000Z',
  approvedBy: null,
  approvedAt: null,
  disabledAt: null,
  ...extra,
});

const PENDING = skill('pending-one');
const APPROVED = skill('approved-one', { approvedBy: 'u1', approvedAt: '2026-09-02T00:00:00.000Z' });
const DISABLED = skill('disabled-one', { disabledAt: '2026-09-03T00:00:00.000Z' });

const fakeController = (overrides: Record<string, unknown> = {}) => {
  const c = {
    listSkills: vi.fn(async (): Promise<WorkspaceSkillView[]> => [PENDING, APPROVED, DISABLED]),
    approveSkill: vi.fn(async (slug: string) => skill(slug, { approvedAt: 'now' })),
    disableSkill: vi.fn(async (slug: string) => skill(slug, { disabledAt: 'now' })),
    ...overrides,
  };
  setController(c as unknown as ControllerType);
  return c;
};

/** admin 인가 아닌가만 다르다 — 그 한 가지가 컨트롤의 유무를 정한다. */
const signIn = (isAdmin: boolean) => {
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', isAdmin),
    accounts: { u1: acc('u1', 'me', 'human', isAdmin), a1: acc('a1', 'fizz', 'agent') },
  });
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
});
afterEach(() => { cleanup(); setController(null as unknown as ControllerType); });

describe('1. 세 묶음으로 나뉜다', () => {
  it('대기 중·승인됨·비활성이 각각 자기 항목을 갖는다', async () => {
    signIn(true);
    fakeController();
    render(<SkillsSettings />);

    await screen.findByText('pending-one');
    // 제목에 개수가 붙는다 — 셋이 한 묶음에 몰려 있으면 여기서 갈린다.
    expect(screen.getByText('대기 중 (1)')).toBeTruthy();
    expect(screen.getByText('승인됨 (1)')).toBeTruthy();
    expect(screen.getByText('비활성 (1)')).toBeTruthy();
    expect(screen.getByText('approved-one')).toBeTruthy();
    expect(screen.getByText('disabled-one')).toBeTruthy();
  });

  it('판정은 한 함수다 — 비활성이 승인을 이긴다', () => {
    // 승인됐다가 비활성된 스킬은 **비활성 하나**다. 화면이 자리마다 조건식을 다시 쓰면
    // 이 스킬이 승인됨과 비활성 두 묶음에 동시에 뜬다.
    expect(skillGroupOf(PENDING)).toBe('pending');
    expect(skillGroupOf(APPROVED)).toBe('approved');
    expect(skillGroupOf(DISABLED)).toBe('disabled');
    expect(skillGroupOf(skill('x', { approvedAt: 'a', disabledAt: 'd' }))).toBe('disabled');
  });
});

describe('2. 비-admin 에게 컨트롤이 렌더되지 않는다', () => {
  it('목록은 보이지만 승인·거부·비활성 버튼이 **없다**(비활성이 아니라 부재)', async () => {
    signIn(false);
    fakeController();
    render(<SkillsSettings />);

    // 목록 자체는 로그인한 사람 누구나 본다 — `GET /skills` 가 requireAccount 다.
    await screen.findByText('pending-one');
    expect(screen.getByText('approved-one')).toBeTruthy();

    // 눌러도 403 이 나는 버튼을 보여 주면, 사람은 자기가 뭘 잘못했다고 생각한다.
    for (const label of ['승인', '거부', '비활성화']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    // 비활성 상태로도 존재하지 않는다.
    expect(screen.queryByText('승인')).toBeNull();
  });

  it('admin 에게는 그 컨트롤이 있다 — 위 단언이 "아무것도 없어서" 통과한 것이 아니다', async () => {
    signIn(true);
    fakeController();
    render(<SkillsSettings />);

    await screen.findByText('pending-one');
    expect(screen.getByRole('button', { name: '승인' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '거부' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '비활성화' })).toBeTruthy();
  });
});

describe('3. 승인은 확인을 거친다 — `window.confirm` 이 아니다', () => {
  it('확인 전에는 요청이 나가지 않고, 문구에 "모든 에이전트"가 있다', async () => {
    signIn(true);
    const c = fakeController();
    // 브라우저 확인창을 쓰면 이 목이 불린다. 이 저장소가 명시적으로 거절한 수단이다.
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);

    render(<SkillsSettings />);
    await screen.findByText('pending-one');

    fireEvent.click(screen.getByRole('button', { name: '승인' }));

    // 첫 클릭은 확인을 띄울 뿐이다 — 여기서 요청이 나가면 확인 단계가 장식이다.
    expect(c.approveSkill).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
    const confirmText = screen.getByText(APPROVE_CONFIRM_TEXT);
    expect(confirmText.textContent).toContain('모든 에이전트');

    fireEvent.click(screen.getByRole('button', { name: '승인 확인' }));
    await waitFor(() => expect(c.approveSkill).toHaveBeenCalledWith('pending-one'));

    vi.unstubAllGlobals();
  });

  it('취소하면 확인이 닫히고 요청은 끝내 나가지 않는다', async () => {
    signIn(true);
    const c = fakeController();
    render(<SkillsSettings />);
    await screen.findByText('pending-one');

    fireEvent.click(screen.getByRole('button', { name: '승인' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(screen.queryByText(APPROVE_CONFIRM_TEXT)).toBeNull();
    expect(c.approveSkill).not.toHaveBeenCalled();
  });
});

describe('4. 승인하면 그 항목이 승인됨으로 옮겨간다', () => {
  it('라우트를 부르고 **목록을 다시 읽는다** — 화면의 사본을 손으로 고치지 않는다', async () => {
    signIn(true);
    let approved = false;
    const c = fakeController({
      listSkills: vi.fn(async () => [
        approved ? skill('pending-one', { approvedBy: 'u1', approvedAt: 'now' }) : PENDING,
      ]),
      approveSkill: vi.fn(async (slug: string) => { approved = true; return skill(slug); }),
    });

    render(<SkillsSettings />);
    await screen.findByText('pending-one');
    expect(screen.getByText('대기 중 (1)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '승인' }));
    fireEvent.click(screen.getByRole('button', { name: '승인 확인' }));

    // 서버가 정본이다. 화면이 자기 배열만 옮기면, 승인이 실패했는데도 옮겨간 것처럼 보인다.
    await waitFor(() => expect(screen.getByText('승인됨 (1)')).toBeTruthy());
    expect(screen.getByText('대기 중 (0)')).toBeTruthy();
    expect(c.listSkills).toHaveBeenCalledTimes(2);
  });

  it('실패하면 사유가 화면에 남고 목록은 그대로다 — 조용히 삼키지 않는다', async () => {
    signIn(true);
    fakeController({
      approveSkill: vi.fn(async () => { throw new Error('이미 승인되었다'); }),
    });

    render(<SkillsSettings />);
    await screen.findByText('pending-one');
    fireEvent.click(screen.getByRole('button', { name: '승인' }));
    fireEvent.click(screen.getByRole('button', { name: '승인 확인' }));

    // 서버가 말해 준 사유를 그대로 보인다 — 우리가 지어낸 한 줄로 덮으면 사유가 사라진다.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('이미 승인되었다');
  });
});

describe('5. 본문은 해석되지 않는다', () => {
  const RAW = '<script>alert(1)</script> **굵게** [링크](https://example.com)';

  it('마크다운 문법과 태그가 **글자 그대로** 보이고, 요소로 만들어지지 않는다', async () => {
    signIn(true);
    fakeController({ listSkills: vi.fn(async () => [skill('inject', { body: RAW })]) });

    render(<SkillsSettings />);
    await screen.findByText('inject');
    fireEvent.click(screen.getByRole('button', { name: '본문 보기' }));

    const pre = await screen.findByTestId('skill-body-inject');
    // 승인하는 사람이 보는 글자가 곧 에이전트가 읽을 바이트여야 한다.
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe(RAW);
    // 마크다운으로 그리면 `**굵게**` 는 <strong> 이 되고 `[링크](...)` 는 <a> 가 된다.
    expect(pre.querySelector('strong')).toBeNull();
    expect(pre.querySelector('a')).toBeNull();
    // HTML 로 그리면 `<script>` 는 요소가 되어 글자에서 사라진다.
    expect(pre.querySelector('script')).toBeNull();
    expect(pre.childElementCount).toBe(0);
    expect(pre.textContent).toContain('<script>');
    expect(pre.textContent).toContain('**굵게**');
  });
});

describe('6. 제안 알림의 진입점이 설정을 스킬 절로 연다', () => {
  /** Workspace 를 통째로 띄운다 — 조각 테스트는 그 사이 배선을 보지 않는다. */
  const bootWorkspace = (onOpenSettings: () => void) => {
    setController({
      api: fakeApi(),
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      createChannel: vi.fn(), updateChannel: vi.fn(), setChannelNotifyLevel: vi.fn(),
      toggleChannelStar: vi.fn(), notifyTyping: vi.fn(), refreshAccounts: vi.fn(),
      send: vi.fn(), loadOlder: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false), goForward: vi.fn().mockResolvedValue(false),
    } as unknown as ControllerType);
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), a1: acc('a1', 'fizz', 'agent') },
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      messages: {
        c1: [msg('m1', 'c1', 1, '스킬이 제안되었습니다: **note-taking** — 승인을 기다리고 있습니다.', 'a1', {
          kind: 'system',
          // 서버(`proposeSkill`)가 남기는 표시. 본문 글자가 아니라 이 값이 진입점을 만든다.
          meta: { skillSlug: 'note-taking' },
        })],
      },
    });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={onOpenSettings} />);
  };

  it('알림의 버튼을 누르면 `onOpenSettings("skills", slug)` 가 불린다', async () => {
    const onOpenSettings = vi.fn();
    bootWorkspace(onOpenSettings);

    const enter = await screen.findByRole('button', { name: '스킬 승인 화면 열기' });
    fireEvent.click(enter);

    // `#279` 의 신호를 재사용한다 — 새 신호를 만들지 않는다. 대상까지 넘겨야
    // 설정이 그 스킬을 펼친 채로 열린다.
    expect(onOpenSettings).toHaveBeenCalledWith('skills', 'note-taking');
  });

  it('표시가 없는 시스템 메시지에는 그 버튼이 없다', async () => {
    const onOpenSettings = vi.fn();
    setController({
      api: fakeApi(),
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
      createChannel: vi.fn(), updateChannel: vi.fn(), setChannelNotifyLevel: vi.fn(),
      toggleChannelStar: vi.fn(), notifyTyping: vi.fn(), refreshAccounts: vi.fn(),
      send: vi.fn(), loadOlder: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false), goForward: vi.fn().mockResolvedValue(false),
    } as unknown as ControllerType);
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), a1: acc('a1', 'fizz', 'agent') },
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      messages: { c1: [msg('m1', 'c1', 1, '스킬이 제안되었습니다: **note-taking**', 'a1', { kind: 'system' })] },
    });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={onOpenSettings} />);

    await screen.findByText(/스킬이 제안되었습니다/);
    expect(screen.queryByRole('button', { name: '스킬 승인 화면 열기' })).toBeNull();
  });

  it('설정이 대상과 함께 열리면 그 스킬의 본문이 펼쳐진 채로 온다', async () => {
    signIn(true);
    fakeController();
    render(<SkillsSettings targetId="approved-one" />);

    // 승인하러 온 사람이 본문을 보려고 한 번 더 눌러야 하면, 그 클릭이 곧 안 보고
    // 승인하는 길이 된다.
    const pre = await screen.findByTestId('skill-body-approved-one');
    expect(pre.textContent).toBe('approved-one 본문');
    expect(screen.queryByTestId('skill-body-pending-one')).toBeNull();
  });
});

describe('7. `skill.*` 이벤트를 받으면 목록이 갱신된다', () => {
  it('제안 이벤트가 오면 다시 읽는다 — 화면을 닫았다 열 필요가 없다', async () => {
    signIn(true);
    let rows = [PENDING];
    const c = fakeController({ listSkills: vi.fn(async () => rows) });

    render(<SkillsSettings />);
    await screen.findByText('pending-one');
    expect(c.listSkills).toHaveBeenCalledTimes(1);

    // 컨트롤러가 `skill.*` 을 받고 올리는 그 신호다(appStore.skillsRevision).
    rows = [PENDING, skill('brand-new')];
    useAppStore.getState().set({ skillsRevision: useAppStore.getState().skillsRevision + 1 });

    await screen.findByText('brand-new');
    expect(c.listSkills).toHaveBeenCalledTimes(2);
  });

  it('컨트롤러가 `skill.*` 세 종류 모두에서 그 신호를 올린다', async () => {
    // 화면 테스트는 신호를 손으로 올린다 — 서버 이벤트가 실제로 그 신호가 되는지는
    // 여기서만 지킨다. 셋 중 하나만 빠져도 그 사건에서 목록이 굳는다.
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    const row = { ...PENDING };

    const before = useAppStore.getState().skillsRevision;
    callbacks.current!.onEvent({ type: 'skill.proposed', skill: row, channelId: 'c1' });
    callbacks.current!.onEvent({ type: 'skill.approved', skill: row });
    callbacks.current!.onEvent({ type: 'skill.disabled', skill: row });

    expect(useAppStore.getState().skillsRevision).toBe(before + 3);
  });

  it('같은 신호가 두 번 오면 두 번 다시 읽는다 — 한 번 놓치면 목록이 굳는다', async () => {
    signIn(true);
    const c = fakeController();
    render(<SkillsSettings />);
    await screen.findByText('pending-one');

    for (let i = 0; i < 2; i += 1) {
      useAppStore.getState().set({ skillsRevision: useAppStore.getState().skillsRevision + 1 });
      await waitFor(() => expect(c.listSkills).toHaveBeenCalledTimes(i + 2));
    }
  });
});

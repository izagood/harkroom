// Task 14(identity 문서) — 프로필.
//
// **알아야 할 때 여는 자리.** Task 12 가 흐름에서 🤖 와 소유자를 뺀 뒤로 그 정보가 어디에도
// 없었다 — 문서가 "흐름에서 표시를 빼면 그 정보가 어디에도 없게 된다"고 경계한 자리다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Profile } from '../src/components/Profile';
import { acc } from './helpers/fakeApi';

const ME = 'u-me';
const MINE = 'a-mine';
const THEIRS = 'a-theirs';

const agentView = (id: string, handle: string, over: Partial<AgentView> = {}): AgentView => ({
  id, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: ME, disabled: false, runnerVersion: null,
  claudeLane: null, executionPath: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...over,
});

const fakeController = (agents: AgentView[] = []) => {
  const c = {
    listAgents: vi.fn(async () => agents),
    startDm: vi.fn(async () => undefined),
    restartRunner: vi.fn(async () => undefined),
    cancelRestart: vi.fn(() => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

const setup = (isAdmin = false) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc(ME, 'jaebin', 'human', isAdmin),
    connected: true,
    online: [MINE],
    // 뒤처짐 판정의 기준. 실제로는 컨트롤러가 기동 때 밀어 넣는다(`appStore.ts::appVersion`).
    appVersion: '0.1.15',
    accounts: {
      [ME]: acc(ME, 'jaebin', 'human', isAdmin),
      [MINE]: acc(MINE, 'mine', 'agent', false, { ownerAccountId: ME }),
      [THEIRS]: acc(THEIRS, 'theirs', 'agent', false, { ownerAccountId: 'someone-else' }),
    },
  });
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(`#619`·사이드바 PR 이
// 세운 방식과 같다). 영어가 원본이라 기본값이 영어이므로, 한국어를 재려면 한국어라고
// 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => { usePrefsStore.getState().setLocale('ko'); setup(); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('Profile — 사람과 에이전트가 같은 틀', () => {
  it('사람은 사람이라고 말한다', () => {
    fakeController();
    render(<Profile accountId={ME} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'jaebin 프로필' });
    expect(dialog.textContent).toContain('사람');
    // 사람에게는 연결·하네스 행이 없다 — 없는 것에 자리를 주지 않는다.
    expect(dialog.textContent).not.toContain('하네스');
  });

  it('에이전트는 종류와 연결을 말한다 — 흐름에서 뺀 것이 여기 있다', () => {
    fakeController();
    render(<Profile accountId={MINE} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'mine 프로필' });
    expect(dialog.textContent).toContain('에이전트');
    expect(dialog.textContent).toContain('온라인');
    expect(dialog.textContent).toContain('@jaebin'); // 소유자
  });

  it('생존을 모르면 모른다고 말한다 — 소켓이 끊긴 것과 죽은 것은 다르다', () => {
    useAppStore.getState().set({ connected: false });
    fakeController();
    render(<Profile accountId={MINE} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog').textContent).toContain('알 수 없음');
  });
});

/**
 * **볼 수 있는 것만 보여 준다.** 설정은 서버가 admin·소유자에게만 준다
 * (`GET /accounts/agents` 가 비admin 에게 자기 것만 준다).
 */
describe('Profile — 권한', () => {
  it('내 에이전트면 하네스와 마지막 활동까지 보인다', async () => {
    fakeController([agentView(MINE, 'mine', { harness: 'codex', workingDir: '/repo' })]);
    // `onOpenSettings` 를 넘겨야 설정 진입점이 선다 — 갈 곳이 없으면 문을 그리지 않는다.
    render(<Profile accountId={MINE} onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('codex'));
    expect(screen.getByRole('dialog').textContent).toContain('/repo');
    expect(screen.getByTestId('profile-settings')).toBeTruthy();
  });

  it('남의 에이전트면 그 행이 아예 없다 — 빈 행은 "값이 없다"로 읽힌다', async () => {
    const c = fakeController([]);
    // 문을 넘겨 주어도 **권한이 없어서** 안 그려지는 것을 본다.
    render(<Profile accountId={THEIRS} onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByRole('dialog').textContent).not.toContain('하네스');
    expect(screen.queryByTestId('profile-settings')).toBeNull();
    // 볼 수 없다는 것을 알면서 부르지 않는다.
    expect(c.listAgents).not.toHaveBeenCalled();
  });

  it('admin 은 남의 에이전트도 본다 — 서버 판정과 같다', async () => {
    setup(true);
    fakeController([agentView(THEIRS, 'theirs', { ownerAccountId: 'someone-else' })]);
    render(<Profile accountId={THEIRS} onClose={vi.fn()} onOpenSettings={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('profile-settings')).toBeTruthy());
  });
});

describe('Profile — 나가는 문', () => {
  it('DM 을 열면 프로필이 닫힌다 — 겹쳐 두면 무엇을 보는지 흐려진다', () => {
    const c = fakeController();
    const onClose = vi.fn();
    render(<Profile accountId={MINE} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('profile-dm'));
    expect(c.startDm).toHaveBeenCalledWith(MINE);
    expect(onClose).toHaveBeenCalled();
  });

  it('내 프로필에는 DM 버튼이 없다 — 자기에게 DM 하지 않는다', () => {
    fakeController();
    render(<Profile accountId={ME} onClose={vi.fn()} />);
    expect(screen.queryByTestId('profile-dm')).toBeNull();
  });

  it('Esc 로 닫힌다 — 오버레이 규칙을 함께 쓴다', () => {
    fakeController();
    const onClose = vi.fn();
    render(<Profile accountId={MINE} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

// ── 새 번들로 재기동 ──────────────────────────────────────────────────────────
//
// 러너는 daemon 이 소유하고 앱의 수명을 넘어 산다(`#431`). 앱을 새로 설치해도 이미 도는
// 러너는 옛 번들 그대로이고, `doStartOne` 은 장부에 살아 있는 러너를 새로 띄우지 않는다.
// 그래서 **사람이 갈아 줘야** 하고, 그러려면 화면이 "이 러너가 뒤처졌다"를 먼저 말해야
// 한다 — 근거 없이 버튼만 두면 사람은 누를 이유를 알 수 없다.
describe('Profile — 러너 버전과 재기동', () => {
  const live = (agentId: string, status = 'running') => {
    useAppStore.getState().set({
      runnerStates: { [agentId]: { agentId, status, exitCode: null, message: null } } as never,
    });
  };

  it('러너가 앱보다 뒤처졌으면 그렇게 말하고 재기동을 내놓는다', async () => {
    fakeController([agentView(MINE, 'mine', { runnerVersion: '0.1.6' })]);
    live(MINE);
    render(<Profile accountId={MINE} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'mine 프로필' });
    await waitFor(() => expect(dialog.textContent).toContain('0.1.6'));
    expect(dialog.textContent).toContain('뒤처진');
    expect(screen.getByRole('button', { name: '새 버전으로 재기동' })).toBeTruthy();
  });

  it('버전을 모르면 뒤처졌다고 하지 않는다 — 모르는 것을 단정하지 않는다', async () => {
    fakeController([agentView(MINE, 'mine', { runnerVersion: 'unknown' })]);
    live(MINE);
    render(<Profile accountId={MINE} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'mine 프로필' });
    await waitFor(() => expect(dialog.textContent).toContain('버전을 모른다'));
    expect(dialog.textContent).not.toContain('뒤처진');
    // 그래도 재기동은 할 수 있다 — 사람이 판단한다. 다만 "새 버전으로" 라고 약속하지 않는다.
    expect(screen.getByRole('button', { name: '러너 재기동' })).toBeTruthy();
  });

  it('누르면 컨트롤러의 재기동에 닿는다', async () => {
    const c = fakeController([agentView(MINE, 'mine', { runnerVersion: '0.1.6' })]);
    live(MINE);
    render(<Profile accountId={MINE} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '새 버전으로 재기동' }));

    await waitFor(() => expect(c.restartRunner).toHaveBeenCalledWith(MINE));
  });

  /**
   * **기다린다는 사실이 화면에 있어야 한다.** SIGTERM 은 graceful 이라 러너는 진행 중인
   * 턴을 마친 뒤에야 죽고, 실측 5분이 넘은 턴도 있다. 그동안 아무 표시가 없으면 사람에게는
   * "눌렀는데 아무 일이 없다"이고, 그것이 이 저장소가 `#384` 에서 이미 고친 결함이다.
   */
  it('예약 중에는 무엇을 기다리는지 적고, 취소는 뜨는 것만 취소한다고 말한다', async () => {
    fakeController([agentView(MINE, 'mine', { runnerVersion: '0.1.6' })]);
    live(MINE, 'restarting');
    render(<Profile accountId={MINE} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'mine 프로필' });
    await waitFor(() => expect(dialog.textContent).toContain('진행 중인 턴'));
    expect(screen.getByRole('button', { name: '재기동 예약 취소' })).toBeTruthy();
  });

  it('붙어 있는 러너가 없으면 재기동을 내놓지 않는다 — 갈아 줄 것이 없다', async () => {
    fakeController([agentView(MINE, 'mine', { runnerVersion: '0.1.6' })]);
    render(<Profile accountId={MINE} onClose={vi.fn()} />);

    await screen.findByRole('dialog', { name: 'mine 프로필' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '새 버전으로 재기동' })).toBeNull();
    });
  });
});

// Task 14(identity 문서) — 프로필.
//
// **알아야 할 때 여는 자리.** Task 12 가 흐름에서 🤖 와 소유자를 뺀 뒤로 그 정보가 어디에도
// 없었다 — 문서가 "흐름에서 표시를 빼면 그 정보가 어디에도 없게 된다"고 경계한 자리다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AgentView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
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
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...over,
});

const fakeController = (agents: AgentView[] = []) => {
  const c = {
    listAgents: vi.fn(async () => agents),
    startDm: vi.fn(async () => undefined),
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
    accounts: {
      [ME]: acc(ME, 'jaebin', 'human', isAdmin),
      [MINE]: acc(MINE, 'mine', 'agent', false, { ownerAccountId: ME }),
      [THEIRS]: acc(THEIRS, 'theirs', 'agent', false, { ownerAccountId: 'someone-else' }),
    },
  });
};

beforeEach(() => setup());
afterEach(() => cleanup());

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

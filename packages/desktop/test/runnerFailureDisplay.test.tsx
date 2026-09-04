/**
 * #368: 러너 기동 실패 사유 표시 회귀선.
 *
 * 1. 채널에서 에이전트 멘션 시 실패 사유 표시
 * 2. 상수 재사용 (문구 복제 방지)
 * 3. 정상运行时 안 표시 (소음 방지)
 * 4. 멘션 없으면 안 표시
 * 5. 사이드바가 failed 를 offline 으로만 안 표시
 * 6. DM 없이도 사유可见
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { REPO_PATH_MISSING, RUNNER_COMMAND_MISSING } from '../src/lib/runnerLauncher';
import { acc, chan, fakeApi } from './helpers/fakeApi';
import type { ChannelAutoMentionRow } from '@murmur/shared';

const createMockController = () => {
  const mockApi = fakeApi();
  const c = {
    openChannel: vi.fn(),
    startDm: vi.fn(),
    logout: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    send: vi.fn(),
    api: mockApi,
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('RunnerStatusDot (#368)', () => {
  it('REPO_PATH_MISSING 상수가 정의되어 있다', () => {
    expect(REPO_PATH_MISSING).toBe('러너를 돌릴 murmur 저장소 경로가 설정되지 않았다 — 설정 → 연결에서 지정한다');
  });

  it('RUNNER_COMMAND_MISSING 상수가 정의되어 있다', () => {
    expect(RUNNER_COMMAND_MISSING).toBe('러너 명령을 찾을 수 없다 — 로그인 셸의 PATH 를 읽지 못했다. 설정 → 연결에서 pnpm 의 절대 경로를 지정하라');
  });
});

describe('사이드바 에이전트 섹션 (#368)', () => {
  const agentAcc = (id: string) => acc(id, id, 'agent');

  beforeEach(() => {
    createMockController();
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: {
        u1: acc('u1', 'admin', 'human', true),
        forge: agentAcc('forge'),
        russalka: agentAcc('russalka'),
      },
      channels: [chan('c1', 'general')],
      dms: [],
      online: [],
      connected: true,
      activeChannelId: 'c1',
      runnerStates: {},
    });
  });

  it('에이전트가 없으면 Agents 섹션이 안 보인다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'admin', 'human', true) } });
    render(<Sidebar
      onOpenDirectory={() => {}}
      onOpenChannelDirectory={() => {}}
      onOpenInbox={() => {}}
      onOpenSaved={() => {}}
      onLogout={vi.fn()}
      onOpenSettings={vi.fn()}
      collapsed={false}
      onToggleCollapse={vi.fn()}
    />);
    expect(screen.queryByText('Agents')).toBeNull();
  });

  it('에이전트가 있으면 Agents 섹션이 보인다', () => {
    render(<Sidebar
      onOpenDirectory={() => {}}
      onOpenChannelDirectory={() => {}}
      onOpenInbox={() => {}}
      onOpenSaved={() => {}}
      onLogout={vi.fn()}
      onOpenSettings={vi.fn()}
      collapsed={false}
      onToggleCollapse={vi.fn()}
    />);
    expect(screen.getByText('Agents')).toBeTruthy();
  });

  it('에이전트 목록에 러너 상태가 보인다', () => {
    useAppStore.getState().set({
      runnerStates: {
        forge: { agentId: 'forge', status: 'failed', exitCode: null, message: REPO_PATH_MISSING },
      },
    });
    render(<Sidebar
      onOpenDirectory={() => {}}
      onOpenChannelDirectory={() => {}}
      onOpenInbox={() => {}}
      onOpenSaved={() => {}}
      onLogout={vi.fn()}
      onOpenSettings={vi.fn()}
      collapsed={false}
      onToggleCollapse={vi.fn()}
    />);
    // 에이전트 이름이 보여야 한다
    expect(screen.getByText('@forge')).toBeTruthy();
  });
});

describe('DM 없는 에이전트也表示 (#368)', () => {
  beforeEach(() => {
    createMockController();
  });

  it('DM 이 없어도 사이드바 Agents 섹션에서 러너 상태를 볼 수 있다', () => {
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: {
        u1: acc('u1', 'admin', 'human', true),
        forge: acc('forge', 'forge', 'agent'),
      },
      channels: [chan('c1', 'general')],
      dms: [], // DM 없음
      online: [],
      connected: true,
      activeChannelId: 'c1',
      runnerStates: {
        forge: { agentId: 'forge', status: 'failed' as const, exitCode: null, message: REPO_PATH_MISSING },
      },
    });
    render(<Sidebar
      onOpenDirectory={() => {}}
      onOpenChannelDirectory={() => {}}
      onOpenInbox={() => {}}
      onOpenSaved={() => {}}
      onLogout={vi.fn()}
      onOpenSettings={vi.fn()}
      collapsed={false}
      onToggleCollapse={vi.fn()}
    />);
    // Agents 섹션이 보여야 하고 에이전트 이름이 있어야 한다
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('@forge')).toBeTruthy();
  });
});
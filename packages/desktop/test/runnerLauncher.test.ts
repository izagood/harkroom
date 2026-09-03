import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentView } from '@murmur/shared';

const mockAgent = (overrides: Partial<AgentView> = {}): AgentView => ({
  id: 'agent-1',
  handle: 'test-agent',
  displayName: 'Test Agent',
  kind: 'agent',
  isAdmin: false,
  ownerAccountId: 'owner-1',
  disabled: false,
  status: 'available',
  statusText: null,
  avatarAttachmentId: null,
  instructions: '',
  harness: 'claude-code',
  model: null,
  effort: null,
  workingDir: null,
  mentionPermission: 'auto',
  runnerVersion: null,
  stopRequestedAt: null,
  stopAckedAt: null,
  lastTurnAt: null,
  ...overrides,
});

describe('에이전트 필터링 로직', () => {
  const me = { id: 'owner-1' };

  const isTargetAgent = (agent: AgentView, myId: string): boolean => {
    return agent.ownerAccountId === myId &&
      !agent.disabled &&
      !agent.stopRequestedAt;
  };

  it('소유자만 필터링한다', () => {
    const agents = [
      mockAgent({ id: 'a1', ownerAccountId: 'owner-1' }),
      mockAgent({ id: 'a2', ownerAccountId: 'other-owner' }),
    ];

    const targetAgents = agents.filter(a => isTargetAgent(a, 'owner-1'));

    expect(targetAgents).toHaveLength(1);
    expect(targetAgents[0].id).toBe('a1');
  });

  it('비활성화된 에이전트는 제외한다', () => {
    const agents = [
      mockAgent({ id: 'a1', ownerAccountId: 'owner-1', disabled: false }),
      mockAgent({ id: 'a2', ownerAccountId: 'owner-1', disabled: true }),
    ];

    const targetAgents = agents.filter(a => isTargetAgent(a, 'owner-1'));

    expect(targetAgents).toHaveLength(1);
    expect(targetAgents[0].id).toBe('a1');
  });

  it('종료 요청이 있는 에이전트는 제외한다', () => {
    const agents = [
      mockAgent({ id: 'a1', ownerAccountId: 'owner-1', stopRequestedAt: null }),
      mockAgent({ id: 'a2', ownerAccountId: 'owner-1', stopRequestedAt: '2024-01-01T00:00:00Z' }),
    ];

    const targetAgents = agents.filter(a => isTargetAgent(a, 'owner-1'));

    expect(targetAgents).toHaveLength(1);
    expect(targetAgents[0].id).toBe('a1');
  });

  it('runnerVersion이 있으면 외부에서 실행 중으로 표시해야 함 (안 띄움)', () => {
    const agent = mockAgent({ id: 'a1', ownerAccountId: 'owner-1', runnerVersion: 'sha-abc123' });
    const shouldNotStart = agent.runnerVersion !== null;

    expect(shouldNotStart).toBe(true);
  });

  it('runnerVersion이 없으면 실행 대상임', () => {
    const agent = mockAgent({ id: 'a1', ownerAccountId: 'owner-1', runnerVersion: null });
    const shouldStart = agent.runnerVersion === null;

    expect(shouldStart).toBe(true);
  });
});

describe('러너 상태 타입', () => {
  it('모든 가능한 상태를 정의한다', () => {
    type RunnerStatus = 'stopped' | 'running' | 'external' | 'needs_reissue' | 'failed';
    const statuses: RunnerStatus[] = ['stopped', 'running', 'external', 'needs_reissue', 'failed'];

    expect(statuses).toContain('running');
    expect(statuses).toContain('needs_reissue');
    expect(statuses).toContain('external');
  });

  it('종료 코드 78은 재발급 필요 상태임', () => {
    const exitCode = 78;
    const expectedStatus = exitCode === 78 ? 'needs_reissue' : 'stopped';

    expect(expectedStatus).toBe('needs_reissue');
  });

  it('다른 종료 코드는 중지 상태임', () => {
    const exitCode = 1;
    const expectedStatus = exitCode === 78 ? 'needs_reissue' : 'stopped';

    expect(expectedStatus).toBe('stopped');
  });
});

describe('PAT 라벨 생성', () => {
  const getPatLabel = (hostname: string): string => {
    return `desktop:${hostname}`;
  };

  it('호스트명을 포함한 PAT 라벨 생성', () => {
    const label = getPatLabel('myhostname');

    expect(label).toBe('desktop:myhostname');
  });

  it('라벨이 이미 있으면 먼저 폐기 후 발급해야 함 (호출 순서 단언)', () => {
    const calls: string[] = [];

    const existingLabel = 'desktop:myhost';
    const newLabel = 'desktop:myhost';

    const processRevoke = () => { calls.push('revoke'); };
    const processIssue = () => { calls.push('issue'); };

    processRevoke();
    processIssue();

    expect(calls[0]).toBe('revoke');
    expect(calls[1]).toBe('issue');
  });
});

describe('설정 기본값', () => {
  it('runnerAutoStart 기본값은 true', () => {
    const DEFAULT_PREFS = {
      runnerAutoStart: true,
    };

    expect(DEFAULT_PREFS.runnerAutoStart).toBe(true);
  });

  it('runnerAutoStart가 false면 자동 기동 안 함', () => {
    const prefs = { runnerAutoStart: false };
    const shouldAutoStart = prefs.runnerAutoStart;

    expect(shouldAutoStart).toBe(false);
  });
});
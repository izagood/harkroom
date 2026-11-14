// 에이전트마다 러너 구현 고르기(B4-5c). 풀·lane 에이전트를 rust 로 돌리면 사람의 기본 claude 로그인으로 돈다 —
// L3c-3 전까지는 node 로 떨어뜨린다.
import { describe, it, expect } from 'vitest';
import { createAssignmentReconciler, type AssignmentDeps } from '../src/assignments.js';
import { pickRunner, type RunnerPick } from '../src/runnerPick.js';
import type { AgentDefinition } from '@harkroom/shared/operatorProtocol';

const lane = { baseUrl: 'https://gateway.example', secretName: 'gw-key' };

describe('pickRunner', () => {
  it('runner 가 rust 가 아니면 node 이고 이유가 없다', () => {
    expect(pickRunner(undefined, true)).toEqual({ kind: 'node' });
    expect(pickRunner({}, true)).toEqual({ kind: 'node' });
    expect(pickRunner({ runner: 'node' }, true)).toEqual({ kind: 'node' });
    expect(pickRunner({ runner: 'Rust' as never }, true)).toEqual({ kind: 'node' });
  });
  it('rust + 파일 있음 → rust', () => {
    expect(pickRunner({ runner: 'rust', workingDir: '/w' }, true)).toEqual({ kind: 'rust' });
  });
  it('rust + 계정 풀 → node(rust_needs_account_pool)', () => {
    expect(pickRunner({ runner: 'rust', claudePool: 'p' }, true)).toEqual({ kind: 'node', fallback: 'rust_needs_account_pool' });
  });
  it('rust + lane → node(rust_needs_provider_lane)', () => {
    expect(pickRunner({ runner: 'rust', providerLane: lane }, true)).toEqual({ kind: 'node', fallback: 'rust_needs_provider_lane' });
  });
  it('rust + 파일 없음 → node(rust_runner_missing)', () => {
    expect(pickRunner({ runner: 'rust' }, false)).toEqual({ kind: 'node', fallback: 'rust_runner_missing' });
  });
});

describe('배정이 고른 러너를 spawn 에 넘긴다', () => {
  const def: AgentDefinition = {
    agentId: 'a-1', handle: 'murmur', harness: 'claude-code', instructions: '', model: null, effort: null,
    mentionPermission: 'auto', workingDirDefault: null, credentialScope: 'none', ownerAccountId: 'u-1', mcpServers: [],
  };
  function run(present: boolean) {
    const picks: (RunnerPick | undefined)[] = [];
    const logs: string[] = [];
    let probed = 0;
    const deps: AssignmentDeps = {
      spawn: async (_a, _e, runnerId, pick) => { picks.push(pick); return { spawned: true, pid: 1, runnerId }; },
      rustRunnerPresent: async () => { probed += 1; return present; },
      signal: () => false, isAlive: () => false, listRunners: () => [],
      link: { expect: () => {}, forget: () => {} },
      socketPath: '/tmp/op.sock', operatorBin: '/opt/harkroom/harkroom-operator', loginPath: null, appVersion: '0.2.8',
      operatorOwnerId: async () => 'u-1', mcpConfig: async (d) => ({ path: `/tmp/mcp/${d.agentId}.json` }),
      schedule: () => () => {}, log: (l) => logs.push(l),
    };
    return { r: createAssignmentReconciler(deps), picks, logs, probed: () => probed };
  }

  it('lane 에이전트 + rust → node 로 돌고 이유를 로그에 남긴다', async () => {
    const h = run(true);
    await h.r.onAssign('https://example.com', def, { runner: 'rust', providerLane: lane });
    expect(h.picks).toEqual([{ kind: 'node', fallback: 'rust_needs_provider_lane' }]);
    expect(h.logs.some((l) => l.includes('rust_needs_provider_lane') && l.includes('murmur'))).toBe(true);
    expect(h.logs.some((l) => l.includes('runner=node'))).toBe(true);
  });
  it('풀 에이전트 + rust → node', async () => {
    const h = run(true);
    await h.r.onAssign('https://example.com', def, { runner: 'rust', claudePool: 'p' });
    expect(h.picks).toEqual([{ kind: 'node', fallback: 'rust_needs_account_pool' }]);
  });
  it('기본 로그인 에이전트 + rust + 파일 있음 → rust', async () => {
    const h = run(true);
    await h.r.onAssign('https://example.com', def, { runner: 'rust' });
    expect(h.picks).toEqual([{ kind: 'rust' }]);
    expect(h.logs.some((l) => l.includes('runner=rust'))).toBe(true);
  });
  it('rust 를 청하지 않으면 파일을 찾아보지도 않는다', async () => {
    const h = run(true);
    await h.r.onAssign('https://example.com', def, { workingDir: '/w' });
    expect(h.picks).toEqual([{ kind: 'node' }]);
    expect(h.probed()).toBe(0);
  });
  it('파일이 없으면 node(rust_runner_missing)', async () => {
    const h = run(false);
    await h.r.onAssign('https://example.com', def, { runner: 'rust' });
    expect(h.picks).toEqual([{ kind: 'node', fallback: 'rust_runner_missing' }]);
  });
});

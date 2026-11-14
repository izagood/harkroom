// 에이전트마다 러너 구현 고르기(B4-5c → L3c-3e). 계정 풀·lane 에이전트도 rust 로 돈다(Rust 러너가 풀·lane 폴더를 안다).
// pi·omp 하네스는 Rust 러너가 홈을 아직 짓지 않아 node 로 둔다. 「못 읽음은 node」는 그대로다.
import { describe, it, expect } from 'vitest';
import { createAssignmentReconciler, type AssignmentDeps } from '../src/assignments.js';
import { pickRunner, type AccountUse, type RunnerPick } from '../src/runnerPick.js';
import { claudeAccountUse } from '@harkroom/shared/claudeAccountLane';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@harkroom/shared/operatorProtocol';

const lane = { baseUrl: 'https://gateway.example', secretName: 'gw-key' };

describe('pickRunner', () => {
  it('runner 가 rust 가 아니면 node 이고 이유가 없다', () => {
    expect(pickRunner(undefined, true, 'none', 'claude-code')).toEqual({ kind: 'node' });
    expect(pickRunner({}, true, 'none', 'claude-code')).toEqual({ kind: 'node' });
    expect(pickRunner({ runner: 'node' }, true, 'none', 'claude-code')).toEqual({ kind: 'node' });
    expect(pickRunner({ runner: 'Rust' as never }, true, 'none', 'claude-code')).toEqual({ kind: 'node' });
  });
  it('rust + 파일 있음 → rust', () => {
    expect(pickRunner({ runner: 'rust', workingDir: '/w' }, true, 'none', 'claude-code')).toEqual({ kind: 'rust' });
  });
  it('rust + 계정 풀(operator.json·풀 해석 모두) → rust(L3c-3e)', () => {
    expect(pickRunner({ runner: 'rust', claudePool: 'p' }, true, 'pool', 'claude-code')).toEqual({ kind: 'rust' });
    expect(pickRunner({ runner: 'rust' }, true, 'pool', 'claude-code')).toEqual({ kind: 'rust' });
  });
  it('rust + lane → rust(L3c-3e)', () => {
    expect(pickRunner({ runner: 'rust', providerLane: lane }, true, 'none', 'claude-code')).toEqual({ kind: 'rust' });
  });
  it('rust + 하네스 pi·omp → node(rust_harness_unsupported) — 풀·lane·파일과 상관없이', () => {
    for (const h of ['pi', 'omp']) {
      expect(pickRunner({ runner: 'rust' }, true, 'none', h)).toEqual({ kind: 'node', fallback: 'rust_harness_unsupported' });
      expect(pickRunner({ runner: 'rust', providerLane: lane }, true, 'pool', h)).toEqual({ kind: 'node', fallback: 'rust_harness_unsupported' });
    }
    for (const h of ['claude-code', 'codex', 'opencode', 'kilo']) {
      expect(pickRunner({ runner: 'rust' }, true, 'none', h)).toEqual({ kind: 'rust' });
    }
  });
  it('rust + 풀 해석 못 읽음 → node(rust_account_pool_unreadable) 그대로', () => {
    expect(pickRunner({ runner: 'rust', claudePool: 'p' }, true, 'unreadable', 'claude-code')).toEqual({ kind: 'node', fallback: 'rust_account_pool_unreadable' });
  });
  it('rust + 파일 없음 → node(rust_runner_missing)', () => {
    expect(pickRunner({ runner: 'rust' }, false, 'none', 'claude-code')).toEqual({ kind: 'node', fallback: 'rust_runner_missing' });
  });
});

describe('배정이 고른 러너를 spawn 에 넘긴다', () => {
  const def: AgentDefinition = {
    agentId: 'a-1', handle: 'murmur', harness: 'claude-code', instructions: '', model: null, effort: null,
    mentionPermission: 'auto', workingDirDefault: null, credentialScope: 'none', ownerAccountId: 'u-1', mcpServers: [],
  };
  function run(present: boolean, use: AccountUse | null = 'none') {
    const picks: (RunnerPick | undefined)[] = [];
    const logs: string[] = [];
    let probed = 0;
    const deps: AssignmentDeps = {
      spawn: async (_a, _e, runnerId, pick) => { picks.push(pick); return { spawned: true, pid: 1, runnerId }; },
      rustRunnerPresent: async () => { probed += 1; return present; },
      ...(use === null ? {} : { claudeAccountUse: async () => use }),
      signal: () => false, isAlive: () => false, listRunners: () => [],
      link: { expect: () => {}, forget: () => {} },
      socketPath: '/tmp/op.sock', operatorBin: '/opt/harkroom/harkroom-operator', loginPath: null, appVersion: '0.2.8',
      operatorOwnerId: async () => 'u-1', mcpConfig: async (d) => ({ path: `/tmp/mcp/${d.agentId}.json` }),
      schedule: () => () => {}, log: (l) => logs.push(l),
    };
    return { r: createAssignmentReconciler(deps), picks, logs, probed: () => probed };
  }

  it('lane 에이전트 + rust → rust(L3c-3e)', async () => {
    const h = run(true);
    await h.r.onAssign('https://example.com', def, { runner: 'rust', providerLane: lane });
    expect(h.picks).toEqual([{ kind: 'rust' }]);
    expect(h.logs.some((l) => l.includes('runner=rust'))).toBe(true);
  });
  it('풀 에이전트 + rust → rust(L3c-3e)', async () => {
    const h = run(true, 'pool');
    await h.r.onAssign('https://example.com', def, { runner: 'rust', claudePool: 'p' });
    expect(h.picks).toEqual([{ kind: 'rust' }]);
  });
  it('pi·omp 에이전트 + rust → node 로 돌고 이유를 로그에 남긴다', async () => {
    for (const harness of ['pi', 'omp']) {
      const h = run(true);
      await h.r.onAssign('https://example.com', { ...def, harness }, { runner: 'rust' });
      expect(h.picks).toEqual([{ kind: 'node', fallback: 'rust_harness_unsupported' }]);
      expect(h.logs.some((l) => l.includes('rust_harness_unsupported') && l.includes('murmur'))).toBe(true);
    }
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
  it('풀 해석 결과가 pool 이어도(operator.json 에 claudePool 없음) rust(L3c-3e)', async () => {
    const h = run(true, 'pool');
    await h.r.onAssign('https://example.com', def, { runner: 'rust' });
    expect(h.picks).toEqual([{ kind: 'rust' }]);
  });
  it('풀 해석을 주지 않은 배정은 닫힌 쪽 — node(rust_account_pool_unreadable)', async () => {
    const h = run(true, null);
    await h.r.onAssign('https://example.com', def, { runner: 'rust' });
    expect(h.picks).toEqual([{ kind: 'node', fallback: 'rust_account_pool_unreadable' }]);
  });
  it('파일이 없으면 node(rust_runner_missing)', async () => {
    const h = run(false);
    await h.r.onAssign('https://example.com', def, { runner: 'rust' });
    expect(h.picks).toEqual([{ kind: 'node', fallback: 'rust_runner_missing' }]);
  });
});

// B4-5e: 「풀 있음」은 operator.json `claudePool` 이 아니라 러너의 실제 풀 해석으로 판정한다.
describe('러너의 풀 해석으로 고른다(B4-5e)', () => {
  const AGENT = '00000000-0000-4000-8000-000000000001';
  async function root(layout: { pools?: unknown | string; dirs?: string[] }) {
    const r = await mkdtemp(join(tmpdir(), 'op-acct-'));
    for (const d of layout.dirs ?? []) await mkdir(join(r, d), { recursive: true });
    if (layout.pools !== undefined) {
      await writeFile(join(r, 'pools.json'), typeof layout.pools === 'string' ? layout.pools : JSON.stringify(layout.pools));
    }
    return { HARKROOM_CLAUDE_ACCOUNTS_DIR: r } as NodeJS.ProcessEnv;
  }
  const use = async (env: NodeJS.ProcessEnv, forcedPool?: string) => claudeAccountUse({ agentId: AGENT, forcedPool, env });

  it('기본 풀만 있다(operator.json 에 claudePool 없음 — 실제로 흔한 모양) → pool → rust(L3c-3e)', async () => {
    const env = await root({ pools: { defaultPool: 'work' }, dirs: ['work/acct-a', 'work/acct-b'] });
    expect(await use(env)).toBe('pool');
    expect(pickRunner({ runner: 'rust' }, true, await use(env), 'claude-code')).toEqual({ kind: 'rust' });
  });
  it('에이전트 배정만 있다 → pool', async () => {
    const env = await root({ pools: { agents: { [AGENT]: ['p1'] } }, dirs: ['p1/acct-a'] });
    expect(await use(env)).toBe('pool');
  });
  it('pools.json 이 깨졌다 → unreadable → node(rust_account_pool_unreadable)', async () => {
    const env = await root({ pools: '{ not json', dirs: ['work/acct-a'] });
    expect(await use(env)).toBe('unreadable');
    expect(pickRunner({ runner: 'rust' }, true, 'unreadable', 'claude-code')).toEqual({ kind: 'node', fallback: 'rust_account_pool_unreadable' });
  });
  it('pools.json 없이 뿌리에 계정만 있다(암묵 풀) → pool', async () => {
    const env = await root({ dirs: ['acct-a'] });
    expect(await use(env)).toBe('pool');
  });
  it('아무것도 없다(뿌리 없음) → none → rust', async () => {
    const env = { HARKROOM_CLAUDE_ACCOUNTS_DIR: join(tmpdir(), `op-acct-none-${process.pid}-${Date.now()}`) } as NodeJS.ProcessEnv;
    expect(await use(env)).toBe('none');
    expect(pickRunner({ runner: 'rust' }, true, 'none', 'claude-code')).toEqual({ kind: 'rust' });
  });
  it('배정된 풀이 비었다(계정 0) → none — 러너도 그때 기본 로그인으로 돈다', async () => {
    const env = await root({ pools: { defaultPool: 'empty' }, dirs: ['empty'] });
    expect(await use(env)).toBe('none');
  });
  it('배정이 모르면(deps 에 claudeAccountUse 가 없으면) 닫힌 쪽: node', async () => {
    expect(pickRunner({ runner: 'rust' }, true, 'unreadable', 'claude-code').kind).toBe('node');
  });
});

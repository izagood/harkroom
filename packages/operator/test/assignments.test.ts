// 배정 조정기 — 스펙 2026-09-20 §3·§9. 서버의 `assign`/`unassign` 을 "이 머신에서 무엇을
// 띄우고 무엇을 내릴까"로 바꾼다. 실제 프로세스는 `runners.test.ts` 가 재고, 여기서는
// 결정만 잰다 — spawn·kill·시계·PAT 을 전부 주입한다.
import { describe, it, expect } from 'vitest';
import type { AgentDefinition } from '@harkroom/shared/operatorProtocol';
import { createAssignmentReconciler, type AssignmentDeps } from '../src/assignments.js';

const def = (agentId = 'a-1'): AgentDefinition => ({
  agentId, handle: 'murmur', harness: 'claude-code', instructions: '', model: null, effort: null,
  mentionPermission: 'auto', workingDirDefault: null, credentialScope: 'none', ownerAccountId: 'u-1', mcpServers: [],
});

function harness(over: Partial<AssignmentDeps> = {}) {
  const spawned: { agentId: string; env: Record<string, string> }[] = [];
  const signals: { agentId: string; signal: string }[] = [];
  const alive = new Set<string>();
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const pats = new Map<string, string>();
  let fetched = 0;
  const deps: AssignmentDeps = {
    spawn: async (agentId, env) => {
      if (alive.has(agentId)) return { spawned: false, pid: 1, runnerId: `r-${agentId}` };
      spawned.push({ agentId, env }); alive.add(agentId);
      return { spawned: true, pid: 1, runnerId: `r-${agentId}` };
    },
    signal: (agentId, signal) => { signals.push({ agentId, signal }); return alive.has(agentId); },
    isAlive: (agentId) => alive.has(agentId),
    listRunners: () => [...alive].map((agentId) => ({ agentId, runnerId: `r-${agentId}`, pid: 1 })),
    secrets: {
      getAgentPat: async (b, a) => pats.get(`${b}|${a}`) ?? null,
      setAgentPat: async (b, a, p) => { pats.set(`${b}|${a}`, p); },
    },
    fetchAgentPat: async () => { fetched += 1; return `hrkp_fetched${fetched}`; },
    loginPath: '/usr/bin:/bin',
    appVersion: '0.2.8',
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    log: () => {},
    ...over,
  };
  return { deps, spawned, signals, alive, timers, pats, fetched: () => fetched, exit: (agentId: string) => alive.delete(agentId) };
}

describe('assign', () => {
  it('PAT 을 받아 저장하고, HARKROOM_URL·PATH·AGENT_VERSION 과 함께 띄운다', async () => {
    const h = harness();
    const r = createAssignmentReconciler(h.deps);
    const outcome = await r.onAssign('https://example.com', def(), { workingDir: '~/dev/x' });
    expect(outcome).toBe('spawned');
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.env).toMatchObject({
      HARKROOM_URL: 'https://example.com', HARKROOM_PAT: 'hrkp_fetched1', PATH: '/usr/bin:/bin', AGENT_VERSION: '0.2.8',
    });
    expect(h.fetched()).toBe(1);
    expect(await h.deps.secrets.getAgentPat('https://example.com', 'a-1')).toBe('hrkp_fetched1');
  });
  it('저장된 PAT 이 있으면 다시 받지 않는다', async () => {
    const h = harness();
    await h.deps.secrets.setAgentPat('https://example.com', 'a-1', 'hrkp_saved');
    const r = createAssignmentReconciler(h.deps);
    await r.onAssign('https://example.com', def(), undefined);
    expect(h.fetched()).toBe(0);
    expect(h.spawned[0]!.env.HARKROOM_PAT).toBe('hrkp_saved');
  });
  it('이미 살아 있으면 새로 띄우지 않는다 — 멱등', async () => {
    const h = harness();
    const r = createAssignmentReconciler(h.deps);
    await r.onAssign('https://example.com', def(), undefined);
    expect(await r.onAssign('https://example.com', def(), undefined)).toBe('already');
    expect(h.spawned).toHaveLength(1);
  });
  it('PAT 을 못 받으면 failed 이고 띄우지 않는다', async () => {
    const h = harness({ fetchAgentPat: async () => { throw new Error('403'); } });
    const r = createAssignmentReconciler(h.deps);
    expect(await r.onAssign('https://example.com', def(), undefined)).toBe('failed');
    expect(h.spawned).toHaveLength(0);
  });
});

describe('러너 링크(스펙 §5) — spawn 마다 id 와 secret 을 새로 만든다', () => {
  it('링크가 있으면 소켓·id·secret 을 env 에 심고, spawn 전에 link.expect 를 부른다', async () => {
    const expected: { runnerId: string; agentId: string; secret: string }[] = [];
    const spawnedIds: string[] = [];
    const h = harness({
      spawn: async (_agentId, _env, runnerId) => { spawnedIds.push(runnerId); return { spawned: true, pid: 1, runnerId }; },
      link: { expect: (r, a, sec) => expected.push({ runnerId: r, agentId: a, secret: sec }), forget: () => {} },
      socketPath: '/tmp/op.sock',
    });
    const r = createAssignmentReconciler(h.deps);
    await r.onAssign('https://example.com', def(), undefined);
    await r.onAssign('https://example.com', def('a-2'), undefined);
    expect(expected).toHaveLength(2);
    expect(expected[0]!.agentId).toBe('a-1');
    expect(expected[0]!.runnerId).toBe(spawnedIds[0]);
    // 러너마다 다른 secret — 하나가 새도 다른 러너에는 쓸모없다.
    expect(expected[0]!.secret).not.toBe(expected[1]!.secret);
    expect(expected[0]!.secret.length).toBeGreaterThanOrEqual(32);
  });

  it('env 에 셋이 실리고, 러너가 이미 있으면 새 id 의 secret 은 잊는다', async () => {
    const expected: string[] = []; const forgotten: string[] = [];
    const h = harness({
      link: { expect: (r) => expected.push(r), forget: (r) => forgotten.push(r) },
      socketPath: '/tmp/op.sock',
    });
    const r = createAssignmentReconciler(h.deps);
    await r.onAssign('https://example.com', def(), undefined);
    const env = h.spawned[0]!.env;
    expect(env.HARKROOM_OPERATOR_SOCKET).toBe('/tmp/op.sock');
    expect(env.HARKROOM_RUNNER_ID).toBe(expected[0]);
    expect(env.HARKROOM_RUNNER_SECRET).toBeTruthy();
    // 두 번째 assign — 살아 있으므로 안 띄운다(harness 의 spawn 은 옛 id 를 돌려준다). 새로
    // 적은 secret 은 아무 러너도 안 쓰므로 지운다.
    await r.onAssign('https://example.com', def(), undefined);
    expect(forgotten).toEqual([expected[1]]);
  });

  it('링크가 없으면(단계 3 이전 배선) env 에 셋을 심지 않는다', async () => {
    const h = harness();
    const r = createAssignmentReconciler(h.deps);
    await r.onAssign('https://example.com', def(), undefined);
    expect(h.spawned[0]!.env.HARKROOM_RUNNER_ID).toBeUndefined();
  });
});

describe('unassign', () => {
  it('drain 이면 SIGTERM 을 보내고 상한 뒤 SIGKILL 을 예약한다 — 먼저 죽으면 취소', async () => {
    const h = harness();
    const r = createAssignmentReconciler({ ...h.deps, drainTimeoutMs: 1000 });
    await r.onAssign('https://example.com', def(), undefined);
    await r.onUnassign('https://example.com', 'a-1', true);
    expect(h.signals).toEqual([{ agentId: 'a-1', signal: 'SIGTERM' }]);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(1000);
    // 상한 안에 스스로 끝났다 → 예약된 SIGKILL 은 아무것도 하지 않는다.
    h.exit('a-1');
    h.timers[0]!.fn();
    expect(h.signals.filter((s) => s.signal === 'SIGKILL')).toHaveLength(0);
  });
  it('drain 상한을 넘기면 SIGKILL', async () => {
    const h = harness();
    const r = createAssignmentReconciler({ ...h.deps, drainTimeoutMs: 1000 });
    await r.onAssign('https://example.com', def(), undefined);
    await r.onUnassign('https://example.com', 'a-1', true);
    h.timers[0]!.fn();
    expect(h.signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
  it('drain 이 아니면 즉시 SIGTERM 뒤 짧은 유예로 SIGKILL', async () => {
    const h = harness();
    const r = createAssignmentReconciler({ ...h.deps, drainTimeoutMs: 1000, killGraceMs: 50 });
    await r.onAssign('https://example.com', def(), undefined);
    await r.onUnassign('https://example.com', 'a-1', false);
    expect(h.timers[0]!.ms).toBe(50);
  });
  it('안 띄운 에이전트의 unassign 은 아무것도 안 한다', async () => {
    const h = harness();
    const r = createAssignmentReconciler(h.deps);
    await r.onUnassign('https://example.com', 'nope', true);
    expect(h.signals).toEqual([]);
  });
});

describe('announce', () => {
  it('살아 있는 러너를 {agentId, runnerId, pid} 로 낸다', async () => {
    const h = harness();
    const r = createAssignmentReconciler(h.deps);
    await r.onAssign('https://example.com', def('a-1'), undefined);
    await r.onAssign('https://example.com', def('a-2'), undefined);
    expect(r.announce().map((a) => a.agentId).sort()).toEqual(['a-1', 'a-2']);
  });
});

describe('러너가 죽으면 — 배정이 살아 있는 동안은 다시 띄운다', () => {
  it('exit 뒤 백오프로 respawn 을 예약하고, 배정이 남아 있으면 띄운다', async () => {
    const h = harness();
    const r = createAssignmentReconciler({ ...h.deps, respawnBackoffMs: 100 });
    await r.onAssign('https://example.com', def(), undefined);
    h.exit('a-1');
    r.onRunnerExit('a-1', 1);
    expect(h.timers.at(-1)!.ms).toBe(100);
    h.timers.at(-1)!.fn();
    await new Promise((res) => setTimeout(res, 0));
    expect(h.spawned).toHaveLength(2);
  });
  it('unassign 된 뒤의 exit 은 다시 띄우지 않는다', async () => {
    const h = harness();
    const r = createAssignmentReconciler({ ...h.deps, respawnBackoffMs: 100 });
    await r.onAssign('https://example.com', def(), undefined);
    await r.onUnassign('https://example.com', 'a-1', true);
    h.exit('a-1');
    r.onRunnerExit('a-1', 143);
    const respawns = h.timers.filter((t) => t.ms === 100);
    expect(respawns).toHaveLength(0);
  });
  it('연속으로 죽으면 백오프가 늘고, 오래 살면 처음으로 돌아간다', async () => {
    let now = 0;
    const h = harness({ now: () => now } as Partial<AssignmentDeps>);
    const r = createAssignmentReconciler({ ...h.deps, respawnBackoffMs: 100, respawnCeilingMs: 400, now: () => now });
    await r.onAssign('https://example.com', def(), undefined);
    const fire = async () => { h.exit('a-1'); r.onRunnerExit('a-1', 1); h.timers.at(-1)!.fn(); await new Promise((res) => setTimeout(res, 0)); };
    await fire(); await fire(); await fire();
    expect(h.timers.filter((t) => t.ms >= 100).map((t) => t.ms)).toEqual([100, 200, 400]);
    now = 10 * 60_000; // 마지막 spawn 뒤 오래 살았다
    await fire();
    expect(h.timers.at(-1)!.ms).toBe(100);
  });
});

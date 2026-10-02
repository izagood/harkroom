/**
 * 회수 게이트 — **무엇을 기다리는가**(2026-09-28).
 *
 * 2026-09-22 사고: 앱이 갱신되며 오퍼레이터가 교체됐고, 턴이 돌던 러너 둘은 SIGTERM 을
 * 드레인으로 받아 살아남았다. 그 러너들은 **그 순간 이미 인박스 폴을 멈췄는데**, 게이트가
 * "프로세스가 죽었는가"를 물었기 때문에 교체 러너가 20~30분(턴 하나 길이) 동안 못 떴다.
 * 그동안 그 에이전트의 인박스는 아무도 안 봤다 — 멘션해도 오지 않았다.
 *
 * 그래서 판정 기준을 **"같은 인박스를 둘이 폴하지 않는다"** 로 바꿨다. 러너가 폴을 놓은
 * 순간 알려 주고(`runner.pollStopped`), 게이트는 그것을 듣는다.
 *
 * 여기서 재는 것은 셋이다:
 *  1. 알리기 **전에는** 예전 그대로 막는다 (옛 세대 러너와의 호환 = 순수한 덧셈)
 *  2. 알린 **뒤에는** 프로세스가 살아 있어도 교체가 뜬다 (공백이 사라진다)
 *  3. 그때 **앞 러너가 들고 있던 entry 가 교체 러너에게 전달된다** (중복 답변을 막는다)
 */
import { describe, expect, it } from 'vitest';

import { RunnerRegistry, type RunnerHost } from '../src/runners.js';
import type { IncarnationId } from '@harkroom/shared/daemonProtocol';

const LAUNCH = { command: '/bin/sh', args: ['-c', 'true'] };

/** 프로세스를 띄우지 않는 host. 생사는 집합 하나로 정한다 — 재는 것은 게이트의 판정뿐이다. */
function fakeHost(): RunnerHost & { alive: Set<number>; spawned: { env: Record<string, string> }[] } {
  const alive = new Set<number>();
  const spawned: { env: Record<string, string> }[] = [];
  let nextPid = 1000;
  return {
    alive,
    spawned,
    spawn(_cmd: string, _args: readonly string[], env: Record<string, string>) {
      const pid = ++nextPid;
      alive.add(pid);
      spawned.push({ env: env as Record<string, string> });
      // `ChildProcess` 의 최소 표면만 흉내낸다 — registry 가 쓰는 것은 pid 와 on 뿐이다.
      return { pid, on: () => {}, unref: () => {} } as never;
    },
    kill(pid: number, signal: NodeJS.Signals | 0) {
      if (signal === 0) return alive.has(pid);
      // SIGTERM 은 **안 죽인다.** 이 사고의 전제가 정확히 그것이다(턴이 남아 있으면 안 죽는다).
      return alive.has(pid);
    },
    now: () => 1,
    bootTimeSec: async () => 1_700_000_000,
  } as unknown as RunnerHost & { alive: Set<number>; spawned: { env: Record<string, string> }[] };
}

const inc = (s: string): IncarnationId => s as unknown as IncarnationId;

describe('회수 게이트 — 프로세스 생사가 아니라 인박스 소유', () => {
  it('폴을 놓았다고 알리기 전에는 막는다 — 옛 세대 러너에서는 예전 동작 그대로다', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));

    await expect(registry.spawnRunner('murmur', {})).rejects.toMatchObject({ code: 'retiring' });
    expect(host.spawned).toHaveLength(0);
  });

  it('폴을 놓았다고 알리면 앞 러너가 살아 있어도 교체가 뜬다 — 공백이 사라지는 자리다', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));

    registry.notePollStopped('murmur', inc('old'), []);

    const record = await registry.spawnRunner('murmur', {});
    expect(record.pid).toBeGreaterThan(0);
    // 앞 러너는 **아직 살아 있다** — 남은 턴을 마저 끝내는 중이다.
    expect(host.kill(62702, 0)).toBe(true);
  });

  it('앞 러너가 들고 있던 entry 가 교체 러너의 env 로 전달된다 — 같은 멘션에 두 번 답하지 않게', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));
    registry.notePollStopped('murmur', inc('old'), [41, 42]);

    await registry.spawnRunner('murmur', { PATH: '/usr/bin' });

    expect(host.spawned[0]?.env.HARKROOM_HANDOVER_HOLD).toBe('41,42');
  });

  /**
   * L2(2026-10-03, #1119 후속). 끝났는데 읽음 처리만 못 한 entry 는 `holding` 과 **다른 env** 로 간다 —
   * 섞으면 교체 러너가 보류 시한 동안만 건너뛰고 그 뒤 끝난 일에 두 번째 턴을 띄운다.
   * 되돌려 RED: `done` 을 `holding` 에 합치거나 버리면 아래 두 단언 중 하나가 깨진다.
   */
  it('앞 러너가 끝냈지만 읽음 처리 못 한 entry 는 HARKROOM_HANDOVER_DONE 으로 따로 전달된다', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));
    registry.notePollStopped('murmur', inc('old'), [41], [7, 8]);

    await registry.spawnRunner('murmur', { PATH: '/usr/bin' });

    expect(host.spawned[0]?.env.HARKROOM_HANDOVER_HOLD).toBe('41');
    expect(host.spawned[0]?.env.HARKROOM_HANDOVER_DONE).toBe('7,8');
  });

  it('done 만 있고 holding 이 없으면 HOLD 는 심지 않고 DONE 만 심는다', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));
    registry.notePollStopped('murmur', inc('old'), [], [9]);

    await registry.spawnRunner('murmur', {});

    expect(host.spawned[0]?.env.HARKROOM_HANDOVER_HOLD).toBeUndefined();
    expect(host.spawned[0]?.env.HARKROOM_HANDOVER_DONE).toBe('9');
  });

  it('들고 있는 것이 없으면 env 를 심지 않는다 — 없는 값을 빈 문자열로 넘기지 않는다', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));
    registry.notePollStopped('murmur', inc('old'), []);

    await registry.spawnRunner('murmur', {});

    expect(host.spawned[0]?.env.HARKROOM_HANDOVER_HOLD).toBeUndefined();
  });

  it('다른 세대의 통지는 무시한다 — 그 사이 회수 자리가 갈렸을 수 있다', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));

    registry.notePollStopped('murmur', inc('남의-세대'), [7]);

    await expect(registry.spawnRunner('murmur', {})).rejects.toMatchObject({ code: 'retiring' });
  });

  /**
   * 보류의 **주인은 오퍼레이터다**(2026-09-28, jaebin 지적). 러너에 env 로 목록만 주고
   * 시한으로 풀게 두면, 앞 러너가 1초 만에 끝나도 그 시한 내내 그 항목을 건너뛴다.
   * 앞 러너의 생사를 아는 쪽은 오퍼레이터뿐이므로, 푸는 것도 여기서 한다.
   *
   * 되돌려 RED: `reapRetiring` 의 `releaseHandover` 호출을 지우면 이 테스트만 빨개진다.
   */
  it('앞 러너가 물러나면 지금 세대에게 보류 해제를 알린다 — 시한을 기다리지 않는다', async () => {
    const host = fakeHost();
    const 해제: { agentId: string; runnerId: string }[] = [];
    const registry = new RunnerRegistry(LAUNCH, host, undefined, null, null,
      (agentId, runnerId) => { 해제.push({ agentId, runnerId }); });
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));
    registry.notePollStopped('murmur', inc('old'), [41]);
    await registry.spawnRunner('murmur', {});
    expect(해제).toEqual([]);

    // 앞 러너가 이제야 죽었다. 실제로 그것을 관측하는 자리는 주기적인 `pollAdopted` 다.
    host.alive.delete(62702);
    registry.pollAdopted();

    expect(해제).toHaveLength(1);
    expect(해제[0]?.agentId).toBe('murmur');
  });

  it('보류를 준 적이 없으면 해제도 알리지 않는다 — 없는 일을 알리지 않는다', async () => {
    const host = fakeHost();
    const 해제: unknown[] = [];
    const registry = new RunnerRegistry(LAUNCH, host, undefined, null, null,
      () => { 해제.push(1); });
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));
    host.alive.delete(62702);

    registry.pollAdopted();
    expect(해제).toEqual([]);
  });

  it('앞 러너가 죽으면 알림이 없어도 교체가 뜬다 — 예전 경로가 그대로 남아 있다', async () => {
    const host = fakeHost();
    const registry = new RunnerRegistry(LAUNCH, host);
    host.alive.add(62702);
    registry.retire('murmur', 62702, inc('old'));
    host.alive.delete(62702);

    const record = await registry.spawnRunner('murmur', {});
    expect(record.pid).toBeGreaterThan(0);
  });
});

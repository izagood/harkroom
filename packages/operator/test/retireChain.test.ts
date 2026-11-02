/**
 * 판이 **짧은 간격으로 두 번** 바뀔 때 회수 중인 러너를 잃지 않는다(2026-11-02).
 *
 * 첫 교체 때 회수(SIGTERM)를 받아 턴을 끝내던 러너가, 두 번째 교체 때 장부에 없었다 — 장부가
 * 표(`byAgent`)만 적었기 때문이다. 두 번째 오퍼레이터는 그 러너의 링크를 「모르는 러너」로 거절했고,
 * 러너는 다시 붙지 못해 열린 턴을 중단했다. 여기서 재는 것:
 *  1. 회수 중인 러너도 장부에 적힌다(이미 받은 「인박스를 놓았다」 목록과 함께)
 *  2. 다음 오퍼레이터는 그 줄을 채택하지 않고 `retiring` 으로 판정한다 — 지금 러너 줄과 다투지 않는다
 *  3. 다음 오퍼레이터는 회수 중인 러너를 **여럿** 들고, 교체 러너에 둘의 보류를 합쳐 심는다
 *  4. 보류 해제는 회수 중인 러너가 **모두** 물러난 뒤다
 */
import { describe, expect, it } from 'vitest';

import { planAdoption, type ProcessIdentityProbe } from '../src/adopt.js';
import type { RunnerLedgerEntry } from '../src/runnerLedger.js';
import { RunnerRegistry, type LedgerRow, type RunnerHost } from '../src/runners.js';
import type { IncarnationId } from '@harkroom/shared/daemonProtocol';

const LAUNCH = { command: '/bin/sh', args: ['-c', 'true'] };
const BOOT = 1_700_000_000;
const inc = (s: string): IncarnationId => s as unknown as IncarnationId;

/** 프로세스를 띄우지 않는 host — 생사는 집합 하나로 정한다. 두 오퍼레이터가 같은 집합을 본다. */
function fakeHost(alive: Set<number>, firstPid: number): RunnerHost & { spawned: { env: Record<string, string> }[] } {
  const spawned: { env: Record<string, string> }[] = [];
  let nextPid = firstPid;
  return {
    spawned,
    spawn(_cmd: string, _args: readonly string[], env: Record<string, string>) {
      const pid = ++nextPid;
      alive.add(pid);
      spawned.push({ env });
      return { pid, on: () => {}, unref: () => {} } as never;
    },
    // SIGTERM 은 안 죽인다 — 턴이 남은 러너는 드레인하며 살아 있다(이 사고의 전제).
    kill: (pid: number) => alive.has(pid),
    now: () => 1_000,
    bootTimeSec: async () => BOOT,
  } as unknown as RunnerHost & { spawned: { env: Record<string, string> }[] };
}

function probeOf(alive: Set<number>): ProcessIdentityProbe {
  return { alive: (pid) => alive.has(pid), bootTimeSec: async (pid) => (alive.has(pid) ? BOOT : null) };
}

/** run.ts 의 장부 창구와 같은 변환 — 회수 중인 줄은 자기 세대를, 나머지는 지금 세대를 적는다. */
function toLedger(rows: readonly LedgerRow[], appVersion: string): RunnerLedgerEntry[] {
  return rows.map((r) => ({
    agentId: r.agentId,
    pid: r.pid,
    incarnationId: r.incarnationId,
    startedAtMs: r.startedAtMs,
    bootTimeSec: r.bootTimeSec,
    ...(r.linkSecret ? { linkSecret: r.linkSecret } : {}),
    spawnedByNonce: 'n',
    spawnedByAppVersion: r.spawnedByAppVersion ?? appVersion,
    ...(r.retiring ? { retiring: r.retiring } : {}),
  }));
}

describe('판이 연달아 바뀌어도 회수 중인 러너를 잃지 않는다', () => {
  it('회수 중 러너가 장부에 남고, 다음 오퍼레이터가 그것을 다시 회수하며 보류를 합친다', async () => {
    const alive = new Set<number>([500]);
    const AGENT = 'tm';

    // ── 오퍼레이터 2(1.0.1): 1.0.0 러너(pid 500)를 회수하고 교체 러너를 띄운다 ──
    let rows2: readonly LedgerRow[] = [];
    const host2 = fakeHost(alive, 600);
    const op2 = new RunnerRegistry(LAUNCH, host2, () => undefined, { save: (r) => { rows2 = r; } });
    op2.retire(AGENT, 500, inc('old-a'), {
      ledger: { startedAtMs: 10, bootTimeSec: BOOT, linkSecret: 'sec-old', spawnedByAppVersion: '1.0.0' },
    });
    op2.notePollStopped(AGENT, inc('old-a'), [101, 103], [100]);
    const cur = await op2.spawnRunner(AGENT, { HARKROOM_RUNNER_SECRET: 'sec-cur' }, inc('cur-b'));
    expect(host2.spawned[0]?.env.HARKROOM_HANDOVER_HOLD).toBe('101,103');

    // 1. 장부에 둘 다 있다 — 회수 중인 줄은 놓은 목록과 secret 을 함께 싣는다.
    const ledger = toLedger(rows2, '1.0.1');
    expect(ledger.map((e) => e.pid).sort()).toEqual([500, cur.pid].sort());
    const 옛줄 = ledger.find((e) => e.pid === 500);
    expect(옛줄).toMatchObject({
      incarnationId: 'old-a',
      linkSecret: 'sec-old',
      spawnedByAppVersion: '1.0.0',
      retiring: { holding: [101, 103], done: [100] },
    });

    // ── 오퍼레이터 3(1.0.2): 장부를 읽는다 ──
    // 2. 회수 중 줄은 `retiring`, 지금 러너 줄은 `stale-generation` — 둘 다 판정되고 하나도 잊히지 않는다.
    const plan = await planAdoption(ledger, probeOf(alive), '1.0.2');
    expect(plan.adopt).toEqual([]);
    const 판정 = new Map(plan.rejected.map(({ entry, verdict }) => [entry.pid, verdict.kind]));
    expect(판정.get(500)).toBe('retiring');
    expect(판정.get(cur.pid)).toBe('stale-generation');

    // run.ts::adoptOrphans 와 같은 순서로 회수한다.
    const released: string[] = [];
    let rows3: readonly LedgerRow[] = [];
    const host3 = fakeHost(alive, 700);
    const op3 = new RunnerRegistry(
      LAUNCH, host3, () => undefined, { save: (r) => { rows3 = r; } }, null,
      (_agent, runnerId) => released.push(runnerId),
    );
    for (const { entry } of plan.rejected) {
      op3.retire(entry.agentId, entry.pid, entry.incarnationId, {
        ledger: { startedAtMs: entry.startedAtMs, bootTimeSec: entry.bootTimeSec, linkSecret: entry.linkSecret },
        ...(entry.retiring ? { pollStopped: entry.retiring } : {}),
      });
    }
    // 둘 다 hello 의 announce 에 실린다(링크를 받을 러너).
    expect(op3.retiringRunners().map((r) => r.incarnationId).sort()).toEqual(['cur-b', 'old-a']);
    // 3-a. 1.0.1 러너가 아직 폴을 놓지 않았다 — 교체는 기다린다(같은 인박스를 둘이 폴하지 않는다).
    await expect(op3.spawnRunner(AGENT, {})).rejects.toMatchObject({ code: 'retiring' });

    // 3-b. 놓으면 뜨고, 두 러너의 보류가 합쳐져 심긴다.
    op3.notePollStopped(AGENT, inc('cur-b'), [104], []);
    const next = await op3.spawnRunner(AGENT, {}, inc('next-c'));
    expect(host3.spawned[0]?.env.HARKROOM_HANDOVER_HOLD?.split(',').map(Number).sort()).toEqual([101, 103, 104]);
    expect(host3.spawned[0]?.env.HARKROOM_HANDOVER_DONE).toBe('100');
    // 판이 **또** 바뀌어도 이어지도록 장부에 셋 다 남는다.
    expect(rows3.filter((r) => r.retiring).map((r) => r.pid).sort()).toEqual([500, cur.pid].sort());
    expect(rows3.some((r) => r.pid === next.pid && !r.retiring)).toBe(true);

    // 4. 하나만 물러나면 보류를 풀지 않는다 — 남은 러너의 턴이 아직 돈다.
    alive.delete(cur.pid);
    op3.pollAdopted();
    expect(released).toEqual([]);
    alive.delete(500);
    op3.pollAdopted();
    expect(released).toEqual(['next-c']);
    expect(rows3.some((r) => r.retiring)).toBe(false);
  });

  it('죽은 회수 중 줄은 회수하지 않는다 — 무관한 프로세스에 SIGTERM 을 보내지 않는다', async () => {
    const ledger: RunnerLedgerEntry[] = [{
      agentId: 'a', pid: 900, incarnationId: inc('gone'), startedAtMs: 1, bootTimeSec: BOOT,
      spawnedByNonce: 'n', spawnedByAppVersion: '1.0.0', retiring: { holding: [], done: [] },
    }];
    const plan = await planAdoption(ledger, probeOf(new Set()), '1.0.2');
    expect(plan.rejected.map((r) => r.verdict.kind)).toEqual(['dead']);
  });
});

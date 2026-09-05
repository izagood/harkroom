/**
 * 러너 소유 — **실제 프로세스로 재는 것과 가짜로 재는 것을 나눠 둔다.**
 *
 * 프로세스 그룹과 생사는 **실물이 아니면 의미가 없다.** `detached: true` 를 넣었는지를
 * 모킹으로 재면 그 옵션이 실제로 무엇을 하는지는 아무도 확인하지 않은 채 초록이 된다 —
 * 그래서 이 파일은 진짜 자식을 띄우고 `ps` 로 PGID 를 읽는다.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { RunnerRegistry, nodeRunnerHost, type RunnerHost } from '../src/runners.js';

/** 오래 자는 자식. 러너 자리를 대신한다 — 우리가 재는 것은 프로세스 성질뿐이다. */
const SLEEPER = { command: '/bin/sh', args: ['-c', 'sleep 30'] };

const 정리할pid: number[] = [];
afterEach(() => {
  for (const pid of 정리할pid.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 죽었다 */
    }
  }
});

function pgidOf(pid: number): number {
  const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  return Number(out.trim());
}

describe('spawnRunner — 프로세스 그룹 분리 (#431 D2)', () => {
  /**
   * 회귀선 3. **spawn 한 러너는 자기 자신이 프로세스 그룹 리더다.**
   *
   * 실측(2026-09-05)이 이 회귀선의 근거다: 러너가 앱 그룹에 남아 있으면 `kill -TERM
   * -<그 그룹>` 한 번에 전부 죽는다. daemon 이 소유해도 같은 위험이 그대로 옮겨온다 —
   * daemon 의 그룹에 시그널이 가면 러너가 딸려 간다.
   *
   * 되돌려 RED: `nodeRunnerHost.spawn` 에서 `detached: true` 를 빼면 자식이 이 vitest
   * 프로세스의 그룹에 남아 `pgid !== pid` 가 된다.
   */
  it('spawn 한 러너는 자기 프로세스 그룹을 갖는다 (pgid === pid)', async () => {
    const registry = new RunnerRegistry(SLEEPER, nodeRunnerHost);
    const record = registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    expect(pgidOf(record.pid)).toBe(record.pid);
    // 이 테스트 프로세스의 그룹과 **다르다**는 것이 실측이 말한 핵심이다.
    expect(pgidOf(record.pid)).not.toBe(pgidOf(process.pid));
  });

  /**
   * 회귀선 4. **`alive` 는 실제 생사를 반영한다** — 죽은 pid 에 `false`.
   *
   * 자식 핸들의 상태가 아니라 `kill(pid, 0)` 으로 커널에게 직접 묻는다는 것이 요점이다.
   * 서버가 못 하는 말(`#428` 의 "실제로 종료했는지는 murmur 가 알 수 없다")을 daemon 이
   * 할 수 있는 근거가 이 한 줄이다.
   */
  it('alive 가 실제 생사를 반영한다 — 죽은 pid 에 false', async () => {
    const registry = new RunnerRegistry(SLEEPER, nodeRunnerHost);
    const record = registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    expect(registry.listRunners()[0]?.alive).toBe(true);

    // 실제로 죽인다(테스트에서는 즉시성이 필요하므로 SIGKILL 이다 — daemon 은 절대
    // 이러지 않는다. `killRunner.test.ts` 가 그것을 고정한다).
    process.kill(record.pid, 'SIGKILL');
    await 죽을때까지(record.pid);

    // 표에서 아직 안 빠진 상태의 `alive` 를 봐야 한다 — exit 이벤트가 표를 비우면 이
    // 회귀선이 잴 대상이 사라지므로, 표를 안 비우는 호스트로 같은 판정을 한 번 더 잰다.
    const 죽은호스트: RunnerHost = {
      spawn: () => ({ pid: record.pid, on: () => undefined }) as never,
      kill: nodeRunnerHost.kill,
      now: () => 0,
    };
    const 정지표 = new RunnerRegistry(SLEEPER, 죽은호스트);
    정지표.spawnRunner('a1', {});
    expect(정지표.listRunners()[0]?.alive).toBe(false);
  });

  /** 같은 에이전트에 살아 있는 러너가 있으면 **새로 띄우지 않는다**(중복 러너 금지). */
  it('살아 있는 러너가 있으면 같은 에이전트에 새로 띄우지 않는다', () => {
    const registry = new RunnerRegistry(SLEEPER, nodeRunnerHost);
    const first = registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(first.pid);
    const second = registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });

    expect(second.pid).toBe(first.pid);
    expect(second.incarnationId).toBe(first.incarnationId);
    expect(registry.size()).toBe(1);
  });
});

describe('runnerExit — 세대가 다른 exit (#431, #419)', () => {
  /**
   * 회귀선 6. **늦게 도착한 exit 이 새 세대를 지우지 않는다.**
   *
   * 옛 러너의 exit 통지가 새 러너가 뜬 뒤에 도착할 수 있고, 그때 `agentId` 만 보고 표를
   * 비우면 앱은 살아 있는 러너를 죽은 것으로 보고 또 하나를 띄운다 — 같은 에이전트에
   * 러너가 둘이면 멘션을 나눠 집어 간다.
   *
   * 되돌려 RED: `runners.ts` 의 exit 핸들러에서
   * `if (this.byAgent.get(agentId) === record)` 조건을 빼면 빨개진다.
   */
  it('늦게 도착한 옛 세대의 exit 이 새 세대를 표에서 지우지 않는다', () => {
    const 핸들러: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    let 다음pid = 100;
    const 죽인다: number[] = [];
    const host: RunnerHost = {
      spawn: () => {
        const pid = (다음pid += 1);
        return {
          pid,
          on: (_ev: string, fn: (c: number | null, s: NodeJS.Signals | null) => void) => {
            핸들러.push(fn);
          },
        } as never;
      },
      kill: (pid) => !죽인다.includes(pid),
      now: () => 0,
    };
    const 통지: { agentId: string; incarnationId: string }[] = [];
    const registry = new RunnerRegistry(SLEEPER, host, (n) => 통지.push(n));

    const 옛세대 = registry.spawnRunner('a1', {});
    죽인다.push(옛세대.pid); // 이제 죽은 것으로 보인다 — 새 spawn 이 허용된다.
    const 새세대 = registry.spawnRunner('a1', {});
    expect(새세대.incarnationId).not.toBe(옛세대.incarnationId);

    // **이제** 옛 세대의 exit 이 도착한다.
    핸들러[0]?.(0, null);

    // 표에는 새 세대가 그대로 남아 있어야 한다.
    expect(registry.currentIncarnation('a1')).toBe(새세대.incarnationId);
    expect(registry.listRunners()).toHaveLength(1);
    // 통지 자체는 나간다 — 거르는 것은 받는 쪽(`acceptRunnerExit`)의 일이고, 그 통지에
    // **어느 세대의 사실인지**가 실려 있어야 거를 수 있다.
    expect(통지).toEqual([
      { agentId: 'a1', incarnationId: 옛세대.incarnationId, code: 0, signal: null },
    ]);
  });

  /** exit 통지에는 항상 `incarnationId` 가 실린다 — 늦은 통지를 거를 유일한 축이다. */
  it('runnerExit 통지에 incarnationId 가 실린다', async () => {
    const 통지: { agentId: string; incarnationId: string; code: number | null }[] = [];
    const registry = new RunnerRegistry(
      { command: '/bin/sh', args: ['-c', 'exit 7'] },
      nodeRunnerHost,
      (n) => 통지.push(n),
    );
    const record = registry.spawnRunner('a1', {});
    정리할pid.push(record.pid);

    await 조건까지(() => 통지.length > 0);
    expect(통지[0]?.incarnationId).toBe(record.incarnationId);
    expect(통지[0]?.code).toBe(7);
  });
});

async function 죽을때까지(pid: number): Promise<void> {
  await 조건까지(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

async function 조건까지(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const 끝 = Date.now() + timeoutMs;
  while (Date.now() < 끝) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('조건이 시간 안에 성립하지 않았다');
}

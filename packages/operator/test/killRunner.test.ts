/**
 * **이 파일의 회귀선이 이 PR 에서 가장 중요하다.**
 *
 * 재는 것은 결과값이 아니라 **daemon 이 무엇을 보냈는가**다. "러너가 결국 죽었다"만 재는
 * 테스트로는 SIGKILL 승격이 들어와도 초록이 유지된다 — 승격을 넣어도 러너는 여전히
 * 죽고, 오히려 **더 빨리** 죽기 때문이다. 사라지는 것은 사람이 기다리던 답이지 테스트가
 * 보는 값이 아니다.
 *
 * 그래서 `RunnerHost.kill` 로 나간 시그널 목록 자체를 고정한다. 누가 유예 타이머를
 * 넣으면 그 목록에 `SIGKILL` 이 끼고 이 회귀선이 빨개진다.
 */
import { describe, expect, it, vi } from 'vitest';

import { RunnerRegistry, type RunnerHost } from '../src/runners.js';

/** 죽지 않는 러너. 실측에서 12초쯤 버틴 러너를 극단으로 민 것이다. */
function 안죽는러너호스트(): { host: RunnerHost; signals: (NodeJS.Signals | 0)[] } {
  const signals: (NodeJS.Signals | 0)[] = [];
  const host: RunnerHost = {
    spawn: () => ({ pid: 4242, on: () => undefined }) as never,
    kill: (_pid, signal) => {
      // `0` 은 생사 확인이지 시그널이 아니다 — 목록에는 남기되 아래에서 걸러 본다.
      signals.push(signal);
      return true; // **끝까지 살아 있다.**
    },
    now: () => 1000,
    // 회귀선은 pid 재사용을 안 잰다 — 그것은 `adopt.test.ts` 의 몫이다.
    bootTimeSec: () => Promise.resolve(null),
  };
  return { host, signals };
}

describe('killRunner — 회수가 아니다 (#431 2단계-b)', () => {
  /**
   * 회귀선 1. **SIGTERM 뒤 아무리 시간이 흘러도 SIGKILL 이 나가지 않는다.**
   *
   * 가짜 타이머로 시간을 크게 밀어 본다 — 어떤 유예 타이머가 걸려 있든 이 시간 안에
   * 터진다. 그래도 나간 시그널이 SIGTERM 하나뿐이어야 한다.
   *
   * 되돌려 RED: `RunnerRegistry.killRunner` 에
   * `setTimeout(() => this.host.kill(pid, 'SIGKILL'), 5000)` 을 넣으면 빨개진다.
   */
  it('SIGTERM 뒤 아무리 기다려도 SIGKILL 을 보내지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const { host, signals } = 안죽는러너호스트();
      const registry = new RunnerRegistry({ command: '/bin/true', args: [] }, host);
      await registry.spawnRunner('a1', {});
      registry.killRunner('a1');

      // 유예 타이머가 있었다면 이 안에 반드시 터진다(한 시간).
      vi.advanceTimersByTime(60 * 60 * 1000);
      vi.runAllTimers();

      const 보낸시그널 = signals.filter((s) => s !== 0);
      expect(보낸시그널).toEqual(['SIGTERM']);
      expect(보낸시그널).not.toContain('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 회귀선 1-b. **같은 러너에 kill 을 여러 번 보내도 승격하지 않는다.**
   *
   * "한 번 더 요청했으니 이번엔 강제로"는 자연스러워 보이는 다음 수순이고, 그래서 막는다.
   * 사람이 두 번 눌렀다는 사실이 러너가 지금 무엇을 들고 있는지를 바꾸지는 않는다.
   */
  it('kill 을 여러 번 보내도 SIGTERM 만 반복한다', async () => {
    const { host, signals } = 안죽는러너호스트();
    const registry = new RunnerRegistry({ command: '/bin/true', args: [] }, host);
    await registry.spawnRunner('a1', {});
    registry.killRunner('a1');
    registry.killRunner('a1');
    registry.killRunner('a1');

    expect(signals.filter((s) => s !== 0)).toEqual(['SIGTERM', 'SIGTERM', 'SIGTERM']);
  });

  /**
   * `termSentAtMs` 는 **처음 보낸 때**로 고정된다.
   *
   * 이 값이 kill 을 다시 부를 때마다 갱신되면 "보낸 지 N초 지났다"가 영원히 작아지고,
   * 사람이 승격을 판단할 근거가 사라진다 — daemon 이 판단하지 않기로 한 대신 사람에게
   * 넘긴 그 정보다.
   */
  it('termSentAtMs 는 처음 SIGTERM 을 보낸 때로 고정된다', async () => {
    const signals: (NodeJS.Signals | 0)[] = [];
    let now = 1000;
    const host: RunnerHost = {
      spawn: () => ({ pid: 4242, on: () => undefined }) as never,
      kill: (_pid, signal) => {
        signals.push(signal);
        return true;
      },
      now: () => now,
      // 회귀선은 pid 재사용을 안 잰다 — 그것은 `adopt.test.ts` 의 몫이다.
      bootTimeSec: () => Promise.resolve(null),
    };
    const registry = new RunnerRegistry({ command: '/bin/true', args: [] }, host);
    await registry.spawnRunner('a1', {});
    registry.killRunner('a1');
    now = 99_000;
    registry.killRunner('a1');

    expect(registry.listRunners()[0]?.termSentAtMs).toBe(1000);
  });

  /** 세대가 어긋난 kill 은 **지금 러너를 데려가지 않는다**(늦게 도착한 명령). */
  it('세대가 다른 kill 은 지금 러너에 시그널을 보내지 않는다', async () => {
    const { host, signals } = 안죽는러너호스트();
    const registry = new RunnerRegistry({ command: '/bin/true', args: [] }, host);
    await registry.spawnRunner('a1', {});

    expect(registry.killRunner('a1', '옛-세대')).toBeNull();
    expect(signals.filter((s) => s !== 0)).toEqual([]);
  });
});

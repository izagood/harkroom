/**
 * 종료 — **daemon 이 죽어도 러너는 산다.** `#431` 의 요점이다.
 *
 * 두 층위로 잰다:
 *
 * 1. 종료 경로가 러너에 **시그널을 보내지 않는다**(단위) — "안 보낸다"를 직접 고정한다
 * 2. daemon 프로세스를 실제로 죽여도 러너가 **살아남고 재부모화된다**(실물)
 *
 * 1번만으로는 부족하다. 시그널을 안 보내도 러너가 daemon 의 프로세스 그룹에 남아 있으면
 * 그룹 시그널 한 번에 함께 죽는다 — 실측(2026-09-05)이 정확히 그것을 보였다. 2번이
 * `detached` 와 종료 경로가 **함께** 성립하는지를 잰다.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { daemonEndpointPaths } from '@murmur/shared/daemonEndpoint';

import { startDaemon } from '../src/run.js';
import type { RunnerHost } from '../src/runners.js';

const 임시들: string[] = [];
const 정리할pid: number[] = [];

afterEach(async () => {
  for (const dir of 임시들.splice(0)) await rm(dir, { recursive: true, force: true });
  for (const pid of 정리할pid.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 죽었다 */
    }
  }
});

describe('daemon 종료 — 러너를 데려가지 않는다 (#431)', () => {
  /**
   * 회귀선 2-a. **종료 경로가 러너에 시그널을 보내지 않는다.**
   *
   * `RunnerHost.kill` 로 나간 시그널 목록을 그대로 본다 — "러너가 여전히 살아 있다"만
   * 재면 daemon 이 SIGTERM 을 보냈는데 러너가 아직 안 죽은 상태와 구분되지 않는다.
   *
   * 되돌려 RED: `run.ts` 의 `shutdown` 에 러너 정리(`registry.killRunner(...)` 순회 등)를
   * 넣으면 목록에 시그널이 끼고 빨개진다.
   */
  it('shutdown 이 러너에 아무 시그널도 보내지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'murmur-daemon-shutdown-'));
    임시들.push(dir);
    const 보낸시그널: (NodeJS.Signals | 0)[] = [];
    const host: RunnerHost = {
      spawn: () => ({ pid: 7777, on: () => undefined }) as never,
      kill: (_pid, signal) => {
        보낸시그널.push(signal);
        return true;
      },
      now: () => 0,
    };
    const paths = daemonEndpointPaths(dir);
    const outcome = await startDaemon({
      args: { socket: paths.socketPath, entryPath: join(dir, 'd'), appVersion: 't', unknown: [] },
      host,
      runnerCommand: '/bin/sh',
      log: () => undefined,
    });
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    outcome.daemon.registry.spawnRunner('a1', {});
    보낸시그널.length = 0; // spawn 중의 생사 확인(`kill(pid, 0)`)은 관심 밖이다.

    await outcome.daemon.shutdown();

    expect(보낸시그널.filter((s) => s !== 0)).toEqual([]);
  });

  /** 종료는 엔드포인트를 **정리한다** — 잔해를 남기면 다음 daemon 이 3중 증거를 다 밟아야 한다. */
  it('shutdown 이 소켓·pid·토큰을 걷어낸다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'murmur-daemon-release-'));
    임시들.push(dir);
    const paths = daemonEndpointPaths(dir);
    const outcome = await startDaemon({
      args: { socket: paths.socketPath, entryPath: join(dir, 'd'), appVersion: 't', unknown: [] },
      host: { spawn: () => ({ pid: 1, on: () => undefined }) as never, kill: () => true, now: () => 0 },
      runnerCommand: '/bin/sh',
      log: () => undefined,
    });
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    await outcome.daemon.shutdown();

    const { existsSync } = await import('node:fs');
    expect(existsSync(paths.socketPath)).toBe(false);
    expect(existsSync(paths.pidPath)).toBe(false);
    expect(existsSync(paths.tokenPath)).toBe(false);
  });

  /**
   * 회귀선 2-b — **실물.** daemon 프로세스를 실제로 죽이고 러너가 사는지 본다.
   *
   * daemon 을 자식으로 띄우고, 그 daemon 이 러너를 spawn 하게 한 다음, daemon 에
   * SIGTERM 을 보낸다. 러너는 살아 있어야 하고 **`ppid` 가 1 로 바뀌어야** 한다
   * (재부모화 — 부모가 사라졌다는 증거).
   *
   * 되돌려 RED: `nodeRunnerHost.spawn` 에서 `detached: true` 를 빼거나 종료 경로에 러너
   * 정리를 넣으면 러너가 함께 죽는다.
   */
  it('daemon 프로세스를 죽여도 러너가 살아남고 재부모화된다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'murmur-daemon-outlive-'));
    임시들.push(dir);
    const paths = daemonEndpointPaths(dir);

    // daemon 을 이 프로세스의 자식으로 띄운다 — 러너의 조부모가 이 테스트다.
    // `main.ts` 대신 작은 하네스를 쓰는 이유: 그쪽은 인자를 프로세스 명령줄로 받는데,
    // 이 회귀선이 재려는 것은 **종료 경로와 `detached` 가 함께 성립하는가**이지 인자
    // 파싱이 아니다. `run.ts` 를 직접 부르면 그 성질만 남는다.
    // (TS 를 그대로 실행하려고 `tsx` 를 쓴다 — 그래서 이 패키지의 devDependency 다.)
    const 하네스 = join(dir, 'harness.mjs');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      하네스,
      [
        `import { startDaemon } from ${JSON.stringify(new URL('../src/run.ts', import.meta.url).href)};`,
        `const outcome = await startDaemon({`,
        `  args: { socket: ${JSON.stringify(paths.socketPath)}, entryPath: '/tmp/d', appVersion: 't', unknown: [] },`,
        `  runnerCommand: '/bin/sh',`,
        `  runnerArgs: ['-c', 'sleep 120'],`,
        `  log: () => undefined,`,
        `});`,
        `if (outcome.kind !== 'running') { console.log('FAIL ' + outcome.kind); process.exit(1); }`,
        // 오래 자는 러너를 띄우고 pid 를 알린다.
        `const rec = outcome.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH });`,
        `console.log('RUNNER ' + rec.pid);`,
        // **러너를 데려가지 않는 종료 경로**를 그대로 쓴다(main.ts 와 같은 것).
        `process.on('SIGTERM', () => { outcome.daemon.shutdown().then(() => process.exit(0)); });`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
      'utf8',
    );

    const daemon자식 = spawn(
      process.execPath,
      ['--import', 'tsx', 하네스],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    정리할pid.push(daemon자식.pid ?? -1);

    const 러너pid = await new Promise<number>((resolve, reject) => {
      let buf = '';
      const 타이머 = setTimeout(() => reject(new Error(`daemon 이 러너를 안 알렸다: ${buf}`)), 30_000);
      daemon자식.stdout.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        const m = /RUNNER (\d+)/.exec(buf);
        if (m) {
          clearTimeout(타이머);
          resolve(Number(m[1]));
        }
      });
      daemon자식.stderr.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
      });
    });
    정리할pid.push(러너pid);

    expect(pgidOf(러너pid)).toBe(러너pid); // 자기 그룹에 있다.
    const daemonPgid = pgidOf(daemon자식.pid!);
    expect(pgidOf(러너pid)).not.toBe(daemonPgid);

    // ── daemon 을 죽인다 ────────────────────────────────────────────────────
    daemon자식.kill('SIGTERM');
    await 조건까지(() => !살아있나(daemon자식.pid!));

    // **러너는 살아 있어야 한다.**
    expect(살아있나(러너pid)).toBe(true);
    // 그리고 재부모화됐어야 한다 — 부모가 사라졌다는 증거다.
    await 조건까지(() => ppidOf(러너pid) === 1);
    expect(ppidOf(러너pid)).toBe(1);
  }, 60_000);
});

function pgidOf(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

function ppidOf(pid: number): number {
  try {
    return Number(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
    );
  } catch {
    return -1;
  }
}

function 살아있나(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function 조건까지(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const 끝 = Date.now() + timeoutMs;
  while (Date.now() < 끝) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('조건이 시간 안에 성립하지 않았다');
}

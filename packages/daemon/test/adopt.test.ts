/**
 * 고아 재발견 — `#431` 2단계-c 의 회귀선.
 *
 * 다섯 가지를 잰다:
 *
 * 1. **고아를 찾아 소유한다** — daemon 이 죽고 새로 떠도 그 러너를 안다 (실물 프로세스)
 * 2. **중복을 안 띄운다** — 채택한 에이전트에 `spawnRunner` 가 와도 새로 안 띄운다
 * 3. **죽은 pid 를 채택하지 않는다** — 장부에 남아 있어도 `kill(pid,0)` 이 실패하면 무시
 * 4. **pid 재사용을 구분한다** — 같은 pid, 다른 시작 시각이면 채택하지 않는다
 * 5. **남의 러너를 채택하지 않는다** — 같은 실행 경로의 프로세스가 여럿이어도 장부에
 *    적힌 것만 채택한다
 *
 * ## 왜 실물 프로세스를 쓰는가
 *
 * 1·2·5 는 **프로세스가 실제로 있어야 의미가 있다.** `kill(pid, 0)` 을 모킹하면 "장부를
 * 읽어 표에 넣는다"만 확인되고, 그 표의 pid 가 진짜 살아 있는 프로세스인지는 아무도 안
 * 본다. 4 만 예외인데, pid 재사용은 실물로는 pid 가 한 바퀴(macOS 기본 99998)를 돌아야
 * 나와서 만들 방법이 없다 — 그래서 `identityProbe` 주입으로 그 상황을 직접 세운다.
 *
 * ## 도그푸딩 스택과의 격리
 *
 * 모든 daemon 이 `mkdtemp` 로 만든 임시 `appDataDir` 를 쓴다. 장부도 소켓도 거기 산다 —
 * 이 회귀선이 이 기계의 다른 murmur 스택(앱·daemon·러너)을 볼 방법이 없다.
 */
import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { connect } from 'node:net';

import { DAEMON_PROTOCOL_VERSION, daemonEndpointPaths } from '@murmur/shared/daemonEndpoint';
import { NdjsonDecoder, encodeLine } from '@murmur/shared/daemonProtocol';

import { judgeCandidate, planAdoption, type ProcessIdentityProbe } from '../src/adopt.js';
import {
  readRunnerLedger,
  runnerLedgerPath,
  writeRunnerLedger,
  type RunnerLedgerEntry,
} from '../src/runnerLedger.js';
import { startDaemon, type StartOutcome } from '../src/run.js';

const 임시들: string[] = [];
const 내릴것들: (() => Promise<void>)[] = [];
const 정리할pid: number[] = [];

afterEach(async () => {
  for (const down of 내릴것들.splice(0)) await down().catch(() => undefined);
  for (const pid of 정리할pid.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 죽었다 */
    }
  }
  // 장부 쓰기가 fire-and-forget 이라(`run.ts` 의 `ledgerSink`) 테스트가 끝난 뒤에도 한
  // 번 더 착지할 수 있다. 그러면 방금 지운 디렉터리에 파일이 다시 생겨 `rmdir` 이
  // `ENOTEMPTY` 로 실패한다 — 정리 실패이지 회귀 실패가 아니므로 한 번 더 시도한다.
  for (const dir of 임시들.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function 임시앱디렉터리(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'murmur-adopt-'));
  임시들.push(dir);
  return dir;
}

/** 오래 자는 자식. 러너 자리를 대신한다 — 재는 것은 프로세스 성질뿐이다. */
const SLEEP_SEC = 120;

async function daemon띄우기(
  appDataDir: string,
  extra: Partial<Parameters<typeof startDaemon>[0]> = {},
): Promise<StartOutcome> {
  const paths = daemonEndpointPaths(appDataDir);
  const outcome = await startDaemon({
    args: {
      socket: paths.socketPath,
      launchNonce: 'test-nonce',
      entryPath: join(appDataDir, 'murmur-daemon'),
      appVersion: '0.0.0-test',
      unknown: [],
    },
    runnerCommand: '/bin/sh',
    runnerArgs: ['-c', `sleep ${SLEEP_SEC}`],
    log: () => undefined,
    ...extra,
  });
  if (outcome.kind === 'running') 내릴것들.push(() => outcome.daemon.shutdown());
  return outcome;
}

function 살아있나(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function 시작시각초(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const ms = Date.parse(out);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  } catch {
    return null;
  }
}

/**
 * 소켓에 붙어 `hello` 까지 마친 클라이언트. 서버 쪽 로그 자리를 밟으려면 실물 소켓이
 * 필요하다 — 레지스트리를 직접 부르면 `server.ts` 의 로그 분기를 지나가지 않는다.
 */
async function 인증된클라이언트(appDataDir: string, socketPath: string) {
  const token = (await readFile(daemonEndpointPaths(appDataDir).tokenPath, 'utf8')).trim();
  const sock = connect(socketPath);
  const decoder = new NdjsonDecoder();
  const 받은: Record<string, unknown>[] = [];
  sock.on('data', (c: Buffer) => {
    for (const line of decoder.push(c)) if (line.ok) 받은.push(line.value as Record<string, unknown>);
  });
  await new Promise<void>((res, rej) => {
    sock.once('connect', () => res());
    sock.once('error', rej);
  });
  sock.write(encodeLine({ type: 'hello', version: DAEMON_PROTOCOL_VERSION, token, role: 'app' }));
  await 조건까지(() => 받은.length >= 1);
  return {
    보낸다: (msg: unknown) => sock.write(encodeLine(msg)),
    // `hello` 응답이 0번이므로 n번째 응답은 `받은[n]` 이다.
    받는다: async (n: number) => {
      await 조건까지(() => 받은.length > n);
      return 받은[n] as { ok: boolean; payload?: unknown; error?: unknown };
    },
    닫는다: () => sock.destroy(),
  };
}

async function 조건까지(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const 끝 = Date.now() + timeoutMs;
  while (Date.now() < 끝) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('조건이 시간 안에 성립하지 않았다');
}

// ---------------------------------------------------------------------------
// 회귀선 1 — 고아를 찾아 소유한다
// ---------------------------------------------------------------------------

describe('고아 재발견 — daemon 이 죽고 새로 떠도 그 러너를 안다 (#431 2-c)', () => {
  /**
   * **회귀선 1.** 이 파일의 핵심이다.
   *
   * daemon 을 띄워 러너를 spawn 하고, **daemon 만 내린다**(`shutdown`). 러너는
   * `setsid` 로 분리돼 있어 살아남는다(1단계의 결과). 그 뒤 같은 `appDataDir` 에
   * 새 daemon 을 띄우면 **장부를 읽어 그 러너를 표에 올려야 한다.**
   *
   * 되돌려 RED (실제로 실행해 확인함):
   * - `run.ts` 에서 `const adoptedAtStartup = await adoptOrphans();` 를
   *   `{ adopted: [], rejected: [] }` 로 바꾸면 `listRunners()` 가 빈 배열이 되어 빨개진다
   * - `runners.ts` 의 `spawnRunner` 에서 `this.saveLedger()` 를 빼도 같은 자리가 빨개진다
   *   (장부가 안 써지면 다음 daemon 에게 후보가 없다)
   */
  it('daemon 을 내리고 새로 띄우면 살아남은 러너를 채택한다', async () => {
    const dir = await 임시앱디렉터리();

    const 첫daemon = await daemon띄우기(dir);
    if (첫daemon.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const 러너 = await 첫daemon.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(러너.pid);
    expect(살아있나(러너.pid)).toBe(true);

    // 장부가 실제로 디스크에 놓였는지 확인한다 — 이것이 재발견의 유일한 근거다.
    const 장부 = await 조건까지장부(dir, 1);
    expect(장부[0]?.agentId).toBe('a1');
    expect(장부[0]?.pid).toBe(러너.pid);
    // **커널 시작 시각이 실제로 담겼다** — pid 재사용 방어의 축이다.
    expect(장부[0]?.bootTimeSec).toBe(시작시각초(러너.pid));

    // ── daemon 만 내린다. 러너는 그대로다 ─────────────────────────────────────
    await 첫daemon.daemon.shutdown();
    expect(살아있나(러너.pid)).toBe(true);

    // ── 새 daemon ────────────────────────────────────────────────────────────
    const 새daemon = await daemon띄우기(dir);
    if (새daemon.kind !== 'running') throw new Error('새 daemon 이 안 떴다');

    expect(새daemon.daemon.adoptedAtStartup.adopted).toHaveLength(1);
    const 채택 = 새daemon.daemon.adoptedAtStartup.adopted[0]!;
    expect(채택.agentId).toBe('a1');
    expect(채택.pid).toBe(러너.pid);
    // **`incarnationId` 가 그대로다** — 새로 만들면 앱의 `killRunner` 가 세대 불일치로
    // 조용히 거절된다(`RunnerRegistry.adopt` 주석).
    expect(채택.incarnationId).toBe(러너.incarnationId);
    expect(채택.adopted).toBe(true);

    // 표에도 올라 있다.
    const 목록 = 새daemon.daemon.registry.listRunners();
    expect(목록).toHaveLength(1);
    expect(목록[0]?.pid).toBe(러너.pid);
    expect(목록[0]?.alive).toBe(true);
    expect(목록[0]?.adopted).toBe(true);
  }, 30_000);

  /**
   * **회귀선 2.** 채택한 러너에 `spawnRunner` 가 와도 **새로 띄우지 않는다.**
   *
   * 이것이 `#430` 이 관측한 중복의 정확한 자리다: daemon 이 재시작하면 표가 비어 있고,
   * 앱이 `spawnRunner` 를 부르면 이미 도는 러너 옆에 하나가 더 뜬다. 같은 에이전트에
   * 러너가 둘이면 서버의 멘션을 나눠 집어 간다.
   *
   * 되돌려 RED: `runners.ts` 의 `spawnRunner` 첫머리 `if (existing && ...) return existing;`
   * 를 빼면 새 pid 가 떠서 빨개진다.
   */
  it('채택한 에이전트에 spawnRunner 가 와도 새로 띄우지 않는다', async () => {
    const dir = await 임시앱디렉터리();
    const 첫daemon = await daemon띄우기(dir);
    if (첫daemon.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const 러너 = await 첫daemon.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(러너.pid);
    await 조건까지장부(dir, 1);
    await 첫daemon.daemon.shutdown();

    const 새daemon = await daemon띄우기(dir);
    if (새daemon.kind !== 'running') throw new Error('새 daemon 이 안 떴다');
    expect(새daemon.daemon.adoptedAtStartup.adopted).toHaveLength(1);

    // **앱이 모르고 다시 부른다** — 정확히 실사용의 순서다.
    const 다시 = await 새daemon.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(다시.pid);

    expect(다시.pid).toBe(러너.pid); // 새 프로세스가 아니라 채택한 그것이다.
    expect(새daemon.daemon.registry.size()).toBe(1);
  }, 30_000);

  /**
   * 채택한 러너에 **`killRunner` 가 실제로 동작한다.**
   *
   * 채택 레코드에는 `child` 핸들이 없다(`null`). 그 갈래에서 `killRunner` 가 pid 를 안
   * 쓰고 핸들만 보도록 짜였다면 여기서 빨개진다 — SIGTERM 이 아무 데도 안 간다.
   */
  it('채택한 러너에 killRunner 가 동작한다', async () => {
    const dir = await 임시앱디렉터리();
    const 첫daemon = await daemon띄우기(dir);
    if (첫daemon.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const 러너 = await 첫daemon.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(러너.pid);
    await 조건까지장부(dir, 1);
    await 첫daemon.daemon.shutdown();

    const 새daemon = await daemon띄우기(dir, { adoptedPollMs: 30 });
    if (새daemon.kind !== 'running') throw new Error('새 daemon 이 안 떴다');

    const rec = 새daemon.daemon.registry.killRunner('a1', 러너.incarnationId);
    expect(rec).not.toBeNull();
    expect(rec?.termSentAtMs).not.toBeNull();

    // `sleep` 은 SIGTERM 으로 죽는다 — 실제로 죽었는지가 요점이다.
    await 조건까지(() => !살아있나(러너.pid));
    // 그리고 폴링이 그것을 알아채 표에서 뺀다(채택한 러너에는 SIGCHLD 가 안 온다).
    await 조건까지(() => 새daemon.daemon.registry.size() === 0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 회귀선 3·4 — 죽은 pid · pid 재사용
// ---------------------------------------------------------------------------

describe('채택 판정 — 확실하지 않으면 채택하지 않는다 (#431 2-c)', () => {
  const 후보 = (over: Partial<RunnerLedgerEntry> = {}): RunnerLedgerEntry => ({
    agentId: 'a1',
    pid: 424242,
    incarnationId: 'inc-1',
    startedAtMs: 1000,
    bootTimeSec: 500,
    spawnedByNonce: 'n1',
    ...over,
  });

  /**
   * **회귀선 3.** 장부에 남아 있어도 `kill(pid, 0)` 이 실패하면 채택하지 않는다.
   *
   * 되돌려 RED: `adopt.ts` 의 `judgeCandidate` 첫 줄
   * `if (!probe.alive(entry.pid)) return { kind: 'dead' };` 을 빼면 죽은 pid 가
   * `adopt` 로 흘러 빨개진다.
   */
  it('죽은 pid 는 채택하지 않는다', async () => {
    const probe: ProcessIdentityProbe = {
      alive: () => false,
      bootTimeSec: () => Promise.resolve(500),
    };
    expect(await judgeCandidate(후보(), probe)).toEqual({ kind: 'dead' });
  });

  /**
   * **회귀선 4.** 같은 pid 를 **다른 프로세스**가 갖고 있으면 채택하지 않는다.
   *
   * 실물로는 만들 수 없는 상황이다 — pid 가 한 바퀴 돌아야 한다. 그래서 `probe` 로
   * "살아는 있는데 커널 시작 시각이 다르다"를 직접 세운다. 그것이 pid 재사용의 정의다.
   *
   * 되돌려 RED: `judgeCandidate` 의 `if (actual !== entry.bootTimeSec)` 를 빼면
   * `adopt` 가 돌아와 빨개진다 — 그리고 그 결함은 실제로 **무관한 프로세스에 SIGTERM 을
   * 보낸다.**
   */
  it('pid 가 재사용됐으면(시작 시각이 다르면) 채택하지 않는다', async () => {
    const probe: ProcessIdentityProbe = {
      alive: () => true,
      // 장부에는 500, 지금 그 pid 의 시작 시각은 9999 — 다른 프로세스다.
      bootTimeSec: () => Promise.resolve(9999),
    };
    expect(await judgeCandidate(후보({ bootTimeSec: 500 }), probe)).toEqual({
      kind: 'pid-reused',
      expected: 500,
      actual: 9999,
    });
  });

  /**
   * 장부에 시작 시각이 없으면(**옛 기록·`ps` 가 막힌 환경·Windows**) 채택하지 않는다.
   *
   * 대조할 축이 없으면 pid 재사용을 가릴 수 없고, 가릴 수 없는 것을 채택하면 남의
   * 프로세스를 죽일 수 있다. 안 채택하는 대가는 중복 러너 하나이고 그것은 복구 가능하다.
   */
  it('장부에 커널 시작 시각이 없으면 채택하지 않는다', async () => {
    const probe: ProcessIdentityProbe = {
      alive: () => true,
      bootTimeSec: () => Promise.resolve(500),
    };
    const verdict = await judgeCandidate(후보({ bootTimeSec: null }), probe);
    expect(verdict.kind).toBe('unverifiable');
  });

  /** 살아 있다고 했는데 시작 시각을 못 읽는 것도 **확인 못 한 것**이다. */
  it('살아 있는데 시작 시각을 못 읽으면 채택하지 않는다', async () => {
    const probe: ProcessIdentityProbe = {
      alive: () => true,
      bootTimeSec: () => Promise.resolve(null),
    };
    const verdict = await judgeCandidate(후보(), probe);
    expect(verdict.kind).toBe('pid-reused');
  });

  /** 같은 에이전트에 낡은 줄이 남아 있으면 **최신 하나만** 채택한다. */
  it('같은 에이전트에 항목이 둘이면 최신 하나만 채택한다', async () => {
    const probe: ProcessIdentityProbe = {
      alive: () => true,
      bootTimeSec: () => Promise.resolve(500),
    };
    const plan = await planAdoption(
      [후보({ pid: 111, startedAtMs: 1000 }), 후보({ pid: 222, startedAtMs: 2000 })],
      probe,
    );
    expect(plan.adopt).toHaveLength(1);
    expect(plan.adopt[0]?.pid).toBe(222);
    expect(plan.rejected).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 회귀선 5 — 남의 러너를 채택하지 않는다
// ---------------------------------------------------------------------------

describe('안전 경계 — 남의 러너를 채택하지 않는다 (#431 2-c)', () => {
  /**
   * **회귀선 5.** 이 설계의 안전 경계다.
   *
   * 실측(2026-09-06)이 이 회귀선의 근거다: 이 기계에 `murmur-runner` 고아가 6개 이상
   * 떠 있고 **전부 `ppid=1` 이며 실행 경로가 완전히 같다.** 프로세스 목록을 훑는 구현은
   * 그것들을 자기 러너로 착각할 수 있고, 착각한 러너는 `killRunner` 의 대상이 된다.
   *
   * 여기서는 **같은 실행 경로의 프로세스를 넷 띄우고 장부에는 하나만 적는다.**
   * 채택되는 것은 그 하나여야 한다.
   *
   * 되돌려 RED: 후보를 장부가 아니라 프로세스 목록에서 가져오도록 바꾸면(예:
   * `pgrep -f <러너 경로>` 결과를 `planAdoption` 에 넣으면) 넷 다 채택돼 빨개진다.
   */
  it('같은 실행 경로의 프로세스가 여럿이어도 장부에 적힌 것만 채택한다', async () => {
    const dir = await 임시앱디렉터리();

    // ── 같은 경로·같은 인자로 넷을 띄운다 ────────────────────────────────────
    // 실측의 permit 러너 6개가 정확히 이 모양이다: 같은 실행 파일, 같은 인자, 전부 고아.
    const 가짜러너: ChildProcess[] = [];
    for (let i = 0; i < 4; i += 1) {
      const child = nodeSpawn('/bin/sh', ['-c', `sleep ${SLEEP_SEC}`], {
        detached: true,
        stdio: 'ignore',
      });
      가짜러너.push(child);
      정리할pid.push(child.pid!);
    }
    await 조건까지(() => 가짜러너.every((c) => typeof c.pid === 'number' && 살아있나(c.pid)));

    // 장부에는 **하나만** 적는다 — daemon 이 자기 손으로 띄운 그 하나라는 뜻이다.
    const 내것 = 가짜러너[2]!;
    await mkdir(join(dir, 'daemon'), { recursive: true });
    await writeRunnerLedger(dir, [
      {
        agentId: 'a1',
        pid: 내것.pid!,
        incarnationId: 'inc-mine',
        startedAtMs: Date.now(),
        bootTimeSec: 시작시각초(내것.pid!),
        spawnedByNonce: 'n1',
      },
    ]);

    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');

    // **하나만 채택됐다.**
    expect(outcome.daemon.adoptedAtStartup.adopted).toHaveLength(1);
    expect(outcome.daemon.adoptedAtStartup.adopted[0]?.pid).toBe(내것.pid);

    // 나머지 셋은 표에 없다 — 즉 `killRunner` 로 죽일 수 없다.
    const 표에있는pid = outcome.daemon.registry.listRunners().map((r) => r.pid);
    expect(표에있는pid).toEqual([내것.pid]);
    for (const c of 가짜러너) {
      if (c.pid === 내것.pid) continue;
      expect(표에있는pid).not.toContain(c.pid);
      expect(살아있나(c.pid!)).toBe(true); // 아무도 건드리지 않았다.
    }
  }, 30_000);

  /**
   * **다른 `appDataDir` 의 장부는 아예 안 본다.**
   *
   * 실측의 permit 러너들이 이 자리에 해당한다 — 다른 워크트리의 앱은 다른 앱 데이터
   * 디렉터리를 쓴다. 그 장부에 무엇이 적혀 있든 이 daemon 의 후보가 되지 않는다.
   */
  it('다른 appDataDir 의 장부는 후보가 되지 않는다', async () => {
    const 남의dir = await 임시앱디렉터리();
    const 내dir = await 임시앱디렉터리();

    const 남의러너 = nodeSpawn('/bin/sh', ['-c', `sleep ${SLEEP_SEC}`], {
      detached: true,
      stdio: 'ignore',
    });
    정리할pid.push(남의러너.pid!);
    await 조건까지(() => 살아있나(남의러너.pid!));

    // 남의 장부에는 살아 있는 러너가 제대로 적혀 있다 — **그래도 안 본다.**
    await writeRunnerLedger(남의dir, [
      {
        agentId: 'a1',
        pid: 남의러너.pid!,
        incarnationId: 'inc-theirs',
        startedAtMs: Date.now(),
        bootTimeSec: 시작시각초(남의러너.pid!),
        spawnedByNonce: 'n-theirs',
      },
    ]);

    const outcome = await daemon띄우기(내dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');

    expect(outcome.daemon.adoptedAtStartup.adopted).toEqual([]);
    expect(outcome.daemon.registry.listRunners()).toEqual([]);
    expect(살아있나(남의러너.pid!)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// `#456` ② — 판정이 로그에 남는다
// ---------------------------------------------------------------------------

describe('채택 판정이 로그에 남는다 (#456 ②)', () => {
  /**
   * **"남의 러너라서 안 채택했다"가 로그에 남아야** 사람이 그 판단을 검증할 수 있다.
   *
   * 채택은 곧 `killRunner` 의 대상이 된다는 뜻이다. 그 판정이 조용하면 **잘못된 채택도
   * 조용하다** — 무관한 프로세스에 SIGTERM 이 갈 때까지 아무도 모른다.
   *
   * 되돌려 RED: `run.ts` 의 기동 로그 블록에서
   * `for (const line of adoptedAtStartup.rejected) log(...)` 를 빼면 빨개진다.
   */
  it('채택하지 않은 사유가 로그에 남는다', async () => {
    const dir = await 임시앱디렉터리();
    const 로그: string[] = [];

    // 죽은 pid 와 pid 재사용, 두 갈래를 장부에 심는다.
    await writeRunnerLedger(dir, [
      {
        agentId: '죽은놈',
        pid: 999_999, // 존재하지 않는 pid.
        incarnationId: 'inc-dead',
        startedAtMs: 1,
        bootTimeSec: 100,
        spawnedByNonce: 'n1',
      },
      {
        agentId: '재사용',
        pid: process.pid, // 살아 있다(이 vitest 프로세스다).
        incarnationId: 'inc-reused',
        startedAtMs: 1,
        bootTimeSec: 1, // 실제 시작 시각과 다르다 — pid 재사용으로 판정돼야 한다.
        spawnedByNonce: 'n1',
      },
    ]);

    const outcome = await daemon띄우기(dir, { log: (l) => 로그.push(l) });
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');

    // **아무것도 채택하지 않았다** — 그리고 이 vitest 프로세스는 표에 안 올랐다.
    expect(outcome.daemon.adoptedAtStartup.adopted).toEqual([]);
    expect(outcome.daemon.registry.listRunners()).toEqual([]);

    const 전문 = 로그.join('\n');
    expect(전문).toMatch(/고아 재발견\(기동\)/);
    // 장부 경로가 남는다 — 사람이 어느 파일을 봐야 하는지 알아야 한다.
    expect(전문).toContain(runnerLedgerPath(dir));
    // 갈래마다 **다른 사유**가 남는다. 뭉치면 pid 재사용이 실제로 나도 아무도 모른다.
    expect(전문).toMatch(/그 pid 가 없다/);
    expect(전문).toMatch(/pid 가 재사용됐다/);
    expect(전문).toContain('999999');
    expect(전문).toContain(String(process.pid));
  }, 30_000);

  /** 후보가 0건이어도 **적는다** — "봤는데 없었다"와 "안 봤다"는 다른 사실이다. */
  it('장부가 비어 있어도 재발견을 돌았다는 사실이 로그에 남는다', async () => {
    const dir = await 임시앱디렉터리();
    const 로그: string[] = [];
    const outcome = await daemon띄우기(dir, { log: (l) => 로그.push(l) });
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    expect(로그.join('\n')).toMatch(/고아 재발견\(기동\).*채택 0건, 안 함 0건/);
  }, 30_000);

  /**
   * **"띄웠다"와 "이미 있었다"를 로그가 가른다.**
   *
   * 실물 검증(2026-09-06)에서 잡은 것이다: 채택한 러너를 그대로 돌려준 자리에
   * `러너 spawn` 이 찍혀, 로그만 보면 프로세스가 하나 더 뜬 것처럼 읽혔다. 이 이슈가
   * 없애려는 오독(`#430`)을 로그가 다시 만드는 셈이다.
   *
   * 되돌려 RED: `server.ts` 의 `spawnRunner` 로그를 `러너 spawn: …` 한 갈래로 되돌리면
   * 빨개진다.
   */
  it('이미 있는 러너를 돌려줄 때는 "spawn 했다"고 적지 않는다', async () => {
    const dir = await 임시앱디렉터리();
    const 로그: string[] = [];
    const 첫daemon = await daemon띄우기(dir);
    if (첫daemon.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const 러너 = await 첫daemon.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(러너.pid);
    await 조건까지장부(dir, 1);
    await 첫daemon.daemon.shutdown();

    const 새daemon = await daemon띄우기(dir, { log: (l) => 로그.push(l) });
    if (새daemon.kind !== 'running') throw new Error('새 daemon 이 안 떴다');
    로그.length = 0;

    // 소켓을 거쳐야 서버의 로그 자리를 밟는다.
    const client = await 인증된클라이언트(dir, 새daemon.daemon.paths.socketPath);
    client.보낸다({ id: 's1', type: 'spawnRunner', payload: { agentId: 'a1', env: {} } });
    await client.받는다(1);
    client.닫는다();

    const 전문 = 로그.join('\n');
    expect(전문).toMatch(/러너가 이미 있다 — 새로 안 띄운다/);
    expect(전문).toMatch(/채택한 러너다/);
    expect(전문).not.toMatch(/러너 spawn:/);
  }, 30_000);

  /** 엔드포인트 획득 사실도 daemon 로그로 흘러야 한다(`daemonEndpoint` 의 `trace`). */
  it('엔드포인트 획득이 daemon 로그로 흐른다', async () => {
    const dir = await 임시앱디렉터리();
    const 로그: string[] = [];
    const outcome = await daemon띄우기(dir, { log: (l) => 로그.push(l) });
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    expect(로그.join('\n')).toMatch(/엔드포인트 획득/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 회귀선 D5 — daemon 코드에 세션이 없다
// ---------------------------------------------------------------------------

describe('D5 — daemon 은 세션을 읽지도 쓰지도 않는다 (#431)', () => {
  /**
   * **회귀선 D5.** `sessions.json` · `SessionStore` 가 daemon 소스에 등장하지 않는다.
   *
   * 근거(D5): 세션 파일의 원자성은 "쓰는 주체가 하나(러너)"에서 나온다. daemon 이 두
   * 번째 writer 가 되면 각자의 쓰기는 원자적인데 합쳐서 lost update 가 나고, **조용히**
   * 난다 — 에러도 크래시도 없이 중복 답변·누락으로 나타나 daemon 과 무관해 보인다.
   *
   * 2-c 가 이 회귀선을 특히 필요로 하는 이유: 스펙이 제안한 pid 기록 자리가
   * `~/.murmur-agent/<agent>-<instance>/` 였고, 거기에는 `sessions.json` 이 산다.
   * 그 디렉터리를 여는 순간 이 경계가 흐려진다.
   *
   * 되돌려 RED: `runnerLedger.ts` 에 `sessions.json` 을 쓰는 코드를 한 줄 넣으면 빨개진다.
   */
  it('daemon 소스에 sessions.json·SessionStore·.murmur-agent 가 없다', async () => {
    const { readdir } = await import('node:fs/promises');
    const srcDir = new URL('../src/', import.meta.url).pathname;
    const 파일들 = (await readdir(srcDir)).filter((f) => f.endsWith('.ts'));
    expect(파일들.length).toBeGreaterThan(0);

    const 걸린것: string[] = [];
    for (const f of 파일들) {
      const text = await readFile(join(srcDir, f), 'utf8');
      // 주석은 벗기고 **코드만** 본다 — 이 파일들의 주석은 "왜 안 쓰는가"를 길게 적고
      // 있어서 문자열 검사가 그것에 걸리면 회귀선이 자기 근거 때문에 빨개진다.
      const code = 주석제거(text);
      for (const 금지 of ['sessions.json', 'SessionStore', '.murmur-agent']) {
        if (code.includes(금지)) 걸린것.push(`${f}: ${금지}`);
      }
    }
    expect(걸린것).toEqual([]);
  });

  /** 장부는 **daemon 디렉터리 안**에 산다 — 러너의 상태 트리를 안 건드린다. */
  it('장부는 <appDataDir>/daemon/ 아래에 있다', () => {
    const path = runnerLedgerPath('/tmp/앱데이터');
    expect(path).toBe('/tmp/앱데이터/daemon/runners-v1.json');
  });
});

// ---------------------------------------------------------------------------
// 장부 자체의 성질
// ---------------------------------------------------------------------------

describe('러너 장부 (#431 2-c)', () => {
  it('없는 장부는 빈 목록이다 — 던지지 않는다', async () => {
    const dir = await 임시앱디렉터리();
    expect(await readRunnerLedger(dir)).toEqual([]);
  });

  /**
   * 깨진 장부로 daemon 이 안 뜨면 안 된다. 잃는 것은 "고아를 못 찾는다" 하나이고,
   * 그것은 2-c 이전의 동작이다.
   */
  it('깨진 장부는 빈 목록이다 — daemon 이 뜨는 것을 막지 않는다', async () => {
    const dir = await 임시앱디렉터리();
    await mkdir(join(dir, 'daemon'), { recursive: true });
    await writeFile(runnerLedgerPath(dir), '{이건 JSON 이 아니다', 'utf8');
    expect(await readRunnerLedger(dir)).toEqual([]);

    const outcome = await daemon띄우기(dir);
    expect(outcome.kind).toBe('running');
  }, 30_000);

  /** 버전이 다른 장부는 **읽지 않는다** — 항목 모양을 모르는 채 pid 를 쓰면 위험하다. */
  it('버전이 다른 장부는 읽지 않는다', async () => {
    const dir = await 임시앱디렉터리();
    await mkdir(join(dir, 'daemon'), { recursive: true });
    await writeFile(
      runnerLedgerPath(dir),
      JSON.stringify({ version: 999, runners: [{ agentId: 'a1', pid: 1, incarnationId: 'i', startedAtMs: 0, bootTimeSec: 0 }] }),
      'utf8',
    );
    expect(await readRunnerLedger(dir)).toEqual([]);
  });

  /**
   * **종료 경로가 장부를 지우지 않는다.**
   *
   * 지우면 러너를 살려 두는 그 코드가 그 러너를 영영 못 찾게 만든다.
   *
   * 되돌려 RED: `run.ts` 의 `shutdown` 에 `writeRunnerLedger(appDataDir, [])` 를 넣으면
   * 빨개진다.
   */
  it('shutdown 이 장부를 지우지 않는다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const 러너 = await outcome.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(러너.pid);
    await 조건까지장부(dir, 1);

    await outcome.daemon.shutdown();

    const 남은장부 = await readRunnerLedger(dir);
    expect(남은장부).toHaveLength(1);
    expect(남은장부[0]?.pid).toBe(러너.pid);
  }, 30_000);

  /**
   * **겹친 쓰기가 서로를 망가뜨리지 않는다** — 실물 검증 B 가 잡은 결함이다(2026-09-06).
   *
   * 장부 쓰기는 fire-and-forget 이라(`run.ts` 의 `ledgerSink`) 겹치는 것이 정상이다.
   * 임시 이름이 `.tmp-<pid>` 뿐이면 같은 프로세스의 두 쓰기가 같은 파일을 쓰고, 먼저
   * `rename` 한 쪽이 그것을 가져가 뒤의 쪽이 `ENOENT` 로 실패한다. **조용히 실패한다** —
   * 던지지 않으므로 daemon 은 계속 돌고 장부만 낡은 채 남는다.
   *
   * 되돌려 RED: `runnerLedger.ts` 의 임시 이름에서 `randomUUID()` 를 빼면
   * "실패 로그가 없다"가 깨진다.
   */
  it('장부 쓰기가 겹쳐도 실패하지 않는다 — 임시 이름이 충돌하지 않는다', async () => {
    const dir = await 임시앱디렉터리();
    const 로그: string[] = [];
    const 항목 = (n: number): RunnerLedgerEntry => ({
      agentId: `a${n}`,
      pid: 1000 + n,
      incarnationId: `inc-${n}`,
      startedAtMs: n,
      bootTimeSec: n,
      spawnedByNonce: 'n1',
    });

    // 스무 번을 동시에 쏟아붓는다 — 순차로 부르면 겹침 자체가 안 생겨 아무것도 안 잰다.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeRunnerLedger(dir, [항목(i)], (l) => 로그.push(l))),
    );

    expect(로그).toEqual([]); // **한 건도 실패하지 않았다.**
    // 마지막 쓰기가 이긴다. 중요한 것은 **온전한 스냅샷이 남는다**는 것이다.
    const 장부 = await readRunnerLedger(dir);
    expect(장부).toHaveLength(1);

    // 임시 파일이 하나도 안 남았다 — 남으면 그것이 새 잔해다.
    const { readdir } = await import('node:fs/promises');
    const 남은 = (await readdir(join(dir, 'daemon'))).filter((n) => n.includes('.tmp-'));
    expect(남은).toEqual([]);
  });

  /** 정상 종료한 러너는 장부에서 **빠진다** — 다음 daemon 의 후보로 남기지 않는다. */
  it('러너가 끝나면 장부에서 빠진다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir, { runnerArgs: ['-c', 'sleep 0.2'] });
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const 러너 = await outcome.daemon.registry.spawnRunner('a1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(러너.pid);

    await 조건까지(() => !살아있나(러너.pid), 15_000);
    await 조건까지장부(dir, 0);
  }, 30_000);
});

/**
 * 장부가 원하는 길이가 될 때까지 기다린다.
 *
 * 기다리는 이유: 장부 쓰기는 **fire-and-forget** 이다(`run.ts` 의 `ledgerSink`) —
 * `spawnRunner` 응답을 디스크 쓰기만큼 늦추지 않으려는 선택이고, 그 대가로 회귀선이
 * 이렇게 기다려야 한다.
 */
async function 조건까지장부(dir: string, 길이: number): Promise<RunnerLedgerEntry[]> {
  const 끝 = Date.now() + 15_000;
  for (;;) {
    const 장부 = await readRunnerLedger(dir);
    if (장부.length === 길이) return 장부;
    if (Date.now() >= 끝) {
      throw new Error(`장부가 ${길이}줄이 되지 않았다: 지금 ${장부.length}줄`);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** 줄 주석과 블록 주석을 벗긴다. 문자열 리터럴 안의 `//` 는 이 회귀선의 관심 밖이다. */
function 주석제거(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

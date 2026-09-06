/**
 * 러너 로그 회귀선 — `#434`(stderr 가 버려진다)와 `#473`(구분자를 읽을 수 없다).
 *
 * **실물로 잰다.** 파일 리다이렉션은 모킹으로 재면 아무것도 안 지킨다: `stdio` 옵션에
 * 무엇을 넣었는지를 목이 확인하는 순간, 그 옵션이 실제로 무엇을 하는지는 아무도 확인하지
 * 않은 채 초록이 된다. `runners.test.ts` 가 PGID 를 `ps` 로 읽는 것과 같은 규율이다 —
 * 여기서는 진짜 자식을 띄우고 **파일 내용을 읽는다.**
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openRunnerLog,
  readRunnerLogTail,
  runnerLogPath,
  RUNNER_EXIT_TAIL_LINES,
} from '../src/runnerLog.js';
import { RunnerRegistry, nodeRunnerHost, type RunnerLogSink } from '../src/runners.js';

const 정리할pid: number[] = [];
const 정리할디렉터리: string[] = [];

afterEach(() => {
  for (const pid of 정리할pid.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 죽었다 */
    }
  }
  for (const dir of 정리할디렉터리.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function 임시앱데이터(): string {
  const dir = mkdtempSync(join(tmpdir(), 'murmur-runnerlog-'));
  정리할디렉터리.push(dir);
  return dir;
}

/** 운영과 **같은** sink 다 — 회귀선이 자기 사본을 세우면 그 사본만 초록이 된다. */
function 실물sink(appDataDir: string, maxBytes?: number): RunnerLogSink {
  return {
    open: (agentId) => openRunnerLog(appDataDir, agentId, { maxBytes }),
    pathFor: (agentId) => runnerLogPath(appDataDir, agentId),
    tail: (path) => readRunnerLogTail(path),
  };
}

async function 조건까지(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const 끝 = Date.now() + timeoutMs;
  while (Date.now() < 끝) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('조건이 시간 안에 성립하지 않았다');
}

describe('회귀선 1 — 러너의 출력이 파일로 간다 (#434)', () => {
  /**
   * **되돌려 RED**: `nodeRunnerHost.spawn` 의 `stdio` 를 `'ignore'` 로 되돌리면 파일이
   * 비어 이 단언이 빨개진다. 실제로 그렇게 되돌려 실행해 확인했다.
   *
   * stdout·stderr **둘 다** 재는 것이 요점이다. `#434` 의 증상은 stderr 였지만 러너의
   * 기동 로그는 stdout 으로 나가고, 둘 중 하나만 살리면 진단의 절반이 다시 사라진다.
   */
  it('러너가 stdout·stderr 에 쓴 것이 로그 파일에 남는다', async () => {
    const appDataDir = 임시앱데이터();
    const registry = new RunnerRegistry(
      { command: '/bin/sh', args: ['-c', 'echo 표준출력; echo 표준오류 1>&2; sleep 30'] },
      nodeRunnerHost,
      () => undefined,
      null,
      실물sink(appDataDir),
    );

    const record = await registry.spawnRunner('agent-1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    const path = runnerLogPath(appDataDir, 'agent-1');
    await 조건까지(() => existsSync(path) && readFileSync(path, 'utf8').includes('표준오류'));

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('표준출력');
    expect(text).toContain('표준오류');
  });

  /**
   * **회귀선 2 — daemon 에 파이프를 매달지 않는다.**
   *
   * 이 성질이 `#434` 를 파일로 푼 이유 그 자체다. 파이프를 매달면 daemon 이 죽을 때
   * 파이프의 읽는 끝이 닫히고, 그 뒤 러너가 한 줄이라도 쓰면 EPIPE 로 죽는다 —
   * "daemon 이 죽어도 러너는 산다"(`#431` 의 목적)가 깨진다.
   *
   * **되돌려 RED**: `stdio` 를 `['ignore', 'pipe', 'pipe']` 로 바꾸면 자식 핸들에
   * `stdout`/`stderr` 스트림이 생겨 이 단언이 빨개진다. 실제로 그렇게 바꿔 확인했다.
   *
   * 왜 이렇게 재는가: 파이프가 매달렸다는 사실은 **Node 자식 핸들에 그대로 드러난다** —
   * `stdio: 'pipe'` 면 `child.stdout` 이 `Readable` 이고, fd 나 `'ignore'` 면 `null` 이다.
   * "daemon 을 죽여 러너가 EPIPE 로 죽는지" 를 직접 재는 것이 더 실물이지만, 그것은
   * 러너가 죽는 타이밍(파이프가 닫힌 뒤 쓰기가 일어나야 한다)에 의존해 불안정하다.
   */
  it('러너의 stdio 에 daemon 쪽 파이프를 매달지 않는다', async () => {
    const appDataDir = 임시앱데이터();
    const registry = new RunnerRegistry(
      { command: '/bin/sh', args: ['-c', 'sleep 30'] },
      nodeRunnerHost,
      () => undefined,
      null,
      실물sink(appDataDir),
    );

    const record = await registry.spawnRunner('agent-1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    // 파이프가 매달렸으면 이 셋이 스트림이다. 파일 fd 로 갔으면 전부 `null` 이다.
    expect(record.child?.stdout).toBeNull();
    expect(record.child?.stderr).toBeNull();
    expect(record.child?.stdin).toBeNull();
  });

  /**
   * **로그 fd 가 daemon 안에 쌓이지 않는다.**
   *
   * 자식은 spawn 순간 fd 복제본을 받으므로 daemon 쪽 사본은 즉시 닫아야 한다. 안 닫으면
   * 러너를 띄울 때마다 fd 가 하나씩 쌓여 결국 `EMFILE` 로 **아무 러너도 못 띄운다** —
   * 로그를 남기려던 장치가 daemon 을 못 쓰게 만드는 것이다.
   *
   * 그런데도 자식의 출력은 계속 파일로 가야 한다. 그 둘을 한 자리에서 잰다.
   */
  it('daemon 쪽 fd 를 닫아도 자식의 출력은 계속 파일로 간다', async () => {
    const appDataDir = 임시앱데이터();
    const registry = new RunnerRegistry(
      // 0.2초 뒤에 쓴다 — spawn 이 끝나고 daemon 이 fd 를 닫은 뒤다.
      { command: '/bin/sh', args: ['-c', 'sleep 0.2; echo 나중에쓴줄; sleep 30'] },
      nodeRunnerHost,
      () => undefined,
      null,
      실물sink(appDataDir),
    );

    const record = await registry.spawnRunner('agent-1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    const path = runnerLogPath(appDataDir, 'agent-1');
    await 조건까지(() => existsSync(path) && readFileSync(path, 'utf8').includes('나중에쓴줄'));
    expect(readFileSync(path, 'utf8')).toContain('나중에쓴줄');

    // fd 가 실제로 안 쌓이는지도 잰다 — 러너를 여럿 띄우고 이 프로세스의 열린 fd 를 센다.
    const 이전 = 열린fd수();
    for (let i = 0; i < 5; i += 1) {
      const r = await registry.spawnRunner(`fd-${i}`, { PATH: process.env.PATH ?? '' });
      정리할pid.push(r.pid);
    }
    // 여유를 크게 둔다 — 자식 핸들·이벤트 루프가 fd 를 몇 개 쓰는 것은 정상이다.
    // 재는 것은 "러너 하나당 로그 fd 하나가 영구히 남는가"이고, 그것이면 5 이상 늘어난다.
    expect(열린fd수()).toBeLessThan(이전 + 5);
  });

  /**
   * **로그를 못 열어도 러너는 뜬다.** 로그는 진단 수단이지 기동 조건이 아니다.
   *
   * 못 여는 상황을 실물로 만든다 — `appDataDir/daemon` 자리에 **파일**을 놓으면
   * `mkdirSync` 가 `ENOTDIR`/`EEXIST` 로 실패한다.
   */
  it('로그 파일을 못 열어도 러너 기동을 막지 않는다', async () => {
    const appDataDir = 임시앱데이터();
    // 디렉터리가 있어야 할 자리에 파일을 놓는다.
    writeFileSync(join(appDataDir, 'daemon'), '나는 디렉터리가 아니다');

    const 남은로그: string[] = [];
    const registry = new RunnerRegistry(
      { command: '/bin/sh', args: ['-c', 'sleep 30'] },
      nodeRunnerHost,
      () => undefined,
      null,
      {
        open: (agentId) =>
          openRunnerLog(appDataDir, agentId, { log: (line) => 남은로그.push(line) }),
        pathFor: (agentId) => runnerLogPath(appDataDir, agentId),
        tail: (path) => readRunnerLogTail(path),
      },
    );

    const record = await registry.spawnRunner('agent-1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    // 러너는 떴다.
    expect(record.pid).toBeGreaterThan(0);
    expect(record.logPath).toBeNull();
    // **그리고 그 사실이 어딘가 남았다** — 조용히 버리면 사람은 "로그가 0바이트인데
    // 실패가 없었던 것인지 안 찍힌 것인지"를 또 못 가린다(`#434` 가 인용한 상황).
    expect(남은로그.join('\n')).toContain('러너 로그 파일을 열지 못했다');
  });
});

describe('회전 — spawn 직전에 한 번만 본다', () => {
  it('상한을 넘긴 로그는 spawn 직전에 .1 로 밀린다', async () => {
    const appDataDir = 임시앱데이터();
    const path = runnerLogPath(appDataDir, 'agent-1');

    // 상한을 넘긴 파일을 먼저 만든다.
    const 첫핸들 = openRunnerLog(appDataDir, 'agent-1', { maxBytes: 1024 });
    첫핸들?.close();
    writeFileSync(path, '옛 세대의 줄\n'.repeat(500));
    expect(statSync(path).size).toBeGreaterThan(1024);

    const registry = new RunnerRegistry(
      { command: '/bin/sh', args: ['-c', 'echo 새 세대의 줄; sleep 30'] },
      nodeRunnerHost,
      () => undefined,
      null,
      실물sink(appDataDir, 1024),
    );
    const record = await registry.spawnRunner('agent-1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    await 조건까지(() => readFileSync(path, 'utf8').includes('새 세대의 줄'));

    // 옛 것은 `.1` 로 갔고, 현재 파일에는 새 것만 있다.
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('옛 세대의 줄');
    expect(readFileSync(path, 'utf8')).not.toContain('옛 세대의 줄');
    expect(readFileSync(path, 'utf8')).toContain('새 세대의 줄');
  });

  it('상한 안이면 밀지 않고 이어 쓴다 — 진행 중인 진단이 사라지지 않는다', async () => {
    const appDataDir = 임시앱데이터();
    const path = runnerLogPath(appDataDir, 'agent-1');
    const 핸들 = openRunnerLog(appDataDir, 'agent-1');
    핸들?.close();
    writeFileSync(path, '앞선 기동의 줄\n');

    const registry = new RunnerRegistry(
      { command: '/bin/sh', args: ['-c', 'echo 이번 기동의 줄; sleep 30'] },
      nodeRunnerHost,
      () => undefined,
      null,
      실물sink(appDataDir),
    );
    const record = await registry.spawnRunner('agent-1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    await 조건까지(() => readFileSync(path, 'utf8').includes('이번 기동의 줄'));
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('앞선 기동의 줄');
    expect(text).toContain('이번 기동의 줄');
    expect(existsSync(`${path}.1`)).toBe(false);
  });
});

describe('로그 경로 — 소켓에서 온 문자열이 경로가 되지 않는다 (#250 의 경계)', () => {
  /**
   * `agentId` 는 소켓 너머에서 온다. 그대로 이어 붙이면 `<appDataDir>/daemon/` 밖의
   * 파일을 daemon 권한으로 열고, 회전 경로에서는 `rename`·`unlink` 까지 닿는다 —
   * **임의 파일 파괴**다.
   *
   * **되돌려 RED**: `runnerLogFileName` 의 `replace` 를 지우면 경로가 디렉터리를
   * 벗어나 이 단언이 빨개진다.
   */
  it('경로 조각이 섞인 agentId 도 daemon 디렉터리를 벗어나지 못한다', () => {
    const appDataDir = '/tmp/murmur-test-appdata';
    const 나쁜값 = ['../../../etc/passwd', 'a/b/c', './..', '..'];
    for (const id of 나쁜값) {
      const path = runnerLogPath(appDataDir, id);
      expect(path.startsWith(`${appDataDir}/daemon/`)).toBe(true);
      expect(path).not.toContain('/..');
      expect(path.slice(`${appDataDir}/daemon/`.length)).not.toContain('/');
    }
  });

  it('에이전트마다 파일이 다르다 — 구분자가 뒤섞이지 않는다', () => {
    const appDataDir = '/tmp/murmur-test-appdata';
    expect(runnerLogPath(appDataDir, 'a1')).not.toBe(runnerLogPath(appDataDir, 'a2'));
  });
});

describe('꼬리 읽기 — exit 통지에 실을 재료 (#473)', () => {
  it('마지막 몇 줄을 그대로 준다 — 빈 줄은 뺀다', async () => {
    const appDataDir = 임시앱데이터();
    const 핸들 = openRunnerLog(appDataDir, 'agent-1');
    핸들?.close();
    const path = runnerLogPath(appDataDir, 'agent-1');
    writeFileSync(path, '첫 줄\n\n둘째 줄\n셋째 줄\n');

    expect(await readRunnerLogTail(path)).toEqual(['첫 줄', '둘째 줄', '셋째 줄']);
  });

  it('줄 수에 상한이 있다 — 폭주한 로그가 exit 통지를 삼키지 않는다', async () => {
    const appDataDir = 임시앱데이터();
    const 핸들 = openRunnerLog(appDataDir, 'agent-1');
    핸들?.close();
    const path = runnerLogPath(appDataDir, 'agent-1');
    writeFileSync(path, Array.from({ length: 500 }, (_, i) => `줄 ${i}`).join('\n'));

    const tail = await readRunnerLogTail(path);
    expect(tail).toHaveLength(RUNNER_EXIT_TAIL_LINES);
    // **마지막** 줄들이어야 한다 — 구분자는 언제나 끝에 있다.
    expect(tail.at(-1)).toBe('줄 499');
  });

  it('파일이 없으면 빈 배열이다 — 던지지 않는다', async () => {
    expect(await readRunnerLogTail('/tmp/murmur-없는파일-9999.log')).toEqual([]);
  });

  /**
   * exit 통지에 꼬리가 실린다 — **`#473` 의 배선 전체**를 한 자리에서 잰다.
   *
   * 러너가 78 로 죽으며 구분자를 찍는 것을 흉내낸다. 이 통지가 앱까지 가면
   * `runnerExitReason` 이 그것을 갈라 화면 문구가 된다.
   */
  it('러너가 죽으면 그 로그의 꼬리가 exit 통지에 실린다', async () => {
    const appDataDir = 임시앱데이터();
    const 통지: { code: number | null; tailLines: string[] }[] = [];
    const registry = new RunnerRegistry(
      {
        command: '/bin/sh',
        args: [
          '-c',
          "echo 'murmur-agent: harness executable not found; exiting' 1>&2; exit 78",
        ],
      },
      nodeRunnerHost,
      (n) => 통지.push({ code: n.code, tailLines: n.tailLines }),
      null,
      실물sink(appDataDir),
    );

    const record = await registry.spawnRunner('agent-1', { PATH: process.env.PATH ?? '' });
    정리할pid.push(record.pid);

    await 조건까지(() => 통지.length > 0);
    expect(통지[0]!.code).toBe(78);
    expect(통지[0]!.tailLines.join('\n')).toContain(
      'murmur-agent: harness executable not found; exiting',
    );
  });

  /** 로그가 없어도 exit 통지는 나간다 — 진단 장치가 상태 표시를 망가뜨리면 안 된다. */
  it('로그 sink 가 없어도 exit 통지는 나가고 꼬리는 빈 배열이다', async () => {
    const 통지: { code: number | null; tailLines: string[] }[] = [];
    const registry = new RunnerRegistry(
      { command: '/bin/sh', args: ['-c', 'exit 78'] },
      nodeRunnerHost,
      (n) => 통지.push({ code: n.code, tailLines: n.tailLines }),
    );
    const record = await registry.spawnRunner('agent-1', {});
    정리할pid.push(record.pid);

    await 조건까지(() => 통지.length > 0);
    expect(통지[0]!.code).toBe(78);
    expect(통지[0]!.tailLines).toEqual([]);
  });
});

/** 이 프로세스가 지금 열고 있는 fd 의 수. `lsof` 없이 `/dev/fd` 로 센다. */
function 열린fd수(): number {
  const out = execFileSync('ls', ['/dev/fd'], { encoding: 'utf8' });
  return out.trim().split('\n').filter((l) => l.length > 0).length;
}

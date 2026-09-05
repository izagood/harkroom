/**
 * 소켓 서버 — **진짜 unix 소켓 위에서 잰다.**
 *
 * `claimDaemonEndpoint` 에 실제 `net.Server` 를 넘기는 것이 2-a 가 "확인 못 함"으로 남긴
 * 항목이고, 그것을 확인하려면 실물이 필요하다. 모킹한 bind 로는 "임시 이름에 bind 한
 * 서버가 정규 이름을 그대로 서비스하는가"를 잴 수 없다 — 그 성질은 커널의 하드링크가
 * 만드는 것이지 우리 코드가 만드는 것이 아니다.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DAEMON_PROTOCOL_VERSION, daemonEndpointPaths } from '@murmur/shared/daemonEndpoint';
import { NdjsonDecoder, encodeLine } from '@murmur/shared/daemonProtocol';

import { startDaemon, EXIT_OCCUPIED, appDataDirFromSocket } from '../src/run.js';
import type { RunnerHost } from '../src/runners.js';

const 임시들: string[] = [];
const 내릴것들: (() => Promise<void>)[] = [];
const 정리할pid: number[] = [];

afterEach(async () => {
  for (const down of 내릴것들.splice(0)) await down().catch(() => undefined);
  for (const dir of 임시들.splice(0)) await rm(dir, { recursive: true, force: true });
  for (const pid of 정리할pid.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 죽었다 */
    }
  }
});

async function 임시앱디렉터리(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'murmur-daemon-test-'));
  임시들.push(dir);
  return dir;
}

/** 아무 프로세스도 안 띄우는 호스트 — 소켓 성질만 잴 때 쓴다. */
function 가짜호스트(): RunnerHost {
  let pid = 9000;
  return {
    spawn: () => ({ pid: (pid += 1), on: () => undefined }) as never,
    kill: () => true,
    now: () => 1000,
    // 회귀선은 pid 재사용을 안 잰다 — 그것은 `adopt.test.ts` 의 몫이다.
    bootTimeSec: () => Promise.resolve(null),
  };
}

async function daemon띄우기(appDataDir: string, host: RunnerHost = 가짜호스트()) {
  const paths = daemonEndpointPaths(appDataDir);
  const outcome = await startDaemon({
    args: {
      socket: paths.socketPath,
      launchNonce: 'test-nonce',
      entryPath: join(appDataDir, 'murmur-daemon'),
      appVersion: '0.0.0-test',
      unknown: [],
    },
    host,
    runnerCommand: '/bin/sh',
    log: () => undefined,
  });
  if (outcome.kind === 'running') 내릴것들.push(() => outcome.daemon.shutdown());
  return outcome;
}

/** 소켓에 붙어 NDJSON 으로 말하는 최소 클라이언트. */
class 테스트클라이언트 {
  private readonly decoder = new NdjsonDecoder();
  private readonly 받은: unknown[] = [];
  private constructor(private readonly socket: Socket) {}

  static async 접속(socketPath: string): Promise<테스트클라이언트> {
    const socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const client = new 테스트클라이언트(socket);
    socket.on('data', (chunk: Buffer) => {
      for (const line of client.decoder.push(chunk)) {
        if (line.ok) client.받은.push(line.value);
      }
    });
    return client;
  }

  보낸다(message: unknown): void {
    this.socket.write(encodeLine(message));
  }

  async 받는다(index = 0, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const 끝 = Date.now() + timeoutMs;
    while (Date.now() < 끝) {
      if (this.받은.length > index) return this.받은[index] as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`응답 ${index} 이 오지 않았다`);
  }

  /**
   * 조건에 맞는 줄을 **순서와 무관하게** 찾는다.
   *
   * NDJSON 에서 응답은 `id` 로 짝짓고 이벤트는 그 사이에 낀다 — 즉 프로토콜이 순서를
   * 계약으로 두지 않는다. 인덱스로 집는 `받는다` 는 편하지만, 둘이 섞일 수 있는 자리에
   * 쓰면 회귀선이 타이밍에 따라 뒤집힌다(실제로 겪었다, 2026-09-06).
   */
  async 찾는다(
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const 끝 = Date.now() + timeoutMs;
    while (Date.now() < 끝) {
      const hit = (this.받은 as Record<string, unknown>[]).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`조건에 맞는 줄이 오지 않았다: ${JSON.stringify(this.받은)}`);
  }

  닫는다(): void {
    this.socket.destroy();
  }
}

async function 토큰읽기(appDataDir: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return (await readFile(daemonEndpointPaths(appDataDir).tokenPath, 'utf8')).trim();
}

describe('daemon 서버 기동 (#431 2단계-b)', () => {
  /**
   * `claimDaemonEndpoint` 에 **실제 `net.Server`** 를 넘긴 결과가 성립하는지 잰다 —
   * 2-a 가 남긴 미확인 항목이다.
   *
   * 임시 이름에 bind 한 서버가 하드링크로 정규 이름을 얻고, 임시 이름이 지워진 뒤에도
   * **정규 이름으로 접속이 된다**는 것이 확인 대상이다. 그 성질이 깨지면 daemon 은 뜨는데
   * 아무도 붙지 못한다.
   */
  it('세 파일이 놓이고 정규 이름 소켓에 실제로 붙는다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    expect(outcome.kind).toBe('running');
    if (outcome.kind !== 'running') return;

    const paths = outcome.daemon.paths;
    expect((await stat(paths.socketPath)).isSocket()).toBe(true);
    expect((await stat(paths.pidPath)).isFile()).toBe(true);
    expect((await stat(paths.tokenPath)).isFile()).toBe(true);

    const client = await 테스트클라이언트.접속(paths.socketPath);
    client.닫는다();
  });

  /**
   * 회귀선 5. **엔드포인트가 이미 점유돼 있으면 물러난다** — 중복 daemon 이 안 뜬다.
   *
   * 둘이 같은 소켓을 들고 있으면 앱이 어느 쪽에 붙는지가 타이밍에 달리고, 러너 소유권이
   * 두 daemon 으로 갈린다.
   *
   * 되돌려 RED: `run.ts` 에서 `outcome.kind === 'occupied'` 분기를 지우면(또는
   * `claimDaemonEndpoint` 결과를 무시하고 계속 진행하면) 둘째도 `running` 이 된다.
   */
  it('이미 서비스 중인 daemon 이 있으면 둘째는 물러난다', async () => {
    const dir = await 임시앱디렉터리();
    const 첫째 = await daemon띄우기(dir);
    expect(첫째.kind).toBe('running');

    const 둘째 = await daemon띄우기(dir);
    expect(둘째.kind).toBe('occupied');

    // 첫째의 소켓은 그대로 서비스 중이어야 한다 — 둘째가 밀어내지 않았다.
    if (첫째.kind !== 'running') return;
    const client = await 테스트클라이언트.접속(첫째.daemon.paths.socketPath);
    client.닫는다();
  });

  /** 종료 코드가 뜻을 갖는다 — 앱이 "붙어라"와 "다시 띄워라"를 가른다. */
  it('점유 종료 코드는 실패 코드와 다르다', () => {
    expect(EXIT_OCCUPIED).not.toBe(0);
    expect(EXIT_OCCUPIED).not.toBe(1);
  });

  it('소켓 경로에서 앱 데이터 디렉터리를 되짚는다', () => {
    const paths = daemonEndpointPaths('/somewhere/appdata');
    expect(appDataDirFromSocket(paths.socketPath)).toBe('/somewhere/appdata');
  });
});

describe('hello — 문을 먼저 지킨다 (#431 D6)', () => {
  it('토큰이 맞으면 daemon 신원을 돌려준다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');

    const client = await 테스트클라이언트.접속(outcome.daemon.paths.socketPath);
    client.보낸다({
      type: 'hello',
      version: DAEMON_PROTOCOL_VERSION,
      token: await 토큰읽기(dir),
      role: 'app',
    });
    const reply = await client.받는다();
    expect(reply.ok).toBe(true);
    const identity = reply.daemon as { pid: number; launchNonce: string };
    expect(identity.pid).toBe(process.pid);
    // pid 파일의 nonce 와 소켓으로 온 nonce 가 **같아야** 한다 — 어긋나면 그것이
    // "내가 붙은 daemon 은 그 파일을 쓴 daemon 이 아니다"라는 신호다.
    expect(identity.launchNonce).toBe(outcome.daemon.pidRecord.launchNonce);
    client.닫는다();
  });

  it('토큰이 틀리면 사유를 알려 주고 끊는다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');

    const client = await 테스트클라이언트.접속(outcome.daemon.paths.socketPath);
    client.보낸다({
      type: 'hello',
      version: DAEMON_PROTOCOL_VERSION,
      token: '틀린-토큰-이지만-길이는-충분히-길다',
      role: 'app',
    });
    const reply = await client.받는다();
    expect(reply.ok).toBe(false);
    expect((reply.error as { code: string }).code).toBe('unauthorized');
    client.닫는다();
  });

  /** **`hello` 전에는 아무 요청도 받지 않는다.** 인증 없이 러너를 조종하면 안 된다(D6). */
  it('hello 없이 보낸 요청은 not-authenticated 로 거절한다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');

    const client = await 테스트클라이언트.접속(outcome.daemon.paths.socketPath);
    client.보낸다({ id: 'r1', type: 'listRunners' });
    const reply = await client.받는다();
    expect(reply.ok).toBe(false);
    expect((reply.error as { code: string }).code).toBe('not-authenticated');
    client.닫는다();
  });
});

describe('요청 넷 (#431 2단계-b 범위)', () => {
  async function 인증된클라이언트(dir: string, socketPath: string) {
    const client = await 테스트클라이언트.접속(socketPath);
    client.보낸다({
      type: 'hello',
      version: DAEMON_PROTOCOL_VERSION,
      token: await 토큰읽기(dir),
      role: 'app',
    });
    await client.받는다();
    return client;
  }

  it('ping 은 nowMs 를 돌려준다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const client = await 인증된클라이언트(dir, outcome.daemon.paths.socketPath);

    client.보낸다({ id: 'p1', type: 'ping' });
    const reply = await client.받는다(1);
    expect(reply.ok).toBe(true);
    expect(typeof (reply.payload as { nowMs: number }).nowMs).toBe('number');
    client.닫는다();
  });

  it('spawnRunner → listRunners → killRunner 가 소켓 위에서 이어진다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const client = await 인증된클라이언트(dir, outcome.daemon.paths.socketPath);

    client.보낸다({ id: 's1', type: 'spawnRunner', payload: { agentId: 'a1', env: {} } });
    const spawned = await client.받는다(1);
    expect(spawned.ok).toBe(true);
    const result = spawned.payload as { agentId: string; pid: number; incarnationId: string };
    expect(result.agentId).toBe('a1');
    expect(typeof result.incarnationId).toBe('string');

    client.보낸다({ id: 'l1', type: 'listRunners' });
    const listed = await client.받는다(2);
    const runners = (listed.payload as { runners: { alive: boolean; termSentAtMs: number | null }[] })
      .runners;
    expect(runners).toHaveLength(1);
    expect(runners[0]?.alive).toBe(true);
    expect(runners[0]?.termSentAtMs).toBeNull();

    client.보낸다({ id: 'k1', type: 'killRunner', payload: { agentId: 'a1' } });
    const killed = await client.받는다(3);
    expect(killed.ok).toBe(true);

    // **`termSentAtMs` 가 채워진다** — "보낸 지 N초 지났는데 아직 살아 있다"를 사람이
    // 읽을 수 있게 하는 값이다. daemon 은 그 N 을 보고 아무것도 하지 않는다.
    client.보낸다({ id: 'l2', type: 'listRunners' });
    const listed2 = await client.받는다(4);
    const runners2 = (listed2.payload as { runners: { termSentAtMs: number | null }[] }).runners;
    expect(runners2[0]?.termSentAtMs).toBe(1000);
    client.닫는다();
  });

  /** 2-d 의 요청은 아직 **모르는 요청**이다. 범위를 넘지 않았다는 고정. */
  it('shutdownIfIdle 은 unknown-request 로 거절한다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const client = await 인증된클라이언트(dir, outcome.daemon.paths.socketPath);

    client.보낸다({ id: 'x2', type: 'shutdownIfIdle' });
    expect(((await client.받는다(1)).error as { code: string }).code).toBe('unknown-request');
    client.닫는다();
  });

  /**
   * `adoptRunner` 는 이제 **아는 요청**이다(2-c). 장부가 비어 있으면 채택 0건으로 답한다 —
   * 에러가 아니다. "고아가 없다"는 정상 상태이기 때문이다.
   *
   * **payload 를 안 받는다**는 것도 여기서 고정한다: pid 를 실어 보내도 무시된다.
   * 받아 주면 소켓에 붙은 누구든 임의의 pid 를 표에 올려 `killRunner` 로 죽일 수 있다.
   */
  it('adoptRunner 는 아는 요청이고, 실어 보낸 pid 를 무시한다', async () => {
    const dir = await 임시앱디렉터리();
    const outcome = await daemon띄우기(dir);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    const client = await 인증된클라이언트(dir, outcome.daemon.paths.socketPath);

    // 이 프로세스의 pid 를 실어 보낸다 — 채택되면 vitest 자신이 `killRunner` 대상이 된다.
    client.보낸다({ id: 'a1', type: 'adoptRunner', payload: { pid: process.pid, agentId: '남의것' } });
    const res = await client.받는다(1);
    expect(res.ok).toBe(true);
    expect((res.payload as { adopted: unknown[] }).adopted).toEqual([]);

    // 표가 그대로 비어 있다 — 실어 보낸 pid 가 어디에도 안 올랐다.
    client.보낸다({ id: 'l1', type: 'listRunners' });
    const listed = await client.받는다(2);
    expect((listed.payload as { runners: unknown[] }).runners).toEqual([]);
    client.닫는다();
  });

  /** 러너가 끝나면 **`incarnationId` 를 실은** 이벤트가 붙어 있는 쪽으로 간다. */
  it('러너가 끝나면 incarnationId 를 실은 runnerExit 이벤트가 온다', async () => {
    const dir = await 임시앱디렉터리();
    const paths = daemonEndpointPaths(dir);
    const outcome = await startDaemon({
      args: {
        socket: paths.socketPath,
        entryPath: join(dir, 'murmur-daemon'),
        appVersion: '0.0.0-test',
        unknown: [],
      },
      // 진짜 자식을 띄운다 — 이벤트가 실제 종료에서 나오는지를 재는 것이 요점이다.
      runnerCommand: '/bin/sh',
      log: () => undefined,
    });
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');
    내릴것들.push(() => outcome.daemon.shutdown());
    const client = await 인증된클라이언트(dir, paths.socketPath);

    client.보낸다({ id: 's1', type: 'spawnRunner', payload: { agentId: 'a1', env: {} } });

    // ── **줄 순서를 가정하지 않는다** ────────────────────────────────────────────
    // `/bin/sh` 를 인자 없이 stdio ignore 로 띄우면 stdin 이 즉시 EOF 라 스스로 끝난다.
    // 그 종료가 **`spawnRunner` 응답보다 먼저** 소켓에 실릴 수 있다 — 2-c 에서 spawn 이
    // 커널 시작 시각을 읽느라(`ps`) 한 틱 더 걸리게 됐고, 그 사이 자식이 끝나면 exit
    // 이벤트가 앞선다. 프로토콜은 애초에 순서를 계약으로 두지 않는다(응답은 `id` 로
    // 짝짓고 이벤트는 그 사이에 낀다 — `daemon_client.rs::Pending` 주석).
    //
    // 그래서 **응답과 이벤트를 각각 찾아서** 본다. 인덱스로 집으면 이 회귀선이
    // 타이밍에 따라 빨개졌다 초록이 됐다 한다(전체 테스트 병렬 실행에서 실제로 겪었다,
    // 2026-09-06).
    const spawned = await client.찾는다((m) => m.id === 's1');
    const result = spawned.payload as { pid: number; incarnationId: string };
    정리할pid.push(result.pid);

    const event = await client.찾는다((m) => m.type === 'event');
    expect(event.event).toBe('runnerExit');
    expect((event.payload as { incarnationId: string }).incarnationId).toBe(result.incarnationId);
    client.닫는다();
  });
});

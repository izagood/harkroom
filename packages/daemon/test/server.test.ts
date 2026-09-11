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

import { DAEMON_PROTOCOL_VERSION, daemonEndpointPaths } from '@harkroom/shared/daemonEndpoint';
import { NdjsonDecoder, encodeLine } from '@harkroom/shared/daemonProtocol';

import { startDaemon, EXIT_OCCUPIED, appDataDirFromSocket } from '../src/run.js';
import { runnerLedgerPath } from '../src/runnerLedger.js';
import { runnerLogPath } from '../src/runnerLog.js';
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
  const dir = await mkdtemp(join(tmpdir(), 'harkroom-daemon-test-'));
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
      entryPath: join(appDataDir, 'harkroom-daemon'),
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

  /**
   * **개발 구획을 얹어도 되짚기가 그대로 성립한다** — 앱 쪽 변경이 daemon 쪽 규칙을
   * 고치지 않아도 되는 근거다.
   *
   * 앱은 개발 빌드에서 `<app_data_dir>/dev-<해시>` 를 뿌리로 준다
   * (`daemon_client.rs::app_data_root`). daemon 은 그 사실을 모르고 **소켓에서 두 단계
   * 위**만 되짚는다 — 상대 규칙이라 절대 위치가 어디로 가든 같은 값이 나온다.
   *
   * 이 단언이 깨지면 daemon 이 장부와 러너 로그를 앱이 보지 않는 자리에 놓는다.
   */
  it('개발 구획을 얹어도 되짚기가 뿌리를 그대로 준다', () => {
    const 뿌리 = '/somewhere/appdata/dev-1a2b3c4d';
    const paths = daemonEndpointPaths(뿌리);
    expect(appDataDirFromSocket(paths.socketPath)).toBe(뿌리);
  });
});

/**
 * **개발 구획 회귀선** — 뿌리가 갈리면 daemon 도, 장부도, 로그도 함께 갈린다.
 *
 * 앱 쪽 경로 계산은 `daemon_client.rs` 의 회귀선이 잰다. 여기서 재는 것은 **그 계산의
 * 결과가 실물에서 실제로 격리를 만드는가**다 — 서로 다른 뿌리로 daemon 을 각각 띄웠을 때
 * 둘 다 뜨고(하나가 물러나지 않고), 서로의 장부를 안 건드리는가.
 */
describe('개발 구획 — 뿌리가 다르면 서로 안 보인다 (#431 2-e)', () => {
  /**
   * **`app_data_dir()` 하나를 흉내 낸다.** 이 디렉터리가 곧 번들 식별자가 정하는
   * 그 자리이고, 구획 전에는 모든 워크트리가 이것 하나를 공유했다.
   *
   * ## 호출마다 새 디렉터리를 주면 안 된다
   *
   * 그러면 격리를 만드는 것이 구획이 아니라 `mkdtemp` 가 되어, 구획을 없애도 회귀선이
   * 초록이다 — **되돌려 RED 절차에서 실제로 그렇게 통과했다**(2026-09-06). 두 뿌리는
   * 반드시 **같은 이 디렉터리 밑**에서 갈려야 하고, 그래야 둘의 차이가 구획 하나뿐이다.
   *
   * ## 왜 `os.tmpdir()` 가 아니라 `/tmp` 인가 — 104바이트
   *
   * macOS 의 `os.tmpdir()` 는 74바이트짜리
   * `/var/folders/…/T/harkroom-daemon-test-XXXXXX` 를 준다. 거기에 구획 13바이트
   * (`dev-XXXXXXXX/`)를 얹으면 소켓이 104바이트를 넘어 `listen EINVAL` 로 죽는다 —
   * **구현 중 실제로 밟았다**(107바이트). 앱 쪽에는 `check_socket_path_length` 가 있어
   * 그 실패가 사유로 나오지만(`daemon_client.rs`), daemon 쪽은 커널 에러를 그대로 받는다.
   *
   * 즉 여기서 짧게 만드는 것은 **테스트 사정이지 운영 경로의 성질이 아니다.** 운영
   * 경로가 예산 안이라는 것은 `daemon_client.rs::구획을_넣어도_소켓이_상한_안이다` 가
   * 실측 값(95바이트)으로 못박는다.
   */
  async function 공유앱데이터디렉터리(): Promise<string> {
    const base = await mkdtemp('/tmp/mmr-p-');
    임시들.push(base);
    return base;
  }

  /**
   * **이것이 핵심이다.** 구획 전에는 두 워크트리가 뿌리 하나를 공유했고, 그래서 둘째
   * daemon 은 언제나 `occupied` 로 물러났다(바로 위 "둘째는 물러난다" 회귀선이 그
   * 성질을 잰다). 뿌리가 갈리면 **둘 다 떠야 한다.**
   *
   * 대조군이 바로 위에 있다: **같은** 뿌리면 둘째가 물러난다. 그 둘이 함께 있어야
   * "그냥 언제나 뜬다"와 구분된다.
   *
   * 되돌려 RED: 아래 두 줄에서 구획(`dev-…`)을 빼면 두 daemon 이 같은 뿌리를 보고
   * 둘째가 `occupied` 로 물러난다 — 그것이 이 변경 **이전의 상태**다.
   */
  it('서로 다른 뿌리의 daemon 둘이 함께 뜬다', async () => {
    const 앱데이터 = await 공유앱데이터디렉터리();
    const 알파 = join(앱데이터, 'dev-aaaaaaaa');
    const 베타 = join(앱데이터, 'dev-bbbbbbbb');

    const 첫째 = await daemon띄우기(알파);
    const 둘째 = await daemon띄우기(베타);

    expect(첫째.kind, '알파 daemon 이 안 떴다').toBe('running');
    expect(둘째.kind, '베타 daemon 이 물러났다 — 뿌리가 안 갈렸다').toBe('running');
    if (첫째.kind !== 'running' || 둘째.kind !== 'running') return;

    // 서로 다른 소켓을 쥐고 있다 — 앱이 어느 쪽에 붙는지가 타이밍에 안 달린다.
    expect(첫째.daemon.paths.socketPath).not.toBe(둘째.daemon.paths.socketPath);

    // 둘 다 실제로 서비스 중이다. 파일만 있고 아무도 안 듣는 상태와 구분한다.
    for (const d of [첫째.daemon, 둘째.daemon]) {
      const client = await 테스트클라이언트.접속(d.paths.socketPath);
      client.닫는다();
    }
  });

  /**
   * **대조군 — 같은 뿌리면 둘째가 물러난다.** 위 회귀선과 **같은 `app_data_dir` 밑**에서
   * 재는 것이 요점이다: 둘의 차이가 구획 하나뿐이어야 위 회귀선이 "구획 덕분에 둘 다
   * 떴다"를 말한다. 이것이 없으면 위 회귀선은 "daemon 은 언제나 뜬다"로도 통과한다.
   *
   * 그리고 이것이 **구획 전의 상태**다 — 모든 워크트리가 이 자리 하나를 공유했다.
   */
  it('같은 뿌리면 둘째는 여전히 물러난다 (대조군)', async () => {
    const 앱데이터 = await 공유앱데이터디렉터리();
    const 뿌리 = join(앱데이터, 'dev-dddddddd');

    const 첫째 = await daemon띄우기(뿌리);
    const 둘째 = await daemon띄우기(뿌리);

    expect(첫째.kind).toBe('running');
    expect(둘째.kind, '같은 뿌리인데 둘 다 떴다 — 엔드포인트 획득이 깨졌다').toBe('occupied');
  });

  /**
   * **소켓만 갈리고 장부가 공유되면 갈리기 전보다 나쁘다.**
   *
   * 두 daemon 이 각자 뜨는데 장부가 하나면, 나중에 쓴 쪽이 앞선 쪽의 표를 통째로
   * 덮어쓴다(`writeRunnerLedger` 는 전체 교체다) — 그 러너들은 다음 daemon 이 채택할
   * 근거를 잃고 영영 고아가 된다.
   *
   * 장부·러너 로그의 경로는 daemon 이 **소켓에서 되짚은 뿌리** 밑에 조립하므로
   * (`run.ts` 의 `ledgerSink`·`logSink`), 뿌리가 갈리면 자동으로 함께 갈린다.
   * 그 "자동"을 여기서 못박는다.
   */
  it('장부와 러너 로그가 뿌리와 함께 갈린다', () => {
    const 알파 = '/somewhere/appdata/dev-aaaaaaaa';
    const 베타 = '/somewhere/appdata/dev-bbbbbbbb';

    expect(runnerLedgerPath(알파)).not.toBe(runnerLedgerPath(베타));
    expect(runnerLogPath(알파, 'agent-1')).not.toBe(runnerLogPath(베타, 'agent-1'));

    // 그리고 각자 자기 뿌리 **안**에 있다 — 밖으로 새면 갈린 의미가 없다.
    expect(runnerLedgerPath(알파).startsWith(`${알파}/`)).toBe(true);
    expect(runnerLogPath(알파, 'agent-1').startsWith(`${알파}/`)).toBe(true);

    // 소켓과 **같은 디렉터리**다 — 사람이 한자리에서 대조한다(`run.ts::logSink` 주석).
    const paths = daemonEndpointPaths(알파);
    expect(runnerLedgerPath(알파).startsWith(`${paths.dir}/`)).toBe(true);
    expect(runnerLogPath(알파, 'agent-1').startsWith(`${paths.dir}/`)).toBe(true);
  });

  /**
   * **장부가 실물에서도 구획 안에 떨어진다.** 위 회귀선은 경로 계산을 잰다 — 이것은
   * 러너를 실제로 띄워 파일이 그 자리에 생기는지를 잰다.
   */
  it('실물 daemon 이 장부를 자기 구획 안에 쓴다', async () => {
    const 뿌리 = join(await 공유앱데이터디렉터리(), 'dev-cccccccc');
    const outcome = await daemon띄우기(뿌리);
    if (outcome.kind !== 'running') throw new Error('daemon 이 안 떴다');

    const client = await 테스트클라이언트.접속(outcome.daemon.paths.socketPath);
    client.보낸다({
      type: 'hello',
      version: DAEMON_PROTOCOL_VERSION,
      token: await 토큰읽기(뿌리),
      role: 'app',
    });
    expect((await client.받는다()).ok).toBe(true);

    client.보낸다({ id: 's1', type: 'spawnRunner', payload: { agentId: 'a1', env: {} } });
    const reply = await client.찾는다((m) => m.id === 's1');
    expect(reply.ok, `spawnRunner 가 실패했다: ${JSON.stringify(reply)}`).toBe(true);

    // 장부 쓰기는 응답을 기다리지 않는다(`run.ts::ledgerSink` — "기다리지 않는다").
    // 그래서 파일이 나타날 때까지 짧게 기다린다.
    const 장부 = runnerLedgerPath(뿌리);
    for (let i = 0; i < 100 && !(await stat(장부).catch(() => null)); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await stat(장부).catch(() => null), `장부가 구획 안에 안 생겼다: ${장부}`).not.toBeNull();

    client.닫는다();
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
        entryPath: join(dir, 'harkroom-daemon'),
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

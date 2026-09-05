/**
 * daemon 을 실제로 띄우는 절차 — 엔드포인트 획득 → 서비스 → 종료(`#431` 2단계-b).
 *
 * `main.ts` 가 아니라 여기 있는 이유: 회귀선이 이 절차를 **프로세스를 띄우지 않고**
 * 부를 수 있어야 한다. "점유돼 있으면 물러난다"를 재려면 `claimDaemonEndpoint` 의 결과에
 * 따른 분기를 직접 밟아야 하는데, 그것이 `main.ts` 의 top-level 에 있으면 재는 방법이
 * 자식 프로세스뿐이다.
 */
import { dirname, resolve } from 'node:path';

import {
  claimDaemonEndpoint,
  releaseDaemonEndpoint,
  type ClaimOutcome,
  type DaemonEndpointPaths,
  type DaemonPidRecord,
} from '@murmur/shared/daemonEndpoint';
import type { DaemonIdentity } from '@murmur/shared/daemonProtocol';

import type { DaemonArgs } from './args.js';
import { RunnerRegistry, nodeRunnerHost, type RunnerHost } from './runners.js';
import { DaemonServer } from './server.js';

/**
 * 종료 코드. **숫자에 뜻이 있다** — 앱이 이 값으로 "왜 안 떴는가"를 가른다.
 *
 * orca 는 중복 기동에 20 을 쓴다(실측). 그 숫자를 그대로 쓰지 않은 이유는 우리에게
 * 근거가 없기 때문이다 — 남의 관례를 근거 없이 물려받으면 다음 사람이 "왜 20 인가"에
 * 답할 수 없다. 대신 **뜻이 서로 다른 두 실패를 다른 코드로 가른다**는 성질만 물려받고,
 * 값은 우리 자리에서 정한다:
 *
 * - `10` — 이미 다른 daemon 이 서비스 중이다. **실패가 아니다.** 앱은 이 코드를 보면
 *   "그럼 그쪽에 붙으면 된다"로 넘어간다
 * - `11` — 경쟁이 격렬해 판정이 안 섰다(`inconclusive`). 잠시 뒤 다시 띄우면 된다
 * - `1` — 그 밖의 실패. 사유는 stderr 에 원문 그대로 남는다(`#368`)
 *
 * 셋을 한 코드로 뭉치면 앱이 "재시도할 것인가 / 붙을 것인가 / 사람에게 보일 것인가"를
 * 못 가른다.
 */
export const EXIT_OCCUPIED = 10;
export const EXIT_INCONCLUSIVE = 11;

export interface RunOptions {
  args: DaemonArgs;
  /**
   * 러너 사이드카 경로. 안 주면 daemon 실행 파일 옆에서 찾는다.
   *
   * **소켓 클라이언트는 이 값을 못 정한다** — `RunOptions` 는 `main.ts` 와 회귀선만
   * 만드는 것이고, 프로토콜에는 프로그램 경로를 실어 보내는 자리가 없다. 있으면 소켓에
   * 붙은 누구든 임의의 실행 파일을 daemon 권한으로 띄울 수 있다(`#250` 의 경계).
   */
  runnerCommand?: string;
  /**
   * 러너에게 줄 인자. **운영에서는 비어 있다** — 러너는 인자를 안 받고 환경변수로만
   * 설정된다(`runner_spawn` 의 계약). 이 자리는 회귀선이 오래 사는 자식(`sh -c 'sleep …'`)
   * 을 러너 대신 세우기 위한 것이고, 그래서 여기도 **클라이언트가 못 미치는 자리**다.
   */
  runnerArgs?: readonly string[];
  host?: RunnerHost;
  log?: (line: string) => void;
}

export interface RunningDaemon {
  paths: DaemonEndpointPaths;
  pidRecord: DaemonPidRecord;
  token: string;
  server: DaemonServer;
  registry: RunnerRegistry;
  /** 엔드포인트를 정리하고 서버를 내린다. **러너는 데려가지 않는다.** */
  shutdown(): Promise<void>;
}

export type StartOutcome =
  | { kind: 'running'; daemon: RunningDaemon }
  | { kind: 'occupied'; paths: DaemonEndpointPaths }
  | { kind: 'inconclusive'; paths: DaemonEndpointPaths; attempts: number };

/**
 * 러너 사이드카의 기본 경로 — **daemon 실행 파일 옆**이다.
 *
 * `build-sidecars.mjs` 가 둘을 같은 디렉터리(`src-tauri/binaries/`)로 내고 Tauri 가 그
 * 둘을 같은 자리(macOS 배포에서 `Contents/MacOS/`)로 복사한다. 그래서 daemon 은 자기
 * 위치에서 러너를 찾을 수 있고, **경로를 클라이언트에게 받지 않는다** — 받으면 소켓에
 * 붙은 누구든 임의의 실행 파일을 띄울 수 있게 된다(`#250` 의 경계).
 */
export function defaultRunnerCommand(entryPath: string): string {
  const dir = dirname(resolve(entryPath));
  const name = process.platform === 'win32' ? 'murmur-runner.exe' : 'murmur-runner';
  return resolve(dir, name);
}

/**
 * `--socket` 경로에서 앱 데이터 디렉터리를 되짚는다.
 *
 * `claimDaemonEndpoint` 는 `appDataDir` 를 받아 세 경로를 **자기가 조립한다**
 * (`daemonEndpointPaths`). 앱은 이미 조립된 경로를 인자로 넘긴다. 두 경로가 어긋나면
 * daemon 이 앱이 보지 않는 자리에 소켓을 놓게 되므로, 앱이 준 경로에서 되짚어
 * `daemonEndpointPaths` 가 **같은 값을 다시 만들도록** 한다 — 조립 규칙은 여전히 한
 * 곳(`daemonEndpointPaths`)에만 있고, 여기서는 그 입력만 복원한다.
 *
 * `<appDataDir>/daemon/daemon-v1.sock` 이므로 두 단계 위가 `appDataDir` 다.
 */
export function appDataDirFromSocket(socketPath: string): string {
  return dirname(dirname(resolve(socketPath)));
}

export async function startDaemon(options: RunOptions): Promise<StartOutcome> {
  const { args } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  if (!args.socket) throw new Error('--socket 이 없다 — daemon 은 어디에 소켓을 열지 모른다');
  const entryPath = args.entryPath ?? resolve(process.argv[1] ?? 'murmur-daemon');
  const appDataDir = appDataDirFromSocket(args.socket);

  // exit 통지는 레지스트리 → 서버로 흐르는데 서버는 레지스트리를 필요로 한다. 그 순환을
  // 한 칸짜리 참조로 끊는다 — 레지스트리가 먼저 만들어지고, 통지는 서버가 선 뒤에만 온다.
  const serverRef: { current: DaemonServer | null } = { current: null };

  const registry = new RunnerRegistry(
    {
      command: options.runnerCommand ?? defaultRunnerCommand(entryPath),
      args: options.runnerArgs ?? [],
    },
    options.host ?? nodeRunnerHost,
    (notice) => serverRef.current?.broadcastRunnerExit(notice),
  );

  // identity 는 claim 이 끝나야 완성된다(pid 레코드가 nonce 를 만든다). 서버 객체는
  // claim 전에 있어야 하므로, 그 사이는 변경 가능한 자리로 두고 claim 직후 채운다.
  const identity: DaemonIdentity = {
    pid: process.pid,
    startedAtMs: Date.now(),
    launchNonce: args.launchNonce ?? '',
    entryPath,
    appVersion: args.appVersion ?? '',
  };
  const server = new DaemonServer({
    token: '', // claim 이 만든 값으로 아래에서 바꾼다 — 그 전에는 아무도 못 붙는다.
    identity,
    registry,
    log,
  });
  serverRef.current = server;

  // ── 서버를 **먼저 만들고** 그 bind 함수를 claim 에 넘긴다 ─────────────────
  // 2-a 가 남긴 미확인 항목이 이 자리다. `claimDaemonEndpoint` 는 돌려받은 `net.Server`
  // 를 졌을 때·되감을 때 **자기가 닫는다**(`closeServer`·`rollbackSocketName`).
  // 넘기지 않으면(`void` 를 돌려주면) 파일은 지워지는데 fd 는 이 프로세스 안에 열린 채
  // 남아, 아무 이름도 없는 소켓에 대해 accept 를 계속 기다린다.
  const outcome: ClaimOutcome = await claimDaemonEndpoint(appDataDir, {
    bindTemporary: server.bindTemporary,
    appVersion: args.appVersion ?? '',
    entryPath,
  });

  if (outcome.kind === 'occupied') {
    // 서버는 claim 이 이미 닫았다(`closeServer`). 여기서 다시 닫을 것이 없다.
    return { kind: 'occupied', paths: outcome.paths };
  }
  if (outcome.kind === 'inconclusive') {
    await server.close();
    return { kind: 'inconclusive', paths: outcome.paths, attempts: outcome.attempts };
  }

  // 이겼다. 토큰·nonce 는 **claim 이 만든 것**이 사실이다(진 daemon 이 알 수 없는 값).
  server.setToken(outcome.token);
  identity.launchNonce = outcome.pidRecord.launchNonce;
  identity.startedAtMs = outcome.pidRecord.startedAtMs;

  const daemon: RunningDaemon = {
    paths: outcome.paths,
    pidRecord: outcome.pidRecord,
    token: outcome.token,
    server,
    registry,
    async shutdown() {
      // ── daemon 이 죽어도 러너는 산다 — `#431` 의 요점 ──────────────────────
      // 여기서 **러너에 시그널을 보내지 않는다.** 보내면 daemon 크래시·앱 업데이트·
      // 사람이 daemon 을 재시작하는 매 순간마다 진행 중인 턴이 끊긴다. 그리고 그 턴이
      // 잃는 것은 사람이 기다리던 답이고 디스크 어디에도 없다.
      //
      // 러너가 `detached` 로 떠 있으므로 이 프로세스의 프로세스 그룹에 오는 시그널도
      // 러너에 닿지 않는다(`runners.ts` 의 "왜 setsid 인가"). 즉 daemon 이 SIGKILL 로
      // 죽어도 결과는 같다 — 이 함수가 안 불려도 러너는 산다.
      //
      // 남는 러너를 다시 알아보는 것은 **2-c(고아 재발견)** 의 일이다. 그때까지는
      // 사람이 정리한다는 것을 알고 있어야 한다(`#431` 코멘트).
      //
      // 회귀선: `test/shutdown.test.ts` 의 "종료 경로가 러너를 데려가지 않는다".
      await server.close();
      await releaseDaemonEndpoint(outcome.paths, {
        token: outcome.token,
        launchNonce: outcome.pidRecord.launchNonce,
      });
    },
  };
  return { kind: 'running', daemon };
}

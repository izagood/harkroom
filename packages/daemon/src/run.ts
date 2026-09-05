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
import type { AdoptRunnerResult, DaemonIdentity } from '@murmur/shared/daemonProtocol';

import type { DaemonArgs } from './args.js';
import { describeVerdict, planAdoption, psIdentityProbe, type ProcessIdentityProbe } from './adopt.js';
import {
  readRunnerLedger,
  runnerLedgerPath,
  writeRunnerLedger,
  type RunnerLedgerEntry,
} from './runnerLedger.js';
import { RunnerRegistry, nodeRunnerHost, type RunnerHost } from './runners.js';
import { DaemonServer } from './server.js';

/**
 * 채택한 러너의 생사를 확인하는 주기(`#431` 2-c).
 *
 * 채택한 러너는 내 자식이 아니라 `SIGCHLD` 가 안 온다 — 물어보는 수밖에 없다
 * (`RunnerRegistry.pollAdopted` 주석). 2초는 `kill(pid, 0)` 한 번이 사실상 공짜라는
 * 사실과 "죽은 러너가 화면에 살아 있다고 남는 시간"을 맞바꾼 값이다.
 *
 * **이것은 유예도 타임아웃도 아니다.** 아무것도 죽이지 않고 아무것도 승격시키지 않는다 —
 * 이미 일어난 일을 늦게 아는 것을 덜 늦게 알 뿐이다. `killRunner` 에 타이머를 걸지
 * 않는다는 성질과 충돌하지 않는다.
 */
const ADOPTED_POLL_MS = 2_000;

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
  /**
   * 프로세스 신원 확인 표면(`#431` 2-c). 기본은 `ps -o lstart`.
   *
   * 주입 지점을 둔 이유는 하나다: **pid 재사용 회귀선이 실물로는 불가능하다.** pid 가
   * 한 바퀴를 돌아야(macOS 기본 99998) 같은 pid 를 다른 프로세스가 갖는 상황이 나오고,
   * 그것을 테스트에서 만들 방법이 없다. 이 자리로 "살아 있는데 시작 시각이 다르다"를
   * 직접 세운다.
   */
  identityProbe?: ProcessIdentityProbe;
  /**
   * 채택 폴링 주기. 회귀선이 실제 시간을 기다리지 않게 하려고만 열어 둔다 —
   * 운영에서는 `ADOPTED_POLL_MS` 다.
   */
  adoptedPollMs?: number;
  log?: (line: string) => void;
}

export interface RunningDaemon {
  paths: DaemonEndpointPaths;
  pidRecord: DaemonPidRecord;
  token: string;
  server: DaemonServer;
  registry: RunnerRegistry;
  /**
   * 기동 시 자동으로 돈 고아 재발견의 결과(`#431` 2-c). 회귀선이 이 값을 읽는다.
   *
   * `adoptRunner` 요청을 기다리지 않고 **기동 즉시** 하는 이유: 앱이 daemon 을 띄우고
   * 곧바로 `spawnRunner` 를 부를 수 있고, 그때 표가 비어 있으면 고아가 있는데도 새로
   * 띄운다 — 정확히 `#430` 이 관측한 중복이다. 채택이 먼저 끝나 있어야 그 판정이 선다.
   */
  adoptedAtStartup: AdoptRunnerResult;
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

  const probe = options.identityProbe ?? psIdentityProbe;

  // identity 는 claim 이 끝나야 완성된다(pid 레코드가 nonce 를 만든다). 서버 객체는
  // claim 전에 있어야 하므로, 그 사이는 변경 가능한 자리로 두고 claim 직후 채운다.
  //
  // **장부 sink 보다 먼저 선언한다** — sink 가 `identity.launchNonce` 를 읽는다. 아래로
  // 내리면 TDZ 에 걸리고, 그 실패는 "러너를 띄웠는데 장부가 안 써진다"로 늦게 드러난다.
  const identity: DaemonIdentity = {
    pid: process.pid,
    startedAtMs: Date.now(),
    launchNonce: args.launchNonce ?? '',
    entryPath,
    appVersion: args.appVersion ?? '',
  };

  // ── 장부 — **이 daemon 하나만 쓴다**(`#431` D5) ──────────────────────────────
  // 러너도, 앱도, 서버도 이 파일에 안 쓴다. 그래서 lost update 가 원리적으로 없다.
  // 그리고 이 파일은 `<appDataDir>/daemon/` 에 있고 그 자리의 소켓을 가진 daemon 은
  // 하나뿐이므로(2-a), "쓰는 daemon 이 하나"까지 커널이 보장한다.
  //
  // `sessions.json` 은 여기 등장하지 않는다 — 그 파일의 writer 는 러너이고, daemon 이
  // 두 번째 writer 가 되면 조용히 lost update 가 난다(`runners.ts` 모듈 주석).
  const ledgerSink = {
    save: (records: readonly { agentId: string; pid: number; incarnationId: string; startedAtMs: number; bootTimeSec: number | null }[]) => {
      const entries: RunnerLedgerEntry[] = records.map((r) => ({
        agentId: r.agentId,
        pid: r.pid,
        incarnationId: r.incarnationId,
        startedAtMs: r.startedAtMs,
        bootTimeSec: r.bootTimeSec,
        spawnedByNonce: identity.launchNonce,
      }));
      // **기다리지 않는다.** 장부 쓰기가 `spawnRunner` 응답을 늦추면 앱이 그만큼 멈춘다.
      // 실패해도 던지지 않고 로그로 올린다(`writeRunnerLedger` 주석).
      void writeRunnerLedger(appDataDir, entries, log);
    },
  };

  const registry = new RunnerRegistry(
    {
      command: options.runnerCommand ?? defaultRunnerCommand(entryPath),
      args: options.runnerArgs ?? [],
    },
    options.host ?? nodeRunnerHost,
    (notice) => serverRef.current?.broadcastRunnerExit(notice),
    ledgerSink,
  );

  /**
   * 장부를 훑어 고아를 채택한다 — `adoptRunner` 요청과 기동 시 자동 실행이 **같은 함수**를
   * 부른다. 둘이 갈리면 한쪽만 강화되는 날이 온다.
   */
  const adoptOrphans = async (): Promise<AdoptRunnerResult> => {
    const entries = await readRunnerLedger(appDataDir);
    const plan = await planAdoption(entries, probe);
    const adopted = [];
    for (const entry of plan.adopt) {
      const record = registry.adopt(entry);
      if (!record) {
        // 그 에이전트에 이미 살아 있는 표가 있었다 — 채택하면 그것을 밀어내 고아를
        // 만든다(`RunnerRegistry.adopt` 주석). 안 한 사실을 사유로 남긴다.
        plan.rejected.push({
          entry,
          verdict: { kind: 'unverifiable', reason: '이미 이 daemon 이 아는 러너가 그 자리에 있다' },
        });
        continue;
      }
      adopted.push({
        agentId: record.agentId,
        pid: record.pid,
        incarnationId: record.incarnationId,
        startedAtMs: record.startedAtMs,
        alive: true, // 방금 확인했다 — `planAdoption` 이 `kill(pid, 0)` 을 통과시킨 것만 온다.
        termSentAtMs: record.termSentAtMs,
        adopted: true,
      });
    }
    return {
      adopted,
      rejected: plan.rejected.map(({ entry, verdict }) => describeVerdict(entry, verdict)),
    };
  };

  const server = new DaemonServer({
    token: '', // claim 이 만든 값으로 아래에서 바꾼다 — 그 전에는 아무도 못 붙는다.
    identity,
    registry,
    adoptOrphans,
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
    // ── 판정 과정을 그대로 흘려보낸다 (`#456` ②) ────────────────────────────────
    // `ClaimOutcome` 은 **무엇이 됐는가**만 말한다. 잔해를 강탈했는지·누가 점유 중이었는지·
    // ABA 를 몇 번 만났는지는 그 값에 없고, 그것이 없으면 사람이 그 판단을 검증할 수 없다.
    // 실측(2026-09-06): 잔해 강탈에 **성공했는데 그 사실이 어디에도 안 남았다.**
    trace: (line) => log(line),
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

  // ── 고아 재발견 — **claim 을 이긴 뒤, 서비스를 시작하기 전에** (`#431` 2-c) ────────
  //
  // 이 순서가 load-bearing 이다.
  //
  // **claim 뒤인 이유**: 진 daemon 이 채택하면 러너 하나를 두 daemon 이 소유한다. 진 쪽은
  // 곧 물러나지만, 물러나며 장부를 다시 쓰면(자기 표는 비어 있으므로 빈 장부다) 이긴
  // daemon 의 후보를 지운다. claim 이 끝난 뒤에는 이 프로세스가 그 자리의 유일한 daemon 이다.
  //
  // **서비스 전인 이유**: 앱이 붙자마자 `spawnRunner` 를 부를 수 있다. 그때 표가 비어
  // 있으면 고아가 있는데도 새로 띄운다 — 정확히 `#430` 이 관측한 중복이다.
  const adoptedAtStartup = await adoptOrphans();
  // **후보가 0건이어도 적는다**(`#456` ②). "장부를 봤는데 아무것도 없었다"와 "장부를
  // 아예 안 봤다"는 사람에게 전혀 다른 사실이고, 조용하면 그 둘이 같아 보인다.
  log(
    `고아 재발견(기동): 장부 ${runnerLedgerPath(appDataDir)} — ` +
    `채택 ${adoptedAtStartup.adopted.length}건, 안 함 ${adoptedAtStartup.rejected.length}건`,
  );
  for (const info of adoptedAtStartup.adopted) {
    log(`  채택: agent=${info.agentId} pid=${info.pid} incarnation=${info.incarnationId}`);
  }
  // **안 한 사유가 남는 것이 요점이다.** "남의 러너라서 안 채택했다"가 로그에 있어야
  // 사람이 그 판단을 검증할 수 있다 — 채택은 곧 `killRunner` 의 대상이 된다는 뜻이므로,
  // 이 판정이 조용하면 잘못된 채택도 조용하다.
  for (const line of adoptedAtStartup.rejected) log(`  ${line}`);

  // 채택한 러너의 종료는 `SIGCHLD` 로 안 온다 — 물어봐야 한다(`pollAdopted` 주석).
  const pollTimer = setInterval(
    () => registry.pollAdopted(),
    options.adoptedPollMs ?? ADOPTED_POLL_MS,
  );
  // `unref` — 이 타이머가 daemon 을 살려 두면 안 된다. daemon 이 살아 있는 이유는 소켓이지
  // 타이머가 아니다.
  pollTimer.unref?.();

  const daemon: RunningDaemon = {
    paths: outcome.paths,
    pidRecord: outcome.pidRecord,
    token: outcome.token,
    server,
    registry,
    adoptedAtStartup,
    async shutdown() {
      clearInterval(pollTimer);
      // ── daemon 이 죽어도 러너는 산다 — `#431` 의 요점 ──────────────────────
      // 여기서 **러너에 시그널을 보내지 않는다.** 보내면 daemon 크래시·앱 업데이트·
      // 사람이 daemon 을 재시작하는 매 순간마다 진행 중인 턴이 끊긴다. 그리고 그 턴이
      // 잃는 것은 사람이 기다리던 답이고 디스크 어디에도 없다.
      //
      // 러너가 `detached` 로 떠 있으므로 이 프로세스의 프로세스 그룹에 오는 시그널도
      // 러너에 닿지 않는다(`runners.ts` 의 "왜 setsid 인가"). 즉 daemon 이 SIGKILL 로
      // 죽어도 결과는 같다 — 이 함수가 안 불려도 러너는 산다.
      //
      // ── 장부도 지우지 않는다 (`#431` 2-c) ────────────────────────────────────
      // 이 함수가 장부를 비우면 다음 daemon 이 고아를 찾을 근거가 사라진다 — 즉 러너를
      // 살려 두는 이 코드가 그 러너를 영영 못 찾게 만드는 셈이다. 장부는 **다음 daemon
      // 을 위한 것**이지 이 daemon 의 상태가 아니다.
      //
      // 소켓·pid·토큰은 지운다(`releaseDaemonEndpoint`) — 그 셋은 "지금 서비스 중"이라는
      // 뜻이라 물러난 뒤에 남으면 잔해다. 장부는 그 반대다.
      //
      // 회귀선: `test/adopt.test.ts` 의 "daemon 이 죽고 새로 떠도 그 러너를 안다".
      await server.close();
      await releaseDaemonEndpoint(outcome.paths, {
        token: outcome.token,
        launchNonce: outcome.pidRecord.launchNonce,
      });
    },
  };
  return { kind: 'running', daemon };
}

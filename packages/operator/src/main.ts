// harkroom daemon 의 엔트리포인트 — **러너를 소유하는 상주 프로세스**다(`#431` 2단계-b·c).
//
// 2단계-a 까지 이 파일은 인자를 적고 바로 끝났다. 이제는 엔드포인트를 획득하고, 소켓을
// 열고, **앞선 daemon 이 남긴 고아 러너를 다시 소유하고**(2-c), 러너를 띄우고, 죽을 때
// **러너를 데려가지 않고** 물러난다.
//
// ## 여기서 하지 않는 것 (범위)
//
// - **수명 관리**(채택 타임아웃·은퇴 플래그·크래시 루프 차단) — 2-d
// - **앱 클라이언트 전환** — 2-b 3/3. 지금 이 소켓에 붙는 앱은 아직 없다
//
// ## 종료 — 러너를 데려가지 않는다
//
// `SIGTERM`/`SIGINT` 를 받으면 **엔드포인트만 정리하고 물러난다.** 러너에게는 아무
// 시그널도 보내지 않는다. 근거는 `run.ts` 의 `shutdown` 주석에 있다 — 요약하면, 러너가
// 들고 있을 수 있는 것(사람이 기다리는 답)이 디스크 어디에도 없기 때문이다.
//
// 러너는 `detached` 로 떠 있으므로 이 프로세스의 프로세스 그룹에 오는 시그널도 러너에
// 닿지 않는다. 즉 이 핸들러가 아예 안 불려도(SIGKILL) 러너는 산다 — 이 핸들러가 하는
// 일은 러너를 살리는 것이 아니라 **잔해를 남기지 않는 것**이다.
import { resolve } from 'node:path';
import { parseDaemonArgs, describeArgs, type DaemonArgs } from './args.js';
import { parseCliArgs, register, registerViaRunningOperator, resolveDataDir, runArgs } from './cli.js';
import { runMcpBridge } from './mcpBridge.js';
import { EXIT_INCONCLUSIVE, EXIT_OCCUPIED, startDaemon } from './run.js';

/**
 * `harkroom-operator mcp-bridge` — 하네스가 stdio MCP 서버로 띄우는 갈래(스펙 2026-09-20 §5).
 * 러너 env(오퍼레이터가 spawn 때 심은 셋)를 상속한다. 여기서 끝나는 프로세스라 daemon 을 세우지
 * 않는다 — 인자 파서도 소켓 획득도 지나지 않는다.
 */
async function mcpBridgeMain(): Promise<void> {
  const socketPath = process.env.HARKROOM_OPERATOR_SOCKET;
  const runnerId = process.env.HARKROOM_RUNNER_ID;
  const secret = process.env.HARKROOM_RUNNER_SECRET;
  if (!socketPath || !runnerId || !secret) {
    console.error('mcp-bridge: HARKROOM_OPERATOR_SOCKET·HARKROOM_RUNNER_ID·HARKROOM_RUNNER_SECRET 이 필요하다 — 러너가 띄운 하네스 안에서만 돈다');
    process.exit(2);
  }
  await runMcpBridge({ socketPath, runnerId, secret }, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
}

/**
 * 서브커맨드 분기(`cli.ts`). 앱이 띄우면 `--socket …` 인자가 그대로 오고(`daemon`), 사람이나
 * launchd/systemd 가 띄우면 `run` 이다 — 둘 다 같은 `daemonMain` 으로 들어간다. 차이는 인자를
 * 누가 조립했는가뿐이다.
 */
async function main(): Promise<void> {
  const cmd = parseCliArgs(process.argv.slice(2));
  switch (cmd.command) {
    case 'mcp-bridge':
      await mcpBridgeMain();
      return;
    case 'register': {
      const dataDir = resolveDataDir(process.env.HARKROOM_DATA_DIR);
      const input = { baseUrl: cmd.baseUrl, code: cmd.code, ...(cmd.name ? { name: cmd.name } : {}) };
      // 도는 오퍼레이터가 있으면 그쪽이 claim 하고 곧바로 붙는다 — 없으면 파일에 두고 `run` 이 읽는다.
      const live = await registerViaRunningOperator(dataDir, input);
      const out = live ?? await register(input, { dataDir });
      console.log(`등록됐다: ${out.name} (${out.operatorId}) @ ${out.baseUrl} — 설정: ${dataDir}/operator/operator.json`);
      console.log(live
        ? '도는 오퍼레이터가 방금 그 커뮤니티에 붙었다. 이제 설정 › 에이전트 상세에서 이 오퍼레이터를 배정하면 러너가 뜬다.'
        : '이제 설정 › 에이전트 상세에서 이 오퍼레이터를 배정하면 러너가 뜬다. 상주시키려면: harkroom-operator run');
      return;
    }
    case 'run': {
      const dataDir = resolveDataDir(cmd.dataDir);
      await daemonMain(runArgs(dataDir, resolve(process.argv[1] ?? 'harkroom-operator'), process.env.HARKROOM_OPERATOR_VERSION));
      return;
    }
    case 'daemon':
      await daemonMain(parseDaemonArgs(cmd.argv));
      return;
  }
}

async function daemonMain(args: DaemonArgs): Promise<void> {
  // stdout 으로 적는다 — 앱이 사이드카를 spawn 하면 이 줄이 그대로 파이프로 온다.
  console.log(`harkroom daemon 기동 ${describeArgs(args)}`);

  const outcome = await startDaemon({ args });

  if (outcome.kind === 'occupied') {
    // **실패가 아니다.** 다른 daemon 이 이미 서비스 중이니 앱은 그쪽에 붙으면 된다.
    // 여기서 그 소켓을 빼앗으려 들지 않는다 — 그러면 러너 소유권이 두 daemon 으로 갈린다.
    console.log(`이미 서비스 중인 daemon 이 있다: ${outcome.paths.socketPath} — 물러난다`);
    process.exit(EXIT_OCCUPIED);
  }
  if (outcome.kind === 'inconclusive') {
    console.error(
      `엔드포인트 판정이 서지 않았다(${outcome.attempts}회 시도): ${outcome.paths.socketPath} — 잠시 뒤 다시 띄워라`,
    );
    process.exit(EXIT_INCONCLUSIVE);
  }

  const { daemon } = outcome;
  console.log(
    `소켓 서비스 시작: ${daemon.paths.socketPath} (pid ${daemon.pidRecord.pid}, nonce ${daemon.pidRecord.launchNonce})`,
  );

  let shuttingDown = false;
  const bye = (signal: NodeJS.Signals): void => {
    // 두 번째 시그널에도 러너를 데려가지 않는다. 여기에 "그럼 이번엔 강제로" 같은 경로를
    // 만들지 마라 — 그것이 정확히 이 이슈가 막으려는 것이다.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} — 엔드포인트를 정리하고 물러난다(러너는 그대로 둔다)`);
    void daemon.shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        // 정리에 실패해도 러너는 건드리지 않는다. 사유는 그대로 남긴다(`#368`).
        console.error(`엔드포인트 정리 실패: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      },
    );
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => bye(signal));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

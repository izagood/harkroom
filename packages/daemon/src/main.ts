// murmur daemon 의 엔트리포인트 — **러너를 소유하는 상주 프로세스**다(`#431` 2단계-b·c).
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
import { parseDaemonArgs, describeArgs } from './args.js';
import { EXIT_INCONCLUSIVE, EXIT_OCCUPIED, startDaemon } from './run.js';

async function main(): Promise<void> {
  const args = parseDaemonArgs(process.argv.slice(2));
  // stdout 으로 적는다 — 앱이 사이드카를 spawn 하면 이 줄이 그대로 파이프로 온다.
  console.log(`murmur daemon 기동 ${describeArgs(args)}`);

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

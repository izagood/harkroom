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
import { RUNNER_LINK_ENV, RUNNER_LINK_ENV_KEYS, RUNNER_MCP_READY_FILE_ENV, RUNNER_TURN_CAUSE_ENV } from '@harkroom/shared/runnerLink';
import { parseDaemonArgs, describeArgs, type DaemonArgs } from './args.js';
import { parseCliArgs, register, registerViaRunningOperator, resolveDataDir, runArgs } from './cli.js';
import { runMcpBridge } from './mcpBridge.js';
import { MERGE_TOOL, parseMergeArgs } from './turnMerge.js';
import { API_TOOL, parseApiArgs } from './turnApi.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { EXIT_INCONCLUSIVE, EXIT_OCCUPIED, startDaemon } from './run.js';

/**
 * `harkroom-operator mcp-bridge` — 하네스가 stdio MCP 서버로 띄우는 갈래(스펙 2026-09-20 §5).
 * 러너 env(오퍼레이터가 spawn 때 심은 셋)를 상속한다. 여기서 끝나는 프로세스라 daemon 을 세우지
 * 않는다 — 인자 파서도 소켓 획득도 지나지 않는다.
 */
async function mcpBridgeMain(): Promise<void> {
  const socketPath = process.env[RUNNER_LINK_ENV.socketPath];
  const runnerId = process.env[RUNNER_LINK_ENV.runnerId];
  const secret = process.env[RUNNER_LINK_ENV.secret];
  if (!socketPath || !runnerId || !secret) {
    console.error(`mcp-bridge: ${RUNNER_LINK_ENV_KEYS.join('·')} 이 필요하다 — 러너가 띄운 하네스 안에서만 돈다`);
    process.exit(2);
  }
  // 턴의 원인은 없어도 된다 — 옛 러너·대화형 턴은 심지 않는다(서버는 옛 셈으로 간다).
  const cause = process.env[RUNNER_TURN_CAUSE_ENV] || null;
  // 러너가 기다리는 표식(`RUNNER_MCP_READY_FILE_ENV`). 못 쓰면 러너가 시한까지 기다린 뒤 그냥 넣는다.
  const readyFile = process.env[RUNNER_MCP_READY_FILE_ENV] || null;
  const onToolsListed = readyFile ? () => { try { writeFileSync(readyFile, ''); } catch { /* 러너의 시한이 덮는다 */ } } : undefined;
  await runMcpBridge(
    { socketPath, runnerId, secret, cause, cwd: process.cwd(), ...(onToolsListed ? { onToolsListed } : {}) },
    { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  );
}

/**
 * `harkroom-operator merge <owner/name> <n> --head <sha>` — 에이전트 머지 래퍼의 **클라이언트 쪽**(스레드 3deac356).
 * 하네스의 셸에서 돈다. 인자를 재고(`parseMergeArgs`), 브릿지와 같은 소켓·같은 자격으로 `tools/call repo.merge`
 * 한 줄을 보낸 뒤 답 한 줄을 받아 JSON 으로 찍는다. 판정·gh 실행은 전부 오퍼레이터 쪽(`turnMerge.ts`)이다 —
 * 이 프로세스는 토큰도 임대도 모른다. 러너가 그 에이전트의 턴에만 이 명령의 allow 규칙을 준다.
 */
async function mergeMain(argv: string[]): Promise<void> {
  const parsed = parseMergeArgs(argv);
  if ('error' in parsed) {
    console.log(JSON.stringify({ error: { code: 'bad_request', message: parsed.error }, merged: false, exit: 2 }));
    process.exit(2);
  }
  const socketPath = process.env[RUNNER_LINK_ENV.socketPath];
  const runnerId = process.env[RUNNER_LINK_ENV.runnerId];
  const secret = process.env[RUNNER_LINK_ENV.secret];
  const cause = process.env[RUNNER_TURN_CAUSE_ENV] || null;
  if (!socketPath || !runnerId || !secret || !cause) {
    console.log(JSON.stringify({ error: { code: 'not_in_turn', message: `${RUNNER_LINK_ENV_KEYS.join('·')}·${RUNNER_TURN_CAUSE_ENV} are required — the wrapper only runs inside a runner-launched mention turn` }, merged: false, exit: 2 }));
    process.exit(2);
  }
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
    let buf = '';
    stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
        if (msg.error) resolve({ ok: false, text: JSON.stringify({ error: { code: 'link_error', message: msg.error.message ?? 'link error' } }) });
        else resolve({ ok: msg.result?.isError !== true, text: msg.result?.content?.[0]?.text ?? '{}' });
      } catch {
        resolve({ ok: false, text: JSON.stringify({ error: { code: 'bad_reply', message: 'unparseable reply from operator' } }) });
      }
      stdin.end();
    });
  });
  const bridge = runMcpBridge({ socketPath, runnerId, secret, cause, cwd: process.cwd() }, { stdin, stdout, stderr: process.stderr });
  stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: MERGE_TOOL, arguments: { repo: parsed.repo, number: parsed.number, headSha: parsed.headSha } },
  })}\n`);
  const r = await done;
  await bridge;
  // 결과 JSON 에 종료 코드와 머지 여부를 함께 싣는다(qa ②) — 에이전트가 `; echo $?` 를 붙일 이유를 없앤다. 그 꼬리는
  // allow 규칙을 깨뜨려 분류기로 간다(2026-10-03 #1130 사고).
  let out: Record<string, unknown> = {};
  try { const v: unknown = JSON.parse(r.text); if (v && typeof v === 'object') out = v as Record<string, unknown>; } catch { out = { raw: r.text }; }
  const exit = r.ok ? 0 : 1;
  console.log(JSON.stringify({ ...out, merged: out.merged === true, exit }));
  process.exit(exit);
}

/**
 * 브릿지와 같은 소켓·같은 자격으로 `tools/call` 한 줄을 보내고 답 한 줄을 받는다(머지·api 래퍼 공용 꼴).
 */
async function callOperatorTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string } | { ok: false; notInTurn: true }> {
  const socketPath = process.env[RUNNER_LINK_ENV.socketPath];
  const runnerId = process.env[RUNNER_LINK_ENV.runnerId];
  const secret = process.env[RUNNER_LINK_ENV.secret];
  const cause = process.env[RUNNER_TURN_CAUSE_ENV] || null;
  if (!socketPath || !runnerId || !secret || !cause) return { ok: false, notInTurn: true };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
    let buf = '';
    stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
        if (msg.error) resolve({ ok: false, text: JSON.stringify({ error: { code: 'link_error', message: msg.error.message ?? 'link error' } }) });
        else resolve({ ok: msg.result?.isError !== true, text: msg.result?.content?.[0]?.text ?? '{}' });
      } catch {
        resolve({ ok: false, text: JSON.stringify({ error: { code: 'bad_reply', message: 'unparseable reply from operator' } }) });
      }
      stdin.end();
    });
  });
  const bridge = runMcpBridge({ socketPath, runnerId, secret, cause, cwd: process.cwd() }, { stdin, stdout, stderr: process.stderr });
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  const r = await done;
  await bridge;
  return r;
}

/**
 * `harkroom-operator api <연결> <METHOD> <경로> [--data @파일|<글자>] [--content-type <형식>]` — 외부 API 래퍼의 **클라이언트 쪽**
 * (C안 P3, 스레드 07519d86). 하네스의 셸에서 돈다. 인자를 재고 본문 파일을 읽어 오퍼레이터에 넘긴다 — 판정·키·호출은 전부
 * 오퍼레이터 쪽(`turnApi.ts`)이다. 이 프로세스는 키도 임대도 모른다. 결과 JSON 에 `exit` 를 싣는다(꼬리 `; echo $?` 를 붙이면
 * allow 규칙이 깨진다 — 머지 래퍼 qa ②).
 */
async function apiMain(argv: string[]): Promise<void> {
  const parsed = parseApiArgs(argv, (p) => readFileSync(resolve(process.cwd(), p)));
  if ('error' in parsed) {
    console.log(JSON.stringify({ error: { code: 'bad_request', message: parsed.error }, exit: 2 }));
    process.exit(2);
  }
  const r = await callOperatorTool(API_TOOL, { connector: parsed.connector, method: parsed.method, path: parsed.path, body: parsed.body, contentType: parsed.contentType });
  if ('notInTurn' in r) {
    console.log(JSON.stringify({ error: { code: 'not_in_turn', message: `${RUNNER_LINK_ENV_KEYS.join('·')}·${RUNNER_TURN_CAUSE_ENV} are required — the wrapper only runs inside a runner-launched mention turn` }, exit: 2 }));
    process.exit(2);
  }
  let out: Record<string, unknown> = {};
  try { const v: unknown = JSON.parse(r.text); if (v && typeof v === 'object') out = v as Record<string, unknown>; } catch { out = { raw: r.text }; }
  const exit = r.ok ? 0 : 1;
  console.log(JSON.stringify({ ...out, exit }));
  process.exit(exit);
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
    case 'merge':
      await mergeMain(cmd.argv);
      return;
    case 'api':
      await apiMain(cmd.argv);
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

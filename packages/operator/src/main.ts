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
import { dirname, join, resolve } from 'node:path';
import { RUNNER_LINK_ENV, RUNNER_LINK_ENV_KEYS, RUNNER_GATE_FILE_ENV, RUNNER_MCP_READY_FILE_ENV, RUNNER_TURN_CAUSE_ENV, RUNNER_TURN_ID_ENV, RUNNER_TURN_KEY_ENV } from '@harkroom/shared/runnerLink';
import { parseDaemonArgs, describeArgs, type DaemonArgs } from './args.js';
import { parseCliArgs, register, registerViaRunningOperator, resolveDataDir, runArgs } from './cli.js';
import { runMcpBridge, writeReadyMarker } from './mcpBridge.js';
import { MERGE_TOOL, parseMergeArgs } from './turnMerge.js';
import { countTurnDenials, decideHook, notifyGateLine, decideLaneHook, decidePermissionHook, decidePostToolHook, decideTailHook, HOOK_STDIN_MAX, postToolOutput, HOOK_TIMEOUT_MS, laneDeny, readStdinCapped, type LaneDenyDecision, type PermissionRecord } from './hookCli.js';
import { CODEX_HOOK_SPEC_ENV, decodeCodexHookSpec, decodeLaneHookRules } from '@harkroom/shared/providerLane';
import { decideCodexHook } from './codexHook.js';
import { API_TOOL, parseApiArgs, readApiBodyFile } from './turnApi.js';
import { closeSync, constants as fsc, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  const secret = process.env[RUNNER_LINK_ENV.secret] || null;
  // 다리 열쇠(턴 자격)가 있으면 그것으로 붙는다 — 러너가 하네스의 MCP 설정으로 준다.
  const turnKey = process.env[RUNNER_TURN_KEY_ENV.bridge] || null;
  if (!socketPath || !runnerId || !(secret || turnKey)) {
    console.error(`mcp-bridge: ${RUNNER_LINK_ENV_KEYS.join('·')} 이 필요하다 — 러너가 띄운 하네스 안에서만 돈다`);
    process.exit(2);
  }
  // 턴의 원인은 없어도 된다 — 옛 러너·대화형 턴은 심지 않는다(서버는 옛 셈으로 간다).
  const cause = process.env[RUNNER_TURN_CAUSE_ENV] || null;
  // 턴 id 도 없어도 된다 — 없으면 서버가 그 글에 턴을 적지 않는다(러너는 「어느 턴 것인지 모른다」로 센다).
  const turnId = process.env[RUNNER_TURN_ID_ENV] || null;
  // 러너가 기다리는 표식(`RUNNER_MCP_READY_FILE_ENV`). 못 쓰면 러너가 시한까지 기다린 뒤 그냥 넣는다.
  const readyFile = process.env[RUNNER_MCP_READY_FILE_ENV] || null;
  const onToolsListed = readyFile ? () => writeReadyMarker(readyFile) : undefined;
  await runMcpBridge(
    { socketPath, runnerId, secret, turnKey, cause, turnId, cwd: process.cwd(), ...(onToolsListed ? { onToolsListed } : {}) },
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
  const r = await callOperatorTool(MERGE_TOOL, { repo: parsed.repo, number: parsed.number, headSha: parsed.headSha }, 'wrapper', { waitForAnswer: true });
  if ('notInTurn' in r) {
    console.log(JSON.stringify({ error: { code: 'not_in_turn', message: `${RUNNER_LINK_ENV_KEYS.join('·')}·${RUNNER_TURN_CAUSE_ENV} are required — the wrapper only runs inside a runner-launched mention turn` }, merged: false, exit: 2 }));
    process.exit(2);
  }
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
async function callOperatorTool(name: string, args: Record<string, unknown>, kind: 'wrapper' | 'hook' = 'wrapper', opts: { waitForAnswer?: boolean } = {}): Promise<{ ok: boolean; text: string } | { ok: false; notInTurn: true }> {
  const socketPath = process.env[RUNNER_LINK_ENV.socketPath];
  const runnerId = process.env[RUNNER_LINK_ENV.runnerId];
  const secret = process.env[RUNNER_LINK_ENV.secret] || null;
  // 셸 열쇠(턴 자격)가 있으면 그것으로 붙는다 — 그 턴의 cause 는 오퍼레이터가 장부에서 쓴다(env 의 값을 믿지 않는다).
  const turnKey = process.env[RUNNER_TURN_KEY_ENV.shell] || null;
  const cause = process.env[RUNNER_TURN_CAUSE_ENV] || null;
  if (!socketPath || !runnerId || !(turnKey || (secret && cause))) return { ok: false, notInTurn: true };
  // 옛 자격(링크 secret)으로 붙는 래퍼는 옛 kind 그대로 — 이 판을 모르는 오퍼레이터도 받는다.
  const linkKind = turnKey ? kind : kind === 'wrapper' ? 'bridge' : kind;
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
  const bridge = runMcpBridge({ socketPath, runnerId, secret, turnKey, cause, cwd: process.cwd(), kind: linkKind, ...(opts.waitForAnswer ? { failOnRejected: true } : {}) }, { stdin, stdout, stderr: process.stderr });
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  // **답이 올 때까지 프로세스를 붙잡는다**(2026-11-10). 브릿지의 재접속·유예·요청 시한 타이머는 전부 `unref` 다 — 하네스가 띄운
  // `mcp-bridge` 는 stdin 이 살아 있어 상관없지만, 이 래퍼의 stdin 은 메모리 파이프라 아무것도 루프를 붙잡지 않는다. 그래서
  // 오퍼레이터가 링크를 거절(`link.rejected`)하거나 소켓이 없어 브릿지가 재접속을 기다리는 사이 Node 가 **아무것도 찍지 않고
  // exit 0** 으로 끝났다(에이전트가 성공으로 읽을 수 있다). 이제 거절은 `failOnRejected` 로 바로, 소켓 없음은 브릿지의 유예(15초)
  // 끝에 링크 없음 오류가 오고, 위 `done` 이 그것을 `link_error` 로 바꿔 exit 1 이 된다. 브릿지는 요청 시한(90초)에 반드시
  // 답하므로 영원히 서지 않는다.
  // `merge`·`api` 가 켠다(`waitForAnswer`). PreToolUse hook 은 켜지 않는다 — hook 은 allow 만 내므로 답 없이 끝나면 평소 권한 판정으로
  // 넘어가 안전한 쪽으로 실패한다(security 판정 2026-11-10).
  const keepAlive = opts.waitForAnswer ? setInterval(() => {}, 60_000) : null;
  const r = await done.finally(() => { if (keepAlive) clearInterval(keepAlive); });
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
  const parsed = parseApiArgs(argv, (p) => readApiBodyFile(process.cwd(), p));
  if ('error' in parsed) {
    console.log(JSON.stringify({ error: { code: 'bad_request', message: parsed.error }, exit: 2 }));
    process.exit(2);
  }
  const r = await callOperatorTool(API_TOOL, { connector: parsed.connector, method: parsed.method, path: parsed.path, body: parsed.body, contentType: parsed.contentType }, 'wrapper', { waitForAnswer: true });
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
 * `harkroom-operator hook pretool` — claude 의 PreToolUse hook(H③b, 스레드 8769dbf7). 러너가 `operator.json` 의 commandHook 이 켜졌을 때만
 * 인라인 `--settings` 로 단다. **fail-closed 는 무출력이다**: 출력이 없으면 claude 는 판단하지 않은 것으로 보고 평소대로 auto 분류기가
 * 판정한다. 그래서 allow 를 낼 때만 stdout 에 쓰고, 그 밖(Bash 아님·판정에 걸림·턴 밖·오퍼레이터 무응답·시간 초과·오류)은 아무것도
 * 쓰지 않고 0 으로 끝낸다. deny 는 내지 않는다. 판정은 오퍼레이터(`turnCommand.ts` command.check)가 hook 소켓에서만 한다.
 */
async function hookMain(event: string, laneRules?: string, laneMode: 'lane' | 'tail' = 'lane', tailReach?: string, codex = false, since?: number): Promise<void> {
  const quiet = () => process.exit(0);
  if (event === 'posttool') return postToolHookMain(since ?? 0);
  if (event === 'permission') return permissionHookMain();
  if (event === 'notify') return notifyHookMain();
  if (event !== 'pretool') return quiet();
  // codex 턴: 판정할 것은 턴 env 로 온다. 값이 없는 codex(대화형 턴 등 — 같은 홈의 규칙 파일·hook 을 싣는다)는 그 채널 규칙이 없는
  // 것으로 본다: 규칙 파일의 명령에 닿으면 막고 그 밖은 판단하지 않는다. 값이 있는데 못 읽으면 막는다(fail-closed).
  if (codex) {
    const raw = process.env[CODEX_HOOK_SPEC_ENV];
    const home = process.env.CODEX_HOME;
    const spec = raw ? decodeCodexHookSpec(raw) : home?.startsWith('/') ? { rules: [], reach: [], codexHome: home } : null;
    return blockingHookMain((raw) => (spec ? decideCodexHook(raw, spec) : laneDeny()));
  }
  if (laneRules !== undefined) {
    if (laneMode !== 'tail') return laneHookMain(laneRules, decideLaneHook);
    // 꼬리 막기는 합집합 규칙이 있어야 판정한다 — 못 읽으면 막는다(fail-closed).
    const reach = decodeLaneHookRules(tailReach ?? '');
    return laneHookMain(laneRules, (raw, rules) => (reach === null ? laneDeny() : decideTailHook(raw, rules, reach)));
  }
  const timer = setTimeout(quiet, HOOK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const raw = await readStdinCapped(process.stdin, HOOK_STDIN_MAX);
    const decision = await decideHook(raw, (name, args) => callOperatorTool(name, args, 'hook'));
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch { /* 무출력 */ }
  clearTimeout(timer);
  process.exit(0);
}

/**
 * `harkroom-operator hook permission` — claude PermissionRequest hook(C안 P1, 판정은 `hookCli.ts::decidePermissionHook`). **언제나 종료 0**:
 * 결정은 deny 뿐이고, 결정 없음·오류·시간 초과는 무출력이라 지금 경로(화면 물음 → 2분 자동 거절)가 받친다(결정 #6). 0 이 아닌 종료는
 * 하네스가 비차단 오류로 넘기지만 판본마다 다를 수 있어 쓰지 않는다. 판정은 로컬이다 — 오퍼레이터에 묻지 않는다.
 *
 * 기록(1주 관찰): 오퍼레이터 데이터 디렉터리(링크 소켓 옆, 턴 밖이면 임시 디렉터리)의 `permission-hook/<날짜>.jsonl` 에 한 줄씩.
 * 명령 전문은 남기지 않는다(첫 낱말만). 같은 파일에서 이 턴의 거절 수를 세어 3번째 거절 문구를 고른다.
 */
function permissionLogPath(now: Date): string {
  const sock = process.env[RUNNER_LINK_ENV.socketPath];
  const dir = join(sock ? dirname(sock) : tmpdir(), 'permission-hook');
  return join(dir, `${now.toISOString().slice(0, 10)}.jsonl`);
}

function permissionTurn(): string {
  return process.env[RUNNER_TURN_ID_ENV] || process.env[RUNNER_TURN_CAUSE_ENV] || 'unknown';
}

/** 기록 폴더가 심링크·폴더 아닌 것이면 던진다(#1885 정리 — 남이 심어 둔 링크를 따라 다른 곳에 쓰지 않게). */
function assertPlainDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a plain directory');
}

/** 마지막 칸이 심링크면 열지 않고(O_NOFOLLOW), FIFO 에 멈추지 않게(O_NONBLOCK) 열어 일반 파일일 때만 쓴다. */
function appendNoFollow(path: string, text: string): void {
  const fd = openSync(path, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    writeSync(fd, text);
  } finally { closeSync(fd); }
}

function appendPermissionRecord(path: string, rec: PermissionRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    assertPlainDir(dirname(path));
    appendNoFollow(path, `${JSON.stringify(rec)}\n`);
  } catch { /* 기록 실패는 판정을 바꾸지 않는다 */ }
}

/** 앞선 기록 — 폴더·파일이 심링크면 읽지 않는다(던지면 0 으로 센다). */
function readPermissionRecord(path: string): string {
  assertPlainDir(dirname(path));
  const fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/**
 * `harkroom-operator hook notify` — Notification hook(C안 P2, 판정은 `hookCli.ts::notifyGateLine`). **언제나 종료 0·무출력**: 알림을
 * 막거나 바꾸지 않는다. 러너가 심은 신호 파일(`RUNNER_GATE_FILE_ENV`, 절대 경로만)에 덧붙이기만 한다 — 없으면 아무것도 안 한다.
 */
async function notifyHookMain(): Promise<void> {
  const quiet = () => process.exit(0);
  const timer = setTimeout(quiet, HOOK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const raw = await readStdinCapped(process.stdin, HOOK_STDIN_MAX);
    const file = process.env[RUNNER_GATE_FILE_ENV];
    const line = notifyGateLine(raw, Date.now());
    if (line && file && file.startsWith('/')) appendNoFollow(file, line);
  } catch { /* 무출력 */ }
  clearTimeout(timer);
  process.exit(0);
}

async function permissionHookMain(): Promise<void> {
  const now = new Date();
  const path = permissionLogPath(now);
  const turn = permissionTurn();
  const incident = (error: string): never => {
    appendPermissionRecord(path, { at: now.toISOString(), turn, event: 'hook_error', error });
    process.exit(0);
  };
  process.on('uncaughtException', () => incident('uncaught'));
  process.on('unhandledRejection', () => incident('unhandled'));
  const timer = setTimeout(() => incident('timeout'), HOOK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const raw = await readStdinCapped(process.stdin, HOOK_STDIN_MAX);
    let prior = 0;
    try { prior = countTurnDenials(readPermissionRecord(path), turn); } catch { /* 첫 줄 */ }
    const d = decidePermissionHook(raw, prior);
    if (!d) return incident('bad_input');
    appendPermissionRecord(path, { at: now.toISOString(), turn, event: 'decided', tool: d.tool, kind: d.kind, program: d.program, decision: d.decision ? 'deny' : 'none' });
    if (d.decision) writeSync(1, `${JSON.stringify(d.decision)}\n`);
  } catch {
    return incident('error');
  }
  clearTimeout(timer);
  process.exit(0);
}

/**
 * `harkroom-operator hook posttool` — 턴 도중 새 글(`turnPeek.ts`). **언제나 종료 0** 이다: 실을 글이 있으면 PostToolUse 의
 * `additionalContext` 를 쓰고, 없거나 턴 밖·오퍼레이터 무응답·시간 초과·오류면 아무것도 쓰지 않는다. 판정을 내지 않으므로 어떤 길로
 * 끝나도 넓어지는 것이 없다(fail-open 이 안전한 이유). stdin(도구 입력·결과)은 읽어 버리기만 한다 — 묻는 데 쓰지 않는다.
 */
async function postToolHookMain(since: number): Promise<void> {
  const quiet = () => process.exit(0);
  const timer = setTimeout(quiet, HOOK_TIMEOUT_MS);
  timer.unref?.();
  try {
    await readStdinCapped(process.stdin, HOOK_STDIN_MAX).catch(() => '');
    const text = await decidePostToolHook(since, (name, args) => callOperatorTool(name, args, 'hook'));
    if (text) writeSync(1, `${JSON.stringify(postToolOutput(text))}\n`);
  } catch { /* 무출력 */ }
  clearTimeout(timer);
  process.exit(0);
}

/**
 * API 키 연결 턴의 hook(D1, security F2). 거절은 **차단 종료 코드 2** 로 낸다 — 하네스는 종료 코드 2 를 막고 stderr 를 이유로 쓴다.
 * 무출력·0 이 아닌 다른 종료·오류는 하네스가 막지 않고 넘기므로, 결정 없음 말고는 어떤 길로 끝나도 2 로 끝낸다. 출력은 동기로 쓴다
 * (파이프 쓰기가 잘린 채 끝나면 「결정 없음」이 된다). 판정은 로컬이다 — 오퍼레이터에 묻지 않는다.
 */
function laneHookMain(laneRules: string, decide: (raw: string, rules: readonly string[]) => LaneDenyDecision | null): Promise<void> {
  const rules = decodeLaneHookRules(laneRules);
  return blockingHookMain((raw) => (rules === null ? laneDeny() : decide(raw, rules)));
}

/** 거절은 차단 종료 코드 2 로, 결정 없음만 0 으로 끝낸다(`laneHookMain` 주석). 판정은 로컬이다 — 오퍼레이터에 묻지 않는다. */
function blockingHookMain(decide: (raw: string) => LaneDenyDecision | null | Promise<LaneDenyDecision | null>): Promise<void> {
  // 판정이 낸 거절(이유 포함)을 그대로 쓴다 — 셸 글자·꼬리 거절의 이유가 모델에 가야 한다(#1533 의 이유가 여기서 버려지고 있었다).
  const block = (decision?: LaneDenyDecision): never => {
    try {
      const d = decision ?? laneDeny();
      writeSync(1, `${JSON.stringify(d)}\n`);
      writeSync(2, `${d.hookSpecificOutput.permissionDecisionReason}\n`);
    } catch { /* 써지지 않아도 종료 코드가 막는다 */ }
    process.exit(2);
  };
  process.on('uncaughtException', () => block());
  process.on('unhandledRejection', () => block());
  const timer = setTimeout(() => block(), HOOK_TIMEOUT_MS);
  timer.unref?.();
  return (async () => {
    try {
      const raw = await readStdinCapped(process.stdin, HOOK_STDIN_MAX);
      const denied = await decide(raw);
      if (denied !== null) return block(denied);
      clearTimeout(timer);
      process.exit(0);
    } catch {
      block();
    }
  })();
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
    case 'hook':
      await hookMain(cmd.event, cmd.laneRules, cmd.laneMode, cmd.tailReach, cmd.codex === true, cmd.since);
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

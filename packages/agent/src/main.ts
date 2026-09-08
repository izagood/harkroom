// murmur 에이전트 러너. 멘션을 기다리다 깨어나 답한다.
//
// 실행(저장소 안): MURMUR_URL=... MURMUR_PAT=murp_... pnpm --filter @murmur/agent start
// 배포판에서는 이 소스가 아니라 **단일 번들**이 돈다 — `#431` 1단계가 러너를 Tauri
// 사이드카(`externalBin`)로 만들어 앱과 함께 배포하고, `.app` 안
// `Contents/MacOS/murmur-runner` 로 놓인다. 즉 위 pnpm 명령은 죽지 않았지만 **개발 환경
// 전용**이다: 앱을 설치해 쓰는 사람에게는 실행할 소스도 pnpm 워크스페이스도 없다.
// 사람에게 보여 줄 명령의 정본은 `packages/desktop/src/lib/runnerCommand.ts` 다.
// (claude-code harness 는 claude CLI 의 로그인을 그대로 쓴다 — API 키가 필요 없다.)
//
// 옛 구조(reply.ts + harness/claudeCode.ts)는 멘션마다 `claude -p` 를 새로 띄워 stdout 의
// json 을 파싱해 대신 발화했다. 지금은 스레드마다 하네스 세션이 디스크에 살아남아
// resume 되고(sessions.ts), 발화는 에이전트 자신이 murmur MCP `message.post` 로 한다
// (prompt.ts) — 이 파일은 더 이상 하네스 출력을 파싱하지 않는다. 조립 흐름 자체는
// mentionTurn.ts::runMentionTurn 에 있다: main.ts 는 top-level await 로 접속·설정 파일
// 쓰기 같은 부작용을 곧바로 일으키므로, 그 흐름을 여기 두면 테스트가 import 하는 순간
// 진짜 서버에 붙으려 든다.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, runnerLabel } from './config.js';
import { MurmurAgentClient } from './murmur.js';
import { runMentionTurn, type MentionTurnDeps } from './mentionTurn.js';
import { runPtyTurn } from './pty.js';
import { SessionStore } from './sessions.js';
import { resolveAgentStateDir } from './stateDir.js';
import { assertHarnessContract, writeMcpConfigOnce } from './turn.js';
import type { Exec } from './workspace.js';
import { isCredentialFailure, nextBackoffMs } from './policy.js';
import { harnessBinaryName } from '@murmur/shared';
import { runnerExitPlan } from './exit.js';
import { stopRequestedForRunner } from './stop.js';
import { harnessLoginNotice } from './prompt.js';
import { createRelayClient } from './relay.js';
import { createInteractiveManager, type InteractiveManager } from './interactiveTurn.js';
import { TurnRegistry } from './turnRegistry.js';
import { MentionQueue } from './mentionQueue.js';
import { loadClaudeAccountLane } from './claudeAccounts.js';
import { ensureCodexHome } from './codexHome.js';
import { createMentionScheduler, type BatchContext } from './mentionScheduler.js';

const config = loadConfig();
const murmur = new MurmurAgentClient(config.murmurUrl, config.murmurPat);

// RUNNABLE_HARNESSES 가 실제로 PRESETS 에 구현돼 있는지 기동 시점에 검사한다.
// 불일치가 있으면 여기서 크게 실패한다 — 멘션마다 개별적으로 실패하는 대신.
assertHarnessContract();

let running = true;
/** 아래에서 늦게 배선된다(릴레이 ↔ 매니저 상호 참조). 시그널 핸들러가 참조하므로 먼저 선언한다. */
let interactive: InteractiveManager | null = null;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    running = false;
    // #337: 인터랙티브 PTY 는 사람이 닫아 줄 때까지 기다릴 대상이 없다 — 러너가 죽으면
    // 릴레이도 함께 끊긴다. 고아 회수와 같은 경로(SIGTERM→유예→SIGKILL)로 즉시 회수한다.
    interactive?.shutdown();
  });
}

// 기동 시각. 종료 요청(#129)이 **나를 향한 것인지** 가르는 기준이다 — 내가 뜨기 전에 남은
// 요청은 이미 물러난 앞 러너의 것이고, 그것으로 죽으면 새 러너가 뜰 때마다 곧바로 죽는다
// (stop.ts 주석). 원격 종료 요청은 위 SIGTERM 과 **같은 플래그**를 끈다: 진행 중인 배치를
// 끝낸 뒤에만 루프를 벗어난다는 이미 검증된 성질을 그대로 물려받는다.
const startedAtMs = Date.now();

/**
 * 종료 요청을 받아들인다. 여기서 프로세스를 죽이지 않는다 — 플래그만 끄고, 실제 종료는
 * 진행 중인 턴·배치가 끝난 뒤 루프가 스스로 빠져나가며 일어난다.
 *
 * #126: 요청을 받았다는 사실은 로그에 남긴다. 로그가 없으면 운영자는 러너가 요청 때문에
 * 물러난 것인지 죽은 것인지 구분할 수 없다.
 */
function acceptStopRequest(at: string): void {
  running = false;
  console.log(`[main] 종료 요청을 받았다 (요청 시각: ${at}) — 진행 중인 턴을 마쳤으므로 물러난다.`);
  // #250: 데스크탑 앱이 띄운 러너라면 앱이 다시 띄운다(내가 소유한 에이전트인 경우).
  // 그 밖에는 여전히 사람(또는 감독)의 몫이다 — 서버는 러너를 띄우지 않는다(design.md §1).
  console.log('  murmur 서버는 러너를 띄우지 않는다 — 다시 띄우는 것은 데스크탑 앱(소유한 에이전트) 또는 사람/launchd/systemd 감독의 몫이다.');
}

/**
 * **재시도로 낫지 않는 실패**면 78 로 물러난다 — 자격증명 실패(#250)와 하네스 실행 파일
 * 부재(#340). 판정은 `exit.ts::runnerExitPlan` 하나가 갖는다: 세 자리(기동·멘션 턴·폴 루프)가
 * 같은 판정을 써야 하고, 판정을 늘릴 때도 여기가 아니라 거기를 고쳐야 한다.
 *
 * 이름이 `...CredentialRejected` 가 아닌 이유: #340 이 같은 결의 두 번째 부류를 더했다.
 * 자격증명만 가리키는 이름으로 두면 다음 사람이 실행 파일 부재를 "왜 여기서 죽지"로 읽는다.
 */
function exitIfUnrecoverable(err: unknown): void {
  const plan = runnerExitPlan(err);
  if (!plan) return;
  for (const line of plan.lines) console.error(line);
  process.exit(plan.code);
}

/**
 * **아무도 await 하지 않은 거절도 같은 판정을 지나게 한다**(2026-09-08 14:04 실측).
 *
 * 위 세 자리(기동·멘션 턴·폴 루프)는 모두 `try/catch` 다. 그날 러너를 죽인 것은 그 셋 중
 * 어디도 아니었다: 드레인(SIGTERM)을 받은 러너가 턴을 끝내고 폴 루프를 빠져나가
 * `relay.stop()` → `종료` 까지 정상으로 출력한 **뒤**, 떠 있던 MCP send 하나가 401 로
 * 거절되며 프로세스를 죽였다. 스택에 애플리케이션 프레임이 하나도 없었다 — 그 promise 를
 * 들고 있는 곳이 없었으니 걸릴 catch 도 없다.
 *
 * 그 죽음이 남긴 것은 종료 코드 1 과 생 `StreamableHTTPError` 스택이었다. 앱이 읽는 것은
 * 78 과 마커 한 줄뿐이므로(`exit.ts` 주석) 앱은 이 죽음을 `needs_reissue` 로 칠할 수
 * 없었고, 사람이 화면에서 본 것은 이유 없이 사라진 러너다.
 *
 * **판정을 새로 만들지 않는다** — 같은 `exitIfUnrecoverable` 을 태운다. 판정이 두 벌이
 * 되면 한쪽만 고치는 사고가 나고, 이 저장소는 그 사고를 이미 두 번 겪었다(#250·#473).
 *
 * **삼키지 않는다.** 판정이 "물러날 사유가 아니다"라고 하면 다시 던져 Node 의 기본 동작으로
 * 돌려보낸다. 모든 거절을 로그 한 줄로 덮으면 이번 사고와 무관한 결함들이 조용히 묻히고,
 * 그것은 그물이 아니라 뚜껑이다.
 */
process.on('unhandledRejection', (reason: unknown) => {
  exitIfUnrecoverable(reason);
  throw reason;
});

/**
 * 하네스 로그인이 풀린 실패를 **사람이 보는 자리에** 남긴다(2026-09-07).
 *
 * 왜 러너 로그로 충분하지 않았나: 그날 forge 의 claude 로그인이 만료됐고 러너 로그에는
 * "`claude` 를 한 번 실행해 로그인해라"가 이미 있었다. 그런데 사람이 보고 있던 곳은
 * 스레드였고, 거기 남은 것은 "(답변에 실패했습니다 — 운영자 확인이 필요합니다)" 두
 * 줄이었다. 사용자의 말이 그것이다: *"그럼 다시 로그인 할 수 있게 알려줬어야지"*.
 *
 * **함수로 뽑은 이유**: 이 통지는 `exitIfUnrecoverable` 바로 앞에 서야 하고
 * (그 함수가 `process.exit` 을 부른다), 호출부에 열 줄 넘게 펼치면 판정과 그 자리가
 * 멀어진다 — `mainCredentialSites.test.ts` 가 "판정이 그 자리에 붙어 있는가"를 재고,
 * 그 회귀선이 실제로 이 변경을 잡았다.
 *
 * 던지지 않는다: 통지 실패로 물러남을 막으면 안 된다. 78 로 죽는 것이 앱이 상태를
 * 갱신하는 유일한 계약이고(`exit.ts` 주석), 그 계약이 통지 성공에 매달릴 이유가 없다.
 */
async function noticeIfHarnessLogin(
  err: unknown, channelId: string, anchor: string, messageId: string,
): Promise<void> {
  if (isCredentialFailure(err) !== 'harness-credential') return;
  try {
    // 하네스 이름은 정의에서 읽는다 — 지어내지 않는다(#368). 사람이 실행할 명령이
    // 에이전트마다 다르므로(`claude-code` → `claude`) 이름이 없으면 문구가 명령을 뺀다.
    const def = await murmur.definition();
    await murmur.post(channelId, harnessLoginNotice(harnessBinaryName(def.harness)), anchor);
  } catch (notifyErr) {
    console.error(`  ${messageId} 로그인 통지 발화 실패(물러남은 계속):`,
      notifyErr instanceof Error ? notifyErr.message : notifyErr);
  }
}

/**
 * 기동의 첫 두 호출. 여기서 401 이 나는 것이 **가장 흔한 경우**다 — 앱이 PAT 를 회전한
 * 뒤 옛 PAT 로 다시 뜬 러너, 또는 사람이 폐기된 PAT 를 넘긴 러너. 감싸지 않으면 top-level
 * rejection 이 되어 Node 가 종료 코드 1 로 죽고, 앱은 "그냥 죽었다"와 구분할 수 없다.
 */
const [me, guide] = await (async () => {
  try {
    return [await murmur.me(), await murmur.guide()] as const;
  } catch (err) {
    exitIfUnrecoverable(err);
    throw err;
  }
})();

// spec §3: 상태는 handle 로 스코프한다 — `workspaceName` 은 이미 이름에 handle 을 넣어
// 워크스페이스끼리는 안 겹치지만(다중 에이전트 격리), 세션 레코드·MCP 설정까지 나누지
// 않으면 격리가 절반만 된다: 기본 `AGENT_STATE_DIR` 로 러너 두 대를 띄우면 에이전트 B 가
// A 의 sessions.json 레코드를 읽고, harness 가 같으면 A 의 세션 id 를 B 자신의(다른)
// workspaceDir 에서 resume 하려 든다 — 다중 에이전트 협업(성공 기준 9·10)이 구조적으로
// 깨진다.
//
// #167: 그 격리가 **서버 축에서** 또 절반이었다. handle 만으로 나누면 서로 다른 서버의
// 같은 handle 이 같은 디렉터리를 쓴다. 키에 계정 id 를 넣어 서버별로 갈린다 — 왜 URL 이
// 아니라 id 인지는 stateDir.ts 주석에 있다.
//
// #174: 같은 에이전트를 여러 인스턴스로 동시에 돌리기 위해 인스턴스 축을 하나 더한다.
// MURMUR_AGENT_INSTANCE 가 없으면 기존 경로가 그대로(하위 호환). 있으면 마지막
// 세그먼트로 붙는다.
//
// **세션 파일·MCP 설정·avcs 워크스페이스 경로를 여기서 이어 붙이지 않는다** — 그 셋을
// `resolveAgentStateDir` 이 함께 돌려준다. 여기서 각자 조립하면 하나를 옛 뿌리에 두는
// 실수가 타입에 걸리지 않고, 그 파일 하나만 두 인스턴스가 밟는다(그러면 격리는 없다).
const {
  agentStateDir, legacyPath, sessionsPath, mcpDir, workspaceBaseDir, codexHomeDir,
} = resolveAgentStateDir(config.stateDir, me.handle, me.id, config.agentInstance);

// 대화형 `codex resume` 은 --ignore-user-config 를 받지 않는다. 개인 config.toml/MCP 를
// 물려주지 않으면서 기존 로그인은 재사용하도록 Murmur 전용 CODEX_HOME 을 준비한다.
const codexHome = await ensureCodexHome(codexHomeDir);

// claude 계정 풀. **비어 있는 것이 정상이다** — 그때는 `CLAUDE_CONFIG_DIR` 를 주입하지 않아
// 자식이 시스템 기본(`~/.claude`)을 쓴다(기존 동작).
//
// 이것이 필요한 이유: 러너는 `CLAUDE_CONFIG_DIR` 를 설정하지 않아 언제나 시스템 기본 계정에
// 묶여 있었고, 계정 전환을 그 경로로 하는 도구에서 사람이 계정을 바꿔도 러너에 닿지 않았다
// (`claudeAccounts.ts` 모듈 주석).
//
// `MURMUR_CLAUDE_ACCOUNTS` 에 없는 계정이 오면 이 호출이 던지고 러너는 뜨지 않는다 —
// 조용히 무시하면 운영자가 계정 B 라고 믿고 띄운 러너가 A 로 돈다.
// 풀 축(다중 계정 2단계): 어느 풀을 쓸지는 `MURMUR_CLAUDE_POOL` → `pools.json` 의 이
// 에이전트 배정 → 기본 풀 → 암묵 풀(뿌리 자체) 순으로 정해진다.
//
// **키는 `me.id`** 다 — handle 이 아닌 이유는 `stateDir.ts` 판단과 같다: handle 은 바뀔 수
// 있고 서로 다른 서버의 같은 handle 은 다른 계정이다.
//
// **러너는 `pools.json` 을 쓰지 않는다.** 읽기만 한다 — 그 파일의 writer 는 데몬 하나이고,
// 두 번째 writer 가 생기면 lost update 가 조용히 난다(`daemonProtocol.ts` 머리 주석이
// `sessions.json` 에 대해 적은 것과 같은 근거).
const lane = await loadClaudeAccountLane({
  agentId: me.id,
  forcedPool: process.env.MURMUR_CLAUDE_POOL,
  order: process.env.MURMUR_CLAUDE_ACCOUNTS,
});
const claudeAccounts = lane.accounts;
// **이름만 적는다** — 이메일·토큰·Keychain 서비스명은 적지 않는다(PAT 규율과 같다).
console.log(claudeAccounts.length
  ? `claude 계정 ${claudeAccounts.length}개 (풀: ${lane.pool ?? '기본(뿌리)'}): ${claudeAccounts.map((a) => a.name).join(', ')}`
  : `claude 계정 풀이 비어 있다 (풀: ${lane.pool ?? '지정 없음'}) — 시스템 기본 로그인을 쓴다`);

// 계정 축에 넘길 배열. 풀이 비면 `[null]` — 루프가 정확히 한 번 돌아 기존 동작과 같아진다
// (`withAccountFailover` 주석).
const accountLane = claudeAccounts.length ? claudeAccounts : [null];

// 서버별로 갈리기 전 경로가 남아 있으면 **경고만** 한다 — 자동으로 옮기지 않는다.
// 코드는 그 디렉터리가 *어느 서버의* 이 handle 것인지 알 방법이 없다(아래 레거시
// sessions.json 주석과 같은 논리다). 대신 운영자가 판단할 수 있게 명령을 그대로 준다.
const hasLegacyPath = await access(legacyPath).then(() => true, () => false);
if (hasLegacyPath) {
  console.warn(`[main] 서버별로 갈리기 전 상태 디렉터리가 있다: ${legacyPath}`);
  console.warn(`  이 디렉터리가 이 서버(${config.murmurUrl})의 @${me.handle} 것이 확실하면 옮겨라:`);
  console.warn(`    mv ${legacyPath} ${agentStateDir}`);
  console.warn('  확실하지 않으면 옮기지 마라 — 다른 커뮤니티의 세션을 접수한다.');
}

const legacySessionsPath = join(config.stateDir, 'sessions.json');
const hasLegacySessions = await access(legacySessionsPath).then(() => true, () => false);
if (hasLegacySessions) {
  console.warn(`[main] 레거시 세션 파일이 있다: ${legacySessionsPath}`);
  console.warn('  handle 스코프 이전 버전이 남긴 것이라 여러 에이전트의 레코드가 섞여 있을 수 있다.');
  console.warn('  자동으로 옮기지 않는다 — 고아 워크스페이스·claude 세션을 직접 확인하고 정리해라.');
}

const store = new SessionStore(sessionsPath);
await store.load();

// MCP 설정 파일은 기동 시 한 번만 쓴다 — PAT 는 실값이 아니라 플레이스홀더로 들어가므로
// 파일 자체는 비밀이 아니다(turn.ts::writeMcpConfigOnce). stateDir/handle 아래 고정 경로에
// 둬서 러너가 재시작돼도 같은 경로를 그대로 재사용한다.
const mcpConfigPath = await writeMcpConfigOnce(mcpDir, config.murmurUrl);

/**
 * `node:child_process` 의 `execFile` 을 workspace.ts::Exec 계약으로 감싼 얇은 어댑터.
 * **절대 reject 하지 않는다** — `ensureWorkspace` 는 stderr 를 보고 "avcs repo 아님" 폴백을
 * 판정하는데, reject 하면 그 분기 자체에 도달하지 못하고 채팅 전용 에이전트까지 죽는다
 * (브리프 지적). exec 자체가 실패해도(명령을 못 찾음 등) code 로만 알린다.
 */
const exec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      // 프로세스가 떠서 비정상 종료했으면 err.code 는 그 종료 코드(숫자)다. 애초에 spawn
      // 자체가 안 됐으면(명령을 못 찾음 등) err.code 는 'ENOENT' 같은 문자열이라 종료 코드로
      // 쓸 수 없다 — 그 경우엔 실패를 나타내는 숫자로만 뭉뚱그리고, 원인은 stderr(비어
      // 있으면 에러 메시지)로 넘긴다.
      const code = typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout, stderr: stderr || err.message });
    });
  });

// 기동 로그에 handle 과 인스턴스를 함께 적는다(#174) — 운영자가 `ps` 로 구분해야 한다.
// 형식은 `runnerLabel` 하나가 갖는다: 여기서 직접 조립하면 로그와 문서가 갈린다.
console.log(`${runnerLabel(me.handle, config.agentInstance)} 로 붙었다 — ${config.murmurUrl}`);
console.log(`상태 디렉터리: ${agentStateDir}`);
console.log('정의는 서버에서 읽는다 (murmur UI 의 Add/Edit agent 로 바꾼다)');

// #141 Phase 2: 진행 중인 턴의 PTY 바이트를 서버로 중계하는 상시 outbound WS. 여기서
// 시작하고, 끊기면 스스로 백오프로 다시 붙는다(`relay.ts` — `policy.ts::nextBackoffMs`
// 를 poll 루프와 공유한다).
//
// **접속 실패로 러너를 죽이지 않는다.** 릴레이는 관찰이고 poll 루프는 답이다 — 서버가
// attach 를 지원하지 않는 구버전이거나 릴레이가 막혀 있어도 멘션에는 답해야 한다.
// 그래서 여기에 await 도, 성공 확인도 없다.
const relay = createRelayClient({
  murmurUrl: config.murmurUrl,
  pat: config.murmurPat,
  // #337: 서버의 interactive.open 은 매니저가 처리한다. 매니저가 relay 를 필요로 해서
  // (세션 열기) 상호 참조가 생기므로 늦게 배선한다 — 매니저가 아직 없으면 릴레이가
  // 스스로 interactive.error 로 답한다(relay.ts 의 훅 부재 처리).
  onInteractiveOpen: (req) => {
    if (!interactive) return Promise.reject(new Error('러너가 아직 기동 중이다 — 잠시 뒤 다시 열어라'));
    return interactive.open(req);
  },
});
relay.start();

// #337: 진행 중 턴의 레지스트리와 멘션 유예 장부. 멘션 턴(runMentionTurn)과 인터랙티브
// 턴이 같은 레지스트리를 봐야 한다 — 갈라지면 같은 세션에 PTY 가 둘 뜬다(turnRegistry.ts).
const registry = new TurnRegistry();
const mentionQueue = new MentionQueue();
interactive = createInteractiveManager({
  murmur, store, exec, runTurn: runPtyTurn, me,
  workspaceBaseDir, mcpConfigPath, codexHome,
  // **인터랙티브 턴은 페일오버하지 않는다.** 사람이 앉아 있고, 계정을 바꾸면 그 사람이
  // 보던 세션이 사라진다(세션 파일이 계정 디렉터리 안에 있다) — 관찰 도중에 화면을 갈아
  // 치우는 것보다 그 계정의 한도를 그대로 보여 주는 편이 낫다. 그래서 첫 계정에 고정한다.
  claudeConfigDir: accountLane[0]?.configDir ?? null,
  murmurUrl: config.murmurUrl, pat: config.murmurPat,
  relay, registry, queue: mentionQueue,
  orphanMs: config.interactiveOrphanMs,
});

// 멘션 턴의 실행·회수는 여기 있다(2026-09-08 병렬화). **같은 registry·queue 를 본다** —
// 갈라지면 인터랙티브 open 이 죽은 PTY 에 사람을 붙이거나 같은 세션에 PTY 가 둘 뜬다.
//
// 이 조립이 main 에 남는 이유: 계정 축·워크스페이스 경로·MCP 설정은 기동이 정하는 값이고,
// 스케줄러가 그것을 직접 읽으면 테스트가 그 환경을 전부 세워야 한다. 스케줄러는 "무엇을
// 언제 띄우는가"만 알고, "무엇으로 띄우는가"는 이 함수가 넘긴다.
const scheduler = createMentionScheduler({
  murmur, registry, queue: mentionQueue, accountLane,
  runMentionTurn,
  // 계정별로 갈리는 두 필드(`claudeAccount`·`claudeConfigDir`)만 계정 축이 채운다 —
  // 나머지는 계정과 무관하므로 매번 같은 값이다.
  buildTurnDeps: ({ ctx, mention, account }) => ({
    murmur, store, exec, runTurn: runPtyTurn, me, guide,
    channelName: ctx.channelName(mention.channelId),
    handles: ctx.handles, workspaceBaseDir, mcpConfigPath,
    // 지시문 파일이 여기 쓰인다(#92) — 에이전트 워크스페이스가 아니라 러너의 상태
    // 디렉터리다. 워크스페이스 안에 두면 bypassPermissions 에이전트가 자기 지시문을 고칠 수 있다.
    stateDir: agentStateDir,
    codexHome,
    claudeAccount: account?.name ?? null,
    claudeConfigDir: account?.configDir ?? null,
    murmurUrl: config.murmurUrl, pat: config.murmurPat,
    turnTimeoutMs: config.turnTimeoutMs,
    relay,
    // #337: 멘션 턴도 자기 존재를 등록해야 인터랙티브 open 이 그 PTY 에 합류한다.
    registry,
  } satisfies MentionTurnDeps),
  hooks: {
    // #384: 이 스레드에 이어받기 예약이 있으면 **지금** 인터랙티브 턴이 뜬다. 이 자리인
    // 이유는 세션 상태(turnsRun·codex 세션 id)가 방금 저장됐기 때문이다 — 레지스트리
    // 해제 시점(턴의 finally)은 그 저장보다 앞이라, 그때 띄우면 이어받기 턴이 옛 레코드를
    // 읽어 같은 세션을 새로 시작하려 든다(turnRegistry.ts 의 handoffs 주석).
    resumeHandoff: async (threadKey) => { await interactive?.resumeHandoff(threadKey); },
    // #129: 종료 요청은 턴이 끝난 **지금** 본다. 진행 중인 다른 턴은 아래 drain 이 기다린다.
    stopRequested: (at) => {
      if (stopRequestedForRunner(at, startedAtMs)) acceptStopRequest(at);
    },
    exitIfUnrecoverable,
    noticeHarnessLogin: noticeIfHarnessLogin,
  },
  startedAtMs,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 폴 **자체**의 transport 실패용 백오프. 턴 실패는 스케줄러가 entry 별로 쉰다. */
let backoffMs = 1_000;

while (running) {
  try {
    const batch = await murmur.pollInbox(config.pollTimeoutMs);
    if (!batch.entries.length) {
      backoffMs = 1_000;
      // 멘션이 없어도 종료 요청은 봐야 한다. 턴 안에서만 정의를 읽으면 **조용한 러너는
      // 영원히 물러나지 않는다** — 낡은 코드로 도는 러너가 마침 한가한 경우가 정확히
      // 운영자가 세우고 싶어 하는 경우다. 새 채널을 만드는 것이 아니라 러너가 이미 매 턴
      // 읽는 그 정의를 한 번 더 읽는 것이다(빈 폴은 pollTimeoutMs 만큼 park 된 뒤라 잦지 않다).
      const idleDef = await murmur.definition();
      if (stopRequestedForRunner(idleDef.stopRequestedAt, startedAtMs)) {
        acceptStopRequest(idleDef.stopRequestedAt!);
      }
      continue;
    }

    // 채널 이름·계정 handle 은 턴마다 바뀌지 않으니 배치 단위로 한 번만 받는다.
    const channels = await murmur.channels();
    const byId = new Map(channels.map((c) => [c.id, c.name]));
    // GET /accounts — MCP 에는 이 표면이 없다. 이게 없으면 handles 맵에 나(me) 하나만
    // 남아 동료 에이전트·사람의 발화가 전부 "알 수 없는 사용자"로 렌더된다(브리프 지적,
    // 다중 에이전트 협업의 핵심 값이 여기 걸려 있다).
    const accounts = await murmur.accounts();
    const handles = Object.fromEntries(accounts.map((a) => [a.id, a.handle]));

    const ctx: BatchContext = {
      channelName: (channelId) => byId.get(channelId) ?? 'dm',
      handles,
    };
    const outcome = await scheduler.admit(batch, ctx);

    // 인플라이트 entry 는 미읽음으로 남으므로(markRead 는 턴 완료 후다) 다음 폴이 **즉시**
    // 같은 배치를 돌려준다 — 아무것도 새로 못 띄운 폴이면 잠깐 쉰다. 유예 backoff 와 같은
    // 5초다: 유예도 blocked 도 실패가 아니고(늘어나는 backoff 는 자리가 난 뒤 반응만 늦춘다),
    // 5초는 턴 하나가 끝난 뒤 대기 멘션이 시작되기까지의 최대 지연이다.
    //
    // **실패 backoff 가 여기 없는 이유**: 턴 실패는 이제 entry 별로 쉰다(mentionScheduler 의
    // `backoffFor`). 전역 sleep 으로 두면 스레드 하나의 실패가 나머지 전부를 멈춘다 —
    // 병렬화가 없앤 바로 그 결함이다. 아래 catch 의 backoffMs 는 폴 자체의 transport
    // 실패용이고, 그것은 진짜로 러너 전역이다.
    if (outcome.started === 0 && outcome.deferred + outcome.blocked > 0) {
      await sleep(5_000);
    }
    backoffMs = 1_000;
  } catch (err) {
    // #250: 자격증명 실패는 **여기서** 먼저 걸러야 한다. 앱이 PAT 를 회전할 때 옛 러너는
    // 거의 항상 롱폴에 park 돼 있어 401 이 이 catch 로 온다 — 아래 "재접속하면 된다"로
    // 삼키면 러너는 영원히 물러나지 않고, 폐기된 PAT 로 무한 재시도만 한다. 회전이
    // 약속한 것("옛 러너는 다음 호출에서 401 을 받고 78 로 스스로 물러난다")이 여기 걸려 있다.
    exitIfUnrecoverable(err);
    // 서버 재시작이면 poll 이 빈 결과로 끝나거나 transport 오류가 난다 — 둘 다 정상이고
    // 재접속하면 된다(workspace.guide 의 poll 루프 계약).
    console.error('poll 루프 오류, 재접속:', err instanceof Error ? err.message : err);
    murmur.reset();
    await sleep(backoffMs);
    backoffMs = nextBackoffMs(backoffMs);
  }
}
// #129 의 계약 "진행 중인 턴을 마쳤으므로 물러난다" 를 병렬에서도 지킨다 — 루프를 벗어난
// 지금 admit 은 멈췄고, 남은 것은 이미 도는 턴들뿐이다.
await scheduler.drain();
relay.stop();
console.log('종료');

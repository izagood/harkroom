// murmur 에이전트 러너. 멘션을 기다리다 깨어나 답한다.
//
// 실행: MURMUR_PAT=murp_... pnpm --filter @murmur/agent start
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
import { loadConfig } from './config.js';
import { MurmurAgentClient } from './murmur.js';
import { mentionAnchor, runMentionTurn, type MentionTurnDeps } from './mentionTurn.js';
import { runPtyTurn } from './pty.js';
import { SessionStore } from './sessions.js';
import { resolveAgentStateDir } from './stateDir.js';
import { assertHarnessContract, writeMcpConfigOnce } from './turn.js';
import type { Exec } from './workspace.js';
import { exhausted, isCredentialFailure, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';
import { stopRequestedForRunner } from './stop.js';
import { FAILURE_NOTICE } from './prompt.js';

const config = loadConfig();
const murmur = new MurmurAgentClient(config.murmurUrl, config.murmurPat);

// RUNNABLE_HARNESSES 가 실제로 PRESETS 에 구현돼 있는지 기동 시점에 검사한다.
// 불일치가 있으면 여기서 크게 실패한다 — 멘션마다 개별적으로 실패하는 대신.
assertHarnessContract();

let running = true;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { running = false; });
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
  console.log('  murmur 는 러너를 띄우지 않는다 — 다시 띄우는 것은 사람(또는 launchd/systemd 감독)의 몫이다.');
}

const me = await murmur.me();
const guide = await murmur.guide();

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
// 세그먼트로 붙는다. 세션 파일·MCP 설정·avcs 워크스페이스 전부 이 아래로 가서
// 인스턴스별로 격리된다.
const { agentStateDir, legacyPath } = resolveAgentStateDir(
  config.stateDir,
  me.handle,
  me.id,
  config.agentInstance,
);

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

const store = new SessionStore(join(agentStateDir, 'sessions.json'));
await store.load();

// MCP 설정 파일은 기동 시 한 번만 쓴다 — PAT 는 실값이 아니라 플레이스홀더로 들어가므로
// 파일 자체는 비밀이 아니다(turn.ts::writeMcpConfigOnce). stateDir/handle 아래 고정 경로에
// 둬서 러너가 재시작돼도 같은 경로를 그대로 재사용한다.
const mcpConfigPath = await writeMcpConfigOnce(join(agentStateDir, 'mcp'), config.murmurUrl);

// avcs 워크스페이스들이 사는 상위 디렉터리. stateDir/handle 아래에 둬서 세션 파일과 생애주기를 같이 한다.
const workspaceBaseDir = join(agentStateDir, 'workspaces');

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

const instanceLabel = config.agentInstance ?? 'default';
console.log(`@${me.handle}[${instanceLabel}] 로 붙었다 — ${config.murmurUrl}`);
console.log('정의는 서버에서 읽는다 (murmur UI 의 Add/Edit agent 로 바꾼다)');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 항목별 시도 횟수. 영원히 실패하는 한 건이 나머지 멘션을 가로막지 않게 한다. */
const attempts = new Map<number, number>();
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

    const done: number[] = [];
    let failed = false;
    for (const entry of batch.entries) {
      const mention = batch.messages.find((m) => m.id === entry.messageId);
      if (!mention) { done.push(entry.id); continue; }

      const tried = (attempts.get(entry.id) ?? 0) + 1;
      attempts.set(entry.id, tried);
      // 이 턴의 앵커 — 규칙은 mentionTurn.ts::mentionAnchor 하나가 갖는다(그 주석 참고).
      // 여기서 한 번만 계산해 턴과 아래 실패 통지가 **같은 값**을 쓴다.
      // `mention` 은 `batch.messages.find((m) => m.id === entry.messageId)` 이므로
      // `mention.id` 는 멘션 **메시지** id 다(inbox 항목 id 인 `entry.id` 가 아니다).
      const anchor = mentionAnchor(mention);
      try {
        const deps: MentionTurnDeps = {
          murmur, store, exec, runTurn: runPtyTurn, me, guide,
          channelName: byId.get(mention.channelId) ?? 'dm',
          handles, workspaceBaseDir, mcpConfigPath,
          // 지시문 파일이 여기 쓰인다(#92) — 에이전트 워크스페이스가 아니라 러너의 상태
          // 디렉터리다. 워크스페이스 안에 두면 bypassPermissions 에이전트가 자기 지시문을
          // 고칠 수 있다.
          stateDir: agentStateDir,
          murmurUrl: config.murmurUrl, pat: config.murmurPat,
          turnTimeoutMs: config.turnTimeoutMs,
        };
        // #98: 채널 최상위 멘션(threadRootId 가 null)은 **그 멘션 메시지를 루트로 하는
        // 스레드**에 답한다. 두 가지를 한 번에 얻는다: 긴 답이 채널 본문에 쌓이지 않고,
        // 멘션마다 세션 키가 갈려 서로 무관한 요청의 맥락이 섞이지 않는다. 스레드 안의
        // 멘션은 그대로 그 스레드의 루트를 쓴다.
        // 앵커를 여기서 한 번만 계산해 아래 실패 통지와 **같은 값**을 쓴다 — 같은 식을
        // 두 곳에 적으면 나중에 한쪽만 고치는 사고가 난다.
        // mentionId 는 앵커와 **다르다**: 스레드 안 멘션의 앵커는 스레드 루트이고,
        // 리액션 대상은 방금 온 그 멘션이어야 한다.
        const turn = await runMentionTurn(deps, {
          channelId: mention.channelId,
          threadRootId: anchor,
          mentionId: mention.id,
        });
        done.push(entry.id);
        attempts.delete(entry.id);
        // #129: 종료 요청은 **턴이 끝난 지금** 본다. runMentionTurn 은 턴 시작 직후에
        // 정의를 읽지만 스스로 돌아서지 않는다 — 그 간격이 "사람이 기다리는 답을 잃지
        // 않는다"를 만든다. 배치의 나머지는 미읽음으로 남겨 다음 러너가 이어받는다:
        // markRead 는 이 for 밖에서 done 만 처리하므로 답한 것만 소비된다.
        if (stopRequestedForRunner(turn.stopRequestedAt, startedAtMs)) {
          acceptStopRequest(turn.stopRequestedAt!);
          break;
        }
      } catch (err) {
        // 자격증명 실패는 재시도로 낫지 않는다. 조용히 반복하면 "왜 답이 없지"의 원인이 묻힌다.
        const credType = isCredentialFailure(err);
        if (credType !== 'other') {
          console.error(`\n${credType === 'murmur-credential' ? 'Murmur' : 'Harness'} 자격증명을 해결할 수 없다. 러너를 멈춘다.`);
          if (credType === 'murmur-credential') {
            console.error('  Murmur API 의 PAT 가 만료·폐기됐는지 확인해라.');
            console.error('  MURMUR_PAT 환경변수를 새 PAT 로 교체하고 러너를 재시작한다.');
          } else {
            console.error('  claude-code harness 는 claude CLI 의 로그인을 쓴다 — `claude` 를 한 번 실행해 로그인해라.');
          }
          console.error(`  원문: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        failed = true;
        console.error(`  ${entry.messageId} 답변 실패 (${tried}/${MAX_ATTEMPTS}):`,
          err instanceof Error ? err.message : err);
        // 한도까지 실패하면 읽음 처리해 흘려보낸다 — 안 그러면 이 항목이 큐를 막는다.
        if (exhausted(tried)) {
          console.error(`  ${entry.messageId} 포기하고 읽음 처리한다`);
          // #82: MAX_ATTEMPTS 소진 시 채널에 통지한다. 통지 실패해도 읽음 처리는 계속한다
          // (통지 실패로 러너가 멈추면 안 된다). #98: 채널 최상위 멘션도 **같은 앵커**에
          // 쓴다 — 안 그러면 답은 스레드로 가는데 실패 통지만 채널 최상위에 남아, 부른
          // 사람이 스레드를 보고 있는 동안 실패를 놓친다(#82 가 닫은 구멍이 반쪽 열린다).
          try {
            await murmur.post(mention.channelId, FAILURE_NOTICE, anchor);
          } catch (notifyErr) {
            console.error(`  ${entry.messageId} 실패 통지 발화 실패(읽음 처리 계속):`,
              notifyErr instanceof Error ? notifyErr.message : notifyErr);
          }
          done.push(entry.id);
          attempts.delete(entry.id);
        }
      }
    }
    await murmur.markRead(done);

    // poll 은 미읽음이 남아 있으면 즉시 반환한다 — 실패한 채로 곧바로 다시 폴하면 타이트 루프다.
    if (failed) {
      await sleep(backoffMs);
      backoffMs = nextBackoffMs(backoffMs);
    } else {
      backoffMs = 1_000;
    }
  } catch (err) {
    // 서버 재시작이면 poll 이 빈 결과로 끝나거나 transport 오류가 난다 — 둘 다 정상이고
    // 재접속하면 된다(workspace.guide 의 poll 루프 계약).
    console.error('poll 루프 오류, 재접속:', err instanceof Error ? err.message : err);
    murmur.reset();
    await sleep(backoffMs);
    backoffMs = nextBackoffMs(backoffMs);
  }
}
console.log('종료');

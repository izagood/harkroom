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
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { MurmurAgentClient } from './murmur.js';
import { runMentionTurn, type MentionTurnDeps } from './mentionTurn.js';
import { runPtyTurn } from './pty.js';
import { SessionStore } from './sessions.js';
import { writeMcpConfigOnce } from './turn.js';
import type { Exec } from './workspace.js';
import { exhausted, isCredentialFailure, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';

const config = loadConfig();
const murmur = new MurmurAgentClient(config.murmurUrl, config.murmurPat);
const store = new SessionStore(join(config.stateDir, 'sessions.json'));
await store.load();

let running = true;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { running = false; });
}

const me = await murmur.me();
const guide = await murmur.guide();

// MCP 설정 파일은 기동 시 한 번만 쓴다 — PAT 는 실값이 아니라 플레이스홀더로 들어가므로
// 파일 자체는 비밀이 아니다(turn.ts::writeMcpConfigOnce). stateDir 아래 고정 경로에 둬서
// 러너가 재시작돼도 같은 경로를 그대로 재사용한다.
const mcpConfigPath = await writeMcpConfigOnce(join(config.stateDir, 'mcp'), config.murmurUrl);

// avcs 워크스페이스들이 사는 상위 디렉터리. stateDir 아래에 둬서 세션 파일과 생애주기를 같이 한다.
const workspaceBaseDir = join(config.stateDir, 'workspaces');

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

console.log(`@${me.handle} 로 붙었다 — ${config.murmurUrl}`);
console.log('정의는 서버에서 읽는다 (murmur UI 의 Add/Edit agent 로 바꾼다)');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 항목별 시도 횟수. 영원히 실패하는 한 건이 나머지 멘션을 가로막지 않게 한다. */
const attempts = new Map<number, number>();
let backoffMs = 1_000;

while (running) {
  try {
    const batch = await murmur.pollInbox(config.pollTimeoutMs);
    if (!batch.entries.length) { backoffMs = 1_000; continue; }

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
      try {
        const deps: MentionTurnDeps = {
          murmur, store, exec, runTurn: runPtyTurn, me, guide,
          channelName: byId.get(mention.channelId) ?? 'dm',
          handles, workspaceBaseDir, mcpConfigPath,
          murmurUrl: config.murmurUrl, pat: config.murmurPat,
          turnTimeoutMs: config.turnTimeoutMs,
        };
        // 멘션이 있던 자리에 답한다 — 스레드 안이면 스레드에, 채널 최상위면 최상위에.
        // main.ts 가 이미 아는 값을 그대로 넘긴다(prompt.ts 가 다시 계산하면 두 번째
        // 진실 원천이 된다).
        await runMentionTurn(deps, { channelId: mention.channelId, threadRootId: mention.threadRootId });
        done.push(entry.id);
        attempts.delete(entry.id);
      } catch (err) {
        // 자격증명 실패는 재시도로 낫지 않는다. 조용히 반복하면 "왜 답이 없지"의 원인이 묻힌다.
        if (isCredentialFailure(err)) {
          console.error('\nharness 의 자격증명을 해결할 수 없다. 러너를 멈춘다.');
          console.error('  claude-code harness 는 claude CLI 의 로그인을 쓴다 — `claude` 를 한 번 실행해 로그인해라.');
          console.error(`  원문: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
        failed = true;
        console.error(`  ${entry.messageId} 답변 실패 (${tried}/${MAX_ATTEMPTS}):`,
          err instanceof Error ? err.message : err);
        // 한도까지 실패하면 읽음 처리해 흘려보낸다 — 안 그러면 이 항목이 큐를 막는다.
        if (exhausted(tried)) {
          console.error(`  ${entry.messageId} 포기하고 읽음 처리한다`);
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

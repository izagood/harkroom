// murmur 에이전트 러너. 멘션을 기다리다 깨어나 답한다.
//
// 실행: MURMUR_PAT=murp_... ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @murmur/agent start
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { buildClaudeArgs, mcpConfigFor, parseClaudeResult } from './harness/claudeCode.js';
import { MurmurAgentClient } from './murmur.js';
import { buildReplyRequest, extractReply } from './reply.js';
import { exhausted, isCredentialFailure, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';

const config = loadConfig();
const murmur = new MurmurAgentClient(config.murmurUrl, config.murmurPat);

let running = true;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { running = false; });
}

const me = await murmur.me();
const guide = await murmur.guide();

// MCP 설정 파일은 한 번만 쓴다 — PAT 가 담기므로 임시 디렉터리에 둔다.
const mcpDir = await mkdtemp(join(tmpdir(), 'murmur-agent-'));
const mcpConfigPath = join(mcpDir, 'mcp.json');
await writeFile(mcpConfigPath, JSON.stringify(mcpConfigFor(config.murmurUrl, config.murmurPat)), { mode: 0o600 });

console.log(`@${me.handle} 로 붙었다 — ${config.murmurUrl}`);
console.log('정의는 서버에서 읽는다 (murmur UI 의 Add/Edit agent 로 바꾼다)');

/** `claude -p` 를 띄우고 stdout 을 모은다. 프롬프트는 stdin 으로 넘긴다(인자 길이 제한 회피). */
function runClaude(args: string[], prompt: string, cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => reject(new Error(`claude 를 실행할 수 없다: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0 && !stdout) reject(new Error(`claude 종료 ${code}: ${stderr.slice(0, 300)}`));
      else resolve({ stdout, code: code ?? 0 });
    });
    child.stdin.end(prompt);
  });
}

/** 멘션 하나에 답한다. 실패는 이 함수 안에서 끝낸다 — 한 건이 루프를 죽이지 않는다. */
async function answer(
  entry: { id: number; messageId: string; channelId: string; reason: string },
  messages: Awaited<ReturnType<typeof murmur.readThread>>,
  channelName: string,
  handles: Record<string, string>,
): Promise<void> {
  const mention = messages.find((m) => m.id === entry.messageId);
  if (!mention) return;

  // 멘션이 있던 자리에 답한다 — 스레드 안이면 스레드에, 채널 최상위면 최상위에.
  const anchor = mention.threadRootId;
  const thread = await murmur.readThread(mention.channelId, anchor);
  const req = buildReplyRequest({
    me, guide, channelName,
    mention,
    thread: thread.length ? thread : [mention],
    handles,
  });

  // 정의를 매 답변마다 읽는다 — UI 로 지시문을 바꾸면 다음 멘션부터 바로 반영된다.
  const def = await murmur.definition();
  const args = buildClaudeArgs({ ...def, handle: me.handle }, mcpConfigPath);
  // reply.ts 가 만든 대화 맥락을 하나의 프롬프트로 넘긴다. 지시문은 --append-system-prompt 로 간다.
  const prompt = [
    req.system,
    '',
    '--- 대화 ---',
    ...req.messages.map((m) => `[${m.role}] ${m.content}`),
  ].join('\n');

  const { stdout } = await runClaude(args, prompt, def.workingDir ?? process.cwd());
  const result = parseClaudeResult(stdout);
  if (!result.ok) throw new Error(result.reason);

  const reply = extractReply({ content: [{ type: 'text', text: result.text }], stop_reason: 'end_turn' });
  if (!reply) {
    console.log(`  ${entry.messageId}: 쓸 말이 없어 넘긴다`);
    return;
  }
  await murmur.post(mention.channelId, reply, anchor);
  console.log(`  ${entry.messageId} (${entry.reason}) → 답변 ${reply.length}자`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 항목별 시도 횟수. 영원히 실패하는 한 건이 나머지 멘션을 가로막지 않게 한다. */
const attempts = new Map<number, number>();
let backoffMs = 1_000;

while (running) {
  try {
    const batch = await murmur.pollInbox(config.pollTimeoutMs);
    if (!batch.entries.length) { backoffMs = 1_000; continue; }

    // 채널 이름과 handle 은 답변마다 바뀌지 않으니 배치 단위로 한 번만 받는다.
    const channels = await murmur.channels();
    const byId = new Map(channels.map((c) => [c.id, c.name]));
    const handles: Record<string, string> = { [me.id]: me.handle };

    const done: number[] = [];
    let failed = false;
    for (const entry of batch.entries) {
      const tried = (attempts.get(entry.id) ?? 0) + 1;
      attempts.set(entry.id, tried);
      try {
        await answer(entry, batch.messages, byId.get(entry.channelId) ?? 'dm', handles);
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

// murmur 에이전트 러너. 멘션을 기다리다 깨어나 답한다.
//
// 실행: MURMUR_PAT=murp_... ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @murmur/agent start
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { MurmurAgentClient } from './murmur.js';
import { buildReplyRequest, extractReply } from './reply.js';
import { exhausted, isCredentialFailure, MAX_ATTEMPTS, nextBackoffMs } from './policy.js';

const config = loadConfig();
const murmur = new MurmurAgentClient(config.murmurUrl, config.murmurPat);
const claude = new Anthropic();

let running = true;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { running = false; });
}

const me = await murmur.me();
const guide = await murmur.guide();
console.log(`@${me.handle} 로 붙었다 — ${config.murmurUrl} (model: ${config.model}, effort: ${config.effort})`);

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

  const response = await claude.messages.create({
    model: config.model,
    max_tokens: 16000,
    system: req.system,
    messages: req.messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.effort },
  });

  const reply = extractReply(response as never);
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
          console.error('\nAnthropic 자격증명을 해결할 수 없다. 러너를 멈춘다.');
          console.error('  ANTHROPIC_API_KEY 를 설정하거나 `ant auth login` 으로 프로필을 만들어라.');
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

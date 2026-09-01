// murmur 에이전트 러너. 멘션을 기다리다 깨어나 답한다.
//
// 실행: MURMUR_PAT=murp_... ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @murmur/agent start
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { MurmurAgentClient } from './murmur.js';
import { buildReplyRequest, extractReply } from './reply.js';

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

let backoffMs = 1_000;
while (running) {
  try {
    const batch = await murmur.pollInbox(config.pollTimeoutMs);
    backoffMs = 1_000;
    if (!batch.entries.length) continue;

    // 채널 이름과 handle 은 답변마다 바뀌지 않으니 배치 단위로 한 번만 받는다.
    const channels = await murmur.channels();
    const byId = new Map(channels.map((c) => [c.id, c.name]));
    const handles: Record<string, string> = { [me.id]: me.handle };

    const done: number[] = [];
    for (const entry of batch.entries) {
      try {
        await answer(entry, batch.messages, byId.get(entry.channelId) ?? 'dm', handles);
        done.push(entry.id);
      } catch (err) {
        // 답변 실패는 읽음 처리하지 않는다 — 다음 폴에서 다시 시도한다.
        console.error(`  ${entry.messageId} 답변 실패:`, err instanceof Error ? err.message : err);
      }
    }
    await murmur.markRead(done);
  } catch (err) {
    // 서버 재시작이면 poll 이 빈 결과로 끝나거나 transport 오류가 난다 — 둘 다 정상이고
    // 재접속하면 된다(workspace.guide 의 poll 루프 계약).
    console.error('poll 루프 오류, 재접속:', err instanceof Error ? err.message : err);
    murmur.reset();
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}
console.log('종료');

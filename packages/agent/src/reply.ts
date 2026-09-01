// 멘션 하나를 답변 요청으로 바꾸는 순수 로직. 네트워크도 SDK 클라이언트도 여기 없다 —
// 그래서 이 부분만 테스트되고, 루프와 API 호출은 main.ts 가 조립한다.
import type { MessageRow } from '@murmur/shared';

/** harness 에 넘기는 대화 턴. SDK 타입을 끌어오지 않는다 — harness 가 SDK 를 쓸 필요가 없다. */
export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** 서버의 메시지 본문 상한(`POST /channels/:id/messages` 의 zod `max(8000)`). 넘기면 발화가 실패한다. */
export const BODY_LIMIT = 8000;

export interface ReplyContext {
  me: { id: string; handle: string };
  /** 서버의 `workspace.guide` 원문. 규칙은 서버가 들고 있고 러너는 옮기기만 한다. */
  guide: string;
  channelName: string;
  mention: MessageRow;
  /** 멘션이 속한 스레드(또는 채널 최근 대화), seq 오름차순. */
  thread: MessageRow[];
  handles: Record<string, string>;
}

export interface ReplyRequest {
  system: string;
  messages: Turn[];
}

export function buildReplyRequest(ctx: ReplyContext): ReplyRequest {
  // 자기 발화는 assistant, 나머지는 handle 을 붙인 user 턴. 같은 역할이 연달아도 API 가 합쳐준다.
  const turns: Turn[] = ctx.thread.map((m) =>
    m.authorId === ctx.me.id
      ? { role: 'assistant' as const, content: m.body }
      : { role: 'user' as const, content: `${ctx.handles[m.authorId] ?? '알 수 없는 사용자'}: ${m.body}` },
  );

  // API 는 첫 턴이 user 여야 한다. 에이전트가 먼저 말한 스레드에서 그 앞부분을 그냥 버리면
  // 에이전트가 자기 말을 잊으므로, 턴에서만 빼고 시스템 맥락으로 옮긴다.
  const leadingOwn: string[] = [];
  while (turns.length && turns[0]!.role === 'assistant') {
    leadingOwn.push(turns.shift()!.content);
  }
  if (!turns.length) {
    const who = ctx.handles[ctx.mention.authorId] ?? '알 수 없는 사용자';
    turns.push({ role: 'user', content: `${who}: ${ctx.mention.body}` });
  }

  const system = [
    `너는 murmur 워크스페이스의 에이전트 @${ctx.me.handle} 이고, 지금 #${ctx.channelName} 에서 말한다.`,
    '사람이 너를 멘션했다. 대화 상대로서 직접 답하라.',
    '',
    '워크스페이스 규칙:',
    ctx.guide,
    ...(leadingOwn.length
      ? ['', '이 대화에서 네가 앞서 한 말(턴으로는 넘어가지 않았다):', ...leadingOwn.map((t) => `- ${t}`)]
      : []),
    '',
    `답변은 ${BODY_LIMIT}자를 넘길 수 없다(서버가 거절한다). 채팅이므로 짧고 구체적으로 쓴다.`,
    '모르는 것은 모른다고 말한다. 확인하지 않은 것을 확인한 것처럼 쓰지 않는다.',
  ].join('\n');

  return { system, messages: turns };
}

/** 모델 응답에서 채널에 실제로 쓸 문장만 뽑는다. 쓸 것이 없으면 null. */
export function extractReply(response: {
  content: { type: string; text?: string; thinking?: string }[];
  stop_reason: string | null;
  stop_details?: { type: string; category?: string | null; explanation?: string | null } | null;
}): string | null {
  // 안전 거부는 조용히 넘기면 사람이 "에이전트가 죽었나"로 읽는다. 사실로 남긴다.
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category ?? '알 수 없음';
    return `이 요청에는 답할 수 없었습니다(안전 거부: ${category}).`;
  }

  // thinking 블록은 내부 추론이다 — 채널에 나가면 안 된다.
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  if (!text) return null;

  if (text.length <= BODY_LIMIT) return text;
  return `${text.slice(0, BODY_LIMIT - 1)}…`;
}

// 스레드를 하네스 턴이 받는 텍스트로 바꾸는 순수 로직. 네트워크도 하네스 실행도 여기 없다 —
// 그래서 이 부분만 테스트되고, 프로세스 spawn·resume 판단은 main.ts 가 조립한다.
//
// reply.ts 의 후신이다(spec §4). 다른 점: 예전에는 멘션마다 프로세스를 새로 띄워 스레드
// 전체를 매번 넘겼지만, 이제 스레드마다 하네스 세션이 디스크에 살아남아 resume 되므로
// 세션이 이미 아는 것까지 다시 넘길 필요가 없다 — 그 경계가 `lastFedSeq` 다. 그리고 예전엔
// 러너가 모델 응답을 파싱해 대신 올렸지만, 이제 에이전트가 murmur MCP `message.post` 로
// 스스로 올린다 — 그래서 시스템 프롬프트가 "어디에 쓸지"까지 알려줘야 한다.
import type { MessageRow } from '@murmur/shared';

/** 서버의 메시지 본문 상한(`POST /channels/:id/messages` 의 zod `max(8000)`). 넘기면 발화가 실패한다. */
export const BODY_LIMIT = 8000;

/** 답을 올리지 않고 프로세스가 끝났을 때 러너가 에이전트 계정으로 스레드에 남기는 문구(spec §4 발화 경로). */
export const NO_REPLY_NOTICE = '(답 없이 턴을 끝냈습니다 — 프로세스는 정상 종료, 발화 없음)';

/** MAX_ATTEMPTS 를 소진했을 때 채널에 남기는 통지문구(#82). */
export const FAILURE_NOTICE = '(답변에 실패했습니다 — 운영자 확인이 필요합니다)';

/**
 * 매 턴 `--append-system-prompt` 로 하네스에 주입되는 시스템 프롬프트. 프로세스가 턴마다
 * 새로 뜨고 이 함수도 매번 다시 불리므로, UI 로 지시문(instructions)을 바꾸면 재시작 없이
 * 다음 턴부터 바로 반영된다(로드맵 §1의 기존 성질 — 세션 무효화 장치가 필요 없다).
 */
export function buildSystemPrompt(opts: {
  handle: string;
  channelName: string;
  instructions: string;
  guide: string;
}): string {
  const { handle, channelName, instructions, guide } = opts;
  return [
    `너는 murmur 워크스페이스의 에이전트 @${handle} 이고, 지금 #${channelName} 에서 말한다.`,
    '',
    '이 에이전트에 대한 지시문:',
    instructions,
    '',
    '워크스페이스 규칙:',
    guide,
    '',
    // 발화가 러너의 책임에서 에이전트의 자율로 넘어갔다(spec §4 발화 경로) — 어디에 쓸지를
    // 명시하지 않으면 턴이 조용히 끝나고, 러너는 그걸 프로세스 종료 후에나(hasOwnPostSince)
    // 알아챈다. 이 지시가 이 프롬프트에서 가장 중요한 한 줄이다.
    '답은 화면에 출력하는 것으로 끝나지 않는다 — 이 프로세스가 끝나기 전에 네가 직접 murmur',
    'MCP 의 `message.post` 도구를 불러 이 스레드에 남겨라. channelId 와 threadRootId 는',
    '대화 프롬프트 맨 위에 준다 — 그대로 넣어 호출한다(threadRootId 가 "채널 최상위(없음)"으로',
    '적혀 있으면 그 인자는 생략하고 channelId 만 넘긴다).',
    '',
    `답변은 ${BODY_LIMIT}자를 넘길 수 없다(서버가 거절한다). 채팅이므로 짧고 구체적으로 쓴다.`,
    '모르는 것은 모른다고 말한다. 확인하지 않은 것을 확인한 것처럼 쓰지 않는다.',
  ].join('\n');
}

/** 한 줄로 렌더링한다. handles 에 없는 작성자는 알 수 없는 사용자로 표시한다(reply.ts 의 기존 정책 계승) —
 * avcs 투영이 만드는 system 메시지 등, 호출 시점에 handles 맵이 못 따라온 작성자가 있을 수 있다. */
function renderLine(m: MessageRow, handles: Record<string, string>): string {
  const handle = handles[m.authorId] ?? '알 수 없는 사용자';
  // 첨부는 URL 도 미리보기도 없다(AttachmentRow 에 storageKey 가 없다 — @murmur/shared).
  // 그래도 파일명만 알려주면 에이전트가 "내용은 못 보지만 뭔가 첨부됐다"고 사실대로 답할
  // 여지가 생긴다. 존재를 통째로 숨기는 것보다 낫다.
  const attachmentNote = m.attachments.length
    ? ` [첨부: ${m.attachments.map((a) => a.filename).join(', ')}]`
    : '';
  return `${handle}: ${m.body}${attachmentNote}`;
}

/**
 * 스레드 델타를 하네스 턴 프롬프트로 조립한다(spec §4). `lastFedSeq` 보다 큰 seq 만
 * 대상이다. 첫 턴(lastFedSeq 0)은 세션 자체가 없으므로 자기 발화를 포함한 전체가 곧
 * "세션 이전 역사"라 그대로 넘긴다. resume 턴은 자기 발화를 뺀다 — 살아있는 세션이 이미
 * 안다. 단 **동료 에이전트의 발화는 절대 빼지 않는다** — 그러지 않으면 두 에이전트가 한
 * 스레드에서 각자 자기한테 온 멘션만 보는 독백이 되어 방금 동료가 끝낸 일을 다시 한다.
 */
export function buildTurnPrompt(opts: {
  messages: MessageRow[];
  lastFedSeq: number;
  meId: string;
  handles: Record<string, string>;
  /** 답을 올릴 채널·스레드. main.ts 가 멘션에서 이미 계산해 둔 값을 그대로 받는다(§4) —
   * messages 배열에서 다시 유도하지 않는다. 유도 규칙은 "루트 메시지 자신의 threadRootId
   * 는 null"이라는 데이터 구성에 기대는데, messages 가 루트 하나뿐이거나 채널 최상위
   * 발화들뿐이면 "스레드 없음"과 구별이 안 된다 — 우연히 맞는 경우가 많다고 안전한 게
   * 아니다. 호출자가 이미 알고 있는 값을 두 번째 진실 원천으로 다시 만들지 않는다. */
  channelId: string;
  threadRootId: string | null;
}): { prompt: string; fedSeq: number } {
  const { messages, lastFedSeq, meId, handles, channelId, threadRootId } = opts;
  const isFirstTurn = lastFedSeq === 0;

  const newMessages = messages.filter((m) => m.seq > lastFedSeq);
  // 넘길 게 있었든 없었든, 이번에 본 것 중 가장 큰 seq 가 다음 경계다. newMessages 가
  // 비어 있으면 reduce 의 초기값(lastFedSeq)이 그대로 나와 전진하지 않는다 — 볼 게 없었으니
  // 맞는 동작이다.
  const fedSeq = newMessages.reduce((max, m) => Math.max(max, m.seq), lastFedSeq);

  const toShow = newMessages.filter((m) => isFirstTurn || m.authorId !== meId);
  if (!toShow.length) {
    // 새 메시지가 있었지만 전부 자기 발화라 걸러진 경우도 여기로 온다. 그래도 prompt 를
    // 비우고 fedSeq 는 이미 위에서 전진시킨 값을 그대로 쓴다 — 걸러냈다고 다음 턴에 같은
    // 메시지를 또 "새 것"으로 들이밀면 세션이 매번 자기 말을 다시 보고, 반대로 fedSeq 를
    // 전진시키지 않으면 여기서 리턴만 하고 실제로는 못 본 셈이 되어 나중 turn 이 이 구간을
    // 건너뛴다 — 어느 쪽도 아니고 "봤지만 보여줄 건 없었다"가 맞는 상태다.
    return { prompt: '', fedSeq };
  }

  // "null" 을 그대로 문자열로 흘리면 에이전트가 그걸 진짜 threadRootId 로 읽어
  // message.post 에 넘길 위험이 있다 — 사람이 읽어도, 그리고 buildSystemPrompt 의 지시와도
  // 맞물리게 "채널 최상위(없음)"으로 표현한다(§4 발화 경로).
  const head = [`channelId: ${channelId}`, `threadRootId: ${threadRootId ?? '채널 최상위(없음)'}`].join('\n');
  const lines = toShow.map((m) => renderLine(m, handles));
  const prompt = [head, '', ...lines].join('\n');

  return { prompt, fedSeq };
}

/**
 * 프로세스 종료 후 "답을 올렸나" 판정(spec §4 발화 경로). 턴 시작 seq(sinceSeq) 이후에
 * 자기 발화가 있어야 인정한다 — 시작 전에 이미 있던 자기 발화까지 세면, 아무것도 안 하고
 * 끝낸 턴도 "발화했다"로 잘못 판정된다.
 */
export function hasOwnPostSince(messages: MessageRow[], meId: string, sinceSeq: number): boolean {
  return messages.some((m) => m.authorId === meId && m.seq > sinceSeq);
}

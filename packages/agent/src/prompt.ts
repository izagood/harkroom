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
 * 사람이 조종 중인 스레드에 온 멘션의 대기 통지(#337, 스펙 §5-2 결정 6). 러너가
 * **에이전트 계정으로** 스레드에 올린다 — NO_REPLY_NOTICE 와 같은 판례다: 시스템 계정을
 * 새로 만들지 않고, 그 스레드에서 말하던 바로 그 목소리가 자기 사정을 말한다.
 * entry 당 1회만 올린다(중복 판정은 mentionQueue 가 갖는다).
 */
export function controlledNotice(handle: string, pending: number): string {
  return `(지금 ${handle} 이(가) 직접 조종 중입니다 — 이 멘션은 대기 ${pending}건째로, 터미널이 닫히면 처리합니다)`;
}

/** 진행 설명이 담긴 progress 메시지의 kind 값. */
export const MESSAGE_KIND_PROGRESS = 'progress';

/**
 * 매 턴 `--append-system-prompt` 로 하네스에 주입되는 시스템 프롬프트. 프로세스가 턴마다
 * 새로 뜨고 이 함수도 매번 다시 불리므로, UI 로 지시문(instructions)을 바꾸면 재시작 없이
 * 다음 턴부터 바로 반영된다(로드맵 §1의 기존 성질 — 세션 무효화 장치가 필요 없다).
 */
/**
 * 메모리 조회 결과(#139). **세 상태를 타입으로 강제한다.**
 *
 * `string` 이나 `string | null` 로 두면 "저장소가 비었다"와 "조회가 실패했다"가 같은
 * 값이 되고, 그것이 이슈가 경고한 사고다 — **DB 장애를 "기억 없음" 으로 읽으면
 * 에이전트가 진짜 기억을 새 프로필로 덮어쓴다.** 판별 가능한 값을 두면 호출부가
 * `catch` 로 빈 값을 흘려보낼 수 없다.
 */
export type MemoryContext =
  | { core: string | null; slugs: string[] }
  | 'unavailable';

/**
 * 프롬프트에 넣기 전 이스케이프.
 *
 * 에이전트가 쓴 메모리를 **자기가 나중에 읽는다** — 저장된 프롬프트 인젝션 경로다.
 * `<` 와 `&` 를 그대로 두면 메모리 내용이 아래 경계 마커를 위조할 수 있다.
 * `&` 를 먼저 바꾼다(나중에 바꾸면 자신이 만든 `&lt;` 를 다시 망가뜨린다).
 */
export function escapeForPrompt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** 메모리 절을 만든다. 세 상태가 각각 다른 것을 낸다 — 아래 주석이 이유다. */
function memorySection(memory: MemoryContext): string[] {
  // 조회 자체가 실패했다. **아무것도 주입하지 않는다** — 온보딩 안내조차 넣으면
  // 에이전트가 "나는 기억이 없다" 고 믿고 새로 쓴다. 러너 로그에는 호출부가 남긴다.
  if (memory === 'unavailable') return [];

  if (memory.core === null && memory.slugs.length === 0) {
    // 조회는 성공했고 저장소가 비어 있다. 이건 사실이므로 안내해도 안전하다.
    return [
      '기억이 아직 없다. 이 워크스페이스에서 반복해서 쓸 사실(사람들의 역할, 저장소 규칙,',
      '자주 하는 작업)이 생기면 murmur MCP 의 `memory.set` 으로 `core` 슬러그에 적어 둬라 —',
      '다음 턴부터 여기에 실려 온다.',
      '',
    ];
  }

  const lines = ['<memory>'];
  if (memory.core !== null) lines.push(escapeForPrompt(memory.core));
  if (memory.slugs.length) {
    lines.push('', '추가로 저장된 기억(본문은 필요할 때 `memory.get` 으로 가져온다):');
    for (const slug of memory.slugs) lines.push(`- ${escapeForPrompt(slug)}`);
  }
  lines.push('</memory>', '');
  return lines;
}

export function buildSystemPrompt(opts: {
  handle: string;
  channelName: string;
  instructions: string;
  guide: string;
  /** #139: 세 상태를 구분한다. `MemoryContext` 주석 참고. */
  memory: MemoryContext;
}): string {
  const { handle, channelName, instructions, guide, memory } = opts;
  return [
    `너는 murmur 워크스페이스의 에이전트 @${handle} 이고, 지금 #${channelName} 에서 말한다.`,
    '',
    '이 에이전트에 대한 지시문:',
    instructions,
    '',
    '워크스페이스 규칙:',
    guide,
    '',
    ...memorySection(memory),
    // 발화가 러너의 책임에서 에이전트의 자율로 넘어갔다(spec §4 발화 경로) — 어디에 쓸지를
    // 명시하지 않으면 턴이 조용히 끝나고, 러너는 그걸 프로세스 종료 후에나(hasOwnPostSince)
    // 알아챈다. 이 지시가 이 프롬프트에서 가장 중요한 한 줄이다.
    '답은 화면에 출력하는 것으로 끝나지 않는다 — 이 프로세스가 끝나기 전에 네가 직접 murmur',
    'MCP 의 `message.post` 도구를 불러 이 스레드에 남겨라. channelId 와 threadRootId 는',
    '대화 프롬프트 맨 위에 준다 — 그대로 넣어 호출한다(threadRootId 가 "채널 최상위(없음)"으로',
    '적혀 있으면 그 인자는 생략하고 channelId 만 넘긴다).',
    '',
    // #90: 한 턴에서 message.post 를 여러 번 부르면 같은 스레드에 답이 여러 개 남는다.
    // 금지형("절대 두 번 부르지 마라")보다 "한 번에 정리한다"가 모델에게 실행 가능한 지시다.
    // 러너는 이걸 강제하지 못한다 — 하네스 출력을 파싱하지 않는다는 경계(pty.ts) 때문이다.
    // 그래서 이 문장이 유일한 예방이고, 위반은 턴 후 개수를 세어 러너 로그에 남긴다.
    '한 턴에 한 번만 발화한다 — 답이 길어도 나눠 올리지 않고 한 번에 정리해서 올린다.',
    '',
    // #144: 긴 작업 시작 시 진행 설명 — message.progress MCP 도구로 올린다.
    // 이것은 결과 발화로 세지 않으며, 사용자가 읽을 수 있어야 뜻이 있다.
    // 진행 설명 예시: "avcs intent 를 만들고 merge3 결함 재현 테스트부터 붙인다 — 서너 턴 걸린다"
    '긴 작업을 시작할 때는 먼저 `message.progress` MCP 도구로 짧게 무슨 작업인지 설명하고 들어간다. ',
    '이 진행 설명은 결과 발화로 세지 않으며, 사용자가 기다릴지 끊을지 판단할 근거를 준다.',
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
 * 턴 시작 seq(sinceSeq) 이후 자기 발화가 몇 개인지 센다. 기준선을 turnStartSeq 로 두는
 * 이유: 시작 전에 이미 있던 자기 발화까지 세면 아무것도 안 한 턴도 "발화했다"가 된다.
 *
 * 불리언이 아니라 개수인 이유(#90): 호출부가 두 가지를 물어야 한다 — "발화가 있었나"(> 0,
 * NO_REPLY_NOTICE 와 커서 전진 판단)와 "여러 번 발화했나"(> 1, 중복 발화 관측). 불리언만
 * 두면 후자를 알 수 없고, 두 함수가 각자 세면 규칙이 둘로 갈린다. 세는 곳은 여기 하나다.
 *
 * progress 메시지는 **결과 발화로 세지 않는다.** 에이전트가 `message.progress` 로 올린
 * 진행 설명이고, 그것을 결과로 세면 "설명만 올리고 결과를 못 올린 턴"이 침묵으로
 * 취급되지 않아 NO_REPLY_NOTICE 가 억제된다 — #144 가 가장 비싸다고 지목한 문제다.
 *
 * 플래그로 두지 않는 이유: progress 를 결과로 세고 싶은 호출자가 없다. 끌 수 있게 두면
 * 그 인자가 잘못 넘어오는 경로가 생길 뿐이다.
 *
 * #123 의 `excludeSeqs`(러너가 직접 올린 진행 통지를 빼던 것)는 제거했다 — 러너가 더
 * 이상 아무것도 올리지 않는다. 그 폴백은 **1단계의 진행 중 리액션**이 대신한다:
 * 러너는 내용 있는 설명을 쓸 수 없으므로(하네스 출력 파싱은 pty.ts 의 금지선이다)
 * 스레드 칸을 쓰지 않는 리액션이 옳은 자리다.
 */
export function countOwnPostsSince(messages: MessageRow[], meId: string, sinceSeq: number): number {
  return messages.filter(
    (m) => m.authorId === meId && m.seq > sinceSeq && m.kind !== MESSAGE_KIND_PROGRESS,
  ).length;
}

/**
 * "이 턴에 결과 발화가 있었나". `countOwnPostsSince` 위에 얹은 얇은 판정이다 — 세는 규칙이
 * 두 곳에 생기지 않게 한다. 실패 경로(커서를 전진시킬지 정하는 자리)가 이 불리언을 쓴다.
 *
 * #144: progress 메시지는 제외되므로, 진행 설명만 있고 결과가 없는 턴은 NO_REPLY_NOTICE 를 표시한다.
 *
 * #174: 같은 에이전트를 **여러 인스턴스**로 돌리면 이 판정이 둘을 구분하지 못한다 —
 * 인스턴스 A 가 올린 발화를 B 도 "내 발화"로 본다(계정이 같기 때문이다). 그래서 두
 * 인스턴스가 같은 스레드에 동시에 답하면 답이 둘 남을 수 있다.
 *
 * **그것을 여기서 고치지 않는다.** 인스턴스별 구분을 넣으면 발화를 세는 규칙이 두 벌이
 * 되고(`countOwnPostsSince` 와 갈린다), 이 저장소는 이미 at-least-once 를 택했다. 대가는
 * 문서로 알린다 — `packages/agent/README.md` 의 "대가" 절이 그 자리이고, 인스턴스를
 * 여러 개 띄우는 것은 그 대가를 아는 운영자의 선택이다.
 */
export function hasOwnPostSince(messages: MessageRow[], meId: string, sinceSeq: number): boolean {
  return countOwnPostsSince(messages, meId, sinceSeq) > 0;
}

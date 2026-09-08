// 스레드를 하네스 턴이 받는 텍스트로 바꾸는 순수 로직. 네트워크도 하네스 실행도 여기 없다 —
// 그래서 이 부분만 테스트되고, 프로세스 spawn·resume 판단은 main.ts 가 조립한다.
//
// reply.ts 의 후신이다(spec §4). 다른 점: 예전에는 멘션마다 프로세스를 새로 띄워 스레드
// 전체를 매번 넘겼지만, 이제 스레드마다 하네스 세션이 디스크에 살아남아 resume 되므로
// 세션이 이미 아는 것까지 다시 넘길 필요가 없다 — 그 경계가 `lastFedSeq` 다. 그리고 예전엔
// 러너가 모델 응답을 파싱해 대신 올렸지만, 이제 에이전트가 murmur MCP `message.post` 로
// 스스로 올린다 — 그래서 시스템 프롬프트가 "어디에 쓸지"까지 알려줘야 한다.
import { messagePermalink, type MessageRow } from '@murmur/shared';

/** 서버의 메시지 본문 상한(`POST /channels/:id/messages` 의 zod `max(8000)`). 넘기면 발화가 실패한다. */
export const BODY_LIMIT = 8000;

/** 답을 올리지 않고 프로세스가 끝났을 때 러너가 에이전트 계정으로 스레드에 남기는 문구(spec §4 발화 경로). */
export const NO_REPLY_NOTICE = '(답 없이 턴을 끝냈습니다 — 프로세스는 정상 종료, 발화 없음)';


/** 통지에 실을 하네스 출력의 상한. 이 길이를 넘으면 앞을 자르고 뒤를 남긴다. */
const TAIL_NOTICE_MAX_CHARS = 1000;

/**
 * 발화 없이 끝난 턴에서 **하네스가 마지막에 남긴 출력**을 통지에 실을 형태로 만든다.
 *
 * ## 왜 있는가
 *
 * 2026-09-07 15:08 의 턴은 `PR #533 을 올렸고 CI 두 잡이 도는 중입니다 … 통과 시 머지하고
 * 결과를 스레드에 올리겠습니다` 를 stdout 에 남기고 끝났다. 사람이 스레드에서 본 것은
 * `(답 없이 턴을 끝냈습니다)` 한 줄이었다 — **정보는 존재했고 러너가 버렸다.** 그 말은
 * `runTurn` 이 돌려주는 `tail`(끝 2KB) 안에 있었고, 성공 경로가 그것을 쓰지 않았을 뿐이다.
 *
 * ## 이것은 하네스 출력의 "해석" 이 아니다
 *
 * `pty.ts` 가 그은 금지선은 **출력을 해석해 답으로 삼는 것**이다(옛 `reply.ts::extractReply`
 * 가 하던 일이고, 발화를 에이전트의 자율로 옮기며 걷어냈다). 여기서 하는 것은 판정이 아니라
 * **증거 첨부**다: 무슨 뜻인지 정하지 않고, 마지막에 무엇이 찍혔는지를 그대로 보인다.
 * 그래서 발화 판정(`countOwnPostsSince`)은 여전히 murmur 데이터만 본다.
 *
 * ## 새니타이즈가 선택이 아닌 이유
 *
 * PTY 안에서는 stdout·stderr 가 한 스트림으로 섞이고 프롬프트 에코까지 남는다(`pty.ts`
 * 주석의 실측). 러너 env 에는 `MURMUR_PAT` 가 있으므로 하네스가 `env` 를 찍는 순간 그것이
 * tail 에 들어온다 — 걸러내지 않으면 이 통지가 **비밀을 대화에 흘리는 경로**가 된다.
 * 그래서 러너 자신의 PAT(정확한 문자열), `murp_` 모양의 다른 토큰, `Bearer <값>` 을 가린다.
 *
 * 남길 것이 없으면 `null` — 빈 상자는 "여기 뭔가 있다"는 거짓 신호다(`readAskMeta` 판례).
 */
export function harnessTailNotice(tail: string, pat: string): string | null {
  let text = tail
    // CSI/OSC 등 ANSI 이스케이프. 색·커서 제어가 그대로 흐르면 사람이 읽을 수 없다.
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[[\]()#;?]*[0-9;?]*[A-Za-z@-~]/g, '')
    // PTY 는 줄바꿈을 `\r\n` 으로 낸다. `\r` 만 남으면 채팅에서 줄이 겹쳐 보인다.
    .replace(/\r\n?/g, '\n')
    // 남은 제어문자(벨 등). 개행·탭은 뜻이 있으므로 남긴다.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 비밀 가리기. **정확한 PAT 를 먼저** 지운다 — 아래 모양 규칙이 못 잡는 형태여도 이건 잡힌다.
  if (pat.length > 0) text = text.split(pat).join('(가림)');
  text = text
    .replace(/murp_[A-Za-z0-9_-]+/g, '(가림)')
    .replace(/(Bearer\s+)\S+/gi, '$1(가림)');

  text = text.trim();
  if (text.length === 0) return null;
  // 뒤를 남긴다 — 마지막에 무엇을 했는지가 이 통지의 값이다. 자른 사실을 밝힌다:
  // 밝히지 않으면 사람이 "이게 전부"로 읽는다.
  return text.length > TAIL_NOTICE_MAX_CHARS
    ? `…${text.slice(-TAIL_NOTICE_MAX_CHARS)}`
    : text;
}

/** MAX_ATTEMPTS 를 소진했을 때 채널에 남기는 통지문구(#82). */
export const FAILURE_NOTICE = '(답변에 실패했습니다 — 운영자 확인이 필요합니다)';

/**
 * 하네스 로그인이 풀렸을 때 **스레드에** 남기는 통지(2026-09-07).
 *
 * 왜 러너 로그로 충분하지 않은가: 그날 forge 의 claude 로그인이 만료됐고, 러너 로그에는
 * "`claude` 를 한 번 실행해 로그인해라"가 이미 있었다. 그런데 사람이 보고 있던 곳은
 * 스레드였고 거기 남은 것은 `FAILURE_NOTICE`("운영자 확인이 필요합니다") 두 줄이었다.
 * 사용자의 말이 정확히 이것이다: *"그럼 다시 로그인 할 수 있게 알려줬어야지"*.
 *
 * 이름을 인자로 받는 이유: 하네스마다 명령이 다르고(`claude-code` → `claude`,
 * `codex` → `codex`), 모르면 **지어내지 않는다**(#368).
 */
export function harnessLoginNotice(binary: string | null): string {
  return binary === null
    ? '(하네스 로그인이 풀렸습니다 — 그 CLI 로 다시 로그인한 뒤 저를 다시 불러 주세요)'
    : `(하네스 로그인이 풀렸습니다 — 터미널에서 \`${binary}\` 를 실행해 다시 로그인한 뒤 저를 다시 불러 주세요)`;
}

/**
 * 사용량 한도에 걸렸을 때 스레드에 남기는 통지(2026-09-07 16:05 실측).
 *
 * 자격증명 통지와 갈라야 하는 이유: 여기서 사람이 할 일은 **아무것도 없다** — 기다리면
 * 낫는다. 그것을 "운영자 확인이 필요합니다"로 말하면 사람은 로그인과 PAT 를 뒤진다.
 * 시각을 아는 것이 이 통지의 값이고, 모르면 사실만 말한다.
 */
export function quotaNotice(resetsAt: string | null): string {
  return resetsAt === null
    ? '(사용량 한도에 걸렸습니다 — 한도가 풀린 뒤 다시 불러 주세요)'
    : `(사용량 한도에 걸렸습니다 — ${resetsAt} 에 풀립니다. 그 뒤에 다시 불러 주세요)`;
}

/**
 * 하네스 세션 상태가 어긋났을 때 스레드에 남기는 통지(2026-09-07 19:03 실측).
 *
 * 앞의 두 통지와 갈라야 하는 이유는 **사람이 할 일이 다르다**는 것뿐이다. 한도는 기다리면
 * 낫고, 로그인 만료는 그 CLI 로 다시 로그인하면 낫는다. 이것은 둘 다 아니다 — 러너가 든
 * 세션 상태와 하네스의 디스크가 어긋난 것이라, 기다려도 로그인해도 그대로다.
 *
 * `FAILURE_NOTICE`("운영자 확인이 필요합니다")가 실패한 자리가 정확히 여기다: 확인이
 * 필요한 것은 맞는데 **무엇을** 확인할지 말하지 않았다. 그래서 어긋난 대상과 볼 곳을
 * 함께 적는다. 인자를 받지 않는 이유는 세션 uuid 가 사람에게 아무 정보도 주지 않아서다 —
 * 그 값이 필요한 사람은 러너 로그를 보고, 거기에는 tail 원문이 함께 찍힌다.
 */
export function sessionConflictNotice(): string {
  return '(하네스 세션 상태가 어긋나 답할 수 없었습니다 — 운영자가 러너 로그를 확인해야 합니다)';
}

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

/** 깨움 예약이 남기는 대기 줄의 kind 값(마이그레이션 040). */
export const MESSAGE_KIND_WAKE = 'wake';

/**
 * **결과 발화로 세지 않는** 메시지 종류. `progress` 는 과정 설명이고 `wake` 는 기다림의
 * 표시다 — 둘 다 "물어본 것에 답한 것"이 아니다.
 *
 * 집합으로 둔 이유: 세는 자리가 하나여야 한다(`countOwnPostsSince` 주석). 종류가 늘 때
 * 필터 조건을 두 곳에서 고치면 한쪽만 고쳐지고, 그때 침묵한 턴이 발화한 것으로 판정된다.
 */
const NON_UTTERANCE_KINDS: ReadonlySet<string> = new Set([MESSAGE_KIND_PROGRESS, MESSAGE_KIND_WAKE]);

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

/**
 * 스킬 절(#140 의 마지막 조각). **도구는 처음부터 있었고, 없던 것은 이 절이다.**
 *
 * 2026-09-09 실측: `workspace_skill` 테이블과 MCP `skill.propose`(#140), 승인 화면(#311),
 * 러너의 실체화(`mentionTurn.ts::syncSkills`)가 전부 머지·릴리스된 상태에서 설정 → Skills
 * 는 대기 0 / 승인 0 / 비활성 0 이었다. 이 파일에 `skill` 이 한 번도 없었기 때문이다 —
 * 에이전트는 도구 목록에서 이름만 보고 그것을 **언제** 부를지 알지 못했다. 옆의 메모리
 * (#139)가 실제로 쓰이는 것이 대조군이다: `memorySection` 은 "이런 게 생기면 `memory.set`
 * 해라"까지 적어 둔다. 도구를 여는 것과 쓰이게 하는 것은 다른 일이다.
 *
 * **문턱을 적는 것이 이 절의 절반이다.** 승인된 스킬은 모든 에이전트의 스킬 디렉터리에
 * 깔리므로 가장 레버리지가 큰 프롬프트 표면이고(#140 결정문), 제안 하나에는 사람의 승인
 * 시간이 든다. 문턱이 없으면 두 방향으로 다 실패한다 — 낮으면 승인 큐가 차서 게이트가
 * 형식이 되고, 아예 없으면 지금처럼 0 이다. 그래서 "언제 제안하나"와 "무엇은 제안하지
 * 않나"를 같은 절에 적는다. 후자가 없는 절은 전자만 읽힌다.
 *
 * 메모리와 갈라 주는 것도 여기서 한다. 둘 다 "배운 것을 남기는" 도구라 문턱을 말하지
 * 않으면 아무 쪽에나 쓰인다: 나만 쓸 사실은 메모리, 다른 에이전트도 그대로 따라할 절차는
 * 스킬이다(스킬이 워크스페이스 자산인 이유 그대로 — #140 결정문).
 *
 * 조건 없이 매 턴 붙인다. 이미 승인된 스킬 목록을 함께 실어 주고 싶어지는 자리지만, 그것은
 * 하네스가 자기 스킬 디렉터리에서 이미 읽는다(`syncSkills` 가 링크해 둔다) — 같은 사실의
 * 두 번째 원천을 프롬프트에 만들지 않는다.
 */
function skillSection(memory: MemoryContext): string[] {
  // **메모리 조회가 실패한 턴에는 `memory.set` 을 가리키지 않는다.** #139 가 세운 불변식은
  // `memorySection` 하나의 성질이 아니라 프롬프트 전체의 성질이다 — 조회가 실패했는데
  // 프롬프트가 메모리를 입에 올리면 에이전트는 "내 기억은 비어 있다"고 읽고 진짜 기억을
  // 새 프로필로 덮어쓴다. `prompt.test.ts` 의 '조회가 실패하면 온보딩 안내조차 들어가지
  // 않는다' 가 그 선이고, 이 절이 무심코 도구 이름을 적으면 같은 파일 안에서 그 선을 뚫는다.
  const notSkill = memory === 'unavailable'
    ? '아니다 — 그건 내가 기억해 둘 것이고, 스킬은 남이 그대로 따라할 절차다.'
    : '아니라 `memory.set` 이다.';
  return [
    '이 워크스페이스에는 **스킬**이 있다 — 승인되면 모든 에이전트의 스킬 디렉터리에 `SKILL.md`',
    '로 깔려서, 다음부터는 누구든 그 절차를 읽고 그대로 한다. 만드는 길은 murmur MCP 의',
    '`skill.propose`(slug·body·channelId) 하나이고 **제안만 할 수 있다** — 사람이 승인해야',
    '깔린다. 같은 slug 를 다시 제안하면 본문을 덮고 승인은 버려진다(다시 승인받아야 한다).',
    '',
    '**언제 제안하나:** 같은 절차를 세 번쯤 되풀이했고, 그것이 이 스레드·이 요청에 한정된',
    '맥락이 아니라 다른 에이전트도 그대로 따라할 수 있는 것일 때다. 본문에는 절차와 **그 절차가',
    '그 모양인 이유**를 함께 적는다 — 읽는 쪽은 그때의 대화를 모른다.',
    '',
    `**무엇은 제안하지 않나:** 나만 쓸 사실(사람들의 역할, 저장소 규칙, 내 작업 경위)은 스킬이 ${notSkill}`,
    '한 번 하고 끝난 일, 이 스레드에서만 뜻이 있는 것, 확실하지 않은 것은 제안하지 마라 —',
    '제안 하나마다 사람의 승인 시간이 들고, 승인된 본문은 모든 에이전트가 읽는다. 애매하면',
    '제안하지 말고 스레드에서 물어라.',
    '',
  ];
}

export function buildSystemPrompt(opts: {
  handle: string;
  channelName: string;
  instructions: string;
  guide: string;
  /** #139: 세 상태를 구분한다. `MemoryContext` 주석 참고. */
  memory: MemoryContext;
  /**
   * 이 턴이 살아있을 수 있는 시간(`config.turnTimeoutMs`). 옵셔널인 이유는 기본값을 여기서
   * 정해도 좋기 때문이 **아니다** — 값을 지어내면 프롬프트가 거짓을 말한다. 없으면 예산
   * 문장을 아예 빼고, 대신 "말을 멈추면 죽는다"는 사실만 말한다.
   */
  turnBudgetMs?: number;
}): string {
  const { handle, channelName, instructions, guide, memory, turnBudgetMs } = opts;
  const budgetMinutes = turnBudgetMs === undefined ? null : Math.floor(turnBudgetMs / 60_000);
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
    ...skillSection(memory),
    // 발화가 러너의 책임에서 에이전트의 자율로 넘어갔다(spec §4 발화 경로) — 어디에 쓸지를
    // 명시하지 않으면 턴이 조용히 끝나고, 러너는 그걸 프로세스 종료 후에나(hasOwnPostSince)
    // 알아챈다. 이 지시가 이 프롬프트에서 가장 중요한 한 줄이다.
    '답은 화면에 출력하는 것으로 끝나지 않는다 — 이 프로세스가 끝나기 전에 네가 직접 murmur',
    'MCP 의 `message.post` 도구를 불러 이 스레드에 남겨라. channelId 와 threadRootId 는',
    '대화 프롬프트 맨 위에 준다 — 그대로 넣어 호출한다(threadRootId 가 "채널 최상위(없음)"으로',
    '적혀 있으면 그 인자는 생략하고 channelId 만 넘긴다).',
    '',
    // 2026-09-08 실측: 서로 다른 앵커를 받은 턴 셋 중 둘이 **자기 앵커 대신** 채널의 더
    // 새로운 요청을 구현했다. 같은 기능 PR 이 셋 나오고(#638·#639·#640) 정작 그 둘의
    // 앵커에는 답이 없었다. 원인은 워크스페이스 가이드가 상주 에이전트용 poll 계약을
    // 턴에게도 주고 있었던 것이고(서버 `mcp/guide.ts` 가 그것을 모드로 갈랐다), 이 두 줄은
    // 가이드가 없거나 옛 판본이어도 앵커가 지켜지도록 프롬프트 자신이 거는 안전선이다.
    // 여기에 두는 이유: 바로 위가 channelId·threadRootId 를 말한 자리다 — 그 값이 무엇을
    // 뜻하는지(=이 턴의 일 전체)를 같은 문단에서 말해야 한다.
    '**그 앵커가 이 턴의 일 전부다.** 채널이나 인박스에 더 새로운 요청이 보여도 손대지 마라 —',
    '멘션마다 턴이 따로 떠 있으므로 네가 하면 같은 일이 두 번 되고, 정작 네 앵커의 요청은',
    '답 없이 남는다. 눈에 띈 요청은 대신 하지 말고 그 사실만 네 스레드에 한 줄 적어라.',
    '',
    // 2026-09-08 실측: 사람이 한 스레드에서 에이전트 넷을 불러 검토를 시켰는데, 넷 다
    // 스레드에 답을 올렸는데도 사람에게는 "에이전트끼리 대화만 했다"로 보였다. 원인이 둘이고
    // 아래 두 줄이 각각의 짝이다.
    //
    // ① 답에 요청자의 이름이 없었다. 데스크탑은 에이전트끼리의 연속 구간을 한 줄로 접는데
    //    (`desktop/src/lib/agentExchange.ts`), 그 판정이 "이 말이 사람에게 오는가"를 본다.
    //    요청자를 `@handle` 로 부르면 그 판정에 걸려 접히지 않는다 — 화면의 `addressesHuman`
    //    과 이 지시가 한 쌍이다. 접힘 규칙 자체도 같은 커밋에서 고쳤으므로 이 줄이 없어도
    //    답은 보이지만, 이름을 부른 답이 사람에게 훨씬 잘 읽힌다.
    // ② 답이 스레드 안에만 있었다. 채널 화면은 `alsoInChannel` 이 아닌 스레드 답을 걸러낸다
    //    (`desktop/src/components/ChannelPane.tsx`). 그래서 채널만 보는 사람에게는 자기
    //    질문 뒤가 비어 있었다. 그때는 "채널에도 에코하라"로 고쳤으나 같은 날 오후 그 처방이
    //    병보다 나쁜 것으로 드러나 되돌렸다 — 아래 에코 문단이 그 경위와 지금의 짝을 적는다.
    // #600: 어느 모델이 답했는지. **에이전트만 알 수 있다** — 러너가 넘기는 `--model` 은
    // 설정값이고, 설정이 비면(`agent_config.model === null`) 러너는 플래그를 아예 안 붙여
    // 하네스가 고른다. 그 선택은 하네스 출력에만 있고, 러너는 출력을 해석하지 않는다(pty.ts).
    // 그래서 이 한 줄이 murmur 가 실제 모델을 아는 유일한 길이다. 표시는 hover 뿐이므로
    // (`desktop/src/components/MessageItem.tsx`) 이 값을 실어도 화면이 시끄러워지지 않는다.
    '발화할 때(`message.post`·`report`·`fail`·`ask`·`progress`) `model` 인자에 **네가 지금 쓰는',
    '모델 ID** 를 그대로 실어라 — 환경 설명에 적힌 정확한 ID 를 쓴다(예: `claude-opus-5[1m]`).',
    '이름을 다듬거나 추측하지 말고, 모르면 생략한다. 사람이 이름줄에 hover 할 때만 보이므로',
    '화면을 어지럽히지 않는다.',
    '',
    '누구에게 답하는지를 잊지 마라 — **이 스레드를 연 사람에게 답하는 것**이 목적이다.',
    '동료 에이전트에게만 말하고 끝내지 말고, 최종 답은 요청자를 `@handle` 로 부르며 쓴다.',
    '',
    // 2026-09-08 오후, jaebin 의 요청으로 **기본값을 뒤집었다.** 아침까지 이 자리는 "채널
    // 최상위 요청에는 `alsoInChannel: true` 를 주라"였다. 반나절 만에 되돌린 이유는 처방이
    // 병보다 나빴기 때문이다: PR 진행 보고처럼 긴 답이 전부 채널로 올라와, 사람이 **자기가
    // 올린 요청**을 채널 화면에서 찾을 수 없게 됐다. 채널은 무슨 일이 있었나를 훑는 자리이고
    // 답 본문의 자리가 아니다.
    //
    // 되돌려도 위 ②(채널만 보는 사람에게 자기 질문 뒤가 비어 보인다)가 그대로 돌아오지는
    // 않는다: 채널 요약 줄이 루트 메시지에 **답글 수**를 그린다(`MessageItem` 의 `hasReplies`
    // — 서버가 스레드 루트에 `replyCount` 를 실어 준다). 답이 스레드에만 있어도 채널에는
    // "답글 N개"가 남으므로 사람은 답이 온 것을 알고 눌러 들어갈 수 있다. 즉 ② 의 짝은 이제
    // 에코가 아니라 답글 수이고, 에코는 **명시적으로 요청받았을 때의 예외**로만 남는다.
    '답은 **스레드 안에만** 남기는 것이 기본이다 — `message.post` 에 `alsoInChannel` 을 붙이지',
    '않는다. 채널에는 답글 수가 남으므로 사람은 답이 온 것을 안다. 요청자가 "채널에도 올려라 /',
    '공지해라 / 다른 사람도 봐야 한다"고 **명시적으로** 말한 경우에만 `alsoInChannel: true` 를',
    '준다 — 애매하면 붙이지 않는다.',
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
    // 2026-09-07 15:08: PR #533 을 올린 턴이 CI 대기 루프를 **백그라운드로** 띄우고
    // "결과 나오면 머지하겠다"며 끝났다. 그 계획은 실행되지 않았다 — 프로세스가 죽었고
    // 루프도 함께 죽었으며, 4분 뒤 초록이 된 CI 를 아무도 보지 않았다. 위의 지시는 "어디에
    // 쓸지"만 말하고 **언제까지 살아있는지**를 말하지 않았고, 그 공백이 실행 불가능한
    // 계획을 낳았다. 이 세 문장이 그 공백을 메운다.
    '네가 말을 멈추면 이 프로세스는 그 자리에서 죽는다. "나중에", "결과가 나오면"은 실행되지',
    '않는다 — 백그라운드로 띄운 명령도 프로세스와 함께 죽는다.',
    '',
    ...(budgetMinutes === null ? [] : [
      `이 턴의 예산은 ${budgetMinutes}분이다. 그 안에 끝나는 기다림은 포그라운드에서 기다려도 된다.`,
      '',
    ]),
    '더 기다려야 하면 **지금 아는 것을 `message.post` 로 남기고**, murmur MCP 의 `turn.wake` 로',
    '다시 볼 시각을 예약하고 끝낸다(예: CI 결과 확인 — 5분 뒤). 예약은 스레드에 대기 줄로',
    '보이고, 시각이 되면 **이 세션이 그대로 이어져** 다시 시작한다 — 조사한 것을 다시 조사할',
    '필요가 없다. 예약을 건 턴은 결과 발화 없이 끝내도 된다.',
    '',
    `답변은 ${BODY_LIMIT}자를 넘길 수 없다(서버가 거절한다). 채팅이므로 짧고 구체적으로 쓴다.`,
    '모르는 것은 모른다고 말한다. 확인하지 않은 것을 확인한 것처럼 쓰지 않는다.',
  ].join('\n');
}

/** 한 줄로 렌더링한다. handles 에 없는 작성자는 알 수 없는 사용자로 표시한다(reply.ts 의 기존 정책 계승) —
 * avcs 투영이 만드는 system 메시지 등, 호출 시점에 handles 맵이 못 따라온 작성자가 있을 수 있다. */
function renderLine(m: MessageRow, handles: Record<string, string>): string {
  const handle = handles[m.authorId] ?? '알 수 없는 사용자';
  // **id 를 함께 싣는다.** 파일명만 있으면 에이전트는 그 첨부를 열 방법이 없어 내용을
  // 짐작하거나 못 봤다고 답한다(2026-09-08 실측 — 아래 attachmentHowTo 주석). id 는
  // `GET /attachments/:id` 의 유일한 열쇠이고, AttachmentRow 는 그것을 이미 들고 있었다.
  // contentType·sizeBytes 도 함께 준다 — 내려받기 전에 "열 수 있는 것인가, 얼마나 큰가"를
  // 판단할 근거다(200MB 짜리를 무조건 받게 만들지 않는다).
  const attachmentNote = m.attachments.length
    ? ` [첨부: ${m.attachments
        .map((a) => `${a.filename} (id ${a.id}, ${a.contentType}, ${a.sizeBytes}B)`)
        .join(', ')}]`
    : '';
  return `${handle}: ${m.body}${attachmentNote}`;
}

/**
 * 첨부 바이트를 **실제로 여는 방법**. 이 절이 없던 동안 무슨 일이 있었나(2026-09-08 실측):
 * 사람이 스크린샷을 붙여 "이 부분을 고쳐 달라"고 했고, 에이전트는 "첨부 스크린샷을 제가
 * 열지 못했습니다(파일이 제 쪽 디스크에 없었습니다)"라고 답한 뒤 **코드만 보고 어느 화면인지
 * 추측해** 고쳤다. 추측이 맞았지만 그것은 운이다.
 *
 * 정작 바이트는 그때도 닿을 수 있었다. 막힌 것은 통로가 아니라 **아는 것**이었다:
 *   - 하네스는 러너 env 를 통째로 물려받아 `MURMUR_PAT` 을 들고 있다(turn.ts::childEnv).
 *   - 서버에는 `GET /attachments/:id` 가 계정 인가로 열려 있다(attachmentRoutes.ts).
 *   - 그런데 프롬프트는 파일명만 줬고(위 renderLine 의 옛 코드), 이 통로를 아무도 말해
 *     주지 않았다. 셋 중 어느 하나가 아니라 **id + 통로 안내**가 빠져 있었다.
 *
 * 통로를 **둘** 적는다. `curl` 이 먼저인 이유는 셸이 있는 하네스가 그 한 줄로 파일을 손에
 * 넣고 곧바로 자기 도구로 열 수 있기 때문이고, MCP `attachment.fetch` 를 함께 적는 이유는
 * **셸이 없는 하네스에는 그것이 유일한 통로**이기 때문이다(#585). 하나만 적으면 그 하나가
 * 없는 쪽 에이전트는 다시 "못 봤다"로 돌아간다.
 *
 * 첨부가 있는 턴에만 붙인다 — 대부분의 턴은 첨부가 없고, 그때 이 여덟 줄은 순전한 낭비다.
 *
 * URL 은 러너가 아는 실값(`config.murmurUrl`)을 그대로 굽고 토큰은 **env 이름으로만** 적는다.
 * 실값을 프롬프트 파일에 넣지 않는 이유는 #92·#117 과 같다 — 그 파일은 디스크에 남는다.
 */
function attachmentHowTo(murmurUrl: string): string[] {
  return [
    '',
    '(위 `[첨부: …]` 의 id 로 첨부 바이트를 직접 받을 수 있다 — 파일명만 보고 내용을 짐작하지 마라.',
    '셸이 있으면:',
    `  curl -fsS -H "Authorization: Bearer $MURMUR_PAT" ${murmurUrl}/attachments/<id> -o /tmp/<파일명>`,
    '받은 파일을 열어서 봐라 — 이미지도 그대로 읽힌다.',
    '셸이 없으면 murmur MCP 의 `attachment.fetch` 를 attachmentId 로 불러라 — 이미지는 그 응답에',
    '그림으로 실려 온다. 받기가 실패했을 때만 "못 봤다"고 말하고, 못 본 것을 본 것처럼 쓰지 마라.)',
  ];
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
  /**
   * 서버 베이스 URL(`config.murmurUrl`). 첨부 안내에 실을 실값이다.
   *
   * 옵셔널이 아니라 필수인 이유: 여기서 `$MURMUR_URL` 같은 env 참조로 때우면 그 변수가
   * 없는 러너(`config.ts` 는 없으면 기본값으로 넘어간다)에서 curl 이 조용히 실패한다.
   * 러너는 자기가 붙은 URL 을 이미 알고 있으므로 그 값을 받는다 — 두 번째 진실 원천을
   * 만들지 않는다. 첨부가 없는 턴에는 쓰이지 않지만 그렇다고 옵셔널로 두면 새 호출자가
   * 잊었을 때 **첨부가 있는 턴에서만** 조용히 망가진다.
   */
  murmurUrl: string;
  /**
   * 이 턴이 **깨어난 턴**이면 그 사유(마이그레이션 040). 있으면 사람의 새 발화가 없어도
   * 프롬프트가 비지 않는다 — 깨움에는 부른 사람이 없고, 예약 줄을 쓴 것도 자기라서
   * 아래 자기-발화 필터에 전부 걸린다. 그대로 두면 `mentionTurn` 이 하네스를 돌리지
   * 않고 끝내, 걸어 둔 기다림이 조용히 사라진다.
   */
  wake?: { reason: string };
}): { prompt: string; fedSeq: number } {
  const { messages, lastFedSeq, meId, handles, channelId, threadRootId, murmurUrl, wake } = opts;
  const isFirstTurn = lastFedSeq === 0;

  const newMessages = messages.filter((m) => m.seq > lastFedSeq);
  // 넘길 게 있었든 없었든, 이번에 본 것 중 가장 큰 seq 가 다음 경계다. newMessages 가
  // 비어 있으면 reduce 의 초기값(lastFedSeq)이 그대로 나와 전진하지 않는다 — 볼 게 없었으니
  // 맞는 동작이다.
  const fedSeq = newMessages.reduce((max, m) => Math.max(max, m.seq), lastFedSeq);

  const toShow = newMessages.filter((m) => isFirstTurn || m.authorId !== meId);
  if (!toShow.length && wake === undefined) {
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
  // 깨움 줄을 **사람의 발화처럼 렌더하지 않는다**(`renderLine` 을 쓰지 않는 이유다).
  // "forge: CI 결과 확인" 으로 보이면 에이전트가 자기 옛 말을 새 요청으로 읽는다.
  // 아래 델타에 사람의 새 발화가 함께 있을 수 있으므로 이 줄은 그것을 대체하지 않고 앞에 선다.
  const wakeLines = wake === undefined ? [] : [`(예약된 후속 턴 — 사유: ${wake.reason})`, ''];
  // 안내는 첨부 줄 **뒤**에 선다 — 먼저 무엇이 왔는지 보고 그다음 어떻게 여는지 읽는 순서다.
  // `toShow` 로 판정한다: 보여주지 않은 메시지의 첨부는 프롬프트에 id 가 없어 열 수도 없다.
  const howTo = toShow.some((m) => m.attachments.length) ? attachmentHowTo(murmurUrl) : [];
  const prompt = [head, '', ...wakeLines, ...lines, ...howTo].join('\n');

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
    (m) => m.authorId === meId && m.seq > sinceSeq && !NON_UTTERANCE_KINDS.has(m.kind),
  ).length;
}

/**
 * 이 턴이 **자기 앵커가 아닌 스레드에** 남긴 발화들.
 *
 * ## 왜 필요한가 (2026-09-08 실측)
 *
 * 서로 다른 앵커를 받은 턴 둘이 자기 앵커 대신 채널의 다른 요청을 구현하고, 결과도 **그쪽
 * 스레드에** 올렸다. 그 두 턴의 앵커에는 `NO_REPLY_NOTICE` 한 줄만 남았다 — 사람이 본 것은
 * "답 없이 턴을 끝냈습니다" 였고, 그 턴이 실제로는 30분을 일해서 옆 스레드에 답을 올렸다는
 * 사실은 어디에도 없었다. 침묵의 **이유**가 러너에게는 보이는데 사람에게 안 보였다.
 *
 * ## 판정 규칙
 *
 * 메시지가 속한 스레드는 `threadRootId ?? id` 다(루트 메시지 자신은 자기 id 가 스레드다).
 * 앵커가 `null`(채널 최상위)인 턴에게는 "최상위에 쓴 것"이 자기 자리이므로 `threadRootId`
 * 가 null 인 것만 자기 것이다 — 그 경우 루트의 id 로 비교하면 자기 발화가 전부 남의 것이 된다.
 *
 * 발화의 정의는 `countOwnPostsSince` 와 **같다**(progress·wake 제외) — 세는 규칙이 두 벌이
 * 되면 "앵커에는 0건인데 밖에는 1건"의 두 숫자가 서로 다른 뜻을 갖게 된다.
 *
 * ## 이것이 증명하지 못하는 것
 *
 * 같은 채널에서 턴이 **동시에** 돌면 여기 잡힌 발화가 남의 정상 턴의 것일 수 있다(계정이
 * 같아 구분되지 않는다 — `hasOwnPostSince` 의 #174 와 같은 한계다). 그래서 호출부는 이것을
 * 고발이 아니라 정황으로 쓴다: 이미 침묵으로 통지가 나가는 자리에만 덧붙인다.
 */
export function offAnchorPosts(
  messages: MessageRow[], meId: string, anchor: string | null, sinceSeq: number,
): MessageRow[] {
  return messages.filter((m) => {
    if (m.authorId !== meId || m.seq <= sinceSeq || NON_UTTERANCE_KINDS.has(m.kind)) return false;
    return anchor === null ? m.threadRootId !== null : (m.threadRootId ?? m.id) !== anchor;
  });
}

/**
 * `offAnchorPosts` 가 잡은 것을 `NO_REPLY_NOTICE` 뒤에 붙일 한 문단으로 만든다.
 *
 * 스레드 링크를 싣는다 — "다른 스레드에 썼다"만 말하면 사람이 그것을 찾을 방법이 없다.
 * 형식은 데스크탑이 이미 여는 permalink(`messagePermalink`)다: 붙여넣으면 그 스레드가 열린다.
 * 잡힌 것이 없으면 `null` 이다(`harnessTailNotice` 와 같은 규칙: 빈 상자는 "여기 뭔가
 * 있다"는 거짓 신호다).
 */
export function offAnchorNotice(posts: MessageRow[]): string | null {
  if (posts.length === 0) return null;
  const roots = [...new Set(posts.map((m) => m.threadRootId ?? m.id))];
  const links = roots.map((id) => messagePermalink(id));
  return [
    `다만 이 턴이 도는 동안 **다른 스레드에** 내 발화가 ${posts.length}건 있었다 —`,
    '이 턴이 자기 앵커 대신 그쪽 요청을 했을 수 있다(같은 계정의 다른 턴일 수도 있다):',
    ...links.map((l) => `- ${l}`),
  ].join('\n');
}

/**
 * "이 턴이 **기다림을 예약했나**". 발화 판정과 다른 질문이라 별도 함수이지만, 세는 규칙이
 * 흩어지지 않게 같은 파일에 둔다.
 *
 * 기준선(`sinceSeq`)이 핵심이다: 스레드에 옛 대기 줄이 남아 있는 것은 흔한 일이고, 그것을
 * 근거로 침묵을 허용하면 **한 번 예약한 스레드는 그 뒤로 영원히 조용해도 된다**가 된다.
 * 이번 턴에 생긴 줄만이 "이번 턴은 기다리기로 했다"는 증거다.
 *
 * 저자를 보는 이유: 한 스레드에 여러 에이전트가 있을 수 있고, 동료의 대기 줄로 내 침묵을
 * 정당화하면 내 턴은 아무 말 없이 사라진다.
 */
export function hasOwnWakeSince(messages: MessageRow[], meId: string, sinceSeq: number): boolean {
  return messages.some(
    (m) => m.authorId === meId && m.seq > sinceSeq && m.kind === MESSAGE_KIND_WAKE,
  );
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

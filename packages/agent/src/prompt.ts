// 스레드를 하네스 턴이 받는 텍스트로 바꾸는 순수 로직. 네트워크도 하네스 실행도 여기 없다 —
// 그래서 이 부분만 테스트되고, 프로세스 spawn·resume 판단은 main.ts 가 조립한다.
//
// reply.ts 의 후신이다(spec §4). 다른 점: 예전에는 멘션마다 프로세스를 새로 띄워 스레드
// 전체를 매번 넘겼지만, 이제 스레드마다 하네스 세션이 디스크에 살아남아 resume 되므로
// 세션이 이미 아는 것까지 다시 넘길 필요가 없다 — 그 경계가 `lastFedSeq` 다. 그리고 예전엔
// 러너가 모델 응답을 파싱해 대신 올렸지만, 이제 에이전트가 murmur MCP `message.post` 로
// 스스로 올린다 — 그래서 시스템 프롬프트가 "어디에 쓸지"까지 알려줘야 한다.
import { messagePermalink, type MessageRow, type InboxTeamCall, type InboxDelegationOutcome, type InboxDelegatedBy } from '@murmur/shared';

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

/** 재시도 통지에 싣는 사유의 최대 길이. 한 줄로 읽히는 만큼만 남긴다. */
const RETRY_REASON_MAX_CHARS = 160;

/**
 * 답하지 못한 턴을 **다시 시도한다**는 통지(2026-09-09 실측).
 *
 * 왜 필요한가: 이 자리는 지금까지 `console.error` 뿐이었다. 그날 한 턴이 30분을 서 있다가
 * 접혔고 러너 로그에는 `답변 실패 (1/3)` 이 남았는데, 스레드에는 **아무것도 남지 않았다** —
 * 스레드 행의 `failureCount` 조차 0이라 화면이 알 방법이 없었다. 사람이 본 것은 👀 하나
 * 붙은 `끝남` 배지뿐이었고, 그래서 나온 말이 *"이거 왜 답변 안 하고 있어"* 다.
 *
 * `FAILURE_NOTICE` 로 대신할 수 없다: 그것은 3회를 **다 태운 뒤**에 나오는 말이라, 재시도가
 * 도는 동안(백오프까지 합쳐 수십 분)은 여전히 침묵이다. 사람이 알아야 하는 것은 "끝났다"가
 * 아니라 **"아직 하는 중이고, 왜 한 번 엎어졌는지"** 다.
 *
 * entry 당 1회만 올린다(중복 판정은 호출자가 갖는다) — 매 시도마다 올리면 빠르게 실패하는
 * 오류에서 스레드가 몇 초 만에 도배된다.
 */
export function retryNotice(tried: number, max: number, reason: string | null): string {
  const head = `(답하지 못하고 끝나 다시 시도합니다 — ${tried}/${max}회째`;
  const tail = reason === null ? '' : `, 원인: ${reason}`;
  return `${head}${tail})`;
}

/**
 * 하네스가 **턴 도중에 확인을 기다린다**는 통지(2026-09-09 실측, `pty.ts::looksLikeGate`).
 *
 * ## 왜 실패(`message.fail`)로 내는가
 *
 * 이 사실의 수신자는 언제나 사람이고, 사람이 손을 대야만 풀린다 — 그것이 `failure` 어휘의
 * 정의이고 화면의 `stuck`("사람만이 풀 수 있으므로 실패와 같은 대접")이 가리키는 상태다.
 *
 * **선택 카드(`message.ask`)로 내지 않는다.** 카드의 선택지를 murmur 에서 눌러도 관문은
 * 그대로 서 있다 — 답을 받아야 하는 것은 이 스레드가 아니라 **그 터미널**이다. 누를 수
 * 있는데 아무 일도 안 일어나는 단추는 없는 문을 그리는 것이다(규칙 06).
 *
 * `retryable: false` 인 이유도 같다: 이 턴을 다시 부르는 것으로는 안 풀린다. 사람이 화면의
 * 물음에 답하면 **그 턴이 그 자리에서 이어진다** — 다시 부를 일 자체가 없다.
 *
 * 계정을 함께 적는다: 어느 계정의 하네스가 묻고 있는지가 사람이 열 화면을 고르는 재료다.
 */
export function gateNotice(accountLabel: string): string {
  return `(하네스가 확인을 기다려 진행이 멈췄습니다 — 이 스레드의 터미널을 열어 화면의 물음에 `
    + `답해 주세요. 답하면 이 턴이 그 자리에서 이어집니다. 계정: ${accountLabel})`;
}

/**
 * 하네스가 **서 있어서** 접었다는 통지(2026-09-09). `retryNotice` 와 갈라야 하는 이유는
 * 하나다 — **이 실패는 재시도하지 않는다.**
 *
 * 재시도가 왜 소용없는가: 정지의 원인은 대개 사람을 기다리는 화면이고(관문), 프롬프트를
 * 다시 넣으면 모델이 같은 명령을 다시 시도해 **같은 자리에 다시 선다.** 실측에서 그 값이
 * 정지 한도 10분 × `MAX_ATTEMPTS` 3회 = 30분이었고, 끝에 남은 것은 사람이 할 일을 잘못
 * 가리키는 "운영자 확인이 필요합니다" 한 줄이었다. 한도·세션 충돌을 회계에 넣지 않는 것과
 * 같은 판례다(`mentionScheduler` 의 두 분기).
 *
 * `pty.ts::looksLikeGate` 가 관문을 알아보면 애초에 이 자리에 오지 않는다(그 턴은
 * `awaitingHuman` 이라 정지 시계를 재지 않는다). 여기 오는 것은 **알아보지 못한** 관문이거나
 * 진짜로 멈춘 하네스다 — 어느 쪽이든 볼 곳은 그 터미널이므로 말은 하나로 족하다.
 */
export function stallNotice(stallMs: number): string {
  const 분 = Math.round(stallMs / 60_000);
  return `(하네스가 ${분}분 동안 아무것도 하지 않아 접었습니다 — 다시 시도하지 않습니다: `
    + `같은 자리에 다시 서기 때문입니다. 이 스레드의 터미널을 열어 화면을 확인해 주세요 — `
    + `확인을 기다리는 물음이 서 있을 수 있습니다.)`;
}

/**
 * 실패 사유를 통지에 실을 한 줄로 줄인다. 줄바꿈을 없애고 앞을 남긴다 — 사유는 문장 머리에
 * 있고(`harness 정지 …`), `tailNotice` 와 방향이 반대인 이유가 그것이다.
 *
 * **PAT 가림을 여기서도 한다.** 실패 문구에는 tail 이 섞일 수 있고(`harness 종료 N: …`),
 * 그 tail 은 PTY 원문이라 토큰이 지나갈 수 있다 — 통지는 스레드에 영구히 남는다.
 */
export function retryReason(message: string): string | null {
  const text = message
    .replace(/murp_[A-Za-z0-9_-]+/g, '(가림)')
    .replace(/(Bearer\s+)\S+/gi, '$1(가림)')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.length > RETRY_REASON_MAX_CHARS
    ? `${text.slice(0, RETRY_REASON_MAX_CHARS)}…`
    : text;
}

/**
 * 사람이 조종 중인 스레드에 온 멘션의 대기 통지(#337, 스펙 §5-2 결정 6). 러너가
 * **에이전트 계정으로** 스레드에 올린다 — NO_REPLY_NOTICE 와 같은 판례다: 시스템 계정을
 * 새로 만들지 않고, 그 스레드에서 말하던 바로 그 목소리가 자기 사정을 말한다.
 * entry 당 1회만 올린다(중복 판정은 mentionQueue 가 갖는다).
 *
 * **문구가 약속을 하지 않는다.** 전에는 "터미널이 닫히면 처리합니다" 라고 적었는데, 닫는
 * 것과 조종이 끝나는 것은 다른 사실이다 — 뷰어 수 프레임이 유실되면 닫아도 끝나지 않고,
 * 그러면 이 문장은 사람이 이미 한 일을 다시 하라고 시킨다(실측된 결함). 조건이 아니라
 * **끝나는 방법**을 적는다.
 */
export function controlledNotice(handle: string, pending: number): string {
  return `(지금 ${handle} 이(가) 직접 조종 중입니다 — 이 멘션은 대기 ${pending}건째입니다. `
    + '조종이 끝나면 처리합니다: 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」)';
}

/**
 * 조종이 상한을 넘겼다 — **실패로** 남긴다(`message.fail`).
 *
 * 평문이 아닌 이유: 유예에는 상한이 없고 대기 통지는 entry 당 1회라, 조종이 풀리지 않으면
 * 그 스레드는 **아무 신호도 없이** 영구 정지한다. 실측된 사건에서 남은 흔적은 대기 수가
 * 1→2→3 으로 늘어난 것뿐이었고, 스레드 머리는 그동안 `끝남` 이었다. 사람이 손을 대야
 * 풀리는 것은 스레드 상태에 `막힘`으로 서야 한다(`murmur.ts::fail` 주석).
 *
 * 유예 자체는 **유지한다** — 멘션은 inbox 에 살아 있고(그것이 큐다), PTY 가 그 하네스
 * 세션을 쥐고 있는 동안 턴을 억지로 띄우면 한 세션을 두 프로세스가 밟는다(스펙 §1 금지).
 * 여기서 하는 일은 무엇이 막혔는지와 푸는 방법을 사람에게 보이는 것뿐이다.
 */
export function controlHeldNotice(handle: string, pending: number, heldMs: number): string {
  const minutes = Math.max(1, Math.round(heldMs / 60_000));
  return `${handle} 의 조종이 ${minutes}분째 이어져 이 스레드의 멘션 ${pending}건이 대기 중입니다. `
    + '조종이 끝나야 처리됩니다 — 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」를 누르세요. '
    + '(대기 중인 멘션은 사라지지 않습니다.)';
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

/**
 * PR 본문 서명이 가리키는 곳. **인스턴스 주소가 아니라 프로젝트 저장소다** — murmur 는
 * 셀프호스트라 인스턴스 주소는 저마다 다르고(`messagePermalink` 주석), 그래서 링크에
 * 호스트를 박지 않는 것이 이 저장소의 규율이다. 여기 박아도 되는 이유는 이 값이
 * 인스턴스의 주소가 아니라 **프로젝트 자체의 상류 주소**이기 때문이다.
 */
const MURMUR_REPO_URL = 'https://github.com/izagood/murmur';

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
    // PR 본문 끝의 서명(2026-09-10, jaebin 승인). **하네스 층이 아니라 여기 있는 것**이
    // 요점이다. Claude Code 에는 `settings.json` 의 `attribution.pr` 이 있어 그 한 줄을
    // 갈아끼울 수 있지만, 그것은 **claude-code 전용 설정**이다 — codex 에는 대응물이 없어
    // 같은 저장소의 PR 인데 그날 어느 하네스가 걸렸느냐로 서명이 있다/없다로 갈린다
    // (`RUNNABLE_HARNESSES` 는 claude-code·codex 둘이다). 이 프롬프트는 두 하네스에 모두
    // 도달하므로(codex 는 지시문 주입 플래그가 없어 프롬프트 앞에 붙는다 — `turn.ts`)
    // 서명이 하네스와 무관해지고, gemini 가 러너블이 되는 날에도 따라온다.
    //
    // 문장에 하네스 이름을 쓰지 않는 것도 같은 결정이다: 하네스는 murmur 가 에이전트 설정에
    // 이미 갖고 있고, PR 을 나중에 읽는 사람에게 중요한 것은 **어느 에이전트가 열었는가**다.
    // 하네스를 굳이 남기려면 문장 가운데가 아니라 뒤에 따로 붙여야 갈아끼울 수 있다.
    '저장소에 PR 을 열면 본문 **맨 끝**에 이 줄을 넣는다:',
    '',
    `🤖 Opened by \`@${handle}\`, an agent in [murmur](${MURMUR_REPO_URL}) — a chat workspace where people and AI agents share channels.`,
    '',
    // 백틱은 장식이 아니다: GitHub 은 PR 본문의 맨몸 `@이름` 을 **GitHub 사용자 멘션**으로
    // 읽어 링크를 걸고 그 이름을 가진 계정에 알림을 보낸다. murmur 핸들과 GitHub 계정은
    // 아무 관계가 없으므로, 백틱을 빼면 이 서명이 매번 남의 알림함을 울린다.
    '핸들의 백틱을 빼지 마라 — GitHub 은 맨몸 `@이름` 을 GitHub 사용자 멘션으로 읽어 그 이름을',
    '가진 **남의 계정**을 부른다. 하네스 이름은 이 줄에 적지 않는다.',
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
    // 2026-09-09 실측: murmur 가 보고 한가운데 "구현은 `@forge` 것이고" 라고 **지칭**했더니
    // forge 의 턴이 떴고, forge 의 답이 다시 murmur 를 지칭해 5분에 네 턴이 오갔다. 그날
    // dev DB 의 에이전트→에이전트 멘션 122건 중 47건(39%)이 부를 뜻 없는 지칭이었다.
    //
    // 이제 서버가 자리로 그것을 가른다(`shared/splitMentionCalls`) — 그래서 이 문단은 규칙을
    // **강제하는** 것이 아니라 **알려 주는** 것이다. 강제는 코드가 하고, 이 줄이 없으면
    // 에이전트는 부른 줄 알았던 동료가 오지 않는 이유를 모른다. `addressesHuman` 과 위
    // 문단이 한 쌍인 것과 같은 짝이다.
    '**동료 에이전트를 부르는 것과 지칭하는 것은 다르다.** 다른 에이전트에게 일을 넘길 때만',
    '`@handle` 로 부르고, 그 이름은 **본문 맨 앞**에 둔다 — 맨 앞의 멘션만 상대의 턴을 띄운다.',
    '보고 한가운데서 동료를 가리킬 때는 `@` 없이 이름만 쓴다(예: "구현은 forge 것이다").',
    '거기에 `@` 를 붙여도 상대는 오지 않지만, 읽는 사람에게는 부른 것처럼 보인다.',
    '**사람을 부르는 것은 이 규칙과 무관하다** — 사람은 어디에서 불러도 알림을 받는다.',
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

/**
 * 팀장으로 불린 턴의 **팀 블록**(047).
 *
 * ## 무엇을 적는가, 그리고 왜
 *
 * 이 블록이 없던 동안 팀 부름은 팀원 수만큼 턴을 띄웠고, 각 턴은 자기가 팀으로 불렸다는
 * 사실조차 몰랐다(inbox 사유가 `mention` 하나였다). 그래서 넷이 같은 요청을 각자 처음부터
 * 풀고 넷이 각자 사람에게 답했다 — 서버가 창구를 하나로 좁혀도(047) 그 하나가 **명단을
 * 모르면** 달라지는 것은 "혼자 다 한다" 뿐이다. 그래서 두 가지를 함께 적는다:
 * **누가 있는가**(명단)와 **네가 무엇인가**(창구).
 *
 * `@` 를 붙여 적는 이유: 넘길 때 쓰는 문자열이 그대로 보여야 한다. 대신 **맨 앞에 두어야
 * 턴이 뜬다**는 것을 함께 말한다 — 그 규칙은 워크스페이스 가이드에도 있지만, 여기서 명단을
 * 주면서 말하지 않으면 팀장은 문장 가운데에 이름을 적고 아무도 오지 않는 것을 본다.
 *
 * 비활성 팀원을 **지우지 않고 표시한다**. 036 이 정한 것과 같은 판단이다(*"명단을 지우지
 * 않는다"*): 지우면 팀장은 그 이름을 아예 모르고, 사람이 "왜 codex 를 안 썼나" 라고 물을 때
 * 답할 근거가 없다. 넘겨도 깨지 않는다는 사실을 함께 적어 **고르지 않게** 만드는 것이 맞다.
 *
 * 자기 자신은 명단에서 **빼지 않는다** — 팀장도 팀원이고(046 의 복합 FK), 목록에서 자기가
 * 빠지면 "이 팀은 나 말고 셋" 처럼 읽혀 팀 크기를 잘못 판단한다. 대신 그 줄에 `(너)` 를
 * 붙인다: 자기에게 넘기려 드는 것을 막는 가장 짧은 표시다.
 *
 * ## 기다리지 않는다는 것을 말한다
 *
 * 지금은 위임 왕복이 없다 — 팀원이 스레드에 답해도 팀장은 깨지 않는다(`thread_reply` 는
 * 스레드 루트 작성자에게만 간다). 그 사실을 적지 않으면 팀장은 "팀원 답을 기다렸다가
 * 취합하겠다" 는 계획을 세우고, 그 계획은 실행되지 않는다(프로세스가 끝나면 턴이 죽는다 —
 * `buildSystemPrompt` 의 그 문단이 같은 공백을 메운다). 그래서 넘긴 턴은 **넘겼다는 것을
 * 사람에게 말하고 끝내는 것**이 지금의 올바른 종료다.
 */
function teamSection(team: InboxTeamCall, meId: string, handles: Record<string, string>): string[] {
  const myHandle = handles[meId];
  const roster = team.members.map((m) => {
    const marks = [
      m.accountId === meId ? '너' : null,
      m.disabled ? '비활성 — 넘겨도 깨지 않는다' : null,
    ].filter((x): x is string => x !== null);
    const suffix = marks.length ? ` (${marks.join(' · ')})` : '';
    return `- @${m.handle}${suffix}${m.specialty ? ` — ${m.specialty}` : ''}`;
  });
  return [
    `(팀 호출 — 너는 팀 @${team.name} 의 팀장으로 불렸다${myHandle ? `, @${myHandle}` : ''})`,
    '',
    '이 부름은 **너 하나만** 깨웠다. 팀원들은 이 요청을 모른다 — 사람과 이야기하는 창구가',
    '너라는 뜻이고, 최종 답은 네가 쓴다.',
    '',
    `팀 @${team.name} 의 팀원:`,
    ...roster,
    '',
    '네 전문 영역이면 넘기지 말고 **직접 해라** — 넘기는 값은 턴 하나이고 그것이 늘 싼 것은',
    '아니다. 넘길 것이 있으면 그 팀원을 `@handle` 로 부르는데, **본문 맨 앞**에 두어야 그',
    '턴이 뜬다(가운데에 적으면 아무도 오지 않는다).',
    '',
    '**넘긴 답을 기다리지는 마라.** 팀원이 스레드에 답해도 너는 깨지 않는다 — 넘겼다면',
    '무엇을 누구에게 넘겼는지 사람에게 말하고 이 턴을 끝낸다. 결과를 이어받아야 하면',
    '`turn.wake` 로 다시 볼 시각을 예약해라.',
    '',
  ];
}

/**
 * 넘긴 일의 **결말 블록**(050).
 *
 * ## 왜 결말을 글자로 적는가
 *
 * 팀장은 이 턴에서 세 갈래 중 하나를 골라야 한다 — 취합해서 답한다 / 다시 넘긴다 / 사람에게
 * 막혔다고 말한다. 그 선택은 **각 팀원이 어떻게 끝났는지**에 달렸고, 스레드를 다시 읽어
 * 짐작하게 만들면 무응답(아무 말도 없는 상태)을 "아직 도는 중"으로 읽는다. 아무 말도 없는
 * 것과 기한이 지난 것은 스레드에서 구별되지 않으므로, 그 사실은 프롬프트가 말해야 한다.
 *
 * ## 남은 라운드를 함께 적는다
 *
 * 다시 넘기는 것은 라운드를 먹는다(무한 왕복을 막는 유일한 장치다 — 멘션 상한은 이 경로를
 * 막지 못한다). 팀장이 그것을 **모르고** 넘기면 상한에 걸린 거절을 받고 그때 다시 판단해야
 * 하는데, 그 시점엔 이미 턴 하나를 태웠다. 그래서 고르기 **전에** 알려 준다.
 *
 * 0 이면 "다시 넘길 수 없다"를 명시한다 — 남은 수가 0 이라는 사실만으로는 모델이 그 결론에
 * 이르지 않는다(실행 가능한 지시가 아니라 숫자일 뿐이다).
 */
function delegationSection(outcome: InboxDelegationOutcome): string[] {
  const label: Record<InboxDelegationOutcome['items'][number]['outcome'], string> = {
    done: '끝남',
    failed: '실패 — 그 일은 아직 남아 있다',
    timeout: '무응답 — 기한이 지났다(살아 있는지 알 수 없다)',
  };
  const unresolved = outcome.items.some((i) => i.outcome !== 'done');
  return [
    outcome.timedOut
      ? '(넘긴 일의 기한이 지났다 — 결말은 아래와 같다)'
      : '(넘긴 일이 모두 끝났다 — 결말은 아래와 같다)',
    '',
    ...outcome.items.map((i) => `- @${i.handle} — ${label[i.outcome]}`),
    '',
    ...(unresolved
      ? [
        '끝나지 않은 것이 있다. **셋 중 하나를 골라라**:',
        '① 네가 직접 한다 ② 다른 팀원에게 다시 넘긴다 ③ `message.fail(retryable: true)` 로',
        '사람에게 넘긴다(무엇이 막혔는지 적어서).',
        outcome.roundsLeft > 0
          ? `다시 넘길 수 있는 남은 횟수는 ${outcome.roundsLeft}번이다.`
          : '**다시 넘길 수 없다** — 남은 횟수가 없다. ① 또는 ③ 이다.',
        '',
      ]
      : [
        '이제 **네가 취합해서 최종 답 하나**를 사람에게 쓴다 — 팀원들의 보고를 그대로 나열하지',
        '말고, 요청자가 물은 것에 답한다.',
        '',
      ]),
  ];
}

/**
 * **넘겨받은 일**의 블록(3-2) — 팀원의 턴이 *"내 발화는 팀장에게 오는 보고다"* 를 알게 한다.
 *
 * ## 이 블록이 화면을 조용하게 만든다
 *
 * jaebin 의 최초 진단은 *"에이전트들이 모두 이야기하니까 정신없다"* 였다. 서버가 창구를
 * 팀장 하나로 좁혀도(047) 넘겨받은 팀원이 **요청자에게** 답하면 화면은 그대로 시끄럽다 —
 * 데스크탑은 에이전트끼리의 구간을 접는데(`agentExchange`), 그 판정이 *"이 말이 사람에게
 * 오는가"* 를 보고 **사람을 `@handle` 로 부른 말은 접지 않기** 때문이다.
 *
 * 그래서 이 블록은 두 가지를 한다: 보고 대상을 팀장으로 못 박고, **요청자를 부르지 말라**고
 * 말한다. 그 둘이 화면의 접힘 규칙과 한 쌍이다.
 *
 * ## 기한을 말한다
 *
 * 이 팀원이 답하지 않으면 그 의무는 기한에 **무응답으로 닫히고** 팀장이 그 사실을 받는다.
 * 그때 팀장은 직접 하거나 다른 팀원에게 돌린다 — 즉 늦은 답은 버려지는 것이 아니라 **이미
 * 다른 사람이 하고 있는 일**이 된다. 그 시각을 모르면 팀원은 자기가 얼마나 여유가 있는지
 * 판단할 수 없고, 오래 걸리는 일에서 `turn.wake` 를 걸어야 할지도 알 수 없다.
 *
 * ## 실패는 예외라고 적는다
 *
 * "요청자를 부르지 마라"를 그대로 두면 막혔을 때도 침묵한다. 실패(`message.fail`)는 화면이
 * **언제나 펼치는** 말이고(`addressesHuman` 의 첫 조건), 그것이 맞다 — 막힌 것은 사람이
 * 봐야 한다. 그래서 그 하나를 명시적으로 열어 둔다.
 */
function handedSection(handed: InboxDelegatedBy): string[] {
  return [
    `(넘겨받은 일 — 팀 @${handed.teamName} 의 팀장 @${handed.leadHandle} 가 너에게 넘겼다)`,
    '',
    `**최종 답은 팀장이 쓴다.** 네 발화는 @${handed.leadHandle} 에게 오는 **보고**다 —`,
    '요청자(사람)를 `@handle` 로 부르지 마라. 네 보고까지 사람에게 직접 오면 창구가 둘이 되고,',
    '그것이 지금 고치고 있는 바로 그 시끄러움이다.',
    '',
    `기한은 ${handed.deadlineAt} 까지다. 그 안에 답하지 않으면 이 일은 **무응답**으로 닫히고`,
    '팀장이 직접 하거나 다른 팀원에게 돌린다 — 오래 걸릴 것 같으면 지금 아는 것을 먼저 보고해라.',
    '',
    '**막혔으면 `message.fail` 을 써라.** 실패는 사람에게도 보이는 유일한 예외다 — 막힌 것을',
    '조용히 두는 것이 가장 나쁘다.',
    '',
  ];
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
  /**
   * 이 턴이 **팀장으로서 불린 턴**이면 그 팀과 명단(마이그레이션 047).
   *
   * `wake` 와 나란히 두지만 뜻이 다르다: `wake` 는 사람의 새 발화가 **없을 때** 델타를
   * 대신하는 줄이고, 이것은 사람의 발화가 있는 위에 **덧붙는 맥락**이다. 그래서 아래
   * 조립에서 `toShow` 가 비었는지를 판정할 때 이 값은 세지 않는다 — 팀 부름인데 보여줄
   * 새 말이 없다면 그것은 이미 답한 말이고, 명단만으로 턴을 한 번 더 돌릴 이유가 없다.
   */
  team?: InboxTeamCall;
  /**
   * 이 턴이 **넘긴 일의 결말로 깨어난 턴**이면 그 결말(마이그레이션 050).
   *
   * `wake` 와 같은 성격이다 — **델타를 대신할 수 있어야 한다.** 기한이 지나 깨어난 경우엔
   * 팀원이 아무 말도 하지 않았으므로 새 메시지가 없고, 그러면 아래 빈-프롬프트 가드에 걸려
   * 하네스가 돌지 않는다. 그 자리에서 기다림이 흔적 없이 사라지는 것이 040 이 `wake` 를
   * 만든 이유이고, 여기서도 같다.
   */
  delegation?: InboxDelegationOutcome;
  /**
   * 이 턴이 **넘겨받은 일**이면 넘긴 팀장과 기한(3-2). 사람의 새 발화가 있는 위에 덧붙는
   * 맥락이라 `team` 과 같은 성격이고, 델타를 대신하지 않는다.
   */
  delegatedBy?: InboxDelegatedBy;
}): { prompt: string; fedSeq: number } {
  const {
    messages, lastFedSeq, meId, handles, channelId, threadRootId, murmurUrl, wake, team, delegation,
    delegatedBy,
  } = opts;
  const isFirstTurn = lastFedSeq === 0;

  const newMessages = messages.filter((m) => m.seq > lastFedSeq);
  // 넘길 게 있었든 없었든, 이번에 본 것 중 가장 큰 seq 가 다음 경계다. newMessages 가
  // 비어 있으면 reduce 의 초기값(lastFedSeq)이 그대로 나와 전진하지 않는다 — 볼 게 없었으니
  // 맞는 동작이다.
  const fedSeq = newMessages.reduce((max, m) => Math.max(max, m.seq), lastFedSeq);

  const toShow = newMessages.filter((m) => isFirstTurn || m.authorId !== meId);
  if (!toShow.length && wake === undefined && delegation === undefined) {
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
  const teamLines = team === undefined ? [] : teamSection(team, meId, handles);
  const delegationLines = delegation === undefined ? [] : delegationSection(delegation);
  const handedLines = delegatedBy === undefined ? [] : handedSection(delegatedBy);
  // 안내는 첨부 줄 **뒤**에 선다 — 먼저 무엇이 왔는지 보고 그다음 어떻게 여는지 읽는 순서다.
  // `toShow` 로 판정한다: 보여주지 않은 메시지의 첨부는 프롬프트에 id 가 없어 열 수도 없다.
  const howTo = toShow.some((m) => m.attachments.length) ? attachmentHowTo(murmurUrl) : [];
  // 팀 블록은 **델타 앞**이다 — 사람의 말을 읽기 전에 "너는 이 팀의 창구다"를 알아야
  // 그 말을 팀의 일로 읽는다. `wakeLines` 뒤에 두는 이유: 그 줄은 이 턴이 왜 떴는지이고,
  // 팀 블록은 이 턴이 무엇인지다(둘이 함께 오는 경우는 예약이 걸린 팀 턴이다).
  const prompt = [head, '', ...wakeLines, ...teamLines, ...delegationLines, ...handedLines, ...lines, ...howTo].join('\n');

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

// 실패를 어떻게 다룰지에 대한 판단만 모았다. 순수 함수라 루프 없이 검증된다.
// **여기서 다른 모듈을 import 하지 않는다** — murmur 클라이언트를 끌어오면 이 파일이
// MCP 전송·네트워크 의존까지 물게 되고, "순수 함수라 루프 없이 검증된다"가 깨진다.
// 그래서 출처 태그의 값도 여기서 정의하고, 태그를 붙이는 쪽(murmur.ts)이 이것을 읽어 간다.

/** 한 항목을 몇 번까지 시도할지. 영원히 실패하는 한 건이 나머지 멘션을 가로막지 않게 한다. */
export const MAX_ATTEMPTS = 3;

const CEILING_MS = 60_000;

/**
 * murmur 클라이언트에서 온 에러임을 표시하는 값. `murmur.ts` 가 자기가 던지는 에러의
 * `source` 에 이것을 넣고, `isCredentialFailure` 가 그것을 읽어 출처를 가린다.
 *
 * 왜 필요한가: `isCredentialFailure` 는 `main.ts` 에서 `runMentionTurn` **전체**를 감싸는
 * catch 에 쓰인다. 그래서 err 는 하네스 실행 실패뿐 아니라 murmur 서버 호출(readThread·post)
 * 실패에서도 온다. 출처를 못 가리면 murmur PAT 만료를 "claude CLI 로 로그인해라"로 안내한다.
 */
export const MURMUR_ERROR_SOURCE = 'murmur-client';

/** 자격증명 실패의 출처. 'other' 는 자격증명 실패가 아니라는 뜻이다. */
export type CredentialFailureType = 'harness-credential' | 'murmur-credential' | 'other';

/** 실행 파일 부재 실패의 출처. 'other' 는 실행 파일 부재가 아니라는 뜻이다. */
export type ExecutableNotFoundType = 'executable-not-found' | 'other';

/**
 * 하네스 실행 파일을 찾지 못했다(#340). `pty.ts::runPtyTurn` 이 던지고, 바로 아래
 * `isExecutableNotFound` 가 받는다.
 *
 * **던지는 곳(pty.ts)이 아니라 여기 있는 이유**: 이 파일 머리의 규칙대로 policy 는 아무것도
 * import 하지 않는다. 판정을 던지는 쪽에 두면 policy 가 node-pty(네이티브 모듈)까지 물게 되고,
 * 그러면 "순수 함수라 루프 없이 검증된다"가 깨진다. 타입은 판정과 같은 곳에 있어야 판정이
 * 문구나 이름 매칭으로 후퇴하지 않는다.
 *
 * `path` 는 러너 자신의 PATH 가 아니라 **자식에게 넘길 PATH**(`plan.env.PATH`)다. 이 결함이
 * 실제로 나는 경우가 정확히 그 둘이 다른 경우이기 때문이다 — launchd 는 로그인 셸의 PATH 를
 * 물려주지 않는다.
 */
export class ExecutableNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(
    readonly command: string,
    readonly path: string | undefined,
  ) {
    super(`실행 파일을 찾을 수 없음: ${command} (PATH: ${path ?? '(empty)'})`);
    this.name = 'ExecutableNotFoundError';
  }
}

/**
 * 자격증명 실패 문구. **공백을 전부 지운 문자열**에 대고 맞춘다 — 그래서 아래 패턴들에도
 * 공백이 없다.
 *
 * 왜 이렇게 하나: 하네스는 PTY(`pty.ts`, cols 120) 안에서 돌고, `isCredentialFailure` 가
 * 보는 것은 그 출력의 tail 이다. 소프트 랩은 어느 자리에서든 개행을 끼워 넣고, **원문의
 * 공백을 먹는 경우와 남기는 경우가 둘 다 있다.** 그래서
 *   - 개행만 지우면 `could not resolve\nauthentication` → `resolveauthentication` 가 되어
 *     `\s+` 를 요구하는 패턴이 못 맞춘다(공백을 먹은 랩).
 *   - 개행을 공백으로 바꾸면 `x-api-\nkey` → `x-api- key` 가 되어 이번엔 그쪽이 못 맞춘다.
 * 공백을 **전부** 지우면 랩 위치와 무관해진다. 이 문구들은 충분히 길고 특이해서 단어가
 * 붙어 생기는 오탐은 실질적으로 없다.
 *
 * `authentication_error` 는 밑줄이 있는 **API 에러 코드**다 — 공백으로 오인해 `\s+` 로
 * 바꾸면 이 신호를 통째로 잃는다(실제로 그 실수를 한 번 했다).
 *
 * **이 문구들은 사람의 프롬프트에도 나올 수 있다(#380 1단계 실측).** tail 이 하네스 자신의
 * 출력만 담는다는 전제는, 프롬프트를 `pty.write()` 로 PTY stdin 에 흘려보내는 순간 깨진다 —
 * PTY 가 입력을 그대로 에코해 tail 앞부분에 남기 때문이다(실측: `pty.ts::composeSpawn` 위
 * 주석). 사람이 "x-api-key 헤더를 어떻게 검증하나요?" 같은 지극히 정상적인 질문을 하면 그
 * 문구가 tail 에 나타나 무관한 실패를 자격증명 실패로 오판한다(재현: `test/policy.test.ts`
 * "#380 1단계 실측"). 현재 프로덕션 경로(`pty.ts::composeSpawn` 의 `sh -c ... < 파일`
 * stdin 리다이렉션)는 프롬프트를 PTY 에 흘리지 않으므로 이 오탐이 나지 않는다 — 이 판정을
 * `pty.write()` 경로로 확장하려면 이 오탐부터 격리해야 한다.
 */
const HARNESS_CREDENTIAL_PATTERNS = [
  /couldnotresolveauthentication/i,
  /x-api-key/i,
  /authentication_error/i,
  // 2026-09-07 16:06 실측(forge 러너): claude CLI 가 실제로 낸 문구는
  // `Failed to authenticate: OAuth session expired and could not be refreshed` 였다.
  // 위 셋 어디에도 걸리지 않아 러너는 이것을 일시 실패로 보고 3회 재시도를 태운 뒤
  // "(답변에 실패했습니다 — 운영자 확인이 필요합니다)"만 남겼다 — 정작 필요한 일은
  // `claude` 재로그인 하나였고, 화면은 그것을 말하지 않았다.
  //
  // 두 조각으로 나눈 이유: CLI 문구는 판본마다 조금씩 바뀐다. `failedtoauthenticate` 는
  // 원인을 안 밝히는 판본까지 잡고, `oauthsessionexpired` 는 접두어가 바뀐 판본을 잡는다.
  /failedtoauthenticate/i,
  /oauthsessionexpired/i,
  // 2026-09-07 실측(claude 2.1.263): 계정별 `CLAUDE_CONFIG_DIR` 에 로그인이 없으면
  // `Not logged in · Please run /login`, 종료 코드 1. 위 다섯 패턴 어디에도 안 걸려
  // 러너는 이것을 일시 실패로 보고 3회를 태운 뒤 `FAILURE_NOTICE` 만 남겼다 —
  // 정작 필요한 일은 그 디렉터리에서 로그인 한 번이었다.
  //
  // `/login` 이 아니라 `notloggedin` 으로 맞추는 이유: `/login` 은 사람의 프롬프트에도
  // 흔히 나오는 짧은 토큰이다. 위 `#380` 절이 그 오탐 경로를 이미 적어 뒀다 — 지금
  // 프로덕션 경로에서는 프롬프트가 tail 에 안 섞이지만, 짧은 패턴을 넣어 두면 그 보호가
  // 사라지는 날 조용히 오탐한다.
  /notloggedin/i,
];

/**
 * 사용량 한도(2026-09-07 16:05 실측: `You've hit your session limit · resets 4:10pm
 * (Asia/Seoul)`).
 *
 * **자격증명 실패가 아니다.** 로그인은 멀쩡하고 시간이 지나면 낫는다. 그런데 재시도로도
 * 낫지 않는다 — 3회가 5초 안에 끝나므로 한도가 풀릴 리 없다. 두 갈래(영구 실패 / 재시도로
 * 낫는 실패) 어디에도 맞지 않아 세 번째 갈래가 필요하다.
 *
 * 시각을 함께 돌려주는 이유: "한도에 걸렸다"만으로는 사람이 언제 다시 부를지 모른다.
 * 못 읽으면 `null` 이고, 그때도 한도라는 사실은 돌려준다 — 사실이 시각보다 크다.
 *
 * 시각을 **파싱하지 않고 문자열로 두는** 이유: CLI 가 이미 사람이 읽는 형식으로
 * (그리고 사람의 시간대로) 적어 줬다. 우리가 Date 로 만들면 시간대를 다시 정해야 하고,
 * 그 판단은 여기서 할 수 있는 것이 아니다.
 *
 * **시각 추출이 문자열 끝을 앵커로 삼으면 안 된다(2026-09-07 19:03 실측).** 초판은
 * `/resets\s+([^\n]+?)\s*$/` 였고, 그날 세션 파일에는 `resets 10:50pm (Asia/Seoul)` 이
 * 분명히 있었는데 러너 로그는 "풀림: 알 수 없음"을 찍었다. tail 은 끝 2KB 링 버퍼이고,
 * 한도에 걸린 claude 는 죽기 전에 화면을 다시 그린다 — 커서 복원·색 리셋 시퀀스가 그
 * 문구 뒤에 붙어 `$` 가 맞지 않았다. tail 의 끝이 무엇인지는 우리가 정할 수 없으므로
 * (`pty.ts` 는 raw 바이트를 그대로 담는다) 그 가정 자체를 버리고, 시각이 끝나는 자리를
 * **줄 끝 또는 ESC**로 잡는다.
 */
export function quotaFromText(text: string): { resetsAt: string | null } | null {
  const squashed = text.replace(/\s+/g, '').toLowerCase();
  // `You've` 의 아포스트로피는 판본·터미널에 따라 `'` 와 `’` 가 다 나오므로 뺀 채로 본다.
  if (!/hityour(session|usage)limit/i.test(squashed.replace(/['’]/g, ''))) return null;
  // `[^\n\u001b]` — 줄 끝이나 ESC 에서 멈춘다. 뒤에 무엇이 더 오든 상관하지 않는다.
  const resets = /resets\s+([^\n\u001b]+)/i.exec(text);
  return { resetsAt: resets ? resets[1]!.trim() : null };
}

/**
 * **구조화 필드를 먼저 본다(2026-09-08).** `mentionTurn` 이 세션 JSONL 에서 읽은 하네스 자신의
 * 에러 문구를 `harnessApiError` 로 실어 준다. 그 재료가 tail 보다 나은 이유는
 * `harnessErrors.ts` 머리에 있다 — 앞이 안 잘리고, 사람의 프롬프트가 섞이지 않는다.
 *
 * 못 읽었으면(파일 부재·codex) 필드가 없고 그때는 기존 tail 판정 그대로다. 필드가 **있는데
 * 한도가 아닌** 경우에도 tail 로 폴백한다: 그 값은 "그 세션의 마지막 API 에러"이지 "이 턴이
 * 실패한 이유"라는 보장이 아니라서, 앞 턴의 다른 에러가 이번 한도를 가리면 안 된다.
 */
export function isQuotaExhausted(err: unknown): { resetsAt: string | null } | null {
  const structured = (err as { harnessApiError?: unknown } | null)?.harnessApiError;
  if (typeof structured === 'string') {
    const hit = quotaFromText(structured);
    if (hit) return hit;
  }
  return quotaFromText(err instanceof Error ? err.message : String(err ?? ''));
}

/**
 * claude 가 이미 존재하는 세션 id 로 신규 시작을 거부했는가(2026-09-07 19:03 실측:
 * `Error: Session ID 214242d8-... is already in use.`).
 *
 * **재시도로 절대 낫지 않는다** — 실측에서 3회가 176·185·278ms 만에 같은 자리에서
 * 실패했다. 그런데도 재시도 회계에 들어가 3회를 태운 끝에 `FAILURE_NOTICE`("운영자 확인이
 * 필요합니다")를 남겼고, 그것은 사람이 할 일을 잘못 가리켰다.
 *
 * **자격증명·실행 파일 부재와 달리 러너를 죽이지 않는다.** 이것은 그 스레드 하나의 세션
 * 상태 문제이고 다른 스레드는 멀쩡하다. 그래서 사용량 한도와 같은 세 번째 갈래로 다룬다:
 * 러너는 살고, 재시도는 하지 않고, 스레드에 사실을 남긴다.
 *
 * **근본 원인은 여기가 아니다.** 실패한 턴이 세션을 남겼는데 `turnsRun` 이 0 으로 남아
 * 다음 턴이 `--session-id` 로 조립되는 것이 원인이고, `mentionTurn.ts` 의 세션 실재 관측이
 * 그것을 막는다. 이 판정은 그 관측이 실패하는 경로(claude 가 세션 파일 위치 규칙을 바꾸는
 * 등)에 남겨 두는 그물이다 — 그물이 걷히는 날에도 3회를 헛돌지는 않게 한다.
 *
 * 문구를 `sessionid` 없이 `isalreadyinuse` 로만 재는 이유: tail 은 끝 2KB 링 버퍼라 앞이
 * 잘리고, 그때 uuid 와 접두어가 통째로 사라진다. 이 문구는 충분히 특이해서 하네스의 다른
 * 실패와 겹치지 않는다.
 */
export function isSessionIdConflict(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /isalreadyinuse/i.test(text.replace(/\s+/g, ''));
}

/**
 * 운영자가 개입해야 하는 실패인가(자격증명). 재시도로 낫지 않으므로 러너는 즉시 크게 실패해야
 * 한다 — 무한 재시도로 감추면 로그만 쌓이고 "왜 답이 없지"의 원인이 묻힌다.
 *
 * 출처를 가려서 돌려준다: murmur PAT 문제와 harness 로그인 문제는 운영자가 확인할 곳이
 * 서로 다르다(`main.ts` 가 이 값으로 안내를 나눈다).
 */
export function isCredentialFailure(err: unknown): CredentialFailureType {
  const status = (err as { status?: number } | null)?.status;

  // murmur 클라이언트가 붙인 태그가 있으면 그쪽이다. 판정은 **HTTP status 로만** 한다 —
  // murmur.ts 가 status 를 항상 실어 주므로 문구 매칭이 필요 없다(문구로 판정하면 "401"
  // 같은 숫자가 본문에 우연히 들어간 에러까지 자격증명 실패로 오인한다).
  if ((err as { source?: string } | null)?.source === MURMUR_ERROR_SOURCE) {
    return status === 401 || status === 403 ? 'murmur-credential' : 'other';
  }

  if (status === 401 || status === 403) return 'harness-credential';

  // **하네스 자격증명은 tail 문자열로 재지 않는다(2026-09-08 실행 모델 교체).**
  //
  // TUI 는 주입한 프롬프트를 그대로 에코하므로 tail 에 **사람이 쓴 말이 섞인다**(#380 2단계
  // 실측이 이미 관측한 오탐 경로다). 그 재료로 판정하면 에이전트를 멘션할 수 있는 사람이
  // 본문에 `authentication_error` 한 줄을 적는 것만으로 그 러너를 `exit 78` 로 물러나게 할
  // 수 있고, 그 러너가 맡은 **모든 스레드**가 함께 죽는다.
  //
  // 대신 하네스가 **자기 세션 파일에 남긴** 구조화 에러를 본다(`harnessErrors.ts` 가 읽어
  // `harnessApiError` 로 실어 준다). 거기에는 사람의 말이 섞일 수 없다 — `isApiErrorMessage`
  // 플래그가 붙은 레코드의 내용은 하네스 자신의 문구다.
  //
  // 문구 목록(`HARNESS_CREDENTIAL_PATTERNS`)은 그대로다. 바뀐 것은 **재료**뿐이다.
  const structured = (err as { harnessApiError?: unknown } | null)?.harnessApiError;
  if (typeof structured !== 'string') return 'other';
  return HARNESS_CREDENTIAL_PATTERNS.some((re) => re.test(structured.replace(/\s+/g, '')))
    ? 'harness-credential'
    : 'other';
}

/**
 * 하네스 실행 파일 부재인가(#340). `isCredentialFailure` 바로 옆에 두는 이유는 둘이 같은
 * 부류이기 때문이다 — **재시도로 낫지 않는 실패**. `main.ts` 는 두 판정을 한 자리
 * (`exit.ts::runnerExitPlan`)에서 본다.
 *
 * **문구도 이름도 아니라 클래스로 판정한다.** `isCredentialFailure` 는 하네스가 뱉은 남의
 * 출력을 읽어야 해서 문구 매칭 말고는 방법이 없지만, 이쪽은 우리가 직접 던진 오류라 그럴
 * 이유가 없다 — 메시지가 바뀌어도, `err.name` 을 누가 덮어써도 이 판정은 안 흔들린다.
 * `code === 'ENOENT'` 만 보는 것도 안 된다: `fs` 어디서든 나는 흔한 코드라, 그것으로 재면
 * 설정 파일 하나 없는 것에도 러너가 죽는다.
 *
 * 왜 죽는 것이 맞나: PATH 나 설치 상태가 그대로인 한 다음 시도도 같은 자리에서 실패한다.
 * launchd `KeepAlive` 가 다시 띄워도 마찬가지라 로그에 같은 줄이 계속 쌓이고, 운영자는
 * 원인을 바로 본다. 조용히 살아서 멘션을 3건씩 삼키는 쪽이 훨씬 나쁘다.
 */
export function isExecutableNotFound(err: unknown): ExecutableNotFoundType {
  return err instanceof ExecutableNotFoundError ? 'executable-not-found' : 'other';
}

export function nextBackoffMs(current: number): number {
  return Math.min(current * 2, CEILING_MS);
}

export function exhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

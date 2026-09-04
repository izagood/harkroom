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
 */
const HARNESS_CREDENTIAL_PATTERNS = [
  /couldnotresolveauthentication/i,
  /x-api-key/i,
  /authentication_error/i,
];

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

  // 태그가 없으면 하네스에서 온 것으로 본다(mentionTurn.ts 가 tail 을 담아 던진 에러).
  if (status === 401 || status === 403) return 'harness-credential';
  const squashed = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, '');
  return HARNESS_CREDENTIAL_PATTERNS.some((re) => re.test(squashed)) ? 'harness-credential' : 'other';
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

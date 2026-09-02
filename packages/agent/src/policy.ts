// 실패를 어떻게 다룰지에 대한 판단만 모았다. 순수 함수라 루프 없이 검증된다.
import { MURMUR_ERROR_MARKER } from './murmur.js';

/** 한 항목을 몇 번까지 시도할지. 영원히 실패하는 한 건이 나머지 멘션을 가로막지 않게 한다. */
export const MAX_ATTEMPTS = 3;

const CEILING_MS = 60_000;

/**
 * 자격증명 실패의 출처를 나타내는 타입.
 * #87: murmur 클라이언트 실패와 하네스 실패를 구분한다.
 */
export type CredentialFailureType = 'harness-credential' | 'murmur-credential' | 'other';

/**
 * 운영자가 개입해야 하는 실패인가(자격증명). 재시도로 낫지 않으므로 러너는 즉시 크게 실패해야
 * 한다 — 무한 재시도로 감추면 로그만 쌓이고 "왜 답이 없지"의 원인이 묻힌다.
 *
 * #87 수정:
 * - PTY 120컬럼 줄바꿈에 강건해졌다: \s+ 로 매칭해 줄바꿈이나 공백을 모두Accept한다.
 * - murmur 클라이언트와 하네스의 401/자격증명 실패를 구분한다. murmur PAT 문제면
 *   "Murmur API 키를 확인해라", 하네스(claude) 문제면 "claude CLI 로그인"을 안내한다.
 * - MURMUR_ERROR_MARKER 로 출처를 구분한다 — murmur.ts 가 에러에 source: 'murmur-client' 를
 *   붙이므로 이 함수는 그 태그를 읽어 'murmur-credential' 인지 'harness-credential' 인지
 *   판단한다. 태그가 없으면 하네스라고 보고, mentionTurn.ts 가 만드는 "harness 종료" 형식의
 *   에러 메시지를 본다.
 */
export function isCredentialFailure(err: unknown): CredentialFailureType {
  // #87: murmur 클라이언트 출처 태그 확인
  const source = (err as { source?: string })?.source;
  if (source === MURMUR_ERROR_MARKER) {
    // murmur 클라이언트에서 온 에러 — status 나 자격증명 문구로 판단
    const status = (err as { status?: number } | null)?.status;
    if (status === 401 || status === 403) return 'murmur-credential';
    const message = err instanceof Error ? err.message : String(err);
    // murmur 클라이언트의 401/403 은 이미 위에서 처리됨, 여기선万一를 위해
    if (/401|403|unauthorized|forbidden|authentication.*fail/i.test(message)) {
      return 'murmur-credential';
    }
    return 'other';
  }

  // 하네스에서 온 에러 (또는 출처 태그가 없는 에러)
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return 'harness-credential';
  const message = err instanceof Error ? err.message : String(err);

  // #87: \s+ 로 줄바꿈에 강건하게 매칭 — PTY 120컬럼에서 줄이 끊겨도匹配된다.
  // credential 관련 핵심 단어들을 \s+ 로 구분해 어느 자리에서 줄바꿈이 일어나든 감지한다.
  // 먼저 메시지의 모든 개행과 하이픈 주변을 정규화: 개행은 제거, "-key"는 "key"로 매칭되게 한다.
  // PTY 가 120컬럼에서 "x-api-key"를 "x-api-\nkey" 로 끊을 수 있으므로,
  // 하이픈 다음에 오는 줄바꿈을 무시하도록 "x-api-?key" 패턴을 쓴다.
  const normalized = message.replace(/[\r\n]+/g, '');
  if (/could\s+not\s+resolve\s+authentication|x-api-?key|authentication\s+error/i.test(normalized)) {
    return 'harness-credential';
  }

  return 'other';
}

/**
 * 다음 백오프. `inbox.poll` 은 미읽음이 있으면 즉시 반환하므로(park 는 비어 있을 때만),
 * 답변 실패 후 그냥 다시 폴하면 같은 항목으로 타이트 루프가 돈다.
 */
export function nextBackoffMs(current: number): number {
  return Math.min(current * 2, CEILING_MS);
}

export function exhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}
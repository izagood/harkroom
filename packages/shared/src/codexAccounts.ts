/**
 * codex 계정의 **이름 문법과 활성 표식** — 데몬(쓰는 쪽)과 러너(읽는 쪽)가 같은 한 벌을 본다.
 *
 * ## 모양
 *
 * ```
 * <root>/                       (기본 ~/.harkroom-agent/codex-accounts)
 *   active.json                 { "active": "<이름>" | null }   writer = 데몬 하나
 *   <이름>/auth.json            그 계정의 CODEX_HOME. `codex login` 이 쓴다
 * ```
 *
 * claude 와 달리 **풀이 없다.** codex 는 한 번에 한 계정(활성)으로 돌고, 러너는 턴마다
 * `active.json` 을 다시 읽어 자기 격리 `CODEX_HOME/auth.json` 링크를 그 계정으로 돌린다
 * (`agent/src/codexHome.ts`). 세션 장부는 러너 쪽 `CODEX_HOME/sessions` 에 남으므로 계정을
 * 바꿔도 스레드의 codex 세션은 끊기지 않는다 — claude(세션이 계정 디렉터리 안)와 다른 점이다.
 *
 * `active` 가 `null`·없음·깨짐이면 **시스템 기본 로그인**(`~/.codex`)이다. 깨진 파일을 던지지
 * 않는 이유: 러너가 턴마다 읽으므로, 던지면 파일 하나 때문에 codex 턴 전부가 죽는다.
 */

/** claude 계정 이름(`CLAUDE_POOL_NAME_PATTERN`)과 같은 문법. 이 이름은 경로 세그먼트가 된다. */
export const CODEX_ACCOUNT_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

export const CODEX_ACTIVE_FILE = 'active.json';

export interface CodexActiveConfig {
  active: string | null;
}

export function parseCodexActive(raw: unknown): CodexActiveConfig {
  if (typeof raw !== 'object' || raw === null) return { active: null };
  const v = (raw as Record<string, unknown>).active;
  return { active: typeof v === 'string' && CODEX_ACCOUNT_NAME_PATTERN.test(v) ? v : null };
}

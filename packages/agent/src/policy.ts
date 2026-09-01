// 실패를 어떻게 다룰지에 대한 판단만 모았다. 순수 함수라 루프 없이 검증된다.

/** 한 항목을 몇 번까지 시도할지. 영원히 실패하는 한 건이 나머지 멘션을 가로막지 않게 한다. */
export const MAX_ATTEMPTS = 3;

const CEILING_MS = 60_000;

/**
 * 운영자가 개입해야 하는 실패인가(자격증명). 재시도로 낫지 않으므로 러너는 즉시 크게 실패해야
 * 한다 — 무한 재시도로 감추면 로그만 쌓이고 "왜 답이 없지"의 원인이 묻힌다.
 */
export function isCredentialFailure(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /could not resolve authentication|x-api-key|authentication_error/i.test(message);
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

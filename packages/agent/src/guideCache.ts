/**
 * 워크스페이스 가이드를 기동 때 한 번만 받지 않고 TTL 로 다시 받는다(2026-10-27, 앱 기본 규칙 전달 땜질 f6).
 *
 * 가이드는 서버 상수라 서버 배포로 바뀐다. 러너가 기동 때 받은 원문을 끝까지 쓰면, 러너를 다시 띄우기 전까지
 * 턴은 옛 규칙을 받는다. 턴 의존(`buildTurnDeps`)은 동기라서 **가진 값을 바로 돌려주고**, 오래됐으면 뒤에서
 * 다시 받는다 — TTL 이 지난 뒤 첫 턴은 옛 판, 그다음 턴부터 새 판이다. 다시 받기에 실패하면 가진 값을 그대로
 * 쓴다(서버 교체 중의 일시 오류로 규칙이 빈 채 나가면 안 된다).
 */
export interface GuideCache {
  /** 지금 가진 가이드. 오래됐으면 뒤에서 다시 받기를 건다(한 번에 하나만). */
  current(): string;
}

export const GUIDE_TTL_MS = 10 * 60_000;

export function createGuideCache(opts: {
  initial: string;
  fetch: () => Promise<string>;
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}): GuideCache {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? GUIDE_TTL_MS;
  let value = opts.initial;
  let fetchedAt = now();
  let inflight = false;
  return {
    current() {
      if (!inflight && now() - fetchedAt >= ttl) {
        inflight = true;
        opts.fetch().then(
          (g) => { if (g) value = g; fetchedAt = now(); },
          // 실패해도 시각을 당긴다 — 서버가 내려간 동안 턴마다 다시 부르지 않는다.
          (err) => { fetchedAt = now(); opts.onError?.(err); },
        ).finally(() => { inflight = false; });
      }
      return value;
    },
  };
}

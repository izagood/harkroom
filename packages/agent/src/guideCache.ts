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

/**
 * 서버 가이드의 머리(`server/src/mcp/guide.ts` HEADER). 다시 받은 값이 이것으로 시작할 때만 교체한다(#1609 security n1).
 * `harkroom.guide()` 는 모양이 다른 응답을 `JSON.stringify` 로 글자로 만든다 — 기동 때는 그 판밖에 없지만, 실행 중에는
 * 좋은 판을 그 글자가 덮어 턴에 실린다. 머리가 다르면 실패로 친다(가진 판을 그대로 쓴다).
 */
export const GUIDE_HEAD = '# harkroom workspace 가이드';

/**
 * 글자이면서 가이드 머리로 시작하는가. `harkroom.guide()` 는 응답의 `guide` 를 그대로 넘기므로 숫자·null 이 올 수 있다 —
 * 그때 `startsWith` 가 성공 처리기 안에서 던지면 처리되지 않은 거부로 러너가 죽는다(#1616 security m1).
 */
export function isGuideText(g: unknown): g is string {
  return typeof g === 'string' && g.startsWith(GUIDE_HEAD);
}

/** 모양이 다른 응답을 로그에 남길 때의 머리 — 글자가 아니면 그 형만 적는다. */
export function guideHeadForLog(g: unknown): string {
  return typeof g === 'string' ? JSON.stringify(g.slice(0, 40)) : `(${g === null ? 'null' : typeof g})`;
}

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
          (g) => {
            fetchedAt = now();
            if (isGuideText(g)) value = g;
            else opts.onError?.(new Error(`가이드 응답 모양이 다르다(머리 ${guideHeadForLog(g)}) — 가진 판을 쓴다`));
          },
          // 실패해도 시각을 당긴다 — 서버가 내려간 동안 턴마다 다시 부르지 않는다.
          (err) => { fetchedAt = now(); opts.onError?.(err); },
        ).finally(() => { inflight = false; });
      }
      return value;
    },
  };
}

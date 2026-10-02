/**
 * (에이전트, 스레드) 턴 임대 — 러너 쪽(서버 마이그레이션 095, 스레드 ca992991 안 B).
 *
 * 왜: 앱을 업데이트하면 옛 러너가 하던 턴을 마저 끝내는 동안 새 러너가 이미 인박스를 본다(#866). 스레드
 * 잠금(`mentionScheduler.ts` 의 inFlightThreads·registry)은 **이 프로세스 안에만** 있어서, 그 사이 같은
 * 스레드에 새 멘션이 오면 새 러너가 같은 스레드·같은 하네스 세션에 두 번째 턴을 띄웠다(10-02 실측).
 * 그래서 턴을 띄우기 전에 서버에서 그 스레드의 임대를 잡는다 — 임대를 쥔 러너만 턴을 띄운다.
 *
 * - **holder 는 이 러너 프로세스다.** 같은 에이전트의 러너 둘은 같은 자격으로 붙으므로 기동 때 지은
 *   무작위 id 로 가른다.
 * - **턴 동안 민다(하트비트).** 러너가 죽으면 박동이 끊기고 서버의 만료(`ttlSec`)가 지나 다른 러너가
 *   넘겨받는다. 넘겨받힌 뒤 늦게 온 박동은 서버가 409 로 거절한다 — 되찾지 않는다.
 * - **한 프로세스 안에서도 스레드당 하나다.** 놓기가 끝나기 전에 같은 스레드를 다시 잡으면, 앞 턴의 놓기가
 *   뒤 턴의 임대를 지운다(같은 holder 라 서버는 둘을 못 가른다). 그래서 놓기가 끝날 때까지 null 이다.
 * - **확인하지 못하면 띄우지 않는다**(fail-closed). 링크·서버 오류는 다음 폴에서 다시 묻는다 — 멘션은
 *   인박스에 미읽음으로 남는다. 단 **옛 서버(404)는 임대가 없는 것**이라 지금까지처럼 띄운다.
 */

export type ClaimOutcome = 'held' | 'taken' | 'unsupported';

export interface ThreadClaimClient {
  /** `POST /agent/thread-claims` — 잡기와 하트비트가 같은 호출이다. 링크·서버 오류는 던진다. */
  claimThread(channelId: string, threadRootId: string, holder: string, ttlSec: number): Promise<ClaimOutcome>;
  /** `POST /agent/thread-claims/release` — 멱등이다. */
  releaseThread(channelId: string, threadRootId: string, holder: string): Promise<void>;
}

export interface ThreadClaim {
  /** 박동을 멈추고 서버에서 놓는다. 던지지 않는다 — 놓기가 실패해도 만료가 대신 놓는다. */
  release(): Promise<void>;
}

export interface ThreadClaims {
  /** 잡았으면 손잡이, 남(다른 러너)이 쥐었거나 확인하지 못했거나 이 프로세스가 아직 쥐고 있으면 null. */
  hold(channelId: string, threadRootId: string): Promise<ThreadClaim | null>;
  /** 종료 경로: 진행 중인 놓기를 최대 `ms` 기다린다. 놓지 못한 것은 만료가 놓는다. */
  drain(ms: number): Promise<void>;
}

export interface ThreadClaimTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 서버 기본값과 같다(`services/threadClaims.ts`). 러너가 죽은 뒤 넘겨받기까지 걸리는 시간의 상한이다. */
export const THREAD_CLAIM_TTL_SEC = 90;
/** 만료의 1/3 — 박동 하나가 늦거나 빠져도 임대가 살아 있다. */
export const THREAD_CLAIM_HEARTBEAT_MS = 30_000;

const NOOP: ThreadClaim = { release: async () => {} };

export function createThreadClaims(opts: {
  client: ThreadClaimClient;
  holder: string;
  ttlSec?: number;
  heartbeatMs?: number;
  timers?: ThreadClaimTimers;
  log?: (line: string) => void;
}): ThreadClaims {
  const ttlSec = opts.ttlSec ?? THREAD_CLAIM_TTL_SEC;
  const heartbeatMs = opts.heartbeatMs ?? THREAD_CLAIM_HEARTBEAT_MS;
  const log = opts.log ?? ((line: string) => console.error(line));
  const timers: ThreadClaimTimers = opts.timers ?? {
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      // 박동이 프로세스를 붙잡지 않는다 — 종료는 턴이 끝났는가로 정한다.
      h.unref?.();
      return h;
    },
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  /** 이 프로세스가 쥐고 있는(또는 놓는 중인) 스레드. 놓기가 끝나야 빠진다. */
  const held = new Set<string>();
  const releasing = new Set<Promise<void>>();
  let warnedUnsupported = false;

  return {
    async hold(channelId, threadRootId) {
      const key = `${channelId}/${threadRootId}`;
      if (held.has(key)) return null;
      held.add(key);
      let outcome: ClaimOutcome;
      try {
        outcome = await opts.client.claimThread(channelId, threadRootId, opts.holder, ttlSec);
      } catch (err) {
        held.delete(key);
        log(`[threadClaims] ${key}: 임대를 확인하지 못했다 — 이번 폴에는 띄우지 않는다(${err instanceof Error ? err.message : String(err)})`);
        return null;
      }
      if (outcome === 'taken') {
        held.delete(key);
        return null;
      }
      if (outcome === 'unsupported') {
        held.delete(key);
        if (!warnedUnsupported) {
          warnedUnsupported = true;
          log('[threadClaims] 서버가 스레드 임대를 모른다(옛 서버) — 이 러너 안의 스레드 잠금만으로 띄운다');
        }
        return NOOP;
      }

      let released = false;
      /** 날아가는 중인 박동. 놓기는 이것을 기다린다 — 놓은 뒤에 도착한 박동이 임대를 되살리지 않게. */
      let beat: Promise<void> | null = null;
      const handle = timers.setInterval(() => {
        if (released || beat) return;
        beat = opts.client.claimThread(channelId, threadRootId, opts.holder, ttlSec)
          .then((o) => {
            if (o === 'taken' && !released) {
              log(`[threadClaims] ${key}: 임대를 잃었다 — 박동이 끊긴 사이 다른 러너가 넘겨받았다`);
            }
          })
          .catch(() => { /* 다음 박동이 다시 민다. 만료 전에 두 번 더 기회가 있다 */ })
          .finally(() => { beat = null; });
      }, heartbeatMs);

      return {
        release() {
          if (released) return Promise.resolve();
          released = true;
          timers.clearInterval(handle);
          const p = (async () => {
            try {
              if (beat) await beat;
              await opts.client.releaseThread(channelId, threadRootId, opts.holder);
            } catch (err) {
              log(`[threadClaims] ${key}: 놓기 실패 — 만료(${ttlSec}초)가 놓는다(${err instanceof Error ? err.message : String(err)})`);
            } finally {
              held.delete(key);
            }
          })();
          releasing.add(p);
          void p.finally(() => releasing.delete(p));
          return p;
        },
      };
    },

    async drain(ms) {
      if (!releasing.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...releasing]),
        new Promise<void>((r) => { timer = setTimeout(r, ms); }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}

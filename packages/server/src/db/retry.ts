/**
 * DB 에 **닿지 못한** 실패인가(2026-10-12). Postgres 가 OOM 으로 재시작하는 동안 서버가 보는 것은
 * 이런 것들이다 — 실측 로그: `connect EPERM 10.0.0.1:5432`(엔드포인트가 빠진 동안 Cilium 이
 * connect 를 막는다), `timeout exceeded when trying to connect`(pg-pool 의 대기 시한),
 * `Connection terminated unexpectedly`, FATAL `57P01`·`57P03`(재시작 중·기동 중).
 *
 * 여기에 들지 않는 것 — 문법 오류·제약 위반 같은 **질의의** 실패 — 는 다시 해도 같은 답이 나온다.
 * 그런 것을 기다리며 되풀이하면 깨진 마이그레이션이 영원히 "DB 를 기다리는 중"으로 보인다.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (['ECONNREFUSED', 'ECONNRESET', 'EPERM', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
    'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true;
  // 57P01 admin_shutdown · 57P02 crash_shutdown · 57P03 cannot_connect_now · 08xxx connection_exception
  if (/^57P0[123]$/.test(code) || /^08/.test(code)) return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /timeout exceeded when trying to connect|Connection terminated|connection.*(closed|terminated)|Client has encountered a connection error/i
    .test(msg);
}

export interface DbRetryOptions {
  /** 로그에 실을 이름 — 무엇이 DB 를 기다리는지. */
  label: string;
  /** 이 시간(ms)을 넘기면 마지막 오류를 그대로 던진다. */
  deadlineMs: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** 시험용. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * DB 에 닿지 못한 실패만 지수 백오프로 다시 한다. 다른 실패와 시한을 넘긴 실패는 그대로 던진다 —
 * 기다림이 끝없으면 정말 죽은 DB 앞에서 프로세스가 "살아 있는 척"만 한다(그때는 죽어서 재시작
 * 정책에 넘기는 것이 맞다).
 */
export async function retryWhileDbUnreachable<T>(fn: () => Promise<T>, opts: DbRetryOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.error(m));
  const started = now();
  let delay = opts.initialDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      const waited = now() - started;
      if (waited + delay > opts.deadlineMs) throw err;
      log(`${opts.label}: database unreachable (attempt ${attempt}, ${(err as Error).message}) — retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

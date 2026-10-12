import pg from 'pg';

/**
 * Pool 을 만드는 **유일한** 지점. 에러 가드를 붙이지 않은 Pool 이 생기지 않게 하려고
 * 생성과 가드를 한 함수에 묶었다.
 *
 * pg 문서의 요구사항: 유휴 클라이언트에서 에러가 나면 Pool 이 대신 `error` 를 emit 하고,
 * **리스너가 없으면 uncaught exception 으로 던진다.** Postgres 가 재시작하면(compose
 * restart·failover·OOM) 살아 있는 유휴 연결에 FATAL `57P01 terminating connection due to
 * administrator command` 가 오고, 그 순간 서버 프로세스가 죽었다. DB 는 돌아오는데 서버는
 * 안 돌아오는 형태의 장애다 — 재시작 내성을 만들어 둔 것과 정면으로 어긋난다.
 */
/**
 * 풀 크기와 대기 시한(2026-10-01). 예전에는 pg 기본값(최대 10개, 대기 **무제한**)이었다.
 * 같은 채널에 글이 몰리면 게시 트랜잭션들이 채널 락에 줄을 서며 커넥션을 하나씩 쥐었고,
 * 10개가 다 묶인 동안 `/readyz` 의 `select 1` 까지 끝없이 기다려 readiness probe 가
 * 떨어졌다. 그 순간 DB 를 안 쓰는 `/healthz` 는 1~2ms 였다 — 서버가 아니라 풀이 막혔다.
 *
 * - `max` 20: Postgres `max_connections` 기본 100 에 비하면 여유가 크다(서버는 한 벌이다).
 * - `connectionTimeoutMillis` 5s: pg-pool 은 이 값을 **풀이 찼을 때 기다리는 시간**에도
 *   쓴다. 끝없이 줄 서는 대신 실패해서 500 으로 드러나게 한다 — 요청을 붙든 채 멈춘 서버는
 *   로그에 아무것도 남기지 않는다.
 */
export const POOL_MAX = 20;
export const POOL_CONNECT_TIMEOUT_MS = 5_000;

export function createPool(connectionString: string, onError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString, max: POOL_MAX, connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
  });
  const report = (err: Error) => {
    // 보고가 던지면 가드가 무의미해진다 — 로거가 죽은 상황이 정확히 이런 때다.
    try { onError(err); } catch { /* 삼킨다: 살아 있는 것이 보고보다 중요하다 */ }
  };
  pool.on('error', report);
  /**
   * **빌려 간 클라이언트**에도 같은 가드를 단다(2026-10-12). pg-pool 은 위 `error` 를 유휴
   * 클라이언트에만 걸고, `pool.connect()` 로 내준 동안에는 그 리스너를 뗀다. 그 사이 연결이 끊기고
   * 마침 질의가 없으면(트랜잭션을 쥔 채 다른 커넥션의 `postMessage` 를 기다리는 sweep 처럼) pg 는
   * 리스너 없는 `error` 를 emit 한다 — uncaught exception, 곧 프로세스 사망이다. 끊긴 클라이언트는
   * 반납할 때 pg-pool 이 `_queryable` 을 보고 버리므로 여기서는 알리기만 한다.
   */
  pool.on('connect', (client) => { client.on('error', report); });
  return pool;
}

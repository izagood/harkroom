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
export function createPool(connectionString: string, onError: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on('error', (err) => {
    // 보고가 던지면 가드가 무의미해진다 — 로거가 죽은 상황이 정확히 이런 때다.
    try { onError(err); } catch { /* 삼킨다: 살아 있는 것이 보고보다 중요하다 */ }
  });
  return pool;
}

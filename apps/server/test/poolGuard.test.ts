import { describe, it, expect, vi } from 'vitest';
import { createPool } from '../src/db/pool.js';

describe('pool 에러 가드', () => {
  // pg 문서의 요구사항: 유휴 클라이언트의 에러는 Pool 이 대신 emit 하고, **리스너가 없으면
  // uncaught exception 으로 던진다.** Postgres 가 재시작하면(compose restart·failover)
  // 살아 있는 유휴 연결에 FATAL 57P01 이 오고, 그때 서버 프로세스가 죽는다.
  it('attaches an error listener so an idle-client failure cannot kill the process', () => {
    const pool = createPool('postgres://nobody@127.0.0.1:1/none', () => {});

    expect(pool.listenerCount('error')).toBe(1);
  });

  it('reports the error instead of throwing', () => {
    const seen: unknown[] = [];
    const pool = createPool('postgres://nobody@127.0.0.1:1/none', (err) => seen.push(err));
    const fatal = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });

    expect(() => pool.emit('error', fatal, {} as never)).not.toThrow();
    expect(seen).toEqual([fatal]);
  });

  // 보고 자체가 던지면 가드가 무의미하다(로거가 죽은 상황이 정확히 이런 때다).
  it('survives a reporter that throws', () => {
    const pool = createPool('postgres://nobody@127.0.0.1:1/none', () => { throw new Error('logger down'); });

    expect(() => pool.emit('error', new Error('x'), {} as never)).not.toThrow();
  });

  it('passes the connection string through', () => {
    const url = 'postgres://u:p@127.0.0.1:5555/db';
    const pool = createPool(url, vi.fn());

    // pg 는 connectionString 을 즉시 파싱하지 않는다(첫 연결 때 푼다) — 보관된 값을 본다.
    expect((pool.options as { connectionString?: string }).connectionString).toBe(url);
  });
});

import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { retryWhileDbUnreachable } from './retry.js';

// 마이그레이션 직렬화용 advisory lock 키. 테이블에 의존하지 않는 잠금이어야 한다 —
// 'create table if not exists schema_migrations' 자체도 동시 실행 시 pg 카탈로그 유니크
// 인덱스에서 깨지므로(실측: pg_type_typname_nsp_index), 첫 DDL보다 앞서 잠글 곳이 필요하다.
const MIGRATION_LOCK_KEY = 0x6d726d72; // 'mrmr'

/**
 * 트랜잭션 밖에서 돌릴 파일의 표지(2026-10-12). 파일 어디든 이 줄이 있으면 `begin`/`commit` 으로 감싸지 않고
 * 문장을 하나씩 따로 보낸다 — `create index concurrently` 는 트랜잭션 블록 안에서 거절되고, 여러 문장을 한
 * 질의로 보내도 pg 는 그것을 암묵 트랜잭션으로 묶어 같은 이유로 거절한다.
 *
 * 그 대가로 **원자성이 없다**: 중간에 죽으면 앞 문장만 남고 `schema_migrations` 에는 적히지 않아 다음 기동이
 * 처음부터 다시 돈다. 그래서 이 표지를 단 파일의 문장은 **다시 돌아도 같은 결과**여야 한다(`if not exists`·
 * `drop … if exists`). 특히 `concurrently` 로 만들다 실패한 인덱스는 INVALID 로 남고 `if not exists` 는 그것을
 * 「있다」고 본다 — 그래서 같은 이름을 먼저 `drop index concurrently if exists` 로 걷고 만든다.
 *
 * 문장은 줄 끝의 `;` 로 가른다. 함수 본문(`$$ … $$`)처럼 문장 안에 `;` 가 줄 끝에 오는 것은 이 표지와 같이 쓰지
 * 마라 — 그런 것은 보통 트랜잭션 파일에 둔다.
 */
export const NO_TRANSACTION_MARK = /^\s*--\s*migrate:\s*no-transaction\s*$/im;

/**
 * 트랜잭션 파일이 잠금을 기다리는 상한(2026-10-12). 이것이 없으면 `alter table`·인덱스 만들기가 앞선 긴 질의 뒤에서
 * 잠금을 기다리는 동안, **그 뒤에 줄 선 모든 쓰기**(옛 파드가 받는 요청)가 같이 선다. 5초 안에 못 잡으면 마이그레이션이
 * 실패하고 파드는 재시작 정책으로 다시 시도한다 — 서비스 전체가 멈추는 것보다 판올림이 한 번 늦는 쪽이 낫다.
 *
 * 트랜잭션 밖 파일(`concurrently`)에는 걸지 않는다: 그 문장은 쓰기를 막지 않고, 오래된 트랜잭션이 끝나기를
 * 기다리는 것 자체가 정상 동작이라 5초로 자르면 바쁜 DB 에서 매번 실패한다.
 */
export const MIGRATION_LOCK_TIMEOUT = '5s';

/** 다른 인스턴스가 마이그레이션 잠금을 쥐고 있을 때 다시 두드리는 간격. */
const LOCK_RETRY_MS = 250;

/** 트랜잭션 밖 파일을 문장으로 가른다 — 주석 줄은 버리고, 줄 끝 `;` 에서 끊는다. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line)) continue;
    cur.push(line);
    if (/;\s*$/.test(line)) {
      const stmt = cur.join('\n').trim();
      if (stmt !== ';') out.push(stmt);
      cur = [];
    }
  }
  const rest = cur.join('\n').trim();
  if (rest) out.push(rest);
  return out;
}

export async function runMigrations(pool: Pool): Promise<void> {
  // 롤링 업데이트에서 구·신 인스턴스가 같은 DB에 동시 부팅해도 한쪽만 실제로 적용하고,
  // 다른 쪽은 잠금을 기다렸다가 "이미 적용됨"을 보고 그냥 통과한다. 잠금은 세션 수준이라
  // 마이그레이션마다 커밋해도 유지된다.
  const client = await pool.connect();
  try {
    // 쿼리 시간 상한(`pool.ts` STATEMENT_TIMEOUT_MS)을 이 세션에서만 푼다. 큰 표의 색인 만들기·채우기는 30초를 넘을 수
    // 있고, 롤링 업데이트에서 다른 인스턴스의 마이그레이션을 기다리는 잠금 대기도 상한에 걸린다. 반납 전에 되돌린다.
    await client.query('set statement_timeout = 0');
    /**
     * `pg_advisory_lock` 으로 **막혀 기다리지 않는다**(2026-10-12). 막힌 `select` 는 스냅숏을 쥔 채 서 있고,
     * 잠금을 쥔 쪽이 `create index concurrently` 를 돌리면 그 문장은 **스냅숏을 쥔 모든 트랜잭션이 끝나기를**
     * 기다린다 — 서로를 기다리는 꼴이 된다(롤링 업데이트에서 두 파드가 같이 기동할 때). 짧은 `try` 를 되풀이하면
     * 두드리는 사이에는 스냅숏이 없다.
     */
    while (!(await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock($1) as ok', [MIGRATION_LOCK_KEY])).rows[0]!.ok) {
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
    await client.query(`create table if not exists schema_migrations (name text primary key)`);
    const dir = new URL('./migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const name of files) {
      const applied = await client.query('select 1 from schema_migrations where name = $1', [name]);
      if ((applied.rowCount ?? 0) > 0) continue;
      const sql = await readFile(new URL(name, dir), 'utf8');
      if (NO_TRANSACTION_MARK.test(sql)) {
        for (const stmt of splitStatements(sql)) await client.query(stmt);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        continue;
      }
      try {
        await client.query('begin');
        // `set local` — 커밋·롤백과 함께 풀린다. 위 advisory 잠금 두드리기에는 걸리지 않는다.
        await client.query(`set local lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    // 잠금 해제 실패로 원래 에러를 덮지 않는다. 커넥션을 반납하면 세션 잠금은 어차피 풀린다.
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    // 연결 시작 값(30초)으로 되돌린다 — 이 클라이언트는 풀로 돌아가 보통 요청을 받는다.
    await client.query('reset statement_timeout').catch(() => {});
    client.release();
  }
}

/**
 * 기동 때 마이그레이션 — DB 에 아직 닿지 못하면 **기다린다**(2026-10-12). Postgres 가 OOM 으로
 * 재시작하던 날 서버도 같이 재시작했는데, 그 서버가 다시 뜰 때 DB 는 아직 기동 중이었다.
 * 바로 죽으면 재시작 정책의 백오프(CrashLoopBackOff)가 쌓여 DB 가 돌아온 뒤에도 몇 분을 더 논다.
 *
 * 시한(기본 5분)을 넘기거나 DB 에 닿은 뒤의 실패(깨진 마이그레이션)는 그대로 던진다 — 그때는
 * 죽어서 재시작 정책에 넘기는 것이 맞다.
 */
export async function runMigrationsWhenReachable(
  pool: Pool, opts: { deadlineMs?: number; log?: (msg: string) => void } = {},
): Promise<void> {
  await retryWhileDbUnreachable(() => runMigrations(pool), {
    label: 'migrations', deadlineMs: opts.deadlineMs ?? 5 * 60_000, log: opts.log,
  });
}

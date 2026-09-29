import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 마이그레이션은 **expand/contract** 로 쓴다 — `docs/operations.md` §12.
 *
 * **왜:** 서버 배포는 롤링이다. 새 파드가 `runMigrations` 를 끝내고 ready 가 되는 동안
 * **옛 파드가 새 스키마 위에서 계속 요청을 받는다**(수 초~수십 초). 그 사이 옛 코드가
 * 읽고 쓰는 테이블·컬럼을 지우거나 이름을 바꾸거나 타입을 바꾸면, 배포 자체가 장애가 된다.
 * 그래서 한 릴리스의 마이그레이션은 **더하기만** 하고, 빼기(contract)는 옛 코드가 더는
 * 그것을 쓰지 않는 **다음 릴리스**로 넘긴다.
 *
 * 이 검사는 새 파일에서 옛 코드를 깨뜨리는 DDL 을 낱말로 잡는다. 정말 빼야 할 때(앞 릴리스에서
 * 코드가 이미 그것을 안 쓰게 됐을 때)는 파일에 `-- contract: <사유>` 한 줄을 적으면 통과한다 —
 * 사유가 리뷰에 남는 것이 목적이다.
 *
 * 낱말 검사라 완전하지 않다. 본문을 다시 쓰는 `update`(063 같은 것)나, 긴 쓰기 잠금을 잡는
 * 인덱스 생성은 잡지 않는다 — §12 에 적은 주의로 갈음한다.
 */

const MIGRATIONS = join(import.meta.dirname, '../src/db/migrations');

/**
 * 이 번호까지는 규칙 이전에 들어갔다(002·040·054·069 가 걸린다). 이미 모든 배포에 적용됐으므로
 * 다시 볼 이유가 없다. **올리지 마라** — 새 파일은 전부 이 검사를 받는다.
 */
const GRANDFATHERED_THROUGH = 78;

const CONTRACT_MARK = /^\s*--\s*contract:\s*\S/im;

type Rule = { name: string; test: (sql: string) => boolean };

const RULES: Rule[] = [
  { name: 'drop table', test: (s) => /\bdrop\s+table\b/.test(s) },
  { name: 'drop column', test: (s) => /\bdrop\s+column\b/.test(s) },
  { name: 'rename', test: (s) => /\brename\b/.test(s) },
  {
    name: 'alter column … type',
    test: (s) => /\balter\s+column\s+("[^"]+"|\w+)\s+(set\s+data\s+)?type\b/.test(s),
  },
  { name: 'set not null', test: (s) => /\bset\s+not\s+null\b/.test(s) },
  {
    // 옛 코드의 insert 는 새 컬럼을 모른다 — default 없이 not null 이면 그 insert 가 깨진다.
    name: 'add column … not null (default 없음)',
    test: (s) =>
      [...s.matchAll(/\badd\s+column\b([^;]*?)(?=,\s*(?:add|alter|drop)\b|;|$)/g)].some(
        (m) => { const c = m[1] ?? ''; return /\bnot\s+null\b/.test(c) && !/\b(default|generated)\b/.test(c); },
      ),
  },
];

/** 주석을 걷고 소문자로 — 주석 속 낱말(“drop column 은 다음 릴리스”)에 걸리지 않게. */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .toLowerCase();
}

function violations(sql: string): string[] {
  if (CONTRACT_MARK.test(sql)) return [];
  const s = normalize(sql);
  return RULES.filter((r) => r.test(s)).map((r) => r.name);
}

describe('migrations are expand-only (rolling deploy)', () => {
  it('new migrations do not break the previous release', () => {
    const offenders = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && Number.parseInt(f, 10) > GRANDFATHERED_THROUGH)
      .map((f) => ({ f, v: violations(readFileSync(join(MIGRATIONS, f), 'utf8')) }))
      .filter(({ v }) => v.length > 0)
      .map(({ f, v }) => `${f}: ${v.join(', ')}`);
    expect(
      offenders,
      '롤링 배포 중 옛 파드가 새 스키마에서 돈다 — 빼기는 다음 릴리스로 미루거나, ' +
        '옛 코드가 이미 안 쓴다면 `-- contract: <사유>` 를 적어라 (docs/operations.md §12)',
    ).toEqual([]);
  });

  // 검사기가 조용히 아무것도 못 잡게 되면 위 단언은 영원히 초록이다 — 규칙 이전 파일로 잰다.
  it('the detector still catches the known pre-rule contractions', () => {
    const read = (f: string) => violations(readFileSync(join(MIGRATIONS, f), 'utf8'));
    expect(read('002_idempotency_scope.sql')).toContain('set not null');
    expect(read('040_drop_thread_projection.sql')).toContain('drop table');
    expect(read('054_drop_agent_execution_path.sql')).toContain('drop column');
  });

  it.each([
    ['alter table t add column c text not null default \'\';', []],
    ['alter table t add column c text;', []],
    ['alter table t add column c text not null;', ['add column … not null (default 없음)']],
    ['alter table t add column a int, add column b int not null;', ['add column … not null (default 없음)']],
    ['alter table t alter column c type bigint;', ['alter column … type']],
    ['alter table t rename column a to b;', ['rename']],
    ['alter table t drop column if exists c;', ['drop column']],
    ['drop index if exists i; alter table t drop constraint k;', []],
    ['-- drop column c 는 다음 릴리스에서\nalter table t add column d int;', []],
    ['-- contract: 0.3.40 부터 c 를 안 읽는다\nalter table t drop column c;', []],
  ])('%s', (sql, expected) => {
    expect(violations(sql)).toEqual(expected);
  });
});

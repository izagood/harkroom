import type { Pool } from 'pg';

// 두 한도의 정본은 `@harkroom/shared` 다 — 설정 화면이 같은 값을 그려야 하는데
// 데스크탑은 이 패키지를 import 할 수 없다. 여기서는 다시 내보내기만 한다.
import {
  MAX_CORE_MEMORY_LENGTH, MAX_JOURNAL_MEMORIES_PER_ACCOUNT, MAX_MEMORY_DESCRIPTION_LENGTH, MAX_MEMORY_ITEMS_PER_ACCOUNT,
  MAX_MEMORY_VALUE_LENGTH, MEMORY_KINDS, type MemoryKind,
} from '@harkroom/shared';

export {
  MAX_CORE_MEMORY_LENGTH, MAX_JOURNAL_MEMORIES_PER_ACCOUNT, MAX_MEMORY_DESCRIPTION_LENGTH, MAX_MEMORY_ITEMS_PER_ACCOUNT,
  MAX_MEMORY_VALUE_LENGTH, MEMORY_KINDS, type MemoryKind,
};

/** slug 마다 남기는 이전 판 수(069). 되돌릴 길이면 되고, 역사서가 아니다. */
export const MAX_MEMORY_REVISIONS_PER_SLUG = 5;

export interface MemoryEntry {
  slug: string;
  value: string;
  updatedAt: Date;
  description: string | null;
  createdAt: Date;
  readCount: number;
  lastReadAt: Date | null;
  kind: MemoryKind;
}

const ENTRY_COLUMNS = `slug, value, updated_at as "updatedAt", description, created_at as "createdAt",
  read_count as "readCount", last_read_at as "lastReadAt", kind`;

/** 목록 한 줄 — 러너가 턴 프롬프트의 `<memory-index>` 에 싣는다(본문은 없다). */
export interface MemoryIndexEntry {
  slug: string;
  description: string | null;
  kind: MemoryKind;
}

export async function listMemoryIndex(pool: Pool, accountId: string): Promise<MemoryIndexEntry[]> {
  const res = await pool.query(
    `select slug, description, kind from agent_memory where account_id = $1 order by slug`,
    [accountId],
  );
  return res.rows as MemoryIndexEntry[];
}

/**
 * `not_found` 가 없는 이유: 삭제는 **멱등**이다. inbox 는 at-least-once 라 같은 지시가
 * 두 번 처리될 수 있고, 그때 재삭제가 에러로 오면 성공한 작업이 실패로 기록된다.
 * "없는 것을 지웠다" 는 호출자가 원한 상태에 도달한 것이므로 `ok` 다.
 */
export type MemoryResult = 'ok' | 'too_many';

export async function listMemory(pool: Pool, accountId: string): Promise<string[]> {
  const res = await pool.query(
    `select slug from agent_memory where account_id = $1 order by slug`,
    [accountId],
  );
  return res.rows.map((r) => r.slug as string);
}

/**
 * 이 계정 메모리 전체의 **판본**. 러너가 들고 있는 사본이 아직 맞는지 왕복 없이 가리는 값이다
 * (러너 메모리 캐시, 2026-09-28). 러너는 이 값이 자기 사본과 같으면 `memory.get` 을 부르지 않는다.
 *
 * 열(`rev`)을 새로 두지 않고 **있는 것에서 계산한다** — 마이그레이션 없이 들어가고, 쓰기 경로가
 * 판본을 올리는 것을 잊을 자리가 아예 없다. 재료는 `(slug, updated_at)` 이다:
 * - 추가·수정은 `updated_at = now()` 로 그 행의 값을 바꾼다.
 * - 삭제는 그 행이 목록에서 빠진다.
 * 그래서 어느 쪽이든 해시가 바뀐다. 본문을 해시하지 않는 이유: 200행×8,000자를 폴마다
 * 읽을 까닭이 없다 — 본문이 바뀌면 `updated_at` 도 반드시 바뀐다.
 *
 * 빈 저장소는 `'empty'` 다(`string_agg` 가 null 을 낸다). null 을 내면 "판본을 모르는 옛
 * 서버"와 구분되지 않는다.
 */
export async function memoryRev(pool: Pool, accountId: string): Promise<string> {
  const res = await pool.query(
    `select coalesce(
       md5(string_agg(slug || ':' || (extract(epoch from updated_at) * 1000000)::bigint, ',' order by slug)),
       'empty') as rev
     from agent_memory where account_id = $1`,
    [accountId],
  );
  return res.rows[0].rev as string;
}

export async function getMemory(
  pool: Pool, accountId: string, slug: string,
): Promise<MemoryEntry | null> {
  const res = await pool.query(
    `select ${ENTRY_COLUMNS} from agent_memory where account_id = $1 and slug = $2`,
    [accountId, slug],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as MemoryEntry;
}

/**
 * 에이전트가 **읽었다**는 사실을 남기며 읽는다(069). 정리의 근거가 이것이다 — 무엇이 안
 * 읽히는지 모르면 무엇을 지울지도 모른다. `updated_at` 은 건드리지 않는다: 읽기가 판본
 * (`memoryRev`)을 바꾸면 러너 캐시가 읽을 때마다 무효가 된다.
 */
export async function readMemoryCounted(
  pool: Pool, accountId: string, slug: string,
): Promise<MemoryEntry | null> {
  const res = await pool.query(
    `update agent_memory set read_count = read_count + 1, last_read_at = now()
     where account_id = $1 and slug = $2
     returning ${ENTRY_COLUMNS}`,
    [accountId, slug],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as MemoryEntry;
}

/**
 * 사람이 보는 화면용 — slug 와 **값을 함께** 낸다(#139 3단계).
 *
 * `listMemory` 는 slug 만 준다. 그건 에이전트 주입 경로의 요구다(본문까지 주면 축적이
 * 곧 컨텍스트 고갈이 된다). 사람이 보는 화면은 값을 봐야 하는데, slug 마다
 * `getMemory` 를 부르면 N+1 이 된다 — 한 질의로 낸다.
 */
export async function listMemoryEntries(pool: Pool, accountId: string): Promise<MemoryEntry[]> {
  const res = await pool.query(
    `select ${ENTRY_COLUMNS} from agent_memory where account_id = $1 order by slug`,
    [accountId],
  );
  return res.rows as MemoryEntry[];
}

/** slug 하나를 지운다. 없는 것을 지워도 성공이다 — setMemory 의 멱등 규칙과 같다. */
export async function deleteMemory(pool: Pool, accountId: string, slug: string): Promise<void> {
  await deleteWithRevision(pool, accountId, slug);
}

/** 지우기 전 본문을 이전 판으로 남기고 지운다 — 사람이 지워도, 에이전트가 지워도 되돌릴 수 있다. */
async function deleteWithRevision(pool: Pool, accountId: string, slug: string): Promise<void> {
  await pool.query(
    `with d as (
       delete from agent_memory where account_id = $1 and slug = $2
       returning slug, value, description, updated_at)
     insert into agent_memory_revision (account_id, slug, value, description, updated_at)
     select $1, slug, value, description, updated_at from d`,
    [accountId, slug],
  );
  await pruneRevisions(pool, accountId, slug);
}

async function pruneRevisions(pool: Pool, accountId: string, slug: string): Promise<void> {
  await pool.query(
    `delete from agent_memory_revision
     where account_id = $1 and slug = $2 and id not in (
       select id from agent_memory_revision where account_id = $1 and slug = $2
       order by replaced_at desc, id desc limit $3)`,
    [accountId, slug, MAX_MEMORY_REVISIONS_PER_SLUG],
  );
}

/**
 * `description` 은 **세 상태**다: `undefined` 면 있던 요약을 그대로 두고(요약 없이 본문만
 * 고치는 호출이 요약을 지우면 안 된다), 문자열이면 바꾸고, 빈 문자열이면 지운다.
 */
export async function setMemory(
  pool: Pool, accountId: string, slug: string, value: string | null, description?: string, kind?: MemoryKind,
): Promise<MemoryResult> {
  if (value === null) {
    // 없는 것을 지워도 성공이다 — 위 MemoryResult 주석의 이유.
    await deleteWithRevision(pool, accountId, slug);
    return 'ok';
  }

  // 한도 검사와 삽입을 **한 문장**으로 한다. 세 왕복(존재 확인 → 개수 → 삽입)으로 하면
  // 같은 계정의 동시 호출 둘이 모두 199 를 보고 201 이 된다.
  //
  // `exists(...)` 절이 있는 이유: **기존 항목을 고치는 것은 한도에 걸리지 않아야 한다.**
  // 한도는 항목이 늘어나는 것을 막으려는 것이고, 200개에 도달한 에이전트가 자기 메모리를
  // 수정조차 못 하게 되면 저장소가 잠긴다.
  //
  // 이전 판(069)도 **같은 문장**에서 남긴다. 따로 하면 두 쓰기 사이에 다른 턴이 끼어 엉뚱한
  // 본문을 "이전 판"으로 적는다. `prev` 는 문장 시작 시점의 스냅숏이라 덮어쓰기 전 값이다.
  const res = await pool.query(
    `with prev as (
       select slug, value, description, updated_at from agent_memory where account_id = $1 and slug = $2),
     ins as (
       insert into agent_memory (account_id, slug, value, description, kind)
       select $1, $2, $3, nullif($5, ''), coalesce($7, 'topic')
       where (select count(*) from agent_memory where account_id = $1) < $4
          or exists (select 1 from prev)
       on conflict (account_id, slug) do update set
         value = excluded.value,
         description = case when $6 then excluded.description else agent_memory.description end,
         kind = coalesce($7, agent_memory.kind),
         updated_at = now()
       returning 1),
     rev as (
       insert into agent_memory_revision (account_id, slug, value, description, updated_at)
       select $1, slug, value, description, updated_at from prev where exists (select 1 from ins)
       returning 1)
     select (select count(*) from ins)::int as n`,
    [accountId, slug, value, MAX_MEMORY_ITEMS_PER_ACCOUNT, description ?? null, description !== undefined, kind ?? null],
  );
  // 행이 안 들어갔다는 것은 where 절이 걸렀다는 뜻이고, 그 조건은 한도뿐이다.
  if (!res.rows[0].n) return 'too_many';
  await pruneRevisions(pool, accountId, slug);
  await pruneJournal(pool, accountId);
  return 'ok';
}

/**
 * journal 을 최근 것 `MAX_JOURNAL_MEMORIES_PER_ACCOUNT` 개로 자른다(070). 넘친 것은 **이전 판으로
 * 옮기며** 지운다 — 경위 기록은 PR 본문이 갖는 서사라 버려도 되지만, 되돌릴 길은 남긴다.
 * 쓰기마다 부르지만 넘치지 않으면 지울 행이 없어 값싸다.
 */
async function pruneJournal(pool: Pool, accountId: string): Promise<void> {
  await pool.query(
    `with d as (
       delete from agent_memory where account_id = $1 and kind = 'journal' and slug in (
         select slug from agent_memory where account_id = $1 and kind = 'journal'
         order by updated_at desc, slug offset $2)
       returning slug, value, description, updated_at)
     insert into agent_memory_revision (account_id, slug, value, description, updated_at)
     select $1, slug, value, description, updated_at from d`,
    [accountId, MAX_JOURNAL_MEMORIES_PER_ACCOUNT],
  );
}

export interface MemorySearchHit {
  slug: string;
  description: string | null;
  kind: MemoryKind;
  score: number;
  value?: string;
}

/** 한국어 조사가 붙은 낱말도 걸리게 끝의 흔한 조사를 떼어 본다(형태소 분석기 없이 싼 근사). */
const PARTICLES = ['에서', '으로', '에게', '까지', '부터', '처럼', '은', '는', '이', '가', '을', '를', '에', '의', '로', '도', '만', '와', '과'];

export function searchTerms(query: string): string[] {
  const out = new Set<string>();
  for (const raw of query.toLowerCase().split(/[\s,.;:!?()[\]{}"'`<>@#|/\\*~=+]+/u)) {
    let t = raw.trim();
    if (t.length < 2) continue;
    if (/[\uAC00-\uD7A3]$/u.test(t)) {
      const p = PARTICLES.find((x) => t.endsWith(x) && t.length - x.length >= 2);
      if (p) t = t.slice(0, -p.length);
    }
    out.add(t);
    if (out.size >= 12) break;
  }
  return [...out];
}

/**
 * 기억 검색(070). 목록에 안 실리는 journal 을 찾는 길이자, 러너가 요청 본문으로 관련 기억을
 * 골라 주입하는 길이다. 에이전트당 200행이 상한이라 전문 색인 없이 부분 일치 점수로 충분하다
 * — 이름·요약에 걸리면 3점, 본문에 걸리면 1점. `core` 는 매 턴 실리므로 뺀다.
 */
export async function searchMemory(
  pool: Pool, accountId: string, query: string, opts: { limit: number; includeValue: boolean },
): Promise<MemorySearchHit[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const patterns = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const res = await pool.query(
    `select slug, description, kind, ${opts.includeValue ? 'value,' : ''}
       (select coalesce(sum(
          case when lower(m.slug) like p or lower(coalesce(m.description, '')) like p then 3 else 0 end
          + case when lower(m.value) like p then 1 else 0 end), 0)
        from unnest($2::text[]) as p)::int as score
     from agent_memory m
     where account_id = $1 and slug <> 'core'
     order by score desc, updated_at desc
     limit $3`,
    [accountId, patterns, opts.limit],
  );
  return (res.rows as MemorySearchHit[]).filter((r) => r.score > 0);
}

export interface MemoryRevision {
  value: string;
  description: string | null;
  updatedAt: Date;
  replacedAt: Date;
}

/** slug 의 이전 판, 최근 것부터. 사람이 보는 화면과 정리 턴이 되돌릴 때 쓴다. */
export async function listMemoryRevisions(
  pool: Pool, accountId: string, slug: string,
): Promise<MemoryRevision[]> {
  const res = await pool.query(
    `select value, description, updated_at as "updatedAt", replaced_at as "replacedAt"
     from agent_memory_revision where account_id = $1 and slug = $2
     order by replaced_at desc, id desc`,
    [accountId, slug],
  );
  return res.rows as MemoryRevision[];
}

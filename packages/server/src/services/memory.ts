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
  /** 쓰기 검사(080)에 걸린 판이면 그 시각과 이유. 사람이 확인할 때까지 프롬프트에 싣지 않는다. */
  flaggedAt: Date | null;
  flagReason: string | null;
}

const ENTRY_COLUMNS = `slug, value, updated_at as "updatedAt", description, created_at as "createdAt",
  read_count as "readCount", last_read_at as "lastReadAt", kind,
  flagged_at as "flaggedAt", flag_reason as "flagReason"`;

/** 목록 한 줄 — 러너가 턴 프롬프트의 `<memory-index>` 에 싣는다(본문은 없다). */
export interface MemoryIndexEntry {
  slug: string;
  description: string | null;
  kind: MemoryKind;
}

export async function listMemoryIndex(pool: Pool, accountId: string): Promise<MemoryIndexEntry[]> {
  const res = await pool.query(
    // 걸린 판(080)의 요약은 싣지 않는다 — 요약도 에이전트가 쓴 글이라 검사 대상이다.
    `select slug, case when flagged_at is null then description end as description, kind
     from agent_memory where account_id = $1 order by slug`,
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
       returning slug, value, description, updated_at, flagged_at)
     insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged)
     select $1, slug, value, description, updated_at, flagged_at is not null from d`,
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
/**
 * 낙관적 동시성(메모리 고도화 M3). `memory.get` 이 준 `updatedAt` 을 그대로 돌려주면 "그 사이
 * 누가 고쳤으면 쓰지 마라"가 된다. `null` 은 "아직 없어야 한다"(새로 만들기)다.
 *
 * 왜 필요한가: 같은 에이전트의 멘션 턴이 병렬로 돈다. 둘이 core 를 읽고 각자 고쳐 쓰면 나중
 * 쓰기가 앞 것을 **조용히** 지운다(2026-09-09 감사에서 예고했고, 기억을 자주 고치라고 말한 뒤로
 * 실제로 일어날 수 있는 일이 됐다). 생략하면 예전처럼 무조건 쓴다 — 옛 호출을 깨지 않는다.
 */
export interface MemoryExpectation {
  updatedAt: Date | null;
}

/** 기대가 어긋났다 — 지금 값의 시각을 준다(없으면 null). 호출자는 다시 읽고 합쳐 쓴다. */
export interface MemoryConflict {
  conflict: { updatedAt: Date | null };
}

/** DB 는 µs 까지 갖고 JSON 은 ms 까지 준다 — 비교는 ms 로 자른 값끼리 한다. */
const MS_EQ = `date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $EXPECT::timestamptz)`;

async function currentUpdatedAt(pool: Pool, accountId: string, slug: string): Promise<Date | null> {
  const r = await pool.query(
    `select updated_at from agent_memory where account_id = $1 and slug = $2`, [accountId, slug],
  );
  return r.rowCount ? (r.rows[0].updated_at as Date) : null;
}

/**
 * `flagReason` 은 쓰기 검사(080) 결과다. 문자열이면 이 판을 **걸린 판**으로 저장하고, 생략하거나
 * null 이면 깨끗한 판이다 — 걸렸던 기억을 깨끗하게 다시 쓰면 표시가 풀린다(걸린 판은 이전 판에
 * `flagged` 로 남는다). 사람이 고치는 길(route)은 검사하지 않는다: 사람이 쓴 것이 곧 확인이다.
 */
export async function setMemory(
  pool: Pool, accountId: string, slug: string, value: string | null, description?: string, kind?: MemoryKind,
  expect?: MemoryExpectation, flagReason?: string | null,
): Promise<MemoryResult | MemoryConflict> {
  if (value === null) {
    if (expect) {
      // 기대한 판일 때만 지운다. "없어야 한다"를 기대하며 지우는 것은 할 일이 없다 — 있으면 충돌.
      if (expect.updatedAt === null) {
        const now = await currentUpdatedAt(pool, accountId, slug);
        return now === null ? 'ok' : { conflict: { updatedAt: now } };
      }
      const d = await pool.query(
        `with d as (
           delete from agent_memory where account_id = $1 and slug = $2 and ${MS_EQ.replace('$EXPECT', '$3')}
           returning slug, value, description, updated_at, flagged_at)
         insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged)
         select $1, slug, value, description, updated_at, flagged_at is not null from d returning 1`,
        [accountId, slug, expect.updatedAt],
      );
      if (d.rowCount) {
        await pruneRevisions(pool, accountId, slug);
        return 'ok';
      }
      const now = await currentUpdatedAt(pool, accountId, slug);
      return now === null ? 'ok' : { conflict: { updatedAt: now } };
    }
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
       select slug, value, description, updated_at, flagged_at from agent_memory where account_id = $1 and slug = $2),
     ins as (
       insert into agent_memory (account_id, slug, value, description, kind, flagged_at, flag_reason)
       select $1, $2, $3, nullif($5, ''), coalesce($7, 'topic'), case when $10::text is null then null else now() end, $10::text
       where ((select count(*) from agent_memory where account_id = $1) < $4
          or exists (select 1 from prev))
         -- 기대가 있으면: 새로 만들기는 "기대가 null" 일 때만.
         and ($8 = 'none' or ($8 = 'absent' and not exists (select 1 from prev)) or ($8 = 'at' and exists (select 1 from prev)))
       on conflict (account_id, slug) do update set
         value = excluded.value,
         description = case when $6 then excluded.description else agent_memory.description end,
         kind = coalesce($7, agent_memory.kind),
         flagged_at = excluded.flagged_at,
         flag_reason = excluded.flag_reason,
         updated_at = now()
       -- **판 비교는 여기서 한다.** DO UPDATE 의 WHERE 는 잠근 뒤의 최신 행으로 다시 평가되므로,
       -- 두 턴이 같은 판을 들고 동시에 와도 한쪽만 통과한다(prev 스냅숏으로 비교하면 둘 다 통과).
       where $8 = 'none'
          or ($8 = 'at' and date_trunc('milliseconds', agent_memory.updated_at) = date_trunc('milliseconds', $9::timestamptz))
       returning 1),
     rev as (
       insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged)
       select $1, slug, value, description, updated_at, flagged_at is not null from prev where exists (select 1 from ins)
       returning 1)
     select (select count(*) from ins)::int as n`,
    [
      accountId, slug, value, MAX_MEMORY_ITEMS_PER_ACCOUNT, description ?? null, description !== undefined, kind ?? null,
      !expect ? 'none' : expect.updatedAt === null ? 'absent' : 'at', expect?.updatedAt ?? null,
      flagReason ?? null,
    ],
  );
  if (!res.rows[0].n) {
    // 기대가 없으면 걸러진 이유는 한도뿐이다. 기대가 있으면 지금 값과 대 봐서 가른다.
    if (expect) {
      const now = await currentUpdatedAt(pool, accountId, slug);
      const matches = expect.updatedAt === null
        ? now === null
        : now !== null && Math.floor(now.getTime()) === Math.floor(expect.updatedAt.getTime());
      if (!matches) return { conflict: { updatedAt: now } };
    }
    return 'too_many';
  }
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
       returning slug, value, description, updated_at, flagged_at)
     insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged)
     select $1, slug, value, description, updated_at, flagged_at is not null from d`,
    [accountId, MAX_JOURNAL_MEMORIES_PER_ACCOUNT],
  );
}

export interface MemorySearchHit {
  slug: string;
  description: string | null;
  kind: MemoryKind;
  score: number;
  value?: string;
  /** recall 모드만: 이름·요약에 걸린 낱말 수. 러너가 이 값이 있으면 새 서버로 알아본다. */
  nameHits?: number;
  /** recall 모드만: 그 판의 시각. 러너가 `slug@updatedAt` 으로 "이 판을 이미 실었나"를 가른다(F6). */
  updatedAt?: string;
}

/** 한국어 조사가 붙은 낱말도 걸리게 끝의 흔한 조사를 떼어 본다(형태소 분석기 없이 싼 근사). */
const PARTICLES = ['에서', '으로', '에게', '까지', '부터', '처럼', '은', '는', '이', '가', '을', '를', '에', '의', '로', '도', '만', '와', '과'];

/**
 * 활용 어미(recall P1, 2026-09-30). "조사해 달라"의 `조사해` 는 `%조사해%` 로 찾으니 기억의
 * "조사" 에 안 걸렸다(감사 ⑤ — 활용형은 안 걸림). 긴 것부터 떼고, 어간이 두 글자 이상 남을
 * 때만 뗀다 — `권한`·`제한` 같은 명사의 끝 `한` 을 어미로 보고 한 글자로 만들지 않으려고.
 * 뗀 어간은 `%어간%` 부분 일치라 곧 "어간 앞부분 맞추기" 다.
 */
const ENDINGS = [
  '해야해', '해야지', '해야겠', '했습니다', '합니다', '해주세요', '해달라', '해줘', '해라', '해서', '해야', '해도', '했다', '했고', '했는', '했던',
  '하고', '하다', '한다', '하는', '하면', '하지', '하게', '하려', '된다', '됐다', '되는', '되어', '되면',
  '해', '했', '할', '한', '돼', '됨',
];

/**
 * 러너 recall 에서만 거르는 상투어. 요청문마다 붙어 다니는 말이라 본문 1점이 쌓여 아무 기억이나
 * 끌어올렸다(감사 ⑤ (b)). 사람 이름은 여기 적지 않는다 — 계정 표에서 읽는다
 * (`recallExcludedNames`). 에이전트가 직접 부르는 `memory.search` 에는 걸지 않는다: 거기서
 * "jaebin" 을 찾으면 찾아져야 한다.
 */
export const RECALL_STOPWORDS: ReadonlySet<string> = new Set([
  // 요청의 틀
  '지시', '경유', '요청', '부탁', '착수', '진행', '확인', '보고', '답변', '방식',
  '스레드', '채널', '메시지', '에이전트', '사람', '이번', '지금', '다음', '먼저', '그리고', '그러니', '그래서',
  '어떻게', '무엇', '여기', '거기', '이것', '그것', '해당', '관련', '내용', '부분', '경우', '정도', '이상', '이하',
  '달라', '주세요', '있다', '없다', '같다', '한다', '된다', '했다', '위해', '대해', '대한', '통해',
  // 말버릇·활용 조각(qa 측정 ④, 09-30) — 12자리를 채우던 것들
  '이거', '이걸', '너가', '내가', '말고', '아니', '있는', '하는', '하고', '하면', '않아', '같아', '때도', '보면',
  '원문', '첨부', '계획', '수정', '원인', '분석',
  // 영어·주소 조각
  'task', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'message', 'thread', 'channel', 'please', 'http', 'https',
  'png', 'jpg', 'id', 'v0',
]);

/**
 * 비밀값처럼 생긴 조각(초대 토큰 `hrki_…`·API 키). 요청 낱말은 러너 로그(`terms=`)에 남으므로
 * recall 낱말로 받지 않는다(qa 리뷰 ③) — 기억 이름에 20자 넘는 영숫자 덩어리가 걸릴 일도 없다.
 */
const SECRET_LIKE = /^[a-z0-9_-]{20,}$/u;

/** 3자 이하 ASCII 낱말(`ui`·`pr`)은 부분 일치하면 `progress`·`mcp-ui-…` 에 걸린다 — 경계에서만 맞춘다. */
const SHORT_ASCII = /^[a-z0-9]{1,3}$/u;
function termMatcher(t: string): (hay: string) => number {
  if (!SHORT_ASCII.test(t)) return (hay) => countOccurrences(hay, t);
  const re = new RegExp(`(?<![a-z0-9])${t}(?![a-z0-9])`, 'gu');
  return (hay) => Math.min(50, hay.match(re)?.length ?? 0);
}

/** 떼어 낸 낱말 하나. 기호로 가르고, 조사·어미를 한 번씩 떼어 본다. */
function normalizeTerm(raw: string): string | null {
  let t = raw.trim();
  if (t.length < 2) return null;
  if (/[가-힣]$/u.test(t)) {
    const p = PARTICLES.find((x) => t.endsWith(x) && t.length - x.length >= 2);
    if (p) t = t.slice(0, -p.length);
    const e = ENDINGS.find((x) => t.endsWith(x) && t.length - x.length >= 2);
    if (e) t = t.slice(0, -e.length);
  }
  return t;
}

export function searchTerms(query: string, opts: { exclude?: ReadonlySet<string> } = {}): string[] {
  const out = new Set<string>();
  const exclude = opts.exclude;
  // recall 모드: `@handle` 과 주소는 통째로 지운다 — 부른 사람·부름받은 이름은 요청의 뜻이 아니다.
  const text = exclude
    ? query.toLowerCase().replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gu, ' ').replace(/@[\p{L}\p{N}_.-]+/gu, ' ')
      .replace(/\[첨부:[^\]]*\]/gu, ' ')
    : query.toLowerCase();
  for (const raw of text.split(/[\s,.;:!?()[\]{}"'`<>@#|/\\*~=+]+/u)) {
    const t = normalizeTerm(raw);
    if (!t) continue;
    // 필터를 **먼저** 건다 — 12개 상한을 상투어가 채우면 정작 요청의 낱말이 빠진다(감사 ⑤).
    if (exclude) {
      if (exclude.has(t) || RECALL_STOPWORDS.has(t)) continue;
      if (/^[0-9a-f-]{8,}$/u.test(t) || /^\d{1,2}$/u.test(t)) continue; // id 조각·작은 숫자
      if (SECRET_LIKE.test(t) || !/[\p{L}\p{N}]/u.test(t)) continue; // 비밀값·`---` 같은 기호 덩어리
    }
    out.add(t);
    if (out.size >= 12) break;
  }
  return [...out];
}

/**
 * recall 에서 뺄 이름 — **사람 계정만**(지워지지 않은 것), handle·표시 이름 통째와 낱말로 편 조각까지.
 * 요청문의 "jaebin 결정" 같은 사람 이름이 기억 본문에 흔해서 recall 을 오염시켰다(감사 ⑤ (a)).
 * 이름은 바뀌므로 표에서 읽는다.
 *
 * 에이전트·팀 이름은 빼지 않는다(qa 리뷰 ①, 09-30). `forge`·`rcms`·`homelab` 처럼 에이전트 이름이
 * 곧 그 에이전트가 맡은 주제어라, 통째로만 빼도 `rcms 부가 서비스 forge 이관` 이 `[]` 가 됐다.
 * 부른 이름은 `@멘션` 지우기가 이미 없애고, 러너 질의는 발화 본문이라 `이름:` 머리도 없다. 본문에
 * 맨이름(`task_manager`)이 섞여도 이름·요약에 걸려야만 싣는 규칙이 거른다.
 */
export async function recallExcludedNames(pool: Pool): Promise<Set<string>> {
  const res = await pool.query(
    `select handle, display_name, kind from account where deleted_at is null and kind = 'human'`,
  );
  return excludedNamesFrom(res.rows as { handle: string; display_name: string | null; kind: string }[]);
}

export function excludedNamesFrom(rows: { handle: string; display_name: string | null; kind: string }[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'human') continue;
    for (const name of [r.handle, r.display_name ?? '']) {
      const low = name.toLowerCase().trim();
      if (low.length >= 2) out.add(low);
      for (const part of low.split(/[\s_.-]+/u)) if (part.length >= 2) out.add(part);
    }
  }
  return out;
}

export interface RecallCandidate {
  slug: string;
  description: string | null;
  kind: MemoryKind;
  value: string;
  updatedAt: Date;
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < 50; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * recall 순위(P1). 순수 함수라 pg 없이 정답 세트(fixture)로 잰다.
 * - 이름·요약에 걸린 낱말이 **하나도 없으면 싣지 않는다** — 본문 1점만 쌓인 것은 상투어였다.
 * - journal 은 뺀다 — 한 작업의 경위라 요청 낱말(PR·기능 이름)에 잘 걸리지만 교훈은 주제 기억에
 *   증류돼 있다. 경위가 필요하면 에이전트가 `memory.search` 로 직접 찾는다.
 * - 점수 = 이름·요약 3 + 본문 1(낱말당, 전과 같다). 동점은 이름 일치 수 → 본문 출현 수 → slug.
 *   전에는 동점을 최근 수정 순으로 갈라, 같은 짝이 세션마다 실렸다(감사 ⑤).
 */
export function rankRecall(terms: string[], rows: RecallCandidate[], limit: number): (MemorySearchHit & { nameHits: number })[] {
  const scored = [];
  for (const r of rows) {
    // 이름이 journal 인데 kind 가 topic 으로 남은 행(`mem/journal/e2cc9c57`)도 journal 로 본다.
    if (r.slug === 'core' || r.kind === 'journal' || r.slug.startsWith('mem/journal/')) continue;
    const name = `${r.slug.toLowerCase()}\n${(r.description ?? '').toLowerCase()}`;
    const body = r.value.toLowerCase();
    let nameHits = 0; let bodyHits = 0; let occurrences = 0;
    for (const t of terms) {
      const count = termMatcher(t);
      if (count(name)) nameHits++;
      const c = count(body);
      if (c) { bodyHits++; occurrences += c; }
    }
    if (!nameHits) continue;
    scored.push({ r, nameHits, score: nameHits * 3 + bodyHits, occurrences });
  }
  scored.sort((a, b) => b.score - a.score || b.nameHits - a.nameHits || b.occurrences - a.occurrences
    || (a.r.slug < b.r.slug ? -1 : a.r.slug > b.r.slug ? 1 : 0));
  return scored.slice(0, limit).map(({ r, nameHits, score }) => ({
    slug: r.slug, description: r.description, kind: r.kind, score, nameHits, value: r.value,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * 기억 검색(070). 목록에 안 실리는 journal 을 찾는 길이자, 러너가 요청 본문으로 관련 기억을
 * 골라 주입하는 길이다. 에이전트당 200행이 상한이라 전문 색인 없이 부분 일치 점수로 충분하다
 * — 이름·요약에 걸리면 3점, 본문에 걸리면 1점. `core` 는 매 턴 실리므로 뺀다.
 *
 * `recall: true` 는 러너 자동 주입용이다(P1): 이름·상투어를 거른 낱말로, 이름·요약에 걸린
 * 것만, journal 빼고, 일치 수로 동점을 가른다(`rankRecall`). 쓴 낱말(`terms`)을 같이 돌려줘
 * 러너가 로그 한 줄로 남긴다.
 */
export async function searchMemory(
  pool: Pool, accountId: string, query: string,
  opts: { limit: number; includeValue: boolean; recall?: boolean; exclude?: string[]; recordTop?: number },
): Promise<{ hits: MemorySearchHit[]; terms: string[] }> {
  if (opts.recall) {
    const terms = searchTerms(query, { exclude: await recallExcludedNames(pool) });
    if (!terms.length) return { hits: [], terms };
    const patterns = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    // 이름·요약에 걸린 행만 가져온다 — 본문은 그 몇 행만 JS 로 센다.
    const res = await pool.query(
      `select slug, description, kind, value, updated_at as "updatedAt" from agent_memory m
       where account_id = $1 and slug <> 'core' and kind <> 'journal' and flagged_at is null
         and exists (select 1 from unnest($2::text[]) as p
                     where lower(m.slug) like p or lower(coalesce(m.description, '')) like p)`,
      [accountId, patterns],
    );
    const skip = new Set(opts.exclude ?? []);
    const rows = (res.rows as RecallCandidate[]).filter((r) => !isExcluded(skip, r.slug, r.updatedAt));
    const hits = rankRecall(terms, rows, opts.limit)
      .map((h) => (opts.includeValue ? h : { ...h, value: undefined }));
    if (opts.recordTop) await recordRecall(pool, accountId, hits.slice(0, opts.recordTop).map((h) => h.slug));
    return { hits, terms };
  }
  const terms = searchTerms(query);
  if (!terms.length) return { hits: [], terms };
  const patterns = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const res = await pool.query(
    `select slug, description, kind, ${opts.includeValue ? 'value,' : ''}
       (select coalesce(sum(
          case when lower(m.slug) like p or lower(coalesce(m.description, '')) like p then 3 else 0 end
          + case when lower(m.value) like p then 1 else 0 end), 0)
        from unnest($2::text[]) as p)::int as score
     from agent_memory m
     where account_id = $1 and slug <> 'core' and flagged_at is null
     order by score desc, updated_at desc
     limit $3`,
    [accountId, patterns, opts.limit],
  );
  return { hits: (res.rows as MemorySearchHit[]).filter((r) => r.score > 0), terms };
}

/**
 * 이 세션에 이미 실은 판인가(F6). 키는 `slug@updatedAt`(ISO) — 세션 도중 **고쳐진** 기억은 다시 싣는다.
 * 맨 slug 키는 옛 러너의 고정 파일에서 온 것이라 판과 무관하게 뺀다(그 세션이 끝나면 사라진다).
 */
function isExcluded(skip: Set<string>, slug: string, updatedAt: Date): boolean {
  return skip.has(slug) || skip.has(`${slug}@${updatedAt.toISOString()}`);
}

/**
 * 러너가 턴 프롬프트에 실은 기억을 센다(F1, 096). recall 은 러너가 고르므로 서버는 러너가
 * `recordTop` 으로 "앞 몇 개를 싣는다"고 말한 것만 센다 — 돌려준 후보 전부를 세면 안 실린 것까지 쓰인 것이 된다.
 */
async function recordRecall(pool: Pool, accountId: string, slugs: string[]): Promise<void> {
  if (!slugs.length) return;
  await pool.query(
    `update agent_memory set recall_count = recall_count + 1, last_recalled_at = now()
     where account_id = $1 and slug = any($2::text[])`,
    [accountId, slugs],
  );
}

export interface MemoryRevision {
  value: string;
  description: string | null;
  updatedAt: Date;
  replacedAt: Date;
  /** 이 판이 쓰기 검사(080)에 걸린 판이었나. */
  flagged: boolean;
}

/** slug 의 이전 판, 최근 것부터. 사람이 보는 화면과 정리 턴이 되돌릴 때 쓴다. */
export async function listMemoryRevisions(
  pool: Pool, accountId: string, slug: string,
): Promise<MemoryRevision[]> {
  const res = await pool.query(
    `select value, description, updated_at as "updatedAt", replaced_at as "replacedAt", flagged
     from agent_memory_revision where account_id = $1 and slug = $2
     order by replaced_at desc, id desc`,
    [accountId, slug],
  );
  return res.rows as MemoryRevision[];
}

/**
 * 걸린 기억(080)의 **걸리기 전 마지막 판**. 걸린 기억을 `memory.get` 하면 본문 대신 이것을 준다 —
 * core 가 걸려도 러너는 그 전 판을 싣고, 걸린 글은 사람이 확인할 때까지 어느 프롬프트에도 안 간다.
 * 깨끗한 판이 없으면(처음부터 걸린 기억) null.
 */
export async function lastCleanRevision(
  pool: Pool, accountId: string, slug: string,
): Promise<{ value: string; description: string | null } | null> {
  const res = await pool.query(
    `select value, description from agent_memory_revision
     where account_id = $1 and slug = $2 and not flagged
     order by replaced_at desc, id desc limit 1`,
    [accountId, slug],
  );
  return res.rowCount ? (res.rows[0] as { value: string; description: string | null }) : null;
}

/**
 * 사람이 걸린 기억을 **확인**한다(080) — 표시를 풀어 이 판을 다시 프롬프트에 싣는다. 본문은 그대로다.
 * `updated_at` 은 건드리지 않는다: 에이전트가 들고 있는 판(ifUpdatedAt)이 확인 때문에 깨지면 안 된다.
 * 판본(`memoryRev`)이 안 바뀌므로 러너 캐시가 옛 core(걸리기 전 판)를 계속 들 수 있다 — 다음
 * 쓰기나 세션까지다. 확인은 드문 일이라 그 지연을 받아들인다. 걸린 것이 없으면 false.
 */
export async function clearMemoryFlag(pool: Pool, accountId: string, slug: string): Promise<boolean> {
  const res = await pool.query(
    `update agent_memory set flagged_at = null, flag_reason = null
     where account_id = $1 and slug = $2 and flagged_at is not null`,
    [accountId, slug],
  );
  return (res.rowCount ?? 0) > 0;
}

const MEMORY_SLUG_REGEX = /^core$|^mem\/[a-z0-9][a-z0-9_-]{0,63}((\/[a-z0-9][a-z0-9_-]{0,63})*)$/;

/**
 * 거절할 때 **문법을 함께 준다.** 원래 문구는 `invalid slug format` 한 마디였고, 그것이
 * 실제로 기능 하나를 죽였다(2026-09-11 실측): 한 에이전트가 `baremetal`·`baremetal.cluster`
 * 를 차례로 시도해 전부 거절당한 뒤 "harkroom 는 slug `core` 하나만 받는다"고 결론짓고,
 * 남겨야 할 런북을 하네스의 파일 메모리에 넣었다 — 그쪽은 cwd(=스레드)로 키가 잡혀 다음
 * 스레드에서 사라진다. 당시 에이전트 9 중 8이 `core` 하나뿐이었고, 이 한 줄이 없는 것이
 * 그 분포의 이유다. 문법은 프롬프트(`prompt.ts::memorySection`)에도 적지만, 거절이 오는
 * 자리에서 다시 말해야 한다 — 프롬프트를 못 읽은 하네스도 이 응답은 읽는다.
 *
 * `skill.propose` 가 이미 `slug must be [a-z0-9-]{2,40}` 로 그렇게 한다. 같은 판례다.
 */
export const MEMORY_SLUG_HINT = 'slug must be "core" or "mem/<name>" '
  + '(segments of [a-z0-9][a-z0-9_-]* joined by "/", e.g. "mem/deploy" or "mem/people/jaebin"; '
  + 'no dots, no uppercase, and the "mem/" prefix is required)';

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 255 && MEMORY_SLUG_REGEX.test(slug);
}

// ── 정리 후보(메모리 고도화 M4) ─────────────────────────────────────────────────────

/** 이 기간 넘게 안 읽힌 기억은 정리 후보다. 한 번도 안 읽힌 것은 만든 지 이만큼 지나야 센다. */
export const AUDIT_STALE_DAYS = 30;
export const AUDIT_NEVER_READ_GRACE_DAYS = 7;
const AUDIT_LIST_CAP = 30;

export interface MemoryAudit {
  total: number;
  core: { length: number; limit: number } | null;
  /**
   * 만든 지 7일이 지났는데 한 번도 안 쓰인 것(journal 제외 — 경위는 원래 잘 안 읽힌다).
   * "쓰임" = `memory.get` 으로 읽힘 **또는** 러너 recall 로 실림(096).
   */
  neverRead: string[];
  /** 마지막으로 쓰인 지(읽힘·recall 중 늦은 쪽) 30일이 지난 것(journal 제외). `lastReadAt` 은 그 늦은 쪽 시각이다. */
  stale: { slug: string; lastReadAt: string }[];
  /** 본문의 `[[이름]]` 이 가리키는 기억이 없다. */
  brokenLinks: { slug: string; target: string }[];
  /** 이름이 거의 같은 짝 — 합칠 후보. */
  similar: [string, string][];
  /** 호출자가 준 낡은 낱말(옛 이름·옛 주소)이 들어 있는 기억. */
  outdated: { slug: string; pattern: string }[];
  /**
   * 요약(description)이 없는 기억(journal 제외, P2). 목록에 이름만 실리고, 러너 recall 은
   * 이름·요약에 걸린 것만 싣으므로 요약이 없으면 이름 낱말로만 찾힌다. 채울 후보다.
   */
  undescribed: string[];
  /** 쓰기 검사(080)에 걸려 사람 확인을 기다리는 것. 에이전트는 고쳐 쓰거나 사람에게 알린다. */
  flagged: { slug: string; reason: string | null }[];
  /**
   * 어느 목록이든 30개에서 잘렸으면 true(F9). 정리 턴이 한 바퀴 돌고 "끝났다"고 믿지 않게 —
   * true 면 고친 뒤 다시 audit 한다.
   */
  truncated: boolean;
}

/** 이름을 낱말로 편다 — `mem/pr-896-memory-runner-cache` → {pr, memory, runner, cache}(숫자는 버린다). */
function nameTokens(slug: string): Set<string> {
  return new Set(slug.replace(/^mem\//, '').split(/[\/_-]+/).filter((t) => t.length > 1 && !/^\d+$/.test(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 정리 턴이 볼 후보를 뽑는다(M4). **판단은 에이전트가 한다** — 서버는 사실(읽힘·링크·이름)만
 * 모은다. 안 읽혔다고 쓸모없는 것은 아니고(드물게 꼭 필요한 런북), 이름이 비슷해도 다른 주제일
 * 수 있다. 목록마다 30개로 자른다 — 한 번에 다 고칠 필요가 없다.
 */
export async function auditMemory(
  pool: Pool, accountId: string, patterns: string[] = [],
): Promise<MemoryAudit> {
  const res = await pool.query(
    `select slug, value, description, kind, read_count, last_read_at, recall_count, last_recalled_at,
       created_at, flagged_at, flag_reason
     from agent_memory where account_id = $1 order by slug`,
    [accountId],
  );
  const rows = res.rows as {
    slug: string; value: string; description: string | null; kind: MemoryKind;
    read_count: number; last_read_at: Date | null; recall_count: number; last_recalled_at: Date | null;
    created_at: Date; flagged_at: Date | null; flag_reason: string | null;
  }[];
  const now = Date.now();
  const day = 86_400_000;
  const slugs = new Set(rows.map((r) => r.slug));
  const coreRow = rows.find((r) => r.slug === 'core');
  const audit: MemoryAudit = {
    total: rows.length,
    core: coreRow ? { length: coreRow.value.length, limit: MAX_CORE_MEMORY_LENGTH } : null,
    neverRead: [], stale: [], brokenLinks: [], similar: [], outdated: [], undescribed: [], flagged: [],
    truncated: false,
  };
  const lowered = patterns.map((p) => p.trim()).filter((p) => p.length >= 3).map((p) => [p, p.toLowerCase()] as const);
  for (const r of rows) {
    const judged = r.slug !== 'core' && r.kind !== 'journal';
    if (r.flagged_at) audit.flagged.push({ slug: r.slug, reason: r.flag_reason });
    const used = r.read_count + r.recall_count;
    if (judged && used === 0 && now - r.created_at.getTime() > AUDIT_NEVER_READ_GRACE_DAYS * day) {
      audit.neverRead.push(r.slug);
    }
    if (judged && !r.description?.trim()) audit.undescribed.push(r.slug);
    const lastUsed = [r.last_read_at, r.last_recalled_at]
      .filter((d): d is Date => d !== null).reduce<Date | null>((a, d) => (!a || d > a ? d : a), null);
    if (judged && lastUsed && now - lastUsed.getTime() > AUDIT_STALE_DAYS * day) {
      audit.stale.push({ slug: r.slug, lastReadAt: lastUsed.toISOString() });
    }
    for (const m of r.value.matchAll(/\[\[([^\]\s]{1,255})\]\]/g)) {
      const target = m[1]!;
      const exists = slugs.has(target) || slugs.has(`mem/${target}`);
      if (!exists && !audit.brokenLinks.some((b) => b.slug === r.slug && b.target === target)) {
        audit.brokenLinks.push({ slug: r.slug, target });
      }
    }
    const body = r.value.toLowerCase();
    for (const [raw, low] of lowered) if (body.includes(low)) audit.outdated.push({ slug: r.slug, pattern: raw });
  }
  const named = rows.filter((r) => r.slug !== 'core' && r.kind !== 'journal').map((r) => [r.slug, nameTokens(r.slug)] as const);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      if (jaccard(named[i]![1], named[j]![1]) >= 0.6) audit.similar.push([named[i]![0], named[j]![0]]);
    }
  }
  audit.truncated = [audit.neverRead, audit.stale, audit.brokenLinks, audit.similar, audit.outdated,
    audit.undescribed, audit.flagged].some((l) => l.length > AUDIT_LIST_CAP);
  audit.neverRead = audit.neverRead.slice(0, AUDIT_LIST_CAP);
  audit.stale = audit.stale.slice(0, AUDIT_LIST_CAP);
  audit.brokenLinks = audit.brokenLinks.slice(0, AUDIT_LIST_CAP);
  audit.similar = audit.similar.slice(0, AUDIT_LIST_CAP);
  audit.outdated = audit.outdated.slice(0, AUDIT_LIST_CAP);
  audit.undescribed = audit.undescribed.slice(0, AUDIT_LIST_CAP);
  audit.flagged = audit.flagged.slice(0, AUDIT_LIST_CAP);
  return audit;
}

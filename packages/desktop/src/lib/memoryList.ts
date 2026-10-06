/**
 * 기억 목록을 **사람이 훑을 수 있는 모양**으로 바꾸는 판정(#139 4단계).
 *
 * ## 왜 화면에서 떼어 냈나
 *
 * 앞판은 서버가 준 배열을 그대로 `map` 해서 전부 펼쳤다. 값 하나가 8,000자까지 오고
 * 계정당 200개까지 쌓이므로, 그 화면은 **항목이 늘어날수록 반드시 무너지는 모양**이었다.
 * 실측(2026-09-14, `@murmur`): 81개 × (머리 + `max-h-32` 본문 + 여백 ≈ 170px) ≈ 13,800px —
 * PAT·권한 설정 사이에 1440px 화면 아홉 장 반이 끼어 있었다.
 *
 * 여기 있는 것은 셋 다 **순수 함수**다. 접기·검색·묶기는 눈으로 확인하기 어려운 판정이라
 * (묶임의 경계, 검색이 그룹을 어떻게 쪼개는가) 회귀선이 직접 재야 한다.
 */

/** 서버가 주는 그대로. `updatedAt` 은 ISO 문자열이다. */
export interface MemoryEntry {
  slug: string;
  value: string;
  updatedAt: string;
  /** 서버 069/070 이후 필드. 옛 서버면 없다 — 화면은 없는 것을 그리지 않는다. */
  description?: string | null;
  kind?: 'topic' | 'procedure' | 'journal';
  readCount?: number;
  lastReadAt?: string | null;
  /** 서버 080: 쓰기 검사에 걸린 판이면 시각과 이유. 사람이 확인할 때까지 에이전트 프롬프트에 안 실린다. */
  flaggedAt?: string | null;
  flagReason?: string | null;
  /**
   * 서버 097: 보관된 기억이면 그 시각. 사람 목록 API 는 보관된 것도 **함께** 준다 — 그것을
   * 살아 있는 것과 한 목록·한 숫자로 세면 상한(보관 제외)과 어긋난 `213 / 200` 이 뜬다.
   */
  archivedAt?: string | null;
  /** 서버 096: 러너 recall 로 프롬프트에 실린 횟수·마지막 시각(#1186 부터 사람 목록에도 온다). */
  recallCount?: number;
  lastRecalledAt?: string | null;
  /**
   * 만든 시각. 보관·되살리기도 `updatedAt` 을 바꾸므로(서버 `archiveMemory`) 상세의 "고침" 만으로는
   * 되살린 기억이 방금 쓴 것처럼 보인다 — 만든 때를 따로 보여 준다.
   */
  createdAt?: string;
}

/** 이전 판(서버 069). 최근 것부터 온다. */
export interface MemoryRevision {
  value: string;
  description: string | null;
  updatedAt: string;
  replacedAt: string;
  /** 서버 080: 이 판이 쓰기 검사에 걸린 판이었나. */
  flagged?: boolean;
}

/** 사람의 기억 편집(M5). `ifUpdatedAt` 은 화면이 연 판 — 그 사이 에이전트가 고쳤으면 409. */
export interface MemoryEdit {
  value: string;
  description?: string;
  kind?: 'topic' | 'procedure' | 'journal';
  ifUpdatedAt?: string | null;
}

/**
 * 정렬 축 둘. **기본은 `recent` 다.**
 *
 * 서버는 `order by slug` 한 가지로 준다. 그것을 그대로 화면의 기본으로 쓰면
 * `mem/pr-*` 38개가 목록 한가운데를 가로막는다. 사람이 이 화면을 여는 대부분의 이유는
 * *"이 에이전트가 방금 무엇을 기억했나"* 이고, 그 물음에 답하는 것은 이름순이 아니다.
 */
export type MemorySort = 'recent' | 'name';

/** 묶인 접두어 하나. `items` 는 이미 정렬돼 있다. */
export interface MemoryGroup {
  /** 묶음의 열쇠이자 접두어 그 자체 — `mem/pr-`. 열림 상태의 id 로도 쓴다. */
  key: string;
  items: MemoryEntry[];
}

/** 목록의 한 줄. 묶음 머리이거나 항목이다. */
export type MemoryRow =
  | { kind: 'group'; group: MemoryGroup }
  | { kind: 'item'; item: MemoryEntry };

/**
 * **묶음은 셋부터다.**
 *
 * 둘로 두면 머리 한 줄을 더 그려 두 줄을 감추므로 실이 한 줄, 대신 누르는 수고가 는다 —
 * 감추는 값이 비용을 넘지 못한다. 셋부터는 확실히 남는다. 실측에서 이 값이 만드는 묶음은
 * `mem/pr-`(38) · `mem/codex-`(4) · `mem/rename-`(3) · `mem/terminal-`(3) 넷이고,
 * 그것으로 81줄이 40줄대로 내려간다.
 */
export const MIN_GROUP_SIZE = 3;

/** `core` 는 목록에 서지 않는다 — 성격이 다르다(아래 `splitCore`). */
export const CORE_SLUG = 'core';

/**
 * 값의 **첫 줄을 제목처럼** 쓴다.
 *
 * 에이전트들이 이미 `# 제목` 으로 시작하는 글을 넣고 있다(실측 81개 중 대부분). 그것을
 * 그대로 한 줄 요약으로 쓰면 사람이 따로 요약을 달 필요가 없고, 안 쓰는 에이전트의 값도
 * 첫 줄이 대개 가장 뜻이 굵다.
 *
 * 마크다운 장식을 떼는 이유: 접힌 줄은 **한 줄**이라 `#`·`**`·`>` 가 뜻을 더하지 않고
 * 자리만 먹는다. 펼치면 원문 그대로 보인다.
 *
 * 길이를 자르는 것은 서식이 아니라 **안전장치**다 — 줄바꿈이 없는 8,000자 값 하나가
 * 그대로 DOM 에 들어가면 접은 보람이 없다. 말줄임은 CSS 가 한다.
 */
export function memorySummary(value: string): string {
  for (const raw of value.split('\n')) {
    const line = raw
      .replace(/^\s*>+\s*/, '')       // 인용 줄
      .replace(/^\s*#{1,6}\s+/, '')   // 제목
      .replace(/^\s*[-*+]\s+/, '')    // 목록 표시
      .replace(/\*\*/g, '')           // 굵게
      .trim();
    if (line) return line.slice(0, 200);
  }
  return '';
}

/**
 * 이 slug 가 어느 묶음에 드는가. 들지 않으면 `null`.
 *
 * 규칙은 **`mem/` 다음 첫 `-` 토큰**이다 — `mem/pr-703-progress-not-a-reply` → `mem/pr-`.
 *
 * ## 왜 화면의 규칙으로 두나
 *
 * slug 문법은 `/` 를 구분자로 받으므로 `mem/pr/703-…` 으로 쓰게 하면 묶음이 어림짐작이
 * 아니라 **구조**가 된다. 그쪽이 옳지만 이미 쌓인 38개의 이름을 바꿔야 하고, 그것은
 * *"`mem/pr-*` 를 존치할 것인가"*(`mem/memory-redesign-794`)가 정해진 뒤의 일이다.
 * 그 결정을 기다리는 동안에도 화면은 고칠 수 있다 — 이 함수가 그 사이를 메운다.
 * 구조로 옮기는 날 여기만 바꾸면 된다.
 */
export function memoryGroupKey(slug: string): string | null {
  if (!slug.startsWith('mem/')) return null;
  const rest = slug.slice('mem/'.length);
  const dash = rest.indexOf('-');
  // 토큰이 비면(`mem/-x`) 묶을 이름이 없다.
  if (dash <= 0) return null;
  return `mem/${rest.slice(0, dash)}-`;
}

/**
 * `core` 를 목록에서 떼어 낸다.
 *
 * **매 턴 통째로 프롬프트에 실리는 것은 `core` 뿐이다** — 길이가 곧 비용이다. 나머지는
 * 에이전트가 필요할 때만 연다. 성격이 정반대인 둘을 한 목록에 두면 화면에 그 차이가
 * 없고, `core` 가 맨 위에 오는 것도 이름순 정렬의 우연에 기댄 것이 된다(`c` < `m`).
 */
export function splitCore(entries: MemoryEntry[]): { core: MemoryEntry | null; rest: MemoryEntry[] } {
  const core = entries.find((e) => e.slug === CORE_SLUG) ?? null;
  return { core, rest: entries.filter((e) => e.slug !== CORE_SLUG) };
}

/**
 * 보관된 것을 뗀다(서버 097).
 *
 * **상한 200 은 보관을 빼고 센다**(`services/memory.ts` 의 `too_many` 판정) — 화면의 숫자도
 * `active` 로 세야 서버가 거절하는 시점과 맞는다. 보관된 것은 에이전트 목록·recall 에
 * 실리지 않으므로 살아 있는 것과 한 목록에 섞지 않는다. 최근 보관한 것부터 준다.
 */
export function splitArchived(entries: MemoryEntry[]): { active: MemoryEntry[]; archived: MemoryEntry[] } {
  const active: MemoryEntry[] = [];
  const archived: MemoryEntry[] = [];
  for (const e of entries) (e.archivedAt ? archived : active).push(e);
  archived.sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!) || a.slug.localeCompare(b.slug));
  return { active, archived };
}

/** 검색어로만 거른다(순서는 그대로). 보관 칸처럼 묶지 않는 목록이 쓴다. */
export function filterMemories(entries: MemoryEntry[], query: string): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  return q ? entries.filter((e) => matches(e, q)) : entries;
}

/** 검색은 slug 와 **본문 둘 다** 본다 — 값이 이미 손에 있으므로 서버 왕복이 없다. */
function matches(e: MemoryEntry, q: string): boolean {
  return e.slug.toLowerCase().includes(q) || e.value.toLowerCase().includes(q);
}

function compare(sort: MemorySort) {
  return (a: MemoryEntry, b: MemoryEntry): number => (
    sort === 'name'
      ? a.slug.localeCompare(b.slug)
      // 같은 시각이면 이름으로 —그렇지 않으면 순서가 렌더마다 흔들린다.
      : (b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug))
  );
}

/**
 * 목록을 줄의 나열로 바꾼다. `core` 는 여기 오지 않는다(`splitCore` 가 먼저 뗀다).
 *
 * **묶음의 자리는 그 안에서 가장 앞서는 항목이 정한다.** 묶음을 목록 끝에 몰면 최근에
 * 고친 `mem/pr-*` 가 맨 아래로 밀려, 정렬을 `recent` 로 둔 뜻이 사라진다.
 *
 * **검색 중에는 남은 것으로 다시 묶는다.** 걸러 낸 결과가 둘뿐인데 묶음 머리가 그대로
 * 서 있으면 사람은 접힌 줄 뒤에 더 있다고 읽는다 — 없는데 있다고 말하는 화면이 된다.
 */
export function memoryRows(
  entries: MemoryEntry[],
  opts: { query?: string; sort?: MemorySort } = {},
): MemoryRow[] {
  const sort = opts.sort ?? 'recent';
  const q = (opts.query ?? '').trim().toLowerCase();
  const kept = q ? entries.filter((e) => matches(e, q)) : entries.slice();
  kept.sort(compare(sort));

  const byKey = new Map<string, MemoryEntry[]>();
  for (const e of kept) {
    const key = memoryGroupKey(e.slug);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e); else byKey.set(key, [e]);
  }

  const grouped = new Set<string>();
  for (const [key, items] of byKey) {
    if (items.length < MIN_GROUP_SIZE) continue;
    for (const e of items) grouped.add(e.slug);
    byKey.set(key, items);
  }

  const rows: MemoryRow[] = [];
  const emitted = new Set<string>();
  for (const e of kept) {
    if (!grouped.has(e.slug)) { rows.push({ kind: 'item', item: e }); continue; }
    const key = memoryGroupKey(e.slug)!;
    if (emitted.has(key)) continue;
    emitted.add(key);
    rows.push({ kind: 'group', group: { key, items: byKey.get(key)! } });
  }
  return rows;
}

/**
 * 정리 후보(서버 `GET …/memory/audit`, #1186). 에이전트의 `memory.audit` 과 같은 분류이고, 사람
 * 화면은 목록 상한이 200 이라 낱개 목록은 사실상 전부 온다. 화면이 쓰는 필드만 적는다.
 */
export interface MemoryAudit {
  core: { length: number; limit: number } | null;
  neverRead: string[];
  stale: { slug: string; lastReadAt: string }[];
  brokenLinks: { slug: string; target: string }[];
  similar: [string, string][];
  similarBody: { pair: [string, string]; similarity: number }[];
  undescribed: string[];
  flagged: { slug: string; reason: string | null }[];
  expiringJournal: string[];
  /** 어느 목록이든 상한에서 잘렸으면 true. 사람 상한(200)에서 잘리는 것은 n² 인 짝 목록뿐이다. */
  truncated: boolean;
  items: { active: number; limit: number; archived: number };
}

/** 보관·되살리기의 slug 하나 결과(#1186). 한 slug 의 실패가 나머지를 막지 않는다. */
export type MemoryBatchResult = 'ok' | 'not_found' | 'invalid_slug' | 'core_not_archivable' | 'too_many';

/** 「정리할 것」 칩. 순서가 곧 화면 순서다 — 사람 손이 가장 급한 것부터. */
export const CLEANUP_CHIPS = ['flagged', 'stale', 'neverRead', 'pairs', 'brokenLinks', 'expiringJournal', 'undescribed'] as const;
export type CleanupChip = typeof CLEANUP_CHIPS[number];

export interface CleanupChipView {
  key: CleanupChip;
  /** 칩을 누르면 목록이 이 기억들만 보인다. 숫자는 이 집합의 크기다. */
  slugs: Set<string>;
  /** 짝 목록이 상한에서 잘렸으면 숫자를 "200+" 처럼 쓴다. */
  truncated: boolean;
}

/**
 * audit 를 칩으로 편다. **숫자는 기억 수**다 — 짝 칩은 `similar`·`similarBody` 가 같은 짝을 각각
 * 담을 수 있고 한 기억이 여러 짝에 들어가므로, 짝 수로 세면 칩을 눌러 보이는 줄 수와 어긋난다.
 *
 * 깨진 링크는 **정말 없는 기억을 가리키는 것만** 센다. audit 은 살아 있는 slug 만 보므로 보관된
 * 기억을 가리키는 `[[링크]]` 도 깨짐으로 오는데, 그것은 고칠 일이 아니라 되살릴지 정할 일이다
 * (`archivedLinks`). 0 인 칩은 돌려주지 않는다 — 할 일이 없는 칩은 소음이다.
 */
export function cleanupChips(audit: MemoryAudit, archivedSlugs: ReadonlySet<string>): CleanupChipView[] {
  const pairSlugs = new Set<string>();
  for (const [a, b] of audit.similar) { pairSlugs.add(a); pairSlugs.add(b); }
  for (const { pair: [a, b] } of audit.similarBody) { pairSlugs.add(a); pairSlugs.add(b); }
  const sets: Record<CleanupChip, Set<string>> = {
    flagged: new Set(audit.flagged.map((f) => f.slug)),
    stale: new Set(audit.stale.map((s) => s.slug)),
    neverRead: new Set(audit.neverRead),
    pairs: pairSlugs,
    brokenLinks: new Set(audit.brokenLinks.filter((l) => !isArchivedTarget(l.target, archivedSlugs)).map((l) => l.slug)),
    expiringJournal: new Set(audit.expiringJournal),
    undescribed: new Set(audit.undescribed),
  };
  // core 는 목록 줄이 아니라 위 카드에 선다 — 칩 숫자에 넣으면 눌렀을 때 보이는 줄 수와 하나 어긋난다.
  // audit 은 `flagged`·`brokenLinks` 에 core 를 넣는다(서버 `auditMemory` 의 judged 밖).
  for (const set of Object.values(sets)) set.delete(CORE_SLUG);
  return CLEANUP_CHIPS
    .map((key) => ({ key, slugs: sets[key], truncated: key === 'pairs' && audit.truncated }))
    .filter((c) => c.slugs.size > 0);
}

/** 칩 숫자. 잘린 짝 칩은 아는 만큼 + "+" 다(정확하지 않은 숫자를 정확한 듯 쓰지 않는다). */
export function chipCount(chip: CleanupChipView): string {
  return chip.truncated ? `${chip.slugs.size}+` : String(chip.slugs.size);
}

/** 한 기억이 어느 칩에 걸렸나 — 줄 꼬리표. 칩 순서대로. */
export function chipsFor(slug: string, chips: CleanupChipView[]): CleanupChip[] {
  return chips.filter((c) => c.slugs.has(slug)).map((c) => c.key);
}

/** 보관된 기억을 가리키는 `[[링크]]` — slug → 가리킨 보관 기억들. 줄에 [되살리기]를 단다. */
export function archivedLinks(audit: MemoryAudit, archivedSlugs: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of audit.brokenLinks) {
    if (!isArchivedTarget(l.target, archivedSlugs)) continue;
    const target = archivedSlugs.has(l.target) ? l.target : `mem/${l.target}`;
    const list = out.get(l.slug);
    if (list) { if (!list.includes(target)) list.push(target); } else out.set(l.slug, [target]);
  }
  return out;
}

/** 보관은 300 개까지 — 넘치면 서버가 가장 오래 보관한 것부터 **조용히** 이전 판으로 밀어낸다. */
export const MAX_ARCHIVED_MEMORIES = 300;

/** 이만큼 더 보관하면 밀려나는 수. 0 이면 경고하지 않는다(security n2: 미리 알린다). */
export function archiveOverflow(archivedNow: number, adding: number): number {
  return Math.max(0, archivedNow + adding - MAX_ARCHIVED_MEMORIES);
}

/** 지난 `days` 일 안에 쓰인(읽힘 또는 recall) 기억 수 — 건강 띠. */
export function usedWithin(entries: MemoryEntry[], days: number, now: number): number {
  const since = now - days * 86_400_000;
  return entries.filter((e) => [e.lastReadAt, e.lastRecalledAt]
    .some((t) => t != null && new Date(t).getTime() >= since)).length;
}

/** 쓰임 = 읽힘 + recall. 옛 서버면 없는 쪽은 0 으로 센다. */
export function usageOf(e: MemoryEntry): number {
  return (e.readCount ?? 0) + (e.recallCount ?? 0);
}

/**
 * 종류별 칸(Memory 탭 결정 1). 순서가 곧 화면 순서다 — 규칙·사실이 가장 많이 열리고, 경위는
 * 원래 잘 안 읽힌다. 종류가 없는 옛 서버 항목은 규칙·사실로 센다(서버 기본값과 같다).
 */
export const MEMORY_KINDS = ['topic', 'procedure', 'journal'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

export interface MemoryKindSection {
  kind: MemoryKind;
  /** 이 칸에 든 기억 수(검색·칩으로 거른 뒤). */
  count: number;
  rows: MemoryRow[];
}

/**
 * 종류별로 나눈 뒤 칸마다 `memoryRows` 로 접두어를 묶는다. 빈 칸은 돌려주지 않는다.
 * 접두어 묶음이 종류를 넘나들지 않게 칸 안에서 묶는다 — `mem/pr-` 의 경위와 규칙이 한 묶음에
 * 섞이면 종류로 나눈 보람이 없다.
 */
export function memorySections(
  entries: MemoryEntry[],
  opts: { query?: string; sort?: MemorySort } = {},
): MemoryKindSection[] {
  const out: MemoryKindSection[] = [];
  for (const kind of MEMORY_KINDS) {
    const rows = memoryRows(entries.filter((e) => (e.kind ?? 'topic') === kind), opts);
    const count = rows.reduce((n, r) => n + (r.kind === 'item' ? 1 : r.group.items.length), 0);
    if (count > 0) out.push({ kind, count, rows });
  }
  return out;
}

/** 본문의 `[[이름]]` 조각. 서버 audit 과 같은 문법이다(공백 없음, 255자까지). */
export const WIKI_LINK = /\[\[([^\]\s]{1,255})\]\]/g;

/** `[[x]]` 가 가리키는 slug. 서버처럼 `x` 그대로와 `mem/x` 둘 다 본다. */
export function resolveWikiLink(
  target: string, active: ReadonlySet<string>, archived: ReadonlySet<string>,
): { slug: string; state: 'active' | 'archived' } | { slug: null; state: 'missing' } {
  for (const slug of [target, `mem/${target}`]) {
    if (active.has(slug)) return { slug, state: 'active' };
    if (archived.has(slug)) return { slug, state: 'archived' };
  }
  return { slug: null, state: 'missing' };
}

/**
 * 「왜 후보인가」 — 한 기억이 audit 의 어느 목록에 왜 들었나. 칩은 이름만 말하고, 상세는
 * 근거(마지막 쓰임·짝 상대·가리킨 이름·걸린 이유)를 함께 말한다. 칩 순서대로.
 */
export type CandidateReason =
  | { key: 'flagged'; reason: string | null }
  | { key: 'stale'; lastUsedAt: string }
  | { key: 'neverRead' }
  | { key: 'pairs'; with: string[] }
  | { key: 'brokenLinks'; targets: string[] }
  | { key: 'expiringJournal' }
  | { key: 'undescribed' };

export function candidateReasons(
  slug: string, audit: MemoryAudit, archivedSlugs: ReadonlySet<string>,
): CandidateReason[] {
  if (slug === CORE_SLUG) return [];
  const out: CandidateReason[] = [];
  const flag = audit.flagged.find((f) => f.slug === slug);
  if (flag) out.push({ key: 'flagged', reason: flag.reason });
  const stale = audit.stale.find((s) => s.slug === slug);
  if (stale) out.push({ key: 'stale', lastUsedAt: stale.lastReadAt });
  if (audit.neverRead.includes(slug)) out.push({ key: 'neverRead' });
  const partners = new Set<string>();
  for (const [a, b] of audit.similar) { if (a === slug) partners.add(b); if (b === slug) partners.add(a); }
  for (const { pair: [a, b] } of audit.similarBody) { if (a === slug) partners.add(b); if (b === slug) partners.add(a); }
  if (partners.size) out.push({ key: 'pairs', with: [...partners] });
  const targets = audit.brokenLinks.filter((l) => l.slug === slug && !isArchivedTarget(l.target, archivedSlugs)).map((l) => l.target);
  if (targets.length) out.push({ key: 'brokenLinks', targets });
  if (audit.expiringJournal.includes(slug)) out.push({ key: 'expiringJournal' });
  if (audit.undescribed.includes(slug)) out.push({ key: 'undescribed' });
  return out;
}

/** 줄 꼬리표는 이만큼만 보이고 나머지는 「+n」(좁은 창에서 요약 칸이 0 으로 밀리지 않게, #1196 designer n3). */
export const MAX_ROW_REASONS = 2;

/** `[[x]]` 의 x 가 보관된 기억을 가리키나(`x` 그대로 또는 `mem/x`, 서버 audit 과 같은 규칙). */
function isArchivedTarget(target: string, archived: ReadonlySet<string>): boolean {
  return archived.has(target) || archived.has(`mem/${target}`);
}

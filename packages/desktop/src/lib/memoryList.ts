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

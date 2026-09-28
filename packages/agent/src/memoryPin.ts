/**
 * 메모리를 **어디에** 싣는가(메모리 고도화 PR2, 2026-09-28 jaebin 승인 "옮겨").
 *
 * 전에는 core 본문과 `mem/*` 목록이 전부 시스템 프롬프트에 있었다. 대화 기록은 그 **뒤에**
 * 붙으므로, 시스템 프롬프트가 한 글자라도 바뀌면 이어받은 세션은 대화 기록 전체를 프롬프트
 * 캐시 없이 다시 읽는다. 그런데 목록은 에이전트가 `memory.set` 을 할 때마다 바뀐다 — murmur
 * 는 하루 수십 번 쓴다. 다른 스레드에서 한 번 쓰는 것만으로 이 스레드의 다음 턴이 비싸졌다.
 *
 * 그래서 **세션 단위로 고정한다**:
 * - 시스템 프롬프트의 core 는 **세션 첫 턴에 본 값**으로 고정한다(`systemCore`).
 * - `mem/*` 목록은 시스템 프롬프트에서 빼고 **턴 프롬프트** 앞머리(`<memory-index>`)로 옮긴다.
 *   세션 첫 턴에 전체를, 그 뒤로는 **바뀐 것만**(생김·지워짐) 싣는다 — 매 턴 전체를 실으면
 *   그것이 대화 기록에 턴 수만큼 쌓인다.
 * - core 가 세션 도중 바뀌면 턴 프롬프트에 **지금 core 전문**을 한 번 싣고(`<memory-update>`),
 *   "시스템 프롬프트의 것보다 이것이 지금 값이다"라고 말한다. 다음 턴부터는 다시 안 싣는다.
 * - 러너 사본으로 도는 경고(`stale`)도 턴 프롬프트로 간다 — 그것 역시 턴마다 달라지는 값이다.
 *
 * 고정 상태는 세션마다 파일 하나(`<stateDir>/memory-pins/<키 해시>.json`)다. `sessions.json`
 * 에 넣지 않은 이유: 그 파일은 턴마다 통째로 다시 쓰이는데 core 전문 × 스레드 수가 실리면
 * 무거워진다. 알린 것은 **성공한 턴 뒤에만** 저장한다(`commit`) — 실패한 턴의 알림은 하네스에
 * 닿았는지 모르므로 다음 시도가 다시 알린다(중복 알림이 누락보다 싸다).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeForPrompt, staleMemoryLines, type MemoryContext } from './prompt.js';

export const MEMORY_PIN_DIR = 'memory-pins';

interface PinState {
  /** 이 고정을 만든 세션. codex 는 첫 턴 뒤에야 id 를 알므로 null 일 수 있다. */
  sessionId: string | null;
  /** 이 세션의 시스템 프롬프트에 실린 core — 세션이 끝날 때까지 그대로다. */
  systemCore: string | null;
  /** 이 세션에 마지막으로 알린 core 의 해시. */
  announcedCoreSha: string | null;
  /** 이 세션에 마지막으로 알린 slug 목록(journal 제외 — 목록에 안 싣는 것은 알리지도 않는다). */
  announcedSlugs: string[];
  /** 이 세션에 이미 본문을 실어 준 기억(`<memory-recall>`). 같은 것을 턴마다 다시 싣지 않는다. */
  recalled?: string[];
}

/** 러너가 요청 본문으로 찾은 기억(서버 `memory.search`, includeValue). */
export interface RecallHit {
  slug: string;
  description: string | null;
  score: number;
  value?: string;
}

/** 자동 주입 기준. 이름·요약에 한 번 걸리면(3점) 넘는다 — 본문 한두 낱말 일치로는 싣지 않는다. */
export const RECALL_MIN_SCORE = 3;
export const RECALL_MAX_ITEMS = 2;
export const RECALL_MAX_CHARS = 1500;

export interface MemoryPlan {
  /** 시스템 프롬프트에 넘길 기억. core 는 고정값이다. */
  system: MemoryContext;
  /** 턴 프롬프트 앞머리에 붙일 줄. 알릴 것이 없으면 빈 배열이다. */
  turnLines: string[];
  /** 성공한 턴 뒤에 부른다 — 알린 상태를 저장한다. 실패는 삼킨다(다음 턴이 다시 알린다). */
  commit(sessionId: string | null): Promise<void>;
}

const sha = (text: string | null): string | null =>
  text === null ? null : createHash('sha256').update(text).digest('hex');

function pinFile(stateDir: string, key: string): string {
  return join(stateDir, MEMORY_PIN_DIR, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
}

async function loadPin(file: string): Promise<PinState | null> {
  try {
    const p = JSON.parse(await readFile(file, 'utf8')) as Partial<PinState>;
    if (!Array.isArray(p.announcedSlugs)) return null;
    return {
      sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
      systemCore: typeof p.systemCore === 'string' ? p.systemCore : null,
      announcedCoreSha: typeof p.announcedCoreSha === 'string' ? p.announcedCoreSha : null,
      announcedSlugs: p.announcedSlugs.filter((s): s is string => typeof s === 'string'),
      recalled: Array.isArray(p.recalled) ? p.recalled.filter((s): s is string => typeof s === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** 목록 한 줄. 요약(서버 069)이 있으면 이름 옆에 붙인다 — 언제 열어 볼지 정하는 근거다. */
function entryLine(slug: string, descriptions: Record<string, string> | undefined): string {
  const d = descriptions?.[slug];
  return d ? `- ${escapeForPrompt(slug)} — ${escapeForPrompt(d)}` : `- ${escapeForPrompt(slug)}`;
}

function indexLines(slugs: string[], descriptions: Record<string, string> | undefined, journalCount = 0): string[] {
  if (!slugs.length && !journalCount) return [];
  return [
    '<memory-index>',
    '저장된 기억(본문은 필요할 때 `memory.get` 으로 가져온다 — 이름만으로 짐작되지 않으면 열어 본다):',
    ...slugs.map((s) => entryLine(s, descriptions)),
    ...(journalCount ? [`(작업 경위 기록 journal ${journalCount}개는 목록에 싣지 않는다 — \`memory.search\` 로 찾는다.)`] : []),
    '</memory-index>',
  ];
}

export async function planMemory(opts: {
  stateDir: string;
  /** 세션 키(`SessionStore.threadKey`). */
  key: string;
  sessionId: string | null;
  isFirstTurn: boolean;
  memory: MemoryContext;
  /**
   * 관련 기억 찾기(메모리 고도화 PR4). 감사에서 `memory.get` 은 세션의 6.7% 에서만 불렸다 —
   * 목록을 보고 모델이 알아서 열기를 기대할 수 없다. 그래서 러너가 **이번에 새로 온 말**로
   * 찾아 관련 상위 몇 개의 본문을 턴 프롬프트에 붙여 준다. 실패는 삼킨다(없어도 턴은 돈다).
   */
  recall?: { query: string; search: (query: string) => Promise<RecallHit[]> };
}): Promise<MemoryPlan> {
  const file = pinFile(opts.stateDir, opts.key);
  const noop: MemoryPlan['commit'] = async () => {};

  // 못 읽었고 사본도 없다 — #139 규칙대로 아무것도 싣지 않는다. 고정도 건드리지 않는다.
  if (opts.memory === 'unavailable') return { system: 'unavailable', turnLines: [], commit: noop };
  const memory = opts.memory;
  const stale = memory.stale ? ['', ...staleMemoryLines(memory.stale.fetchedAt)] : [];
  // journal(070)은 목록에 싣지 않는다 — 한 작업의 경위라 적고 나면 거의 안 읽혔다(감사: pr-* 41%).
  const isJournal = (s: string) => memory.kinds?.[s] === 'journal';
  const visible = memory.slugs.filter((s) => !isJournal(s));
  const journalCount = memory.slugs.length - visible.length;

  const pin = opts.isFirstTurn ? null : await loadPin(file);
  const pinUsable = pin !== null
    && (pin.sessionId === null || pin.sessionId === opts.sessionId)
    // core 가 "없음 ↔ 있음" 으로 바뀌면 다시 고정한다. 시스템 프롬프트가 "기억이 아직 없다"
    // 는 온보딩을 싣고 있는데 턴 프롬프트가 core 를 주면 두 말이 부딪친다. 드문 전이라
    // 캐시를 한 번 깨는 값이 싸다.
    && (pin.systemCore === null) === (memory.core === null);

  const save = (next: PinState): MemoryPlan['commit'] => async (sessionId) => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(opts.stateDir, MEMORY_PIN_DIR), { recursive: true });
      await writeFile(tmp, JSON.stringify({ ...next, sessionId: sessionId ?? next.sessionId }), { mode: 0o600 });
      await rename(tmp, file);
    } catch (err: unknown) {
      console.error(`[memoryPin] 고정 저장 실패 — 다음 턴이 다시 알린다: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const alreadyRecalled = new Set(pinUsable ? pin!.recalled ?? [] : []);
  const recall = await recallLines(opts.recall, alreadyRecalled);
  const recalled = [...alreadyRecalled, ...recall.slugs];

  if (!pinUsable) {
    // 새 세션(또는 고정을 잃었다): 지금 값으로 고정하고 목록 전체를 싣는다.
    const lines = [...indexLines(visible, memory.descriptions, journalCount), ...recall.lines, ...stale];
    return {
      system: { core: memory.core, slugs: memory.slugs },
      turnLines: trimLeading(lines),
      commit: save({
        sessionId: opts.sessionId, systemCore: memory.core,
        announcedCoreSha: sha(memory.core), announcedSlugs: visible, recalled,
      }),
    };
  }

  const lines: string[] = [];
  const coreSha = sha(memory.core);
  const coreChanged = coreSha !== pin.announcedCoreSha;
  const seen = new Set(pin.announcedSlugs);
  const now = new Set(visible);
  const added = visible.filter((s) => !seen.has(s));
  const removed = pin.announcedSlugs.filter((s) => !now.has(s));
  if (coreChanged || added.length || removed.length) {
    lines.push('<memory-update>', '이 세션이 시작된 뒤 기억이 바뀌었다 — 시스템 프롬프트의 `<memory>` 보다 이것이 지금 값이다.');
    if (coreChanged && memory.core !== null) {
      lines.push('', '지금 core 전문:', escapeForPrompt(memory.core));
    }
    if (added.length) lines.push('', '새로 생긴 기억:', ...added.map((s) => entryLine(s, memory.descriptions)));
    if (removed.length) lines.push('', '지워진 기억:', ...removed.map((s) => `- ${escapeForPrompt(s)}`));
    lines.push('</memory-update>');
  }
  lines.push(...recall.lines, ...stale);
  return {
    // slugs 는 "비었는가" 판정에만 쓰인다 — 목록 자체는 시스템 프롬프트에 안 실린다.
    system: { core: pin.systemCore, slugs: memory.slugs },
    turnLines: trimLeading(lines),
    commit: save({ ...pin, announcedCoreSha: coreSha, announcedSlugs: visible, recalled }),
  };
}

async function recallLines(
  recall: { query: string; search: (query: string) => Promise<RecallHit[]> } | undefined,
  skip: Set<string>,
): Promise<{ lines: string[]; slugs: string[] }> {
  if (!recall || !recall.query.trim()) return { lines: [], slugs: [] };
  let hits: RecallHit[];
  try {
    hits = await recall.search(recall.query);
  } catch (err: unknown) {
    console.error(`[memoryPin] 관련 기억 찾기 실패 — 이번 턴은 싣지 않는다: ${err instanceof Error ? err.message : String(err)}`);
    return { lines: [], slugs: [] };
  }
  const picked = hits
    .filter((h) => h.score >= RECALL_MIN_SCORE && typeof h.value === 'string' && !skip.has(h.slug) && h.slug !== 'core')
    .slice(0, RECALL_MAX_ITEMS);
  if (!picked.length) return { lines: [], slugs: [] };
  const lines = [
    '', '<memory-recall>',
    '이번 요청과 관련돼 보이는 기억이다(러너가 낱말로 찾았다 — 맞지 않으면 무시하고, 낡았으면 고쳐라):',
  ];
  for (const h of picked) {
    const body = h.value!.length > RECALL_MAX_CHARS ? `${h.value!.slice(0, RECALL_MAX_CHARS)}\n…(잘림 — 전문은 memory.get)` : h.value!;
    lines.push('', `## ${escapeForPrompt(h.slug)}${h.description ? ` — ${escapeForPrompt(h.description)}` : ''}`, escapeForPrompt(body));
  }
  lines.push('</memory-recall>');
  return { lines, slugs: picked.map((h) => h.slug) };
}

function trimLeading(lines: string[]): string[] {
  let i = 0;
  while (i < lines.length && lines[i] === '') i++;
  return lines.slice(i);
}

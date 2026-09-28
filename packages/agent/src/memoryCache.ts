/**
 * 러너 메모리 캐시(2026-09-28, jaebin 승인 — 메모리 고도화 PR1).
 *
 * #139 는 "메모리는 매 턴 다시 읽는다, 캐시 없음"으로 정했다(`mentionTurn.ts` 의 그 주석).
 * 반영이 즉시라는 이점은 맞았지만, 값이 둘 들었다:
 *
 * 1. **조회가 실패하면 그 턴은 기억 없이 돈다.** `readMemory` 가 던지면 `'unavailable'` 이고,
 *    core 가 통째로 빠진다. 서버는 한국 → Cloudflare(LAX) → 홈랩을 지나는 원격이라
 *    (`mem/server-is-remote-kr-to-sjc`) 잠깐 느리거나 끊기는 일이 드물지 않은데, 그때마다
 *    에이전트가 자기가 누구와 무엇을 해 왔는지 모르는 채로 일했다. 이것이 치명적인 쪽이다.
 * 2. **턴마다 직렬 두 왕복**(`memory.list` → `memory.get('core')`, 한 번에 ~280ms).
 *
 * 그래서 사본을 러너 state 에 둔다. 판본(`rev`)으로 맞는지 가리므로 #139 의 이점(수정이
 * 다음 턴부터 반영)은 그대로다:
 *
 * - **배치 판본(`noteRev`)** — 서버는 턴을 띄울 폴 응답에 `memoryRev` 를 얹는다. 그 값이
 *   사본과 같으면 **왕복 0회**다. 이 힌트는 **한 번만 쓴다**: 같은 배치의 다음 턴이 돌 때쯤엔
 *   앞 턴(또는 병렬로 도는 다른 턴)이 `memory.set` 을 했을 수 있고, 그 호출은 하네스가
 *   브릿지로 직접 내므로 러너는 보지 못한다.
 *   그리고 **짧게만 믿는다**(`HINT_TTL_MS`) — 턴이 큐에서 기다리다 늦게 뜨면 그동안 병렬 턴이
 *   쓴 것을 놓친다. 힌트가 낡았으면 버리고 아래 확인으로 간다.
 * - **힌트가 없거나 다르면** `memory.list` 하나로 rev 를 보고, 같으면 core 를 다시 받지 않는다.
 * - **조회가 실패하면 사본으로 돈다**(`stale`). 프롬프트가 그 사실을 에이전트에게 말한다 —
 *   오래된 기억을 새것처럼 믿고 덮어쓰지 않게.
 * - 사본이 **없는** 상태에서 실패하면 예전처럼 던진다. 빈 값으로 삼키면 "기억이 없다"와
 *   "못 읽었다"가 같아지고, 그것이 #139 가 막은 사고다.
 *
 * 옛 서버(rev 를 모른다)에서는 매번 받아 온다 — 그래도 폴백 사본은 남으므로 1 은 고쳐진다.
 *
 * 오퍼레이터는 건드리지 않는다: 그쪽은 본문을 모르는 파이프여야 교체 때 끊겨도 안전하다
 * (`operator/src/mcpBridge.ts` 머리 주석). 캐시는 턴을 조립하는 러너의 일이다.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 배치 판본을 믿는 시간. 폴 응답 직후 뜨는 턴만 왕복 0회로 간다 — 그 뒤는 `memory.list` 하나. */
export const HINT_TTL_MS = 5_000;

export interface MemorySnapshot {
  /** 서버 판본. 옛 서버면 null — 그때는 사본을 폴백으로만 쓰고 적중 판정에 쓰지 않는다. */
  rev: string | null;
  core: string | null;
  slugs: string[];
  /** 서버에서 받아 온 시각(ISO). 폴백일 때 프롬프트가 "언제 것인지"를 말한다. */
  fetchedAt: string;
}

export interface MemoryRead {
  core: string | null;
  slugs: string[];
  /** 서버를 못 읽어 사본으로 돈다 — 그 사본을 받은 시각. */
  stale?: { fetchedAt: string };
}

/** 서버에서 읽는 두 가지. `HarkroomAgentClient` 가 구현한다. 실패는 던진다. */
export interface MemorySource {
  listMemory(): Promise<{ slugs: string[]; rev?: string }>;
  getMemoryValue(slug: string): Promise<string | null>;
}

export interface MemoryCache {
  /** 방금 받은 폴 배치의 `memoryRev`. 다음 `read()` 한 번에만 쓰인다. */
  noteRev(rev: string | undefined): void;
  read(): Promise<MemoryRead>;
}

/** 사본 파일 이름. 에이전트 state 디렉터리 바로 아래다(지시문 파일과 같은 자리). */
export const MEMORY_CACHE_FILE = 'memory-cache.json';

export function createMemoryCache(deps: {
  /** 이 에이전트(인스턴스)의 state 디렉터리 — `stateDir.ts::resolveAgentStateDir` 가 정한 것. */
  stateDir: string;
  source: MemorySource;
  now?: () => Date;
  log?: (line: string) => void;
}): MemoryCache {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line) => console.error(line));
  const file = join(deps.stateDir, MEMORY_CACHE_FILE);
  let snap: MemorySnapshot | null | undefined; // undefined = 아직 디스크를 안 읽었다
  let hint: { rev: string; at: number } | undefined;

  async function load(): Promise<MemorySnapshot | null> {
    if (snap !== undefined) return snap;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<MemorySnapshot>;
      snap = Array.isArray(parsed.slugs) && typeof parsed.fetchedAt === 'string'
        ? {
          rev: typeof parsed.rev === 'string' ? parsed.rev : null,
          core: typeof parsed.core === 'string' ? parsed.core : null,
          slugs: parsed.slugs.filter((s): s is string => typeof s === 'string'),
          fetchedAt: parsed.fetchedAt,
        }
        : null;
    } catch {
      // 없거나 깨졌다 — 사본이 없는 것과 같다. 받아 오면 새로 쓴다.
      snap = null;
    }
    return snap;
  }

  /**
   * 원자적으로 쓴다(임시 파일 → rename). 턴이 병렬이라 둘이 동시에 쓸 수 있고, 반쯤 쓴
   * 파일을 다음 기동이 읽으면 사본이 없는 것보다 나쁘다. 실패는 삼킨다 — 캐시를 못 써도
   * 이번 턴은 방금 받은 값으로 멀쩡히 돈다. 0600: 기억은 대화만큼 사적이다.
   */
  async function persist(next: MemorySnapshot): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, file);
    } catch (err: unknown) {
      log(`[memoryCache] 사본 저장 실패 — 이번 턴은 받아 온 값으로 돈다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    noteRev(rev) {
      hint = rev === undefined ? undefined : { rev, at: now().getTime() };
    },

    async read() {
      const cached = await load();
      const batchRev = hint && now().getTime() - hint.at <= HINT_TTL_MS ? hint.rev : undefined;
      hint = undefined;
      if (batchRev !== undefined && cached?.rev === batchRev) {
        return { core: cached.core, slugs: cached.slugs };
      }

      try {
        const listed = await deps.source.listMemory();
        const rev = typeof listed.rev === 'string' ? listed.rev : null;
        const slugs = (listed.slugs ?? []).filter((s) => s !== 'core');
        if (rev !== null && cached?.rev === rev) {
          // 목록만 확인하면 됐다 — core 본문은 사본 그대로다.
          return { core: cached.core, slugs: cached.slugs };
        }
        const core = (listed.slugs ?? []).includes('core')
          ? await deps.source.getMemoryValue('core')
          : null;
        const next: MemorySnapshot = { rev, core, slugs, fetchedAt: now().toISOString() };
        snap = next;
        await persist(next);
        return { core, slugs };
      } catch (err: unknown) {
        if (!cached) throw err;
        log(`[memoryCache] 메모리 조회 실패 — ${cached.fetchedAt} 사본으로 돈다: ${err instanceof Error ? err.message : String(err)}`);
        return { core: cached.core, slugs: cached.slugs, stale: { fetchedAt: cached.fetchedAt } };
      }
    },
  };
}

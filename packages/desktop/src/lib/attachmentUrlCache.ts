import { getController } from '../state/controller';
import { sessionScopedKey } from './sessionKey';

/**
 * 첨부 그림의 objectURL 캐시 — **줄이 다시 마운트돼도 다시 받지 않는다.**
 *
 * 채널 본문은 가상 목록이라 화면 밖으로 나간 줄은 언마운트되고, 돌아오면 새로 마운트된다.
 * 예전 `useAttachmentUrl` 은 마운트마다 fetch → blob → objectURL 을 새로 하고 언마운트에서
 * revoke 했다. 그래서 스크롤로 되돌아올 때마다 그림이 0.3~1초 비었다가 들어왔고, 그 사이에
 * 줄 높이가 바뀌어 스크롤 위치를 다시 맞추는 보정이 돌았다(스레드 bf24d7bd 분석 ①).
 *
 * - **키**: 컨트롤러(=커뮤니티 세션) + 첨부 id. 첨부 바이트는 id 에 묶여 바뀌지 않으므로 만료가
 *   필요 없다. objectURL 은 이 창의 메모리에 있는 blob 을 가리킬 뿐이라 서버 쪽 만료도 없다.
 *   컨트롤러를 키에 넣는다(`sessionScopedKey`).
 * - **상한(LRU)**: 바이트 합 `MAX_BYTES` 와 개수 `MAX_ENTRIES` 중 먼저 닿는 쪽. 넘치면 가장 오래 안 쓴
 *   것부터 revoke 한다. **지금 화면에 붙어 있는(참조 중인) 것은 내쫓지 않는다** — 그린 그림의 URL 을
 *   revoke 하면 그 `<img>` 가 깨진다. 그래서 상한은 "참조 없는 것" 에만 걸린다.
 * - **실패는 담지 않는다.** 다음 마운트에서 다시 시도한다(일시 오류가 굳지 않게).
 * - 같은 id 를 동시에 여럿이 부르면 요청은 하나다(진행 중 promise 공유).
 */
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_ENTRIES = 300;

interface Entry {
  url: string;
  bytes: number;
  refs: number;
}

/** 삽입 순서 = 최근 사용 순서(Map 은 순서를 지킨다). 쓸 때마다 지우고 다시 넣는다. */
const entries = new Map<string, Entry>();
interface Inflight { waiters: number; promise: Promise<string> }
const inflight = new Map<string, Inflight>();
let totalBytes = 0;

function touch(key: string, e: Entry): void {
  entries.delete(key);
  entries.set(key, e);
}

function evict(): void {
  if (totalBytes <= MAX_BYTES && entries.size <= MAX_ENTRIES) return;
  for (const [key, e] of entries) {
    if (totalBytes <= MAX_BYTES && entries.size <= MAX_ENTRIES) return;
    if (e.refs > 0) continue;
    entries.delete(key);
    totalBytes -= e.bytes;
    URL.revokeObjectURL(e.url);
  }
}

/** 이미 받아 둔 URL 을 **동기로** 돌려준다 — 첫 렌더부터 그림을 그려 빈 자리가 한 번도 안 서게. */
export function peekAttachmentUrl(id: string): string | null {
  const key = sessionScopedKey(id);
  return key ? entries.get(key)?.url ?? null : null;
}

/**
 * URL 을 빌린다. 돌려받은 `release` 를 언마운트에서 부른다 — revoke 는 하지 않고 참조만 내려놓는다
 * (LRU 가 나중에 치운다).
 */
export function acquireAttachmentUrl(id: string): { promise: Promise<string>; release: () => void } {
  const key = sessionScopedKey(id);
  if (!key) {
    // 캐시를 못 쓰는 자리는 예전처럼 한 번 쓰고 버린다.
    let url: string | null = null;
    let released = false;
    const promise = getController().fetchAttachment(id).then((blob) => {
      url = URL.createObjectURL(blob);
      if (released) URL.revokeObjectURL(url);
      return url;
    });
    return { promise, release: () => { released = true; if (url) URL.revokeObjectURL(url); } };
  }
  const cached = entries.get(key);
  if (cached) {
    cached.refs += 1;
    touch(key, cached);
    let held = true;
    return {
      promise: Promise.resolve(cached.url),
      release: () => {
        if (!held) return;
        held = false;
        cached.refs -= 1;
        evict();
      },
    };
  }
  // 받는 중인 것을 기다리는 쪽은 `waiters` 로 센다 — 도착하는 순간 그 수만큼 참조를 쥔 채로
  // 캐시에 들어가야, 다른 쪽의 evict 가 그 사이에 막 받은 URL 을 revoke 하지 못한다.
  let job = inflight.get(key);
  if (!job) {
    const j: Inflight = { waiters: 0, promise: Promise.resolve('') };
    j.promise = getController().fetchAttachment(id).then((blob) => {
      const e: Entry = { url: URL.createObjectURL(blob), bytes: blob.size, refs: j.waiters };
      entries.set(key, e);
      totalBytes += e.bytes;
      evict();
      return e.url;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, j);
    job = j;
  }
  const j = job;
  j.waiters += 1;
  let state: 'waiting' | 'held' | 'released' = 'waiting';
  const promise = j.promise.then((url) => {
    if (state === 'waiting') state = 'held';
    return url;
  });
  return {
    promise,
    release: () => {
      if (state === 'released') return;
      const e = entries.get(key);
      if (inflight.get(key) === j && state === 'waiting') {
        // 아직 도착 전 — 도착할 때 쥘 참조를 하나 덜 쥐게 한다.
        j.waiters -= 1;
      } else if (e) {
        e.refs -= 1;
      }
      state = 'released';
      evict();
    },
  };
}

/** 시험용 — 파일 사이에 캐시가 새지 않게. */
export function resetAttachmentUrlCacheForTest(): void {
  for (const e of entries.values()) URL.revokeObjectURL(e.url);
  entries.clear();
  inflight.clear();
  totalBytes = 0;
}

export const ATTACHMENT_URL_CACHE_LIMITS = { MAX_BYTES, MAX_ENTRIES } as const;

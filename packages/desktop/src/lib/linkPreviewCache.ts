import type { LinkPreviewView } from '@harkroom/shared';
import { sessionPrefix, sessionScopedKey } from './sessionKey';
import { onSessionEnd } from './sessionEnd';

/**
 * 링크 카드 응답 캐시 — 가상 목록에서 줄이 다시 마운트될 때 **첫 렌더부터** 카드를 그린다
 * (스레드 bf24d7bd ①). 예전에는 마운트마다 GET 했고 받기 전엔 아무것도 안 그려서, 스크롤로
 * 돌아올 때마다 줄이 카드 높이만큼 늦게 자랐다.
 *
 * - **키**: 세션(`sessionScopedKey`) + URL. 서버가 "다시 가져왔다"고 알리면(`linkPreviewReadyAt`)
 *   그 값이 바뀌므로 그때는 다시 묻는다.
 * - **만료**: `MAX_AGE_MS` 가 지난 응답은 그린 채로 뒤에서 다시 묻는다(비어 보이지 않게).
 * - **세션이 끝나면**(`Controller.stop()`) 그 세션의 항목을 비운다.
 * - **상한(LRU)**: `MAX_ENTRIES` 개. 응답은 글자 몇 줄이라 개수로만 묶는다.
 * - **실패(예외)는 담지 않는다.** `failed`·`blocked` 응답은 서버의 답이므로 담는다 — 그것도
 *   "그리지 않는다"를 첫 렌더에 알게 한다.
 */
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 60 * 1000;

interface Entry { view: LinkPreviewView; readyAt: number | undefined; at: number }
const entries = new Map<string, Entry>();

// 세션이 끝나면 그 세션의 카드를 비운다(#1286 security n1).
onSessionEnd((n) => {
  const prefix = sessionPrefix(n);
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
});

export function peekLinkPreview(url: string): { view: LinkPreviewView; fresh: (readyAt: number | undefined) => boolean } | null {
  const key = sessionScopedKey(url);
  const e = key ? entries.get(key) : undefined;
  if (!key || !e) return null;
  entries.delete(key);
  entries.set(key, e);
  return {
    view: e.view,
    fresh: (readyAt) => e.readyAt === readyAt && Date.now() - e.at < MAX_AGE_MS,
  };
}

export function storeLinkPreview(url: string, readyAt: number | undefined, view: LinkPreviewView): void {
  const key = sessionScopedKey(url);
  if (!key) return;
  entries.delete(key);
  entries.set(key, { view, readyAt, at: Date.now() });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export const LINK_PREVIEW_CACHE_LIMITS = { MAX_ENTRIES, MAX_AGE_MS } as const;

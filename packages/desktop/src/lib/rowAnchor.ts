/**
 * **줄이 다른 칸으로 옮겨 가도 보던 자리를 지킨다** — 설정 목록(작업 폴더 정리)의 손 앵커.
 *
 * `scrollAnchor.ts` 와 같은 까닭이다: WKWebView 에는 `overflow-anchor` 가 없다(macOS 26.6 실측,
 * `CSS.supports('overflow-anchor','auto') === false`). 「삭제 예정에 넣기」를 누르면 그 줄이 위쪽 「삭제 예정」 칸으로
 * 옮겨 가 그 칸이 한 줄 길어지고, 보던 내용은 그만큼 아래로 밀린다 — 누를 때마다 한 줄씩 화면이 위로 튄다.
 * Chromium 은 스스로 잡아 주므로 브라우저에서는 멀쩡하다.
 *
 * 채널 목록의 앵커(시야 맨 위 줄)와 달리 여기서는 **누른 줄**이 기준이다: 누른 줄은 사라지므로 바로 아래 줄이 누른 줄 자리로
 * 오게 한다 — 같은 손가락 자리에서 다음 줄을 누를 수 있다. 줄에는 `data-anchor-key` 를 단다.
 */
import { needsAnchorFix } from './scrollAnchor';

export const ROW_ANCHOR_ATTR = 'data-anchor-key';

export interface RowAnchor {
  scroller: HTMLElement;
  /** 붙잡은 줄의 key. */
  key: string;
  /** 그 줄이 와야 할 자리(스크롤 상자 위 끝에서 잰 px). */
  top: number;
  /** 잡을 때의 scrollTop — 그 사이 사람이 굴렸으면 되돌리지 않는다. */
  scrollTop: number;
}

export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const oy = getComputedStyle(e).overflowY;
    if (oy === 'auto' || oy === 'scroll') return e;
  }
  return null;
}

const topIn = (el: HTMLElement, scroller: HTMLElement) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

function sibling(row: HTMLElement, dir: 'next' | 'prev'): HTMLElement | null {
  for (let e = dir === 'next' ? row.nextElementSibling : row.previousElementSibling; e; e = dir === 'next' ? e.nextElementSibling : e.previousElementSibling) {
    if (e instanceof HTMLElement && e.hasAttribute(ROW_ANCHOR_ATTR)) return e;
  }
  return null;
}

/**
 * `replace`(기본) — 누른 줄은 사라진다: 같은 칸의 바로 아래 줄이 누른 줄 자리로 오게 한다. 아래 줄이 없으면 위 줄을 제자리에.
 * `self` — 그 요소(묶음 막대 등)를 제자리에 둔다.
 */
export function captureRowAnchor(row: Element | null, mode: 'replace' | 'self' = 'replace'): RowAnchor | null {
  if (!(row instanceof HTMLElement)) return null;
  const scroller = scrollParent(row);
  if (!scroller) return null;
  const base = { scroller, scrollTop: scroller.scrollTop };
  if (mode === 'self') {
    const own = row.getAttribute(ROW_ANCHOR_ATTR);
    return own ? { ...base, key: own, top: topIn(row, scroller) } : null;
  }
  const next = sibling(row, 'next');
  if (next) return { ...base, key: next.getAttribute(ROW_ANCHOR_ATTR)!, top: topIn(row, scroller) };
  const prev = sibling(row, 'prev');
  if (prev) return { ...base, key: prev.getAttribute(ROW_ANCHOR_ATTR)!, top: topIn(prev, scroller) };
  return null;
}

/** 붙잡은 줄이 그 자리에 오게 scrollTop 을 맞춘다. 줄이 없어졌거나 그 사이 사람이 굴렸으면 아무것도 하지 않는다. */
export function restoreRowAnchor(a: RowAnchor | null): void {
  if (!a || !a.scroller.isConnected || needsAnchorFix(a.scroller.scrollTop, a.scrollTop)) return;
  const el = [...a.scroller.querySelectorAll<HTMLElement>(`[${ROW_ANCHOR_ATTR}]`)].find((e) => e.getAttribute(ROW_ANCHOR_ATTR) === a.key);
  if (!el) return;
  const delta = topIn(el, a.scroller) - a.top;
  // 1px 문턱(`needsAnchorFix`)은 여기선 쓰지 않는다 — 줄 높이가 소수라 누를 때마다 1px 씩 밀려 38번이면 한 줄이 된다.
  if (Math.abs(delta) > 0.25) a.scroller.scrollTop = Math.max(0, Math.round(a.scroller.scrollTop + delta));
}

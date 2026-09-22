/**
 * **읽던 자리를 붙잡는다** — 위쪽에서 내용이 자라도.
 *
 * 왜 필요한가(jaebin 보고 2026-09-22: "채널을 다시 열면 제일 밑으로 갔다가 채팅들 응답으로
 * 들어오면서 스크롤이 위로 올라가 버린다"): 스크롤 상자는 **보고 있는 줄**이 아니라 위에서부터
 * 잰 거리(`scrollTop`)를 기억한다. 그래서 시야 **위쪽**에 한 줄이라도 끼어들면 `scrollTop` 은
 * 그대로인데 보던 줄은 그만큼 아래로 밀린다 — 사람 눈에는 화면이 위로 올라간 것으로 보인다.
 *
 * 에이전트의 응답이 정확히 그 성장을 만든다. 답은 **스레드**에 달리므로 채널 목록의 줄 수는
 * 그대로인데(`roots` 는 뿌리만 센다), 뿌리 줄에 답글 요약 줄(참여자·"N replies"·상태 뱃지)이
 * **새로 선다**(`MessageItem` 의 `hasActivity`). 늦게 오는 그림·링크 카드도 같은 모양이다.
 *
 * Chromium 은 `overflow-anchor` 로 이것을 알아서 붙잡아 주지만 **WKWebView 에는 그 기능이
 * 없다**(macOS 앱은 Tauri 다). 그래서 우리가 붙잡는다: 자라기 **전에** 시야 맨 위의 줄과
 * 그 줄이 상자 위에서 얼마나 내려와 있었는지를 적어 두고, 자란 **뒤에** 같은 줄이 같은
 * 자리에 오도록 `scrollTop` 을 되돌린다.
 *
 * 판정을 순수 함수로 떼어 둔 이유는 `stickyBottom.ts` 와 같다 — 스크롤 수치를 다루는 계산은
 * 부호 하나로 뒤집히는데, 컴포넌트 안에 두면 jsdom 이 레이아웃을 재지 않아 회귀선을 걸 자리가
 * 없다.
 *
 * **바닥에 붙어 있을 때는 이 보정을 쓰지 않는다.** 그때 옳은 것은 "읽던 자리"가 아니라
 * "가장 최신"이고, 그 일은 `stickyBottom.ts` 의 판정과 바닥 표식 관찰자가 이미 한다.
 */

/** 붙잡을 줄과, 그 줄이 상자 위쪽에서 떨어져 있던 거리(px). */
export interface ScrollAnchor {
  /** 그 줄의 상자 안 세로 위치(`offsetTop`). 되돌릴 때 **다시 재서** 비교한다. */
  top: number;
  /** 상자 위쪽에서 그 줄까지의 거리. 음수면 그 줄은 위로 반쯤 잘려 있었다. */
  offset: number;
}

/** 붙잡을 후보 한 줄. `top` 은 스크롤 상자 기준 세로 위치다(`offsetTop`). */
export interface AnchorRow {
  top: number;
}

/**
 * 시야에 걸친 **첫 줄**을 고른다 — 정확히는 바닥이 시야 위쪽보다 아래인 첫 줄이다.
 *
 * 완전히 위로 지나간 줄을 고르면 안 된다: 그런 줄은 사람이 보고 있지 않으므로 그것을
 * 기준으로 되돌려도 화면에 보이는 것은 달라질 수 있다. 반쯤 걸친 줄은 고른다 — 그 줄의
 * 아랫부분이 화면 맨 위에 있고, 사람이 보는 것이 바로 그것이다.
 *
 * `rows` 는 **세로 순으로 정렬돼 있다고 본다**(DOM 순서가 곧 그 순서다). 그래서 이분 탐색을
 * 쓴다 — 스크롤 한 번에 수백 줄의 위치를 훑으면 목록이 긴 채널에서 그것이 곧 버벅임이다.
 *
 * 고를 줄이 없으면(목록이 비었거나 전부 시야 위로 지나갔다) `null` 이다 — 그때는 붙잡지
 * 않는다. 아무것도 안 하는 것이 엉뚱한 줄을 잡는 것보다 낫다.
 */
export function pickAnchor(rows: AnchorRow[], scrollTop: number): ScrollAnchor | null {
  let lo = 0;
  let hi = rows.length - 1;
  let found: AnchorRow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid]!;
    if (row.top >= scrollTop) { found = row; hi = mid - 1; } else { lo = mid + 1; }
  }
  // 전부 시야 위로 지나갔으면 **마지막 줄**을 잡는다. 긴 메시지 하나가 화면을 다 채운
  // 경우가 그것이고, 그때 붙잡을 것이 없다고 답하면 정작 가장 흔한 자리에서 보정이 죽는다.
  const row = found ?? rows[rows.length - 1];
  if (!row) return null;
  return { top: row.top, offset: row.top - scrollTop };
}

/**
 * 붙잡아 둔 줄이 **지금 어디 있는지**를 받아, 되돌릴 `scrollTop` 을 낸다.
 *
 * 음수로 내려가지 않는다 — 위쪽 내용이 줄어든 경우(진행 묶음이 접혔다) 그대로 쓰면 브라우저가
 * 어차피 0 으로 자르는데, 그 값을 우리가 다시 직전 위치로 적어 두면 다음 스크롤 이벤트를
 * "사람이 올렸다"로 잘못 읽는다.
 */
export function anchoredScrollTop(anchor: ScrollAnchor, currentTop: number): number {
  return Math.max(0, currentTop - anchor.offset);
}

/**
 * 되돌릴 만큼 어긋났는가. 1px 미만은 건드리지 않는다 — `scrollTop` 은 소수이고 확대 배율에
 * 따라 늘 미세하게 어긋나는데, 그때마다 쓰면 스크롤 이벤트를 끝없이 낳는다.
 */
export function needsAnchorFix(from: number, to: number): boolean {
  return Math.abs(to - from) >= 1;
}

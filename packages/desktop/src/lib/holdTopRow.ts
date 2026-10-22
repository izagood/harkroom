/**
 * **위쪽에 줄이 붙거나 빠져도 보던 줄을 그 자리에 둔다** — 창으로 좁힌 목록(`MessageRows`)의 몫이다
 * (2026-10-22 사용자 보고: 위로 올려 과거가 붙을 때 화면이 튕긴다).
 *
 * 왜 창 안에서 해야 하나: 과거가 앞에 붙는 커밋에서 창(`@tanstack/virtual-core`)은 **옛 스크롤 위치**로
 * 마운트할 줄을 고른다. 그 위치는 이제 막 붙은 옛 대화의 맨 위라, 보던 줄은 마운트되지 않고 새 줄
 * 수십 개가 대신 그려진다. 그러면 세 가지가 한꺼번에 어긋났다(탐침 실측, 스레드 1a06bdce):
 * - 창이 그 새 줄들을 처음 재며 "시야 위에서 자랐다"고 스크롤을 밀고, 민 만큼 다음 줄도 시야 위가
 *   되어 연쇄로 민다(손을 멈춘 채 기다리면 커밋 안에서 바로 잰다 — +1.8k px).
 * - 화면 쪽이 scrollHeight 차로 한 번 더 밀어 같은 줄을 두 번 셌다(−2.1k px).
 * - 읽던 줄이 DOM 에서 빠져 `restoreAnchor` 가 붙잡을 것을 잃었다.
 *
 * 그래서 **창이 위치를 읽기 전에**(같은 렌더 안에서) 창의 스크롤 위치를 "그 전 첫 줄이 내려간 거리"만큼
 * 옮긴다. 창은 처음부터 보던 줄 근처를 마운트하고, 그 줄들은 이미 잰 높이가 있으므로 재측정 보정도
 * 일어나지 않는다. DOM 의 `scrollTop` 은 커밋 뒤에 같은 값으로 맞춘다(`VirtualRows` 의 layout 효과).
 *
 * 기준을 "첫 **실제** 줄"로 두는 이유: 맨 위에는 스켈레톤 자리표시가 붙었다 빠진다. 그 자리표시를 기준으로
 * 잡으면 그것이 사라지는 순간 잴 줄이 없다.
 */

/** 지난 렌더의 첫 실제 줄과 그 줄의 시작 위치(창의 좌표, px). */
export interface HeldTopRow {
  key: string;
  start: number;
}

/**
 * 그 전 첫 줄이 새 목록에서 얼마나 내려갔나(px, 위로 올라갔으면 음수).
 *
 * 그 줄이 새 목록에 없으면(지워졌다·창이 통째로 바뀌었다) 0 이다 — 붙잡을 기준이 없을 때 옮기지 않는 것이
 * 엉뚱한 줄을 기준으로 옮기는 것보다 낫다(`scrollAnchor.ts` 의 `pickAnchor` 와 같은 태도).
 */
export function topRowShift(prev: HeldTopRow | null, startOf: (key: string) => number | null): number {
  if (!prev) return 0;
  const now = startOf(prev.key);
  if (now === null) return 0;
  return now - prev.start;
}
